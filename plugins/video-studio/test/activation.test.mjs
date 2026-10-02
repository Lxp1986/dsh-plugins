/**
 * Activation test: runs the exact code path the Harness runs when it mounts
 * the plugin, against a minimal fake Context.
 *
 * Host modules are cached by the running process, so a change to `index.js`
 * only takes effect after a restart; this test exercises activation, the tool
 * registry, the HTTP route and every tool's output shape beforehand. It also
 * covers both API-gate modes: off by default, and enforced when the profile
 * config asks for `requireToken: true`.
 *
 * Usage: node test/activation.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'video-studio-activation-'));
const mediaRoot = path.join(root, 'media');
await mkdir(mediaRoot, { recursive: true });

/** One isolated plugin world: a fake Context plus everything it registered. */
function makeWorld() {
  const world = { tools: new Map(), routes: [], taps: [], effects: [] };
  world.ctx = {
    effect(callback) {
      const disposer = callback();
      world.effects.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{
            id: 'ws_test',
            path: mediaRoot,
            title: '测试工作区',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          }],
        };
      }
      return undefined;
    },
    logger: { error() {}, warn() {} },
    webServer: {
      register(route) {
        world.routes.push(route);
        return () => {};
      },
      tapIndex(transform) {
        world.taps.push(transform);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        world.tools.set(definition.name, definition);
        return () => world.tools.delete(definition.name);
      },
    },
  };
  return world;
}

/** Fail on any value the runtime would reject as non-lossless JSON. */
function assertLossless(value, label) {
  const seen = new Set();
  const walk = (node, at) => {
    if (node === undefined) throw new Error(`${label}: undefined at ${at}`);
    if (typeof node === 'number' && !Number.isFinite(node)) throw new Error(`${label}: non-finite number at ${at}`);
    if (typeof node === 'function') throw new Error(`${label}: function at ${at}`);
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) throw new Error(`${label}: cycle at ${at}`);
    seen.add(node);
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${at}[${index}]`));
    else for (const [key, item] of Object.entries(node)) walk(item, `${at}.${key}`);
    seen.delete(node);
  };
  walk(value, 'value');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON round-trip changed the value`);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const main = makeWorld();
const { apply, resolveConfig } = await import('../index.js');
apply(main.ctx, { dataRoot: path.join(root, 'data'), mediaRoot });

check('插件声明与配置解析', async () => {
  const { name, inject } = await import('../index.js');
  assert.equal(name, 'video-studio');
  assert.deepEqual(inject, ['tools', 'webServer']);

  const config = resolveConfig({ dataRoot: path.join(root, 'data'), mediaRoot }, main.ctx);
  assert.equal(config.mediaRoot, mediaRoot, 'an explicit mediaRoot is honoured');
  assert.equal(config.basePath, '/video-studio');
  assert.equal(config.tts.voice, 'Tingting');
  assert.notEqual(config.requireToken, true, 'the gate stays off unless configured');
});

check('apply() 注册 7 个工具与 1 条 HTTP 路由', () => {
  assert.equal(main.tools.size, 7, `expected 7 tools, got ${[...main.tools.keys()].join(', ')}`);
  assert.equal(main.routes.length, 1);
  const [route] = main.routes;
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/video-studio');
  assert.equal(typeof route.handler, 'function');
  assert.equal(main.taps.length, 0, 'no index injection is needed while the gate is off');
});

check('每个工具的 schema 与输出定义合法', () => {
  for (const [name, definition] of main.tools) {
    assert.equal(typeof definition.description, 'string', `${name} needs a description`);
    assert.ok(definition.description.length > 20, `${name} description is too short`);
    assert.equal(definition.parameters.type, 'object', `${name} parameters must be an object schema`);
    assert.equal(typeof definition.parameters.properties, 'object', `${name} parameters need properties`);
    assert.ok(definition.output && definition.output.schema, `${name} needs an output schema`);
    assert.equal(typeof definition.output.render, 'function', `${name} needs an output renderer`);
    const blocks = definition.output.render({}, { ok: true });
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text', `${name} renderer must return a text block`);
  }
});

check('工具调用返回无损 JSON（含 speech/tts 的可选字段）', async () => {
  const status = await main.tools.get('video_studio_status').execute({}, {});
  assertLossless(status, 'video_studio_status');
  assert.ok(status.ffmpeg, 'status should report ffmpeg');
  assert.equal(status.mediaRoot, mediaRoot, 'mediaRoot resolves as configured');

  const voices = await main.tools.get('video_studio_dub').execute({ action: 'voices' }, {});
  assertLossless(voices, 'video_studio_dub voices');

  const created = await main.tools.get('video_studio_project').execute({ action: 'create', name: '激活测试', preset: 'portrait' }, {});
  assertLossless(created, 'project create');
  assert.equal(created.project.target.width, 1080);

  const subs = await main.tools.get('video_studio_subtitles').execute(
    { action: 'set', segments: [{ start: 0, end: 1.5, text: '激活路径字幕' }] },
    {},
  );
  assertLossless(subs, 'subtitles set');
  assert.equal(subs.count, 1);

  const history = await main.tools.get('video_studio_job').execute({ list: true }, {});
  assertLossless(history, 'job list');
});

check('失败以同步异常或带错误的任务两种方式暴露', async () => {
  const imported = await main.tools.get('video_studio_media').execute(
    { action: 'import', paths: ['/definitely/missing.mp4'] },
    {},
  );
  assert.equal(imported.added.length, 0);
  assert.match(imported.skipped[0].error, /文件不存在/);

  const jobTool = main.tools.get('video_studio_job');
  const render = await main.tools.get('video_studio_render').execute({ action: 'start' }, {});
  const settledRender = await jobTool.execute({ id: render.job.id, waitSeconds: 15 }, {});
  assert.equal(settledRender.job.status, 'failed');
  assert.match(String(settledRender.job.error), /时间线为空/);

  await assert.rejects(
    () => main.tools.get('video_studio_project').execute({ action: 'nonsense' }, {}),
    /未知 action/,
  );
  await assert.rejects(
    () => main.tools.get('video_studio_media').execute({ action: 'clips', projectId: 'proj_missing' }, {}),
    /项目不存在/,
  );
});

check('HTTP 路由默认可直接访问（令牌门关闭）', async () => {
  const [route] = main.routes;
  const server = createServer((req, res) => void route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/video-studio`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ok, true);
    assert.ok(state.workspaces.length >= 1, 'state should expose workspaces');
    assert.ok(state.history && typeof state.history.past === 'number', 'state should expose undo depth');
    assert.equal(state.projects.length, 1);
    const escape = await fetch(`${base}/api/media?p=${encodeURIComponent('/etc/hosts')}`);
    assert.equal(escape.status, 404);
    const unknown = await (await fetch(`${base}/api/nope`)).json();
    assert.equal(unknown.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

check('显式开启令牌门时校验令牌', async () => {
  const gatedWorld = makeWorld();
  apply(gatedWorld.ctx, { dataRoot: path.join(root, 'data-gated'), mediaRoot, requireToken: true });
  const [route] = gatedWorld.routes;
  const server = createServer((req, res) => void route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/video-studio`;
  try {
    assert.equal(gatedWorld.taps.length, 1, 'the gate must inject its token into the index');
    const injected = gatedWorld.taps[0]('<html><head></head><body></body></html>');
    const token = /__VIDEO_STUDIO_TOKEN__="([0-9a-f]+)"/.exec(injected)?.[1];
    assert.ok(token, `token missing from injected html: ${injected.slice(0, 120)}`);
    assert.match(injected, /<body data-vs-token="/, 'the token must also reach the DOM as an attribute');
    assert.ok(injected.indexOf('</head>') > injected.indexOf('__VIDEO_STUDIO_TOKEN__'));

    const denied = await fetch(`${base}/api/state`);
    assert.equal(denied.status, 401, 'a request without the token must be rejected');
    assert.equal((await denied.json()).code, 'unauthorized');

    const allowed = await (await fetch(`${base}/api/state`, { headers: { 'x-vs-token': token } })).json();
    assert.equal(allowed.ok, true);
    const viaQuery = await (await fetch(`${base}/api/state?t=${token}`)).json();
    assert.equal(viaQuery.ok, true, 'media URLs pass the token as a query parameter');
    assert.equal((await fetch(`${base}/api/state?t=deadbeef`)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

let failures = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failures === 0 ? `\n激活路径 ${checks.length} 项全部通过` : `\n${failures}/${checks.length} 项失败`);
await rm(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
