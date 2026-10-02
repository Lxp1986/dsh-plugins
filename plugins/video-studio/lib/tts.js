/**
 * Automatic dubbing.
 *
 * Speech is synthesized locally (macOS `say` by default) per subtitle line,
 * measured, optionally time-compressed to fit its line, then placed on the
 * timeline and mixed with the original track.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildDubTrack } from './ffmpeg.js';
import { projectDuration } from './project.js';
import { segmentsFromScript } from './subtitles.js';
import { ensureDir, round3, runCommand, shortHash, whichSync, writeText } from './util.js';

/** Media duration in seconds via ffprobe. */
async function mediaDuration(tools, file) {
  const result = await runCommand(tools.ffprobe ?? 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse `say -v '?'` into a voice list.
 *
 * macOS prints a single space before the locale for voices whose label fills
 * the column (Tingting, Meijia, …), so the separator must not require two
 * spaces; matching a locale token instead keeps multi-word names such as
 * "Bad News" from being split into a bogus id and locale.
 */
export function parseVoices(output) {
  const voices = [];
  const seen = new Set();
  for (const line of String(output ?? '').split('\n')) {
    const match = /^(.+?)\s+([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\s+#\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const label = match[1].trim();
    const id = label.replace(/\s*\(.*\)\s*$/, '').trim();
    const locale = match[2].trim();
    const key = `${id}|${locale}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    voices.push({ id, label, locale, sample: match[3].trim() });
  }
  return voices;
}

/** Voices a Chinese-first editor expects to be preferred. */
const VOICE_PREFERENCE = ['Tingting', 'Meijia', 'Sinji', 'Shelley', 'Sandy', 'Samantha', 'Daniel'];

/** Pick the most natural default among an already-filtered catalog. */
export function preferredVoice(voices) {
  for (const name of VOICE_PREFERENCE) {
    const match = voices.find((voice) => voice.id === name && voice.locale.startsWith('zh'))
      ?? voices.find((voice) => voice.id === name);
    if (match) return match.id;
  }
  return voices.find((voice) => voice.locale === 'zh_CN')?.id
    ?? voices.find((voice) => voice.locale.startsWith('zh'))?.id
    ?? voices[0]?.id
    ?? null;
}

/** Build the dubbing engine over the shared ffmpeg tools. */
export function createTts({ tools, config }) {
  const engine = config?.tts?.engine ?? 'say';
  const sayBin = whichSync(config?.tts?.command ?? 'say');
  const defaultRate = Number(config?.tts?.rate ?? 180);
  let voiceCache = null;

  const api = {
    /** Engine availability plus the voice catalog. */
    async info(options = {}) {
      if (engine !== 'say' || !sayBin) {
        return {
          available: false,
          engine,
          voices: [],
          message: process.platform === 'darwin'
            ? '未找到 say 命令，无法本地配音'
            : '当前系统的本地配音仅支持 macOS say；可在插件配置中改用其它 TTS 命令',
        };
      }
      const voices = await api.voices();
      const filtered = options.all
        ? voices
        : voices.filter((voice) => /^(zh|en|yue|cmn)/i.test(voice.locale));
      return {
        available: true,
        engine: 'say',
        defaultVoice: filtered.some((voice) => voice.id === config?.tts?.voice)
          ? config.tts.voice
          : preferredVoice(filtered),
        defaultRate,
        voices: filtered,
      };
    },

    async voices() {
      if (voiceCache) return voiceCache;
      if (!sayBin) return [];
      const result = await runCommand(sayBin, ['-v', '?']);
      voiceCache = parseVoices(result.stdout);
      return voiceCache;
    },

    /**
     * Synthesize one line to a 48 kHz stereo WAV.
     * @returns {Promise<{file:string,duration:number}>}
     */
    async synthesize({ text, voice, rate, outFile }) {
      if (!sayBin) throw new Error('未找到 say 命令，无法本地配音');
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('配音文本为空');
      const dir = path.dirname(outFile);
      await ensureDir(dir);
      const textFile = path.join(dir, `${path.basename(outFile, '.wav')}.txt`);
      const aiffFile = path.join(dir, `${path.basename(outFile, '.wav')}.aiff`);
      await writeText(textFile, clean);
      const args = ['-o', aiffFile];
      if (voice) args.push('-v', voice);
      args.push('-r', String(Number(rate) || defaultRate));
      args.push('-f', textFile);
      const result = await runCommand(sayBin, args);
      if (result.code !== 0) {
        throw new Error(`say 合成失败：${(result.stderr || '').trim() || result.code}`);
      }
      await runCommand(tools.ffmpeg, [
        '-y', '-i', aiffFile, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outFile,
      ]);
      const duration = await mediaDuration(tools, outFile);
      return { file: outFile, duration };
    },

    /** Speed a synthesized line up (or down) to fit its window. */
    async fit({ file, targetSeconds, outFile }) {
      const current = await mediaDuration(tools, file);
      if (!Number.isFinite(current) || current <= 0) return { file, duration: current };
      if (current <= targetSeconds * 1.02) return { file, duration: current };
      const tempo = Math.min(2.0, Math.max(0.5, current / Math.max(0.2, targetSeconds)));
      if (tempo <= 1.02) return { file, duration: current };
      await runCommand(tools.ffmpeg, [
        '-y', '-i', file, '-filter:a', `atempo=${tempo.toFixed(3)}`,
        '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outFile,
      ]);
      return { file: outFile, duration: await mediaDuration(tools, outFile) };
    },
  };

  return api;
}

/**
 * Build the dub track for a project.
 * @param {{ tts: object, tools: object, project: object, workdir: string, signal?: AbortSignal, onProgress?: Function }} context
 */
export async function generateDub(context) {
  const { tts, tools, project, workdir, signal, onProgress } = context;
  const dub = project.dub ?? {};
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('时间线为空，先导入素材');

  const source = dub.mode === 'narrate'
    ? segmentsFromScript(dub.script ?? '', duration)
    : (project.subtitles?.segments ?? []);
  if (source.length === 0) {
    throw new Error(dub.mode === 'narrate' ? '还没有旁白文稿' : '还没有字幕，先做自动字幕或手写字幕');
  }

  const srcDir = await ensureDir(path.join(workdir, 'dub', 'src'));
  const fitDir = await ensureDir(path.join(workdir, 'dub', 'fit'));
  const voice = dub.voice || context.defaultVoice;
  const rate = Number(dub.rate) || 180;
  const placed = [];
  const cache = [];

  for (const [index, segment] of source.entries()) {
    signal?.throwIfAborted();
    const text = String(segment.text ?? '').trim();
    if (!text) continue;
    const key = shortHash(`${voice}|${rate}|${text}`);
    const cached = path.join(srcDir, `${key}.wav`);
    let file = cached;
    if (!existsSync(cached)) {
      onProgress?.(0.05 + 0.85 * (index / source.length), `合成配音 ${index + 1}/${source.length}`);
      const produced = await tts.synthesize({ text, voice, rate, outFile: cached });
      file = produced.file;
    }
    const span = Math.max(0.3, segment.end - segment.start);
    const fitted = path.join(fitDir, `${key}_fit.wav`);
    const useFit = dub.fitToSegment !== false;
    const final = useFit
      ? await tts.fit({ file, targetSeconds: span, outFile: fitted })
      : { file, duration: await mediaDuration(tools, file) };
    placed.push({
      start: round3(segment.start),
      end: round3(segment.start + final.duration),
      duration: round3(final.duration),
      file: final.file,
      text,
    });
    cache.push({ index, file: final.file, duration: round3(final.duration), text });
    void key;
  }

  if (placed.length === 0) throw new Error('没有可配音的文本');
  onProgress?.(0.92, '混排配音轨道');
  const track = path.join(workdir, 'dub', 'dub-track.wav');
  await buildDubTrack(tools, placed, track, {
    workdir,
    totalDuration: duration,
    volume: Number(dub.volume ?? 1),
    signal,
  });
  onProgress?.(1, '配音完成');
  return { track, segments: cache, count: placed.length };
}

