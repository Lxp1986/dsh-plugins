/**
 * Agent-facing tools.
 *
 * Every tool delegates to the shared studio facade, so the agent and the Web
 * panel drive exactly the same pipeline. Long operations return a job id; the
 * `wait` argument optionally blocks for a bounded time.
 */
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { speechStatus } from './asr.js';
import { projectDuration } from './project.js';

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }];

/**
 * Tool results must be lossless JSON: `undefined`, non-finite numbers and
 * functions are rejected by the runtime, so every result is normalized here
 * instead of relying on each action to omit them.
 */
export function jsonSafe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') return jsonSafe(value.toJSON());
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = jsonSafe(item);
    }
    return out;
  }
  return null;
}

const objectSchema = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

/** Poll a job until it settles or the wait window closes. */
async function waitForJob(studio, id, seconds) {
  const deadline = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  let job = studio.jobs.get(id);
  while (job && job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    job = studio.jobs.get(id);
  }
  return job;
}

/** Register every Video Studio tool. */
export function registerTools(ctx, studio) {
  const disposers = [];
  const register = (definition) => disposers.push(ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      return jsonSafe(await definition.execute(args, exec));
    },
  }));

  register({
    name: 'video_studio_status',
    description:
      'Video Studio 能力与项目总览：ffmpeg/ffprobe 可用性、自动字幕的语音识别提供方与模型准备状态、本地配音引擎与可用音色、已有项目列表与当前项目。开始任何剪辑工作前先调用它。',
    parameters: objectSchema({}),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute() {
      const state = await studio.state();
      return {
        build: 'canonical-wav-v1',
        ffmpeg: state.tools,
        dataRoot: state.config.dataRoot,
        mediaRoot: state.config.mediaRoot,
        speech: state.speech,
        tts: { available: state.tts.available, engine: state.tts.engine, defaultVoice: state.tts.defaultVoice, message: state.tts.message },
        activeProject: state.project
          ? {
            id: state.project.id,
            name: state.project.name,
            duration: projectDuration(state.project),
            clips: state.project.clips.length,
            subtitles: state.project.subtitles.segments.length,
            dubReady: Boolean(state.project.dub.track),
            renders: state.project.renders.length,
          }
          : null,
        projects: state.projects,
        hint: state.tools.ok
          ? '可以用 video_studio_project 创建/打开项目，再 video_studio_media 导入素材。'
          : state.tools.hint,
      };
    },
  });

  register({
    name: 'video_studio_project',
    description:
      'Video Studio 项目管理。action=create 新建（name、preset: landscape|portrait|square|720p）；open 打开（id）；list 列出；update 改名/改画幅/字幕样式/BGM/配音参数（patch）；delete 删除。项目保存在插件数据目录，请把素材的绝对路径或相对 mediaRoot 的路径交给 video_studio_media。',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['create', 'open', 'list', 'update', 'delete', 'undo', 'redo'], description: '要执行的操作' },
        id: { type: 'string', description: '项目 id（open/update/delete）' },
        name: { type: 'string', description: '项目名（create/update）' },
        preset: { type: 'string', description: '画幅预设：landscape|portrait|square|720p' },
        patch: { type: 'object', additionalProperties: true, description: 'update 的改动，如 {"name":"...","target":{"preset":"portrait"},"subtitleStyle":{"color":"#ffe066","fontSize":64},"bgm":{"path":"/abs/bgm.mp3","volume":0.3}}' },
      },
      ['action'],
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      switch (args?.action) {
        case 'create':
          return { project: await studio.createProject({ name: args.name, preset: args.preset }) };
        case 'open':
          return { project: await studio.openProject(args.id) };
        case 'list':
          return { projects: await studio.store.list(), activeProjectId: studio.activeId() };
        case 'update':
          return { project: await studio.updateProject(args.id, args.patch ?? {}) };
        case 'delete':
          return await studio.removeProject(args.id);
        case 'undo':
          return { project: await studio.undo({ projectId: args.id ?? args.projectId }) };
        case 'redo':
          return { project: await studio.redo({ projectId: args.id ?? args.projectId }) };
        default:
          throw new Error(`未知 action：${args?.action}`);
      }
    },
  });

  register({
    name: 'video_studio_media',
    description:
      'Video Studio 素材与时间线。action=files 列出媒体目录（dir 可省略，默认 mediaRoot）；import 把路径加入时间线（paths 数组，支持视频/音频/图片，图片按 imageDuration 秒静帧）；clips 读取当前时间线；update 修改片段（clips 数组，元素 {id,in,out,name}，修改会自动重算字幕时间）；remove 删除片段（clipId）。',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['files', 'import', 'clips', 'update', 'remove', 'split', 'merge'], description: '要执行的操作' },
        projectId: { type: 'string', description: '项目 id，省略则用当前项目' },
        dir: { type: 'string', description: 'files：要列出的目录' },
        paths: { type: 'array', items: { type: 'string' }, description: 'import：媒体文件路径数组' },
        imageDuration: { type: 'number', description: 'import：图片默认时长（秒），默认 5' },
        clips: {
          type: 'array',
          description: 'update：片段改动',
          items: objectSchema({
            id: { type: 'string' },
            in: { type: 'number' },
            out: { type: 'number' },
            name: { type: 'string' },
          }, ['id']),
        },
        clipId: { type: 'string', description: 'remove/split/merge：片段 id' },
        at: { type: 'number', description: 'split：时间线绝对秒数（播放头位置）' },
      },
      ['action'],
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      switch (args?.action) {
        case 'files':
          return await studio.listFiles(args.dir);
        case 'import': {
          const result = await studio.importMedia({
            projectId: args.projectId,
            paths: args.paths ?? [],
            imageDuration: args.imageDuration,
          });
          return {
            added: result.added.map((clip) => ({ id: clip.id, name: clip.name, duration: clip.duration, kind: clip.kind, hasAudio: clip.hasAudio })),
            skipped: result.skipped,
            timelineDuration: projectDuration(result.project),
            timeline: result.project.clips.map((clip, index) => ({ index, id: clip.id, name: clip.name, in: clip.in, out: clip.out })),
          };
        }
        case 'clips': {
          const project = await studio.requireProject(args.projectId);
          return {
            duration: projectDuration(project),
            clips: project.clips.map((clip, index) => ({
              index, id: clip.id, name: clip.name, kind: clip.kind,
              in: clip.in, out: clip.out, duration: clip.out - clip.in, hasAudio: clip.hasAudio,
            })),
          };
        }
        case 'update': {
          const project = await studio.updateClips({ projectId: args.projectId, clips: args.clips ?? [] });
          return { duration: projectDuration(project), clips: project.clips.map((clip) => ({ id: clip.id, in: clip.in, out: clip.out })) };
        }
        case 'remove': {
          const project = await studio.removeClip({ projectId: args.projectId, clipId: args.clipId });
          return { duration: projectDuration(project), clips: project.clips.length };
        }
        case 'split': {
          const project = await studio.splitClip({ projectId: args.projectId, clipId: args.clipId, at: args.at });
          return {
            duration: projectDuration(project),
            clips: project.clips.map((clip) => ({ id: clip.id, name: clip.name, in: clip.in, out: clip.out })),
            subtitles: project.subtitles.segments,
          };
        }
        case 'merge': {
          const project = await studio.mergeClip({ projectId: args.projectId, clipId: args.clipId });
          return { duration: projectDuration(project), clips: project.clips.length };
        }
        default:
          throw new Error(`未知 action：${args?.action}`);
      }
    },
  });

  register({
    name: 'video_studio_subtitles',
    description:
      'Video Studio 字幕。action=auto 用本地语音识别为整条时间线生成字幕（language: auto|zh|en|yue|ja|ko；wait 秒数默认 180）；set 直接写入字幕（segments: [{start,end,text}]，适合翻译或改写后回填，source 可写 translated）；get 读取当前字幕；script 返回纯文本逐行稿（便于翻译）；style 通过 video_studio_project 的 subtitleStyle 设置。',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['auto', 'set', 'get', 'script', 'prepare', 'cancel'], description: '要执行的操作' },
        projectId: { type: 'string', description: '项目 id，省略则用当前项目' },
        language: { type: 'string', description: '识别语言提示，默认 auto' },
        segments: {
          type: 'array',
          description: 'set：字幕数组',
          items: objectSchema({
            start: { type: 'number' },
            end: { type: 'number' },
            text: { type: 'string' },
          }, ['start', 'end', 'text']),
        },
        source: { type: 'string', description: 'set：来源标记' },
        wait: { type: 'number', description: 'auto：最多等待秒数，默认 180，超时返回任务 id' },
      },
      ['action'],
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      switch (args?.action) {
        case 'auto': {
          const job = await studio.startAutoSubtitles({ projectId: args.projectId, language: args.language });
          const settled = await waitForJob(studio, job.id, args.wait ?? 180);
          const project = await studio.requireProject(args.projectId);
          return {
            job: settled,
            subtitles: project.subtitles.segments,
            speech: speechStatus(studio.speech, studio.config),
          };
        }
        case 'set': {
          const project = await studio.setSubtitles({
            projectId: args.projectId,
            segments: args.segments ?? [],
            language: args.language,
            source: args.source ?? 'manual',
          });
          return { count: project.subtitles.segments.length, segments: project.subtitles.segments };
        }
        case 'get': {
          const project = await studio.requireProject(args.projectId);
          return { count: project.subtitles.segments.length, segments: project.subtitles.segments };
        }
        case 'script':
          return await studio.subtitlesToScript({ projectId: args.projectId });
        case 'prepare': {
          const prepared = await studio.prepareSpeech(args.providerId);
          return { ...prepared, speech: speechStatus(studio.speech, studio.config) };
        }
        case 'cancel': {
          const cancelled = await studio.cancelSpeech(args.providerId);
          return { ...cancelled, speech: speechStatus(studio.speech, studio.config) };
        }
        default:
          throw new Error(`未知 action：${args?.action}`);
      }
    },
  });

  register({
    name: 'video_studio_dub',
    description:
      'Video Studio 自动配音。action=voices 列出可用音色（macOS 本地 TTS）与默认音色；start 按字幕逐句合成配音并混入时间线（voice 音色 id、rate 语速默认 180、mode=segments 按字幕时间轴|narrate 按文稿铺满、script 旁白文稿、fitToSegment 是否变速对齐、wait 秒数默认 240）。生成后 export 时项目会自动混入配音轨。',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['voices', 'start'], description: '要执行的操作' },
        projectId: { type: 'string', description: '项目 id，省略则用当前项目' },
        voice: { type: 'string', description: '音色 id，例如 Tingting、Meijia、Sinji、Samantha' },
        rate: { type: 'number', description: '语速（词/分钟），默认 180' },
        mode: { type: 'string', enum: ['segments', 'narrate'], description: '配音来源' },
        script: { type: 'string', description: 'narrate 模式的旁白文稿' },
        fitToSegment: { type: 'boolean', description: '超过句长时变速对齐，默认 true' },
        wait: { type: 'number', description: '最多等待秒数，默认 240' },
      },
      ['action'],
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      if (args?.action === 'voices') {
        const info = await studio.tts().info({ all: false });
        return {
          available: info.available,
          engine: info.engine,
          defaultVoice: info.defaultVoice,
          defaultRate: info.defaultRate,
          voices: info.voices.map((voice) => ({ id: voice.id, locale: voice.locale, sample: voice.sample })),
          message: info.message,
        };
      }
      if (args?.action === 'start') {
        const job = await studio.startDub({
          projectId: args.projectId,
          voice: args.voice,
          rate: args.rate,
          mode: args.mode,
          script: args.script,
          fitToSegment: args.fitToSegment,
        });
        const settled = await waitForJob(studio, job.id, args.wait ?? 240);
        const project = await studio.requireProject(args.projectId);
        return {
          job: settled,
          dub: {
            voice: project.dub.voice,
            rate: project.dub.rate,
            mode: project.dub.mode,
            segments: project.dub.segments?.length ?? 0,
            track: project.dub.track ?? null,
          },
        };
      }
      throw new Error(`未知 action：${args?.action}`);
    },
  });

  register({
    name: 'video_studio_render',
    description:
      'Video Studio 渲染导出。action=start 开始导出 MP4（options: burnSubtitles 烧字幕、includeDub 混配音、includeBgm、originalVolume 原声、dubVolume 配音、muteOriginal 静音原声、crf 画质 0-51、preset、width/height/fps）；status 查询任务；copy 把成片复制到工作目录 video-studio-output。渲染较慢，建议先 start 拿到 job id，再用 video_studio_job 轮询。',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['start', 'status', 'copy'], description: '要执行的操作' },
        projectId: { type: 'string', description: '项目 id，省略则用当前项目' },
        options: { type: 'object', additionalProperties: true, description: '导出参数' },
        optionsId: { type: 'string', description: 'status：任务 id' },
        file: { type: 'string', description: 'copy：成片绝对路径' },
        wait: { type: 'number', description: 'start：最多等待秒数，默认 0 表示立即返回任务 id' },
      },
      ['action'],
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      switch (args?.action) {
        case 'start': {
          const job = await studio.startRender({ projectId: args.projectId, options: args.options ?? {} });
          const settled = args.wait ? await waitForJob(studio, job.id, args.wait) : job;
          return { job: settled };
        }
        case 'status': {
          const job = studio.jobs.get(args.optionsId);
          if (!job) throw new Error('任务不存在');
          return { job };
        }
        case 'copy': {
          if (!args.file) throw new Error('缺少成片路径');
          const dir = path.join(studio.store.mediaRoot, 'video-studio-output');
          await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
          const target = path.join(dir, path.basename(args.file));
          await copyFile(args.file, target);
          return { file: target };
        }
        default:
          throw new Error(`未知 action：${args?.action}`);
      }
    },
  });

  register({
    name: 'video_studio_job',
    description:
      'Video Studio 任务查询与等待。列出全部任务（list），或查看/等待某个任务（id，waitSeconds 默认 60）。返回 status=running|done|failed、progress 0-1、message 以及完成后的 result（成片路径等）。',
    parameters: objectSchema({
      id: { type: 'string', description: '任务 id，省略则列出全部任务' },
      waitSeconds: { type: 'number', description: '最多等待秒数，默认 60' },
      list: { type: 'boolean', description: 'true 时只列出任务列表' },
    }),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v) },
    async execute(args) {
      if (args?.list || !args?.id) {
        return { jobs: studio.jobs.list() };
      }
      const job = await waitForJob(studio, args.id, args.waitSeconds ?? 60);
      if (!job) throw new Error('任务不存在');
      return { job };
    },
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { text };
