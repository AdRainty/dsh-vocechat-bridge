import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { defaults, parseConfig } from './config.ts';
import { Bridge } from './bridge.ts';
import { DshSessionPort } from './dsh.ts';
import { registerVoceTools } from './tools.ts';
import type { Logger } from './types.ts';

export const name = 'vocechat-bridge';
export const inject = ['agents', 'tools', 'attachments'];
const descriptions: Record<string,string> = {
  enabled:'启用桥接（首次配置完成后再启用）',baseUrl:'VoceChat 服务地址',botUid:'机器人 UID，用于自消息过滤',
  botApiKeyRef:'Bot Key 的凭据引用名',webhookSecretRef:'接收端 POST 访问令牌的凭据引用名；与 VoceChat 可选的 16 字节 AES secret 分开设置',
  userWhitelist:'允许私聊的 UID，空数组拒绝全部',groupWhitelist:'允许群聊的 GID，空数组拒绝全部',
  groupSenderWhitelist:'群内附加发送者 UID 限制，空数组允许已授权群内成员',
  targetSessionId:'固定 DSH Session ID',agentPreset:'恢复会话使用的可选 preset',
  allowedLocalRoots:'Agent 允许发送的本地文件根目录；默认禁止',allowedRemoteOrigins:'允许发送的远程媒体来源；仍禁止私网地址',
  asrBaseUrl:'兼容转写接口的 API base，例如本地服务 /v1',asrApiKeyRef:'ASR API Key 凭据引用名，本地无鉴权服务可留空',
  allowProactive:'允许固定 Session 的非 VoceChat 轮主动发消息',
  ttsProvider:'扩展保留，内置实现留空',audioUnderstandingProvider:'扩展保留，内置实现留空',
};
export const Config = Schema.object(Object.fromEntries(Object.entries(defaults).map(([key,value])=> {
  let schema: any = Array.isArray(value) ? Schema.array(['userWhitelist','groupWhitelist','groupSenderWhitelist'].includes(key)?Schema.number():Schema.string()) : typeof value==='boolean'?Schema.boolean():typeof value==='number'?Schema.number():Schema.string();
  if(key.endsWith('Ref'))schema=schema.role('credential-ref');
  return [key,schema.default(value).description(descriptions[key] || key)];
})));

export function apply(ctx: any, rawConfig: any) {
  const config=parseConfig(rawConfig);
  const hostLog=typeof ctx.logger==='function'?ctx.logger(name):console;
  const levels=['debug','info','warn','error'];
  const logger=Object.fromEntries(levels.map((level,i)=>[level,(message:string)=>{
    if(i>=levels.indexOf(config.logLevel))hostLog[level]?.(message);
  }])) as unknown as Logger;
  const resolveCredential=async(ref:string):Promise<string|undefined>=>{
    if(!ref)return undefined;
    try {
      const service=typeof ctx.get==='function'?ctx.get('credentials'):ctx.credentials;
      const result=service?.resolve?await service.resolve(ref):undefined;
      if(typeof result==='string' && result)return result;
      if(result && typeof result.value==='string' && result.value)return result.value;
      return process.env[ref] || undefined;
    }catch{throw new Error('CREDENTIAL_RESOLUTION_FAILED');}
  };
  const session=new DshSessionPort(ctx,{targetSessionId:config.targetSessionId,agentPreset:config.agentPreset,
    turnTimeoutMs:config.turnTimeoutMs,maxAttachmentBytes:config.maxMediaBytes},{createUserMessage});
  const bridge=new Bridge(config,{session,resolveCredential,logger});
  registerVoceTools(ctx,bridge,session,defineTool);
  // Cordis awaits async effects before installing their disposer. Return it immediately
  // so disable during startup is also safe and cannot leave a listening socket behind.
  ctx.effect(()=>{
    let disposed=false;
    const start=bridge.start().then(async()=>{if(disposed)await bridge.stop();}).catch(()=>logger.error('BRIDGE_START_FAILED: check configuration, credentials, state file and webhook port'));
    return async()=>{disposed=true;await start;await bridge.stop();session.dispose();};
  });
  return bridge;
}
