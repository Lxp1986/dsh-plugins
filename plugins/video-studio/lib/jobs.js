/**
 * In-memory job registry for long-running renders, transcriptions and dubs.
 * The Web panel polls it; results stay available until the plugin unloads.
 */
import { newId } from './util.js';

const MAX_JOBS = 40;

export function createJobs() {
  const jobs = new Map();

  function prune() {
    if (jobs.size <= MAX_JOBS) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (jobs.size > MAX_JOBS && finished.length > 0) {
      jobs.delete(finished.shift().id);
    }
  }

  return {
    start(kind, label) {
      const job = {
        id: newId('job'),
        kind,
        label,
        status: 'running',
        progress: 0,
        message: '',
        detail: null,
        result: null,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(job.id, job);
      prune();
      return job;
    },

    update(id, patch) {
      const job = jobs.get(id);
      if (!job) return undefined;
      Object.assign(job, patch, { updatedAt: Date.now() });
      return job;
    },

    progress(id, value, message) {
      const patch = { progress: Math.max(0, Math.min(1, Number(value) || 0)) };
      if (message) patch.message = message;
      return this.update(id, patch);
    },

    finish(id, result, message = '完成') {
      return this.update(id, { status: 'done', progress: 1, result: result ?? null, message });
    },

    fail(id, error) {
      return this.update(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        message: '失败',
      });
    },

    get(id) {
      const job = jobs.get(id);
      return job ? { ...job } : undefined;
    },

    list() {
      return [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((job) => ({ ...job }));
    },

    active() {
      return [...jobs.values()].filter((job) => job.status === 'running').map((job) => ({ ...job }));
    },
  };
}
