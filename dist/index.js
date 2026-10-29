import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { defaults, parseConfig, readConfig, speechFields } from "./config.js";
import { Bridge } from "./bridge.js";
import { DshSessionPort } from "./dsh.js";
import { registerVoceTools } from "./tools.js";
import { dirname, join } from 'node:path';
import { PluginSettings, createSettingsHandler, settingsPath } from "./settings.js";
import { AutoStartController, BridgeRuntime } from "./runtime.js";
export const name = 'vocechat-bridge';
export const inject = ['agents', 'tools', 'attachments'];
const descriptions = {
    enabled: '启用桥接（首次配置完成后再启用）', baseUrl: 'VoceChat 服务地址', botUid: '机器人 UID，用于自消息过滤',
    botApiKeyRef: 'Bot Key 的凭据引用名', webhookSecretRef: '可选 POST 访问令牌的凭据引用名；留空直接接收明文 JSON，与 VoceChat 可选的 AES secret 分开设置',
    userWhitelist: '允许私聊的 UID，空数组拒绝全部', groupWhitelist: '允许群聊的 GID，空数组拒绝全部',
    groupSenderWhitelist: '群内附加发送者 UID 限制，空数组允许已授权群内成员',
    targetSessionId: '固定 DSH Session ID', agentPreset: '恢复会话使用的可选 preset',
    allowedLocalRoots: 'Agent 允许发送的本地文件根目录；默认禁止', allowedRemoteOrigins: '允许发送的远程媒体来源；仍禁止私网地址',
    voiceEnabled: '语音服务总开关；关闭后停止识别和合成调用，原始音频仍作为附件收发',
    asrEnabled: '启用入站语音转写', asrProvider: '识别厂家：OpenAI 标准接口或小米 MiMo',
    asrBaseUrl: '识别 API base；留空使用所选厂家官方地址', asrModel: '识别模型；留空按厂家使用默认模型',
    asrApiKeyRef: '识别 Key 的凭据引用名；自定义的无鉴权 OpenAI 兼容服务可留空',
    allowProactive: '允许固定 Session 的非 VoceChat 轮主动发消息',
    privateQuietMs: '私聊静默防抖毫秒数；新消息重置，默认 4000', groupQuietMs: '群聊静默防抖毫秒数；新消息重置，默认 1500',
    maxWaitMs: '从批次首条消息开始的最长封批等待，默认 12000 毫秒；DSH 忙时封批后继续排队',
    mergeWindowMs: '旧参数兼容：0 停用；非零时覆盖私聊和群聊静默时长，建议使用新参数',
    ttsEnabled: '允许 Agent 按需合成语音，不会自动朗读每条回复', ttsProvider: '合成厂家：OpenAI 标准接口或小米 MiMo',
    ttsBaseUrl: '合成 API base；留空使用所选厂家官方地址', ttsModel: '合成模型；留空按厂家使用默认模型',
    ttsApiKeyRef: '合成 Key 的凭据引用名', ttsVoice: '音色 ID；留空使用厂家默认音色',
    ttsInstructions: '声线、语气和风格描述；MiMo voicedesign 必填', ttsFormat: '合成音频格式', ttsTimeoutMs: '合成超时（毫秒）',
    audioUnderstandingProvider: '音频理解扩展保留，内置实现留空',
};
export const Config = Schema.object(Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    let schema = Array.isArray(value) ? Schema.array(['userWhitelist', 'groupWhitelist', 'groupSenderWhitelist'].includes(key) ? Schema.number() : Schema.string()) : typeof value === 'boolean' ? Schema.boolean() : typeof value === 'number' ? Schema.number() : Schema.string();
    if (key === 'asrProvider' || key === 'ttsProvider')
        schema = Schema.union((key === 'ttsProvider' ? ['', 'openai', 'mimo'] : ['openai', 'mimo']).map(value => Schema.const(value)));
    if (key === 'ttsFormat')
        schema = Schema.union(['wav', 'mp3'].map(value => Schema.const(value)));
    if (key === 'asrTimeoutMs' || key === 'ttsTimeoutMs')
        schema = schema.min(1).max(0xffffffff).step(1);
    if (key.endsWith('Ref'))
        schema = schema.role('credential-ref');
    schema = schema.default(value).description(descriptions[key] || key);
    if (speechFields.includes(key))
        schema = schema.volatile();
    return [key, schema];
})));
export function apply(ctx, rawConfig) {
    const config = parseConfig(readConfig(rawConfig));
    ctx.inject?.(['settings'], (settingsCtx) => settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber)));
    const hostLog = typeof ctx.logger === 'function' ? ctx.logger(name) : console;
    const levels = ['debug', 'info', 'warn', 'error'];
    const logger = Object.fromEntries(levels.map((level, i) => [level, (message) => {
            if (i >= levels.indexOf(config.logLevel))
                hostLog[level]?.(message);
        }]));
    const resolveCredential = async (ref) => {
        if (!ref)
            return undefined;
        try {
            const service = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials;
            const result = service?.resolve ? await service.resolve(ref) : undefined;
            if (typeof result === 'string' && result)
                return result;
            if (result && typeof result.value === 'string' && result.value)
                return result.value;
            return process.env[ref] || undefined;
        }
        catch {
            throw new Error('CREDENTIAL_RESOLUTION_FAILED');
        }
    };
    const settings = new PluginSettings(join(dirname(config.statePath), 'settings.json'), () => readConfig(rawConfig));
    const ready = settings.load();
    const runtime = new BridgeRuntime(() => settings.config(), current => {
        const session = new DshSessionPort(ctx, { targetSessionId: current.targetSessionId, agentPreset: current.agentPreset,
            turnTimeoutMs: current.turnTimeoutMs, maxAttachmentBytes: current.maxMediaBytes }, { createUserMessage });
        return { session, bridge: new Bridge(current, { session, resolveCredential, logger, speechConfig: () => settings.raw() }) };
    });
    const autoStart = new AutoStartController({ ready, enabled: () => settings.config().enabled, runtime,
        onError: code => logger.warn(`BRIDGE_AUTO_START_WAITING: ${code}`) });
    registerVoceTools(ctx, runtime, runtime.session, defineTool);
    // Match dsh-bili-scroll: the settings API belongs to DSH's web server, not to
    // the bridge listener, so a stopped bridge can still be configured and started.
    const handler = createSettingsHandler({ settings, ready, runtime, resolveCredential, credentials: () => {
            try {
                return typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials;
            }
            catch {
                return undefined;
            }
        } });
    ctx.inject?.(['credentials'], () => { void autoStart.wake(); });
    ctx.inject?.(['webServer'], (scoped) => {
        void autoStart.wake();
        return scoped.effect(() => scoped.webServer.register({ kind: 'exact', path: settingsPath, handler }));
    });
    // Cordis awaits async effects before installing their disposer. Return it immediately
    // so disable during startup is also safe and cannot leave a listening socket behind.
    ctx.effect(() => {
        const start = autoStart.wake().catch(() => logger.error('BRIDGE_START_FAILED: check settings and host services'));
        return async () => { await autoStart.dispose(); await start; await runtime.dispose(); };
    });
    return runtime;
}
