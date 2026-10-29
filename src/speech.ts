import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioError, OpenAICompatibleAsr, normalizeSpeechAudio, probeAudio } from './audio.ts';
import type { AsrProvider, AudioFile, OpenAICompatibleAsrOptions, SynthesisOptions, SynthesizedAudio, TtsProvider } from './audio.ts';
import type { BridgeConfig } from './config.ts';
import type { CredentialResolver } from './types.ts';

export interface SpeechProviderOptions extends OpenAICompatibleAsrOptions {
  provider: 'openai' | 'mimo'; voice?: string; instructions?: string; format?: 'wav' | 'mp3';
}

function endpoint(baseUrl: string, route: string) {
  try {
    const url = new URL(baseUrl.replace(/\/+$/, '') + route);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new AudioError('SPEECH_CONFIG', 'Speech API base must be HTTP(S), without credentials, query or fragment'); }
}

async function readBytes(response: Response, max: number, code: string): Promise<Buffer> {
  if (!response.body) throw new AudioError(code, 'Speech service returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new AudioError(code, 'Speech response exceeds the configured limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function post(options: SpeechProviderOptions, route: string, body: unknown, signal: AbortSignal, kind: 'ASR' | 'TTS') {
  const url = endpoint(options.baseUrl, route);
  let key: string | undefined;
  try {
    key = await new Promise<string | undefined>((resolve,reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
      Promise.resolve().then(() => options.resolveApiKey?.()).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
    });
  } catch { signal.throwIfAborted(); throw new AudioError(`${kind}_CREDENTIAL`, 'Speech credential resolution failed'); }
  if (options.provider === 'mimo' && !key) throw new AudioError(`${kind}_CREDENTIAL`, 'MiMo API key is not configured');
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json', ...(key ? { Authorization:`Bearer ${key}` } : {}) },
      body:JSON.stringify(body), redirect:'error', signal });
  } catch { signal.throwIfAborted(); throw new AudioError(`${kind}_UNAVAILABLE`, 'Cannot reach the speech service'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AudioError(`${kind}_HTTP`, `Speech request failed (HTTP ${response.status})`);
  }
  return response;
}

function json(bytes: Buffer, code: string): any {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new AudioError(code, 'Speech service returned invalid JSON'); }
}

export class MiMoAsr implements AsrProvider {
  private options: SpeechProviderOptions;
  constructor(options: SpeechProviderOptions) { this.options=options; endpoint(options.baseUrl, '/chat/completions'); }
  async transcribe(file: AudioFile, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
    let normalized: Awaited<ReturnType<typeof normalizeSpeechAudio>> | undefined;
    try {
      combined.throwIfAborted();
      normalized = await normalizeSpeechAudio(file,this.options,combined);
      const bytes = await fs.readFile(normalized.file.path,{signal:combined});
      const response = await post(this.options,'/chat/completions',{
        model:this.options.model, messages:[{role:'user',content:[{type:'input_audio',
          input_audio:{data:`data:audio/wav;base64,${bytes.toString('base64')}`}}]}],
        asr_options:{language:this.options.language || 'auto'}, stream:false,
      },combined,'ASR');
      const result = json(await readBytes(response,this.options.maxResponseBytes ?? 1024*1024,'ASR_INVALID_RESPONSE'),'ASR_INVALID_RESPONSE');
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AudioError('ASR_EMPTY','ASR returned no transcription text');
      return {text:text.trim(),durationSeconds:normalized.original.durationSeconds};
    } catch (error) {
      if (signal?.aborted) throw new AudioError('ASR_CANCELLED','ASR transcription cancelled');
      if (timeout.aborted) throw new AudioError('ASR_TIMEOUT','ASR transcription timed out');
      throw error;
    } finally { await normalized?.cleanup(); }
  }
}

export class HttpTts implements TtsProvider {
  private options: SpeechProviderOptions;
  constructor(options: SpeechProviderOptions) { this.options=options; endpoint(options.baseUrl, options.provider === 'mimo' ? '/chat/completions' : '/audio/speech'); }
  async synthesize(text: string, request: SynthesisOptions = {}): Promise<SynthesizedAudio> {
    if (!text?.trim()) throw new AudioError('TTS_EMPTY','Speech text is empty');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
    const signal = request.signal ? AbortSignal.any([request.signal,timeout]) : timeout;
    const format = this.options.format ?? 'wav';
    const max = this.options.maxBytes ?? 25*1024*1024;
    const voice = request.voice || this.options.voice || (this.options.provider === 'mimo' ? 'mimo_default' : 'alloy');
    const instructions = request.instructions ?? this.options.instructions ?? '';
    let dir: string | undefined;
    try {
      signal.throwIfAborted();
      const design = this.options.provider === 'mimo' && this.options.model.includes('voicedesign');
      if (design && !instructions.trim()) throw new AudioError('TTS_CONFIG','MiMo voice design requires voice instructions');
      if (this.options.provider === 'mimo' && this.options.model.includes('voiceclone')) throw new AudioError('TTS_CONFIG','Voice cloning is not supported');
      const body = this.options.provider === 'openai' ? {
        model:this.options.model,input:text,voice,response_format:format,...(instructions ? {instructions} : {}),
      } : {
        model:this.options.model,messages:[...(instructions ? [{role:'user',content:instructions}] : []),{role:'assistant',content:text}],
        audio:{format,...(design ? {} : {voice})},stream:false,
      };
      const response = await post(this.options,this.options.provider === 'mimo' ? '/chat/completions' : '/audio/speech',body,signal,'TTS');
      let bytes = await readBytes(response,this.options.provider === 'mimo' ? Math.ceil(max*4/3)+65536 : max,'TTS_INVALID_RESPONSE');
      if (this.options.provider === 'mimo') {
        const data = json(bytes,'TTS_INVALID_RESPONSE')?.choices?.[0]?.message?.audio?.data;
        if (typeof data !== 'string' || !data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AudioError('TTS_INVALID_RESPONSE','TTS returned no valid base64 audio');
        bytes = Buffer.from(data,'base64');
      }
      if (!bytes.length || bytes.length > max) throw new AudioError('TTS_INVALID_RESPONSE','TTS audio is empty or exceeds the size limit');
      const parent = this.options.tempDir || tmpdir();
      await fs.mkdir(parent,{recursive:true});
      dir = await fs.mkdtemp(join(parent,'voce-tts-'));
      const file = join(dir,`speech.${format}`);
      await fs.writeFile(file,bytes,{mode:0o600,signal});
      const info = await probeAudio(file,this.options,signal);
      if (info.format !== format) throw new AudioError('TTS_INVALID_RESPONSE','TTS returned an unexpected audio container');
      return {bytes,name:`speech.${format}`,mime:info.mime,durationSeconds:info.durationSeconds};
    } catch (error) {
      if (request.signal?.aborted) throw new AudioError('TTS_CANCELLED','Speech synthesis cancelled');
      if (timeout.aborted) throw new AudioError('TTS_TIMEOUT','Speech synthesis timed out');
      throw error;
    } finally { if (dir) await fs.rm(dir,{recursive:true,force:true}); }
  }
}

export function createAsrProvider(options: SpeechProviderOptions): AsrProvider {
  return options.provider === 'mimo' ? new MiMoAsr(options) : new OpenAICompatibleAsr(options);
}
export function createTtsProvider(options: SpeechProviderOptions): TtsProvider { return new HttpTts(options); }

export function speechOptions(config: BridgeConfig, resolve: CredentialResolver, mode: 'asr' | 'tts'): SpeechProviderOptions {
  const provider = config[`${mode}Provider`] as 'openai' | 'mimo';
  const baseUrl = config[`${mode}BaseUrl`] || (provider === 'mimo' ? 'https://api.xiaomimimo.com/v1' : 'https://api.openai.com/v1');
  const ref = config[`${mode}ApiKeyRef`] || (provider === 'mimo' ? 'MIMO_API_KEY' : config[`${mode}BaseUrl`] ? '' : 'OPENAI_API_KEY');
  return {provider,baseUrl,model:config[`${mode}Model`],resolveApiKey:() => ref ? resolve(ref) : undefined,
    timeoutMs:config[`${mode}TimeoutMs`],maxBytes:config.maxMediaBytes,maxDurationSeconds:config.maxAudioSeconds,
    ffmpegPath:config.ffmpegPath,ffprobePath:config.ffprobePath,tempDir:config.tempDir,
    ...(mode === 'asr' ? {language:config.asrLanguage === 'auto' && provider === 'openai' ? undefined : config.asrLanguage || undefined,acceptedFormats:config.asrAcceptedFormats}
      : {voice:config.ttsVoice,instructions:config.ttsInstructions,format:config.ttsFormat as 'wav' | 'mp3'})};
}
