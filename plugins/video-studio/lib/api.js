/**
 * The plugin's HTTP surface, mounted by the Host web server under
 * `/video-studio`. It serves the panel's JSON API, media byte ranges for the
 * preview player, and the download of finished renders.
 */
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { toSrt } from './subtitles.js';
import { ensureDir, newId } from './util.js';

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const MAX_JSON_BYTES = 4 * 1024 * 1024;

/** Read and parse a JSON request body with a hard size cap. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

/** Stream a file with byte-range support so `<video>` can seek. */
function sendFile(req, res, file) {
  let info;
  try {
    info = statSync(file);
  } catch {
    sendJson(res, 404, { ok: false, error: `文件不存在：${file}` });
    return;
  }
  if (!info.isFile()) {
    sendJson(res, 404, { ok: false, error: '不是文件' });
    return;
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * Only serve files this plugin can justify: anything under its data or media
 * root, plus paths a project document already references. Wider disk access is
 * never required, so a stray request cannot read an unrelated file.
 */
async function within(studio, file) {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return false;
  const roots = [path.resolve(studio.store.dataRoot), path.resolve(studio.store.mediaRoot)];
  if (roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return true;
  const referenced = await studio.referencedPaths();
  return referenced.has(resolved);
}

/**
 * Build the request handler.
 * @param {object} studio - the studio facade from createStudio.
 * @param {{ path?: string }} [options] - base path, default `/video-studio`.
 */
export function createApi(studio, options = {}) {
  const base = options.path ?? '/video-studio';
  // Per-activation secret injected into the page. It keeps other local
  // processes (which cannot read the authenticated index) out of the API.
  const token = options.token ?? null;

  const routes = {
    'GET /api/health': async () => ({
      ok: true,
      service: 'video-studio',
      dataRoot: studio.store.dataRoot,
      mediaRoot: studio.store.mediaRoot,
      ffmpeg: studio.refreshTools(),
    }),
    'GET /api/state': async (_body, query) => studio.state(query.get('projectId') ?? undefined),
    'GET /api/files': async (_body, query) => ({ ok: true, ...(await studio.listFiles(query.get('dir') ?? undefined)) }),
    'GET /api/jobs': async () => ({ ok: true, jobs: studio.jobs.list() }),
    'GET /api/job': async (_body, query) => {
      const job = studio.jobs.get(query.get('id'));
      if (!job) throw new Error('任务不存在');
      return { ok: true, job };
    },
    'GET /api/voices': async () => ({ ok: true, ...(await studio.tts().info({ all: true })) }),
    'GET /api/srt': async (_body, query) => {
      const project = await studio.requireProject(query.get('projectId') ?? undefined);
      return { ok: true, srt: toSrt(project.subtitles?.segments ?? []) };
    },
    'POST /api/project/create': async (body) => ({ ok: true, project: await studio.createProject(body) }),
    'POST /api/project/open': async (body) => {
      const project = await studio.openProject(body.id);
      return { ok: true, project };
    },
    'POST /api/project/update': async (body) => {
      const project = await studio.updateProject(body.projectId ?? body.id, body.patch ?? body);
      return { ok: true, project };
    },
    'POST /api/project/delete': async (body) => ({ ok: true, ...(await studio.removeProject(body.id ?? body.projectId)) }),
    'POST /api/import': async (body) => ({ ok: true, ...(await studio.importMedia(body)) }),
    'POST /api/project/undo': async (body) => ({ ok: true, project: await studio.undo(body) }),
    'POST /api/project/redo': async (body) => ({ ok: true, project: await studio.redo(body) }),
    'POST /api/clips/update': async (body) => ({ ok: true, project: await studio.updateClips(body) }),
    'POST /api/clips/remove': async (body) => ({ ok: true, project: await studio.removeClip(body) }),
    'POST /api/clips/split': async (body) => ({ ok: true, project: await studio.splitClip(body) }),
    'POST /api/clips/merge': async (body) => ({ ok: true, project: await studio.mergeClip(body) }),
    'POST /api/subtitles/auto': async (body) => ({ ok: true, job: await studio.startAutoSubtitles(body) }),
    'POST /api/subtitles/set': async (body) => ({ ok: true, project: await studio.setSubtitles(body) }),
    'POST /api/subtitles/script': async (body) => ({ ok: true, ...(await studio.subtitlesToScript(body)) }),
    'POST /api/speech/prepare': async (body) => ({ ok: true, ...(await studio.prepareSpeech(body.providerId)) }),
    'POST /api/speech/cancel': async (body) => ({ ok: true, ...(await studio.cancelSpeech(body.providerId)) }),
    'POST /api/dub/start': async (body) => ({ ok: true, job: await studio.startDub(body) }),
    'POST /api/render/start': async (body) => ({ ok: true, job: await studio.startRender(body) }),
    'POST /api/export/copy': async (body) => {
      const render = String(body.file ?? '');
      if (!render || !(await within(studio, render))) throw new Error('渲染文件不可用');
      const dir = await ensureDir(path.join(studio.store.mediaRoot, 'video-studio-output'));
      const target = path.join(dir, path.basename(render));
      await copyFile(render, target);
      return { ok: true, file: target };
    },
  };

  async function handleUpload(req, res, url) {
    const name = path.basename(url.searchParams.get('name') ?? `upload-${newId('f')}`);
    const dir = await ensureDir(path.join(studio.store.dataRoot, 'imports'));
    const target = path.join(dir, name);
    await new Promise((resolve, reject) => {
      const stream = createReadStreamFor(req, target);
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    const { added, skipped } = await studio.importMedia({
      projectId: url.searchParams.get('projectId') ?? undefined,
      paths: [target],
    });
    return { ok: true, file: target, added, skipped };
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;

    try {
      if (token !== null) {
        const provided = req.headers['x-vs-token'] ?? url.searchParams.get('t');
        if (provided !== token) {
          sendJson(res, 401, { ok: false, error: '未授权：请刷新页面后重试', code: 'unauthorized' });
          return;
        }
      }
      if (route === '/api/media') {
        const target = url.searchParams.get('p') ?? '';
        if (!target || !(await within(studio, target))) {
          sendJson(res, 404, { ok: false, error: '文件不可访问' });
          return;
        }
        sendFile(req, res, path.resolve(target));
        return;
      }
      if (route === '/api/thumb') {
        const target = url.searchParams.get('p') ?? '';
        if (!target || !(await within(studio, target))) {
          sendJson(res, 404, { ok: false, error: '文件不可访问' });
          return;
        }
        sendFile(req, res, await studio.thumbFor(target));
        return;
      }
      if (route === '/api/upload' && req.method === 'POST') {
        sendJson(res, 200, await handleUpload(req, res, url));
        return;
      }
      if (route === '/api/srt.txt') {
        const project = await studio.requireProject(url.searchParams.get('projectId') ?? undefined);
        sendText(res, 200, toSrt(project.subtitles?.segments ?? []));
        return;
      }
      const key = `${req.method} ${route}`;
      const action = routes[key];
      if (!action) {
        sendJson(res, 404, { ok: false, error: `未知接口：${key}` });
        return;
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const result = await action(body, url.searchParams);
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /不存在|为空|缺少/.test(message) ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: message,
        code: error?.code ?? null,
      });
    }
  };
}

/** Pipe the request body to a file (uploads never buffer in memory). */
function createReadStreamFor(req, target) {
  const stream = createWriteStream(target);
  req.pipe(stream);
  return stream;
}
