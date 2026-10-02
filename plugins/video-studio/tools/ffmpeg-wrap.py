#!/usr/bin/env python3
"""
FFmpeg wrapper that canonicalizes WAV outputs.

Why this exists: the bundled speech recognizer accepts only a canonical
44-byte-header 16 kHz mono PCM16 WAV (`validateWave`), while ffmpeg's WAV muxer
may insert metadata chunks (LIST/INFO/bext) that shift the `data` chunk and make
the recording invalid. This wrapper forwards every argument to the real ffmpeg
and, when the output is a PCM WAV, rewrites it as a container with exactly one
`fmt ` chunk and one `data` chunk — keeping the real format (channels, rate,
bits) untouched.

It is wired in as the plugin's `ffmpegPath`. Set VIDEO_STUDIO_REAL_FFMPEG to
point at a different ffmpeg binary.
"""
import os
import struct
import subprocess
import sys

REAL_FFMPEG = os.environ.get("VIDEO_STUDIO_REAL_FFMPEG") or "ffmpeg"


def iter_chunks(data):
    """Yield (chunk_id, payload_start, payload_size) for a RIFF container."""
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        yield chunk_id, offset + 8, size
        offset += 8 + size + (size & 1)


def canonicalize(path):
    """Rewrite one PCM WAV as a canonical two-chunk container. Returns True when rewritten."""
    with open(path, "rb") as handle:
        data = handle.read()
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        return False

    fmt = None
    payloads = []
    for chunk_id, start, size in iter_chunks(data):
        if chunk_id == b"fmt " and fmt is None:
            fmt = data[start:start + max(16, size)]
        elif chunk_id == b"data":
            payloads.append(data[start:start + size])
    if fmt is None or not payloads:
        return False

    pcm = b"".join(payloads)
    if len(pcm) % 2:
        pcm = pcm[:-1]
    audio_format, channels, rate, _byte_rate, _block_align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if audio_format != 1:  # only linear PCM can be reassembled this way
        return False

    block_align = channels * bits // 8
    byte_rate = rate * block_align
    header = (
        b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, audio_format, channels, rate, byte_rate, block_align, bits)
        + b"data" + struct.pack("<I", len(pcm))
    )
    rebuilt = header + pcm
    if rebuilt == data:
        return False
    with open(path, "wb") as handle:
        handle.write(rebuilt)
    return True


def main():
    args = sys.argv[1:]
    code = subprocess.call([REAL_FFMPEG] + args)
    if code == 0:
        candidates = [item for item in args if item.lower().endswith(".wav")]
        if candidates:
            target = candidates[-1]
            if os.path.isfile(target):
                try:
                    canonicalize(target)
                except Exception:
                    # A failed rewrite must never fail the ffmpeg call itself.
                    pass
    return code


if __name__ == "__main__":
    sys.exit(main())
