import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { parseConfig, allowedDestination } from '../src/config.ts';
import { normalizeWebhook } from '../src/inbound.ts';
import { StateStore } from '../src/state.ts';
import type { BridgeConfig } from '../src/config.ts';
import type { PreparedMessage, SessionPort } from '../src/types.ts';

const event=(mid:number,uid=10,gid?:number,content='hello')=>({mid,from_uid:uid,created_at:123,target:gid?{gid}:{uid:2},detail:{type:'normal',content_type:'text/plain',content}});
const wav=()=>{const b=Buffer.alloc(44+3200);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;};
async function waitFor(fn:()=>boolean) {for(let i=0;i<200;i++){if(fn())return;await sleep(10);}throw new Error('condition timed out');}
async function setup(t:any, overrides:Partial<BridgeConfig>={}, run?:SessionPort['run']) {
  const dir=await mkdtemp(join(tmpdir(),'voce-core-'));
  const sent:{url:string;text:string;type:string}[]=[];
  const calls:PreparedMessage[][]=[];
  let asrFail=false;
  let holdSends=false;
  const api=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    if(req.url?.startsWith('/api/resource/file')){const image=req.url.includes('test_image'),file=req.url.includes('test_file');res.writeHead(200,{'content-type':image?'image/png':file?'application/pdf':'audio/wav'});res.end(image?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64'):file?Buffer.from('%PDF-1.4 test'):wav());return;}
    if(req.url==='/v1/audio/transcriptions'){if(asrFail){res.writeHead(503);res.end('private-provider-data');return;}res.writeHead(200,{'content-type':'application/json'});res.end('{"text":"听到的内容"}');return;}
    if(req.url==='/api/bot/file/prepare'){res.writeHead(200,{'content-type':'application/json'});res.end('"upload-1"');return;}
    if(req.url==='/api/bot/file/upload'){
      const start=body.indexOf('\r\n\r\n',body.indexOf('name="chunk_data"'))+4;const end=body.indexOf('\r\n--',start);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({path:'2026/10/29/uploaded',size:end-start}));return;
    }
    sent.push({url:req.url||'',text:body.toString(),type:String(req.headers['content-type'])});
    if(holdSends)return;
    res.writeHead(200,{'content-type':'application/json'});res.end('123');
  });
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(api.address() as any).port}`;
  const config:Partial<BridgeConfig>={enabled:true,baseUrl:base,botUid:2,targetSessionId:'session-test',userWhitelist:[10,11],groupWhitelist:[20],webhookPort:0,mergeWindowMs:10,statePath:join(dir,'state.json'),tempDir:join(dir,'tmp'),...overrides};
  const bridge=new Bridge(config,{session:{async run(m,s){calls.push(m);return run?run(m,s):{text:'reply'};}},resolveCredential:async()=> 'test-secret'});
  await bridge.start();
  t.after(async()=>{await bridge.stop();await new Promise<void>(r=>api.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${(bridge.status().address as any).port}/vocehook`;
  return {bridge,calls,sent,url,dir,base,failAsr:()=>{asrFail=true;},holdSends:()=>{holdSends=true;}};
}

test('configuration fails closed and rejects malformed values',()=>{
  const c=parseConfig();assert.equal(c.enabled,false);assert.equal(allowedDestination(c,{kind:'user',id:1}),false);
  for(const bad of [{enabled:true},{maxAudioSeconds:0},{maxQueue:-1},{webhookPath:'/'},{userWhitelist:['10']},{baseUrl:'https://key:secret@example.com'},{allowedRemoteOrigins:['https://example.com/path']},{asrEnabled:true},{asrAcceptedFormats:[]},{asrAcceptedFormats:['exe']},{logLevel:'verbose'}])assert.throws(()=>parseConfig(bad as any));
});
test('normalize official direct/group payload, media and invalid event',()=>{
  assert.deepEqual(normalizeWebhook(event(1))?.destination,{kind:'user',id:10});
  assert.deepEqual(normalizeWebhook(event(2,10,20))?.destination,{kind:'group',id:20});
  assert.throws(()=>normalizeWebhook({...event(1),target:{gid:20,uid:2}}));
  const p=event(3) as any;p.detail={type:'normal',content_type:'vocechat/file',content:'a/b.png',properties:{content_type:'image/png',name:'x.png',size:5}};
  assert.equal(normalizeWebhook(p)?.attachments[0].kind,'image');
  assert.equal(normalizeWebhook({...p,detail:{...p.detail,type:'edit'}}),undefined);
});
test('HTTP webhook public GET validation, authenticated POST and durable ACK',async t=>{
  const {bridge,url,calls}=await setup(t);
  assert.equal((await fetch(url)).status,200);
  assert.equal((await fetch(url+'?secret=wrong-secret')).status,200);
  assert.equal((await fetch(url+'?secret=test-secret')).status,200);
  assert.equal((await fetch(url+'/wrong?secret=test-secret')).status,404);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event(1))})).status,401);
  assert.equal((await fetch(url+'?secret=wrong-secret',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event(1))})).status,401);
  assert.equal(bridge.store.jobs.length,0);
  const headers={authorization:'Bearer test-secret','content-type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers,body:'{'})).status,400);
  const result=await fetch(url,{method:'POST',headers,body:JSON.stringify(event(1))});assert.equal(result.status,202);
  assert.equal(bridge.store.jobs[0].message.id,'1');
  await waitFor(()=>bridge.status().counts.done===1);assert.equal(calls.length,1);
});
test('direct and group text route to their own destinations; bot/allowlists/dedup reject',async t=>{
  const {bridge,sent}=await setup(t);
  assert.equal(await bridge.accept(event(1)),'accepted');assert.equal(await bridge.accept(event(1)),'duplicate');
  assert.equal(await bridge.accept(event(2,10,20)),'accepted');
  assert.equal(await bridge.accept(event(3,2)),'ignored');assert.equal(await bridge.accept(event(4,99)),'ignored');
  assert.equal(await bridge.accept(event(5,10,99)),'ignored');
  assert.equal(await bridge.accept({...event(6),target:{uid:999}}),'ignored');
  await waitFor(()=>bridge.status().counts.done===2);
  assert.deepEqual(sent.map(s=>s.url),['/api/bot/send_to_user/10','/api/bot/send_to_group/20']);
});
test('groupSenderWhitelist restricts members inside allowed group',async t=>{
  const {bridge}=await setup(t,{groupSenderWhitelist:[11]});
  assert.equal(await bridge.accept(event(1,10,20)),'ignored');assert.equal(await bridge.accept(event(2,11,20)),'accepted');
});
test('contiguous messages merge without mixing sender or destination; turns never overlap',async t=>{
  let active=0,max=0;
  const {bridge,calls}=await setup(t,{mergeWindowMs:30},async()=>{active++;max=Math.max(active,max);await sleep(30);active--;return {text:'ok'};});
  for(const e of [event(1),event(2),event(3,11),event(4,10,20),event(5)])await bridge.accept(e);
  await waitFor(()=>bridge.status().counts.done===5);
  assert.deepEqual(calls.map(c=>c.map(m=>m.id)),[['1','2'],['3'],['4'],['5']]);assert.equal(max,1);
});
test('queue backpressure and oversized webhook body',async t=>{
  const {bridge,url}=await setup(t,{maxQueue:1,mergeWindowMs:100,maxBodyBytes:100});
  assert.equal(await bridge.accept(event(1)),'accepted');assert.equal(await bridge.accept(event(2)),'full');
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer test-secret','content-type':'application/json'},body:' '.repeat(101)})).status,413);
});
test('successful explicit send and quiet turns suppress automatic duplicate; automatic reply switch',async t=>{
  const {bridge,sent}=await setup(t,{},async m=>m[0].id==='1'?{text:'do not duplicate',sent:true}:{text:'do not send',quiet:true});
  await bridge.accept(event(1));await bridge.accept(event(2,11));await waitFor(()=>bridge.status().counts.done===2);assert.equal(sent.length,0);
  const second=await setup(t,{autoReply:false});await second.bridge.accept(event(1));await waitFor(()=>second.bridge.status().counts.done===1);assert.equal(second.sent.length,0);
});
test('ASR audio success preserves original metadata, transcription and cleans temp files',async t=>{
  const {bridge,base,calls,dir}=await setup(t);
  bridge.config.asrEnabled=true;bridge.config.asrBaseUrl=base+'/v1';
  const p=event(1) as any;p.detail={type:'normal',content_type:'vocechat/audio',content:'2026/10/29/test_audio',properties:{content_type:'audio/wav',name:'test.wav'}};
  await bridge.accept(p);await waitFor(()=>bridge.status().counts.done===1);
  assert.equal(calls[0][0].attachments[0].transcript,'听到的内容');assert.equal(calls[0][0].senderId,10);
  await bridge.stop(); // Wait for worker finally/cleanup after the send status becomes done.
  assert.deepEqual(await readdir(join(dir,'tmp')),[]);
});
test('ASR unavailable produces an explicit error without inventing transcript',async t=>{
  const {bridge,base,calls,failAsr}=await setup(t);bridge.config.asrEnabled=true;bridge.config.asrBaseUrl=base+'/v1';failAsr();
  const p=event(1) as any;p.detail={type:'normal',content_type:'vocechat/audio',content:'2026/10/29/test_audio',properties:{content_type:'audio/wav',name:'test.wav'}};
  await bridge.accept(p);await waitFor(()=>bridge.status().counts.done===1);
  assert.equal(calls[0][0].attachments[0].error,'ASR_HTTP');assert.equal(calls[0][0].attachments[0].transcript,undefined);
});
test('receive native image and ordinary file without adding a textual media protocol',async t=>{
  const {bridge,calls}=await setup(t);
  for(const [mid,key,mime] of [[1,'test_image','image/png'],[2,'test_file','application/pdf']] as const){const p=event(mid) as any;p.detail={type:'normal',content_type:'vocechat/file',content:`2026/10/29/${key}`,properties:{content_type:mime,name:key}};await bridge.accept(p);}
  await waitFor(()=>bridge.status().counts.done===2);assert.equal(calls.flat()[0].text,'');
  assert.deepEqual(calls.flatMap(c=>c.flatMap(m=>m.attachments.map(a=>a.kind))),['image','file']);
});
test('combined text, multiple images, existing audio and files upload and send in order',async t=>{
  const {bridge,dir,sent}=await setup(t);bridge.config.allowProactive=true;
  bridge.client.options.allowedLocalRoots=[dir];
  const image=join(dir,'test.png'),audio=join(dir,'test.wav'),file=join(dir,'test.txt');await writeFile(image,Buffer.from('png'));await writeFile(audio,wav());await writeFile(file,'text');
  const result=await bridge.send({kind:'group',id:20},{text:'media reply',attachments:[{kind:'image',path:image},{kind:'image',path:image},{kind:'audio',path:audio},{kind:'file',path:file}]},{proactive:true});
  assert.equal(result.length,5);assert.deepEqual(sent.map(s=>s.type),['text/plain','vocechat/file','vocechat/file','vocechat/audio','vocechat/file']);
  assert.ok(sent.every(s=>s.url==='/api/bot/send_to_group/20'));
});
test('partial combined send returns delivered receipts and does not hide partial success',async t=>{
  const {bridge,sent}=await setup(t);
  await assert.rejects(bridge.send({kind:'user',id:10},{text:'already sent',attachments:[{kind:'image',path:'missing'}]}),(error:any)=>error.message==='PARTIAL_SEND_FAILED' && error.sent===true && error.receipts.length===1);
  assert.equal(sent.length,1);
});
test('same bridge can stop and restart, and sends fail immediately while stopped',async t=>{
  const {bridge}=await setup(t);await bridge.stop();await assert.rejects(bridge.send({kind:'user',id:10},{text:'x'}),/BRIDGE_STOPPED/);
  await bridge.start();await bridge.accept(event(1));await waitFor(()=>bridge.status().counts.done===1);
});
test('disable cancels an outbound request even when a tool supplied its own live signal',async t=>{
  const {bridge,sent,holdSends}=await setup(t);holdSends();
  const operation=assert.rejects(bridge.send({kind:'user',id:10},{text:'pending'},{signal:new AbortController().signal}),/VOCECHAT_TIMEOUT_OR_ABORTED/);
  await waitFor(()=>sent.length===1);await bridge.stop();await operation;
});
test('stop waits for an in-flight durable ACK write before a replacement instance may load',async t=>{
  const {bridge}=await setup(t);const save=bridge.store.save.bind(bridge.store);
  let writing=false,finished=false;
  bridge.store.save=async()=>{writing=true;await sleep(50);await save();finished=true;};
  const accepted=bridge.accept(event(1));await waitFor(()=>writing);
  await bridge.stop();assert.equal(finished,true);assert.equal(await accepted,'accepted');
  assert.equal(await bridge.accept(event(2)),'ignored');
});
test('periodic cleanup does not remove an active media job even with very short retention',async t=>{
  let survived=false;
  const {bridge}=await setup(t,{retentionMs:1},async messages=>{await sleep(1100);survived=(await stat(messages[0].attachments[0].localPath!)).isFile();return {quiet:true};});
  const p=event(1) as any;p.detail={type:'normal',content_type:'vocechat/audio',content:'2026/10/29/test_audio',properties:{content_type:'audio/wav',name:'test.wav'}};
  await bridge.accept(p);await waitFor(()=>bridge.status().counts.done===1);assert.equal(survived,true);
});
test('proactive switch, destination gate and Unicode-aware text segmentation',async t=>{
  const {bridge,sent}=await setup(t,{textSegmentChars:2});
  await assert.rejects(bridge.send({kind:'user',id:99},{text:'x'}),/DESTINATION_DENIED/);
  await assert.rejects(bridge.send({kind:'user',id:10},{text:'x'},{proactive:true}),/PROACTIVE_DISABLED/);
  bridge.config.allowProactive=true;await bridge.send({kind:'user',id:10},{text:'😀😀中'},{proactive:true});
  assert.deepEqual(sent.map(s=>s.text),['😀😀','中']);
});
test('restart restores pending and dedup, quarantines uncertain turns and preserves session config',async t=>{
  const {bridge,dir}=await setup(t);await bridge.stop();
  const path=join(dir,'state.json');
  const pending={message:normalizeWebhook(event(7)),acceptedAt:Date.now(),status:'pending'};
  await writeFile(path,JSON.stringify({version:1,jobs:[pending,{...pending,message:normalizeWebhook(event(8)),status:'processing'}]}));
  const calls:PreparedMessage[][]=[];
  const next=new Bridge({...bridge.config},{session:{async run(m){calls.push(m);return {quiet:true};}},resolveCredential:async()=> 'test-secret'});
  t.after(()=>next.stop());await next.start();await waitFor(()=>next.status().counts.done===1);
  assert.equal(next.status().counts.uncertain,1);assert.equal(calls[0][0].id,'7');assert.equal(await next.accept(event(8)),'duplicate');assert.equal(next.status().sessionId,'session-test');
});
test('turn failure is quarantined, later jobs continue, state remains readable',async t=>{
  const {bridge,dir}=await setup(t,{},async m=>{if(m[0].id==='1')throw new Error('private internal error');return {quiet:true};});
  await bridge.accept(event(1));await bridge.accept(event(2,11));await waitFor(()=>bridge.status().counts.done===1);
  assert.equal(bridge.status().counts.uncertain,1);assert.equal((await readFile(join(dir,'state.json'),'utf8')).includes('private internal error'),false);
});
test('disabled lifecycle never listens; corrupted state fails closed without overwriting',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'voce-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'state.json');await writeFile(path,'corrupt');
  const store=new StateStore(path,1000);await assert.rejects(store.load(),/STATE_LOAD_FAILED/);assert.equal(await readFile(path,'utf8'),'corrupt');
  const bridge=new Bridge({statePath:path},{session:{async run(){return {quiet:true};}},resolveCredential:async()=>undefined});await bridge.start();assert.equal(bridge.status().running,false);await bridge.stop();
});
