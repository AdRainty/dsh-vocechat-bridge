import { type BridgeConfig } from './config.ts';
import { StateStore } from './state.ts';
import { VoceChatClient } from './vocechat.ts';
import type { Destination, OutboundMessage, SessionPort, CredentialResolver, Logger } from './types.ts';
export declare class Bridge {
    readonly config: BridgeConfig;
    readonly store: StateStore;
    readonly client: VoceChatClient;
    private server?;
    private controller;
    private worker?;
    private running;
    private log;
    private outbound;
    private cleanupTimer?;
    private activeTempDirs;
    private failure?;
    private ports;
    constructor(config: Partial<BridgeConfig>, ports: {
        session: SessionPort;
        resolveCredential: CredentialResolver;
        logger?: Logger;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): {
        enabled: boolean;
        running: boolean;
        address: string | import("net").AddressInfo | null | undefined;
        failure: string | undefined;
        sessionId: string;
        counts: {
            [k: string]: number;
        };
    };
    private handleHttp;
    accept(value: unknown): Promise<'accepted' | 'duplicate' | 'ignored' | 'full'>;
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
