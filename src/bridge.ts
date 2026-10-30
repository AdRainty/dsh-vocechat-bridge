import { createServer, type Server, type IncomingMessage as HttpRequest } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, allowedDestination, type BridgeConfig } from './config.ts';
import { normalizeWebhook } from './inbound.ts';
import { StateStore, batchPhases, type Job, type Batch, type BufferScope } from './state.ts';
import { DebounceBuffer } from './debounce.ts';
import { VoceChatClient } from './vocechat.ts';
import { AudioError, probeAudio } from './audio.ts';
import { createAsrProvider, createTtsProvider, speechOptions } from './speech.ts';
import { boundHistory } from './history.ts';
import type { LocalFileResolver } from './files.ts';
import type { ConversationHistory, Destination, HistoryMessage, IncomingMessage, OutboundMessage, PreparedMessage, QuotedContext, SessionPort, CredentialResolver, Logger } from './types.ts';

const silent: Logger = {debug(){},info(){},warn(){},error(){}};
type RecentHistory = {messages:IncomingMessage[];error?:never} | {messages?:never;error:string};
const contextError=(error:unknown)=>error instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.message)?error.message:'QUOTE_CONTEXT_UNAVAILABLE';
export class Bridge {
  readonly config: BridgeConfig;
  readonly store: StateStore;
  readonly client: VoceChatClient;
  private buffer: DebounceBuffer;
  private server?: Server;
  private controller = new AbortController();
  private worker?: Promise<void>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private sealing?: Promise<void>;
  private running = false;
  private log: Logger;
  private outbound: Promise<unknown> = Promise.resolve();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private activeTempDirs = new Set<string>();
  private failure?: string;
  private historyError?: string;
  private ingress = {posts:0,lastPostAt:undefined as number|undefined,lastHttpStatus:undefined as number|undefined,
    recent:[] as {at:number;messageId?:number;senderId?:number;target?:Destination;status:string;reason?:string}[]};
  private ports: {session:SessionPort;resolveCredential:CredentialResolver;logger?:Logger;speechConfig?:()=>Partial<BridgeConfig>};
  constructor(config: Partial<BridgeConfig>, ports: {session:SessionPort;resolveCredential:CredentialResolver;logger?:Logger;speechConfig?:()=>Partial<BridgeConfig>}) {
    this.ports=ports;
    this.config = parseConfig(config);
    this.store = new StateStore(this.config.statePath, Math.max(this.config.retentionMs,this.config.dedupTtlMs),this.config.maxHistory);
    this.buffer = new DebounceBuffer(this.store,this.config);
    this.log = ports.logger || silent;
    this.client = new VoceChatClient({
      baseUrl:this.config.baseUrl || 'http://127.0.0.1', resolveApiKey:async()=> {
        const key = await ports.resolveCredential(this.config.botApiKeyRef); if (!key) throw new Error('BOT_CREDENTIAL_MISSING'); return key;
      }, timeoutMs:this.config.requestTimeoutMs,maxMediaBytes:this.config.maxMediaBytes,
      allowedLocalRoots:this.config.allowedLocalRoots,allowedRemoteOrigins:this.config.allowedRemoteOrigins,
    });
  }
  private speechConfig() { return parseConfig({...this.config,...this.ports.speechConfig?.()}); }
  async start() {
    if (this.running || !this.config.enabled) return;
    if (!await this.ports.resolveCredential(this.config.botApiKeyRef)) throw new Error('BRIDGE_CREDENTIAL_MISSING');
    if (this.config.webhookSecretRef && !await this.ports.resolveCredential(this.config.webhookSecretRef)) throw new Error('WEBHOOK_CREDENTIAL_MISSING');
    await this.store.load();
    await this.store.transaction(async()=>{
      for(const job of this.store.jobs) {
        job.sourceKey ??= this.sourceKey();job.channel ??= 'vocechat';job.sessionId ??= this.config.targetSessionId;
      }
      this.buffer.restorePending(job=>this.scopeFor(job));
      this.buffer.sealDue(Date.now());
      await this.store.save();
    });
    await mkdir(this.config.tempDir,{recursive:true,mode:0o700});
    await this.cleanup();
    this.controller = new AbortController();
    const server = createServer((req,res) => { void this.handleHttp(req,res).catch(() => {
      if (!res.headersSent) res.writeHead(500); res.end(); this.log.error('WEBHOOK_INTERNAL_ERROR');
    }); });
    server.requestTimeout = this.config.requestTimeoutMs;
    server.headersTimeout = Math.min(15000,this.config.requestTimeoutMs);
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject); server.listen(this.config.webhookPort,this.config.webhookHost,()=>{server.off('error',reject);resolve();});
    });
    server.on('error',()=>{this.failure='WEBHOOK_SERVER_ERROR';this.log.error(this.failure);});
    this.server=server; this.running=true; this.failure=undefined; this.schedule();
    this.cleanupTimer=setInterval(()=>{void this.cleanup().catch(()=>this.log.warn('TEMP_CLEANUP_FAILED'));},Math.max(1000,Math.min(this.config.retentionMs,3600_000)));
    this.cleanupTimer.unref();
    this.log.info('VoceChat bridge started');
  }
  async stop() {
    this.running=false; this.controller.abort();
    clearTimeout(this.debounceTimer);this.debounceTimer=undefined;
    clearInterval(this.cleanupTimer);this.cleanupTimer=undefined;
    if (this.server) {
      const server=this.server; this.server=undefined;
      await new Promise<void>(resolve => {server.close(()=>resolve());server.closeAllConnections();});
    }
    await this.sealing;await this.worker;
    await this.outbound.catch(()=>{});
    // A disconnected webhook can still be completing its durable ACK write.
    // Drain the store lock before a replacement instance can open this file.
    await this.store.transaction(async()=>{});
  }
  status() {
    const voice=this.speechConfig();
    return {enabled:this.config.enabled,running:this.running,address:this.server?.address(),failure:this.failure,
      speech:{enabled:voice.voiceEnabled,asrEnabled:voice.asrEnabled,asrProvider:voice.asrProvider,asrModel:voice.asrModel,
        ttsEnabled:voice.ttsEnabled,ttsProvider:voice.ttsProvider,ttsModel:voice.ttsModel},
      ingress:structuredClone(this.ingress),history:{contextMessages:this.config.historyContextMessages,maxChars:this.config.historyMaxChars,lastError:this.historyError},
      sessionId:this.config.targetSessionId,counts:Object.fromEntries(['pending','processing','done','failed','uncertain'].map(s=>[s,this.store.jobs.filter(j=>j.status===s).length])),
      batchCounts:Object.fromEntries(batchPhases.map(p=>[p,this.store.batches.filter(b=>b.phase===p).length])),
      blockedBatches:this.store.batches.filter(b=>['buffering','ready'].includes(b.phase)&&!this.canDispatch(b)).length,
      nextFlushAt:this.buffer.nextDeadline(),debounce:{privateQuietMs:this.config.privateQuietMs,groupQuietMs:this.config.groupQuietMs,maxWaitMs:this.config.maxWaitMs}};
  }
  private async handleHttp(req:HttpRequest,res:import('node:http').ServerResponse) {
    const url=new URL(req.url || '/', 'http://localhost');
    const respond=(code:number,body:unknown)=>{if(req.method==='POST')this.ingress.lastHttpStatus=code;res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if (url.pathname!==this.config.webhookPath) return respond(404,{error:'NOT_FOUND'});
    if(req.method==='POST'){this.ingress.posts++;this.ingress.lastPostAt=Date.now();}
    // VoceChat validates the endpoint with GET. This probe exposes no data and
    // must succeed independently of POST credentials or query preservation.
    if(req.method==='GET') return respond(200,{ok:true});
    if(this.config.webhookSecretRef) {
      const secret=await this.ports.resolveCredential(this.config.webhookSecretRef);
      const provided=req.headers.authorization?.replace(/^Bearer /,'') || url.searchParams.get('secret') || '';
      const a=Buffer.from(secret||''),b=Buffer.from(provided);
      if (!a.length || a.length!==b.length || !timingSafeEqual(a,b)) return respond(401,{error:'UNAUTHORIZED'});
    }
    if(req.method!=='POST') return respond(405,{error:'METHOD_NOT_ALLOWED'});
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return respond(415,{error:'JSON_REQUIRED'});
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req) {size+=chunk.length;if(size>this.config.maxBodyBytes)return respond(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
    let value:unknown;
    try {value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return respond(400,{error:'INVALID_JSON'});}
    try {
      const result=await this.accept(value);
      return respond(result==='full'?503:202,{status:result});
    } catch(error:any) {return respond(error.message==='STATE_WRITE_FAILED'?503:400,{error:error.message==='STATE_WRITE_FAILED'?'STATE_WRITE_FAILED':'INVALID_EVENT'});}
  }
  async accept(value:unknown):Promise<'accepted'|'duplicate'|'ignored'|'full'> {
    try {
      const result=await this.acceptMessage(value);
      this.recordIngress(value,result.status,result.reason);return result.status;
    }catch(error) {
      this.recordIngress(value,'rejected',error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:'INVALID_EVENT');throw error;
    }
  }
  private recordIngress(value:unknown,status:string,reason?:string) {
    const p=value as any;
    const id=(value:unknown):value is number=>Number.isSafeInteger(value) && Number(value)>0;
    this.ingress.recent.push({at:Date.now(),...(id(p?.mid)?{messageId:p.mid}:{}),...(id(p?.from_uid)?{senderId:p.from_uid}:{}),
      ...(id(p?.target?.gid)?{target:{kind:'group' as const,id:p.target.gid}}:id(p?.target?.uid)?{target:{kind:'user' as const,id:p.target.uid}}:{}),status,...(reason?{reason}:{})});
    if(this.ingress.recent.length>30)this.ingress.recent.shift();
  }
  private async acceptMessage(value:unknown):Promise<{status:'accepted'|'duplicate'|'ignored'|'full';reason?:string}> {
    const ignore=(reason:string)=>({status:'ignored' as const,reason});
    if(!this.running) return ignore('BRIDGE_STOPPED');
    const message=normalizeWebhook(value);
    const c=this.config;
    const rawTarget=(value as any)?.target;
    if(rawTarget?.uid && rawTarget.uid!==c.botUid)return ignore('OTHER_RECIPIENT');
    if(!message)return ignore('UNSUPPORTED_MESSAGE');
    if(message.senderId===c.botUid)return ignore('SELF_MESSAGE');
    if(!allowedDestination(c,message.destination))return ignore('DESTINATION_DENIED');
    if(message.destination.kind==='group' && c.groupSenderWhitelist.length && !c.groupSenderWhitelist.includes(message.senderId))return ignore('SENDER_DENIED');
    if(message.text.length>c.maxTextChars || message.attachments.some(a=>(a.size??0)>c.maxMediaBytes)) throw new Error('MESSAGE_TOO_LARGE');
    const receivedAt=Date.now();
    const result=await this.store.transaction(async()=>{
      if(!this.running)return 'ignored' as const;
      if(this.store.jobs.some(j=>j.message.id===message.id && j.sourceKey===this.sourceKey() && (j.status==='pending'||j.status==='processing'||(j.finishedAt??j.acceptedAt)>Date.now()-c.dedupTtlMs))) return 'duplicate' as const;
      if(this.store.jobs.filter(j=>j.status==='pending'||j.status==='processing').length>=c.maxQueue) return 'full' as const;
      const previousJobs=this.store.jobs.slice(),previousBatches=this.store.batches.slice();
      const batchValues=previousBatches.map(b=>[b,structuredClone(b)] as const);
      const job:Job={id:randomUUID(),message,acceptedAt:receivedAt,status:'pending',sourceKey:this.sourceKey(),channel:'vocechat',sessionId:c.targetSessionId};
      try {
        this.store.jobs.push(job);this.buffer.enqueue(job,this.scopeFor(job));
        await this.store.save();
      }catch{
        this.store.jobs=previousJobs;this.store.batches=previousBatches;
        for(const [batch,value] of batchValues){for(const key of Object.keys(batch))delete (batch as any)[key];Object.assign(batch,value);}
        throw new Error('STATE_WRITE_FAILED');
      }
      return 'accepted' as const;
    });
    if(result==='accepted') this.schedule();return {status:result,...(result==='ignored'?{reason:'BRIDGE_STOPPED'}:{})};
  }
  async getHistory(destination:Destination,limit=20,options:{signal?:AbortSignal;beforeId?:number}={}):Promise<ConversationHistory> {
    if(!this.running)throw new Error('BRIDGE_STOPPED');
    if(!allowedDestination(this.config,destination))throw new Error('DESTINATION_DENIED');
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100)throw new Error('INVALID_HISTORY_LIMIT');
    const signal=AbortSignal.any([this.controller.signal,...(options.signal?[options.signal]:[]),AbortSignal.timeout(this.config.historyTimeoutMs)]);
    // The Bot endpoint exposes the latest window, without a before cursor. Read
    // a bounded window for queued batches and exclude every later/new message.
    const recent=await this.client.getHistory(destination,this.config.botUid,options.beforeId===undefined?limit:100,signal);
    this.historyError=undefined;
    return this.historyView(destination,recent,limit,options.beforeId);
  }
  private cachedHistoryMessage(message:IncomingMessage):HistoryMessage {
    const cached=this.store.jobs.find(j=>j.sourceKey===this.sourceKey() && j.message.id===message.id && j.message.destination.kind===message.destination.kind && j.message.destination.id===message.destination.id);
    return {...message,attachments:message.attachments.map((attachment,index)=>({...attachment,...(attachment.kind==='audio' && cached?.message.attachments[index]?.path===attachment.path?cached.preparedAudio?.[index]:{})}))};
  }
  private visibleHistory(message:IncomingMessage) {
    return message.destination.kind!=='group' || message.senderId===this.config.botUid || !this.config.groupSenderWhitelist.length || this.config.groupSenderWhitelist.includes(message.senderId);
  }
  private historyView(destination:Destination,recent:IncomingMessage[],limit:number,beforeId?:number):ConversationHistory {
    const messages=recent.filter(m=>(beforeId===undefined || Number(m.id)<beforeId) && this.visibleHistory(m)).map(message=>this.cachedHistoryMessage(message));
    return boundHistory(destination,messages,limit,this.config.historyMaxChars);
  }
  private async contextHistory(messages:PreparedMessage[],signal:AbortSignal,recent?:RecentHistory):Promise<ConversationHistory|undefined> {
    const requested=this.config.historyContextMessages;if(!requested)return undefined;
    const destination=messages[0].destination;
    try{
      if(recent?.error)throw new Error(recent.error);
      const beforeId=Math.min(...messages.map(m=>Number(m.id)));
      if(recent?.messages){this.historyError=undefined;return this.historyView(destination,recent.messages,requested,beforeId);}
      return await this.getHistory(destination,requested,{signal,beforeId});
    }
    catch(error) {
      signal.throwIfAborted();
      const code=error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'HISTORY_UNAVAILABLE';
      if(this.historyError!==code)this.log.warn(`HISTORY_UNAVAILABLE: ${code}`);this.historyError=code;
      return {destination:{...destination},messages:[],order:'oldest_first',requested,truncated:false,error:code};
    }
  }
  private async prepareQuotes(messages:PreparedMessage[],dir:string,signal:AbortSignal):Promise<RecentHistory|undefined> {
    const replies=messages.filter(message=>message.replyTo!==undefined);
    if(!replies.length)return undefined;
    const destination=messages[0].destination,candidates=new Map<string,HistoryMessage>(),wanted=new Set(replies.map(message=>message.replyTo!)),sourceKey=this.sourceKey();
    for(const job of this.store.jobs)if(wanted.has(job.message.id) && job.sourceKey===sourceKey && job.message.destination.kind===destination.kind && job.message.destination.id===destination.id && this.visibleHistory(job.message))
      candidates.set(job.message.id,this.cachedHistoryMessage(job.message));
    let recent:RecentHistory|undefined;
    if(this.config.historyContextMessages || replies.some(message=>!candidates.has(message.replyTo!))) {
      try {
        const records=await this.client.getHistory(destination,this.config.botUid,100,AbortSignal.any([signal,AbortSignal.timeout(this.config.historyTimeoutMs)]));
        recent={messages:records};
        for(const message of records)if(this.visibleHistory(message))candidates.set(message.id,this.cachedHistoryMessage(message));
      }catch(error){signal.throwIfAborted();recent={error:contextError(error)};}
    }
    const quotes=new Map<string,QuotedContext>();
    for(const message of replies) {
      const id=message.replyTo!;
      if(quotes.has(id)){message.quote=quotes.get(id);continue;}
      const reference=candidates.get(id);
      if(!reference){message.quote={id,status:'unavailable',error:recent?.error ?? 'QUOTE_NOT_FOUND'};quotes.set(id,message.quote);continue;}
      const bounded=boundHistory(destination,[reference],1,Math.min(4000,this.config.historyMaxChars));
      const snapshot=bounded.messages[0];
      const quote:QuotedContext=message.quote=snapshot?{id,status:'available',message:snapshot,truncated:bounded.truncated}:{id,status:'unavailable',error:'QUOTE_TOO_LARGE'};
      quotes.set(id,quote);
      if(snapshot && reference.attachments.length) {
        try {quote.media=(await this.prepare({message:reference,acceptedAt:Date.now(),status:'done'},dir,signal,false)).attachments;}
        catch(error){signal.throwIfAborted();quote.mediaError=contextError(error);}
      }
    }
    return recent;
  }
  private sourceKey() {return JSON.stringify([this.config.baseUrl,this.config.botUid]);}
  private scopeFor(job:Job):BufferScope {
    return {sourceKey:job.sourceKey??this.sourceKey(),channel:job.channel??'vocechat',sessionId:job.sessionId??this.config.targetSessionId,
      destination:{...job.message.destination},senderId:job.message.senderId};
  }
  private canDispatch(batch:Batch) {
    const s=batch.scope,c=this.config;
    return s.sourceKey===this.sourceKey()&&s.channel==='vocechat'&&s.sessionId===c.targetSessionId&&allowedDestination(c,s.destination)&&
      (s.destination.kind!=='group'||!c.groupSenderWhitelist.length||c.groupSenderWhitelist.includes(s.senderId));
  }
  private schedule() {
    clearTimeout(this.debounceTimer);this.debounceTimer=undefined;
    if(!this.running||this.failure)return;
    this.kick();
    if(this.sealing)return;
    const due=this.buffer.nextDeadline();
    if(due===undefined)return;
    this.debounceTimer=setTimeout(()=>{
      this.debounceTimer=undefined;
      this.sealing=this.store.transaction(async()=>{
        if(!this.running)return;
        if(this.buffer.sealDue(Date.now()).length)await this.store.save();
      }).catch(()=>{this.failure='BUFFER_WRITE_FAILED';this.log.error(this.failure);})
        .finally(()=>{this.sealing=undefined;this.schedule();});
    },Math.max(0,due-Date.now()));
  }
  private kick() {
    if(this.worker || !this.running || !this.buffer.nextReady(b=>this.canDispatch(b)))return;
    this.worker=this.drain().catch(()=>{this.failure='QUEUE_ERROR';this.log.error(this.failure);}).finally(()=>{this.worker=undefined;this.schedule();});
  }
  private async drain() {
    const signal=this.controller.signal;
    while(this.running && !signal.aborted) {
      const batch=await this.store.transaction(async()=>{
        if(!this.running)return undefined;
        const next=this.buffer.nextReady(b=>this.canDispatch(b));if(!next)return undefined;
        next.phase='preparing';delete next.code;await this.store.save();return next;
      });
      if(!batch)return;
      const jobs=this.buffer.jobs(batch);
      const dir=join(this.config.tempDir,`job-${randomUUID()}`);
      this.activeTempDirs.add(dir);
      let submitted=false;
      let submission:Promise<void>|undefined;
      const beforeSubmit=()=>submission??=(async()=>{
        await this.store.transaction(async()=>{
          signal.throwIfAborted();
          batch.phase='dispatching';jobs.forEach(j=>j.status='processing');await this.store.save();
        });
        submitted=true;
      })();
      try {
        await mkdir(dir,{recursive:true,mode:0o700});
        const prepared:PreparedMessage[]=[];
        for(const job of jobs)prepared.push(await this.prepare(job,dir,signal));
        signal.throwIfAborted();
        const recent=await this.prepareQuotes(prepared,dir,signal);
        const history=await this.contextHistory(prepared,signal,recent);
        signal.throwIfAborted();
        if(!this.ports.session.supportsSubmissionBarrier)await beforeSubmit();
        const result=await this.ports.session.run(prepared,signal,{beforeSubmit,history});
        if(!submitted)throw new Error('SESSION_SUBMISSION_NOT_RECORDED');
        if(this.config.autoReply && !result.sent && !result.quiet && result.text?.trim()) await this.send(batch.scope.destination,{text:result.text}, {signal});
        await this.store.transaction(async()=>{
          batch.phase='done';delete batch.code;
          jobs.forEach(j=>{j.status='done';j.finishedAt=Date.now();delete j.code;});
          await this.store.save();
        });
      } catch (cause) {
        const detail=cause instanceof AudioError?cause.code:cause instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(cause.message)?cause.message:undefined;
        const interruptedBeforeSubmit=signal.aborted&&!submitted;
        await this.store.transaction(async()=>{
          batch.phase=interruptedBeforeSubmit?'ready':submitted?'uncertain':'failed';
          batch.code=signal.aborted?'STOPPED':detail || (submitted?'TURN_OR_REPLY_FAILED':'MEDIA_PROCESSING_FAILED');
          jobs.forEach(j=>{j.status=interruptedBeforeSubmit?'pending':submitted?'uncertain':'failed';j.code=batch.code;if(interruptedBeforeSubmit)delete j.finishedAt;else j.finishedAt=Date.now();});
          await this.store.save();
        });
        this.log.warn(jobs[0].code!);
      } finally {
        await rm(dir,{recursive:true,force:true});
        this.activeTempDirs.delete(dir);
      }
    }
  }
  private async prepare(job:Job,dir:string,signal:AbortSignal,transcribe=true):Promise<PreparedMessage> {
    const message=job.message;
    const attachments:PreparedMessage['attachments']=[];
    for(const [index,attachment] of message.attachments.entries()) {
      signal.throwIfAborted();
      const bytes=await this.client.download(attachment.path,attachment.name,signal);
      if(attachment.kind==='image' && !['image/png','image/jpeg','image/webp','image/gif'].includes(bytes.contentType))throw new Error('IMAGE_CONTENT_TYPE_MISMATCH');
      if(attachment.kind==='audio' && !bytes.contentType.startsWith('audio/'))throw new Error('AUDIO_CONTENT_TYPE_MISMATCH');
      const localPath=join(dir,`${randomUUID()}.media`);
      await writeFile(localPath,bytes.bytes,{mode:0o600});
      const a={...attachment,localPath};attachments.push(a);
      if(a.kind==='audio') {
        await probeAudio({path:localPath,name:a.name,mime:a.mime},{maxBytes:this.config.maxMediaBytes,maxDurationSeconds:this.config.maxAudioSeconds,timeoutMs:this.config.requestTimeoutMs,ffmpegPath:this.config.ffmpegPath,ffprobePath:this.config.ffprobePath,tempDir:dir},signal);
        const cached=job.preparedAudio?.[index], config=this.speechConfig();
        if(cached)Object.assign(a,cached);
        else if(transcribe && config.voiceEnabled && config.asrEnabled) {
          let result:{transcript?:string;error?:string};
          try{
            const provider=createAsrProvider({...speechOptions(config,this.ports.resolveCredential,'asr'),tempDir:dir});
            const transcript=await provider.transcribe({path:localPath,name:a.name,mime:a.mime},signal);result={transcript:transcript.text};
          }
          catch(error){if(signal.aborted)throw error;const code=error instanceof AudioError?error.code:'ASR_FAILED';result={error:code};this.log.warn(code);}
          Object.assign(a,result);
          await this.store.transaction(async()=>{job.preparedAudio??={};job.preparedAudio[index]=result;await this.store.save();});
        }
      }
    }
    return {...message,attachments};
  }
  private async assertReplyDestination(destination:Destination,replyTo:number,signal:AbortSignal) {
    // The reply endpoint derives its destination from MID, bypassing send_to_*.
    // Prove that MID belongs to the allowlisted destination before any output.
    const known=this.store.jobs.find(job=>job.sourceKey===this.sourceKey() && job.message.id===String(replyTo));
    if(known) {
      if(known.message.destination.kind!==destination.kind || known.message.destination.id!==destination.id)throw new Error('REPLY_DESTINATION_MISMATCH');
      return;
    }
    const recent=await this.client.getHistory(destination,this.config.botUid,100,AbortSignal.any([signal,AbortSignal.timeout(this.config.historyTimeoutMs)]));
    if(!recent.some(message=>message.id===String(replyTo)))throw new Error('REPLY_TARGET_UNVERIFIED');
  }
  send(destination:Destination,message:OutboundMessage,options:{proactive?:boolean;replyTo?:number;signal?:AbortSignal;localFiles?:LocalFileResolver}={}) {
    const perform=async()=>{
      if(!this.running)throw new Error('BRIDGE_STOPPED');
      if(!allowedDestination(this.config,destination))throw new Error('DESTINATION_DENIED');
      if(options.proactive && !this.config.allowProactive)throw new Error('PROACTIVE_DISABLED');
      if(!message.text?.trim() && !message.attachments?.length && !message.speech?.text?.trim())throw new Error('EMPTY_MESSAGE');
      if(message.attachments && message.attachments.length>20)throw new Error('TOO_MANY_ATTACHMENTS');
      const signal=options.signal ? AbortSignal.any([options.signal,this.controller.signal]) : this.controller.signal;
      const replyTo=message.replyTo??options.replyTo;
      if(replyTo!==undefined && (!Number.isSafeInteger(replyTo)||replyTo<=0))throw new Error('INVALID_REPLY_ID');
      if(replyTo!==undefined)await this.assertReplyDestination(destination,replyTo,signal);
      const receipts:unknown[]=[];
      try {
      let speech;
      if(message.speech) {
        const config=this.speechConfig();
        if(!config.voiceEnabled || !config.ttsEnabled)throw new Error('TTS_DISABLED');
        if(typeof message.speech.text!=='string' || !message.speech.text.trim() || Array.from(message.speech.text).length>this.config.maxTextChars)throw new Error('INVALID_SPEECH_TEXT');
        const dir=join(this.config.tempDir,`job-${randomUUID()}`);this.activeTempDirs.add(dir);
        try {
          speech=await createTtsProvider({...speechOptions(config,this.ports.resolveCredential,'tts'),tempDir:dir})
            .synthesize(message.speech.text,{voice:message.speech.voice,instructions:message.speech.instructions,signal});
        }finally{await rm(dir,{recursive:true,force:true});this.activeTempDirs.delete(dir);}
      }
      const text=Array.from(message.text || '');
      for(let i=0;i<text.length;i+=this.config.textSegmentChars) {
        signal.throwIfAborted();receipts.push(await this.client.sendText(destination,text.slice(i,i+this.config.textSegmentChars).join(''),{replyTo:i===0?replyTo:undefined,format:message.format,signal}));
      }
      if(speech)receipts.push(await this.client.sendAudioBytes(destination,speech.bytes,{name:speech.name,mime:speech.mime},
        {replyTo:receipts.length?undefined:replyTo,signal}));
      for(const a of message.attachments||[]) {
        signal.throwIfAborted();
        receipts.push(await this.client.sendAttachment(destination,a,{replyTo:receipts.length?undefined:replyTo,signal,localFiles:options.localFiles,
          validate:a.kind==='audio'?async(bytes,name,mime)=>{
            const dir=join(this.config.tempDir,`job-${randomUUID()}`);this.activeTempDirs.add(dir);await mkdir(dir,{recursive:true,mode:0o700});
            try{const file=join(dir,'outgoing.media');await writeFile(file,bytes,{mode:0o600});await probeAudio({path:file,name,mime},{maxBytes:this.config.maxMediaBytes,maxDurationSeconds:this.config.maxAudioSeconds,timeoutMs:this.config.requestTimeoutMs,ffmpegPath:this.config.ffmpegPath,ffprobePath:this.config.ffprobePath,tempDir:dir},signal);}
            finally{await rm(dir,{recursive:true,force:true});this.activeTempDirs.delete(dir);}
          }:undefined}));
      }
      return receipts;
      } catch (cause) {
        if(!receipts.length)throw cause;
        const error=Object.assign(new Error(receipts.length?'PARTIAL_SEND_FAILED':'SEND_FAILED'),{sent:receipts.length>0,receipts});
        throw error;
      }
    };
    const result=this.outbound.then(perform);this.outbound=result.catch(()=>{});return result;
  }
  private async cleanup() {
    for(const entry of await readdir(this.config.tempDir,{withFileTypes:true})) {
      if(!entry.isDirectory() || !/^job-[a-f0-9-]{36}$/.test(entry.name))continue;
      const p=join(this.config.tempDir,entry.name);
      if(this.activeTempDirs.has(p))continue;
      try{if(Date.now()-(await stat(p)).mtimeMs>this.config.retentionMs)await rm(p,{recursive:true,force:true});}
      catch(error:any){if(error.code!=='ENOENT')throw error;}
    }
  }
}
