import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, type BufferScope, type Job } from '../src/state.ts';
import { DebounceBuffer, bufferKey } from '../src/debounce.ts';
import { parseConfig } from '../src/config.ts';

const scope=(overrides:Partial<BufferScope>={}):BufferScope=>({sourceKey:'server:bot',channel:'vocechat',sessionId:'session-a',destination:{kind:'user',id:10},senderId:10,...overrides});
function fixture(options={privateQuietMs:4000,groupQuietMs:1500,maxWaitMs:12000,maxBatch:100}) {
  const store=new StateStore('unused-test-state.json',86400000),buffer=new DebounceBuffer(store,options);
  const add=(id:string,at:number,s=scope())=>{
    const job:Job={message:{id,senderId:s.senderId,destination:s.destination,timestamp:at,text:id,attachments:[]},acceptedAt:at,status:'pending'};
    store.jobs.push(job);return {job,batch:buffer.enqueue(job,s)};
  };
  return {store,buffer,add};
}
async function durable(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'voce-debounce-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  return join(dir,'state.json');
}

test('default quiet periods are private 4s, group 1.5s and hard cap 12s; legacy override is explicit',()=>{
  const c=parseConfig();assert.equal(c.privateQuietMs,4000);assert.equal(c.groupQuietMs,1500);assert.equal(c.maxWaitMs,12000);assert.equal(c.mergeWindowMs,0);
  const legacy=parseConfig({mergeWindowMs:200});assert.equal(legacy.privateQuietMs,200);assert.equal(legacy.groupQuietMs,200);
  assert.equal(parseConfig({privateQuietMs:0,groupQuietMs:0}).privateQuietMs,0);
  for(const bad of [{privateQuietMs:-1},{groupQuietMs:1.5},{maxWaitMs:0},{privateQuietMs:3600001},{maxWaitMs:3600001}])assert.throws(()=>parseConfig(bad));
});
test('private quiet deadline resets on each new message without changing first arrival',()=>{
  const f=fixture();const first=f.add('1',1000).batch;
  assert.equal(first.dueAt,5000);
  assert.equal(f.add('2',4500).batch,first);assert.equal(first.firstAcceptedAt,1000);assert.equal(first.dueAt,8500);
  assert.equal(f.buffer.sealDue(8499).length,0);assert.equal(f.buffer.sealDue(8500).length,1);
  assert.equal(first.phase,'ready');assert.equal(first.reason,'quiet');assert.deepEqual(f.buffer.jobs(first).map(j=>j.message.id),['1','2']);
});
test('group quiet deadline uses 1.5 seconds and does not wait for private buffer',()=>{
  const f=fixture();const dm=f.add('dm',0).batch;
  const group=f.add('g',100,scope({destination:{kind:'group',id:20}})).batch;
  f.buffer.sealDue(1600);assert.equal(dm.phase,'buffering');assert.equal(group.phase,'ready');assert.equal(f.buffer.nextReady(()=>true),group);
});
test('continuous arrivals force a frozen batch at 12 seconds',()=>{
  const f=fixture();const first=f.add('1',0).batch;
  for(const [id,at] of [['2',3000],['3',6000],['4',9000],['5',11999]] as const)assert.equal(f.add(id,at).batch,first);
  assert.equal(first.dueAt,12000);assert.equal(f.buffer.sealDue(11999).length,0);
  f.buffer.sealDue(12000);assert.equal(first.reason,'max-wait');
  const next=f.add('6',12000).batch;assert.notEqual(next.id,first.id);
  assert.deepEqual(f.buffer.jobs(first).map(j=>j.message.id),['1','2','3','4','5']);
});
test('arrival exactly at an expired deadline starts a new batch',()=>{
  const f=fixture();const first=f.add('1',100).batch;
  const next=f.add('2',4100).batch;assert.notEqual(first.id,next.id);assert.equal(first.phase,'ready');assert.equal(first.sealedAt,4100);
});
test('channel, server, session, destination and sender are all independent scope components',()=>{
  const f=fixture();const base=scope({destination:{kind:'group',id:20}});
  const variants=[base,{...base,channel:'qq'},{...base,sourceKey:'other-server'}, {...base,sessionId:'session-b'},
    {...base,destination:{kind:'group' as const,id:21}},{...base,senderId:11},{...base,destination:{kind:'user' as const,id:20}}];
  variants.forEach((s,i)=>f.add(String(i),i,s));assert.equal(f.store.batches.length,variants.length);
  assert.equal(new Set(variants.map(bufferKey)).size,variants.length);
});
test('interleaved senders merge only into their own buffer and preserve original order',()=>{
  const f=fixture();const a=f.add('a1',100).batch;
  const b=f.add('b1',200,scope({senderId:11,destination:{kind:'user',id:11}})).batch;
  assert.equal(f.add('a2',300).batch,a);
  assert.deepEqual(f.buffer.jobs(a).map(j=>j.message.id),['a1','a2']);assert.deepEqual(f.buffer.jobs(b).map(j=>j.message.id),['b1']);
});
test('maxBatch is a deterministic optional capacity cap; later messages form a new batch',()=>{
  const f=fixture({privateQuietMs:4000,groupQuietMs:1500,maxWaitMs:12000,maxBatch:2});
  const first=f.add('1',0).batch;f.add('2',1);assert.equal(first.phase,'ready');assert.equal(first.reason,'max-batch');
  assert.notEqual(f.add('3',2).batch.id,first.id);
});
test('ready queue follows sealing deadlines rather than blocking behind the first sender',()=>{
  const f=fixture();const a=f.add('private',0).batch;
  const b=f.add('group',200,scope({destination:{kind:'group',id:20}})).batch;
  f.buffer.sealDue(5000);assert.equal(f.buffer.nextReady(()=>true),b);b.phase='done';assert.equal(f.buffer.nextReady(()=>true),a);
});
test('buffer first/last/deadline and attachments survive a durable restart',async t=>{
  const path=await durable(t),store=new StateStore(path,86400000),buffer=new DebounceBuffer(store,parseConfig());
  const at=Date.now(),job:Job={message:{id:'media',senderId:10,destination:{kind:'user',id:10},timestamp:at,text:'caption',attachments:[{kind:'audio',path:'2026/10/29/audio',mime:'audio/mp4',name:'voice.m4a'}]},acceptedAt:at,status:'pending',preparedAudio:{0:{transcript:'真实转写'}}};
  store.jobs.push(job);const batch=buffer.enqueue(job,scope());await store.save();
  const restored=new StateStore(path,86400000);await restored.load();
  assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);
  assert.equal(restored.batches[0].id,batch.id);assert.equal(restored.batches[0].firstAcceptedAt,at);assert.equal(restored.batches[0].dueAt,at+4000);
  assert.deepEqual(restored.jobs[0].message,job.message);assert.deepEqual(restored.jobs[0].preparedAudio,job.preparedAudio);
});
test('crash during preparation restores an already sealed batch without losing ASR cache',async t=>{
  const path=await durable(t),store=new StateStore(path,86400000),buffer=new DebounceBuffer(store,parseConfig());
  const job:Job={message:{id:'1',senderId:10,destination:{kind:'user',id:10},timestamp:1,text:'',attachments:[]},acceptedAt:Date.now(),status:'pending',preparedAudio:{0:{transcript:'已保存'}}};
  store.jobs.push(job);const batch=buffer.enqueue(job,scope());batch.phase='preparing';await store.save();
  const restored=new StateStore(path,86400000);await restored.load();assert.equal(restored.batches[0].phase,'ready');assert.equal(restored.jobs[0].status,'pending');assert.equal(restored.jobs[0].preparedAudio?.[0].transcript,'已保存');
});
test('crash after dispatch quarantines the batch instead of causing a second reply',async t=>{
  const path=await durable(t),store=new StateStore(path,86400000),buffer=new DebounceBuffer(store,parseConfig());
  const job:Job={message:{id:'1',senderId:10,destination:{kind:'user',id:10},timestamp:1,text:'x',attachments:[]},acceptedAt:Date.now(),status:'pending'};
  store.jobs.push(job);const batch=buffer.enqueue(job,scope());batch.phase='dispatching';job.status='processing';await store.save();
  const restored=new StateStore(path,86400000);await restored.load();assert.equal(restored.batches[0].phase,'uncertain');assert.equal(restored.jobs[0].status,'uncertain');
  assert.equal(new DebounceBuffer(restored,parseConfig()).nextReady(()=>true),undefined);
});
test('version 1 state upgrades without silently replaying an in-flight turn',async t=>{
  const path=await durable(t);const message={id:'legacy',senderId:10,destination:{kind:'user',id:10},timestamp:1,text:'x',attachments:[]};
  await writeFile(path,JSON.stringify({version:1,jobs:[{message,acceptedAt:Date.now(),status:'processing'}]}));
  const store=new StateStore(path,86400000);await store.load();assert.equal(store.jobs[0].status,'uncertain');assert.ok(store.jobs[0].id);assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);
});

test('history retention uses completion time for messages buffered longer than the TTL',async t=>{
  const path=await durable(t),store=new StateStore(path,1000);
  store.jobs.push({id:'job',message:{id:'old',senderId:10,destination:{kind:'user',id:10},timestamp:1,text:'x',attachments:[]},acceptedAt:Date.now()-86400000,status:'done',finishedAt:Date.now()});
  await store.save();const restored=new StateStore(path,1000);await restored.load();assert.equal(restored.jobs.length,1);assert.equal(restored.jobs[0].message.id,'old');
});
