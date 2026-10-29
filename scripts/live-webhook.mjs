#!/usr/bin/env node
// Receive-only integration harness: real Bridge/VoceChat I/O, a local audit
// SessionPort, no model calls and no outgoing messages. Secrets come from a file.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Bridge } from '../dist/bridge.js';
import { normalizeWebhook } from '../dist/inbound.js';
import { probeAudio } from '../dist/audio.js';

const configPath = resolve(process.argv[2] || '.runtime/live-test/config.json');
const input = JSON.parse(await readFile(configPath, 'utf8'));
const outputDir = resolve(input.outputDir || dirname(configPath));
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const summary = { mode: 'receive-only', dshConnected: false, asrEnabled: false,
  mediaDownloadEnabled: input.allowMediaDownload === true,
  webhookTokenRequired: input.requireWebhookToken !== false,
  httpRequests: 0, lastHttpRequest: null,
  startedAt: new Date().toISOString(), received: 0, prepared: 0, media: [], lastInbound: null };
let bridge;
let writes = Promise.resolve();
const safeCode = error => /^[A-Z][A-Z0-9_]{2,64}$/.test(error?.message || '') ? error.message : 'LIVE_TEST_ERROR';
function record(value) {
  writes = writes.then(() => appendFile(join(outputDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }));
  return writes;
}
async function saveStatus() {
  await writeFile(join(outputDir, 'status.json'), JSON.stringify({ ...summary, bridge: bridge?.status() }, null, 2), { mode: 0o600 });
}
const session = {
  async run(messages) {
    for (const message of messages) {
      const media = [];
      for (const attachment of message.attachments) {
        const bytes = attachment.localPath ? await readFile(attachment.localPath) : undefined;
        const audio = attachment.kind === 'audio' && attachment.localPath
          ? await probeAudio({ path: attachment.localPath }, { maxBytes: bridge.config.maxMediaBytes, maxDurationSeconds: bridge.config.maxAudioSeconds })
          : undefined;
        media.push({ kind: attachment.kind, mime: attachment.mime, bytes: bytes?.length,
          sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : undefined,
          audio: audio ? { format: audio.format, durationSeconds: audio.durationSeconds } : undefined,
          transcriptionError: attachment.error });
      }
      summary.prepared++;
      summary.media.push(...media);
      summary.media = summary.media.slice(-100);
      await record({ stage: 'prepared', id: message.id, senderId: message.senderId,
        destination: message.destination, textChars: message.text.length, media });
    }
    await saveStatus();
    return { quiet: true };
  },
};
bridge = new Bridge({ enabled: true, baseUrl: input.baseUrl, botUid: input.botUid,
  botApiKeyRef: 'LIVE_BOT_KEY', webhookSecretRef: 'LIVE_WEBHOOK_SECRET',
  webhookHost: input.host || '0.0.0.0', webhookPort: input.port ?? 34567, webhookPath: '/vocehook',
  targetSessionId: 'live-receive-only-audit', autoReply: false, allowProactive: false,
  asrEnabled: false, statePath: join(outputDir, 'state.json'), tempDir: join(outputDir, 'tmp'),
  userWhitelist: [], groupWhitelist: [], mergeWindowMs: 100,
}, { session, resolveCredential: async ref => ref === 'LIVE_BOT_KEY' ? input.botApiKey : input.webhookSecret,
  logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, text => {
    console.log(JSON.stringify({ at: new Date().toISOString(), level, code: text }));
  }])) });
// Test-only instrumentation of the compiled handler: record every GET/POST,
// including rejected requests, without retaining query/header values or bodies.
const handleHttp = bridge.handleHttp.bind(bridge);
bridge.handleHttp = async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const plaintextTest = input.requireWebhookToken === false && req.method === 'POST' && url.pathname === bridge.config.webhookPath;
  const probe = { method: req.method, routeMatches: url.pathname === bridge.config.webhookPath,
    hasQuerySecret: url.searchParams.has('secret'), hasAuthorization: Boolean(req.headers.authorization),
    plaintextTest,
    isLocal: ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) };
  summary.httpRequests++;
  res.once('finish', () => {
    summary.lastHttpRequest = { at: new Date().toISOString(), ...probe, status: res.statusCode };
    void record({ stage: 'http', ...summary.lastHttpRequest }).then(saveStatus).catch(() => {});
  });
  // Explicitly opt-in receive-only testing can accept the platform's plaintext
  // callbacks. Adapt only this local audit harness to the internal Bridge auth
  // contract; the plugin's defaults and public production API do not change.
  if (plaintextTest) req.headers.authorization = `Bearer ${input.webhookSecret}`;
  return handleHttp(req, res);
};
const accept = bridge.accept.bind(bridge);
bridge.accept = async value => {
  summary.received++;
  let message;
  try { message = normalizeWebhook(value); }
  catch (error) {
    await record({ stage: 'invalid', code: safeCode(error),
      keys: Object.keys(value || {}).slice(0, 20), detailKeys: Object.keys(value?.detail || {}).slice(0, 20) });
    await saveStatus();
    throw error;
  }
  if (message) {
    summary.lastInbound = { id: message.id, senderId: message.senderId, destination: message.destination,
      textChars: message.text.length, attachmentKinds: message.attachments.map(a => a.kind) };
    await record({ stage: 'received', ...summary.lastInbound });
    if (message.attachments.length && input.allowMediaDownload !== true) {
      await record({ stage: 'media-download-disabled', id: message.id });
      await saveStatus();
      return 'ignored';
    }
    // This harness accepts authenticated test inbound senders into a local audit
    // session only. The production defaults/whitelist behavior are unchanged.
    if (message.senderId !== input.botUid) {
      const list = message.destination.kind === 'group' ? bridge.config.groupWhitelist : bridge.config.userWhitelist;
      if (!list.includes(message.destination.id)) list.push(message.destination.id);
    }
  }
  const result = await accept(value);
  await record({ stage: 'accepted', id: message?.id, result });
  await saveStatus();
  return result;
};
await bridge.start();
await saveStatus();
await writeFile(join(outputDir, 'receiver.pid'), String(process.pid), { mode: 0o600 });
console.log(JSON.stringify({ listening: true, port: bridge.status().address?.port, path: '/vocehook', mode: summary.mode }));
const timer = setInterval(() => { void saveStatus().catch(() => {}); }, 1000);
timer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  await bridge.stop(); await writes; await saveStatus();
  process.exit(0);
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
