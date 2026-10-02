/**
 * Studio orchestration: the single place where media operations live, shared by
 * the agent tools and the Web panel's HTTP API.
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { cancelPreparationFor, prepareProvider, speechStatus, transcribeTimeline } from './asr.js';
import { filmstrip, posterFrame, probeFile, resolveTools, waveform } from './ffmpeg.js';
import { createJobs } from './jobs.js';
import { PRESETS, clipOffsets, createStore, projectDuration } from './project.js';
import { renderProject, safeName } from './render.js';
import { createTts, generateDub } from './tts.js';
import { ensureDir, newId, readJson, round3, shortHash, writeJson } from './util.js';

const HISTORY_LIMIT = 20;

const MEDIA_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aiff', '.aif',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif',
]);

/** Create the studio facade. */
export function createStudio({ config, getSpeech, getWorkspaces, resolveMediaRoot }) {
  const store = createStore(config);
  const jobs = createJobs();
  const workspacesOf = typeof getWorkspaces === 'function' ? getWorkspaces : () => [];
  let toolsInfo = resolveTools(config);
  let activeProjectId = null;
  let stateFile = null;
  let initPromise = null;
  let referencedCache = null;

  // Derived timeline visuals are generated after import returns, so a large
  // file never blocks the panel; `whenIdle()` lets callers wait for them.
  let enrichment = Promise.resolve();
  const idle = () => enrichment;

  async function enrichClips(projectId, clipIds) {
    const posterDir = await store.posterDir(projectId);
    for (const id of clipIds) {
      let project;
      try {
        project = await store.load(projectId);
      } catch {
        return;
      }
      const clip = project.clips?.find((item) => item.id === id);
      if (!clip) continue;
      const media = {
        path: clip.path,
        name: clip.name,
        kind: clip.kind,
        duration: clip.duration,
        width: clip.width,
        height: clip.height,
      };
      const patch = {};
      if (!clip.poster && (clip.hasVideo || clip.kind === 'image')) {
        const out = path.join(posterDir, `${clip.id}.jpg`);
        try {
          await posterFrame(toolsInfo, media, out);
          patch.poster = out;
        } catch {
          /* keep the clip usable without a poster */
        }
      }
      if (!clip.strip && (clip.hasVideo || clip.kind === 'image')) {
        const out = path.join(posterDir, `${clip.id}-strip.png`);
        try {
          await filmstrip(toolsInfo, { ...clip, kind: clip.kind }, out, { height: 96, frames: 10 });
          patch.strip = out;
        } catch {
          /* optional */
        }
      }
      if (!clip.waveform && clip.hasAudio) {
        const out = path.join(posterDir, `${clip.id}-wave.png`);
        try {
          await waveform(toolsInfo, clip, out, { width: 1200, height: 72 });
          patch.waveform = out;
        } catch {
          /* optional */
        }
      }
      if (Object.keys(patch).length === 0) continue;
      // Re-read immediately before writing so a concurrent edit is not lost.
      const fresh = await store.load(projectId).catch(() => null);
      const target = fresh?.clips?.find((item) => item.id === id);
      if (!target) continue;
      Object.assign(target, patch);
      await store.save(fresh);
    }
  }

  const studio = {
    config,
    store,
    jobs,

    /** Resolves when background media enrichment has settled. */
    whenIdle: idle,

    /** Idempotent bootstrap; every async entry point awaits this once. */
    async init() {
      if (!initPromise) {
        initPromise = (async () => {
          await store.init();
          if (!store.mediaRoot) {
            // A resolver failure must never take the whole plugin down: fall
            // back to the process directory and keep working.
            let fallback;
            try {
              fallback = typeof resolveMediaRoot === 'function' ? resolveMediaRoot() : undefined;
            } catch {
              fallback = undefined;
            }
            store.setMediaRoot(path.resolve(fallback ?? process.cwd()));
          }
          stateFile = path.join(store.dataRoot, 'state.json');
          const saved = await readJson(stateFile, {});
          activeProjectId = saved?.activeProjectId ?? null;
          toolsInfo = resolveTools(config);
        })();
      }
      await initPromise;
      return studio;
    },

    get speech() {
      return getSpeech();
    },

    tts() {
      return createTts({ tools: toolsInfo, config });
    },

    /** Refresh binary resolution (the user may install ffmpeg while running). */
    refreshTools() {
      toolsInfo = resolveTools(config);
      return toolsInfo;
    },

    activeId() {
      return activeProjectId;
    },

    async setActive(id) {
      activeProjectId = id ?? null;
      if (stateFile) await writeJson(stateFile, { activeProjectId });
      return activeProjectId;
    },

    async activeProject() {
      const projects = await store.list();
      if (projects.length === 0) return null;
      const id = projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : projects[0].id;
      activeProjectId = id;
      return store.load(id);
    },

    async requireProject(id) {
      if (id) return store.load(id);
      const active = await studio.activeProject();
      if (!active) throw new Error('还没有项目，先创建一个项目');
      return active;
    },

    /** Everything the panel needs for its first paint. */
    async state(projectId) {
      const projects = await store.list();
      let project = null;
      try {
        project = await studio.requireProject(projectId);
      } catch {
        project = null;
      }
      if (project) activeProjectId = project.id;
      const speech = studio.speech;
      const tts = await studio.tts().info();
      const history = project
        ? await studio.historyDepth(project.id).catch(() => ({ past: 0, future: 0 }))
        : { past: 0, future: 0 };
      return {
        ok: true,
        config: {
          dataRoot: store.dataRoot,
          mediaRoot: store.mediaRoot,
          allowAnyPath: store.allowAnyPath,
        },
        tools: { ...toolsInfo },
        presets: PRESETS,
        workspaces: workspacesOf(),
        projects,
        activeProjectId: project?.id ?? null,
        history,
        project,
        speech: speechStatus(speech, config),
        tts,
        jobs: jobs.list().slice(0, 12),
      };
    },

    /**
     * Every absolute path a project document refers to. The media endpoint
     * serves these in addition to the data and media roots, so a clip imported
     * from outside the media root stays playable without opening the whole disk.
     */
    async referencedPaths() {
      const now = Date.now();
      if (referencedCache && now - referencedCache.at < 3000) return referencedCache.paths;
      const paths = new Set();
      for (const project of await store.list()) {
        try {
          const full = await store.load(project.id);
          for (const clip of full.clips ?? []) if (clip.path) paths.add(path.resolve(clip.path));
          for (const segment of full.dub?.segments ?? []) if (segment.file) paths.add(path.resolve(segment.file));
          if (full.dub?.track) paths.add(path.resolve(full.dub.track));
          if (full.bgm?.path) paths.add(path.resolve(full.bgm.path));
          for (const render of full.renders ?? []) if (render.file) paths.add(path.resolve(render.file));
        } catch {
          continue;
        }
      }
      referencedCache = { at: now, paths };
      return paths;
    },

    /**
     * Poster frame for any media file, cached under the data root. Used by the
     * media bin so a picked file shows a real thumbnail before it is imported.
     */
    async thumbFor(input) {
      const file = store.resolveMedia(input);
      const dir = await ensureDir(path.join(store.postersRoot, 'bin'));
      const out = path.join(dir, `${shortHash(file)}.jpg`);
      if (!existsSync(out)) {
        const media = await probeFile(toolsInfo, file, { imageDuration: config.imageDuration ?? 5 });
        await posterFrame(toolsInfo, { ...media, path: file }, out, 1);
      }
      return out;
    },

    /** Undo/redo stacks live beside, not inside, the project directory. */
    historyPath(id) {
      return path.join(store.dataRoot, 'history', `${id}.json`);
    },

    /**
     * Snapshot a project before a mutation. Bounded so the history file stays
     * small; a new edit clears the redo branch, like every editor.
     */
    async record(project) {
      if (!project?.id) return;
      const file = studio.historyPath(project.id);
      const state = await readJson(file, { past: [], future: [] });
      const past = [...(state.past ?? []), JSON.parse(JSON.stringify(project))].slice(-HISTORY_LIMIT);
      await writeJson(file, { past, future: [] });
    },

    /** Undo/redo depth, surfaced to the panel so its buttons can disable. */
    async historyDepth(projectId) {
      const project = await studio.requireProject(projectId);
      const state = await readJson(studio.historyPath(project.id), { past: [], future: [] });
      return { past: (state.past ?? []).length, future: (state.future ?? []).length };
    },

    /** Restore the previous snapshot of a project. */
    async undo({ projectId } = {}) {
      const project = await studio.requireProject(projectId);
      const file = studio.historyPath(project.id);
      const state = await readJson(file, { past: [], future: [] });
      if ((state.past ?? []).length === 0) throw new Error('没有可撤销的操作');
      const previous = state.past[state.past.length - 1];
      state.past = state.past.slice(0, -1);
      state.future = [JSON.parse(JSON.stringify(project)), ...(state.future ?? [])].slice(0, HISTORY_LIMIT);
      await writeJson(file, state);
      await writeJson(store.projectFile(previous.id), previous);
      return store.load(previous.id);
    },

    /** Re-apply the snapshot most recently undone. */
    async redo({ projectId } = {}) {
      const project = await studio.requireProject(projectId);
      const file = studio.historyPath(project.id);
      const state = await readJson(file, { past: [], future: [] });
      if ((state.future ?? []).length === 0) throw new Error('没有可重做的操作');
      const next = state.future[0];
      state.future = state.future.slice(1);
      state.past = [...(state.past ?? []), JSON.parse(JSON.stringify(project))].slice(-HISTORY_LIMIT);
      await writeJson(file, state);
      await writeJson(store.projectFile(next.id), next);
      return store.load(next.id);
    },

    async listFiles(dir) {
      const base = dir ? store.resolveMedia(dir) : store.mediaRoot;
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      const files = [];
      const directories = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(base, entry.name);
        if (entry.isDirectory()) {
          directories.push({ name: entry.name, path: full });
          continue;
        }
        if (!MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await stat(full).catch(() => null);
        files.push({ name: entry.name, path: full, sizeBytes: info?.size ?? 0 });
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      directories.sort((a, b) => a.name.localeCompare(b.name));
      return { dir: base, parent: path.dirname(base), files, directories };
    },

    async createProject(input = {}) {
      const project = await store.create(input);
      await studio.setActive(project.id);
      return project;
    },

    async openProject(id) {
      const project = await store.load(id);
      await studio.setActive(project.id);
      return project;
    },

    async removeProject(id) {
      await store.remove(id);
      if (activeProjectId === id) await studio.setActive(null);
      return { removed: id };
    },

    async updateProject(id, patch = {}) {
      const project = await store.load(id);
      await studio.record(project);
      if (patch.name !== undefined) project.name = String(patch.name).slice(0, 120) || project.name;
      if (patch.target) {
        const preset = PRESETS.find((item) => item.id === patch.target.preset);
        if (preset) project.target = { width: preset.width, height: preset.height, fps: preset.fps };
        if (patch.target.width) project.target.width = Number(patch.target.width);
        if (patch.target.height) project.target.height = Number(patch.target.height);
        if (patch.target.fps) project.target.fps = Number(patch.target.fps);
      }
      if (patch.subtitleStyle) {
        project.subtitles.style = { ...project.subtitles.style, ...patch.subtitleStyle };
      }
      if (patch.bgm) {
        project.bgm = {
          path: patch.bgm.path === null ? null : (patch.bgm.path ? store.resolveMedia(patch.bgm.path) : project.bgm.path),
          volume: Number(patch.bgm.volume ?? project.bgm.volume),
        };
      }
      if (patch.dub) {
        project.dub = { ...project.dub, ...patch.dub };
      }
      await store.save(project);
      return project;
    },

    /**
     * Probe and append media to the timeline. Images receive a still duration.
     * @returns {Promise<{project:object, added:Array, skipped:Array}>}
     */
    async importMedia({ projectId, paths = [], imageDuration } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      const added = [];
      const skipped = [];
      for (const input of paths) {
        try {
          const file = store.resolveMedia(input);
          const media = await probeFile(toolsInfo, file, { imageDuration: imageDuration ?? config.imageDuration ?? 5 });
          const clip = {
            id: newId('clip'),
            path: file,
            name: media.name,
            kind: media.kind,
            duration: media.duration,
            in: 0,
            out: media.duration,
            hasAudio: media.hasAudio,
            hasVideo: media.hasVideo,
            width: media.width,
            height: media.height,
            fps: media.fps,
            sizeBytes: media.sizeBytes,
            poster: null,
            strip: null,
            waveform: null,
          };
          project.clips.push(clip);
          added.push(clip);
        } catch (error) {
          skipped.push({ path: String(input), error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (added.length > 0) await store.save(project);
      if (added.length > 0) {
        // Never block the import on thumbnail/filmstrip/waveform generation.
        enrichment = enrichment.then(() => enrichClips(project.id, added.map((clip) => clip.id))).catch(() => {});
      }
      return { project, added, skipped };
    },

    /**
     * Patch or reorder the timeline.
     *
     * A posted array that names every current clip is treated as the new order
     * (that is how the panel reorders and trims); a partial array only patches
     * the clips it names, so a caller naming one clip can never delete the rest.
     */
    async updateClips({ projectId, clips = [], retimeSubtitles = true } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      const previous = project.clips ?? [];
      const byId = new Map(previous.map((clip) => [clip.id, clip]));
      const postedIds = new Set(clips.map((patch) => patch.id));
      const isFullList = previous.length > 0
        && postedIds.size === previous.length
        && previous.every((clip) => postedIds.has(clip.id));
      const apply = (existing, patch) => {
        const duration = existing.duration;
        const start = Math.max(0, Number(patch.in ?? existing.in));
        const end = Math.min(duration, Number(patch.out ?? existing.out));
        return {
          ...existing,
          ...('name' in patch ? { name: String(patch.name) } : {}),
          in: round3(start),
          out: round3(Math.max(start + 0.05, end)),
        };
      };
      let next;
      if (isFullList) {
        next = clips
          .map((patch) => (byId.has(patch.id) ? apply(byId.get(patch.id), patch) : null))
          .filter(Boolean);
      } else {
        const patches = new Map(clips.map((patch) => [patch.id, patch]));
        next = previous.map((clip) => (patches.has(clip.id) ? apply(clip, patches.get(clip.id)) : clip));
      }
      project.clips = next;
      if (retimeSubtitles && project.subtitles?.segments?.length) {
        project.subtitles.segments = retimeSegments(project.subtitles.segments, previous, next);
        project.subtitles.staleAt = null;
      }
      await store.save(project);
      return project;
    },

    async removeClip({ projectId, clipId, retimeSubtitles = true } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      const previous = project.clips ?? [];
      project.clips = previous.filter((clip) => clip.id !== clipId);
      if (retimeSubtitles && project.subtitles?.segments?.length) {
        project.subtitles.segments = retimeSegments(project.subtitles.segments, previous, project.clips);
      }
      await store.save(project);
      return project;
    },

    /**
     * Split one clip at an absolute timeline position.
     *
     * A split is purely structural: nothing moves on the timeline, so existing
     * subtitle times stay valid and are intentionally left untouched.
     */
    async splitClip({ projectId, clipId, at } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      const clips = project.clips ?? [];
      const offsets = clipOffsets(project);
      let index = clips.findIndex((clip) => clip.id === clipId);
      if (index < 0) index = offsets.findIndex((entry) => Number(at) >= entry.start && Number(at) <= entry.end);
      if (index < 0) throw new Error('找不到要分割的片段');
      const entry = offsets[index];
      const clip = clips[index];
      const local = Number(at) - entry.start;
      const minimum = 0.1;
      if (!Number.isFinite(local) || local <= minimum || local >= (entry.end - entry.start) - minimum) {
        throw new Error('播放头不在片段中间，无法分割');
      }
      const cut = round3(clip.in + local);
      const head = { ...clip, id: newId('clip'), out: cut };
      const tail = { ...clip, id: newId('clip'), in: cut };
      project.clips = [...clips.slice(0, index), head, tail, ...clips.slice(index + 1)];
      await store.save(project);
      return project;
    },

    /** Join a clip with an adjacent contiguous piece of the same source file. */
    async mergeClip({ projectId, clipId } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      const clips = project.clips ?? [];
      const index = clips.findIndex((clip) => clip.id === clipId);
      if (index < 0) throw new Error('找不到要合并的片段');
      const current = clips[index];
      const previous = clips[index - 1];
      const next = clips[index + 1];
      const mate = previous && previous.path === current.path && Math.abs(previous.out - current.in) < 0.01
        ? previous
        : next && next.path === current.path && Math.abs(current.out - next.in) < 0.01
          ? next
          : null;
      if (!mate) throw new Error('相邻片段不是同一素材的连续两段，无法合并');
      const merged = { ...current, in: Math.min(current.in, mate.in), out: Math.max(current.out, mate.out) };
      project.clips = clips.filter((clip) => clip !== mate).map((clip) => (clip === current ? merged : clip));
      await store.save(project);
      return project;
    },

    // ---- subtitles -------------------------------------------------------

    async setSubtitles({ projectId, segments = [], language, source = 'manual' } = {}) {
      const project = await studio.requireProject(projectId);
      await studio.record(project);
      project.subtitles.segments = normalizeSegments(segments);
      if (language) project.subtitles.language = language;
      project.subtitles.source = source;
      project.subtitles.updatedAt = new Date().toISOString();
      project.subtitles.staleAt = null;
      await store.save(project);
      return project;
    },

    async subtitlesToScript({ projectId } = {}) {
      const project = await studio.requireProject(projectId);
      return {
        text: (project.subtitles?.segments ?? []).map((segment) => segment.text).join('\n'),
        count: project.subtitles?.segments?.length ?? 0,
      };
    },

    // ---- long-running jobs ----------------------------------------------

    /** Guard against two heavy jobs mutating one project at once. */
    ensureIdle(kind) {
      const running = jobs.active().filter((job) => job.kind === kind);
      if (running.length > 0) {
        throw new Error(`已有${kind === 'render' ? '渲染' : kind === 'dub' ? '配音' : '识别'}任务在进行中`);
      }
    },

    async prepareSpeech(providerId) {
      return { providerId: prepareProvider(studio.speech, providerId ?? config.speechProviderId) };
    },

    /** Stop a slow or stuck model download without unloading the provider. */
    async cancelSpeech(providerId) {
      return { providerId: await cancelPreparationFor(studio.speech, providerId, config) };
    },

    /**
     * Kick off automatic subtitles. Returns the job immediately.
     */
    async startAutoSubtitles({ projectId, language } = {}) {
      const project = await studio.requireProject(projectId);
      studio.ensureIdle('subtitles');
      const job = jobs.start('subtitles', `自动字幕 · ${project.name}`);
      void (async () => {
        try {
          const workdir = await store.workDir(project.id);
          const result = await transcribeTimeline({
            speech: studio.speech,
            tools: toolsInfo,
            project,
            workdir,
            language,
            config,
            onProgress: (value, message) => jobs.progress(job.id, value, message),
          });
          const latest = await store.load(project.id);
          latest.subtitles.segments = result.segments;
          latest.subtitles.language = language ?? latest.subtitles.language ?? 'auto';
          latest.subtitles.source = 'auto';
          latest.subtitles.updatedAt = new Date().toISOString();
          latest.subtitles.staleAt = null;
          await store.save(latest);
          jobs.finish(job.id, {
            projectId: latest.id,
            segments: result.segments.length,
            chunks: result.chunks,
            provider: result.provider,
            language: result.language,
          }, `识别完成，共 ${result.segments.length} 条字幕`);
        } catch (error) {
          jobs.fail(job.id, error);
        }
      })();
      return jobs.get(job.id);
    },

    /**
     * Kick off dubbing from the current subtitles (or a narration script).
     */
    async startDub({ projectId, voice, rate, mode, script, fitToSegment } = {}) {
      const project = await studio.requireProject(projectId);
      studio.ensureIdle('dub');
      const tts = studio.tts();
      const info = await tts.info();
      if (!info.available) throw new Error(info.message ?? '本地配音不可用');
      const project0 = await studio.updateProject(project.id, {
        dub: {
          enabled: true,
          voice: voice ?? project.dub.voice ?? info.defaultVoice,
          rate: Number(rate ?? project.dub.rate ?? info.defaultRate),
          mode: mode ?? project.dub.mode ?? 'segments',
          script: script ?? project.dub.script ?? '',
          fitToSegment: fitToSegment ?? project.dub.fitToSegment ?? true,
        },
      });
      const job = jobs.start('dub', `自动配音 · ${project0.name}`);
      void (async () => {
        try {
          const workdir = await store.workDir(project0.id);
          const result = await generateDub({
            tts,
            tools: toolsInfo,
            project: project0,
            workdir,
            defaultVoice: info.defaultVoice,
            onProgress: (value, message) => jobs.progress(job.id, value, message),
          });
          const latest = await store.load(project0.id);
          latest.dub.track = result.track;
          latest.dub.generatedAt = new Date().toISOString();
          latest.dub.segments = result.segments;
          await store.save(latest);
          jobs.finish(job.id, { projectId: latest.id, count: result.count, track: result.track }, `配音完成，共 ${result.count} 句`);
        } catch (error) {
          jobs.fail(job.id, error);
        }
      })();
      return jobs.get(job.id);
    },

    /** Kick off a render. */
    async startRender({ projectId, options = {} } = {}) {
      const project = await studio.requireProject(projectId);
      studio.ensureIdle('render');
      const job = jobs.start('render', `渲染导出 · ${project.name}`);
      void (async () => {
        try {
          const workdir = await store.workDir(project.id);
          const render = await renderProject({
            tools: toolsInfo,
            store,
            project,
            options,
            onProgress: (value, message) => jobs.progress(job.id, value, message),
            ensureDub: async () => {
              const latest = await store.load(project.id);
              if (latest.dub?.track && existsSync(latest.dub.track)) return { track: latest.dub.track };
              const tts = studio.tts();
              const info = await tts.info();
              const result = await generateDub({
                tts,
                tools: toolsInfo,
                project: latest,
                workdir,
                defaultVoice: info.defaultVoice,
                onProgress: (value, message) => jobs.progress(job.id, 0.54 + value * 0.06, message),
              });
              const saved = await store.load(project.id);
              saved.dub.track = result.track;
              saved.dub.generatedAt = new Date().toISOString();
              saved.dub.segments = result.segments;
              await store.save(saved);
              return { track: result.track };
            },
          });
          jobs.finish(job.id, {
            projectId: project.id,
            file: render.file,
            name: path.basename(render.file),
            url: `/video-studio/api/media?p=${encodeURIComponent(render.file)}`,
            duration: render.duration,
          }, `导出完成：${path.basename(render.file)}`);
        } catch (error) {
          jobs.fail(job.id, error);
        }
      })();
      return jobs.get(job.id);
    },

    /** A short preview render (first N seconds) keeps iteration fast. */
    async previewAudio(projectId) {
      const project = await studio.requireProject(projectId);
      const workdir = await store.workDir(project.id);
      const { buildTimelineAudio } = await import('./ffmpeg.js');
      const audio = await buildTimelineAudio(toolsInfo, project.clips, workdir);
      return { file: audio };
    },

    safeName,
    projectDuration,
    clipOffsets,
    existsSync,
  };

  // Every async entry point bootstraps the data directories exactly once, so
  // tools and HTTP routes can register synchronously during plugin activation.
  const gated = [
    'setActive', 'activeProject', 'requireProject', 'state', 'listFiles', 'referencedPaths',
    'undo', 'redo', 'historyDepth',
    'createProject', 'openProject', 'removeProject', 'updateProject',
    'importMedia', 'updateClips', 'removeClip', 'splitClip', 'mergeClip', 'setSubtitles', 'thumbFor',
    'subtitlesToScript', 'prepareSpeech', 'cancelSpeech', 'startAutoSubtitles', 'startDub',
    'startRender', 'previewAudio',
  ];
  for (const key of gated) {
    const original = studio[key].bind(studio);
    studio[key] = async (...args) => {
      await studio.init();
      return original(...args);
    };
  }

  return studio;
}

/** Validate and sort client-supplied subtitle segments. */
export function normalizeSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const start = Math.max(0, Number(segment.start) || 0);
      const end = Math.max(start + 0.1, Number(segment.end) || start + 1);
      const text = String(segment.text ?? '').replace(/\s+/g, ' ').trim();
      return { start: round3(start), end: round3(end), text };
    })
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.start - b.start);
}

/**
 * Move subtitles along with an edited clip list.
 *
 * A line keeps its position in the source media, not its ratio: trimming a
 * clip's head shifts the line earlier by the trimmed amount, and a line whose
 * footage was trimmed away collapses onto the surviving edge and is dropped
 * when nothing of it remains. Reordering follows the clip it belongs to.
 */
export function retimeSegments(segments, previousClips, nextClips) {
  const oldOffsets = clipOffsets({ clips: previousClips });
  const newOffsets = clipOffsets({ clips: nextClips });
  const byId = new Map(newOffsets.map((entry) => [entry.clip.id, entry]));
  const result = [];
  for (const segment of segments) {
    const owner = oldOffsets.find((entry) => segment.start >= entry.start - 0.001 && segment.start <= entry.end + 0.001);
    const target = owner ? byId.get(owner.clip.id) : undefined;
    if (!owner || !target) {
      result.push(segment);
      continue;
    }
    // Absolute time -> source-media time within the old clip.
    const sourceTime = (time) => owner.clip.in + (time - owner.start);
    const toNew = (time) => {
      const clamped = Math.min(Math.max(sourceTime(time), target.clip.in), target.clip.out);
      return target.start + (clamped - target.clip.in);
    };
    const start = toNew(segment.start);
    const end = Math.max(start, toNew(segment.end));
    if (end - start < 0.05) continue;
    result.push({ ...segment, start: round3(start), end: round3(end) });
  }
  return result;
}

