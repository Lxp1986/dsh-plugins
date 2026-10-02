/**
 * End-to-end pipeline test for the Video Studio host half.
 *
 * Runs entirely outside Harness: it synthesizes its own media with ffmpeg/say,
 * drives the real studio facade, and asserts on the produced artifacts. The
 * speech service is stubbed so the test needs no 239 MB model download; the
 * real provider is exercised separately after installation.
 *
 * Usage: node test/pipeline.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../lib/api.js';
import { createStudio } from '../lib/studio.js';
import { retimeSegments } from '../lib/studio.js';
import { planLines, segmentsFromChunk, toAss, toSrt } from '../lib/subtitles.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'video-studio-test-'));
const mediaRoot = path.join(root, 'media');
const dataRoot = path.join(root, 'data');
await import('node:fs/promises').then((fs) => fs.mkdir(mediaRoot, { recursive: true }));

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

const ffmpeg = 'ffmpeg';
const say = 'say';

// ---------------------------------------------------------------- fixtures

console.log('· 生成测试素材');
const speech1 = path.join(mediaRoot, 'speech1.aiff');
const speech2 = path.join(mediaRoot, 'speech2.aiff');
run(say, ['-v', 'Tingting', '-o', speech1, '你好，欢迎使用视频剪辑插件。']);
run(say, ['-v', 'Tingting', '-o', speech2, '今天我们来做自动字幕和自动配音。']);
const videoTrack = path.join(mediaRoot, 'video.mp4');
run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', 'testsrc=size=640x360:rate=25:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoTrack]);
const speechAudio = path.join(mediaRoot, 'speech.wav');
run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-t', '1.0', '-i', 'anullsrc=r=44100:cl=mono',
  '-i', speech1,
  '-f', 'lavfi', '-t', '1.2', '-i', 'anullsrc=r=44100:cl=mono',
  '-i', speech2,
  '-f', 'lavfi', '-t', '0.8', '-i', 'anullsrc=r=44100:cl=mono',
  '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[out]',
  '-map', '[out]', '-ar', '44100', '-ac', '1', speechAudio]);
const mainClip = path.join(mediaRoot, 'main.mp4');
run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoTrack, '-i', speechAudio,
  '-c:v', 'copy', '-c:a', 'aac', '-shortest', mainClip]);
const silentClip = path.join(mediaRoot, 'silent.mp4');
run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', 'color=c=navy:s=1280x720:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentClip]);
const still = path.join(mediaRoot, 'still.png');
run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', 'color=c=orange:s=800x600:d=1', '-frames:v', '1', still]);

// A stub recognizer standing in for the shipped SenseVoice provider: it reports
// readiness and returns the known transcript, so this test needs no model.
const spoken = ['你好，欢迎使用视频剪辑插件。', '今天我们来做自动字幕和自动配音。'];
const fullTranscript = spoken.join('');
const speechStub = {
  snapshot: () => ({
    providers: [{
      id: 'stub-sensevoice',
      name: 'Stub SenseVoice',
      languages: ['auto', 'zh', 'en'],
      preparation: { phase: 'ready' },
      downloadSources: [],
    }],
    selection: { providerId: 'stub-sensevoice', language: 'auto' },
  }),
  resolve: (request) => ({ provider: { info: { id: 'stub-sensevoice' } }, audio: request.audio, language: request.language ?? 'auto' }),
  transcribe: async () => ({ text: fullTranscript, audioSeconds: 2, inferenceSeconds: 0.1 }),
  prepare: () => {},
  listProviders: () => [],
};

const studio = await createStudio({
  config: {
    dataRoot,
    mediaRoot,
    allowAnyPath: true,
    imageDuration: 4,
    silenceMin: 0.4,
    chunkSeconds: 18,
  },
  getSpeech: () => speechStub,
});
await studio.init();

// ------------------------------------------------------------------ units

check('字幕分行按标点与长度切分', () => {
  const lines = planLines('你好，欢迎使用视频剪辑插件。今天我们来做自动字幕和自动配音。');
  assert.ok(lines.length >= 2, `expected >=2 lines, got ${JSON.stringify(lines)}`);
  assert.ok(lines.every((line) => line.length <= 40));
});

check('SRT / ASS 时间与样式正确', () => {
  const segments = [{ start: 0, end: 2.5, text: '你好，世界。' }];
  const srt = toSrt(segments);
  assert.match(srt, /00:00:00,000 --> 00:00:02,500/);
  const ass = toAss(segments, { width: 1080, height: 1920, style: { color: '#ffe066' } });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Style: Default,PingFang SC,/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:02.50/);
});

check('语音区间 → 字幕时间映射', () => {
  const segments = segmentsFromChunk({
    text: '第一句话。第二句话。第三句话。',
    offset: 0,
    intervals: [{ start: 1, end: 3 }, { start: 5, end: 8 }],
  });
  assert.equal(segments.length, 3);
  assert.ok(segments[0].start >= 1 && segments[0].start <= 1.4, `start=${segments[0].start}`);
  assert.ok(segments[segments.length - 1].end <= 8.7, `end=${segments[segments.length - 1].end}`);
  for (const segment of segments) assert.ok(segment.end > segment.start);
});

check('片段裁剪后字幕自动重算时间', () => {
  const previous = [
    { id: 'a', in: 0, out: 10 },
    { id: 'b', in: 0, out: 5 },
  ];
  const next = [
    { id: 'a', in: 0, out: 5 },
    { id: 'b', in: 0, out: 5 },
  ];
  const result = retimeSegments(
    [
      { start: 11, end: 12, text: '落在第二个片段' },
      { start: 2, end: 3, text: '落在第一个片段' },
      { start: 8, end: 9, text: '被裁掉的片段' },
    ],
    previous,
    next,
  );
  const second = result.find((segment) => segment.text.includes('第二个'));
  // clip b keeps its length, so the line stays 1s into it: 5 + 1 = 6
  assert.ok(Math.abs(second.start - 6) < 0.01, `expected 6s, got ${second.start}`);
  const first = result.find((segment) => segment.text.includes('第一个'));
  // trimming clip a's tail does not move a line near its head
  assert.ok(Math.abs(first.start - 2) < 0.01, `expected 2s, got ${first.start}`);
  const trimmed = result.find((segment) => segment.text.includes('被裁掉'));
  // 8s of clip a no longer exists, so the line has no surviving footage
  assert.equal(trimmed, undefined, 'fully trimmed lines must be dropped');
});

// ------------------------------------------------------------- project flow

let project;
let renderFile;

check('创建项目并导入视频/图片素材', async () => {
  project = await studio.createProject({ name: '测试项目', preset: 'landscape' });
  assert.equal(project.clips.length, 0);
  const result = await studio.importMedia({
    projectId: project.id,
    paths: [mainClip, silentClip, still],
  });
  // import returns before the derived visuals exist; they are written in the
  // background, so the assertions read the project back from disk
  assert.equal(result.added.length, 3, JSON.stringify(result.skipped));
  assert.equal(result.added[0].poster, null, 'import must not block on thumbnail generation');
  await studio.whenIdle();
  project = await studio.requireProject(project.id);
  assert.equal(project.clips.length, 3);
  assert.deepEqual(project.clips.map((clip) => clip.kind), ['video', 'video', 'image']);
  assert.ok(project.clips[0].hasAudio);
  assert.equal(project.clips[1].hasAudio, false);
  assert.equal(project.clips[2].duration, 4);
  assert.ok(existsSync(project.clips[0].poster), 'poster frame should exist');
});

check('素材可视化：胶片缩略条与音频波形', async () => {
  const main = project.clips.find((clip) => clip.hasAudio && clip.kind === 'video');
  const silent = project.clips.find((clip) => !clip.hasAudio);
  const image = project.clips.find((clip) => clip.kind === 'image');
  assert.ok(existsSync(main.strip), 'video clip needs a filmstrip');
  assert.ok(existsSync(main.waveform), 'clip with audio needs a waveform');
  assert.equal(silent.waveform, null, 'silent clip must not gain a waveform');
  assert.ok(existsSync(image.strip), 'image clip needs a strip frame');
  const strip = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', main.strip]).trim();
  const [stripWidth, stripHeight] = strip.split(',').map(Number);
  assert.ok(stripWidth > 500 && stripWidth <= 2000, `unexpected strip width ${stripWidth}`);
  assert.equal(stripHeight, 96);
  const wave = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', main.waveform]).trim();
  assert.equal(wave, '1200,72');
});

check('分割与合并片段', async () => {
  const before = project.clips.length;
  const target = project.clips[0];
  const at = 4;
  const split = await studio.splitClip({ projectId: project.id, clipId: target.id, at });
  assert.equal(split.clips.length, before + 1);
  assert.equal(split.clips[0].out, 4);
  assert.equal(split.clips[1].in, 4);
  const durationBefore = studio.projectDuration(split);
  // a split is structural: total duration and subtitle times are untouched
  assert.ok(Math.abs(durationBefore - studio.projectDuration(project)) < 0.001);
  await assert.rejects(() => studio.splitClip({ projectId: project.id, clipId: split.clips[0].id, at: 0.02 }), /无法分割/);
  const merged = await studio.mergeClip({ projectId: project.id, clipId: split.clips[1].id });
  assert.equal(merged.clips.length, before);
  assert.ok(Math.abs(studio.projectDuration(merged) - durationBefore) < 0.001);
  project = await studio.requireProject(project.id);
});

check('部分片段补丁不会删除其它片段', async () => {
  const before = await studio.requireProject(project.id);
  const target = before.clips[0];
  const patched = await studio.updateClips({ projectId: project.id, clips: [{ id: target.id, in: 0, out: 3 }] });
  assert.equal(patched.clips.length, before.clips.length, 'a one-clip patch must not drop the rest');
  assert.ok(Math.abs(patched.clips[0].out - 3) < 0.01, 'patch applied');
  assert.deepEqual(patched.clips.map((clip) => clip.id), before.clips.map((clip) => clip.id));
  const restored = await studio.undo({ projectId: project.id });
  assert.ok(Math.abs(restored.clips[0].out - target.out) < 0.01, 'undo restored the cut');
  project = await studio.requireProject(project.id);
});

check('撤销 / 重做', async () => {
  const before = await studio.requireProject(project.id);
  const target = before.clips[0];
  await studio.updateClips({
    projectId: project.id,
    clips: before.clips.map((clip) => (clip.id === target.id ? { ...clip, in: 0, out: 3 } : { ...clip })),
  });
  const trimmed = await studio.requireProject(project.id);
  assert.ok(Math.abs(trimmed.clips[0].out - 3) < 0.01, 'trim applied');
  assert.equal(trimmed.clips.length, before.clips.length);

  const undone = await studio.undo({ projectId: project.id });
  assert.ok(Math.abs(undone.clips[0].out - target.out) < 0.01, `undo restored ${undone.clips[0].out} vs ${target.out}`);
  assert.equal(undone.subtitles.segments.length, before.subtitles.segments.length);

  const redone = await studio.redo({ projectId: project.id });
  assert.ok(Math.abs(redone.clips[0].out - 3) < 0.01, 'redo re-applied the trim');

  const depth = await studio.historyDepth(project.id);
  assert.equal(depth.future, 0, 'a fresh edit clears the redo branch');
  assert.ok(depth.past >= 1);

  // undoing an import removes the clips again
  await studio.importMedia({ projectId: project.id, paths: [silentClip] });
  await studio.whenIdle();
  const grown = await studio.requireProject(project.id);
  assert.equal(grown.clips.length, before.clips.length + 1);
  const shrunk = await studio.undo({ projectId: project.id });
  assert.equal(shrunk.clips.length, before.clips.length, 'undo removed the imported clip');

  await assert.rejects(() => studio.redo({ projectId: 'proj_missing' }), /项目不存在/);

  // leave the timeline untrimmed for the checks that follow
  const restored = await studio.undo({ projectId: project.id });
  assert.ok(Math.abs(restored.clips[0].out - target.out) < 0.01, 'timeline restored for later checks');
  project = restored;
});

check('自动字幕：静音分段 + 识别 + 时间对齐', async () => {
  const job = await studio.startAutoSubtitles({ projectId: project.id, language: 'zh' });
  const settled = await waitFor(studio, job.id);
  assert.equal(settled.status, 'done', settled.error ?? '');
  project = await studio.requireProject(project.id);
  const segments = project.subtitles.segments;
  assert.ok(segments.length >= 2, `expected >=2 segments, got ${segments.length}`);
  const first = segments[0];
  assert.ok(first.start >= 0.4 && first.start <= 2.2, `first segment start=${first.start}`);
  // the second sentence sits after the 1.2s pause, so it must not start early
  const second = segments[1];
  assert.ok(second.start >= 3.6, `second segment start=${second.start}`);
  const total = studio.projectDuration(project);
  assert.ok(segments[segments.length - 1].end <= total + 0.5);
  assert.ok(segments.every((segment) => segment.text.length > 0));
  assert.ok(segments.every((segment) => segment.end > segment.start));
});

check('长音频按停顿切分成多次识别请求', async () => {
  const chunkRoot = path.join(root, 'data-chunked');
  let calls = 0;
  const chunkStub = {
    ...speechStub,
    transcribe: async () => {
      const text = spoken[Math.min(calls, spoken.length - 1)];
      calls += 1;
      return { text, audioSeconds: 2, inferenceSeconds: 0.1 };
    },
  };
  const chunkStudio = await createStudio({
    config: { dataRoot: chunkRoot, mediaRoot, allowAnyPath: true, chunkSeconds: 2.2, silenceMin: 0.4 },
    getSpeech: () => chunkStub,
  });
  const chunkProject = await chunkStudio.createProject({ name: '切分测试' });
  await chunkStudio.importMedia({ projectId: chunkProject.id, paths: [mainClip] });
  await chunkStudio.whenIdle();
  const job = await chunkStudio.startAutoSubtitles({ projectId: chunkProject.id, language: 'zh' });
  const settled = await waitFor(chunkStudio, job.id);
  assert.equal(settled.status, 'done', settled.error ?? '');
  assert.ok(settled.result.chunks >= 2, `expected >=2 chunks, got ${settled.result.chunks}`);
  assert.ok(calls >= 2, `expected >=2 recognizer calls, got ${calls}`);
  const project2 = await chunkStudio.requireProject(chunkProject.id);
  assert.ok(project2.subtitles.segments.length >= 2);
  const starts = project2.subtitles.segments.map((segment) => segment.start);
  assert.ok(starts[1] > starts[0], 'segments must stay in timeline order');
});

check('字幕可被翻译/改写后回填', async () => {
  const translated = project.subtitles.segments.map((segment) => ({
    ...segment,
    text: `Hello ${Math.round(segment.start * 10) / 10}s`,
  }));
  const updated = await studio.setSubtitles({ projectId: project.id, segments: translated, source: 'translated' });
  assert.equal(updated.subtitles.source, 'translated');
  const script = await studio.subtitlesToScript({ projectId: project.id });
  assert.equal(script.count, translated.length);
  // restore the recognized text for the render assertions
  await studio.setSubtitles({ projectId: project.id, segments: project.subtitles.segments, source: 'auto' });
  project = await studio.requireProject(project.id);
});

check('自动配音：逐句合成、变速对齐、混排成轨', async () => {
  const job = await studio.startDub({ projectId: project.id, voice: 'Tingting', rate: 180, mode: 'segments' });
  const settled = await waitFor(studio, job.id);
  assert.equal(settled.status, 'done', settled.error ?? '');
  project = await studio.requireProject(project.id);
  assert.ok(project.dub.track && existsSync(project.dub.track), 'dub track should exist');
  assert.ok(project.dub.segments.length >= 2);
  for (const segment of project.dub.segments) {
    assert.ok(existsSync(segment.file), `segment file ${segment.file}`);
    assert.ok(segment.duration > 0.2);
  }
  const info = await stat(project.dub.track);
  assert.ok(info.size > 10000, `dub track too small: ${info.size}`);
});

check('渲染导出：烧字幕 + 混配音', async () => {
  const job = await studio.startRender({
    projectId: project.id,
    options: { burnSubtitles: true, includeDub: true, originalVolume: 0.2, crf: 26, preset: 'veryfast' },
  });
  const settled = await waitFor(studio, job.id, 240000);
  assert.equal(settled.status, 'done', settled.error ?? '');
  renderFile = settled.result.file;
  assert.ok(existsSync(renderFile));
  const info = await stat(renderFile);
  assert.ok(info.size > 20000, `render too small: ${info.size}`);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', renderFile]));
  const duration = Number(probe.format.duration);
  const expected = studio.projectDuration(project);
  assert.ok(Math.abs(duration - expected) < 1.0, `duration ${duration} vs expected ${expected}`);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.ok(audio, 'render must carry an audio track');
  project = await studio.requireProject(project.id);
  assert.equal(project.renders.length, 1);
});

check('背景音乐混音与字幕样式', async () => {
  const bgm = path.join(mediaRoot, 'bgm.mp3');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame', bgm]);
  await studio.updateProject(project.id, {
    bgm: { path: bgm, volume: 0.3 },
    subtitleStyle: { color: '#ffe066', fontSize: 64, outline: 3 },
  });
  project = await studio.requireProject(project.id);
  assert.equal(project.subtitles.style.color, '#ffe066');

  const job = await studio.startRender({
    projectId: project.id,
    options: { burnSubtitles: true, includeDub: true, includeBgm: true, crf: 30, preset: 'veryfast' },
  });
  const settled = await waitFor(studio, job.id, 240000);
  assert.equal(settled.status, 'done', settled.error ?? '');

  // the ASS actually used by the burn-in carries the configured style
  const assPath = path.join(await studio.store.workDir(project.id), 'subs.ass');
  assert.ok(existsSync(assPath), 'subs.ass should exist');
  const ass = await readFile(assPath, 'utf8');
  assert.match(ass, /,64,/, 'font size should come from the style');
  assert.match(ass, /&H0066E0FF/, '#ffe066 should serialize to ASS BGR');
  assert.match(ass, /,3,/, 'outline width should come from the style');

  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', settled.result.file]));
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(audio, 'BGM render must keep an audio track');
  assert.ok(Math.abs(Number(probe.format.duration) - studio.projectDuration(project)) < 1.0);
});

// ---------------------------------------------------------------- HTTP API

check('HTTP API：状态/素材/字幕/任务/媒体 Range', async () => {
  const handler = createApi(studio, { path: '/video-studio' });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/video-studio`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.ok(health.ffmpeg.ffmpeg, 'ffmpeg path should resolve');

    const state = await (await fetch(`${base}/api/state?projectId=${project.id}`)).json();
    assert.equal(state.ok, true);
    assert.equal(state.project.id, project.id);
    assert.equal(state.speech.ready, true);
    assert.ok(state.tts.voices.length > 0, 'voice catalog should be populated');
    assert.ok(state.tts.voices.some((voice) => /^(zh|en)/.test(voice.locale)));

    const files = await (await fetch(`${base}/api/files?dir=${encodeURIComponent(mediaRoot)}`)).json();
    assert.ok(files.files.some((file) => file.name === 'main.mp4'));

    const created = await (await fetch(`${base}/api/project/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP 项目', preset: 'portrait' }),
    })).json();
    assert.equal(created.ok, true);
    assert.equal(created.project.target.width, 1080);

    const imported = await (await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.project.id, paths: [mainClip] }),
    })).json();
    assert.equal(imported.ok, true);
    assert.equal(imported.added.length, 1);
    await studio.whenIdle();

    const set = await (await fetch(`${base}/api/subtitles/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: created.project.id,
        segments: [{ start: 0.5, end: 2, text: '手写字幕' }],
      }),
    })).json();
    assert.equal(set.project.subtitles.segments.length, 1);

    const srt = await (await fetch(`${base}/api/srt.txt?projectId=${created.project.id}`)).text();
    assert.match(srt, /手写字幕/);

    // media byte range for the preview player
    const rangeResponse = await fetch(`${base}/api/media?p=${encodeURIComponent(renderFile)}`, {
      headers: { range: 'bytes=0-1023' },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('content-range')?.startsWith('bytes 0-1023/'), true);
    const bytes = new Uint8Array(await rangeResponse.arrayBuffer());
    assert.equal(bytes.length, 1024);

    const renderJob = await (await fetch(`${base}/api/render/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.project.id, options: { burnSubtitles: true, preset: 'veryfast', crf: 30 } }),
    })).json();
    assert.equal(renderJob.ok, true);
    assert.equal(renderJob.job.status, 'running');
    const settled = await waitForHttp(`${base}/api/job?id=${renderJob.job.id}`);
    assert.equal(settled.status, 'done', settled.error ?? '');
    assert.ok(existsSync(settled.result.file));

    // raw upload -> imports dir -> timeline
    const uploadBytes = await readFile(mainClip);
    const upload = await (await fetch(`${base}/api/upload?name=uploaded-clip.mp4&projectId=${created.project.id}`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: uploadBytes,
    })).json();
    assert.equal(upload.ok, true, upload.error ?? '');
    assert.equal(upload.added.length, 1);
    assert.ok(existsSync(upload.file), 'uploaded file should exist on disk');
    assert.equal((await stat(upload.file)).size, uploadBytes.length);

    // trimming a clip retimes subtitles: a line across the cut survives shorter,
    // a line entirely inside the trimmed head disappears
    await fetch(`${base}/api/subtitles/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: created.project.id,
        segments: [
          { start: 1, end: 4, text: '跨切点' },
          { start: 0.2, end: 0.9, text: '被裁掉' },
        ],
      }),
    });
    const trimmed = await (await fetch(`${base}/api/clips/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: created.project.id,
        clips: [{ id: imported.added[0].id, in: 2, out: 8 }],
      }),
    })).json();
    assert.equal(trimmed.ok, true, trimmed.error ?? '');
    const kept = trimmed.project.subtitles.segments;
    assert.equal(kept.length, 1, `expected only the spanning line to survive, got ${JSON.stringify(kept)}`);
    assert.equal(kept[0].text, '跨切点');
    assert.ok(Math.abs(kept[0].start) < 0.01, `expected the line at the new head, got ${kept[0].start}`);
    assert.ok(Math.abs(kept[0].end - 2) < 0.01, `expected 2s of it to remain, got ${kept[0].end}`);

    // media-bin thumbnail for an arbitrary file (cached on disk)
    const thumb = await fetch(`${base}/api/thumb?p=${encodeURIComponent(silentClip)}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    assert.ok(thumbBytes.length > 200, `thumbnail too small: ${thumbBytes.length}`);
    const missingThumb = await fetch(`${base}/api/thumb?p=${encodeURIComponent('/etc/hosts')}`);
    assert.equal(missingThumb.status, 404);

    // split / merge through HTTP
    const splitHttp = await (await fetch(`${base}/api/clips/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.project.id, clipId: imported.added[0].id, at: 3 }),
    })).json();
    assert.equal(splitHttp.ok, true, splitHttp.error ?? '');
    const mergeHttp = await (await fetch(`${base}/api/clips/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.project.id, clipId: splitHttp.project.clips[1].id }),
    })).json();
    assert.equal(mergeHttp.ok, true, mergeHttp.error ?? '');
    assert.equal(mergeHttp.project.clips.length, splitHttp.project.clips.length - 1);

    const bad = await fetch(`${base}/api/media?p=${encodeURIComponent('/etc/hosts')}`);
    assert.equal(bad.status, 404, 'unrelated paths must not be served');

    const unknown = await (await fetch(`${base}/api/nope`)).json();
    assert.equal(unknown.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await writeFile(path.join(root, 'last-render.txt'), renderFile ?? '', 'utf8');

// ------------------------------------------------------------------- report

let failures = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    const where = error instanceof Error ? (error.stack ?? '').split('\n').find((line) => line.includes('pipeline.test.mjs')) : '';
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}\n      at ${(where ?? '').trim()}`);
  }
}
console.log(failures === 0 ? `\n全部 ${checks.length} 项通过` : `\n${failures}/${checks.length} 项失败`);
if (existsSync(renderFile ?? '')) console.log(`成片：${renderFile}`);
if (process.env.KEEP_TEST_DIR !== '1') await rm(root, { recursive: true, force: true });
else console.log(`测试目录保留在：${root}`);
process.exit(failures === 0 ? 0 : 1);

async function waitFor(studioRef, id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = studioRef.jobs.get(id);
    if (job && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function waitForHttp(url, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await (await fetch(url)).json()).job;
    if (job && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error('http job timed out');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

void readFile;
