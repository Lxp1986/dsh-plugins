/**
 * Project model and persistence.
 *
 * A project is a plain JSON document plus derived work directories. Renders,
 * work files and posters live under the plugin's data root so the user's own
 * media directory stays untouched.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { ensureDir, newId, readJson, writeJson } from './util.js';

export const DEFAULT_STYLE = {
  fontFamily: 'PingFang SC',
  fontSize: 0,
  color: '#ffffff',
  outlineColor: '#000000',
  outline: 2.4,
  shadow: 0,
  alignment: 2,
  marginV: 0,
};

/** Vertical presets offered in the UI. */
export const PRESETS = [
  { id: 'landscape', label: '横屏 1080p', width: 1920, height: 1080, fps: 30 },
  { id: 'portrait', label: '竖屏 1080p', width: 1080, height: 1920, fps: 30 },
  { id: 'square', label: '方形 1080p', width: 1080, height: 1080, fps: 30 },
  { id: '720p', label: '横屏 720p', width: 1280, height: 720, fps: 30 },
];

/** Build the store facade over the plugin's data root. */
export function createStore(config) {
  const dataRoot = config.dataRoot;
  const projectsDir = path.join(dataRoot, 'projects');
  const workRoot = path.join(dataRoot, 'work');
  const rendersRoot = path.join(dataRoot, 'renders');
  const postersRoot = path.join(dataRoot, 'posters');

  const store = {
    dataRoot,
    projectsDir,
    workRoot,
    rendersRoot,
    postersRoot,
    // Resolved lazily: the workspace registry may mount after this plugin.
    mediaRoot: config.mediaRoot ?? null,
    allowAnyPath: config.allowAnyPath !== false,

    /** Adopt the media root once the host composition is fully mounted. */
    setMediaRoot(dir) {
      store.mediaRoot = dir;
      return dir;
    },

    async init() {
      await Promise.all([
        ensureDir(projectsDir),
        ensureDir(workRoot),
        ensureDir(rendersRoot),
        ensureDir(postersRoot),
      ]);
    },

    projectFile(id) {
      return path.join(projectsDir, `${id}.json`);
    },

    /**
     * Resolve a user-supplied media path against the configured media root.
     * Absolute paths are accepted only when `allowAnyPath` is on.
     */
    resolveMedia(input) {
      const raw = String(input ?? '').trim();
      if (!raw) throw new Error('缺少文件路径');
      const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw;
      const absolute = path.isAbsolute(expanded)
        ? path.normalize(expanded)
        : path.resolve(store.mediaRoot ?? process.cwd(), expanded);
      if (!store.allowAnyPath && !absolute.startsWith(path.resolve(store.mediaRoot))) {
        throw new Error(`路径超出允许范围：${absolute}`);
      }
      if (!existsSync(absolute)) throw new Error(`文件不存在：${absolute}`);
      return absolute;
    },

    async list() {
      const files = await readdir(projectsDir).catch(() => []);
      const projects = [];
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        const project = await readJson(path.join(projectsDir, file));
        if (!project) continue;
        projects.push({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          clipCount: project.clips?.length ?? 0,
          duration: projectDuration(project),
          subtitleCount: project.subtitles?.segments?.length ?? 0,
        });
      }
      return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async create(input = {}) {
      const now = new Date().toISOString();
      const preset = PRESETS.find((item) => item.id === input.preset) ?? PRESETS[0];
      const project = {
        id: newId('proj'),
        name: String(input.name ?? '').trim() || `未命名项目 ${now.slice(5, 16).replace('T', ' ')}`,
        createdAt: now,
        updatedAt: now,
        mediaRoot: store.mediaRoot,
        target: { width: preset.width, height: preset.height, fps: preset.fps },
        clips: [],
        subtitles: { language: 'auto', source: null, segments: [], style: { ...DEFAULT_STYLE }, updatedAt: null },
        dub: {
          enabled: false,
          voice: input.voice ?? 'Tingting',
          rate: 180,
          volume: 1,
          originalVolume: 0.25,
          muteOriginal: false,
          mode: 'segments',
          script: '',
          generatedAt: null,
          segments: [],
        },
        bgm: { path: null, volume: 0.28 },
        renders: [],
      };
      await store.save(project);
      return project;
    },

    async load(id) {
      const project = await readJson(store.projectFile(id));
      if (!project) throw new Error(`项目不存在：${id}`);
      return project;
    },

    async save(project) {
      project.updatedAt = new Date().toISOString();
      await writeJson(store.projectFile(project.id), project);
      return project;
    },

    async remove(id) {
      await rm(store.projectFile(id), { force: true });
      await rm(path.join(dataRoot, 'history', `${id}.json`), { force: true });
      await rm(path.join(workRoot, id), { recursive: true, force: true });
    },

    async workDir(id) {
      return ensureDir(path.join(workRoot, id));
    },

    async posterDir(id) {
      return ensureDir(path.join(postersRoot, id));
    },

    renderFile(name) {
      return path.join(rendersRoot, name);
    },
  };
  return store;
}

/** Total timeline duration in seconds. */
export function projectDuration(project) {
  return (project?.clips ?? []).reduce((sum, clip) => sum + Math.max(0, (clip.out ?? 0) - (clip.in ?? 0)), 0);
}

/** Ascending clip start offsets along the rendered timeline. */
export function clipOffsets(project) {
  let cursor = 0;
  return (project?.clips ?? []).map((clip) => {
    const start = cursor;
    cursor += Math.max(0, clip.out - clip.in);
    return { clip, start, end: cursor };
  });
}

/**
 * Shift every subtitle/dub time by the map between the pre-edit timeline and
 * the current one. Used when the clip list changes after a transcription so
 * subtitles stay on their footage.
 */
export function retimeItems(segments, offsets) {
  const mapTime = (time) => {
    for (const entry of offsets) {
      if (time >= entry.originalStart && time <= entry.originalEnd) {
        return entry.start + (time - entry.originalStart);
      }
    }
    const last = offsets[offsets.length - 1];
    return last ? last.end : time;
  };
  return segments.map((segment) => ({ ...segment, start: mapTime(segment.start), end: mapTime(segment.end) }));
}
