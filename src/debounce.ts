import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from './config.ts';
import type { Batch, BufferScope, Job, StateStore } from './state.ts';

export function bufferKey(scope: BufferScope): string {
  return JSON.stringify([scope.sourceKey,scope.channel,scope.sessionId,scope.destination.kind,scope.destination.id,scope.senderId]);
}
type Options = Pick<BridgeConfig,'privateQuietMs'|'groupQuietMs'|'maxWaitMs'|'maxBatch'>;

/** Pure deadline decisions over durable records; timers and I/O belong to Bridge. */
export class DebounceBuffer {
  private store: StateStore;
  private options: Options;
  constructor(store: StateStore, options: Options) { this.store=store;this.options=options; }
  enqueue(job: Job, scope: BufferScope): Batch {
    this.sealDue(job.acceptedAt);
    const key=bufferKey(scope);
    let batch=this.store.batches.find(b=>b.phase==='buffering' && b.key===key);
    if(!batch) {
      const quietMs=scope.destination.kind==='user'?this.options.privateQuietMs:this.options.groupQuietMs;
      batch={id:randomUUID(),key,scope:structuredClone(scope),jobIds:[],firstAcceptedAt:job.acceptedAt,lastAcceptedAt:job.acceptedAt,
        quietMs,maxWaitMs:this.options.maxWaitMs,dueAt:Math.min(job.acceptedAt+quietMs,job.acceptedAt+this.options.maxWaitMs),phase:'buffering'};
      this.store.batches.push(batch);
    }
    job.id ||= randomUUID();job.batchId=batch.id;job.sourceKey=scope.sourceKey;job.channel=scope.channel;job.sessionId=scope.sessionId;
    batch.jobIds.push(job.id);
    batch.lastAcceptedAt=Math.max(batch.lastAcceptedAt,job.acceptedAt);
    batch.dueAt=Math.min(batch.lastAcceptedAt+batch.quietMs,batch.firstAcceptedAt+batch.maxWaitMs);
    if(batch.jobIds.length>=this.options.maxBatch)this.seal(batch,job.acceptedAt,'max-batch');
    return batch;
  }
  restorePending(scopeFor: (job:Job)=>BufferScope) {
    for(const job of this.store.jobs.filter(j=>j.status==='pending'&&!j.batchId).sort((a,b)=>a.acceptedAt-b.acceptedAt))this.enqueue(job,scopeFor(job));
  }
  sealDue(now: number): Batch[] {
    const sealed:Batch[]=[];
    for(const batch of this.store.batches) {
      if(batch.phase!=='buffering' || batch.dueAt>now)continue;
      const reason=batch.firstAcceptedAt+batch.maxWaitMs<=batch.lastAcceptedAt+batch.quietMs?'max-wait':'quiet';
      this.seal(batch,batch.dueAt,reason);sealed.push(batch);
    }
    return sealed;
  }
  private seal(batch:Batch,at:number,reason:Batch['reason']) {batch.phase='ready';batch.sealedAt=at;batch.reason=reason;}
  nextDeadline():number|undefined {
    const deadlines=this.store.batches.filter(b=>b.phase==='buffering').map(b=>b.dueAt);
    return deadlines.length?Math.min(...deadlines):undefined;
  }
  nextReady(matches:(batch:Batch)=>boolean):Batch|undefined {
    return this.store.batches.filter(b=>b.phase==='ready'&&matches(b))
      .sort((a,b)=>(a.sealedAt??a.dueAt)-(b.sealedAt??b.dueAt)||a.firstAcceptedAt-b.firstAcceptedAt)[0];
  }
  jobs(batch:Batch):Job[] {
    const byId=new Map(this.store.jobs.map(j=>[j.id,j]));
    return batch.jobIds.map(id=>{const job=byId.get(id);if(!job)throw new Error('BATCH_JOB_MISSING');return job;});
  }
}
