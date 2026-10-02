import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';

const script = fileURLToPath(new URL('./office.py', import.meta.url));
export function officeProcess(file, edits) {
  const python = process.env.DSH_OFFICE_PYTHON || path.join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; const errors = []; let bytes = 0; let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); reject(new Error('Office 处理超时')); }, 30000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 32 * 1024 * 1024) { stopped = true; child.kill(); reject(new Error('Office 输出超过限制')); } else chunks.push(data); });
    child.stderr.on('data', data => { if (errors.length < 50) errors.push(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); if (stopped) return;
      if (code !== 0) return reject(new Error(`Office 处理失败：${Buffer.concat(errors).toString().slice(-1500)}`));
      const output = Buffer.concat(chunks);
      try { resolve(edits === undefined ? JSON.parse(output.toString('utf8')) : output); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ path: file, ...(edits === undefined ? {} : { edits }) }));
  });
}
export const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
