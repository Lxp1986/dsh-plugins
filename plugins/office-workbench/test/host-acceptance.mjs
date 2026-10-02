// 宿主级验收：对**正在运行的** DSH Host 跑完整 Office 工作台链路（导入 → 结构化编辑 → 保存 → 导出 → 独立解析）。
// 宿主插件改动必须先重启 DSH 才能生效；重启后运行 `node test/host-acceptance.mjs`。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.OW_BASE || 'http://127.0.0.1:19387/office-workbench';
const python = process.env.DSH_OFFICE_PYTHON || path.join(os.homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
const prefix = '验收'; // 会先清掉工作台里遗留的同名前缀文档，保证脚本可重复运行
const build = `
import os
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
d = os.environ['FIXTURES']
doc = Document(); doc.add_paragraph('宿主验收正文')
doc.sections[0].header.paragraphs[0].text = '旧页眉'
doc.save(os.path.join(d, '验收.docx'))
wb = Workbook(); ws = wb.active; ws.title = '数据'; ws['A1'] = 1; wb.save(os.path.join(d, '验收.xlsx'))
pr = Presentation(); s = pr.slides.add_slide(pr.slide_layouts[5]); s.shapes.title.text = '标题'
s.notes_slide.notes_text_frame.text = '旧备注'; pr.save(os.path.join(d, '验收.pptx'))
`;
const verify = `
import json, os, sys
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
d = sys.argv[1]
doc = Document(os.path.join(d, '验收.docx'))
print(json.dumps({
  'header': [p.text for p in doc.sections[0].header.paragraphs],
  'body': [p.text for p in doc.paragraphs],
  'sheetA2': load_workbook(os.path.join(d, '验收.xlsx')).active['A2'].value,
  'notes': Presentation(os.path.join(d, '验收.pptx')).slides[0].notes_slide.notes_text_frame.text,
}, ensure_ascii=False))
`;
const api = async (route, init) => {
  const res = await fetch(`${BASE}${route}`, init);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, payload };
};
const post = (route, body) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const root = await mkdtemp(path.join(os.tmpdir(), 'ow-host-'));
const made = [];
try {
  const listed = await api('/api/documents');
  assert.equal(listed.status, 200, `GET /api/documents → ${listed.status} ${JSON.stringify(listed.payload)}`);

  // 上次异常中断可能留下同名文档，先清干净（导入接口遇到重名会 500）。
  const existing = Array.isArray(listed.payload) ? listed.payload : listed.payload?.documents || [];
  for (const doc of existing) {
    if (String(doc.name ?? '').startsWith(prefix)) {
      await api(`/api/document?id=${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    }
  }

  execFileSync(python, ['-c', build], { env: { ...process.env, FIXTURES: root } });
  const imports = {};
  for (const name of ['验收.docx', '验收.xlsx', '验收.pptx']) {
    const res = await post('/api/import-office', { name, base64: (await readFile(path.join(root, name))).toString('base64') });
    assert.equal(res.status, 200, `import-office(${name}) → ${res.status} ${JSON.stringify(res.payload)}`);
    // 先登记再断言：断言失败时 finally 仍能删掉刚导入的文档。
    made.push(res.payload.id);
    imports[name] = res.payload;
    // PPTX 故意不提供 appendItems（幻灯片追加段落的目标不明确），只有 DOCX/XLSX 有追加项。
    if (name.endsWith('.pptx')) assert.equal(res.payload.office?.kind, 'presentation');
    else assert.ok(res.payload.office?.appendItems?.length, `${name} 缺少 appendItems（宿主仍在跑旧宿主插件代码）`);
  }

  const docx = imports['验收.docx'];
  const headerKey = docx.office.items.find((i) => i.key.includes('header')).key;
  const saves = [
    ['验收.docx', [{ key: headerKey, text: '新页眉' }, { key: 'word/document.xml#append', text: '宿主追加段落' }]],
    ['验收.xlsx', [{ key: 'xl/worksheets/sheet1.xml#append', text: '42' }]],
    ['验收.pptx', [{ key: imports['验收.pptx'].office.items.find((i) => i.key.includes('notesSlide')).key, text: '新备注' }]],
  ];
  for (const [name, edits] of saves) {
    const { id, updatedAt } = imports[name];
    const res = await post('/api/save-office', { id, expectedUpdatedAt: updatedAt, edits });
    assert.equal(res.status, 200, `save-office(${name}) → ${res.status} ${JSON.stringify(res.payload)}`);
  }

  for (const name of Object.keys(imports)) {
    const res = await api(`/api/export?id=${encodeURIComponent(imports[name].id)}`);
    assert.equal(res.status, 200, `export(${name}) → ${res.status}`);
    assert.equal(res.payload.subarray(0, 2).toString('latin1'), 'PK', `${name} 导出不是有效 OOXML 包`);
    await writeFile(path.join(root, name), res.payload);
  }

  const done = JSON.parse(execFileSync(python, ['-c', verify, root], { encoding: 'utf8' }));
  assert.deepEqual(done.header, ['新页眉']);
  assert.deepEqual(done.body, ['宿主验收正文', '宿主追加段落']);
  assert.equal(done.sheetA2, 42);
  assert.equal(done.notes, '新备注');
  console.log('host-acceptance: 运行中的宿主完成 导入 → 页眉/备注编辑 + 新增段落/新增行 → 导出 → 独立解析，全部通过');
} finally {
  for (const id of made) await api(`/api/document?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
