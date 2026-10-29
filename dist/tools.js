const destinationSpec = { type: 'object', required: true, additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['user', 'group'] },
        id: { type: 'integer', required: true, description: 'Explicit whitelisted VoceChat UID or GID.' },
    } };
const mediaProperties = {
    kind: { type: 'string', required: true, enum: ['image', 'audio', 'file'] },
    path: { type: 'string', description: 'Local file inside configured allowedLocalRoots.' },
    url: { type: 'string', description: 'Remote file from configured allowedRemoteOrigins.' },
    name: { type: 'string' }, mime: { type: 'string' },
};
function destination(value) {
    if (!value || !['user', 'group'].includes(value.kind) || !Number.isSafeInteger(value.id) || value.id <= 0)
        throw new Error('INVALID_DESTINATION');
    return { kind: value.kind, id: value.id };
}
function media(value) {
    if (!value || !['image', 'audio', 'file'].includes(value.kind) || Boolean(value.path) === Boolean(value.url))
        throw new Error('INVALID_MEDIA_SOURCE');
    return { kind: value.kind, ...(value.path ? { path: value.path } : { url: value.url }),
        ...(value.name ? { name: value.name } : {}), ...(value.mime ? { mime: value.mime } : {}) };
}
/** Register DSH tools using the actual host defineTool compiler (injected by entry). */
export function registerVoceTools(ctx, bridge, session, defineTool) {
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
    const send = async (args, exec, message) => {
        const to = destination(args.destination);
        const { proactive } = session.outboundMode(exec?.agent, to);
        let receipt;
        try {
            receipt = await bridge.send(to, message, { proactive, signal: exec?.signal });
        }
        catch (error) {
            if (error?.sent === true)
                session.noteSent(exec?.agent, to);
            throw error;
        }
        session.noteSent(exec?.agent, to);
        return JSON.stringify({ ok: true, receipts: receipt });
    };
    const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters, output,
        isConcurrencySafe: () => false, execute }));
    register('voce_send_text', 'Send text to an explicit whitelisted VoceChat destination. Proactive sending requires allowProactive. A successful reply suppresses duplicate automatic text.', {
        destination: destinationSpec, text: { type: 'string', required: true }, format: { type: 'string', enum: ['plain', 'markdown'], description: 'Text format; defaults to plain.' }, replyTo: { type: 'integer' },
    }, (args, exec) => send(args, exec, { text: args.text, format: args.format, replyTo: args.replyTo }));
    for (const kind of ['image', 'audio', 'file']) {
        register(`voce_send_${kind}`, `Upload and send an existing ${kind} to an explicit whitelisted VoceChat destination. Specify exactly one local path or permitted remote URL.`, {
            destination: destinationSpec, path: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' }, replyTo: { type: 'integer' },
        }, (args, exec) => send(args, exec, { attachments: [media({ ...args, kind })], replyTo: args.replyTo }));
    }
    register('voce_send_message', 'Send a combined VoceChat reply: optional text and ordered image/audio/file attachments. The bridge uploads and sends each part in order. Explicit destination and media allowlists are required.', {
        destination: destinationSpec, text: { type: 'string' }, format: { type: 'string', enum: ['plain', 'markdown'], description: 'Text format; defaults to plain.' }, replyTo: { type: 'integer' },
        attachments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: mediaProperties } },
    }, (args, exec) => send(args, exec, { text: args.text, format: args.format, attachments: args.attachments?.map(media), replyTo: args.replyTo }));
    register('voce_quiet', 'End the current VoceChat turn without an automatic text reply. Use when no response is needed. No text marker is necessary.', {}, (_args, exec) => {
        session.quiet(exec?.agent);
        exec.concludeTurn?.();
        return JSON.stringify({ ok: true, quiet: true });
    });
    register('voce_bridge_status', 'Read VoceChat bridge lifecycle and queue counts without credentials or message contents.', {}, () => JSON.stringify(bridge.status()));
}
