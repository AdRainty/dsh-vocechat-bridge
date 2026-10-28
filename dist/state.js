import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class StateStore {
    jobs = [];
    lock = Promise.resolve();
    path;
    retentionMs;
    maxHistory;
    constructor(path, retentionMs, maxHistory = 5000) { this.path = path; this.retentionMs = retentionMs; this.maxHistory = maxHistory; }
    async load() {
        try {
            const value = JSON.parse(await readFile(this.path, 'utf8'));
            if (value.version !== 1 || !Array.isArray(value.jobs))
                throw new Error('INVALID_STATE');
            for (const job of value.jobs) {
                if (!job.message || typeof job.message.id !== 'string' || !['pending', 'processing', 'done', 'failed', 'uncertain'].includes(job.status))
                    throw new Error('INVALID_STATE');
                if (job.status === 'processing') {
                    job.status = 'uncertain';
                    job.code = 'RESTART_DURING_TURN';
                }
            }
            this.jobs = value.jobs;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('STATE_LOAD_FAILED');
        }
        await this.save();
    }
    transaction(fn) {
        const next = this.lock.then(fn);
        this.lock = next.catch(() => { });
        return next;
    }
    async save() {
        const cutoff = Date.now() - this.retentionMs;
        const finished = this.jobs.filter(j => j.status !== 'pending' && j.status !== 'processing' && j.acceptedAt > cutoff).slice(-this.maxHistory);
        const retained = new Set(finished);
        this.jobs = this.jobs.filter(j => j.status === 'pending' || j.status === 'processing' || retained.has(j));
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 1, jobs: this.jobs }), { mode: 0o600 });
        await rename(tmp, this.path);
    }
}
