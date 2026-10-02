/**
 * ffmpeg/ffprobe engine for Video Studio.
 *
 * Everything renders through plain argv arrays (never a shell string), and every
 * filter graph that could grow with the timeline is written to a script file so
 * argument length never becomes the limit.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clamp, ensureDir, runCommand, whichSync, writeText } from './util.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif']);

/** Resolved binaries plus a human-readable availability report. */
export function resolveTools(config = {}) {
  const ffmpeg = whichSync(config.ffmpegPath ?? 'ffmpeg');
  const ffprobe = whichSync(config.ffprobePath ?? 'ffprobe');
  return {
    ffmpeg,
    ffprobe,
    ok: Boolean(ffmpeg && ffprobe),
    hint: ffmpeg && ffprobe ? null : '未找到 ffmpeg/ffprobe，请先安装：brew install ffmpeg',
  };
}

/**
 * Run ffmpeg, folding `-progress` output into a byte/time progress callback.
 * @returns {Promise<{code:number|null, stderr:string, stdout:string}>}
 */
export async function runFfmpeg(tools, args, options = {}) {
  if (!tools.ffmpeg) throw new Error('未找到 ffmpeg 可执行文件');
  const { onProgress, duration, signal, cwd } = options;
  const full = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', ...args];
  const lineHandler = (chunk) => {
    if (!onProgress) return;
    for (const line of chunk.split('\n')) {
      const match = /^out_time_us=(\d+)/.exec(line.trim());
      if (match && duration > 0) {
        onProgress(clamp(Number(match[1]) / 1e6 / duration, 0, 1));
      }
    }
  };
  const result = await runCommand(tools.ffmpeg, full, {
    cwd,
    signal,
    onStdout: lineHandler,
    maxOutputBytes: 128 * 1024,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`ffmpeg 执行失败（退出码 ${result.code}）${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

/**
 * Probe one media file.
 * @returns {Promise<object>} normalized media facts.
 */
export async function probeFile(tools, file, options = {}) {
  if (!tools.ffprobe) throw new Error('未找到 ffprobe 可执行文件');
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const result = await runCommand(tools.ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (result.code !== 0) {
    throw new Error(`无法读取媒体信息：${path.basename(file)}\n${(result.stderr || '').trim()}`);
  }
  const info = JSON.parse(result.stdout || '{}');
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const isImage = !audio && IMAGE_EXT.has(path.extname(file).toLowerCase());
  const rawDuration = Number(info.format?.duration);
  const imageDuration = Number(options.imageDuration ?? 5);
  const duration = isImage
    ? imageDuration
    : Number.isFinite(rawDuration) && rawDuration > 0
      ? rawDuration
      : Number(video?.duration) || 0;
  const [num, den] = String(video?.avg_frame_rate ?? video?.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
  return {
    path: file,
    name: path.basename(file),
    kind: isImage ? 'image' : video ? 'video' : 'audio',
    duration: Math.round(duration * 1000) / 1000,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    fps: fps || 25,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: Number(audio?.sample_rate) || 0,
    channels: Number(audio?.channels) || 0,
    sizeBytes: Number(info.format?.size) || 0,
    bitrate: Number(info.format?.bit_rate) || 0,
  };
}

/** Extract one poster frame for a media bin thumbnail. */
export async function posterFrame(tools, media, out, at = null) {
  const seek = at ?? Math.min(Math.max(media.duration * 0.1, 0), 2);
  if (media.kind === 'audio') {
    await runFfmpeg(tools, [
      '-y', '-f', 'lavfi', '-i', 'color=c=#1f2430:s=320x180',
      '-frames:v', '1', out,
    ]);
    return out;
  }
  await runFfmpeg(tools, [
    '-y', '-ss', String(seek), '-i', media.path,
    '-frames:v', '1', '-vf', 'scale=320:-2', out,
  ]);
  return out;
}

/**
 * Build a repeating filmstrip of evenly spaced frames for a clip's video track.
 * Images contribute a single frame and are repeated by the timeline styles.
 * @returns {Promise<string>} the written PNG path.
 */
export async function filmstrip(tools, clip, out, options = {}) {
  const height = options.height ?? 96;
  const frames = options.frames ?? 10;
  if (clip.kind === 'image') {
    await runFfmpeg(tools, ['-y', '-i', clip.path, '-vf', `scale=-2:${height}`, '-frames:v', '1', out]);
    return out;
  }
  const duration = Math.max(0.5, clip.out - clip.in);
  const fps = Math.max(0.05, Math.min(frames / duration, 12));
  await runFfmpeg(tools, [
    '-y', '-ss', String(clip.in), '-t', String(duration), '-i', clip.path,
    '-vf', `fps=${fps.toFixed(4)},scale=-2:${height},tile=${frames}x1`,
    '-frames:v', '1', out,
  ], { duration });
  return out;
}

/** Render a waveform picture for a clip's audio, used by the timeline's audio lane. */
export async function waveform(tools, clip, out, options = {}) {
  const width = options.width ?? 1200;
  const height = options.height ?? 72;
  const duration = Math.max(0.2, clip.out - clip.in);
  await runFfmpeg(tools, [
    '-y', '-ss', String(clip.in), '-t', String(duration), '-i', clip.path,
    '-filter_complex', `[0:a]showwavespic=s=${width}x${height}:colors=#7aa2f7`,
    '-frames:v', '1', out,
  ], { duration });
  return out;
}

const silenceLine = /silence_(start|end):\s*(-?[\d.]+)/g;

/**
 * Locate silence in a 16 kHz mono WAV using ffmpeg's silencedetect.
 * @returns {Promise<Array<{start:number,end:number}>>}
 */
export async function detectSilence(tools, wav, options = {}) {
  const noise = options.noise ?? '-32dB';
  const minSilence = options.minSilence ?? 0.4;
  if (!tools.ffmpeg) throw new Error('未找到 ffmpeg 可执行文件');
  const result = await runCommand(tools.ffmpeg, [
    '-hide_banner', '-nostdin', '-i', wav,
    '-af', `silencedetect=noise=${noise}:d=${minSilence}`,
    '-f', 'null', '-',
  ], { maxOutputBytes: 8 * 1024 * 1024 });
  const spans = [];
  let pendingStart = null;
  for (const match of (result.stderr || '').matchAll(silenceLine)) {
    const value = Number(match[2]);
    if (match[1] === 'start') {
      pendingStart = value;
    } else if (pendingStart !== null) {
      spans.push({ start: Math.max(0, pendingStart), end: Math.max(0, value) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    // Trailing silence has no end marker; the caller clips it to the real duration.
    spans.push({ start: Math.max(0, pendingStart), end: Number.POSITIVE_INFINITY });
  }
  return spans;
}

/**
 * Invert silence spans into speech intervals within [0, duration].
 * @returns {Array<{start:number,end:number}>}
 */
export function speechIntervals(duration, silences, options = {}) {
  const minSpeech = options.minSpeech ?? 0.2;
  const intervals = [];
  let cursor = 0;
  for (const silence of silences) {
    const end = Math.min(silence.start, duration);
    if (end - cursor >= minSpeech) intervals.push({ start: cursor, end });
    cursor = Math.max(cursor, Math.min(silence.end, duration));
  }
  if (duration - cursor >= minSpeech) intervals.push({ start: cursor, end: duration });
  return intervals.filter((span) => span.end - span.start >= minSpeech);
}

/**
 * Build a canonical 44-byte-header WAV container around raw PCM.
 *
 * The bundled speech service deliberately accepts only this exact layout, while
 * ffmpeg's WAV muxer may add metadata chunks; writing the header here removes
 * that variation entirely.
 */
export function canonicalWav(pcm) {
  const dataLength = pcm.length - (pcm.length % 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, pcm.subarray(0, dataLength)]);
}

/**
 * Trim and resample one span of a WAV into a canonical 16 kHz mono WAV that the
 * bundled recognizer accepts verbatim.
 */
export async function cutWav(tools, source, out, start, end) {
  const duration = Math.max(0.05, end - start);
  const raw = `${out}.pcm`;
  await runFfmpeg(tools, [
    '-y', '-ss', String(start), '-t', String(duration), '-i', source,
    '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', '-f', 's16le', raw,
  ], { duration });
  const pcm = await readFile(raw);
  await writeFile(out, canonicalWav(pcm));
  await rm(raw, { force: true });
  return out;
}

/** Write a silent WAV of the given duration (used for gaps and mute tracks). */
export async function silentWav(tools, out, duration, options = {}) {
  const rate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  await runFfmpeg(tools, [
    '-y', '-f', 'lavfi', '-i', `anullsrc=r=${rate}:cl=${channels === 1 ? 'mono' : 'stereo'}`,
    '-t', String(Math.max(0.01, duration)), '-c:a', 'pcm_s16le', out,
  ], { duration });
  return out;
}

/**
 * Build the timeline's audio track as one 16 kHz mono WAV.
 * Clips without an audio stream contribute silence of the same length.
 */
export async function buildTimelineAudio(tools, clips, workdir, options = {}) {
  const dir = await ensureDir(path.join(workdir, 'audio'));
  const parts = [];
  for (const [index, clip] of clips.entries()) {
    const duration = Math.max(0.05, clip.out - clip.in);
    const out = path.join(dir, `part_${String(index).padStart(3, '0')}.wav`);
    if (clip.hasAudio && clip.kind !== 'image') {
      await runFfmpeg(tools, [
        '-y', '-ss', String(clip.in), '-t', String(duration), '-i', clip.path,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out,
      ], { duration, signal: options.signal });
    } else {
      await silentWav(tools, out, duration);
    }
    parts.push(out);
  }
  const target = path.join(workdir, 'timeline-audio.wav');
  if (parts.length === 1) {
    await runFfmpeg(tools, ['-y', '-i', parts[0], '-c:a', 'pcm_s16le', target]);
    return target;
  }
  const listFile = path.join(dir, 'concat.txt');
  await writeText(listFile, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'));
  await runFfmpeg(tools, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', target]);
  return target;
}

/**
 * Normalize one clip to the project's target geometry so clips concatenate losslessly.
 * Images are looped for their assigned duration; silent audio is synthesized.
 */
export async function normalizeClip(tools, clip, out, target, options = {}) {
  const { width, height, fps, crf = 20 } = target;
  const duration = Math.max(0.05, clip.out - clip.in);
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
  const args = [];
  if (clip.kind === 'image') {
    args.push('-y', '-loop', '1', '-t', String(duration), '-i', clip.path);
  } else {
    args.push('-y', '-ss', String(clip.in), '-t', String(duration), '-i', clip.path);
  }
  if (!clip.hasAudio || clip.kind === 'image') {
    args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0');
  }
  args.push(
    '-vf', vf,
    '-af', 'aresample=48000:async=1:first_pts=0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    out,
  );
  await runFfmpeg(tools, args, { duration, onProgress: options.onProgress, signal: options.signal });
  return out;
}

/** Concatenate normalized clips with the stream-copy concat demuxer. */
export async function concatClips(tools, files, out, options = {}) {
  if (files.length === 0) throw new Error('时间线为空');
  if (files.length === 1) {
    await runFfmpeg(tools, ['-y', '-i', files[0], '-c', 'copy', '-movflags', '+faststart', out]);
    return out;
  }
  const listFile = path.join(path.dirname(out), 'concat-list.txt');
  await writeText(
    listFile,
    files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  await runFfmpeg(tools, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out,
  ], { signal: options.signal });
  return out;
}

/**
 * Assemble a dub track from timed synthesized segments.
 *
 * Non-overlapping segments (the usual case) are assembled by concatenating
 * speech and silence, which stays linear; overlapping segments fall back to a
 * single amix graph written to a filter script.
 */
export async function buildDubTrack(tools, segments, out, options = {}) {
  const { workdir, totalDuration, volume = 1 } = options;
  const dir = await ensureDir(path.join(workdir, 'dub'));
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const overlaps = ordered.some((segment, index) =>
    index > 0 && segment.start < ordered[index - 1].end - 0.02);

  if (!overlaps) {
    const parts = [];
    let cursor = 0;
    for (const [index, segment] of ordered.entries()) {
      const start = Math.max(segment.start, cursor);
      if (start > cursor + 0.02) {
        const gap = path.join(dir, `gap_${index}.wav`);
        await silentWav(tools, gap, start - cursor, { sampleRate: 48000, channels: 2 });
        parts.push(gap);
      }
      parts.push(segment.file);
      cursor = Math.max(cursor, start + (segment.duration ?? 0));
    }
    if (totalDuration > cursor + 0.02) {
      const tail = path.join(dir, 'gap_tail.wav');
      await silentWav(tools, tail, totalDuration - cursor, { sampleRate: 48000, channels: 2 });
      parts.push(tail);
    }
    const listFile = path.join(dir, 'concat.txt');
    await writeText(listFile, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'));
    await runFfmpeg(tools, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-af', `volume=${volume}`, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out,
    ], { duration: totalDuration, signal: options.signal });
    return out;
  }

  const args = [];
  const filters = [];
  for (const [index, segment] of ordered.entries()) {
    args.push('-i', segment.file);
    filters.push(`[${index}:a]adelay=${Math.round(segment.start * 1000)}:all=1[d${index}]`);
  }
  const mixInputs = ordered.map((_segment, index) => `[d${index}]`).join('');
  filters.push(`${mixInputs}amix=inputs=${ordered.length}:normalize=0:dropout_transition=0[mix]`);
  filters.push(`[mix]apad,atrim=0:${totalDuration.toFixed(3)},volume=${volume}[out]`);
  const script = path.join(dir, 'dub-filter.txt');
  await writeText(script, `${filters.join(';\n')}\n`);
  await runFfmpeg(tools, [
    '-y', ...args,
    '-filter_complex_script', script,
    '-map', '[out]',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out,
  ], { duration: totalDuration, signal: options.signal });
  return out;
}

/**
 * Final encode: mix the timeline audio with the dub/BGM tracks and optionally
 * burn subtitles. `subtitleFile` is referenced by bare name with `cwd` set to
 * its directory, which avoids filter-path escaping entirely.
 */
export async function renderFinal(tools, input, out, options = {}) {
  const {
    dubFile,
    bgmFile,
    originalVolume = 1,
    dubVolume = 1,
    bgmVolume = 0.28,
    subtitleFile,
    subtitleStyle,
    width,
    height,
    fps,
    crf = 21,
    preset = 'medium',
    duration,
    workdir,
    muteOriginal = false,
    onProgress,
    signal,
  } = options;

  const args = ['-y', '-i', input];
  const filters = [];
  let audioLabel = null;

  if (dubFile) {
    args.push('-i', dubFile);
    filters.push(`[0:a]volume=${muteOriginal ? 0 : originalVolume}[aorg]`);
    filters.push(`[1:a]volume=${dubVolume}[adub]`);
    filters.push('[aorg][adub]amix=inputs=2:normalize=0:dropout_transition=0[aout]');
    audioLabel = '[aout]';
  } else if (muteOriginal) {
    filters.push('[0:a]volume=0[aout]');
    audioLabel = '[aout]';
  } else if (originalVolume !== 1) {
    filters.push(`[0:a]volume=${originalVolume}[aout]`);
    audioLabel = '[aout]';
  }

  if (bgmFile) {
    const bgmIndex = args.filter((value) => value === '-i').length;
    args.push('-stream_loop', '-1', '-i', bgmFile);
    const base = audioLabel ? audioLabel : '[0:a]';
    filters.push(`[${bgmIndex}:a]volume=${bgmVolume},atrim=0:${Number(duration).toFixed(3)}[abgm]`);
    filters.push(`${base}[abgm]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    audioLabel = '[amixed]';
  }

  const videoFilters = [`scale=${width}:${height}`, `fps=${fps}`, 'format=yuv420p'];
  if (subtitleFile) {
    videoFilters.push(`subtitles=${subtitleFile}${subtitleStyle ? `:force_style='${subtitleStyle}'` : ''}`);
  }
  args.push('-vf', videoFilters.join(','));
  if (audioLabel) args.push('-map', '0:v:0', '-map', audioLabel);
  if (filters.length > 0) {
    const script = path.join(workdir, 'render-filter.txt');
    await writeText(script, `${filters.join(';\n')}\n`);
    args.push('-filter_complex_script', script);
  }
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  );
  await runFfmpeg(tools, args, { duration, onProgress, signal, cwd: workdir });
  return out;
}

/** Read a text file helper re-exported for callers that build SRT/ASS next to media. */
export async function readTextFile(file) {
  return readFile(file, 'utf8');
}

export { writeFile };
