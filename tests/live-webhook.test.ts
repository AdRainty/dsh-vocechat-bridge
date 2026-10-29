import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function waitFor<T>(fn:()=>Promise<T>, accepts:(value:T)=>boolean, timeout=8000):Promise<T> {
  const until=Date.now()+timeout;
  while(Date.now()<until){try{const value=await fn();if(accepts(value))return value;}catch{}await sleep(20);}
  throw new Error('Live harness condition timed out');
}
async function start(dir:string,config:any) {
  const path=join(dir,'config.json');await writeFile(path,JSON.stringify(config));
  const child=spawn(process.execPath,[resolve('scripts/live-webhook.mjs'),path],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  let exited=false;const exit=new Promise<void>(r=>child.once('exit',()=>{exited=true;r();}));
  const stop=async()=>{if(!exited)child.kill('SIGTERM');await exit;};
  try{
    await waitFor(async()=>stdout,output=>output.includes('"listening":true'));
    const status=()=>readFile(join(dir,'status.json'),'utf8').then(JSON.parse);
    const initial=await status();const url=`http://127.0.0.1:${initial.bridge.address.port}/vocehook`;
    return {stop,status,url,stdout:()=>stdout,stderr:()=>stderr};
  }catch(error){await stop();throw error;}
}
const fixture=(mid:number,attachment=false)=>({mid,from_uid:10,created_at:123,target:{uid:4},detail:attachment
  ? {type:'normal',content_type:'vocechat/audio',content:'2026/10/29/live_test_audio',properties:{content_type:'audio/wav',name:'sample.wav'}}
  : {type:'normal',content_type:'text/plain',content:'LIVE_BODY_SHOULD_NOT_APPEAR_IN_AUDIT_LOG'}});
function wav(){const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;}

test('live harness authenticates, audits text without model/sending, and keeps media disabled by default',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'voce-live-'));
  const harness=await start(dir,{baseUrl:'http://127.0.0.1:1',botUid:4,botApiKey:'fixture-bot-key',webhookSecret:'fixture-secret',host:'127.0.0.1',port:0,outputDir:dir});
  t.after(async()=>{await harness.stop();await rm(dir,{recursive:true,force:true});});
  assert.equal((await fetch(harness.url)).status,200);
  assert.equal((await fetch(harness.url+'?secret=fixture-secret')).status,200);
  const post=(value:any)=>fetch(harness.url,{method:'POST',headers:{authorization:'Bearer fixture-secret','content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await fetch(harness.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture(1))})).status,401);
  assert.equal((await post(fixture(1))).status,202);
  assert.equal((await (await post(fixture(1))).json()).status,'duplicate');
  assert.equal((await (await post(fixture(2,true))).json()).status,'ignored');
  const state=await waitFor(harness.status,s=>s.bridge.counts.done===1);
  assert.equal(state.dshConnected,false);assert.equal(state.asrEnabled,false);assert.equal(state.mediaDownloadEnabled,false);assert.equal(state.prepared,1);
  assert.ok(state.httpRequests>=6);
  const audit=await readFile(join(dir,'events.jsonl'),'utf8');
  assert.equal(audit.includes('LIVE_BODY_SHOULD_NOT_APPEAR_IN_AUDIT_LOG'),false);
  assert.equal(audit.includes('fixture-bot-key'),false);assert.equal(audit.includes('fixture-secret'),false);assert.equal(harness.stdout().includes('fixture-secret'),false);assert.equal(harness.stderr(),'');
  const httpEvents=audit.trim().split('\n').map(JSON.parse).filter(e=>e.stage==='http');
  assert.ok(httpEvents.some(e=>e.method==='GET' && e.status===200 && !e.hasQuerySecret));
  assert.ok(httpEvents.some(e=>e.method==='POST' && e.status===401));
});

test('explicitly enabled live harness downloads through production client and reports actual audio info',async t=>{
  let downloads=0;
  const api=createServer((req,res)=>{
    if(!req.url?.startsWith('/api/resource/file?')){res.writeHead(500);res.end();return;}
    assert.equal(req.headers['x-api-key'],'fixture-bot-key');downloads++;
    res.writeHead(200,{'content-type':'audio/wav'});res.end(wav());
  });
  await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'voce-live-'));
  const harness=await start(dir,{baseUrl:`http://127.0.0.1:${(api.address() as any).port}`,botUid:4,botApiKey:'fixture-bot-key',webhookSecret:'fixture-secret',host:'127.0.0.1',port:0,outputDir:dir,allowMediaDownload:true});
  t.after(async()=>{await harness.stop();await new Promise<void>(r=>api.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const response=await fetch(harness.url,{method:'POST',headers:{authorization:'Bearer fixture-secret','content-type':'application/json'},body:JSON.stringify(fixture(1,true))});
  assert.equal(response.status,202);
  const state=await waitFor(harness.status,s=>s.bridge.counts.done===1);
  assert.equal(downloads,1);assert.equal(state.prepared,1);assert.equal(state.media[0].bytes,wav().length);
  assert.deepEqual(state.media[0].audio,{format:'wav',durationSeconds:0.1});assert.equal(state.dshConnected,false);assert.equal(state.asrEnabled,false);
});
