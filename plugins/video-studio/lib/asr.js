/**
 * Automatic subtitles: timeline audio -> silence map -> SenseVoice chunks ->
 * timed subtitle lines.
 *
 * The shipped speech service exposes provider readiness and byte-bounded
 * transcription. Chunking on real silence keeps every request small, gives each
 * line a truthful time range, and never splits inside a pause-free sentence.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTimelineAudio, cutWav, detectSilence, speechIntervals } from './ffmpeg.js';
import { projectDuration } from './project.js';
import { segmentsFromChunk } from './subtitles.js';
import { ensureDir, round3, writeText } from './util.js';

/** Pick the provider to transcribe with: explicit id, then the ready selection. */
export function pickProvider(speech, preferredId) {
  const snapshot = speech.snapshot();
  const providers = snapshot?.providers ?? [];
  const ready = (provider) => !provider.preparation || provider.preparation.phase === 'ready' || provider.preparation.phase === 'standby';
  if (preferredId) {
    const match = providers.find((provider) => provider.id === preferredId);
    if (match) return match;
  }
  const selected = providers.find((provider) => provider.id === snapshot?.selection?.providerId);
  if (selected && ready(selected)) return selected;
  return providers.find(ready) ?? selected ?? providers[0] ?? null;
}

/** Describe speech availability for the UI and for tool error messages. */
export function speechStatus(speech, config) {
  if (!speech) {
    return {
      available: false,
      reason: 'inactive',
      providers: [],
      message: '未启用语音识别服务。请在插件页启用 @deepseek-ai/dsh-experimental-voice-input-bundle 后重试。',
    };
  }
  const snapshot = speech.snapshot();
  const providers = (snapshot?.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    languages: provider.languages,
    phase: provider.preparation?.phase ?? 'ready',
    step: provider.preparation?.step ?? null,
    steps: provider.preparation?.steps ?? null,
    message: provider.preparation?.message ?? null,
    progress: provider.preparation?.progress ?? null,
    detail: provider.preparation?.detail ?? null,
    download: provider.preparation?.download ?? null,
    downloadSources: provider.downloadSources ?? [],
  }));
  const selected = providers.find((provider) => provider.id === snapshot?.selection?.providerId);
  const active = pickProvider(speech, config?.speechProviderId);
  const ready = providers.some((provider) => provider.phase === 'ready' || provider.phase === 'standby');
  return {
    available: true,
    ready,
    providers,
    selectedId: snapshot?.selection?.providerId ?? null,
    activeId: active?.id ?? null,
    message: ready ? null : '语音模型尚未准备，首次使用需要下载约 239 MB 的本地识别模型。',
  };
}

/**
 * Start provider preparation (model download) without waiting for completion.
 * The UI follows the phase through `/video-studio/api/state`.
 */
export function prepareProvider(speech, providerId, options = {}) {
  if (!speech) throw new Error('未启用语音识别服务');
  const provider = pickProvider(speech, providerId);
  if (!provider) throw new Error('没有可用的语音识别提供方');
  speech.prepare(provider.id, options);
  return provider.id;
}

/**
 * Cancel an in-flight model preparation (a stuck or slow download).
 * @returns {Promise<string>} the provider whose preparation was cancelled.
 */
export async function cancelPreparationFor(speech, providerId, config) {
  if (!speech) throw new Error('未启用语音识别服务');
  const provider = pickProvider(speech, providerId ?? config?.speechProviderId);
  if (!provider) throw new Error('没有可用的语音识别提供方');
  await speech.cancelPreparation(provider.id);
  return provider.id;
}

/**
 * Transcribe the project's timeline into subtitle segments.
 * @returns {Promise<{segments:Array, provider:string, chunks:number}>}
 */
export async function transcribeTimeline(context) {
  const { speech, tools, project, workdir, signal, onProgress, config } = context;
  if (!speech) {
    throw Object.assign(new Error('未启用语音识别服务，无法自动生成字幕'), { code: 'stt-unavailable' });
  }
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('时间线为空，先导入素材');

  const status = speechStatus(speech, config);
  const provider = pickProvider(speech, config?.speechProviderId);
  if (!provider) throw Object.assign(new Error('没有可用的语音识别提供方'), { code: 'stt-unavailable' });
  if (!status.ready && provider.preparation && provider.preparation.phase !== 'ready') {
    throw Object.assign(
      new Error(`语音模型未就绪（当前状态：${provider.preparation.phase}），请先准备模型`),
      { code: 'stt-not-ready', providerId: provider.id, phase: provider.preparation.phase },
    );
  }

  const language = context.language ?? project.subtitles?.language ?? 'auto';
  onProgress?.(0.02, '提取时间线音轨');
  const audio = await buildTimelineAudio(tools, project.clips, workdir, { signal });

  onProgress?.(0.12, '分析语音停顿');
  const silences = await detectSilence(tools, audio, {
    noise: config?.silenceNoise ?? '-32dB',
    minSilence: config?.silenceMin ?? 0.4,
  });
  let intervals = speechIntervals(duration, silences, { minSpeech: config?.minSpeech ?? 0.2 });
  if (intervals.length === 0) intervals = [{ start: 0, end: duration }];

  const chunkLimit = config?.chunkSeconds ?? 18;
  const chunks = [];
  let current = null;
  for (const interval of intervals) {
    const speechSeconds = interval.end - interval.start;
    if (current && current.speech + speechSeconds > chunkLimit) {
      chunks.push(current);
      current = null;
    }
    if (!current) current = { intervals: [], speech: 0, start: interval.start, end: interval.end };
    current.intervals.push(interval);
    current.speech += speechSeconds;
    current.end = interval.end;
  }
  if (current) chunks.push(current);

  const chunkDir = await ensureDir(path.join(workdir, 'asr'));
  // A short lead-in keeps the first phoneme of a sentence: silence detection
  // lands on top of the onset, and clipping it costs the opening word. Reported
  // subtitle times still come from the intervals, never from this padding.
  const lead = Math.max(0, Number(config?.chunkLeadSeconds ?? 0.2));
  const tail = Math.max(0, Number(config?.chunkTailSeconds ?? 0.15));
  const segments = [];
  for (const [index, chunk] of chunks.entries()) {
    signal?.throwIfAborted();
    const chunkFile = path.join(chunkDir, `chunk_${String(index).padStart(3, '0')}.wav`);
    await cutWav(
      tools,
      audio,
      chunkFile,
      Math.max(0, chunk.start - lead),
      Math.min(duration, chunk.end + tail),
    );
    const bytes = new Uint8Array(await readFile(chunkFile));
    const spec = speech.resolve({
      audio: bytes,
      language,
      ...(config?.speechProviderId ? { providerId: config.speechProviderId } : {}),
    });
    const transcript = await speech.transcribe(spec, signal ?? new AbortController().signal);
    const text = typeof transcript?.text === 'string' ? transcript.text : '';
    const produced = Array.isArray(transcript?.segments) && transcript.segments.length > 0
      ? transcript.segments.map((item) => ({
        start: round3(item.start),
        end: round3(item.end),
        text: String(item.text ?? '').trim(),
      })).filter((item) => item.text)
      : segmentsFromChunk({ text, offset: 0, intervals: chunk.intervals });
    segments.push(...produced);
    onProgress?.(
      0.12 + 0.86 * ((index + 1) / chunks.length),
      `识别中 ${index + 1}/${chunks.length} 段（${Math.round((chunk.end - chunk.start) * 10) / 10}s）`,
    );
  }

  const cleaned = segments
    .filter((segment) => segment.text && segment.end > segment.start)
    .map((segment) => ({
      start: round3(segment.start),
      end: round3(segment.end),
      text: segment.text,
    }));
  return { segments: cleaned, provider: provider.id, chunks: chunks.length, language };
}

/**
 * Render the current subtitles to SRT and ASS next to a render's work files.
 * @returns {Promise<{srt:string, ass:string, count:number}>}
 */
export async function writeSubtitleFiles(workdir, project, toSrt, toAss) {
  const dir = await ensureDir(workdir);
  const segments = project.subtitles?.segments ?? [];
  const srtFile = path.join(dir, 'timeline.srt');
  const assFile = path.join(dir, 'subs.ass');
  await writeText(srtFile, toSrt(segments));
  await writeText(assFile, toAss(segments, {
    width: project.target.width,
    height: project.target.height,
    style: project.subtitles?.style,
  }));
  return { srt: srtFile, ass: assFile, count: segments.length };
}

