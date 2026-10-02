import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_APP = 'ONLYOFFICE';

// macOS 上用 `open -a` 把文件交给本机已安装的办公应用（ONLYOFFICE / Microsoft Word / Pages…）打开。
function launchApp(app, file) {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', app, file], { timeout: 15000 }, (error) => {
      if (error) reject(new Error(`无法拉起 ${app}：${error.message}`));
      else resolve();
    });
  });
}

// 「文档枢纽 + 就地编辑」桥：把工作台文档落到手边目录交给真编辑器，保存后按 mtime 收回并校验。
export function createExternalBridge({ store, directory, app = DEFAULT_APP, launch = launchApp }) {
  const dir = path.resolve(directory);
  const records = new Map();

  async function open(id) {
    const doc = await store.read(id);
    if (!doc.office) throw new Error('仅支持 docx、xlsx、pptx 就地编辑');
    const target = path.join(dir, doc.name);
    const record = records.get(id);
    if (record && record.path === target) {
      const current = await stat(target).catch(() => null);
      // 外部已有未同步的改动时重新打开会覆盖用户成果，必须先同步回来。
      if (current && current.mtimeMs > record.mtimeMs) throw new Error('本地已有未同步的修改，请先「同步外部修改」再重新打开');
    }
    await mkdir(dir, { recursive: true });
    await writeFile(target, await store.bytes(id), { mode: 0o600 });
    const info = await stat(target);
    records.set(id, { path: target, mtimeMs: info.mtimeMs, updatedAt: doc.updatedAt });
    await launch(app, target);
    return { id, name: doc.name, path: target, app };
  }

  async function status(id) {
    const record = records.get(id);
    if (!record) return { opened: false, changed: false, app };
    const info = await stat(record.path).catch(() => null);
    if (!info) return { opened: false, changed: false, app, path: record.path, missing: true };
    return { opened: true, changed: info.mtimeMs > record.mtimeMs, app, path: record.path, size: info.size, savedAt: info.mtime.toISOString(), updatedAt: record.updatedAt };
  }

  async function pull(id) {
    const record = records.get(id);
    if (!record) throw new Error('该文档还没有在本地应用中打开过');
    const info = await stat(record.path).catch(() => null);
    if (!info) throw new Error('本地文件已不存在，请重新打开');
    if (info.mtimeMs <= record.mtimeMs) return { id, changed: false, updatedAt: record.updatedAt };
    const doc = await store.replaceBytes({ id, buffer: await readFile(record.path), expectedUpdatedAt: record.updatedAt });
    records.set(id, { path: record.path, mtimeMs: info.mtimeMs, updatedAt: doc.updatedAt });
    return { id, changed: true, updatedAt: doc.updatedAt, bytes: doc.bytes };
  }

  async function forget(id) {
    const record = records.get(id);
    if (!record) return;
    records.delete(id);
    await rm(record.path, { force: true }).catch(() => {});
  }

  return { dir, app, open, status, pull, forget };
}
