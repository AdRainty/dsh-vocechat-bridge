import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, allowedDestination } from "./config.js";
import { normalizeWebhook } from "./inbound.js";
import { StateStore, batchPhases } from "./state.js";
import { DebounceBuffer } from "./debounce.js";
import { VoceChatClient } from "./vocechat.js";
import { AudioError, probeAudio } from "./audio.js";
import { createAsrProvider, createTtsProvider, speechOptions } from "./speech.js";
const silent = { debug() { }, info() { }, warn() { }, error() { } };
export class Bridge {
    config;
    store;
    client;
    buffer;
    server;
    controller = new AbortController();
    worker;
    debounceTimer;
    sealing;
    running = false;
    log;
    outbound = Promise.resolve();
    cleanupTimer;
    activeTempDirs = new Set();
    failure;
    ports;
    constructor(config, ports) {
        this.ports = ports;
        this.config = parseConfig(config);
        this.store = new StateStore(this.config.statePath, Math.max(this.config.retentionMs, this.config.dedupTtlMs), this.config.maxHistory);
        this.buffer = new DebounceBuffer(this.store, this.config);
        this.log = ports.logger || silent;
        this.client = new VoceChatClient({
            baseUrl: this.config.baseUrl || 'http://127.0.0.1', resolveApiKey: async () => {
                const key = await ports.resolveCredential(this.config.botApiKeyRef);
                if (!key)
                    throw new Error('BOT_CREDENTIAL_MISSING');
                return key;
            }, timeoutMs: this.config.requestTimeoutMs, maxMediaBytes: this.config.maxMediaBytes,
            allowedLocalRoots: this.config.allowedLocalRoots, allowedRemoteOrigins: this.config.allowedRemoteOrigins,
        });
    }
    speechConfig() { return parseConfig({ ...this.config, ...this.ports.speechConfig?.() }); }
    async start() {
        if (this.running || !this.config.enabled)
            return;
        if (!await this.ports.resolveCredential(this.config.webhookSecretRef) || !await this.ports.resolveCredential(this.config.botApiKeyRef))
            throw new Error('BRIDGE_CREDENTIAL_MISSING');
        await this.store.load();
        await this.store.transaction(async () => {
            for (const job of this.store.jobs) {
                job.sourceKey ??= this.sourceKey();
                job.channel ??= 'vocechat';
                job.sessionId ??= this.config.targetSessionId;
            }
            this.buffer.restorePending(job => this.scopeFor(job));
            this.buffer.sealDue(Date.now());
            await this.store.save();
        });
        await mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
        await this.cleanup();
        this.controller = new AbortController();
        const server = createServer((req, res) => {
            void this.handleHttp(req, res).catch(() => {
                if (!res.headersSent)
                    res.writeHead(500);
                res.end();
                this.log.error('WEBHOOK_INTERNAL_ERROR');
            });
        });
        server.requestTimeout = this.config.requestTimeoutMs;
        server.headersTimeout = Math.min(15000, this.config.requestTimeoutMs);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.config.webhookPort, this.config.webhookHost, () => { server.off('error', reject); resolve(); });
        });
        server.on('error', () => { this.failure = 'WEBHOOK_SERVER_ERROR'; this.log.error(this.failure); });
        this.server = server;
        this.running = true;
        this.failure = undefined;
        this.schedule();
        this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => this.log.warn('TEMP_CLEANUP_FAILED')); }, Math.max(1000, Math.min(this.config.retentionMs, 3600_000)));
        this.cleanupTimer.unref();
        this.log.info('VoceChat bridge started');
    }
    async stop() {
        this.running = false;
        this.controller.abort();
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
        if (this.server) {
            const server = this.server;
            this.server = undefined;
            await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        }
        await this.sealing;
        await this.worker;
        await this.outbound.catch(() => { });
        // A disconnected webhook can still be completing its durable ACK write.
        // Drain the store lock before a replacement instance can open this file.
        await this.store.transaction(async () => { });
    }
    status() {
        const voice = this.speechConfig();
        return { enabled: this.config.enabled, running: this.running, address: this.server?.address(), failure: this.failure,
            speech: { enabled: voice.voiceEnabled, asrEnabled: voice.asrEnabled, asrProvider: voice.asrProvider, asrModel: voice.asrModel,
                ttsEnabled: voice.ttsEnabled, ttsProvider: voice.ttsProvider, ttsModel: voice.ttsModel },
            sessionId: this.config.targetSessionId, counts: Object.fromEntries(['pending', 'processing', 'done', 'failed', 'uncertain'].map(s => [s, this.store.jobs.filter(j => j.status === s).length])),
            batchCounts: Object.fromEntries(batchPhases.map(p => [p, this.store.batches.filter(b => b.phase === p).length])),
            blockedBatches: this.store.batches.filter(b => ['buffering', 'ready'].includes(b.phase) && !this.canDispatch(b)).length,
            nextFlushAt: this.buffer.nextDeadline(), debounce: { privateQuietMs: this.config.privateQuietMs, groupQuietMs: this.config.groupQuietMs, maxWaitMs: this.config.maxWaitMs } };
    }
    async handleHttp(req, res) {
        const url = new URL(req.url || '/', 'http://localhost');
        const respond = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
        if (url.pathname !== this.config.webhookPath)
            return respond(404, { error: 'NOT_FOUND' });
        // VoceChat validates the endpoint with GET. This probe exposes no data and
        // must succeed independently of POST credentials or query preservation.
        if (req.method === 'GET')
            return respond(200, { ok: true });
        const secret = await this.ports.resolveCredential(this.config.webhookSecretRef);
        const provided = req.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('secret') || '';
        const a = Buffer.from(secret || ''), b = Buffer.from(provided);
        if (!a.length || a.length !== b.length || !timingSafeEqual(a, b))
            return respond(401, { error: 'UNAUTHORIZED' });
        if (req.method !== 'POST')
            return respond(405, { error: 'METHOD_NOT_ALLOWED' });
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
            return respond(415, { error: 'JSON_REQUIRED' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > this.config.maxBodyBytes)
                return respond(413, { error: 'BODY_TOO_LARGE' });
            chunks.push(chunk);
        }
        let value;
        try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            return respond(400, { error: 'INVALID_JSON' });
        }
        try {
            const result = await this.accept(value);
            return respond(result === 'full' ? 503 : 202, { status: result });
        }
        catch (error) {
            return respond(error.message === 'STATE_WRITE_FAILED' ? 503 : 400, { error: error.message === 'STATE_WRITE_FAILED' ? 'STATE_WRITE_FAILED' : 'INVALID_EVENT' });
        }
    }
    async accept(value) {
        if (!this.running)
            return 'ignored';
        const message = normalizeWebhook(value);
        const c = this.config;
        const rawTarget = value?.target;
        if (rawTarget?.uid && rawTarget.uid !== c.botUid)
            return 'ignored';
        if (!message || message.senderId === c.botUid || !allowedDestination(c, message.destination) || (message.destination.kind === 'group' && c.groupSenderWhitelist.length && !c.groupSenderWhitelist.includes(message.senderId)))
            return 'ignored';
        if (message.text.length > c.maxTextChars || message.attachments.some(a => (a.size ?? 0) > c.maxMediaBytes))
            throw new Error('MESSAGE_TOO_LARGE');
        const receivedAt = Date.now();
        const result = await this.store.transaction(async () => {
            if (!this.running)
                return 'ignored';
            if (this.store.jobs.some(j => j.message.id === message.id && j.sourceKey === this.sourceKey() && (j.status === 'pending' || j.status === 'processing' || (j.finishedAt ?? j.acceptedAt) > Date.now() - c.dedupTtlMs)))
                return 'duplicate';
            if (this.store.jobs.filter(j => j.status === 'pending' || j.status === 'processing').length >= c.maxQueue)
                return 'full';
            const previousJobs = this.store.jobs.slice(), previousBatches = this.store.batches.slice();
            const batchValues = previousBatches.map(b => [b, structuredClone(b)]);
            const job = { id: randomUUID(), message, acceptedAt: receivedAt, status: 'pending', sourceKey: this.sourceKey(), channel: 'vocechat', sessionId: c.targetSessionId };
            try {
                this.store.jobs.push(job);
                this.buffer.enqueue(job, this.scopeFor(job));
                await this.store.save();
            }
            catch {
                this.store.jobs = previousJobs;
                this.store.batches = previousBatches;
                for (const [batch, value] of batchValues) {
                    for (const key of Object.keys(batch))
                        delete batch[key];
                    Object.assign(batch, value);
                }
                throw new Error('STATE_WRITE_FAILED');
            }
            return 'accepted';
        });
        if (result === 'accepted')
            this.schedule();
        return result;
    }
    sourceKey() { return JSON.stringify([this.config.baseUrl, this.config.botUid]); }
    scopeFor(job) {
        return { sourceKey: job.sourceKey ?? this.sourceKey(), channel: job.channel ?? 'vocechat', sessionId: job.sessionId ?? this.config.targetSessionId,
            destination: { ...job.message.destination }, senderId: job.message.senderId };
    }
    canDispatch(batch) {
        const s = batch.scope, c = this.config;
        return s.sourceKey === this.sourceKey() && s.channel === 'vocechat' && s.sessionId === c.targetSessionId && allowedDestination(c, s.destination) &&
            (s.destination.kind !== 'group' || !c.groupSenderWhitelist.length || c.groupSenderWhitelist.includes(s.senderId));
    }
    schedule() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
        if (!this.running || this.failure)
            return;
        this.kick();
        if (this.sealing)
            return;
        const due = this.buffer.nextDeadline();
        if (due === undefined)
            return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.sealing = this.store.transaction(async () => {
                if (!this.running)
                    return;
                if (this.buffer.sealDue(Date.now()).length)
                    await this.store.save();
            }).catch(() => { this.failure = 'BUFFER_WRITE_FAILED'; this.log.error(this.failure); })
                .finally(() => { this.sealing = undefined; this.schedule(); });
        }, Math.max(0, due - Date.now()));
    }
    kick() {
        if (this.worker || !this.running || !this.buffer.nextReady(b => this.canDispatch(b)))
            return;
        this.worker = this.drain().catch(() => { this.failure = 'QUEUE_ERROR'; this.log.error(this.failure); }).finally(() => { this.worker = undefined; this.schedule(); });
    }
    async drain() {
        const signal = this.controller.signal;
        while (this.running && !signal.aborted) {
            const batch = await this.store.transaction(async () => {
                if (!this.running)
                    return undefined;
                const next = this.buffer.nextReady(b => this.canDispatch(b));
                if (!next)
                    return undefined;
                next.phase = 'preparing';
                delete next.code;
                await this.store.save();
                return next;
            });
            if (!batch)
                return;
            const jobs = this.buffer.jobs(batch);
            const dir = join(this.config.tempDir, `job-${randomUUID()}`);
            this.activeTempDirs.add(dir);
            let submitted = false;
            let submission;
            const beforeSubmit = () => submission ??= (async () => {
                await this.store.transaction(async () => {
                    signal.throwIfAborted();
                    batch.phase = 'dispatching';
                    jobs.forEach(j => j.status = 'processing');
                    await this.store.save();
                });
                submitted = true;
            })();
            try {
                await mkdir(dir, { recursive: true, mode: 0o700 });
                const prepared = [];
                for (const job of jobs)
                    prepared.push(await this.prepare(job, dir, signal));
                signal.throwIfAborted();
                if (!this.ports.session.supportsSubmissionBarrier)
                    await beforeSubmit();
                const result = await this.ports.session.run(prepared, signal, { beforeSubmit });
                if (!submitted)
                    throw new Error('SESSION_SUBMISSION_NOT_RECORDED');
                if (this.config.autoReply && !result.sent && !result.quiet && result.text?.trim())
                    await this.send(batch.scope.destination, { text: result.text }, { signal });
                await this.store.transaction(async () => {
                    batch.phase = 'done';
                    delete batch.code;
                    jobs.forEach(j => { j.status = 'done'; j.finishedAt = Date.now(); delete j.code; });
                    await this.store.save();
                });
            }
            catch (cause) {
                const detail = cause instanceof AudioError ? cause.code : cause instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(cause.message) ? cause.message : undefined;
                const interruptedBeforeSubmit = signal.aborted && !submitted;
                await this.store.transaction(async () => {
                    batch.phase = interruptedBeforeSubmit ? 'ready' : submitted ? 'uncertain' : 'failed';
                    batch.code = signal.aborted ? 'STOPPED' : detail || (submitted ? 'TURN_OR_REPLY_FAILED' : 'MEDIA_PROCESSING_FAILED');
                    jobs.forEach(j => { j.status = interruptedBeforeSubmit ? 'pending' : submitted ? 'uncertain' : 'failed'; j.code = batch.code; if (interruptedBeforeSubmit)
                        delete j.finishedAt;
                    else
                        j.finishedAt = Date.now(); });
                    await this.store.save();
                });
                this.log.warn(jobs[0].code);
            }
            finally {
                await rm(dir, { recursive: true, force: true });
                this.activeTempDirs.delete(dir);
            }
        }
    }
    async prepare(job, dir, signal) {
        const message = job.message;
        const attachments = [];
        for (const [index, attachment] of message.attachments.entries()) {
            signal.throwIfAborted();
            const bytes = await this.client.download(attachment.path, attachment.name, signal);
            if (attachment.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(bytes.contentType))
                throw new Error('IMAGE_CONTENT_TYPE_MISMATCH');
            if (attachment.kind === 'audio' && !bytes.contentType.startsWith('audio/'))
                throw new Error('AUDIO_CONTENT_TYPE_MISMATCH');
            const localPath = join(dir, `${randomUUID()}.media`);
            await writeFile(localPath, bytes.bytes, { mode: 0o600 });
            const a = { ...attachment, localPath };
            attachments.push(a);
            if (a.kind === 'audio') {
                await probeAudio({ path: localPath, name: a.name, mime: a.mime }, { maxBytes: this.config.maxMediaBytes, maxDurationSeconds: this.config.maxAudioSeconds, timeoutMs: this.config.requestTimeoutMs, ffmpegPath: this.config.ffmpegPath, ffprobePath: this.config.ffprobePath, tempDir: dir }, signal);
                const cached = job.preparedAudio?.[index], config = this.speechConfig();
                if (cached)
                    Object.assign(a, cached);
                else if (config.voiceEnabled && config.asrEnabled) {
                    let result;
                    try {
                        const provider = createAsrProvider({ ...speechOptions(config, this.ports.resolveCredential, 'asr'), tempDir: dir });
                        const transcript = await provider.transcribe({ path: localPath, name: a.name, mime: a.mime }, signal);
                        result = { transcript: transcript.text };
                    }
                    catch (error) {
                        if (signal.aborted)
                            throw error;
                        const code = error instanceof AudioError ? error.code : 'ASR_FAILED';
                        result = { error: code };
                        this.log.warn(code);
                    }
                    Object.assign(a, result);
                    await this.store.transaction(async () => { job.preparedAudio ??= {}; job.preparedAudio[index] = result; await this.store.save(); });
                }
            }
        }
        return { ...message, attachments };
    }
    send(destination, message, options = {}) {
        const perform = async () => {
            if (!this.running)
                throw new Error('BRIDGE_STOPPED');
            if (!allowedDestination(this.config, destination))
                throw new Error('DESTINATION_DENIED');
            if (options.proactive && !this.config.allowProactive)
                throw new Error('PROACTIVE_DISABLED');
            if (!message.text?.trim() && !message.attachments?.length && !message.speech?.text?.trim())
                throw new Error('EMPTY_MESSAGE');
            if (message.attachments && message.attachments.length > 20)
                throw new Error('TOO_MANY_ATTACHMENTS');
            const signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
            const replyTo = message.replyTo ?? options.replyTo;
            if (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo <= 0))
                throw new Error('INVALID_REPLY_ID');
            const receipts = [];
            try {
                let speech;
                if (message.speech) {
                    const config = this.speechConfig();
                    if (!config.voiceEnabled || !config.ttsEnabled)
                        throw new Error('TTS_DISABLED');
                    if (typeof message.speech.text !== 'string' || !message.speech.text.trim() || Array.from(message.speech.text).length > this.config.maxTextChars)
                        throw new Error('INVALID_SPEECH_TEXT');
                    const dir = join(this.config.tempDir, `job-${randomUUID()}`);
                    this.activeTempDirs.add(dir);
                    try {
                        speech = await createTtsProvider({ ...speechOptions(config, this.ports.resolveCredential, 'tts'), tempDir: dir })
                            .synthesize(message.speech.text, { voice: message.speech.voice, instructions: message.speech.instructions, signal });
                    }
                    finally {
                        await rm(dir, { recursive: true, force: true });
                        this.activeTempDirs.delete(dir);
                    }
                }
                const text = Array.from(message.text || '');
                if (!text.length && !speech && replyTo !== undefined)
                    receipts.push(await this.client.sendText(destination, '附件', { replyTo, signal }));
                for (let i = 0; i < text.length; i += this.config.textSegmentChars) {
                    signal.throwIfAborted();
                    receipts.push(await this.client.sendText(destination, text.slice(i, i + this.config.textSegmentChars).join(''), { replyTo: i === 0 ? replyTo : undefined, format: message.format, signal }));
                }
                if (speech)
                    receipts.push(await this.client.sendAudioBytes(destination, speech.bytes, { name: speech.name, mime: speech.mime }, { replyTo: text.length ? undefined : replyTo, signal }));
                for (const a of message.attachments || []) {
                    signal.throwIfAborted();
                    receipts.push(await this.client.sendAttachment(destination, a, { replyTo: text.length ? undefined : replyTo, signal,
                        validate: a.kind === 'audio' ? async (bytes, name, mime) => {
                            const dir = join(this.config.tempDir, `job-${randomUUID()}`);
                            this.activeTempDirs.add(dir);
                            await mkdir(dir, { recursive: true, mode: 0o700 });
                            try {
                                const file = join(dir, 'outgoing.media');
                                await writeFile(file, bytes, { mode: 0o600 });
                                await probeAudio({ path: file, name, mime }, { maxBytes: this.config.maxMediaBytes, maxDurationSeconds: this.config.maxAudioSeconds, timeoutMs: this.config.requestTimeoutMs, ffmpegPath: this.config.ffmpegPath, ffprobePath: this.config.ffprobePath, tempDir: dir }, signal);
                            }
                            finally {
                                await rm(dir, { recursive: true, force: true });
                                this.activeTempDirs.delete(dir);
                            }
                        } : undefined }));
                }
                return receipts;
            }
            catch (cause) {
                if (!receipts.length)
                    throw cause;
                const error = Object.assign(new Error(receipts.length ? 'PARTIAL_SEND_FAILED' : 'SEND_FAILED'), { sent: receipts.length > 0, receipts });
                throw error;
            }
        };
        const result = this.outbound.then(perform);
        this.outbound = result.catch(() => { });
        return result;
    }
    async cleanup() {
        for (const entry of await readdir(this.config.tempDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^job-[a-f0-9-]{36}$/.test(entry.name))
                continue;
            const p = join(this.config.tempDir, entry.name);
            if (this.activeTempDirs.has(p))
                continue;
            try {
                if (Date.now() - (await stat(p)).mtimeMs > this.config.retentionMs)
                    await rm(p, { recursive: true, force: true });
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
    }
}
