import { createHash } from 'node:crypto';
import { parseConfig, speechFields } from "./config.js";
const signature = (config) => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'enabled' && !speechFields.includes(key))))).digest('hex');
/** Credential providers and an old listener can become ready after the plugin mounts. */
export class AutoStartController {
    timer;
    pending;
    disposed = false;
    lastError;
    delay;
    options;
    constructor(options) { this.options = options; this.delay = options.retryMs ?? 250; }
    wake() {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.disposed)
            return Promise.resolve();
        if (this.pending)
            return this.pending;
        this.pending = this.attempt().finally(() => { this.pending = undefined; });
        return this.pending;
    }
    async attempt() {
        try {
            await this.options.ready;
        }
        catch {
            this.report('SETTINGS_LOAD_FAILED');
            return;
        }
        if (this.disposed || !this.shouldStart())
            return;
        try {
            await this.options.runtime.start();
            this.lastError = undefined;
            this.delay = this.options.retryMs ?? 250;
        }
        catch (error) {
            this.report(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'BRIDGE_START_FAILED');
            if (this.disposed || !this.shouldStart())
                return;
            this.timer = setTimeout(() => { this.timer = undefined; void this.wake(); }, this.delay);
            this.timer.unref();
            this.delay = Math.min(this.delay * 2, this.options.maxRetryMs ?? 5000);
        }
    }
    shouldStart() { try {
        return this.options.enabled() && !this.options.runtime.status().running;
    }
    catch {
        this.report('INVALID_SETTINGS');
        return false;
    } }
    report(code) { if (!this.disposed && code !== this.lastError) {
        this.lastError = code;
        this.options.onError(code);
    } }
    async dispose() { this.disposed = true; clearTimeout(this.timer); this.timer = undefined; await this.pending; }
}
/** The host UI/API stays mounted while the listener is stopped or recreated. */
export class BridgeRuntime {
    active;
    tail = Promise.resolve();
    phase = 'stopped';
    error;
    disposed = false;
    read;
    factory;
    constructor(read, factory) { this.read = read; this.factory = factory; }
    enqueue(action) { const work = this.tail.then(action); this.tail = work.catch(() => { }); return work; }
    async close() {
        const active = this.active;
        this.phase = 'stopping';
        try {
            await active?.bridge.stop();
        }
        finally {
            active?.session.dispose();
            this.active = undefined;
            this.phase = 'stopped';
            this.error = undefined;
        }
    }
    async open() {
        this.phase = 'starting';
        this.error = undefined;
        let active;
        try {
            active = this.factory(parseConfig({ ...this.read(), enabled: true }));
            await active.bridge.start();
            if (this.disposed)
                throw new Error('BRIDGE_STOPPED');
            this.active = active;
            this.phase = 'running';
        }
        catch (error) {
            await active?.bridge.stop();
            active?.session.dispose();
            this.active = undefined;
            this.phase = 'stopped';
            this.error = error?.code === 'EADDRINUSE' ? 'WEBHOOK_PORT_IN_USE' :
                ['BRIDGE_CREDENTIAL_MISSING', 'WEBHOOK_CREDENTIAL_MISSING'].includes(error?.message) ? error.message : 'BRIDGE_START_FAILED';
            throw new Error(this.error);
        }
    }
    start() { return this.enqueue(async () => { if (this.disposed)
        throw new Error('BRIDGE_STOPPED'); if (!this.active)
        await this.open(); }); }
    stop() { return this.enqueue(() => this.close()); }
    reload() { return this.enqueue(async () => { if (this.disposed)
        throw new Error('BRIDGE_STOPPED'); await this.close(); await this.open(); }); }
    dispose() { this.disposed = true; return this.stop(); }
    status() {
        const config = this.read(), current = this.active?.bridge.status();
        return { ...current, enabled: config.enabled, running: !!current?.running, phase: this.phase, error: this.error,
            sessionId: config.targetSessionId, needsReload: !!this.active && signature(this.active.bridge.config) !== signature(config),
            webhook: { host: config.webhookHost, port: config.webhookPort, path: config.webhookPath } };
    }
    send(destination, message, options = {}) {
        if (!this.active)
            return Promise.reject(new Error('BRIDGE_STOPPED'));
        return this.active.bridge.send(destination, message, options);
    }
    session = {
        outboundMode: (agent, destination) => {
            if (!this.active)
                throw new Error('BRIDGE_STOPPED');
            return this.active.session.outboundMode(agent, destination);
        },
        noteSent: (agent, destination) => this.active?.session.noteSent(agent, destination),
        quiet: (agent) => { if (!this.active)
            throw new Error('BRIDGE_STOPPED'); this.active.session.quiet(agent); },
    };
}
