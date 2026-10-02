import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'office-plugin-'));
const tools = new Map(); const routes = new Map(); const effects = [];
const ctx = {
  tools: { register(def) { assert.ok(!tools.has(def.name)); tools.set(def.name, def); return () => tools.delete(def.name); } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
  effect(fn) { effects.push(fn()); }, logger: { error(message) { throw new Error(message); } },
};
try {
  apply(ctx, { dataRoot: root });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...tools.keys()].sort(), ['office_delete_document', 'office_list_documents', 'office_open_in_app', 'office_read_document', 'office_save_document', 'office_sync_back', 'office_update_office']);
  assert.match(tools.get('office_update_office').description, /appendItems/);
  assert.match(tools.get('office_open_in_app').description, /ONLYOFFICE/);
  assert.ok(routes.has('/office-workbench'));
  const save = tools.get('office_save_document');
  await save.execute({ name: 'Agent 草稿.md', content: '由 Agent 写入' });
  const listed = await tools.get('office_list_documents').execute({});
  assert.equal(listed.documents[0].name, 'Agent 草稿.md');
  const read = await tools.get('office_read_document').execute({ id: 'Agent 草稿.md' });
  assert.equal(read.content, '由 Agent 写入');
  await tools.get('office_save_document').execute({ id: read.id, content: '人机协作更新' });
  assert.equal((await tools.get('office_read_document').execute({ id: read.id })).content, '人机协作更新');
  await tools.get('office_delete_document').execute({ id: read.id });
  const res = { writeHead(code) { this.status = code; }, end(text) { this.text = text; } };
  await routes.get('/office-workbench')({ method: 'GET', url: '/office-workbench/api/documents' }, res);
  assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.text), { documents: [] });
  effects[0]();
  assert.equal(tools.size, 0); assert.equal(routes.size, 0);
  console.log('plugin.test: activation, native tool CRUD, HTTP document list, teardown passed');
} finally { await rm(root, { recursive: true, force: true }); }
