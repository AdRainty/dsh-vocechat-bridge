import type { Destination, IncomingMessage } from './types.ts';
export type Job = {
    id?: string;
    message: IncomingMessage;
    acceptedAt: number;
    status: 'pending' | 'processing' | 'done' | 'failed' | 'uncertain';
    code?: string;
    finishedAt?: number;
    sourceKey?: string;
    channel?: string;
    sessionId?: string;
    batchId?: string;
    preparedAudio?: Record<number, {
        transcript?: string;
        error?: string;
    }>;
};
export type BufferScope = {
    sourceKey: string;
    channel: string;
    sessionId: string;
    destination: Destination;
    senderId: number;
};
export type BatchPhase = 'buffering' | 'ready' | 'preparing' | 'dispatching' | 'done' | 'failed' | 'uncertain';
export type Batch = {
    id: string;
    key: string;
    scope: BufferScope;
    jobIds: string[];
    firstAcceptedAt: number;
    lastAcceptedAt: number;
    quietMs: number;
    maxWaitMs: number;
    dueAt: number;
    phase: BatchPhase;
    sealedAt?: number;
    reason?: 'quiet' | 'max-wait' | 'max-batch';
    code?: string;
};
export declare const batchPhases: BatchPhase[];
export declare class StateStore {
    jobs: Job[];
    batches: Batch[];
    private lock;
    readonly path: string;
    readonly retentionMs: number;
    readonly maxHistory: number;
    constructor(path: string, retentionMs: number, maxHistory?: number);
    load(): Promise<void>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    save(): Promise<void>;
}
