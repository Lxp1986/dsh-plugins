import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';

const LIMIT = 12 * 1024 * 1024;
function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
function bodyJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > LIMIT) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
export function createApi(store) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.slice('/office-workbench'.length) || '/';
    try {
      if (req.method === 'GET' && route === '/api/documents') return send(res, 200, { documents: await store.list() });
      if (req.method === 'GET' && route === '/api/document') return send(res, 200, await store.read(url.searchParams.get('id')));
      if (req.method === 'POST' && route === '/api/import-office') return send(res, 200, await store.importOffice(await bodyJson(req)));
      if (req.method === 'POST' && route === '/api/save-office') return send(res, 200, await store.saveOffice(await bodyJson(req)));
      if (req.method === 'POST' && route === '/api/document') return send(res, 200, await store.save(await bodyJson(req)));
      if (req.method === 'DELETE' && route === '/api/document') return send(res, 200, await store.remove(url.searchParams.get('id')));
      if (req.method === 'GET' && route === '/api/export') {
        const document = await store.read(url.searchParams.get('id'));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(document.name))}`, 'cache-control': 'no-store' });
        createReadStream(resolve(document.path)).pipe(res); return;
      }
      return send(res, 404, { error: '未知办公工作台接口' });
    } catch (error) { return send(res, /不存在|无效|不能为空|超过|仅支持|必须/.test(error.message) ? 400 : 500, { error: error.message }); }
  };
}
