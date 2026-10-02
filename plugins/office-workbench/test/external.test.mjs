// 就地编辑桥验收：工作台 → 交给本地应用 → 应用保存 → 收回工作台。
// 不真的拉起 GUI：launch 注入成记录器；「用户保存」用 python-docx 原地改写来模拟。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStore } from '../lib/store.js';
import { createExternalBridge } from '../lib/external.js';

const python = process.env.DSH_OFFICE_PYTHON || path.join(os.homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
const root = await mkdtemp(path.join(os.tmpdir(), 'office-external-'));
const fixture = path.join(root, 'fixture');
const externalDir = path.join(root, 'external');
const store = createDocumentStore(path.join(root, 'data'));
const ID = '就地编辑.docx';
const py = (code, env) => execFileSync(python, ['-c', code], { env: { ...process.env, ...env } });
const overwrite = (paragraph) => py(`
from docx import Document
import os
p = os.path.join(os.environ['EXT'], os.environ['NAME'])
doc = Document(p); doc.add_paragraph(os.environ['TEXT']); doc.save(p)
`, { EXT: externalDir, NAME: ID, TEXT: paragraph });

try {
  await mkdir(fixture, { recursive: true });
  await store.init();
  py(`
from docx import Document
import os
doc = Document(); doc.add_paragraph('原始正文'); doc.save(os.path.join(os.environ['FIX'], os.environ['NAME']))
`, { FIX: fixture, NAME: ID });
  const imported = await store.importOffice({ name: ID, base64: (await readFile(path.join(fixture, ID))).toString('base64') });

  const launched = [];
  const bridge = createExternalBridge({ store, directory: externalDir, app: 'ONLYOFFICE', launch: async (app, file) => { launched.push({ app, file }); } });

  // 1. 交接：文件落到手边目录，应用被拉起，内容与工作台一致
  const opened = await bridge.open(ID);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].app, 'ONLYOFFICE');
  assert.equal(opened.path, path.join(externalDir, ID));
  const initial = await bridge.status(ID);
  assert.equal(initial.opened, true);
  assert.equal(initial.changed, false);
  assert.equal(initial.app, 'ONLYOFFICE');
  assert.equal(initial.updatedAt, imported.updatedAt);
  assert.equal(initial.size, (await readFile(opened.path)).length);
  assert.equal((await bridge.pull(ID)).changed, false, '未保存时不应判定为有改动');

  // 2. 用户在编辑器里改完保存 → 状态变为待同步
  await overwrite('在 ONLYOFFICE 里新增的一段');
  assert.equal((await bridge.status(ID)).changed, true);

  // 3. 收回：工作台内容与 updatedAt 都变，且 diff 只多这一段
  const pulled = await bridge.pull(ID);
  assert.equal(pulled.changed, true);
  const doc = await store.read(ID);
  assert.deepEqual(doc.office.items.map((i) => i.text), ['原始正文', '在 ONLYOFFICE 里新增的一段']);
  assert.equal(doc.updatedAt, pulled.updatedAt);
  assert.notEqual(doc.updatedAt, imported.updatedAt);
  assert.equal((await bridge.pull(ID)).changed, false, '同步后不应重复计入');

  // 4. 保护：外部已有未同步改动时，重新打开不得覆盖用户成果
  await overwrite('还没同步的改动');
  await assert.rejects(() => bridge.open(ID), /未同步/);

  // 5. 收回后可以再次交接
  assert.equal((await bridge.pull(ID)).changed, true);
  assert.equal((await bridge.open(ID)).app, 'ONLYOFFICE');

  console.log('external.test: 交接 → 外部保存 → 自动/手动收回 → 未同步保护 全部通过');
} finally {
  await rm(root, { recursive: true, force: true });
}
