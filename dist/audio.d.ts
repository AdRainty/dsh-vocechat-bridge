export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'm4a' | 'flac' | 'webm';
export interface AudioFile {
    path: string;
    name?: string;
    mime?: string;
}
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
export interface TranscriptionResult {
    text: string;
    language?: string;
    durationSeconds?: number;
}
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
export interface SynthesizedAudio {
    bytes: Uint8Array;
    name: string;
    mime: string;
    durationSeconds: number;
}
export interface SynthesisOptions {
    voice?: string;
    instructions?: string;
    signal?: AbortSignal;
}
/** All vendors return the same validated audio shape; callers own delivery. */
export interface TtsProvider {
    synthesize(text: string, options?: SynthesisOptions): Promise<SynthesizedAudio>;
}
export declare class AudioError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Detect the container from bytes, never from an attachment's extension or MIME. */
export declare function detectAudioFormat(bytes: Uint8Array): AudioFormat;
export declare function probeAudio(file: AudioFile | string, input?: AudioLimits, signal?: AbortSignal): Promise<AudioInfo>;
/** MiMo accepts WAV/MP3; normalize every source to 16 kHz mono PCM without changing the original. */
export declare function normalizeSpeechAudio(file: AudioFile, input: AudioLimits, signal?: AbortSignal): Promise<{
    file: {
        path: string;
        name: string;
        mime: string;
    };
    original: AudioInfo;
    cleanup: () => Promise<void>;
}>;
export interface OpenAICompatibleAsrOptions extends AudioLimits {
    /** Administrator-configured API base, e.g. a local Whisper server's http://127.0.0.1:8000/v1. */
    baseUrl: string;
    model: string;
    resolveApiKey?: () => Promise<string | undefined> | string | undefined;
    language?: string;
    acceptedFormats?: AudioFormat[];
    maxResponseBytes?: number;
}
/** Multipart transcription protocol, compatible with self-hosted Whisper services. */
export declare class OpenAICompatibleAsr implements AsrProvider {
    private readonly endpoint;
    private readonly options;
    constructor(input: OpenAICompatibleAsrOptions);
    transcribe(file: AudioFile, signal?: AbortSignal): Promise<TranscriptionResult>;
}
