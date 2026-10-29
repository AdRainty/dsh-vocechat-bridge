import type { AsrProvider, AudioFile, OpenAICompatibleAsrOptions, SynthesisOptions, SynthesizedAudio, TtsProvider } from './audio.ts';
import type { BridgeConfig } from './config.ts';
import type { CredentialResolver } from './types.ts';
export interface SpeechProviderOptions extends OpenAICompatibleAsrOptions {
    provider: 'openai' | 'mimo';
    voice?: string;
    instructions?: string;
    format?: 'wav' | 'mp3';
}
export declare class MiMoAsr implements AsrProvider {
    private options;
    constructor(options: SpeechProviderOptions);
    transcribe(file: AudioFile, signal?: AbortSignal): Promise<{
        text: string;
        durationSeconds: number;
    }>;
}
export declare class HttpTts implements TtsProvider {
    private options;
    constructor(options: SpeechProviderOptions);
    synthesize(text: string, request?: SynthesisOptions): Promise<SynthesizedAudio>;
}
export declare function createAsrProvider(options: SpeechProviderOptions): AsrProvider;
export declare function createTtsProvider(options: SpeechProviderOptions): TtsProvider;
export declare function speechOptions(config: BridgeConfig, resolve: CredentialResolver, mode: 'asr' | 'tts'): SpeechProviderOptions;
