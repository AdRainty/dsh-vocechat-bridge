import type { BridgeConfig } from './config.ts';
import type { Batch, BufferScope, Job, StateStore } from './state.ts';
export declare function bufferKey(scope: BufferScope): string;
type Options = Pick<BridgeConfig, 'privateQuietMs' | 'groupQuietMs' | 'maxWaitMs' | 'maxBatch'>;
/** Pure deadline decisions over durable records; timers and I/O belong to Bridge. */
export declare class DebounceBuffer {
    private store;
    private options;
    constructor(store: StateStore, options: Options);
    enqueue(job: Job, scope: BufferScope): Batch;
    restorePending(scopeFor: (job: Job) => BufferScope): void;
    sealDue(now: number): Batch[];
    private seal;
    nextDeadline(): number | undefined;
    nextReady(matches: (batch: Batch) => boolean): Batch | undefined;
    jobs(batch: Batch): Job[];
}
export {};
