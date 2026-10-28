import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'm4a' | 'flac' | 'webm';
export interface AudioFile { path: string; name?: string; mime?: string }
export interface AudioInfo {
  format: AudioFormat;
  mime: string;
  durationSeconds: number;
  sizeBytes: number;
}
export interface AudioLimits {
  maxBytes?: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  tempDir?: string;
}
export interface TranscriptionResult { text: string; language?: string; durationSeconds?: number }
export interface AsrProvider {
  transcribe(file: AudioFile, signal?: AbortSignal): Promise<TranscriptionResult>;
}

/** Independent of ASR: implementations must label uncertain acoustic interpretations. */
export interface AudioUnderstandingResult {
  description: string;
  acousticCues?: string[];
  nonSpeechSounds?: string[];
  environmentalSounds?: string[];
  uncertainInterpretations?: string[];
}
export interface AudioUnderstandingProvider {
  understand(file: AudioFile, signal?: AbortSignal): Promise<AudioUnderstandingResult>;
}
/** Extension interface only. The bridge never enables speech synthesis implicitly. */
export interface TtsProvider {
  synthesize(text: string, options?: { voice?: string; language?: string; signal?: AbortSignal }): Promise<AudioFile>;
}

export class AudioError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
  }
}

const mimeTypes: Record<AudioFormat, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', webm: 'audio/webm',
};
const defaultFormats: AudioFormat[] = ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'webm'];

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new AudioError('AUDIO_CONFIG', `${name} must be positive and finite`);
  return result;
}

function limits(input: AudioLimits) {
  const result = {
    ...input,
    maxBytes: positive(input.maxBytes, 25 * 1024 * 1024, 'maxBytes'),
    maxDurationSeconds: positive(input.maxDurationSeconds, 600, 'maxDurationSeconds'),
    timeoutMs: positive(input.timeoutMs, 60_000, 'timeoutMs'),
  };
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs > 0xffffffff) throw new AudioError('AUDIO_CONFIG', 'timeoutMs must be an integer between 1 and 4294967295');
  return result;
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** Detect the container from bytes, never from an attachment's extension or MIME. */
export function detectAudioFormat(bytes: Uint8Array): AudioFormat {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return 'mp3';
  throw new AudioError('AUDIO_UNSUPPORTED', 'Unsupported audio container; expected WAV, MP3, OGG/Opus, M4A, FLAC or WebM');
}

function wavDuration(bytes: Buffer): number | undefined {
  if (bytes.length < 44 || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new AudioError('AUDIO_INVALID', 'Invalid or truncated WAV container');
  }
  let byteRate = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  let pcm = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > bytes.length - start) throw new AudioError('AUDIO_INVALID', 'Truncated WAV chunk');
    if (id === 'fmt ' && size >= 16) {
      const encoding = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const sampleRate = bytes.readUInt32LE(start + 4);
      byteRate = bytes.readUInt32LE(start + 8);
      blockAlign = bytes.readUInt16LE(start + 12);
      const bits = bytes.readUInt16LE(start + 14);
      pcm = (encoding === 1 || encoding === 3) && channels > 0 && sampleRate > 0 && bits > 0 && bits % 8 === 0 &&
        blockAlign === channels * bits / 8 && byteRate === sampleRate * blockAlign;
    }
    if (id === 'data') dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (pcm && dataBytes > 0 && dataBytes % blockAlign === 0) return dataBytes / byteRate;
  // Non-PCM/extended WAV requires a decoder, just like other compressed containers.
  return undefined;
}

function run(program: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: timeoutMs, signal, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function durationWithProbe(file: string, options: ReturnType<typeof limits>, signal?: AbortSignal): Promise<number> {
  let stdout: string;
  try {
    stdout = await run(options.ffprobePath || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a',
      '-show_entries', 'format=duration:stream=duration,codec_type', '-of', 'json', path.resolve(file),
    ], options.timeoutMs, signal);
  } catch (error) {
    if (signal?.aborted) throw new AudioError('AUDIO_CANCELLED', 'Audio probing cancelled');
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === 'ENOENT') throw new AudioError('AUDIO_PROBE_REQUIRED', 'FFprobe is required to validate duration for compressed audio; install FFmpeg/FFprobe or configure ffprobePath');
    if (failure.killed) throw new AudioError('AUDIO_TIMEOUT', 'Audio probing timed out');
    throw new AudioError('AUDIO_INVALID', 'FFprobe could not decode this audio file');
  }
  try {
    const result = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { duration?: string; codec_type?: string }[] };
    if (!result.streams?.some(stream => stream.codec_type === 'audio')) throw new Error();
    const durations = [result.format?.duration, ...result.streams.map(stream => stream.duration)]
      .map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0);
    if (!durations.length) throw new Error();
    return Math.max(...durations);
  } catch {
    throw new AudioError('AUDIO_INVALID', 'Cannot determine a valid audio duration');
  }
}

export async function probeAudio(file: AudioFile | string, input: AudioLimits = {}, signal?: AbortSignal): Promise<AudioInfo> {
  signal?.throwIfAborted();
  const options = limits(input);
  const filename = typeof file === 'string' ? file : file.path;
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size === 0) throw new AudioError('AUDIO_INVALID', 'Audio must be a nonempty regular file');
  if (info.size > options.maxBytes) throw new AudioError('AUDIO_TOO_LARGE', `Audio exceeds ${options.maxBytes} bytes`);
  const bytes = await fs.readFile(filename, { signal });
  if (bytes.length > options.maxBytes) throw new AudioError('AUDIO_TOO_LARGE', `Audio exceeds ${options.maxBytes} bytes`);
  const format = detectAudioFormat(bytes);
  const durationSeconds = (format === 'wav' ? wavDuration(bytes) : undefined) ?? await durationWithProbe(filename, options, signal);
  if (durationSeconds > options.maxDurationSeconds) throw new AudioError('AUDIO_TOO_LONG', `Audio exceeds ${options.maxDurationSeconds} seconds`);
  return { format, mime: mimeTypes[format], durationSeconds, sizeBytes: bytes.length };
}

export interface OpenAICompatibleAsrOptions extends AudioLimits {
  /** Administrator-configured API base, e.g. a local Whisper server's http://127.0.0.1:8000/v1. */
  baseUrl: string;
  model: string;
  resolveApiKey?: () => Promise<string | undefined> | string | undefined;
  language?: string;
  acceptedFormats?: AudioFormat[];
  maxResponseBytes?: number;
}

async function readResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new AudioError('ASR_INVALID_RESPONSE', 'ASR returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AudioError('ASR_INVALID_RESPONSE', 'ASR response exceeds configured limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Multipart transcription protocol, compatible with self-hosted Whisper services. */
export class OpenAICompatibleAsr implements AsrProvider {
  private readonly endpoint: URL;
  private readonly options: OpenAICompatibleAsrOptions;

  constructor(input: OpenAICompatibleAsrOptions) {
    try {
      this.endpoint = new URL(input.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions');
      if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.hash || this.endpoint.search) throw new Error();
    } catch { throw new AudioError('ASR_CONFIG', 'ASR baseUrl must be an HTTP(S) API base without credentials, query or fragment'); }
    if (!input.model?.trim()) throw new AudioError('ASR_CONFIG', 'ASR model is required');
    if (input.language && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(input.language)) throw new AudioError('ASR_CONFIG', 'ASR language must be a language code, for example zh or en');
    if (input.acceptedFormats && (!input.acceptedFormats.length || input.acceptedFormats.some(format => !defaultFormats.includes(format)))) throw new AudioError('ASR_CONFIG', 'acceptedFormats contains unsupported audio formats');
    this.options = { ...limits(input), ...input };
    positive(input.maxResponseBytes, 1024 * 1024, 'maxResponseBytes');
  }

  async transcribe(file: AudioFile, signal?: AbortSignal): Promise<TranscriptionResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let convertedDir: string | undefined;
    try {
      requestSignal.throwIfAborted();
      const info = await probeAudio(file, this.options, requestSignal);
      const accepted = this.options.acceptedFormats ?? defaultFormats;
      let upload = file.path;
      let format = info.format;
      if (!accepted.includes(format)) {
        if (!accepted.includes('wav')) throw new AudioError('AUDIO_UNSUPPORTED', 'ASR cannot accept this container and WAV conversion is not enabled');
        const tempBase = this.options.tempDir || os.tmpdir();
        await fs.mkdir(tempBase, { recursive: true });
        convertedDir = await fs.mkdtemp(path.join(tempBase, 'voce-asr-'));
        upload = path.join(convertedDir, 'transcription.wav');
        try {
          await run(this.options.ffmpegPath || 'ffmpeg', [
            '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file.path),
            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
            // Stop unbounded output above the limit, then reject rather than transcribe truncation.
            '-fs', String((this.options.maxBytes ?? 25 * 1024 * 1024) + 65536), '-y', upload,
          ], this.options.timeoutMs ?? 60_000, requestSignal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AudioError('AUDIO_CONVERT_REQUIRED', 'FFmpeg is required to convert this audio format; install FFmpeg or configure ffmpegPath');
          throw new AudioError('AUDIO_CONVERT_FAILED', 'FFmpeg audio conversion failed');
        }
        await probeAudio(upload, this.options, requestSignal);
        format = 'wav';
      }
      const bytes = await fs.readFile(upload, { signal: requestSignal });
      if (bytes.length > (this.options.maxBytes ?? 25 * 1024 * 1024)) throw new AudioError('AUDIO_TOO_LARGE', 'Converted audio exceeds configured size limit');
      const body = new FormData();
      body.set('model', this.options.model);
      body.set('file', new Blob([bytes], { type: mimeTypes[format] }), `audio.${format}`);
      body.set('response_format', 'json');
      if (this.options.language) body.set('language', this.options.language);
      let key: string | undefined;
      try { key = await withAbort(Promise.resolve().then(() => this.options.resolveApiKey?.()), requestSignal); }
      catch {
        requestSignal.throwIfAborted();
        throw new AudioError('ASR_CREDENTIAL', 'ASR credential resolution failed');
      }
      requestSignal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {}, body,
          redirect: 'error', signal: requestSignal,
        });
      } catch {
        requestSignal.throwIfAborted();
        throw new AudioError('ASR_UNAVAILABLE', 'Cannot reach the configured ASR service');
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Never copy provider responses, API keys, endpoint queries or local paths into errors.
        throw new AudioError('ASR_HTTP', `ASR request failed (HTTP ${response.status})`);
      }
      let raw: string;
      try { raw = await readResponse(response, this.options.maxResponseBytes ?? 1024 * 1024); }
      catch (error) {
        requestSignal.throwIfAborted();
        if (error instanceof AudioError) throw error;
        throw new AudioError('ASR_INVALID_RESPONSE', 'ASR response stream failed');
      }
      let result: { text?: unknown; language?: unknown };
      try { result = JSON.parse(raw); }
      catch { throw new AudioError('ASR_INVALID_RESPONSE', 'ASR returned invalid JSON'); }
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new AudioError('ASR_EMPTY', 'ASR returned no transcription text');
      return {
        text: result.text.trim(),
        ...(typeof result.language === 'string' ? { language: result.language } : {}),
        durationSeconds: info.durationSeconds,
      };
    } catch (error) {
      if (signal?.aborted) throw new AudioError('ASR_CANCELLED', 'ASR transcription cancelled');
      if (timeout.aborted) throw new AudioError('ASR_TIMEOUT', 'ASR transcription timed out');
      throw error;
    } finally {
      if (convertedDir) await fs.rm(convertedDir, { recursive: true, force: true });
    }
  }
}
