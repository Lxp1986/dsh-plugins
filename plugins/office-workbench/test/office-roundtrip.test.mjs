import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../lib/office.py', import.meta.url));
const python = process.env.DSH_OFFICE_PYTHON || path.join(os.homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');

// Fixtures are produced by the very same libraries a user would use (python-docx / openpyxl /
// python-pptx), so this test fails loudly if the OOXML patching drifts from real files.
const buildFixtures = `
import os
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
d = os.environ['FIXTURES']
doc = Document(); doc.add_paragraph('正文第一段')
doc.sections[0].header.paragraphs[0].text = '旧页眉'
doc.sections[0].footer.paragraphs[0].text = '旧页脚'
doc.save(os.path.join(d, 'a.docx'))
wb = Workbook(); ws = wb.active; ws.title = '数据'; ws['A1'] = 1; ws['B1'] = 'x'; wb.save(os.path.join(d, 'a.xlsx'))
pr = Presentation(); s = pr.slides.add_slide(pr.slide_layouts[5])
s.shapes.title.text = '标题'; s.notes_slide.notes_text_frame.text = '旧备注'
pr.save(os.path.join(d, 'a.pptx'))
`;
const verifyFixtures = `
import json, os
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
d = os.environ['FIXTURES']
doc = Document(os.path.join(d, 'a.docx'))
ws = load_workbook(os.path.join(d, 'a.xlsx')).active
sl = Presentation(os.path.join(d, 'a.pptx')).slides[0]
print(json.dumps({
  'header': [p.text for p in doc.sections[0].header.paragraphs],
  'footer': [p.text for p in doc.sections[0].footer.paragraphs],
  'body': [p.text for p in doc.paragraphs],
  'sheet': [ws['A2'].value, ws['B2'].value, ws['C2'].value],
  'notes': sl.notes_slide.notes_text_frame.text,
}, ensure_ascii=False))
`;

const run = (env, code) => execFileSync(python, ['-c', code], { env: { ...process.env, ...env }, encoding: 'utf8' });
const patch = (file, edits) => execFileSync(python, [script], { input: Buffer.from(JSON.stringify(edits === undefined ? { path: file } : { path: file, edits })) });

const root = await mkdtemp(path.join(os.tmpdir(), 'office-roundtrip-'));
try {
  if (!existsSync(python)) { console.log(`office-roundtrip.test: skipped (no python at ${python})`); }
  else {
    const env = { FIXTURES: root };
    run(env, buildFixtures);
    const read = (file) => JSON.parse(patch(file).toString('utf8'));
    const write = async (file, edits) => writeFile(file, patch(file, edits));

    const docx = path.join(root, 'a.docx');
    const word = read(docx);
    assert.deepEqual([...new Set(word.items.map((i) => i.group))].sort(), ['页眉', '页脚', '正文与表格'].sort());
    const keyOf = (meta, needle) => meta.items.find((i) => i.key.includes(needle)).key;
    await write(docx, [
      { key: keyOf(word, 'header'), text: '新页眉' },
      { key: keyOf(word, 'footer'), text: '新页脚' },
      { key: 'word/document.xml#append', text: '追加的段落' },
    ]);
    const xlsx = path.join(root, 'a.xlsx');
    assert.deepEqual(read(xlsx).appendItems.map((a) => a.label), ['新增行（Tab 分隔单元格）']);
    await write(xlsx, [{ key: 'xl/worksheets/sheet1.xml#append', text: '3\ty\t=SUM(A1:A2)' }]);
    const pptx = path.join(root, 'a.pptx');
    await write(pptx, [{ key: keyOf(read(pptx), 'notesSlide'), text: '新备注' }]);

    const done = JSON.parse(run(env, verifyFixtures));
    assert.deepEqual(done.header, ['新页眉']);
    assert.deepEqual(done.footer, ['新页脚']);
    assert.deepEqual(done.body, ['正文第一段', '追加的段落']);
    assert.deepEqual(done.sheet, [3, 'y', '=SUM(A1:A2)']);
    assert.equal(done.notes, '新备注');
    assert.ok((await readFile(docx)).subarray(0, 2).toString('latin1') === 'PK');
    assert.ok(read(docx).items.every((i) => typeof i.text === 'string'));
    console.log('office-roundtrip.test: 页眉/页脚·备注·新增段落·新增行 真实往返通过');
  }
} finally { await rm(root, { recursive: true, force: true }); }
