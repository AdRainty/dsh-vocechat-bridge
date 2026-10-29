import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshSessionPort, type HostAgent } from '../src/dsh.ts';
import { registerVoceTools } from '../src/tools.ts';
import type { PreparedMessage } from '../src/types.ts';

const signal = () => new AbortController().signal;
const incoming = (text = 'hello'): PreparedMessage => ({ id: '42', senderId: 7, destination: { kind: 'user', id: 7 }, timestamp: 123, text, attachments: [] });
function fixture() {
  let live: HostAgent | undefined;
  let currentTurn = 0;
  let resumeCalls = 0;
  let resumeOptions: any;
  const listeners = new Set<any>();
  const tools = new Map<string, any>();
  const queued: any[] = [];
  const images: any[] = [], files: any[] = [];
  const contexts: any[] = [];
  let onFollowup: (message: any) => void = () => {};
  const emit = (type: string, data: any, sessionId = 'session-test') => {
    for (const listener of [...listeners]) listener({ id: sessionId }, { type, data });
  };
  const agent: HostAgent = { id: 'session-test', session: { id: 'session-test' }, status: 'idle',
    ctx: { get: name => name === 'systemPrompt' ? { context(c: any) { contexts.push(c); return () => contexts.splice(contexts.indexOf(c), 1); } } : undefined },
    async whenIdle() {},
    followup(message) { queued.push(message); onFollowup(message); },
  };
  live = agent;
  const ctx: any = {
    agents: {
      get: (id: string) => live?.id === id ? live : undefined,
      async resume(options: any) { assert.equal(options.resumeSessionId, 'session-test'); resumeOptions = options; resumeCalls++; live = agent; return { agent, dispose() {} }; },
      withInitiator(a: HostAgent, fn: () => unknown) { assert.equal(a, agent); return fn(); },
    },
    tools: { register(tool: any) { tools.set(tool.name, tool); } },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) };
      if (name === 'attachments') return {
        async saveImages(inputs: any[]) { images.push(...inputs); return inputs.map(i => ({ attachmentId: 'image:one', mediaType: i.mediaType })); },
        async saveFile(input: any) { files.push(input); return { attachmentId: 'file:one', name: input.name }; },
      };
      return undefined;
    },
    on(_event: string, fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const session = new DshSessionPort(ctx, { targetSessionId: 'session-test', turnTimeoutMs: 2000 }, {
    createUserMessage: input => ({ ...input, id: randomUUID(), role: 'user' }),
  });
  const start = (message: any) => { currentTurn++; emit('turn/start', { turn: currentTurn }); emit('step/start', { turn: currentTurn, step: 1 }); emit('user/message', message); };
  const answer = (text: string, reason = 'completed') => {
    emit('assistant/message', { turn: currentTurn, step: 1, message: { content: [{ type: 'text', text }] } });
    emit('turn/end', { turn: currentTurn, reason: { kind: reason } });
  };
  return { ctx, agent, session, emit, start, answer, queued, tools, images, files, contexts, listeners,
    setFollowup(fn: (message: any) => void) { onFollowup = fn; }, removeAgent() { live = undefined; }, getResumeCalls: () => resumeCalls, getResumeOptions: () => resumeOptions };
}

test('DSH input source is structured and automatic reply belongs to the exact injected ID', async () => {
  const f = fixture();
  f.setFollowup(m => {
    // Unrelated session events must never be exported.
    f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'other channel secret' }] } }, 'other-session');
    f.start(m); f.answer('answer');
  });
  assert.deepEqual(await f.session.run([incoming()], signal()), { text: 'answer', sent: false, quiet: false });
  const input = f.queued[0];
  assert.equal(input.content[0].text, 'hello');
  assert.equal(input.source.kind, 'plugin:dsh-vocechat-bridge');
  assert.deepEqual(input.source.destination, { kind: 'user', id: 7 });
  assert.equal(input.source.messages[0].senderId, 7);
  assert.equal(f.listeners.size, 0);
});

test('a merged batch becomes exactly one user message with ordered content and original metadata',async()=>{
  const f=fixture();f.setFollowup(m=>{f.start(m);f.answer('done');});
  const one={...incoming('first'),id:'41'},two={...incoming('second'),id:'42'};
  await f.session.run([one,two],signal());assert.equal(f.queued.length,1);
  assert.deepEqual(f.queued[0].content.map((b:any)=>b.text),['first','second']);
  assert.deepEqual(f.queued[0].source.messages.map((m:any)=>m.id),['41','42']);
});

test('submission barrier runs after shared-session idle and before the single followup',async()=>{
  const f=fixture();let release!:()=>void,marked=0;
  f.agent.whenIdle=()=>new Promise<void>(r=>{release=r;});
  f.setFollowup(m=>{assert.equal(marked,1);f.start(m);f.answer('done');});
  const operation=f.session.run([incoming()],signal(),{async beforeSubmit(){marked++;}});
  await new Promise(r=>setImmediate(r));assert.equal(marked,0);assert.equal(f.queued.length,0);
  release();await operation;assert.equal(marked,1);assert.equal(f.queued.length,1);
});

test('waiting for a busy DSH session does not consume the new turn timeout',async()=>{
  const f=fixture();f.agent.whenIdle=()=>new Promise<void>(r=>setTimeout(r,40));
  f.setFollowup(m=>{f.start(m);f.answer('done');});
  const session=new DshSessionPort(f.ctx,{targetSessionId:'session-test',turnTimeoutMs:10},{createUserMessage:input=>({...input,id:randomUUID(),role:'user'})});
  const result=await session.run([incoming()],signal());assert.equal(result.text,'done');assert.equal(f.queued.length,1);session.dispose();
});

test('different senders cannot be merged even when the destination is the same',async()=>{
  const f=fixture();await assert.rejects(f.session.run([incoming(),{...incoming(),senderId:8}],signal()),/MIXED_SENDERS/);assert.equal(f.queued.length,0);
});

test('a separate queued Web turn before our followup does not suppress the later VoceChat answer',async()=>{
  const f=fixture();f.setFollowup(m=>{
    f.emit('turn/start',{turn:90});f.emit('user/message',{id:'web',source:{kind:'user'}});
    f.emit('assistant/message',{turn:90,message:{content:[{type:'text',text:'private web answer'}]}});
    f.emit('turn/end',{turn:90,reason:{kind:'completed'}});
    f.start(m);f.answer('voce answer');
  });
  assert.deepEqual(await f.session.run([incoming()],signal()),{text:'voce answer',sent:false,quiet:false});
});

test('shared session drains Web/QQ work before followup and serializes concurrent VoceChat turns', async () => {
  const f = fixture();
  let releaseIdle!: () => void;
  f.agent.whenIdle = () => new Promise<void>(resolve => { releaseIdle = resolve; });
  f.setFollowup(m => { f.start(m); setTimeout(() => f.answer('done'), 10); });
  const first = f.session.run([incoming('one')], signal());
  const second = f.session.run([incoming('two')], signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queued.length, 0);
  // Those events occur while waiting; they cannot own a VoceChat response.
  f.emit('turn/start', { turn: 55 });
  f.emit('user/message', { id: 'web', source: { kind: 'user' } });
  f.emit('turn/end', { turn: 55, reason: { kind: 'completed' } });
  f.agent.whenIdle = async () => {};
  releaseIdle();
  await Promise.all([first, second]);
  assert.deepEqual(f.queued.map(m => m.content[0].text), ['one', 'two']);
});

test('foreign external input in the same turn closes automatic routing; harness context is allowed', async () => {
  const f = fixture();
  f.setFollowup(m => {
    f.start(m);
    f.emit('user/message', { id: 'harness', source: { kind: 'runtime-context' } });
    f.answer('safe');
  });
  assert.equal((await f.session.run([incoming()], signal())).text, 'safe');
  f.setFollowup(m => {
    f.start(m);
    f.emit('user/message', { id: 'qq-input', source: { kind: 'plugin:dsh-qq-bridge' } });
    assert.throws(() => f.session.outboundMode(f.agent, { kind: 'user', id: 7 }), /SHARED_TURN/);
    f.answer('must stay in shared session');
  });
  assert.deepEqual(await f.session.run([incoming()], signal()), { text: undefined, sent: false, quiet: true });
});

test('empty final step does not resend a tool-step progress message', async () => {
  const f = fixture();
  f.setFollowup(m => {
    f.start(m);
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'working on it' }] } });
    f.emit('step/start', { turn: 1, step: 2 });
    f.emit('assistant/message', { turn: 1, step: 2, message: { content: [] } });
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  assert.equal((await f.session.run([incoming()], signal())).text, '');
});

test('failed turn rejects instead of exporting partial model output', async () => {
  const f = fixture();
  f.setFollowup(m => { f.start(m); f.answer('partial', 'error'); });
  await assert.rejects(f.session.run([incoming()], signal()), /DSH_TURN_NOT_COMPLETED/);
  assert.equal(f.listeners.size, 0);
});

test('resume is fixed to configured session and stale registered handles are reacquired', async () => {
  const f = fixture();
  f.removeAgent();
  f.setFollowup(m => { f.start(m); f.answer('resumed'); });
  assert.equal((await f.session.run([incoming()], signal())).text, 'resumed');
  assert.equal(f.getResumeCalls(), 1);
  f.removeAgent();
  await f.session.run([incoming()], signal());
  assert.equal(f.getResumeCalls(), 2);
});

test('cold resume restores pending model selection and original preset; releases Symbol.dispose observation', async () => {
  const f = fixture(); let released = 0;
  const previousGet = f.ctx.get;
  f.ctx.get = (name: string) => name === 'sessionQuery' ? {
    async observeSession(id: string, options: any) {
      assert.equal(id, 'session-test'); assert.equal(options.projectionMode, 'all');
      return { projections: { values: { modelSelection: { pending: { provider: 'kept', model: 'model-a', reasoningEffort: 'high' } }, agentPreset: 'original-persona' } },
        events: [{ type: 'request/header', data: { header: { config: { provider: 'old', model: 'model-old' } } } }],
        [Symbol.dispose]() { released++; },
      };
    },
  } : previousGet(name);
  f.removeAgent(); f.setFollowup(m => { f.start(m); f.answer('ready'); });
  await f.session.run([incoming()], signal());
  assert.equal(released, 1);
  const options = f.getResumeOptions();
  assert.deepEqual(options.agentOptions, { provider: 'kept', model: 'model-a', reasoningEffort: 'high' });
  let mounted: string | undefined;
  await options.setup({ get: () => ({ async mount(_ctx: any, id: string) { mounted = id; } }) });
  assert.equal(mounted, 'original-persona');
});

test('cold resume uses persisted request model without reusing adapter-default reasoning effort', async () => {
  const f = fixture(); const previousGet = f.ctx.get;
  f.ctx.get = (name: string) => name === 'sessionQuery' ? {
    async observeSession() { return {
      projections: { values: { modelSelection: { pending: null } } },
      events: [{ type: 'request/header', data: { header: { config: { provider: 'persisted', model: 'model-b', reasoningEffort: 'automatic' }, adapterDefaults: { reasoningEffort: true } } } }],
      [Symbol.dispose]() {},
    }; },
  } : previousGet(name);
  f.removeAgent(); f.setFollowup(m => { f.start(m); f.answer('ready'); });
  await f.session.run([incoming()], signal());
  assert.deepEqual(f.getResumeOptions().agentOptions, { provider: 'persisted', model: 'model-b' });
});

test('native images/files survive bridge temp cleanup; ASR text is not invented', async () => {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'voce-dsh-'));
  try {
    const imagePath = join(dir, 'i.png'), audioPath = join(dir, 'a.wav'), filePath = join(dir, 'data.txt');
    await Promise.all([writeFile(imagePath, 'PNG'), writeFile(audioPath, 'WAV'), writeFile(filePath, 'file')]);
    f.setFollowup(m => { f.start(m); f.answer('received'); });
    const message = incoming();
    message.attachments = [
      { kind: 'image', name: 'i.png', mime: 'image/png', path: 'source/i', localPath: imagePath },
      { kind: 'audio', name: 'a.wav', mime: 'audio/wav', path: 'source/a', localPath: audioPath, transcript: 'actual transcription' },
      { kind: 'file', name: 'data.txt', mime: 'text/plain', path: 'source/f', localPath: filePath },
    ];
    await f.session.run([message], signal());
    const blocks = f.queued[0].content;
    assert.deepEqual(blocks.map((b: any) => b.type), ['text', 'image', 'text', 'file', 'file']);
    assert.match(blocks[2].text, /消息 42，原文件 a\.wav/);
    assert.match(blocks[2].text, /actual transcription$/);
    assert.equal(Buffer.from(f.files[0].data).toString(), 'WAV');
    assert.equal(f.images.length, 1); assert.equal(f.files.length, 2);
    assert.equal(f.queued[0].source.messages[0].attachments[1].transcript, 'actual transcription');
    message.attachments[1].transcript = undefined; message.attachments[1].error = 'ASR_TIMEOUT';
    await f.session.run([message], signal());
    assert.match(f.queued[1].content[2].text, /ASR_TIMEOUT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('abort and disposal detach listeners without cancelling shared agent work', async () => {
  const f = fixture();
  f.setFollowup(m => f.start(m));
  const control = new AbortController();
  const running = f.session.run([incoming()], control.signal);
  await new Promise(resolve => setImmediate(resolve));
  control.abort(new Error('STOPPED'));
  await assert.rejects(running, /STOPPED/); assert.equal(f.listeners.size, 0);
  const next = f.session.run([incoming()], signal());
  await new Promise(resolve => setImmediate(resolve));
  f.session.dispose();
  await assert.rejects(next, /SESSION_DISPOSED/); assert.equal(f.contexts.length, 0);
});

test('tool send requires explicit destination and active host execution identity', async () => {
  const f = fixture(); const sends: any[] = [];
  const bridge: any = { async send(...args: any[]) { sends.push(args); return [123]; }, status: () => ({ running: true }) };
  registerVoceTools(f.ctx, bridge, f.session, value => value);
  assert.equal(f.tools.size, 8);
  const tool = f.tools.get('voce_send_text');
  await assert.rejects(tool.execute({ text: 'hello' }, { agent: f.agent }), /INVALID_DESTINATION/);
  await assert.rejects(tool.execute({ destination: { kind: 'user', id: 7 }, text: 'hello' }, {}), /TOOL_SESSION_DENIED/);
  await tool.execute({ destination: { kind: 'user', id: 7 }, text: 'hello' }, { agent: f.agent });
  assert.equal(sends[0][2].proactive, true);
  f.setFollowup(m => {
    f.start(m);
    void tool.execute({ destination: { kind: 'user', id: 7 }, text: 'reply' }, { agent: f.agent }).then(() => f.answer('duplicate final text'));
  });
  assert.equal((await f.session.run([incoming()], signal())).sent, true);
  assert.equal(sends[1][2].proactive, false);
});

test('failed tool send does not suppress the ordinary automatic answer', async () => {
  const f = fixture();
  registerVoceTools(f.ctx, { send: async () => { throw new Error('UPLOAD_FAILED'); }, status: () => ({}) } as any, f.session, value => value);
  f.setFollowup(m => {
    f.start(m);
    void f.tools.get('voce_send_image').execute({ destination: { kind: 'user', id: 7 }, path: 'a.png' }, { agent: f.agent })
      .catch(() => f.answer('upload failed'));
  });
  assert.equal((await f.session.run([incoming()], signal())).sent, false);
});

test('partially delivered combined tool send suppresses duplicate automatic text', async () => {
  const f = fixture();
  registerVoceTools(f.ctx, { send: async () => { throw Object.assign(new Error('PARTIAL_SEND'), { sent: true }); }, status: () => ({}) } as any, f.session, value => value);
  f.setFollowup(m => {
    f.start(m);
    void f.tools.get('voce_send_text').execute({ destination: { kind: 'user', id: 7 }, text: 'part one' }, { agent: f.agent })
      .catch(() => f.answer('part one'));
  });
  assert.equal((await f.session.run([incoming()], signal())).sent, true);
});

test('quiet tool suppresses auto reply and requests native DSH turn conclusion', async () => {
  const f = fixture(); let concluded = false;
  registerVoceTools(f.ctx, { send: async () => [], status: () => ({}) } as any, f.session, value => value);
  f.setFollowup(m => {
    f.start(m);
    f.tools.get('voce_quiet').execute({}, { agent: f.agent, concludeTurn() { concluded = true; } });
    f.answer('this stays local');
  });
  assert.equal((await f.session.run([incoming()], signal())).quiet, true);
  assert.equal(concluded, true);
});
