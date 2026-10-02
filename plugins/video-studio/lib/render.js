/**
 * Render orchestration: normalize -> concat -> mix -> burn subtitles -> export.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { concatClips, normalizeClip, renderFinal } from './ffmpeg.js';
import { projectDuration } from './project.js';
import { toAss } from './subtitles.js';
import { ensureDir, round3, writeText } from './util.js';

/** Strip characters that are awkward in file names. */
export function safeName(name) {
  return String(name ?? 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
}

/**
 * Render a project to an MP4.
 * @param {{
 *   tools: object, store: object, project: object, options?: object,
 *   onProgress?: (value:number, message:string)=>void, signal?: AbortSignal,
 *   ensureDub?: () => Promise<{track:string|null}>,
 * }} context
 */
export async function renderProject(context) {
  const { tools, store, project, options = {}, onProgress, signal } = context;
  const target = {
    width: Number(options.width) || project.target.width,
    height: Number(options.height) || project.target.height,
    fps: Number(options.fps) || project.target.fps,
  };
  const clips = project.clips ?? [];
  if (clips.length === 0) throw new Error('时间线为空，先导入素材');
  const duration = projectDuration(project);
  const workdir = await store.workDir(project.id);
  const clipDir = await ensureDir(path.join(workdir, 'clips'));

  onProgress?.(0.02, '规格化素材');
  const normalized = [];
  for (const [index, clip] of clips.entries()) {
    signal?.throwIfAborted();
    const out = path.join(clipDir, `clip_${String(index).padStart(3, '0')}.mp4`);
    await normalizeClip(tools, clip, out, target, {
      crf: options.crf ?? 20,
      signal,
      onProgress: (value) => onProgress?.(
        0.02 + 0.46 * ((index + value / 1) / clips.length),
        `规格化素材 ${index + 1}/${clips.length}`,
      ),
    });
    normalized.push(out);
  }

  onProgress?.(0.5, '拼接时间线');
  const timeline = path.join(workdir, 'timeline.mp4');
  await concatClips(tools, normalized, timeline, { signal });

  const subtitles = project.subtitles?.segments ?? [];
  const wantsSubtitles = options.burnSubtitles ?? (subtitles.length > 0 && project.subtitles?.burn !== false);
  let subtitleFile = null;
  if (wantsSubtitles && subtitles.length > 0) {
    const assFile = path.join(workdir, 'subs.ass');
    await writeText(assFile, toAss(subtitles, {
      width: target.width,
      height: target.height,
      style: project.subtitles?.style,
    }));
    subtitleFile = path.basename(assFile);
  }

  let dubFile = null;
  const wantsDub = options.includeDub ?? project.dub?.enabled === true;
  if (wantsDub) {
    const existing = project.dub?.track;
    if (existing && existsSync(existing)) {
      dubFile = existing;
    } else if (context.ensureDub) {
      onProgress?.(0.54, '生成配音');
      const produced = await context.ensureDub();
      dubFile = produced?.track ?? null;
    }
  }

  let bgmFile = null;
  const wantsBgm = options.includeBgm ?? Boolean(project.bgm?.path);
  if (wantsBgm && project.bgm?.path && existsSync(project.bgm.path)) bgmFile = project.bgm.path;

  onProgress?.(0.6, '渲染并混音');
  const output = store.renderFile(
    `${safeName(project.name)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`,
  );
  await ensureDir(path.dirname(output));
  await renderFinal(tools, timeline, output, {
    dubFile,
    bgmFile,
    originalVolume: Number(options.originalVolume ?? project.dub?.originalVolume ?? 1),
    dubVolume: Number(options.dubVolume ?? project.dub?.volume ?? 1),
    bgmVolume: Number(options.bgmVolume ?? project.bgm?.volume ?? 0.28),
    muteOriginal: options.muteOriginal ?? project.dub?.muteOriginal ?? false,
    subtitleFile,
    width: target.width,
    height: target.height,
    fps: target.fps,
    crf: options.crf ?? 21,
    preset: options.preset ?? 'medium',
    duration,
    workdir,
    onProgress: (value) => onProgress?.(0.6 + 0.4 * value, '渲染并混音'),
    signal,
  });

  const render = {
    id: path.basename(output, '.mp4'),
    file: output,
    createdAt: new Date().toISOString(),
    duration: round3(duration),
    target,
    options: {
      burnSubtitles: Boolean(subtitleFile),
      includeDub: Boolean(dubFile),
      includeBgm: Boolean(bgmFile),
      muteOriginal: options.muteOriginal ?? project.dub?.muteOriginal ?? false,
    },
  };
  project.renders = [render, ...(project.renders ?? [])].slice(0, 20);
  await store.save(project);
  return render;
}

