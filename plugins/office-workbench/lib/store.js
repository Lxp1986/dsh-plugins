import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { officeProcess, OFFICE_EXTENSIONS } from './office.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.html', '.json', ...OFFICE_EXTENSIONS]);
const safeName = (name) => String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').slice(0, 120);

export function createDocumentStore(root) {
  const documentsDir = path.join(path.resolve(root), 'documents');
  const withinRoot = (file) => path.resolve(file).startsWith(`${documentsDir}${path.sep}`);

  async function init() { await mkdir(documentsDir, { recursive: true }); }
  async function resolveContained(file) {
    const resolved = path.resolve(file);
    if (!withinRoot(resolved)) throw new Error('文档路径无效');
    const [actual, canonicalRoot] = await Promise.all([realpath(resolved), realpath(documentsDir)]);
    if (!actual.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('文档路径无效：符号链接越界');
    return actual;
  }
  async function list() {
    await init();
    const entries = await readdir(documentsDir, { withFileTypes: true });
    const docs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const filePath = path.join(documentsDir, entry.name);
      try {
        const actual = await resolveContained(filePath);
        const info = await stat(actual);
        if (!info.isFile()) continue;
        docs.push({ id: entry.name, name: entry.name, path: actual, bytes: info.size, updatedAt: info.mtime.toISOString() });
      } catch { /* concurrent deletion */ }
    }
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function read(id) {
    const file = path.resolve(documentsDir, String(id || ''));
    if (!withinRoot(file) || !TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('文档路径无效');
    const actual = await resolveContained(file);
    const info = await stat(actual);
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error('文档不存在或超过 8 MiB');
    return { id: path.basename(file), name: path.basename(file), path: actual, ...(OFFICE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? { office: await officeProcess(actual) } : { content: await readFile(actual, 'utf8') }), bytes: info.size, updatedAt: info.mtime.toISOString() };
  }
  async function save({ id, name, content }) {
    await init();
    if (typeof content !== 'string') throw new Error('content 必须是文本');
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('文档超过 8 MiB');
    const requested = safeName(name || id || '未命名文档');
    if (!requested) throw new Error('文档名不能为空');
    const ext = path.extname(requested) || '.md';
    if (!TEXT_EXTENSIONS.has(ext.toLowerCase()) || OFFICE_EXTENSIONS.has(ext.toLowerCase())) throw new Error('文本保存仅支持 Markdown、TXT、CSV、HTML、JSON；Office 文件请使用结构化编辑接口');
    const filename = `${path.basename(requested, ext)}${ext}`;
    const file = path.resolve(documentsDir, filename);
    if (!withinRoot(file)) throw new Error('文档路径无效');
    try { await resolveContained(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(documentsDir, `.${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    return read(filename);
  }
  async function remove(id) {
    const file = path.resolve(documentsDir, String(id || ''));
    if (!withinRoot(file) || !TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('文档路径无效');
    const actual = await resolveContained(file);
    await rm(actual);
    return { deleted: path.basename(file) };
  }
  async function importOffice({ name, base64 }) {
    await init();
    const filename = safeName(name);
    if (!OFFICE_EXTENSIONS.has(path.extname(filename).toLowerCase())) throw new Error('仅支持 docx、xlsx、pptx');
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('无效文件编码');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文档超过 8 MiB');
    const temp = path.join(documentsDir, `.${randomUUID()}${path.extname(filename)}`);
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await officeProcess(temp);
      const target = path.resolve(documentsDir, filename);
      try { await resolveContained(target); throw new Error('文档已存在，请改名后导入'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temp, target);
      return await read(filename);
    } finally { await rm(temp, { force: true }); }
  }
  async function saveOffice({ id, edits, expectedUpdatedAt }) {
    if (!OFFICE_EXTENSIONS.has(path.extname(String(id)).toLowerCase())) throw new Error('仅支持 Office 结构化编辑');
    if (!Array.isArray(edits) || edits.length > 50000 || edits.some(x => typeof x.key !== 'string' || typeof x.text !== 'string')) throw new Error('无效 Office 编辑内容');
    const doc = await read(id);
    if (!expectedUpdatedAt || doc.updatedAt !== expectedUpdatedAt) throw new Error('文档已变更，请重新打开后编辑');
    const bytes = await officeProcess(doc.path, edits);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文档超过 8 MiB');
    const info = await stat(doc.path);
    if (info.mtime.toISOString() !== expectedUpdatedAt) throw new Error('文档已变更，请重新打开后编辑');
    const temp = path.join(documentsDir, `.${randomUUID()}.tmp`);
    try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, doc.path); }
    finally { await rm(temp, { force: true }); }
    return read(id);
  }
  return { root: documentsDir, init, list, read, save, remove, importOffice, saveOffice };
}
