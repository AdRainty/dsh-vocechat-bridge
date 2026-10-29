import type { BridgeConfig } from './config.ts';
import type { Bridge } from './bridge.ts';
import type { DshSessionPort, HostAgent } from './dsh.ts';
import type { Destination, OutboundMessage } from './types.ts';
/** Credential providers and an old listener can become ready after the plugin mounts. */
export declare class AutoStartController {
    private timer?;
    private pending?;
    private disposed;
    private lastError?;
    private delay;
    private options;
    constructor(options: AutoStartController['options']);
    wake(): Promise<void>;
    private attempt;
    private shouldStart;
    private report;
    dispose(): Promise<void>;
}
/** The host UI/API stays mounted while the listener is stopped or recreated. */
export declare class BridgeRuntime {
    private active?;
    private tail;
    private phase;
    private error?;
    private disposed;
    private read;
    private factory;
    constructor(read: () => BridgeConfig, factory: (config: BridgeConfig) => {
        bridge: Bridge;
        session: DshSessionPort;
    });
    private enqueue;
    private close;
    private open;
    start(): Promise<void>;
    stop(): Promise<void>;
    reload(): Promise<void>;
    dispose(): Promise<void>;
    status(): {
        enabled: boolean;
        running: boolean;
        phase: string;
        error: string | undefined;
        sessionId: string;
        needsReload: boolean;
        webhook: {
            host: string;
            port: number;
            path: string;
        };
        address?: string | import("net").AddressInfo | null | undefined;
        failure?: string | undefined;
        speech?: {
            enabled: boolean;
            asrEnabled: boolean;
            asrProvider: string;
            asrModel: string;
            ttsEnabled: boolean;
            ttsProvider: string;
            ttsModel: string;
        } | undefined;
        ingress?: {
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
        } | undefined;
        history?: {
            contextMessages: number;
            maxChars: number;
            lastError: string | undefined;
        } | undefined;
        counts?: {
            [k: string]: number;
        } | undefined;
        batchCounts?: {
            [k: string]: number;
        } | undefined;
        blockedBatches?: number | undefined;
        nextFlushAt?: number | undefined;
        debounce?: {
            privateQuietMs: number;
            groupQuietMs: number;
            maxWaitMs: number;
        } | undefined;
    };
    send(destination: Destination, message: OutboundMessage, options?: Parameters<Bridge['send']>[2]): Promise<unknown[]>;
    getHistory(destination: Destination, limit?: number, options?: Parameters<Bridge['getHistory']>[2]): Promise<import("./types.ts").ConversationHistory>;
    readonly session: {
        assertToolSession: (agent: HostAgent | undefined) => void;
        outboundMode: (agent: HostAgent | undefined, destination: Destination) => {
            proactive: boolean;
        };
        noteSent: (agent: HostAgent | undefined, destination: Destination) => void | undefined;
        quiet: (agent: HostAgent | undefined) => void;
    };
}
