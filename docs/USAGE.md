# 安装与运行

要求 DSH 0.2.1-rc.3、Node.js 22.19+。插件直接使用宿主的 `agents`、`tools`、`attachments` 服务，不连接 DSH Web RPC，不读取浏览器 cookie。压缩音频需要 FFprobe；格式转换需要 FFmpeg。PCM WAV 可以无外部解码器检查实际时长。

## 安装

仓库自带 `dist/`，可直接安装目录或 npm 包；开发修改后重新构建。安装会增加默认禁用的 `vocechat-bridge` 插件项，不覆盖原桥接。

```powershell
cd K:\Code\Tools\dsh-plugins\dsh-vocechat-bridge
npm ci --legacy-peer-deps
npm run check
npm pack
dsh plugin --profile web add "K:\Code\Tools\dsh-plugins\dsh-vocechat-bridge"
```

也可以把 `dsh-vocechat-bridge-0.3.0.tgz` 交给 DSH 插件安装器。安装与配置后重启对应 DSH profile。开发链接安装时，宿主依赖必须能从插件的真实路径解析；遵循宿主安装器解析 peer dependencies 的方式，若手工建立依赖链接，指向实际 profile 的 `node_modules/@deepseek-ai`，不要复制凭据文件。

本次交付没有执行上述安装命令，也没有变更已运行的 profile。`npm ci --legacy-peer-deps` 用于独立开发和测试；运行插件时三个 peer dependency 由 DSH 提供。

## 最小配置

将 [config.example.yml](../config.example.yml) 的连接项合并到 profile 的 `cordis.patch.yml`，填写实际服务地址、机器人 UID、固定 Session ID 和白名单；这些连接项保存后重启生效。语音选项通过 DSH 侧栏 **插件 → VoceChat 语音** 设置，选择厂家、模型、Key、音色并分别启用识别/合成。语音字段使用宿主的 volatile Config 和设置持久化，保存后下一次请求生效；总开关关闭时停止语音模型调用，仍保留原音频附件。设置页的安装入口固定为 bundle 中的 `id: vocechat-bridge`。

敏感值仅存 DSH credentials 或进程环境。配置中的 `botApiKeyRef`、`webhookSecretRef`、`asrApiKeyRef`、`ttsApiKeyRef` 填的是**引用名**。语音设置页的密码输入框通过 DSH credentials 保存实际 Key，不读取已有密钥。credentials 服务存在时优先解析；未解析到再读取同名环境变量。每次请求重新解析，可以轮换凭据。自定义 OpenAI 兼容的无鉴权本地服务允许空引用。

Webhook 建议绑定 loopback，由反向代理转发。精确 Webhook 路径的 GET 无需鉴权，直接返回 200，供 VoceChat 验证地址；该请求不接收消息、不返回会话数据。POST 投递要求共享 secret：支持 `Authorization: Bearer <secret>`，或在 VoceChat 的 Webhook URL 配置 `https://桥接入口/vocehook?secret=<secret>`。反向代理可代为注入 Authorization，避免 URL 中保存密钥；配置代理访问日志时应隐藏 query。插件日志不记录 URL、请求体或凭据。后台验证成功只证明 GET 可达，还需发送测试消息确认 POST 的鉴权参数确实被保留。

VoceChat 后台的 **16 字节 secret 是可选的消息加密设置**，留空即推送明文 JSON；设置后需要接收端先 AES 解密，再做 PKCS7 去填充。当前插件接收明文，所以该字段留空。URL 中的 `?secret=...` 或 Authorization 是插件自己的 POST 访问令牌，长度不受 16 字节限制，不要把它填进 VoceChat 的 AES secret 栏。二者分开配置，并通过 HTTPS/受信任本地代理传输；接收端令牌使用独立的强随机值。

首次配置完成后，将 `enabled` 改为 `true`。默认端口 **8898**，与旧桥接的 **8899** 分开。空白名单拒绝全部对应渠道：私聊使用 UID；群聊使用 GID。`groupSenderWhitelist` 可进一步限制授权群中的成员，空数组代表不加这一层限制。

## 配置项

完整默认值以 `src/config.ts` 为准，示例包含所有可配置项。

| 项目 | 默认及说明 |
| --- | --- |
| `enabled` | `false`，启用前校验基址、Bot UID、Session 与凭据引用 |
| `baseUrl`, `botUid` | VoceChat 基址与机器人自身 UID；`botUid` 用于回环保护 |
| `botApiKeyRef`, `webhookSecretRef` | 默认 `VOCECHAT_BOT_API_KEY` / `VOCECHAT_WEBHOOK_SECRET` |
| `webhookHost`, `webhookPort`, `webhookPath` | `127.0.0.1`, `8898`, `/vocehook`；精确匹配路径 |
| `userWhitelist`, `groupWhitelist`, `groupSenderWhitelist` | 数字 ID 数组；前两个默认拒绝，第三个是可选附加限制 |
| `targetSessionId`, `agentPreset` | 固定已有会话；preset 留空时从持久会话恢复 |
| `autoReply`, `allowProactive` | `true`, `false`；普通回复自动发送最终 step 文本；主动发送需要显式启用 |
| `allowedLocalRoots`, `allowedRemoteOrigins` | 均 `[]`，默认禁止 Agent 出站本地/远程媒体；配置只允许需要的目录及精确 HTTP(S) origin |
| `requestTimeoutMs`, `turnTimeoutMs` | `30000`, `180000`，分别控制 API 及实际提交后的会话轮次；等待共享 Session 空闲不消耗 turnTimeoutMs |
| `maxMediaBytes`, `maxAudioSeconds` | `26214400`, `300`，检查实际字节及音频时长 |
| `maxBodyBytes`, `maxTextChars` | `262144`, `16000`，拒绝过大入站，不静默截断 |
| `textSegmentChars` | `2000`，按 Unicode code point 分段发长文本 |
| `privateQuietMs`, `groupQuietMs` | `4000`, `1500`；私聊/群聊静默防抖，新消息重置本缓冲区计时 |
| `maxWaitMs`, `maxBatch` | `12000`, `10`；从批次首条消息起最长等待 12 秒；达到条数上限也会提前封批 |
| `mergeWindowMs` | 旧配置兼容项，默认 `0` 停用；非零时覆盖两类静默时长，升级后建议删除此旧字段 |
| `maxQueue`, `maxHistory` | `200`, `5000`；队列满返回 503；完成记录及去重窗口受历史条数上限限制 |
| `statePath`, `tempDir` | 默认 `$DSH_HOME/vocechat-bridge/state.json` 与 `tmp`；没有 DSH_HOME 则用用户 `.dsh` |
| `dedupTtlMs`, `retentionMs` | 均 `86400000`；消息记录保留两者较大值，历史条数仍有上限；媒体任务结束即清临时文件 |
| `logLevel` | `info`，可选 `debug/info/warn/error`，只输出操作与安全错误码 |
| `voiceEnabled` | `true`，语音模型调用总开关；ASR/TTS 默认仍关闭 |
| `asrEnabled`, `asrProvider` | `false`, `openai`；厂家可选 `openai` / `mimo` |
| `asrBaseUrl`, `asrModel` | 留空跟随厂家；标准 OpenAI 默认 `whisper-1`，MiMo 默认 `mimo-v2.5-asr` |
| `asrApiKeyRef`, `asrLanguage`, `asrTimeoutMs` | 空、空、`60000`；语言示例 `zh` |
| `asrAcceptedFormats` | `wav/mp3/ogg/m4a/flac/webm`；设为 `[wav]` 可强制其他格式先转换 |
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe`；可给可执行文件绝对路径 |
| `ttsEnabled`, `ttsProvider` | `false`, `openai`；启用后 Agent 可按需调用合成工具 |
| `ttsBaseUrl`, `ttsModel`, `ttsVoice` | 留空跟随厂家；OpenAI 默认 `gpt-4o-mini-tts` / `alloy`，MiMo 默认 `mimo-v2.5-tts` / `mimo_default` |
| `ttsApiKeyRef`, `ttsInstructions` | Key 引用与声线/语气描述；MiMo voicedesign 模型需要描述且不传 voice |
| `ttsFormat`, `ttsTimeoutMs` | `wav`, `120000`；格式可选 `wav` / `mp3` |
| `audioUnderstandingProvider` | 独立扩展保留，当前留空 |

## 消息工具

所有发送工具要求明确 `destination: {kind:'user'|'group', id:数字}`，只能由固定 Session 的真实 Agent 身份调用。目标仍需通过白名单。当前 VoceChat 轮向原目标发送属于回复；向别的目标发送、或 Web/QQ 轮发起发送属于主动发送，需要 `allowProactive:true`。

| 工具 | 参数 |
| --- | --- |
| `voce_send_text` | `destination`, `text`, 可选 `format: 'plain'|'markdown'`、`replyTo` |
| `voce_send_image` | `destination`, `path` 或 `url` 二选一，可选 `name/mime/replyTo` |
| `voce_send_audio` | 同上；发送已有音频，不自动生成 TTS |
| `voce_speak` | `destination`, `text`, 可选 `voice/instructions/replyTo`；生成并发送语音，要求启用 TTS |
| `voce_send_file` | 同上，普通文件 |
| `voce_send_message` | `destination`, 可选 `text`, `format`, `speech`, `attachments`, `replyTo`；speech 包含 text，可选 voice/instructions |
| `voce_quiet` | 无参数，在当前 VoceChat 轮安静结束 |
| `voce_bridge_status` | 无参数，只返回生命周期、Session ID、队列数量和服务地址，不含凭据与消息正文 |

组合消息例子：

```json
{
  "destination": {"kind":"group","id":10},
  "text":"说明与附件",
  "attachments":[
    {"kind":"image","path":"K:/Shared/vocechat-outgoing/chart.png"},
    {"kind":"image","path":"K:/Shared/vocechat-outgoing/detail.jpg"},
    {"kind":"audio","path":"K:/Shared/vocechat-outgoing/answer.wav"}
  ]
}
```

文字默认 `format: 'plain'`；发送原生 Markdown 时显式设置 `format: 'markdown'`，插件使用 `text/markdown`，无需添加引用消息。自动文本回复仍默认普通文本。长文本按 `textSegmentChars` 分段，复杂 Markdown 的代码块或表格宜由调用方按逻辑段发送，避免语法跨越多个消息气泡。

包含 `speech` 时先完成合成及音频校验，再依次发送文字、合成语音、数组中的附件；附件最多 20 项。平台不能在单个气泡中混放这些内容，所以会拆成多条相邻消息。成功工具发送抑制本轮重复自动回复。部分成功时错误带 `sent:true` 和已经确认的 `receipts`，不会自动重发已有片段。合成音频直接从受限的 Provider 字节发送，不需要开放临时目录给 `allowedLocalRoots`。

`replyTo` 使用 Bot API 可实现的可见 Markdown 消息 ID 引用，不是原生引用气泡。仅附件回复时先发引用文字，再发附件。音频优先 `vocechat/audio`，明确 HTTP 415 时以普通音频文件降级，并返回 `audioFallback:true`。

## 持久化与异常恢复

每条合法消息先写状态文件再返回 202；重复或被过滤事件返回 202，非法事件 400、鉴权失败 401、体积超限 413、队列满或状态写入失败 503。VoceChat 是否重试失败 Webhook 由服务端决定；插件不能代替服务端保存尚未接收的事件。

Webhook 在本地持久化每条消息与所属缓冲区后才返回 202。缓冲键包含 VoceChat 服务/Bot、频道、目标 DSH Session、私聊/群聊目标和发送者；不同发送者不能合并。同一键的消息即使与其他来源交错到达，也按原始接收顺序合并。重复 ID 不入缓冲、不重置计时，也不触发第二次回复。

静默截止时间为 `min(末条接收时间 + 静默时长, 首条接收时间 + maxWaitMs)`。到期即持久化为不可追加的待提交批次；DSH 忙时独立计时仍继续，封批后排队。附件下载、ASR 和等待 DSH 空闲可能继续耗时，12 秒限制的是收集消息的防抖窗口。完整算法与状态说明见 [DEBOUNCE.md](DEBOUNCE.md)。

`pending` 消息及缓冲的首条/末条时间、截止时间、批次边界会在启动时恢复，不重新计算一整段等待。未提交的媒体准备与 ASR 结果可恢复；只有实际提交前才落盘 `dispatching`。该阶段崩溃后记为 `uncertain`，不自动重放。处理完成后从完成时间继续保留去重记录，受 `dedupTtlMs`、保留时间和 `maxHistory` 上限约束。

恢复时保留原会话归属；更换 Session、服务/Bot 或收紧白名单后，不匹配的批次继续保留并计入状态工具的 `blockedBatches`，不会投给新目标。状态格式自动从 v1 升级为 v2，升级与回滚前先备份，见防抖文档。不要在运行时手工修改状态文件，也不要把同一个状态文件交给多个插件实例。

临时目录仅清理插件生成的 `job-UUID` 子目录；任务结束立即删除，启动和周期扫描清理过期残留，并跳过活动任务。原始媒体存入 DSH durable attachment 后按宿主的附件保留规则管理。状态文件含聊天正文与来源，应该按聊天数据保护其目录权限。

共享会话由宿主唯一 Agent driver 处理，桥接等待当前 Web/QQ 队列空闲后使用 `followup`，不抢占。若其他渠道强制插入同轮，来源混合时停止外发。取消只停止桥接等待和发送，不取消其他渠道的 Agent 工作。图片理解需要目标会话模型支持图片；音频在当前 DSH 版本中以真实转写文本加原音频文件表示。
