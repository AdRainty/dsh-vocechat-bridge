import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AudioError, detectAudioFormat, OpenAICompatibleAsr, probeAudio } from '../src/audio.ts';

function wav(seconds = 0.25): Buffer {
  const sampleRate = 16000;
  const size = Math.round(sampleRate * seconds) * 2;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
  return b;
}
async function fixture(t: TestContext, bytes = wav()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voce-audio-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const filename = path.join(dir, 'input.wav');
  await fs.writeFile(filename, bytes);
  return { dir, file: { path: filename, name: 'untrusted.mp3', mime: 'audio/mpeg' } };
}
async function api(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    handler(req, res, Buffer.concat(chunks));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}
function code(expected: string) { return (error: unknown) => error instanceof AudioError && error.code === expected; }

test('PCM WAV duration uses actual bytes, ignoring name and MIME', async t => {
  const { file } = await fixture(t);
  const info = await probeAudio(file, { ffprobePath: 'definitely-missing-ffprobe' });
  assert.equal(info.format, 'wav');
  assert.equal(info.mime, 'audio/wav');
  assert.equal(info.durationSeconds, 0.25);
  assert.equal(info.sizeBytes, wav().length);
});

test('audio container identification uses magic for common formats', () => {
  assert.equal(detectAudioFormat(wav()), 'wav');
  assert.equal(detectAudioFormat(Buffer.from('OggS OpusHead')), 'ogg');
  assert.equal(detectAudioFormat(Buffer.from('fLaC')), 'flac');
  assert.equal(detectAudioFormat(Buffer.from('0000ftypM4A ')), 'm4a');
  assert.equal(detectAudioFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'webm');
  assert.equal(detectAudioFormat(Buffer.from('ID3')), 'mp3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb])), 'mp3');
  assert.throws(() => detectAudioFormat(Buffer.from('<html>not audio</html>')), code('AUDIO_UNSUPPORTED'));
});

test('audio size and duration limits reject before ASR', async t => {
  const { file } = await fixture(t, wav(1));
  await assert.rejects(probeAudio(file, { maxBytes: 100 }), code('AUDIO_TOO_LARGE'));
  await assert.rejects(probeAudio(file, { maxDurationSeconds: 0.1 }), code('AUDIO_TOO_LONG'));
  await assert.rejects(probeAudio(file, { maxBytes: -1 }), code('AUDIO_CONFIG'));
});

test('invalid/truncated WAV and unsupported files fail explicitly', async t => {
  const { file } = await fixture(t, wav().subarray(0, 50));
  await assert.rejects(probeAudio(file), code('AUDIO_INVALID'));
  await fs.writeFile(file.path, 'a plain text file');
  await assert.rejects(probeAudio(file), code('AUDIO_UNSUPPORTED'));
  await fs.writeFile(file.path, '');
  await assert.rejects(probeAudio(file), code('AUDIO_INVALID'));
});

test('compressed audio without FFprobe gives an actionable dependency error', async t => {
  const { file } = await fixture(t, Buffer.from('ID3 invalid compressed audio'));
  await assert.rejects(probeAudio(file, { ffprobePath: 'definitely-missing-ffprobe' }), code('AUDIO_PROBE_REQUIRED'));
});

test('ASR sends real multipart file/model/language and fresh credentials', async t => {
  const { file } = await fixture(t);
  let calls = 0;
  const baseUrl = await api(t, (req, res, bytes) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, `Bearer test-key-${++calls}`);
    assert.match(req.headers['content-type']!, /^multipart\/form-data; boundary=/);
    const body = bytes.toString('utf8');
    assert.match(body, /name="model"\r\n\r\nlocal-whisper/);
    assert.match(body, /name="language"\r\n\r\nzh/);
    assert.match(body, /name="response_format"\r\n\r\njson/);
    assert.match(body, /filename="audio.wav"/);
    assert.match(body, /Content-Type: audio\/wav/i);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: '  你好，语音已转写。  ', language: 'zh' }));
  });
  let resolutions = 0;
  const provider = new OpenAICompatibleAsr({ baseUrl, model: 'local-whisper', language: 'zh', resolveApiKey: () => `test-key-${++resolutions}` });
  assert.deepEqual(await provider.transcribe(file), { text: '你好，语音已转写。', language: 'zh', durationSeconds: 0.25 });
  await provider.transcribe(file);
  assert.equal(calls, 2);
  assert.equal(resolutions, 2);
});

test('ASR works with a local unauthenticated Whisper-compatible service', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ text: 'local transcript' }));
  });
  const provider = new OpenAICompatibleAsr({ baseUrl, model: 'whisper-large-v3' });
  assert.equal((await provider.transcribe(file)).text, 'local transcript');
});

test('ASR HTTP failures never expose response bodies or credentials', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, (_req, res) => {
    res.statusCode = 401;
    res.end('secret-server-error private-test-key');
  });
  const provider = new OpenAICompatibleAsr({ baseUrl, model: 'local-whisper', resolveApiKey: () => 'private-test-key' });
  await assert.rejects(provider.transcribe(file), error => {
    assert(error instanceof AudioError);
    assert.equal(error.code, 'ASR_HTTP');
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /secret|private-test-key/);
    return true;
  });
});

test('ASR malformed JSON, absent/empty text and oversized responses never fabricate text', async t => {
  const { file } = await fixture(t);
  for (const [body, expected] of [['invalid JSON', 'ASR_INVALID_RESPONSE'], ['{}', 'ASR_EMPTY'], ['{"text":"  "}', 'ASR_EMPTY']]) {
    const baseUrl = await api(t, (_req, res) => { res.end(body); });
    await assert.rejects(new OpenAICompatibleAsr({ baseUrl, model: 'test' }).transcribe(file), code(expected!));
  }
  const baseUrl = await api(t, (_req, res) => { res.end(JSON.stringify({ text: 'a'.repeat(1024) })); });
  await assert.rejects(new OpenAICompatibleAsr({ baseUrl, model: 'test', maxResponseBytes: 100 }).transcribe(file), code('ASR_INVALID_RESPONSE'));
});

test('ASR timeout and explicit cancellation stop pending requests', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, () => {});
  await assert.rejects(new OpenAICompatibleAsr({ baseUrl, model: 'test', timeoutMs: 80 }).transcribe(file), code('ASR_TIMEOUT'));
  const controller = new AbortController();
  const pending = new OpenAICompatibleAsr({ baseUrl, model: 'test', timeoutMs: 3000 }).transcribe(file, controller.signal);
  controller.abort();
  await assert.rejects(pending, code('ASR_CANCELLED'));
});

test('ASR refuses redirects and invalid service configuration', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, (_req, res) => {
    res.statusCode = 307;
    res.setHeader('location', 'http://127.0.0.1:1/steal-key');
    res.end();
  });
  await assert.rejects(new OpenAICompatibleAsr({ baseUrl, model: 'test' }).transcribe(file), code('ASR_UNAVAILABLE'));
  assert.throws(() => new OpenAICompatibleAsr({ baseUrl: 'file:///secret', model: 'test' }), code('ASR_CONFIG'));
  assert.throws(() => new OpenAICompatibleAsr({ baseUrl: 'https://key:secret@example.com', model: 'test' }), code('ASR_CONFIG'));
  assert.throws(() => new OpenAICompatibleAsr({ baseUrl, model: '' }), code('ASR_CONFIG'));
  assert.throws(() => new OpenAICompatibleAsr({ baseUrl, model: 'test', acceptedFormats: [] }), code('ASR_CONFIG'));
});

test('credential resolution is bounded and errors never disclose provider secrets', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, (_req, res) => { res.end('{"text":"unused"}'); });
  const failed = new OpenAICompatibleAsr({ baseUrl, model: 'test', resolveApiKey: () => { throw new Error('secret-value'); } });
  await assert.rejects(failed.transcribe(file), error => {
    assert(error instanceof AudioError);
    assert.equal(error.code, 'ASR_CREDENTIAL');
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  const neverResolved = new OpenAICompatibleAsr({ baseUrl, model: 'test', timeoutMs: 80, resolveApiKey: () => new Promise(() => {}) });
  await assert.rejects(neverResolved.transcribe(file), code('ASR_TIMEOUT'));
});

test('ASR unavailable service fails without a fake transcript', async t => {
  const { file } = await fixture(t);
  // Bind then close a port so no external connection is used.
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(new OpenAICompatibleAsr({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test' }).transcribe(file), code('ASR_UNAVAILABLE'));
});

test('ASR rejects a container outside acceptedFormats when no WAV fallback is allowed', async t => {
  const { file } = await fixture(t);
  const baseUrl = await api(t, () => { assert.fail('unsupported audio must not reach ASR'); });
  const provider = new OpenAICompatibleAsr({ baseUrl, model: 'test', acceptedFormats: ['mp3'] });
  await assert.rejects(provider.transcribe(file), code('AUDIO_UNSUPPORTED'));
});

test('real local FFmpeg/FFprobe conversion uploads WAV and cleans temporary files', async t => {
  const exec = promisify(execFile);
  try { await exec('ffmpeg', ['-version'], { windowsHide: true }); await exec('ffprobe', ['-version'], { windowsHide: true }); }
  catch { t.skip('FFmpeg and FFprobe are not installed; WAV and ASR tests still run'); return; }
  const { dir, file } = await fixture(t);
  const compressed = path.join(dir, 'voice.flac');
  await exec('ffmpeg', ['-v', 'error', '-i', file.path, compressed], { windowsHide: true });
  const info = await probeAudio(compressed);
  assert.equal(info.format, 'flac');
  assert(Math.abs(info.durationSeconds - 0.25) < 0.01);
  const converted = path.join(dir, 'converted');
  const baseUrl = await api(t, (_req, res, body) => {
    assert.match(body.toString('utf8'), /filename="audio.wav"/);
    res.end(JSON.stringify({ text: 'converted transcript' }));
  });
  const options = { baseUrl, model: 'test', acceptedFormats: ['wav'] as const, tempDir: converted };
  const provider = new OpenAICompatibleAsr({ ...options, acceptedFormats: [...options.acceptedFormats] });
  assert.equal((await provider.transcribe({ path: compressed })).text, 'converted transcript');
  assert.deepEqual(await fs.readdir(converted), []);
  const missingConverter = new OpenAICompatibleAsr({ ...options, acceptedFormats: [...options.acceptedFormats], ffmpegPath: 'definitely-missing-ffmpeg' });
  await assert.rejects(missingConverter.transcribe({ path: compressed }), code('AUDIO_CONVERT_REQUIRED'));
  assert.deepEqual(await fs.readdir(converted), []);
  const failedApi = await api(t, (_req, res) => { res.statusCode = 503; res.end(); });
  const failedProvider = new OpenAICompatibleAsr({ ...options, baseUrl: failedApi, acceptedFormats: [...options.acceptedFormats] });
  await assert.rejects(failedProvider.transcribe({ path: compressed }), code('ASR_HTTP'));
  assert.deepEqual(await fs.readdir(converted), []);
  // A compact FLAC may fit the input limit while decoded PCM does not. Never
  // send a truncated conversion as if it represented the original recording.
  const longWav = path.join(dir, 'long.wav');
  const longFlac = path.join(dir, 'long.flac');
  await fs.writeFile(longWav, wav(10));
  await exec('ffmpeg', ['-v', 'error', '-i', longWav, longFlac], { windowsHide: true });
  const limited = new OpenAICompatibleAsr({ ...options, maxBytes: 20_000, acceptedFormats: [...options.acceptedFormats] });
  await assert.rejects(limited.transcribe({ path: longFlac }), code('AUDIO_TOO_LARGE'));
  assert.deepEqual(await fs.readdir(converted), []);
});
