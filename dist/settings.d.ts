import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeConfig } from './config.ts';
import type { CredentialResolver } from './types.ts';
export declare const settingsPath = "/api/vocechat-bridge/settings";
export declare const connectionFields: readonly ["enabled", "baseUrl", "botUid", "botApiKeyRef", "webhookSecretRef", "webhookHost", "webhookPort", "webhookPath", "userWhitelist", "groupWhitelist", "groupSenderWhitelist", "targetSessionId", "agentPreset", "autoReply", "allowProactive", "privateQuietMs", "groupQuietMs", "maxWaitMs", "maxBatch", "allowedLocalRoots", "allowedRemoteOrigins"];
export declare const editableFields: readonly ["enabled", "baseUrl", "botUid", "botApiKeyRef", "webhookSecretRef", "webhookHost", "webhookPort", "webhookPath", "userWhitelist", "groupWhitelist", "groupSenderWhitelist", "targetSessionId", "agentPreset", "autoReply", "allowProactive", "privateQuietMs", "groupQuietMs", "maxWaitMs", "maxBatch", "allowedLocalRoots", "allowedRemoteOrigins", "voiceEnabled", "asrEnabled", "asrProvider", "asrBaseUrl", "asrModel", "asrApiKeyRef", "asrLanguage", "asrAcceptedFormats", "asrTimeoutMs", "ttsEnabled", "ttsProvider", "ttsBaseUrl", "ttsModel", "ttsApiKeyRef", "ttsVoice", "ttsInstructions", "ttsFormat", "ttsTimeoutMs", "ffmpegPath", "ffprobePath", "maxAudioSeconds", "maxMediaBytes"];
/** Plugin-owned overrides avoid the root-Include write failure of some desktop profiles. */
export declare class PluginSettings {
    private overrides;
    readonly filename: string;
    private base;
    constructor(filename: string, base: () => Partial<BridgeConfig>);
    load(): Promise<void>;
    raw(): BridgeConfig;
    config(): BridgeConfig;
    values(): {
        [k: string]: string | number | boolean | string[] | import("./audio.ts").AudioFormat[] | number[];
    };
    revision(): string;
    validate(patch: unknown): Partial<BridgeConfig>;
    update(patch: Partial<BridgeConfig>): Promise<void>;
}
export declare function createSettingsHandler(options: {
    settings: PluginSettings;
    ready: Promise<unknown>;
    resolveCredential: CredentialResolver;
    credentials: () => any;
    runtime: {
        status(): unknown;
        start(): Promise<void>;
        stop(): Promise<void>;
        reload(): Promise<void>;
    };
}): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
