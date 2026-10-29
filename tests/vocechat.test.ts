import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoceChatClient } from '../src/vocechat.ts';
import { boundedResponse, downloadPublicUrl, isPublicAddress, validateHttpUrl } from '../src/network.ts';

async function fixture(t: any) {
  const events: { path: string; body: Buffer; type: string; props: any }[] = [];
  let rejectAudio = false;
  let replyStatus = 200;
  let rejectUpload = false;
  let redirect = false;
  let stallBody = false;
  let nextId = 100;
  let fileSize = 3;
  let history:any[]=[];
  const historyQueries:string[]=[];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-api-key'], 'mock-key');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const type = req.headers['content-type'] ?? '';
      const props = req.headers['x-properties'] ? JSON.parse(Buffer.from(String(req.headers['x-properties']), 'base64').toString('utf8')) : undefined;
      const url = new URL(req.url!, 'http://local');
      events.push({ path: url.pathname, body, type, props });
      if (redirect) { res.writeHead(302, { location: '/api/leak-key' }); res.end(); return; }
      if (stallBody) { res.writeHead(200); res.flushHeaders(); res.write('1'); return; }
      if (/^\/api\/bot\/(user|group)\/\d+\/messages$/.test(url.pathname)) {
        historyQueries.push(url.search);res.setHeader('content-type','application/json');res.end(JSON.stringify(history));
      } else if (url.pathname === '/api/bot/file/prepare') {
        assert.deepEqual(Object.keys(JSON.parse(body.toString())).sort(), ['content_type', 'filename']);
        res.end(JSON.stringify('dbd06c27-523d-450d-9767-5a211fed229a'));
      } else if (url.pathname === '/api/bot/file/upload') {
        if (rejectUpload) { res.writeHead(500); res.end('sensitive detail mock-key'); return; }
        const form = await new Request('http://mock', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) }).formData();
        assert.equal(form.get('file_id'), 'dbd06c27-523d-450d-9767-5a211fed229a');
        assert.equal(form.get('chunk_is_last'), 'true');
        const file = form.get('chunk_data') as File;
        fileSize = file.size;
        res.end(JSON.stringify({ path: '2026/10/29/dbd06c27-523d-450d-9767-5a211fed229a', size: fileSize, image_properties: { width: 1, height: 1 } }));
      } else if (url.pathname === '/api/resource/file') {
        assert.equal(url.searchParams.get('file_path'), '2026/10/29/dbd06c27-523d-450d-9767-5a211fed229a');
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([1, 2, 3]));
      } else if (url.pathname.startsWith('/api/bot/send_to_') || /^\/api\/bot\/reply\/\d+$/.test(url.pathname)) {
        if (url.pathname.startsWith('/api/bot/reply/') && replyStatus !== 200) { res.writeHead(replyStatus); res.end('reply failed'); }
        else if (rejectAudio && type === 'vocechat/audio') { res.writeHead(415); res.end('unsupported'); }
        else res.end(String(++nextId));
      } else { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const dir = await mkdtemp(path.join(tmpdir(), 'voce-api-test-'));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new VoceChatClient({ baseUrl, resolveApiKey: async () => 'mock-key', allowedLocalRoots: [dir] });
  return { client, dir, events, baseUrl, setRejectAudio: () => { rejectAudio = true; }, setRejectUpload: () => { rejectUpload = true; },
    setReplyStatus:(value:number)=>{replyStatus=value;},
    setHistory:(value:any[])=>{history=value;},historyQueries,
    setRedirect: () => { redirect = true; }, setStallBody: () => { stallBody = true; } };
}

test('private/group text and native replies preserve Unicode, format and original body', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.sendText({ kind: 'user', id: 3 }, '第一行\n第二行'), { messageId: 101 });
  assert.deepEqual(await f.client.sendText({ kind: 'group', id: 8 }, '回答', { replyTo: 29 }), { messageId: 102 });
  assert.equal(f.events[0].path, '/api/bot/send_to_user/3');
  assert.equal(f.events[0].body.toString(), '第一行\n第二行');
  assert.equal(f.events[1].path, '/api/bot/reply/29');
  assert.equal(f.events[1].type, 'text/plain');
  assert.equal(f.events[1].body.toString(), '回答');
  await f.client.sendText({kind:'user',id:3},'**原生引用**',{replyTo:30,format:'markdown'});
  assert.equal(f.events[2].path,'/api/bot/reply/30');
  assert.equal(f.events[2].type,'text/markdown');assert.equal(f.events[2].body.toString(),'**原生引用**');
  await assert.rejects(f.client.sendText({ kind: 'group', id: -1 }, 'x'), /INVALID_TARGET_ID/);
  await assert.rejects(f.client.sendText({ kind: 'user', id: 3 }, '  '), /EMPTY_TEXT/);
});

test('native media replies retain metadata and reply target through audio 415 fallback, never downgrade to a normal send',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'引用附件.txt');await writeFile(file,'attachment');
  await f.client.sendAttachment({kind:'group',id:8},{kind:'file',path:file},{replyTo:29});
  assert.equal(f.events.at(-1)?.path,'/api/bot/reply/29');
  assert.equal(f.events.at(-1)?.props.name,'引用附件.txt');
  f.setRejectAudio();
  const audio=await f.client.sendAudioBytes({kind:'user',id:3},Buffer.from('RIFF'),{name:'voice.wav',mime:'audio/wav'},{replyTo:30});
  assert.equal(audio.audioFallback,true);
  assert.deepEqual(f.events.slice(-2).map(e=>[e.path,e.type]),[['/api/bot/reply/30','vocechat/audio'],['/api/bot/reply/30','vocechat/file']]);
  const count=f.events.length;
  await assert.rejects(f.client.sendAttachment({kind:'group',id:8},{kind:'file',path:file},{replyTo:0}),/INVALID_REPLY_ID/);
  assert.equal(f.events.length,count);
  f.setReplyStatus(404);
  await assert.rejects(f.client.sendText({kind:'group',id:8},'no duplicate',{replyTo:29}),/VOCECHAT_HTTP_404/);
  assert.equal(f.events.length,count+1);assert.equal(f.events.at(-1)?.path,'/api/bot/reply/29');
});

test('Bot history uses context count, restores both DM directions and isolates groups',async t=>{
  const f=await fixture(t);
  const message=(mid:number,from_uid:number,target:any)=>({mid,from_uid,target,created_at:mid,detail:{type:'normal',content_type:'text/plain',content:`message-${mid}`}});
  f.setHistory([message(8,3,{uid:2}),message(4,2,{uid:3}),message(7,9,{uid:2}),message(8,3,{uid:2}),message(6,3,{gid:8}),message(9,3,{gid:9})]);
  const dm=await f.client.getHistory({kind:'user',id:3},2,5);
  assert.deepEqual(dm.map(m=>[m.id,m.senderId,m.destination]),[['4',2,{kind:'user',id:3}],['8',3,{kind:'user',id:3}]]);
  assert.deepEqual((await f.client.getHistory({kind:'group',id:8},2,5)).map(m=>m.id),['6']);
  assert.deepEqual(f.events.map(e=>e.path),['/api/bot/user/3/messages','/api/bot/group/8/messages']);
  assert.deepEqual(f.historyQueries,['?context=5','?context=5']);
  await assert.rejects(f.client.getHistory({kind:'user',id:3},2,101),/INVALID_HISTORY_LIMIT/);
  assert.equal(f.events.length,2);
});

test('prepare + multipart upload + image/file/audio send preserve Unicode metadata', async t => {
  const f = await fixture(t);
  const image = path.join(f.dir, '测试图片.png');
  const audio = path.join(f.dir, 'voice.ogg');
  const file = path.join(f.dir, 'report.pdf');
  await Promise.all([writeFile(image, Buffer.from([1, 2, 3])), writeFile(audio, Buffer.from('OggS')), writeFile(file, '%PDF')]);
  const result = await f.client.sendAttachment({ kind: 'user', id: 3 }, { kind: 'image', path: image });
  assert.equal(result.messageId, 101);
  assert.equal(result.size, 3);
  const sent = f.events[2];
  assert.equal(sent.type, 'vocechat/file');
  assert.equal(sent.props.name, '测试图片.png');
  assert.equal(sent.props.width, 1);
  assert.equal(JSON.parse(sent.body.toString()).path, result.remotePath);
  await f.client.sendAttachment({ kind: 'group', id: 2 }, { kind: 'file', path: file });
  await f.client.sendAttachment({ kind: 'user', id: 3 }, { kind: 'audio', path: audio });
  assert.equal(f.events.at(-1)?.type, 'vocechat/audio');
  assert.equal(f.events[5].props.content_type, 'application/pdf');
});

test('explicit Markdown sends native text/markdown without adding a reply quote', async t => {
  const f = await fixture(t);
  const text = '## Markdown\n\n**加粗** 与 `代码`\n\n- 第一项';
  assert.deepEqual(await f.client.sendText({kind:'user',id:3},text,{format:'markdown'}),{messageId:101});
  assert.equal(f.events[0].type,'text/markdown');assert.equal(f.events[0].body.toString(),text);
  await assert.rejects(f.client.sendText({kind:'user',id:3},'x',{format:'html'} as any),/INVALID_TEXT_FORMAT/);
  assert.equal(f.events.length,1);
});

test('older servers fall back from vocechat/audio 415 to a normal audio attachment', async t => {
  const f = await fixture(t);
  f.setRejectAudio();
  const audio = path.join(f.dir, 'voice.wav');
  await writeFile(audio, 'RIFF');
  const result = await f.client.sendAttachment({ kind: 'group', id: 2 }, { kind: 'audio', path: audio });
  assert.equal(result.audioFallback, true);
  assert.deepEqual(f.events.slice(-2).map(e => e.type), ['vocechat/audio', 'vocechat/file']);
});

test('download always uses fixed resource endpoint with validated resource ID', async t => {
  const f = await fixture(t);
  const result = await f.client.download('2026/10/29/dbd06c27-523d-450d-9767-5a211fed229a', '../照片.png');
  assert.deepEqual(result.bytes, Buffer.from([1, 2, 3]));
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.name, '.._照片.png');
  for (const input of ['https://evil.example/x', '/etc/passwd', '../../credentials', '2026/10/29/../secret', 'C:\\secret', '2026/10/29/x?url=evil']) {
    await assert.rejects(f.client.download(input), /INVALID_RESOURCE_PATH/);
  }
  assert.equal(f.events.length, 1);
});

test('local file allow roots enforce realpath boundaries and deny prefix neighbours', async t => {
  const f = await fixture(t);
  const allowed = path.join(f.dir, 'allowed');
  const neighbour = path.join(f.dir, 'allowed-other');
  await Promise.all([mkdir(allowed), mkdir(neighbour)]);
  await writeFile(path.join(neighbour, 'secret.txt'), 'secret');
  const client = new VoceChatClient({ baseUrl: f.baseUrl, resolveApiKey: async () => 'mock-key', allowedLocalRoots: [allowed] });
  await assert.rejects(client.loadSource({ kind: 'file', path: path.join(neighbour, 'secret.txt') }), /LOCAL_MEDIA_PATH_DENIED/);
  await symlink(neighbour, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(client.loadSource({ kind: 'file', path: path.join(allowed, 'escape', 'secret.txt') }), /LOCAL_MEDIA_PATH_DENIED/);
  assert.equal(f.events.length, 0);
});

test('file limits, unsupported formats, validator errors and failed uploads never send a message', async t => {
  const f = await fixture(t);
  const filename = path.join(f.dir, 'small.bin');
  await writeFile(filename, '1234');
  const small = new VoceChatClient({ baseUrl: f.baseUrl, resolveApiKey: async () => 'mock-key', allowedLocalRoots: [f.dir], maxMediaBytes: 3 });
  await assert.rejects(small.loadSource({ kind: 'file', path: filename }), /MEDIA_TOO_LARGE/);
  await assert.rejects(f.client.sendAttachment({ kind: 'user', id: 3 }, { kind: 'image', path: filename }), /UNSUPPORTED_IMAGE_FORMAT/);
  await assert.rejects(f.client.sendAttachment({ kind: 'user', id: 3 }, { kind: 'file', path: filename }, { validate: async () => { throw new Error('AUDIO_TOO_LONG'); } }), /AUDIO_TOO_LONG/);
  assert.equal(f.events.length, 0);
  f.setRejectUpload();
  await assert.rejects(f.client.sendAttachment({ kind: 'user', id: 3 }, { kind: 'file', path: filename }), error => {
    assert.equal((error as Error).message, 'VOCECHAT_HTTP_500');
    assert.doesNotMatch(String(error), /sensitive|mock-key/);
    return true;
  });
  assert.equal(f.events.some(e => e.path.startsWith('/api/bot/send_to_')), false);
});

test('response streaming stops at size limit with and without Content-Length', async () => {
  await assert.rejects(boundedResponse(new Response('1234', { headers: { 'content-length': '4' } }), 3), /MEDIA_TOO_LARGE/);
  await assert.rejects(boundedResponse(new Response('1234'), 3), /MEDIA_TOO_LARGE/);
  assert.equal((await boundedResponse(new Response('123'), 3)).toString(), '123');
});

test('remote sources require explicit origin plus public addresses; credentials and non-http schemes denied', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.3.4.5', '172.16.1.2', '192.168.1.2', '169.254.169.254', '100.64.1.2', '224.0.0.1', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2001:0000::1', '2002:7f00:1::1', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'http://user:secret@example.com/x', 'https://example.com/#secret']) {
    assert.throws(() => validateHttpUrl(url), /INVALID_HTTP_URL/);
  }
  await assert.rejects(downloadPublicUrl('http://127.0.0.1/file', { allowedOrigins: [], maxBytes: 10, timeoutMs: 1000 }), /REMOTE_ORIGIN_DENIED/);
  await assert.rejects(downloadPublicUrl('http://127.0.0.1/file', { allowedOrigins: ['http://127.0.0.1'], maxBytes: 10, timeoutMs: 1000 }), /REMOTE_ADDRESS_DENIED/);
});

test('missing credentials and cancelled requests return safe actionable errors', async t => {
  const f = await fixture(t);
  const client = new VoceChatClient({ baseUrl: f.baseUrl, resolveApiKey: async () => undefined });
  await assert.rejects(client.sendText({ kind: 'user', id: 2 }, 'x'), /VOCECHAT_CREDENTIAL_MISSING/);
  await assert.rejects(f.client.sendText({ kind: 'user', id: 2 }, 'x', { signal: AbortSignal.abort() }), /VOCECHAT_TIMEOUT_OR_ABORTED/);
  assert.equal(f.events.length, 0);
});

test('API redirects cannot leak the Bot Key to a redirect target', async t => {
  const f = await fixture(t);
  f.setRedirect();
  await assert.rejects(f.client.sendText({ kind: 'user', id: 2 }, 'x'), /VOCECHAT_REQUEST_FAILED/);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].path, '/api/bot/send_to_user/2');
});

test('request timeout also limits response-body streaming after headers', async t => {
  const f = await fixture(t);
  f.setStallBody();
  const client = new VoceChatClient({ baseUrl: f.baseUrl, resolveApiKey: async () => 'mock-key', timeoutMs: 100 });
  await assert.rejects(client.sendText({ kind: 'user', id: 2 }, 'x'), /VOCECHAT_TIMEOUT_OR_ABORTED/);
});
