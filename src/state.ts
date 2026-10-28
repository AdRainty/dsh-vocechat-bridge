import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from './types.ts';

export type Job = { message: IncomingMessage; acceptedAt: number; status: 'pending'|'processing'|'done'|'failed'|'uncertain'; code?: string };
export class StateStore {
  jobs: Job[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  readonly path: string;
  readonly retentionMs: number;
  readonly maxHistory: number;
  constructor(path: string, retentionMs: number, maxHistory=5000) { this.path=path;this.retentionMs=retentionMs;this.maxHistory=maxHistory; }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.jobs)) throw new Error('INVALID_STATE');
      for (const job of value.jobs) {
        if (!job.message || typeof job.message.id !== 'string' || !['pending','processing','done','failed','uncertain'].includes(job.status)) throw new Error('INVALID_STATE');
        if (job.status === 'processing') { job.status = 'uncertain'; job.code = 'RESTART_DURING_TURN'; }
      }
      this.jobs = value.jobs;
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('STATE_LOAD_FAILED'); }
    await this.save();
  }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => {});
    return next;
  }
  async save() {
    const cutoff = Date.now() - this.retentionMs;
    const finished=this.jobs.filter(j=>j.status!=='pending' && j.status!=='processing' && j.acceptedAt>cutoff).slice(-this.maxHistory);
    const retained=new Set(finished);
    this.jobs = this.jobs.filter(j => j.status === 'pending' || j.status === 'processing' || retained.has(j));
    await mkdir(dirname(this.path), {recursive:true,mode:0o700});
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({version:1,jobs:this.jobs}), {mode:0o600});
    await rename(tmp, this.path);
  }
}
