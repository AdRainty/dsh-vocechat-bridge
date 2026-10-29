import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export const batchPhases = ['buffering', 'ready', 'preparing', 'dispatching', 'done', 'failed', 'uncertain'];
export class StateStore {
    jobs = [];
    batches = [];
    lock = Promise.resolve();
    path;
    retentionMs;
    maxHistory;
    constructor(path, retentionMs, maxHistory = 5000) { this.path = path; this.retentionMs = retentionMs; this.maxHistory = maxHistory; }
    async load() {
        try {
            const value = JSON.parse(await readFile(this.path, 'utf8'));
            if (![1, 2].includes(value.version) || !Array.isArray(value.jobs) || (value.version === 2 && !Array.isArray(value.batches)))
                throw new Error('INVALID_STATE');
            const ids = new Set();
            for (const job of value.jobs) {
                if (!job.message || typeof job.message.id !== 'string' || !Number.isFinite(job.acceptedAt) || !['pending', 'processing', 'done', 'failed', 'uncertain'].includes(job.status))
                    throw new Error('INVALID_STATE');
                job.id ||= randomUUID();
                if (typeof job.id !== 'string' || ids.has(job.id))
                    throw new Error('INVALID_STATE');
                ids.add(job.id);
            }
            const batches = value.version === 2 ? value.batches : [];
            const batchIds = new Set();
            for (const batch of batches) {
                const s = batch.scope;
                if (typeof batch.id !== 'string' || batchIds.has(batch.id) || typeof batch.key !== 'string' || !batchPhases.includes(batch.phase) ||
                    !s || typeof s.sourceKey !== 'string' || typeof s.channel !== 'string' || typeof s.sessionId !== 'string' ||
                    !s.destination || !['user', 'group'].includes(s.destination.kind) || !Number.isSafeInteger(s.destination.id) || !Number.isSafeInteger(s.senderId) ||
                    !Array.isArray(batch.jobIds) || !batch.jobIds.length || new Set(batch.jobIds).size !== batch.jobIds.length || batch.jobIds.some(id => !ids.has(id)) ||
                    ![batch.firstAcceptedAt, batch.lastAcceptedAt, batch.dueAt, batch.quietMs, batch.maxWaitMs].every(Number.isFinite) || batch.quietMs < 0 || batch.maxWaitMs <= 0)
                    throw new Error('INVALID_STATE');
                batchIds.add(batch.id);
                const jobs = value.jobs.filter((j) => batch.jobIds.includes(j.id));
                if (jobs.some((j) => j.batchId !== batch.id))
                    throw new Error('INVALID_STATE');
                if (batch.phase === 'preparing') {
                    batch.phase = 'ready';
                    delete batch.code;
                    jobs.forEach((j) => { j.status = 'pending'; delete j.code; delete j.finishedAt; });
                }
                else if (batch.phase === 'dispatching') {
                    batch.phase = 'uncertain';
                    batch.code = 'RESTART_DURING_TURN';
                    jobs.forEach((j) => { j.status = 'uncertain'; j.code = 'RESTART_DURING_TURN'; j.finishedAt = Date.now(); });
                }
            }
            for (const job of value.jobs) {
                if (job.batchId && !batchIds.has(job.batchId))
                    throw new Error('INVALID_STATE');
                if (job.status === 'processing') {
                    job.status = 'uncertain';
                    job.code = 'RESTART_DURING_TURN';
                    job.finishedAt = Date.now();
                }
            }
            this.jobs = value.jobs;
            this.batches = batches;
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
        const finished = this.jobs.filter(j => j.status !== 'pending' && j.status !== 'processing' && (j.finishedAt ?? j.acceptedAt) > cutoff).slice(-this.maxHistory);
        const retained = new Set(finished);
        const jobs = this.jobs.filter(j => j.status === 'pending' || j.status === 'processing' || retained.has(j));
        const ids = new Set(jobs.map(j => j.id));
        const batches = this.batches.map(b => {
            const jobIds = b.jobIds.filter(id => ids.has(id));
            return jobIds.length === b.jobIds.length ? b : { ...b, jobIds };
        }).filter(b => b.jobIds.length);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 2, jobs, batches }), { mode: 0o600 });
        await rename(tmp, this.path);
        this.jobs = jobs;
        this.batches = batches;
    }
}
