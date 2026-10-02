/**
 * Small dependency-free helpers shared by the Video Studio host modules.
 * Only Node builtins are used so the bundle installs without a package step.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Generate a short, collision-resistant id usable in file names. */
export function newId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Stable short hash for cache keys. */
export function shortHash(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
}

/** Ensure a directory exists and return it. */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Read JSON, returning the fallback for a missing or unparsable file. */
export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomically write UTF-8 JSON (tmp file + rename). */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Atomically write a text file. */
export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/** File size in bytes, or 0 when it does not exist. */
export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Default DSH home directory, mirroring the launcher's own resolution order. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** Resolve a PATH-provided executable the way a shell would, without spawning. */
export function whichSync(bin) {
  if (!bin) return undefined;
  if (bin.includes(path.sep)) return existsSync(bin) ? bin : undefined;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Run one child process and capture bounded output.
 * @param {string} command - executable path or name.
 * @param {string[]} args - argv tail.
 * @param {{ cwd?: string, env?: Record<string,string>, signal?: AbortSignal, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void, maxOutputBytes?: number, input?: string }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }>}
 */
export function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    signal,
    onStdout,
    onStderr,
    maxOutputBytes = 4 * 1024 * 1024,
    input,
  } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGKILL');
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxOutputBytes) {
        stdout += chunk;
        stdoutBytes += chunk.length;
      }
      onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxOutputBytes) {
        stderr += chunk;
        stderrBytes += chunk.length;
      }
      onStderr?.(chunk);
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        return;
      }
      resolve({ code, signal: exitSignal, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/** Human-readable seconds: "1:02.500". */
export function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Round to milliseconds, keeping JSON small. */
export function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

export { path };
