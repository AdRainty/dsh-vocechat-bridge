// DSH serves client exports through its module loader; React and host services are shared.
window.__ModuleLoader__.load({
  id: 'dsh-vocechat-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'vocechat.speech';
    const vendors = {
      openai: {label:'OpenAI 标准接口',base:'https://api.openai.com/v1',asr:'whisper-1',tts:'gpt-4o-mini-tts',voice:'alloy',key:'OPENAI_API_KEY'},
      mimo: {label:'小米 MiMo',base:'https://api.xiaomimimo.com/v1',asr:'mimo-v2.5-asr',tts:'mimo-v2.5-tts',voice:'mimo_default',key:'MIMO_API_KEY'},
    };
    const inputStyle = {width:'100%',boxSizing:'border-box',padding:'8px 10px',borderRadius:6,
      border:'1px solid var(--dsw-alias-border-primary, #666)',background:'var(--dsw-alias-surface-primary, transparent)',color:'inherit'};
    const fieldStyle = {display:'grid',gap:6,fontSize:13};
    const hintStyle = {fontSize:12,opacity:.7,lineHeight:1.6};

    function SpeechSettings({view,scope,credentials}) {
      const snapshot = React.useSyncExternalStore(fn=>scope.subscribe(fn),()=>scope.getSnapshot());
      const [draft,setDraft] = React.useState({});
      const [keys,setKeys] = React.useState({asr:'',tts:''});
      const [configured,setConfigured] = React.useState({});
      const [saving,setSaving] = React.useState(false);
      const [notice,setNotice] = React.useState('');
      const value = {...snapshot.value,...draft};
      const disabled = saving || !snapshot.writable || snapshot.status !== 'ready';
      const edit = (key,next) => {setDraft(previous=>({...previous,[key]:next}));setNotice('');};
      const vendor = mode => vendors[value[`${mode}Provider`]] || vendors.openai;
      const keyRef = mode => value[`${mode}ApiKeyRef`] || (value[`${mode}BaseUrl`] && value[`${mode}Provider`] !== 'mimo' ? '' : vendor(mode).key);
      const asrRef = keyRef('asr'), ttsRef = keyRef('tts');
      React.useEffect(()=>{
        let alive = true;
        const refs = [...new Set([asrRef,ttsRef].filter(Boolean))];
        if (refs.length) credentials.describe(refs).then(result=>{
          if(alive && result.ok)setConfigured(result.value);
        }).catch(()=>{});
        return ()=>{alive=false;};
      },[credentials,asrRef,ttsRef]);
      if(view === 'summary')return '配置 OpenAI / 小米 MiMo 的识别和合成；语音输入保留原文件与转写。';
      if(snapshot.status === 'unavailable')return h('p',null,'插件尚未加载，暂时无法配置。');

      const field = (key,label,placeholder='',hint='',type='text') => h('label',{key,style:fieldStyle},label,
        h('input',{style:inputStyle,value:value[key] ?? '',type,disabled,placeholder,
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
      const keyField = mode => h('label',{style:fieldStyle},'API Key',h('input',{
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
      const save = async()=>{
        setSaving(true);setNotice('');
        try {
          for(const mode of ['asr','tts']) {
            const base=value[`${mode}BaseUrl`];
            if(base){let url;try{url=new URL(base);}catch{throw new Error('请填写有效的 HTTP(S) API 根地址。');}
              if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('API 地址不能包含凭据、查询参数或片段。');}
            const timeout=value[`${mode}TimeoutMs`];
            if(!Number.isInteger(timeout)||timeout<1||timeout>0xffffffff)throw new Error('超时请填写有效的正整数毫秒数。');
          }
          if(value.asrProvider==='mimo' && value.asrEnabled && !['','auto','zh','en'].includes(value.asrLanguage || ''))throw new Error('MiMo 识别语言请填写 auto、zh 或 en。');
          if(value.ttsProvider==='mimo' && value.ttsEnabled && (value.ttsModel || '').includes('voicedesign') && !value.ttsInstructions?.trim())throw new Error('MiMo 音色设计需要填写声线与语气描述。');
          if(asrRef && asrRef===ttsRef && keys.asr && keys.tts && keys.asr!==keys.tts)throw new Error('同一凭据引用的两个 Key 不一致。');
          for(const mode of ['asr','tts'])if(keys[mode]) {
            if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyRef(mode)))throw new Error('请填写有效的 Key 凭据引用名。');
            const result=await credentials.set(keyRef(mode),keys[mode]);
            if(!result.ok)throw new Error('Key 保存失败，请检查 DSH 凭据库是否可写。');
          }
          if(Object.keys(draft).length && !await scope.mutate(Object.entries(draft).map(([field,next])=>({op:'set',path:[field],value:next})),snapshot.revision))throw new Error('配置保存失败或已被其他页面修改，请重新加载后重试。');
          setDraft({});setKeys({asr:'',tts:''});setNotice('已保存，下一次语音请求生效。');
          const refs=[...new Set([asrRef,ttsRef].filter(Boolean))];
          if(refs.length){const result=await credentials.describe(refs);if(result.ok)setConfigured(result.value);}
        } catch(error) { setNotice(error instanceof Error?error.message:'保存失败，请重试。'); }
        finally { setSaving(false); }
      };
      return h('div',{style:{display:'grid',gap:18,maxWidth:680,color:'inherit'}},
        h('p',{style:hintStyle},'识别和合成可分别开启。输入会作为同一条用户消息交给 DSH，包含原音频文件及对应的转写文字。合成由 Agent 按需调用，不会自动朗读每条回复。'),
        toggle('voiceEnabled','启用语音服务（识别与合成总开关）'),
        section('asr','语音识别'),section('tts','语音合成'),
        !snapshot.writable && h('p',{role:'status'},'当前部署的设置为只读。'),
        h('div',{style:{display:'flex',gap:12}},h('button',{type:'button',disabled:disabled || (!Object.keys(draft).length && !keys.asr && !keys.tts),onClick:save},saving?'保存中…':'保存'),
          h('button',{type:'button',disabled:saving,onClick:()=>{setDraft({});setKeys({asr:'',tts:''});setNotice('');}},'放弃修改')),
        notice && h('p',{role:'status',style:hintStyle},notice));
    }

    function apply(ctx) {
      const t=ctx.locale.bind(NS);
      ctx.effect(()=>ctx.locale.register(NS,{zh:{title:'VoceChat 语音'},en:{title:'VoceChat Speech'}}));
      const scope=ctx.configForms.get('vocechat-bridge');
      ctx.effect(()=>ctx.configForms.whileServed(['vocechat-bridge'],()=>ctx.slots.inject('plugins.item',()=>ctx.slots.register({
        name:'plugins.item',id:'vocechat-speech',order:65,label:()=>t('title'),locale:NS,
        inject:()=>({scope,credentials:ctx.remote.credentials}),
      },SpeechSettings))));
    }
    return {apply,inject:['slots','locale','remote','remote.credentials','configForms']};
  },
});
