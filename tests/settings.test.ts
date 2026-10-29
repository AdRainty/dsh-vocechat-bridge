import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginSettings, createSettingsHandler, settingsPath } from '../src/settings.ts';
import { AutoStartController, BridgeRuntime } from '../src/runtime.ts';
import { Bridge } from '../src/bridge.ts';

async function fixture(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'voce-settings-'));
  const base={enabled:false,baseUrl:'http://127.0.0.1',botUid:4,targetSessionId:'test-session',userWhitelist:[1],
    webhookPort:0,statePath:join(dir,'state.json'),tempDir:join(dir,'tmp')};
  const settings=new PluginSettings(join(dir,'settings.json'),()=>base),ready=settings.load();
  const keys=new Map([['VOCECHAT_BOT_API_KEY','test-private-bot'],['VOCECHAT_WEBHOOK_SECRET','test-private-hook']]);
  let generation=0,disposed=0,quietGeneration=0;
  const runtime=new BridgeRuntime(()=>settings.config(),config=>{
    const current=++generation;
    return {bridge:new Bridge(config,{session:{async run(){return {quiet:true};}},resolveCredential:async ref=>keys.get(ref),speechConfig:()=>settings.raw()}),
      session:{dispose(){disposed++;},outboundMode(){return {proactive:false};},noteSent(){},quiet(){quietGeneration=current;}} as any};
  });
  const handler=createSettingsHandler({settings,ready,runtime,resolveCredential:async ref=>keys.get(ref),credentials:()=>({
    describe:async(ref:string)=>({configured:keys.has(ref)}),set:async(ref:string,value:string)=>{keys.set(ref,value);},
  })});
  const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,url=origin+settingsPath;
  t.after(async()=>{await runtime.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const post=async(body:any,extraHeaders:Record<string,string>={})=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json',...extraHeaders},body:JSON.stringify(body)});
  return {settings,runtime,url,post,dir,keys,generation:()=>generation,disposed:()=>disposed,quietGeneration:()=>quietGeneration};
}

test('settings page API starts, reloads and stops a real listener without restarting DSH; config survives',async t=>{
  const f=await fixture(t);let view=await (await fetch(f.url)).json();
  assert.equal(view.runtime.running,false);assert.equal(view.credentials.VOCECHAT_BOT_API_KEY.configured,true);
  assert.doesNotMatch(JSON.stringify(view),/test-private/);
  let response=await f.post({revision:view.revision,set:{asrProvider:'mimo'},keys:{asr:'test-new-key'},action:'start'});
  assert.equal(response.status,200);view=await response.json();assert.equal(view.runtime.running,true);
  assert.equal((await fetch(`http://127.0.0.1:${view.runtime.address.port}/vocehook`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${view.runtime.address.port}/vocehook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    mid:1,from_uid:1,created_at:1,target:{uid:4},detail:{type:'normal',content_type:'text/plain',content:'plaintext test'},
  })})).status,202);
  response=await f.post({revision:view.revision,set:{webhookPath:'/changed'}});view=await response.json();
  assert.equal(view.runtime.needsReload,true);
  response=await f.post({revision:view.revision,action:'reload'});assert.equal(response.status,200);view=await response.json();
  assert.equal(view.runtime.running,true);assert.equal(view.runtime.needsReload,false);assert.equal(f.generation(),2);assert.equal(f.disposed(),1);
  f.runtime.session.quiet(undefined);assert.equal(f.quietGeneration(),2);
  assert.equal((await fetch(`http://127.0.0.1:${view.runtime.address.port}/changed`)).status,200);
  response=await f.post({revision:view.revision,action:'stop'});view=await response.json();assert.equal(view.runtime.running,false);
  assert.equal((await fetch(f.url)).status,200);assert.equal(f.disposed(),2);
  const disk=await readFile(join(f.dir,'settings.json'),'utf8');assert.doesNotMatch(disk,/test-new-key|test-private/);
  const recovered=new PluginSettings(join(f.dir,'settings.json'),()=>({statePath:join(f.dir,'state.json')}));await recovered.load();
  assert.equal(recovered.config().enabled,false);assert.equal(recovered.config().webhookPath,'/changed');assert.equal(recovered.config().asrProvider,'mimo');
  await f.runtime.dispose();await assert.rejects(f.runtime.start(),/BRIDGE_STOPPED/);
});

test('settings API rejects cross-origin writes, stale revisions and invalid config before starting',async t=>{
  const f=await fixture(t),view=await (await fetch(f.url)).json();
  assert.equal((await f.post({revision:view.revision,set:{}},{origin:'https://untrusted.example'})).status,403);
  assert.equal((await f.post({revision:view.revision,set:{}},{'content-type':'text/plain'})).status,403);
  assert.equal((await f.post({revision:'stale',set:{asrEnabled:true}})).status,409);
  assert.equal((await f.post({revision:view.revision,set:{botUid:0},action:'start'})).status,400);
  assert.equal((await f.post({revision:view.revision,set:{unknown:'value'}})).status,400);
  assert.equal(f.generation(),0);assert.equal(f.runtime.status().running,false);
});

test('cold start restores enabled state and retries until host credentials are ready; stop cancels retries',async t=>{
  const f=await fixture(t);
  await f.settings.update({enabled:true});
  const recovered=new PluginSettings(join(f.dir,'settings.json'),()=>f.settings.raw());await recovered.load();
  assert.equal(recovered.config().enabled,true);
  let credentialReady=false,attempts=0,running=false;
  const auto=new AutoStartController({ready:Promise.resolve(),enabled:()=>recovered.config().enabled,
    runtime:{status:()=>({running}),async start(){attempts++;if(!credentialReady)throw new Error('BRIDGE_CREDENTIAL_MISSING');running=true;}},
    onError(){},retryMs:10,maxRetryMs:10});
  t.after(()=>auto.dispose());
  await auto.wake();assert.equal(running,false);
  credentialReady=true;
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(running,true);assert(attempts>=2);
  await auto.dispose();
  running=false;credentialReady=false;
  const stopped=new AutoStartController({ready:Promise.resolve(),enabled:()=>recovered.config().enabled,
    runtime:{status:()=>({running}),async start(){attempts++;throw new Error('WEBHOOK_PORT_IN_USE');}},onError(){},retryMs:10,maxRetryMs:10});
  t.after(()=>stopped.dispose());
  await stopped.wake();await recovered.update({enabled:false});const before=attempts;
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(attempts,before);
});
