import type { IncomingMessage } from './types.ts';
export type Job = {
    message: IncomingMessage;
    acceptedAt: number;
    status: 'pending' | 'processing' | 'done' | 'failed' | 'uncertain';
    code?: string;
};
export declare class StateStore {
    jobs: Job[];
    private lock;
    readonly path: string;
    readonly retentionMs: number;
    readonly maxHistory: number;
    constructor(path: string, retentionMs: number, maxHistory?: number);
    load(): Promise<void>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    save(): Promise<void>;
}
