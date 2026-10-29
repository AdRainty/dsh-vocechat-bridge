import { type BridgeConfig } from './config.ts';
import { StateStore } from './state.ts';
import { VoceChatClient } from './vocechat.ts';
import type { ConversationHistory, Destination, OutboundMessage, SessionPort, CredentialResolver, Logger } from './types.ts';
export declare class Bridge {
    readonly config: BridgeConfig;
    readonly store: StateStore;
    readonly client: VoceChatClient;
    private buffer;
    private server?;
    private controller;
    private worker?;
    private debounceTimer?;
    private sealing?;
    private running;
    private log;
    private outbound;
    private cleanupTimer?;
    private activeTempDirs;
    private failure?;
    private historyError?;
    private ingress;
    private ports;
    constructor(config: Partial<BridgeConfig>, ports: {
        session: SessionPort;
        resolveCredential: CredentialResolver;
        logger?: Logger;
        speechConfig?: () => Partial<BridgeConfig>;
    });
    private speechConfig;
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): {
        enabled: boolean;
        running: boolean;
        address: string | import("net").AddressInfo | null | undefined;
        failure: string | undefined;
        speech: {
            enabled: boolean;
            asrEnabled: boolean;
            asrProvider: string;
            asrModel: string;
            ttsEnabled: boolean;
            ttsProvider: string;
            ttsModel: string;
        };
        ingress: {
            posts: number;
            lastPostAt: number | undefined;
            lastHttpStatus: number | undefined;
            recent: {
                at: number;
                messageId?: number;
                senderId?: number;
                target?: Destination;
                status: string;
                reason?: string;
            }[];
        };
        history: {
            contextMessages: number;
            maxChars: number;
            lastError: string | undefined;
        };
        sessionId: string;
        counts: {
            [k: string]: number;
        };
        batchCounts: {
            [k: string]: number;
        };
        blockedBatches: number;
        nextFlushAt: number | undefined;
        debounce: {
            privateQuietMs: number;
            groupQuietMs: number;
            maxWaitMs: number;
        };
    };
    private handleHttp;
    accept(value: unknown): Promise<'accepted' | 'duplicate' | 'ignored' | 'full'>;
    private recordIngress;
    private acceptMessage;
    getHistory(destination: Destination, limit?: number, options?: {
        signal?: AbortSignal;
        beforeId?: number;
    }): Promise<ConversationHistory>;
    private contextHistory;
    private sourceKey;
    private scopeFor;
    private canDispatch;
    private schedule;
    private kick;
    private drain;
    private prepare;
    send(destination: Destination, message: OutboundMessage, options?: {
        proactive?: boolean;
        replyTo?: number;
        signal?: AbortSignal;
    }): Promise<unknown[]>;
    private cleanup;
}
