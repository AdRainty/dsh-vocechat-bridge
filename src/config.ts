import { homedir } from 'node:os';
import { expandHomePath } from './files.ts';
import { join, resolve } from 'node:path';
import type { AudioFormat } from './audio.ts';

export const defaults = {
  enabled: false, baseUrl: '', botApiKeyRef: 'VOCECHAT_BOT_API_KEY', botUid: 0,
  webhookHost: '127.0.0.1', webhookPort: 8898, webhookPath: '/vocehook', webhookSecretRef: '',
  userWhitelist: [] as number[], groupWhitelist: [] as number[], groupSenderWhitelist: [] as number[],
  targetSessionId: '', agentPreset: '', autoReply: true, allowProactive: false,
  statePath: '', tempDir: '', allowedLocalRoots: [] as string[], allowedRemoteOrigins: [] as string[],
  requestTimeoutMs: 30_000, turnTimeoutMs: 180_000, maxMediaBytes: 25 * 1024 * 1024,
  maxAudioSeconds: 300, maxBodyBytes: 256 * 1024, maxQueue: 200, maxTextChars: 16000,
  textSegmentChars: 2000, privateQuietMs: 4000, groupQuietMs: 1500, maxWaitMs: 12000,
  mergeWindowMs: 0, maxBatch: 10, dedupTtlMs: 24 * 3600_000,
  historyContextMessages: 6, historyMaxChars: 12000, historyTimeoutMs: 5000,
  retentionMs: 24 * 3600_000, maxHistory: 5000, logLevel: 'info',
  voiceEnabled: true, asrEnabled: false, asrProvider: 'openai', asrBaseUrl: '', asrModel: '', asrApiKeyRef: '', asrLanguage: '',
  asrAcceptedFormats: ['wav','mp3','ogg','m4a','flac','webm'] as AudioFormat[],
  asrTimeoutMs: 60_000, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
  ttsEnabled: false, ttsProvider: 'openai', ttsBaseUrl: '', ttsModel: '', ttsApiKeyRef: '',
  ttsVoice: '', ttsInstructions: '', ttsFormat: 'wav', ttsTimeoutMs: 120_000,
  audioUnderstandingProvider: '',
};
export type BridgeConfig = typeof defaults;
/** Only speech settings are live-editable; transport/session configuration keeps its existing lifecycle. */
export const speechFields = ['voiceEnabled','asrEnabled','asrProvider','asrBaseUrl','asrModel','asrApiKeyRef','asrLanguage',
  'asrAcceptedFormats','asrTimeoutMs','ttsEnabled','ttsProvider','ttsBaseUrl','ttsModel','ttsApiKeyRef','ttsVoice',
  'ttsInstructions','ttsFormat','ttsTimeoutMs'] as const;
export function readConfig(input: Record<string, any>): Partial<BridgeConfig> {
  return Object.fromEntries(Object.entries(input).map(([key,value]) => [key,
    speechFields.includes(key as typeof speechFields[number]) && typeof value?.get === 'function' ? value.get() : value]));
}
export function parseConfig(input: Partial<BridgeConfig> = {}): BridgeConfig {
  const c = { ...defaults, ...input };
  for (const key of ['enabled','autoReply','allowProactive','voiceEnabled','asrEnabled','ttsEnabled'] as const) {
    if (typeof c[key] !== 'boolean') throw new Error(`Invalid config: ${key}`);
  }
  for (const key of ['userWhitelist','groupWhitelist','groupSenderWhitelist'] as const) {
    if (!Array.isArray(c[key]) || c[key].some(x => !Number.isSafeInteger(x) || x <= 0)) throw new Error(`Invalid config: ${key}`);
    c[key] = [...new Set(c[key])];
  }
  for (const key of ['allowedLocalRoots','allowedRemoteOrigins'] as const) {
    if (!Array.isArray(c[key]) || c[key].some(x => typeof x !== 'string' || !x.trim())) throw new Error(`Invalid config: ${key}`);
  }
  if (!Array.isArray(c.asrAcceptedFormats) || !c.asrAcceptedFormats.length || c.asrAcceptedFormats.some(format => !['wav','mp3','ogg','m4a','flac','webm'].includes(format))) throw new Error('Invalid config: asrAcceptedFormats');
  c.asrAcceptedFormats = [...new Set(c.asrAcceptedFormats)];
  for (const key of Object.keys(defaults) as (keyof BridgeConfig)[]) {
    if (typeof defaults[key] === 'string' && typeof c[key] !== 'string') throw new Error(`Invalid config: ${key}`);
    if (typeof defaults[key] === 'number' && (!Number.isSafeInteger(c[key]) || (c[key] as number) < 0)) throw new Error(`Invalid config: ${key}`);
  }
  for (const key of ['requestTimeoutMs','turnTimeoutMs','maxMediaBytes','maxAudioSeconds','maxBodyBytes','maxQueue','maxTextChars','textSegmentChars','maxBatch','maxHistory','dedupTtlMs','retentionMs','asrTimeoutMs','ttsTimeoutMs','maxWaitMs'] as const) {
    if (c[key] < 1) throw new Error(`Invalid config: ${key}`);
  }
  if (c.webhookPort > 65535 || !/^\/[\w/-]+$/.test(c.webhookPath) || c.mergeWindowMs > 60_000 || c.maxBatch > 100 || !['debug','info','warn','error'].includes(c.logLevel)) throw new Error('Invalid webhook/batch/log config');
  if (c.privateQuietMs > 3600_000 || c.groupQuietMs > 3600_000 || c.maxWaitMs > 3600_000) throw new Error('Invalid debounce limits');
  if (c.historyContextMessages > 50 || c.historyMaxChars < 2000 || c.historyMaxChars > 128000 || c.historyTimeoutMs < 1 || c.historyTimeoutMs > 60000) throw new Error('Invalid history limits');
  if(c.asrTimeoutMs>0xffffffff || c.ttsTimeoutMs>0xffffffff)throw new Error('Invalid speech timeout');
  // Nonzero legacy values explicitly override both quiet periods. Zero disables
  // this compatibility alias; new configurations use the fields above.
  if (c.mergeWindowMs) c.privateQuietMs = c.groupQuietMs = c.mergeWindowMs;
  // Empty values follow the selected vendor, rather than retaining another vendor's model/endpoint.
  c.ttsProvider ||= 'openai'; // v0.2 used an empty reserved field.
  if (!['openai','mimo'].includes(c.asrProvider) || !['openai','mimo'].includes(c.ttsProvider)) throw new Error('Unsupported speech provider');
  c.asrModel ||= c.asrProvider === 'mimo' ? 'mimo-v2.5-asr' : 'whisper-1';
  c.ttsModel ||= c.ttsProvider === 'mimo' ? 'mimo-v2.5-tts' : 'gpt-4o-mini-tts';
  c.ttsVoice ||= c.ttsProvider === 'mimo' ? 'mimo_default' : 'alloy';
  if (!['wav','mp3'].includes(c.ttsFormat)) throw new Error('Invalid config: ttsFormat');
  if (c.voiceEnabled && c.asrEnabled && c.asrProvider === 'mimo' && !['','auto','zh','en'].includes(c.asrLanguage)) throw new Error('MiMo ASR language must be auto, zh or en');
  if (c.voiceEnabled && c.ttsEnabled && c.ttsProvider === 'mimo') {
    if (c.ttsModel.includes('voiceclone')) throw new Error('MiMo voice cloning is not supported');
    if (c.ttsModel.includes('voicedesign') && !c.ttsInstructions.trim()) throw new Error('MiMo voice design requires ttsInstructions');
  }
  for (const key of ['baseUrl','asrBaseUrl','ttsBaseUrl'] as const) {
    if (!c[key]) continue;
    const u = new URL(c[key]);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(`Invalid config: ${key}`);
    c[key] = u.href.replace(/\/$/, '');
  }
  c.allowedRemoteOrigins = c.allowedRemoteOrigins.map(x => {
    const u = new URL(x);
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Invalid remote origin');
    return u.origin;
  });
  c.allowedLocalRoots = c.allowedLocalRoots.map(x => resolve(expandHomePath(x)));
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  c.statePath = resolve(c.statePath || join(home, 'vocechat-bridge', 'state.json'));
  c.tempDir = resolve(c.tempDir || join(home, 'vocechat-bridge', 'tmp'));
  if (c.enabled && (!c.baseUrl || !c.targetSessionId || !c.botUid || !c.botApiKeyRef)) throw new Error('Enabled bridge requires baseUrl, targetSessionId, botUid and Bot credential reference');
  if (c.audioUnderstandingProvider) throw new Error('Audio understanding providers must be registered programmatically');
  return c;
}
export function allowedDestination(c: BridgeConfig, d: {kind: string; id: number}): boolean {
  return Number.isSafeInteger(d.id) && d.id > 0 && (d.kind === 'user' ? c.userWhitelist.includes(d.id) : d.kind === 'group' && c.groupWhitelist.includes(d.id));
}
