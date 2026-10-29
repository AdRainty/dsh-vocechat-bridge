import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Bridge } from '../src/bridge.ts';
import { createAsrProvider } from '../src/speech.ts';

function wav() {
  const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;
}
async function fixture(t:any, handler:(req:any,res:any,body:Buffer)=>Promise<void>|void) {
  const dir=await mkdtemp(join(tmpdir(),'voce-speech-'));
  const server=createServer(async(req,res)=>{
    try {const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);await handler(req,res,Buffer.concat(chunks));}
    catch(error){res.writeHead(500);res.end();t.diagnostic(String(error));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  return {dir,base:`http://127.0.0.1:${(server.address() as any).port}`};
}

test('MiMo ASR normalizes WAV, uses the vendor envelope and preserves the original',async t=>{
  if(spawnSync('ffmpeg',['-version'],{windowsHide:true}).status!==0){t.skip('FFmpeg unavailable');return;}
  let received:any;
  const {dir,base}=await fixture(t,(req,res,body)=>{
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer test-mimo');
    received=JSON.parse(body.toString());res.end(JSON.stringify({choices:[{message:{content:'识别结果'}}]}));
  });
  const file=join(dir,'original.wav'), original=wav();await writeFile(file,original);
  const provider=createAsrProvider({provider:'mimo',baseUrl:base+'/v1',model:'mimo-v2.5-asr',resolveApiKey:()=>'test-mimo',tempDir:dir});
  assert.equal((await provider.transcribe({path:file})).text,'识别结果');
  assert.equal(received.asr_options.language,'auto');
  const sent=Buffer.from(received.messages[0].content[0].input_audio.data.split(',')[1],'base64');
  assert.equal(sent.readUInt16LE(22),1);assert.equal(sent.readUInt32LE(24),16000);
  assert.deepEqual(await readFile(file),original);assert.deepEqual(await readdir(dir),['original.wav']);
});

test('both TTS vendors synthesize, validate, upload and send voice; live settings and disabled state apply',async t=>{
  const requests:{url:string;json:any}[]=[];const sent:any[]=[];let uploads=0;
  const {dir,base}=await fixture(t,(req,res,body)=>{
    if(req.url==='/v1/audio/speech'){requests.push({url:req.url,json:JSON.parse(body.toString())});res.end(wav());return;}
    if(req.url==='/v1/chat/completions'){requests.push({url:req.url,json:JSON.parse(body.toString())});res.end(JSON.stringify({choices:[{message:{audio:{data:wav().toString('base64')}}}]}));return;}
    if(req.url==='/api/bot/file/prepare'){res.end('"upload"');return;}
    if(req.url==='/api/bot/file/upload'){
      uploads++;const start=body.indexOf('\r\n\r\n',body.indexOf('name="chunk_data"'))+4,end=body.indexOf('\r\n--',start);
      assert.deepEqual(body.subarray(start,end),wav());res.end(JSON.stringify({path:'2026/10/29/speech',size:end-start}));return;
    }
    sent.push({type:req.headers['content-type'],url:req.url});res.end('123');
  });
  let settings={ttsEnabled:true,ttsProvider:'openai',ttsModel:'model-standard',ttsBaseUrl:base+'/v1',ttsInstructions:'放慢一点'};
  const bridge=new Bridge({enabled:true,baseUrl:base,botUid:2,targetSessionId:'test',userWhitelist:[1],webhookPort:0,
    statePath:join(dir,'state.json'),tempDir:join(dir,'tmp')},{session:{async run(){return {quiet:true};}},resolveCredential:async()=>'test-key',speechConfig:()=>settings});
  await bridge.start();t.after(()=>bridge.stop());
  await bridge.send({kind:'user',id:1},{speech:{text:'第一条'}});
  settings={...settings,ttsProvider:'mimo',ttsModel:'mimo-v2.5-tts-voicedesign'};
  await bridge.send({kind:'user',id:1},{speech:{text:'第二条'}});
  assert.equal(requests[0].json.input,'第一条');assert.equal(requests[0].json.response_format,'wav');assert.equal(requests[0].json.instructions,'放慢一点');
  assert.equal(requests[1].json.messages[1].role,'assistant');assert.equal(requests[1].json.messages[1].content,'第二条');
  assert.equal(requests[1].json.audio.voice,undefined);assert.equal(uploads,2);
  assert.deepEqual(sent.map(s=>s.type),['vocechat/audio','vocechat/audio']);assert.deepEqual(await readdir(join(dir,'tmp')),[]);
  settings={...settings,ttsEnabled:false};await assert.rejects(bridge.send({kind:'user',id:1},{speech:{text:'不发送'}}),/TTS_DISABLED/);
  assert.equal(requests.length,2);
});
