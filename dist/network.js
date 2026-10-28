import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
/** Addresses that must never be fetched from a message-supplied remote URL. */
export function isPublicAddress(raw) {
    const address = raw.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
            (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
    }
    if (isIP(address) === 6) {
        // Only global unicast; exclude documentation, 6to4 and Teredo transition ranges.
        const [first, second] = address.split(':');
        const secondNumber = parseInt(second || '0', 16);
        return /^[23][0-9a-f]{0,3}:/.test(address) &&
            !(first === '2001' && (secondNumber <= 0x1ff || secondNumber === 0xdb8)) &&
            first !== '2002' && !(first === '3fff' && secondNumber <= 0xfff);
    }
    return false;
}
export function validateHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('INVALID_HTTP_URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error('INVALID_HTTP_URL');
    }
    return url;
}
export async function boundedResponse(response, maxBytes) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
        await response.body?.cancel();
        throw new Error('MEDIA_TOO_LARGE');
    }
    if (!response.body)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maxBytes)
                throw new Error('MEDIA_TOO_LARGE');
            chunks.push(value);
        }
    }
    catch (error) {
        await reader.cancel().catch(() => { });
        throw error;
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}
/** DNS answers are checked and pinned to the socket; a second DNS lookup cannot rebind it. */
export async function downloadPublicUrl(value, options) {
    const url = validateHttpUrl(value);
    if (!options.allowedOrigins.some(origin => validateHttpUrl(origin).origin === url.origin)) {
        throw new Error('REMOTE_ORIGIN_DENIED');
    }
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
        : AbortSignal.timeout(options.timeoutMs);
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let answers;
    let abortLookup;
    try {
        answers = isIP(host) ? [{ address: host, family: isIP(host) }]
            : await Promise.race([
                lookup(host, { all: true, verbatim: true }),
                new Promise((_, reject) => {
                    abortLookup = () => reject(new Error('REMOTE_TIMEOUT'));
                    signal.addEventListener('abort', abortLookup, { once: true });
                }),
            ]);
    }
    catch {
        throw new Error(signal.aborted ? 'REMOTE_TIMEOUT_OR_ABORTED' : 'REMOTE_LOOKUP_FAILED');
    }
    finally {
        if (abortLookup)
            signal.removeEventListener('abort', abortLookup);
    }
    signal.throwIfAborted();
    if (!answers.length || answers.some(a => !isPublicAddress(a.address)))
        throw new Error('REMOTE_ADDRESS_DENIED');
    const selected = answers[0];
    return await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            signal,
            // Keep the URL hostname for Host/TLS verification, pin just the connection address.
            lookup: (_hostname, lookupOptions, callback) => {
                if (typeof lookupOptions === 'object' && lookupOptions.all)
                    callback(null, [selected]);
                else
                    callback(null, selected.address, selected.family);
            },
            headers: { accept: '*/*' },
        }, response => {
            if (response.statusCode !== 200) {
                response.destroy();
                reject(new Error(`REMOTE_HTTP_${response.statusCode ?? 0}`));
                return;
            }
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && declared > options.maxBytes) {
                response.destroy();
                reject(new Error('MEDIA_TOO_LARGE'));
                return;
            }
            let size = 0;
            const chunks = [];
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > options.maxBytes) {
                    response.destroy();
                    reject(new Error('MEDIA_TOO_LARGE'));
                }
                else
                    chunks.push(chunk);
            });
            response.on('end', () => resolve({ bytes: Buffer.concat(chunks, size), contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0] }));
            response.on('error', () => reject(new Error('REMOTE_DOWNLOAD_FAILED')));
        });
        request.on('error', () => reject(new Error(signal.aborted ? 'REMOTE_TIMEOUT_OR_ABORTED' : 'REMOTE_DOWNLOAD_FAILED')));
        request.end();
    });
}
