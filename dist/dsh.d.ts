import type { Destination, PreparedMessage, SessionPort, SessionRunOptions } from './types.ts';
/** Narrow structural views of the verified DSH 0.2.1-rc.3 capabilities. */
export interface HostAgent {
    id: string;
    session: {
        id: string;
        requestHeader?(): any;
    };
    ctx?: {
        get(name: string): any;
    };
    status?: string;
    whenIdle(): Promise<void>;
    followup(message: any): void;
}
export interface DshContext {
    agents: {
        get(id: string): HostAgent | undefined;
        resume(options: any): Promise<{
            agent: HostAgent;
            dispose(): any;
        }>;
        withInitiator<T>(agent: HostAgent, action: () => T): T;
    };
    on(name: string, listener: (...args: any[]) => void): () => void;
    get(name: string): any;
}
type MessageFactory = (input: {
    content: any[];
    source: any;
}) => any;
/** Uses the host's one driver; never steers or cancels a shared channel's turn. */
export declare class DshSessionPort implements SessionPort {
    readonly supportsSubmissionBarrier = true;
    private active?;
    private tail;
    private disposed;
    private lifetime;
    private promptDisposers;
    private ctx;
    private config;
    private dependencies;
    constructor(ctx: DshContext, config: {
        targetSessionId: string;
        agentPreset?: string;
        turnTimeoutMs?: number;
        maxAttachmentBytes?: number;
    }, dependencies: {
        createUserMessage: MessageFactory;
    });
    private resumeSettings;
    run(messages: PreparedMessage[], signal: AbortSignal, options?: SessionRunOptions): Promise<{
        text?: string;
        sent?: boolean;
        quiet?: boolean;
    }>;
    private ensureAgent;
    private mountContext;
    private content;
    private perform;
    /** Used only by tools with the host-provided execution agent. */
    outboundMode(agent: HostAgent | undefined, destination: Destination): {
        proactive: boolean;
    };
    noteSent(agent: HostAgent | undefined, destination: Destination): void;
    quiet(agent: HostAgent | undefined): void;
    dispose(): void;
}
export {};
