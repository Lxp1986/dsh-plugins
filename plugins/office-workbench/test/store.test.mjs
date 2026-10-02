import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStore } from '../lib/store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'office-workbench-'));
try {
  const store = createDocumentStore(root);
  assert.deepEqual(await store.list(), []);
  const created = await store.save({ name: '项目计划.md', content: '# 计划\n' });
  assert.equal(created.content, '# 计划\n');
  assert.equal((await store.list()).length, 1);
  const updated = await store.save({ id: created.id, name: created.name, content: '# 更新\n' });
  assert.equal(updated.content, '# 更新\n');
  await assert.rejects(() => store.read('../escape.md'), /路径无效/);
  const outside = path.join(root, 'outside.md');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(store.root, 'linked.md'));
  await assert.rejects(() => store.read('linked.md'), /符号链接越界/);
  assert.ok(!(await store.list()).some((doc) => doc.id === 'linked.md'));
  await assert.rejects(() => store.save({ name: 'linked.md', content: 'overwrite' }), /符号链接越界/);
  await assert.rejects(() => store.save({ name: 'notes.docx', content: 'x' }), /仅支持/);
  await assert.rejects(() => store.save({ name: 'huge.txt', content: 'x'.repeat(8 * 1024 * 1024 + 1) }), /超过 8 MiB/);
  assert.deepEqual(await store.remove(created.id), { deleted: created.id });
  assert.deepEqual(await store.list(), []);
  console.log('store.test: create/list/read/update/delete, path containment, type and size limits passed');
} finally { await rm(root, { recursive: true, force: true }); }
