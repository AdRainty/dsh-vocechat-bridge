// DSH serves client exports through its module loader; React and host services are shared.
window.__ModuleLoader__.load({
  id: 'dsh-vocechat-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/api/vocechat-bridge/settings';
    const messages = {
      LOCAL_REQUEST_REQUIRED:'请在本机 DSH 页面中修改设置。',SETTINGS_CONFLICT:'配置已被其他页面修改，请重新加载后重试。',
      INVALID_SETTINGS:'配置不完整或格式不正确，请检查服务地址、Bot UID、Session ID、白名单和语音参数。',
      CREDENTIALS_READ_ONLY:'DSH 凭据库不可写，可使用已有凭据或同名环境变量。',CREDENTIAL_WRITE_FAILED:'Key 保存失败，请检查 DSH 凭据库。',
      CREDENTIAL_VALUES_CONFLICT:'同一凭据引用的两个 Key 不一致。',BRIDGE_START_FAILED:'启动失败，请检查 Bot Key、Webhook 令牌和端口占用。',
      WEBHOOK_PORT_IN_USE:'监听端口已被占用，请修改端口，或先停止占用该端口的服务。',
      BRIDGE_CREDENTIAL_MISSING:'Bot API Key 未配置，请填写并保存后再启动。',
      WEBHOOK_CREDENTIAL_MISSING:'Webhook 访问令牌未配置；可关闭“校验 Webhook 访问令牌”使用明文模式，或填写令牌后启动。',
      SETTINGS_LOAD_FAILED:'插件本地设置文件无法读取，请检查 settings.json。',SETTINGS_OPERATION_FAILED:'操作未完成，请检查配置和目录权限。',
    };
    function createSettingsApi() {
      let snapshot={status:'loading',value:{},writable:false,credentials:{},runtime:{running:false}},loading,disposed=false;
      const listeners=new Set(),controller=new AbortController();
      const accept=body=>{if(disposed)return;snapshot={...body,status:'ready'};for(const fn of listeners)fn();};
      const request=async body=>{
        const response=await fetch(API,{credentials:'same-origin',signal:controller.signal,
          ...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{headers:{accept:'application/json'}})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok || data.ok!==true)throw new Error(messages[data.error] || `设置接口不可用（HTTP ${response.status}）。请确认插件后端已加载。`);
        accept(data);return true;
      };
      return {
        getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
        load(){return loading??=(request().catch(error=>{if(!disposed){snapshot={...snapshot,status:snapshot.status==='ready'?'ready':'unavailable',error:error.message};for(const fn of listeners)fn();}}).finally(()=>{loading=undefined;}));},
        mutate:(patch,keys,action,revision)=>request({set:patch,keys,action,revision}),
        dispose(){disposed=true;controller.abort();listeners.clear();},
      };
    }
    const vendors = {
      openai: {label:'OpenAI 标准接口',base:'https://api.openai.com/v1',asr:'whisper-1',tts:'gpt-4o-mini-tts',voice:'alloy',key:'OPENAI_API_KEY'},
      mimo: {label:'小米 MiMo',base:'https://api.xiaomimimo.com/v1',asr:'mimo-v2.5-asr',tts:'mimo-v2.5-tts',voice:'mimo_default',key:'MIMO_API_KEY'},
    };
    const inputStyle = {width:'100%',boxSizing:'border-box',padding:'8px 10px',borderRadius:6,
      border:'1px solid var(--dsw-alias-border-primary, #666)',background:'var(--dsw-alias-surface-primary, transparent)',color:'inherit'};
    const fieldStyle = {display:'grid',gap:6,fontSize:13};
    const hintStyle = {fontSize:12,opacity:.7,lineHeight:1.6,overflowWrap:'anywhere'};

    function SpeechSettings({view,scope}) {
      const snapshot = React.useSyncExternalStore(fn=>scope.subscribe(fn),()=>scope.getSnapshot());
      const [draft,setDraft] = React.useState({});
      const [keys,setKeys] = React.useState({asr:'',tts:'',bot:'',webhook:''});
      const [saving,setSaving] = React.useState(false);
      const [notice,setNotice] = React.useState('');
      const value = {...snapshot.value,...draft};
      const disabled = saving || !snapshot.writable || snapshot.status !== 'ready';
      const edit = (key,next) => {setDraft(previous=>({...previous,[key]:next}));setNotice('');};
      const vendor = mode => vendors[value[`${mode}Provider`]] || vendors.openai;
      const keyRef = mode => mode==='bot'?value.botApiKeyRef:mode==='webhook'?value.webhookSecretRef:
        value[`${mode}ApiKeyRef`] || (value[`${mode}BaseUrl`] && value[`${mode}Provider`] !== 'mimo' ? '' : vendor(mode).key);
      const configured=snapshot.credentials || {};
      React.useEffect(()=>{
        scope.load();const timer=setInterval(()=>scope.load(),3000);return()=>clearInterval(timer);
      },[scope]);
      if(view === 'summary')return '配置 OpenAI / 小米 MiMo 的识别和合成；语音输入保留原文件与转写。';
      if(snapshot.status === 'unavailable')return h('div',null,h('p',{role:'alert'},snapshot.error || '插件设置接口尚未加载。'),h('button',{onClick:()=>scope.load()},'重新读取'));

      const field = (key,label,placeholder='',hint='',type='text') => h('label',{key,style:fieldStyle},label,
        h('input',{style:inputStyle,value:Array.isArray(value[key])?value[key].join(', '):value[key] ?? '',type:type==='number'?'number':'text',disabled,placeholder,
          onChange:event=>edit(key,type==='number'?Number(event.target.value):event.target.value)}),
        hint && h('span',{style:hintStyle},hint));
      const toggle = (key,label) => h('label',{key,style:{display:'flex',gap:10,alignItems:'center',fontSize:13}},
        h('input',{type:'checkbox',checked:!!value[key],disabled,onChange:event=>edit(key,event.target.checked)}),label);
      const selectVendor = mode => h('label',{style:fieldStyle},'服务厂家',h('select',{
        style:inputStyle,value:value[`${mode}Provider`] || 'openai',disabled,onChange:event=>{
          const id=event.target.value, selected=vendors[id];
          setDraft(previous=>({...previous,[`${mode}Provider`]:id,[`${mode}BaseUrl`]:'',[`${mode}Model`]:'',
            [`${mode}ApiKeyRef`]:selected.key,...(mode==='tts'?{ttsVoice:''}:{asrLanguage:''})}));
          setKeys(previous=>({...previous,[mode]:''}));setNotice('');
        },
      },Object.entries(vendors).map(([id,item])=>h('option',{key:id,value:id},item.label))));
      const keyField = mode => h('label',{style:fieldStyle},mode==='bot'?'Bot API Key':mode==='webhook'?'Webhook 接收令牌':'API Key',h('input',{
        type:'password',autoComplete:'new-password',style:inputStyle,disabled:disabled || !keyRef(mode),value:keys[mode],
        placeholder:configured[keyRef(mode)]?.configured?'已配置；留空保留现有 Key':'填写后保存到 DSH 凭据库',
        onChange:event=>setKeys(previous=>({...previous,[mode]:event.target.value})),
      }),h('span',{style:hintStyle},keyRef(mode)?`凭据：${keyRef(mode)}；页面不会读取已有 Key。`:'无鉴权服务可留空；需要 Key 时请先填写凭据引用名。'));
      const section = (mode,title) => h('fieldset',{style:{border:'1px solid var(--dsw-alias-border-primary, #666)',borderRadius:8,padding:16,display:'grid',gap:14}},
        h('legend',{style:{padding:'0 6px',fontWeight:600}},title),
        toggle(`${mode}Enabled`,mode==='asr'?'启用语音识别':'启用语音合成'),selectVendor(mode),
        field(`${mode}BaseUrl`,'API 地址',vendor(mode).base,'留空使用厂家官方地址；自托管服务填写包含 /v1 的 API 根地址。'),
        field(`${mode}Model`,'模型',vendor(mode)[mode],'留空使用所选厂家的默认模型。'),
        field(`${mode}ApiKeyRef`,'Key 凭据引用名',vendor(mode).key),keyField(mode),
        ...(mode==='asr' ? [field('asrLanguage','识别语言','自动识别','MiMo 支持 auto / zh / en；OpenAI 可填写 zh、en 等语言代码。'),
          field('asrTimeoutMs','识别超时（毫秒）','60000','','number')]
          : [field('ttsVoice','音色',vendor(mode).voice,'MiMo voicedesign 模型使用下方声线描述，不传音色 ID。'),
            h('label',{style:fieldStyle},'声线与语气描述',h('textarea',{style:{...inputStyle,minHeight:100},disabled,
              value:value.ttsInstructions || '',placeholder:'描述声线、语速、语气；MiMo voicedesign 模型必填。',
              onChange:event=>edit('ttsInstructions',event.target.value)})),
            h('label',{style:fieldStyle},'输出格式',h('select',{style:inputStyle,disabled,value:value.ttsFormat || 'wav',
              onChange:event=>edit('ttsFormat',event.target.value)},h('option',{value:'wav'},'WAV'),h('option',{value:'mp3'},'MP3'))),
            field('ttsTimeoutMs','合成超时（毫秒）','120000','','number')]),
      );
      const save = async(action)=>{
        setSaving(true);setNotice('');
        try {
          if(action==='stop') {await scope.mutate({}, {},action,snapshot.revision);setNotice('桥接后端已停止，设置页仍可使用。');return;}
          for(const mode of ['asr','tts']) {
            const base=value[`${mode}BaseUrl`];
            if(base){let url;try{url=new URL(base);}catch{throw new Error('请填写有效的 HTTP(S) API 根地址。');}
              if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('API 地址不能包含凭据、查询参数或片段。');}
            const timeout=value[`${mode}TimeoutMs`];
            if(!Number.isInteger(timeout)||timeout<1||timeout>0xffffffff)throw new Error('超时请填写有效的正整数毫秒数。');
          }
          if(value.asrProvider==='mimo' && value.asrEnabled && !['','auto','zh','en'].includes(value.asrLanguage || ''))throw new Error('MiMo 识别语言请填写 auto、zh 或 en。');
          if(value.ttsProvider==='mimo' && value.ttsEnabled && (value.ttsModel || '').includes('voicedesign') && !value.ttsInstructions?.trim())throw new Error('MiMo 音色设计需要填写声线与语气描述。');
          for(const mode of ['asr','tts','bot','webhook'])if(keys[mode]) {
            if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyRef(mode)))throw new Error('请填写有效的 Key 凭据引用名。');
          }
          const patch={...draft};
          for(const key of ['userWhitelist','groupWhitelist','groupSenderWhitelist','allowedLocalRoots','allowedRemoteOrigins'])if(typeof patch[key]==='string') {
            const items=patch[key].split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
            if(key.endsWith('Whitelist')){if(items.some(s=>!/^\d+$/.test(s)||Number(s)<1))throw new Error('白名单请填写正整数 ID，用逗号分隔。');patch[key]=items.map(Number);}
            else patch[key]=items;
          }
          await scope.mutate(patch,keys,action,snapshot.revision);
          setDraft({});setKeys({asr:'',tts:'',bot:'',webhook:''});
          setNotice(action==='start'?'桥接后端已启动。':action==='reload'?'配置已保存，桥接后端已重载。':'已保存；语音下一次请求生效，连接参数更改后点击重载。');
        } catch(error) { setNotice(error instanceof Error?error.message:'保存失败，请重试。');await scope.load(); }
        finally { setSaving(false); }
      };
      return h('div',{style:{display:'grid',gap:18,maxWidth:680,color:'inherit'}},
        h('div',{style:{display:'grid',gap:10}},h('strong',null,snapshot.runtime?.running?'桥接后端：运行中':snapshot.runtime?.enabled?'桥接后端：等待自动启动':'桥接后端：已停止'),
          h('span',{style:hintStyle},snapshot.runtime?.address?`监听：${typeof snapshot.runtime.address==='object'?snapshot.runtime.address.address+':'+snapshot.runtime.address.port:snapshot.runtime.address}`:'设置页独立运行，可以先配置再启动后端。'),
          h('div',{style:{display:'flex',gap:10,flexWrap:'wrap'}},
            h('button',{type:'button',disabled:disabled || snapshot.runtime?.running,onClick:()=>save('start')},'启动桥接后端'),
            h('button',{type:'button',disabled:disabled || !snapshot.runtime?.running,onClick:()=>save('stop')},'停止'),
            h('button',{type:'button',disabled,onClick:()=>save('reload')},'保存并重载后端')),
          snapshot.runtime?.needsReload && h('p',{role:'status',style:hintStyle},'连接配置已修改，点击“保存并重载后端”生效。'),
          snapshot.runtime?.ingress && h('span',{style:hintStyle},`本次启动收到 ${snapshot.runtime.ingress.posts} 次 Webhook POST；最近响应 ${snapshot.runtime.ingress.lastHttpStatus ?? '暂无'}。`),
          snapshot.runtime?.ingress?.recent?.length>0 && h('details',null,h('summary',{style:hintStyle},'最近入站记录（仅 ID 和处理结果）'),
            h('pre',{style:{...hintStyle,whiteSpace:'pre-wrap'}},snapshot.runtime.ingress.recent.slice(-10).map(e=>
              `${new Date(e.at).toLocaleTimeString()}  消息 ${e.messageId ?? '-'} / UID ${e.senderId ?? '-'}  ${e.status}${e.reason?' / '+e.reason:''}`).join('\n'))),
          snapshot.runtime?.history?.lastError && h('p',{role:'status',style:hintStyle},`近期历史暂不可用：${snapshot.runtime.history.lastError}；新消息仍会正常提交。`),
          snapshot.runtime?.error && h('p',{role:'alert',style:hintStyle},messages[snapshot.runtime.error] || snapshot.runtime.error)),
        h('fieldset',{style:{border:'1px solid #8886',borderRadius:8,padding:16,display:'grid',gap:14}},
          h('legend',null,'VoceChat 连接与消息'),
          field('baseUrl','VoceChat 服务地址','https://chat.example.com'),field('botUid','机器人 UID','4','','number'),
          field('targetSessionId','DSH 目标 Session ID','已有会话的完整 ID'),
          field('botApiKeyRef','Bot Key 凭据引用名','VOCECHAT_BOT_API_KEY'),keyField('bot'),
          h('label',{style:{display:'flex',gap:10,alignItems:'center',fontSize:13}},h('input',{
            type:'checkbox',disabled,checked:!!value.webhookSecretRef,onChange:event=>{
              edit('webhookSecretRef',event.target.checked?'VOCECHAT_WEBHOOK_SECRET':'');
              if(!event.target.checked)setKeys(previous=>({...previous,webhook:''}));
            }}),'校验 Webhook 访问令牌（可选）'),
          h('span',{style:hintStyle},'不启用即可接收明文 JSON，不需要 Secret。VoceChat 后台的可选 AES 加密 Secret 也留空。'),
          ...(value.webhookSecretRef?[field('webhookSecretRef','可选访问令牌引用名','VOCECHAT_WEBHOOK_SECRET'),keyField('webhook')]:[]),
          field('webhookHost','Webhook 监听地址','127.0.0.1'),field('webhookPort','Webhook 端口','8898','','number'),field('webhookPath','Webhook 路径','/vocehook'),
          field('userWhitelist','私聊 UID 白名单','1, 2','逗号分隔；留空拒绝所有私聊。'),
          field('groupWhitelist','群聊 GID 白名单','10, 20','逗号分隔；留空拒绝所有群聊。'),
          toggle('autoReply','自动发送最终文字回复'),toggle('allowProactive','允许向白名单目标主动发送'),
          field('privateQuietMs','私聊静默（毫秒）','4000','','number'),field('groupQuietMs','群聊静默（毫秒）','1500','','number'),
          field('maxWaitMs','最长合并等待（毫秒）','12000','','number'),
          field('historyContextMessages','附带近期历史条数','6','0 关闭，最多 50；仅附带同一私聊或群聊、本批新消息之前的记录，作为背景。','number'),
          field('historyMaxChars','历史文本预算（字符）','12000','超限优先保留较新的消息，并标记截断。','number'),
          field('historyTimeoutMs','历史查询超时（毫秒）','5000','附带背景查询失败时继续处理当前新消息。','number')),
        h('p',{style:hintStyle},'识别和合成可分别开启。输入会作为同一条用户消息交给 DSH，包含原音频文件及对应的转写文字。合成由 Agent 按需调用，不会自动朗读每条回复。'),
        toggle('voiceEnabled','启用语音服务（识别与合成总开关）'),
        section('asr','语音识别'),section('tts','语音合成'),
        !snapshot.writable && h('p',{role:'status'},'当前部署的设置为只读。'),
        h('div',{style:{display:'flex',gap:12}},h('button',{type:'button',disabled:disabled || (!Object.keys(draft).length && !Object.values(keys).some(Boolean)),onClick:()=>save()},saving?'保存中…':'保存'),
          h('button',{type:'button',disabled:saving,onClick:()=>{setDraft({});setKeys({asr:'',tts:'',bot:'',webhook:''});setNotice('');}},'放弃修改')),
        notice && h('p',{role:'status',style:hintStyle},notice));
    }

    function apply(ctx) {
      const scope=createSettingsApi();
      ctx.effect(()=>()=>scope.dispose());
      const slots=ctx.get?.('slots') || ctx.slots;
      slots.inject('settings.section',()=>slots.register({name:'settings.section',id:'vocechat-bridge',order:65,label:'VoceChat'},
        ()=>h(SpeechSettings,{scope})));
    }
    return {name:'dsh-vocechat-bridge',apply,inject:['slots']};
  },
});
