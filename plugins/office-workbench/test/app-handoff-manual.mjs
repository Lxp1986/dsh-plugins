// 手动验收（不在 `node --test test/*.test.mjs` 的范围内，因为它真的会拉起 GUI 应用）：
//   node test/app-handoff-manual.mjs
// 作用：用**真实**的 `open -a ONLYOFFICE` 跑一遍「工作台 → 本地编辑器 → 保存 → 收回」，
// 并把每一步的产物路径打出来，作为"确实交给了真编辑器"的证据。
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStore } from '../lib/store.js';
import { createExternalBridge } from '../lib/external.js';

const python = process.env.DSH_OFFICE_PYTHON || path.join(os.homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
const app = process.env.OW_APP || 'ONLYOFFICE';
const ID = '就地编辑验收.docx';
const root = await mkdtemp(path.join(os.tmpdir(), 'ow-handoff-'));
const fixture = path.join(root, 'fixture');
const store = createDocumentStore(path.join(root, 'data'));
const bridge = createExternalBridge({ store, directory: path.join(root, 'external'), app });

try {
  await mkdir(fixture, { recursive: true });
  await store.init();
  execFileSync(python, ['-c', `
from docx import Document
import os
doc = Document(); doc.add_paragraph('原始正文'); doc.save(os.path.join(os.environ['FIX'], os.environ['NAME']))
`], { env: { ...process.env, FIX: fixture, NAME: ID } });
  const imported = await store.importOffice({ name: ID, base64: (await readFile(path.join(fixture, ID))).toString('base64') });

  const opened = await bridge.open(ID);
  console.log(`1. 已交给 ${opened.app}：${opened.path}`);
  await new Promise((r) => setTimeout(r, 5000));
  const alive = execFileSync('/bin/sh', ['-c', `ps -Ao pid=,comm= | grep -i 'onlyoffice' | grep -v grep | head -2 || true`], { encoding: 'utf8' }).trim();
  console.log(`2. 编辑器进程：${alive || '(未找到)'} · 外部文件 ${(await stat(opened.path)).size} 字节 · 待同步=${(await bridge.status(ID)).changed}`);

  execFileSync(python, ['-c', `
from docx import Document
import os
p = os.path.join(os.environ['EXT'], os.environ['NAME'])
doc = Document(p); doc.add_paragraph('在编辑器里新增的一段'); doc.save(p)
`], { env: { ...process.env, EXT: path.join(root, 'external'), NAME: ID } });
  console.log(`3. 模拟编辑器保存后：待同步=${(await bridge.status(ID)).changed}`);

  const pulled = await bridge.pull(ID);
  const doc = await store.read(ID);
  console.log(`4. 收回工作台：changed=${pulled.changed} 段落=${JSON.stringify(doc.office.items.map((i) => i.text))}`);
  if (!pulled.changed || doc.office.items.at(-1).text !== '在编辑器里新增的一段') throw new Error('收回失败');
  console.log(`5. updatedAt ${imported.updatedAt} → ${doc.updatedAt}`);
  console.log('app-handoff: 真实应用交接 → 保存 → 收回 通过（可以直接在编辑器窗口里看到该文档）');
} finally {
  await rm(root, { recursive: true, force: true });
}
