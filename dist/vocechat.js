import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeWebhook } from "./inbound.js";
import { boundedResponse, downloadPublicUrl, validateHttpUrl } from "./network.js";
const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.webm': 'audio/webm', '.flac': 'audio/flac', '.pdf': 'application/pdf', '.txt': 'text/plain',
};
export function mimeOf(name) { return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'; }
function positiveId(id) {
    if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error('INVALID_TARGET_ID');
    return id;
}
function remoteFilePath(value) {
    if (typeof value !== 'string' || !/^\d{4}\/\d{1,2}\/\d{1,2}\/[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('INVALID_RESOURCE_PATH');
    }
    return value;
}
function cleanName(value) {
    return value.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || 'attachment';
}
export class VoceChatClient {
    options;
    baseUrl;
    maxMediaBytes;
    timeoutMs;
    constructor(options) {
        this.options = options;
        this.baseUrl = validateHttpUrl(options.baseUrl);
        if (this.baseUrl.search)
            throw new Error('INVALID_BASE_URL');
        this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/$/, '') + '/';
        this.maxMediaBytes = options.maxMediaBytes ?? 25 * 1024 * 1024;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        if (!Number.isSafeInteger(this.maxMediaBytes) || this.maxMediaBytes < 1 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
            throw new Error('INVALID_TRANSFER_LIMIT');
        }
    }
    endpoint(destination) {
        if (!['user', 'group'].includes(destination.kind))
            throw new Error('INVALID_TARGET_KIND');
        return `api/bot/send_to_${destination.kind}/${positiveId(destination.id)}`;
    }
    async request(endpoint, init = {}, maxBytes = 64 * 1024) {
        const key = await this.options.resolveApiKey();
        if (!key)
            throw new Error('VOCECHAT_CREDENTIAL_MISSING');
        const headers = new Headers(init.headers);
        headers.set('x-api-key', key);
        const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
        try {
            const response = await fetch(new URL(endpoint, this.baseUrl), { ...init, headers, signal, redirect: 'error' });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`VOCECHAT_HTTP_${response.status}`);
            }
            return { bytes: await boundedResponse(response, maxBytes), contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] };
        }
        catch (error) {
            if (error instanceof Error && /^(VOCECHAT_HTTP_\d+|MEDIA_TOO_LARGE)$/.test(error.message))
                throw error;
            throw new Error(signal.aborted ? 'VOCECHAT_TIMEOUT_OR_ABORTED' : 'VOCECHAT_REQUEST_FAILED');
        }
    }
    async sendText(destination, text, options = {}) {
        if (!text.trim())
            throw new Error('EMPTY_TEXT');
        if (options.format !== undefined && !['plain', 'markdown'].includes(options.format))
            throw new Error('INVALID_TEXT_FORMAT');
        // Public Bot API has no native reply operation; a visible quote retains logical linkage.
        const body = options.replyTo === undefined ? text : `> 回复消息 #${positiveId(options.replyTo)}\n\n${text}`;
        const result = await this.request(this.endpoint(destination), {
            method: 'POST', headers: { 'content-type': options.replyTo !== undefined || options.format === 'markdown' ? 'text/markdown' : 'text/plain' }, body, signal: options.signal,
        });
        return { messageId: this.parseMessageId(result.bytes) };
    }
    /** VoceChat 0.5.38 Bot API: context is a count, not the user-token history limit. */
    async getHistory(destination, botUid, limit = 20, signal) {
        this.endpoint(destination);
        positiveId(botUid);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new Error('INVALID_HISTORY_LIMIT');
        const result = await this.request(`api/bot/${destination.kind}/${destination.id}/messages?context=${limit}`, { signal }, 2 * 1024 * 1024);
        let data;
        try {
            data = JSON.parse(result.bytes.toString('utf8'));
        }
        catch {
            throw new Error('VOCECHAT_INVALID_HISTORY');
        }
        if (!Array.isArray(data) || data.length > 1000)
            throw new Error('VOCECHAT_INVALID_HISTORY');
        const messages = new Map();
        for (const item of data) {
            const from = item?.from_uid, target = item?.target;
            const inConversation = destination.kind === 'group' ? target?.gid === destination.id && !target?.uid
                : !target?.gid && ((from === botUid && target?.uid === destination.id) || (from === destination.id && target?.uid === botUid));
            if (!inConversation)
                continue;
            try {
                const message = normalizeWebhook(item);
                if (message)
                    messages.set(message.id, { ...message, destination: { ...destination } });
            }
            catch {
                throw new Error('VOCECHAT_INVALID_HISTORY');
            }
        }
        return [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id)).slice(-limit);
    }
    parseMessageId(bytes) {
        const id = Number(bytes.toString('utf8').trim());
        if (!Number.isSafeInteger(id) || id <= 0)
            throw new Error('VOCECHAT_INVALID_MESSAGE_ID');
        return id;
    }
    async upload(bytes, meta) {
        if (!bytes.length)
            throw new Error('EMPTY_MEDIA');
        if (bytes.length > this.maxMediaBytes)
            throw new Error('MEDIA_TOO_LARGE');
        const name = cleanName(meta.name);
        const prepared = await this.request('api/bot/file/prepare', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: name, content_type: meta.contentType }), signal: meta.signal,
        });
        let fileId;
        try {
            fileId = JSON.parse(prepared.bytes.toString('utf8'));
        }
        catch {
            throw new Error('VOCECHAT_INVALID_UPLOAD_ID');
        }
        if (typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(fileId))
            throw new Error('VOCECHAT_INVALID_UPLOAD_ID');
        const form = new FormData();
        form.append('file_id', fileId);
        form.append('chunk_data', new Blob([Uint8Array.from(bytes)], { type: meta.contentType }), name);
        form.append('chunk_is_last', 'true');
        const uploaded = await this.request('api/bot/file/upload', { method: 'POST', body: form, signal: meta.signal });
        let data;
        try {
            data = JSON.parse(uploaded.bytes.toString('utf8'));
        }
        catch {
            throw new Error('VOCECHAT_INVALID_UPLOAD_RESPONSE');
        }
        if (!data || typeof data !== 'object')
            throw new Error('VOCECHAT_INVALID_UPLOAD_RESPONSE');
        const size = Number(data.size);
        if (!Number.isSafeInteger(size) || size !== bytes.length)
            throw new Error('VOCECHAT_UPLOAD_SIZE_MISMATCH');
        return { path: remoteFilePath(data.path), size, hash: typeof data.hash === 'string' ? data.hash : undefined,
            width: data.image_properties?.width, height: data.image_properties?.height };
    }
    async download(resourcePath, name = 'attachment', signal) {
        const params = new URLSearchParams({ file_path: remoteFilePath(resourcePath) });
        const result = await this.request(`api/resource/file?${params}`, { signal }, this.maxMediaBytes);
        if (!result.bytes.length)
            throw new Error('EMPTY_MEDIA');
        return { ...result, name: cleanName(name) };
    }
    async loadSource(source, signal) {
        if (!!source.path === !!source.url)
            throw new Error('MEDIA_REQUIRES_ONE_SOURCE');
        if (source.url) {
            const url = validateHttpUrl(source.url);
            const result = await downloadPublicUrl(source.url, {
                allowedOrigins: this.options.allowedRemoteOrigins ?? [], timeoutMs: this.timeoutMs, maxBytes: this.maxMediaBytes, signal,
            });
            if (!result.bytes.length)
                throw new Error('EMPTY_MEDIA');
            const name = cleanName(source.name ?? url.pathname.split('/').pop() ?? 'attachment');
            return { ...result, name, contentType: source.mime ?? result.contentType };
        }
        const filename = await this.validateLocalPath(source.path);
        const file = await open(filename, 'r');
        try {
            const stat = await file.stat();
            if (!stat.isFile())
                throw new Error('LOCAL_MEDIA_NOT_FILE');
            if (!stat.size)
                throw new Error('EMPTY_MEDIA');
            if (stat.size > this.maxMediaBytes)
                throw new Error('MEDIA_TOO_LARGE');
            const chunks = [];
            let size = 0;
            for await (const chunk of file.createReadStream({ autoClose: false })) {
                signal?.throwIfAborted();
                size += chunk.length;
                if (size > this.maxMediaBytes)
                    throw new Error('MEDIA_TOO_LARGE');
                chunks.push(chunk);
            }
            const name = cleanName(source.name ?? path.basename(filename));
            return { bytes: Buffer.concat(chunks, size), name, contentType: source.mime ?? mimeOf(name) };
        }
        finally {
            await file.close();
        }
    }
    async validateLocalPath(value) {
        const filename = await realpath(value).catch(() => { throw new Error('LOCAL_MEDIA_NOT_FOUND'); });
        const roots = await Promise.all((this.options.allowedLocalRoots ?? []).map(root => realpath(root).catch(() => '')));
        const allowed = roots.some(root => {
            if (!root)
                return false;
            const relative = path.relative(root, filename);
            return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        if (!allowed)
            throw new Error('LOCAL_MEDIA_PATH_DENIED');
        return filename;
    }
    async sendAttachment(destination, source, options = {}) {
        // Validate target before doing I/O, even when caller bypasses the bridge.
        this.endpoint(destination);
        if (!['image', 'audio', 'file'].includes(source.kind))
            throw new Error('INVALID_ATTACHMENT_KIND');
        const media = await this.loadSource(source, options.signal);
        return this.sendMedia(destination, source.kind, media, options);
    }
    /** Provider-generated bytes never grant Agent-supplied paths access to the plugin's temp directory. */
    sendAudioBytes(destination, bytes, meta, options = {}) {
        return this.sendMedia(destination, 'audio', { bytes: Buffer.from(bytes), name: cleanName(meta.name), contentType: meta.mime }, options);
    }
    async sendMedia(destination, kind, media, options) {
        const endpoint = this.endpoint(destination);
        if (kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(media.contentType)) {
            throw new Error('UNSUPPORTED_IMAGE_FORMAT');
        }
        if (kind === 'audio' && !['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/flac'].includes(media.contentType)) {
            throw new Error('UNSUPPORTED_AUDIO_FORMAT');
        }
        await options.validate?.(media.bytes, media.name, media.contentType);
        const uploaded = await this.upload(media.bytes, { name: media.name, contentType: media.contentType, signal: options.signal });
        const properties = { name: media.name, content_type: media.contentType, size: uploaded.size };
        if (uploaded.width && uploaded.height) {
            properties.width = uploaded.width;
            properties.height = uploaded.height;
        }
        // The official Rust parser decodes base64 UTF-8 JSON, not raw header JSON.
        const headers = { 'content-type': kind === 'audio' ? (this.options.audioContentType ?? 'vocechat/audio') : 'vocechat/file',
            'x-properties': Buffer.from(JSON.stringify(properties), 'utf8').toString('base64') };
        let result;
        let audioFallback = false;
        try {
            result = await this.request(endpoint, { method: 'POST', headers, body: JSON.stringify({ path: uploaded.path }), signal: options.signal });
        }
        catch (error) {
            if (!(error instanceof Error) || error.message !== 'VOCECHAT_HTTP_415' || headers['content-type'] !== 'vocechat/audio')
                throw error;
            headers['content-type'] = 'vocechat/file';
            audioFallback = true;
            result = await this.request(endpoint, { method: 'POST', headers, body: JSON.stringify({ path: uploaded.path }), signal: options.signal });
        }
        return { messageId: this.parseMessageId(result.bytes), remotePath: uploaded.path, size: uploaded.size, audioFallback };
    }
}
