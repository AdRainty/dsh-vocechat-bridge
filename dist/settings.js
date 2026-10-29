import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaults, parseConfig, speechFields } from "./config.js";
export const settingsPath = '/api/vocechat-bridge/settings';
export const connectionFields = ['enabled', 'baseUrl', 'botUid', 'botApiKeyRef', 'webhookSecretRef', 'webhookHost', 'webhookPort', 'webhookPath',
    'userWhitelist', 'groupWhitelist', 'groupSenderWhitelist', 'targetSessionId', 'agentPreset', 'autoReply', 'allowProactive',
    'privateQuietMs', 'groupQuietMs', 'maxWaitMs', 'maxBatch', 'allowedLocalRoots', 'allowedRemoteOrigins'];
export const editableFields = [...connectionFields, ...speechFields, 'ffmpegPath', 'ffprobePath', 'maxAudioSeconds', 'maxMediaBytes'];
const known = new Set(editableFields);
const plainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => { throw new Error(code); };
/** Plugin-owned overrides avoid the root-Include write failure of some desktop profiles. */
export class PluginSettings {
    overrides = {};
    filename;
    base;
    constructor(filename, base) { this.filename = filename; this.base = base; }
    async load() {
        let raw;
        try {
            raw = JSON.parse(await readFile(this.filename, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            fail('SETTINGS_LOAD_FAILED');
        }
        if (!plainObject(raw) || raw.version !== 1 || !plainObject(raw.values) || Object.keys(raw.values).some(key => !known.has(key)))
            fail('SETTINGS_LOAD_FAILED');
        parseConfig({ ...this.base(), ...raw.values });
        this.overrides = raw.values;
    }
    raw() { return { ...defaults, ...this.base(), ...this.overrides }; }
    config() { return parseConfig(this.raw()); }
    values() { const value = this.raw(); return Object.fromEntries(editableFields.map(key => [key, value[key]])); }
    revision() { return createHash('sha256').update(JSON.stringify(this.values())).digest('hex'); }
    validate(patch) {
        if (!plainObject(patch) || Object.keys(patch).some(key => !known.has(key)))
            fail('INVALID_SETTINGS');
        try {
            parseConfig({ ...this.raw(), ...patch });
        }
        catch {
            fail('INVALID_SETTINGS');
        }
        return patch;
    }
    async update(patch) {
        this.validate(patch);
        const values = { ...this.overrides, ...patch };
        await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
        const temporary = this.filename + '.' + randomUUID() + '.tmp';
        try {
            await writeFile(temporary, JSON.stringify({ version: 1, values }) + '\n', { mode: 0o600 });
            await rename(temporary, this.filename);
        }
        finally {
            await rm(temporary, { force: true });
        }
        this.overrides = values;
    }
}
function keyRef(config, mode) {
    if (mode === 'bot')
        return config.botApiKeyRef;
    if (mode === 'webhook')
        return config.webhookSecretRef;
    return config[`${mode}ApiKeyRef`] || (config[`${mode}Provider`] === 'mimo' ? 'MIMO_API_KEY'
        : config[`${mode}BaseUrl`] ? '' : 'OPENAI_API_KEY');
}
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
}
function localRequest(req) {
    const peer = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer))
        return false;
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
        try {
            const url = new URL(origin);
            if (!['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== req.headers.host?.toLowerCase())
                return false;
        }
        catch {
            return false;
        }
    }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
        return false;
    return req.method !== 'POST' || /^application\/json(?:;|$)/i.test(req.headers['content-type'] || '');
}
export function createSettingsHandler(options) {
    let tail = Promise.resolve();
    const snapshot = async () => {
        const config = options.settings.config(), service = options.credentials();
        const credentials = {};
        for (const mode of ['asr', 'tts', 'bot', 'webhook']) {
            const ref = keyRef(config, mode);
            if (!ref || credentials[ref])
                continue;
            let configured = false;
            try {
                configured = service?.describe ? !!(await service.describe(ref))?.configured : !!await options.resolveCredential(ref);
            }
            catch { }
            credentials[ref] = { configured, writable: typeof service?.set === 'function' };
        }
        return { ok: true, value: options.settings.values(), revision: options.settings.revision(), writable: true, credentials, runtime: options.runtime.status() };
    };
    return async (req, res) => {
        if (!localRequest(req)) {
            json(res, 403, { ok: false, error: 'LOCAL_REQUEST_REQUIRED' });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
            return;
        }
        try {
            await options.ready;
            if (req.method === 'GET') {
                json(res, 200, await snapshot());
                return;
            }
            let bytes = 0;
            const chunks = [];
            for await (const part of req) {
                bytes += part.length;
                if (bytes > 64 * 1024)
                    fail('SETTINGS_BODY_TOO_LARGE');
                chunks.push(Buffer.from(part));
            }
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                fail('INVALID_SETTINGS');
            }
            if (!plainObject(body) || Object.keys(body).some(key => !['set', 'keys', 'revision', 'action'].includes(key)))
                fail('INVALID_SETTINGS');
            const update = async () => {
                if (typeof body.revision !== 'string' || body.revision !== options.settings.revision())
                    fail('SETTINGS_CONFLICT');
                if (body.action !== undefined && !['start', 'stop', 'reload'].includes(body.action))
                    fail('INVALID_SETTINGS');
                const patch = options.settings.validate(body.set ?? {});
                if (body.action === 'start' || body.action === 'reload')
                    patch.enabled = true;
                if (body.action === 'stop')
                    patch.enabled = false;
                options.settings.validate(patch);
                const next = parseConfig({ ...options.settings.raw(), ...patch });
                const keys = body.keys ?? {};
                if (!plainObject(keys) || Object.keys(keys).some(key => !['asr', 'tts', 'bot', 'webhook'].includes(key)))
                    fail('INVALID_SETTINGS');
                const writes = new Map();
                for (const [mode, value] of Object.entries(keys)) {
                    if (typeof value !== 'string' || value.length > 16384)
                        fail('INVALID_SETTINGS');
                    if (!value)
                        continue;
                    const ref = keyRef(next, mode);
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
                        fail('INVALID_CREDENTIAL_REF');
                    if (writes.has(ref) && writes.get(ref) !== value)
                        fail('CREDENTIAL_VALUES_CONFLICT');
                    writes.set(ref, value);
                }
                const service = options.credentials();
                if (writes.size && typeof service?.set !== 'function')
                    fail('CREDENTIALS_READ_ONLY');
                for (const [ref, value] of writes)
                    try {
                        await service.set(ref, value);
                    }
                    catch {
                        fail('CREDENTIAL_WRITE_FAILED');
                    }
                if (Object.keys(patch).length)
                    await options.settings.update(patch);
                if (body.action === 'start')
                    await options.runtime.start();
                if (body.action === 'stop')
                    await options.runtime.stop();
                if (body.action === 'reload')
                    await options.runtime.reload();
                return snapshot();
            };
            const operation = tail.then(update);
            tail = operation.catch(() => { });
            json(res, 200, await operation);
        }
        catch (error) {
            const code = error instanceof Error && /^[A-Z][A-Z_]{2,60}$/.test(error.message) ? error.message : 'SETTINGS_OPERATION_FAILED';
            json(res, code === 'SETTINGS_CONFLICT' ? 409 : code === 'SETTINGS_BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: code });
        }
    };
}
