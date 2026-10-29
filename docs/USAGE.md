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

也可以把 `dsh-vocechat-bridge-0.1.0.tgz` 交给 DSH 插件安装器。安装与配置后重启对应 DSH profile。开发链接安装时，宿主依赖必须能从插件的真实路径解析；遵循宿主安装器解析 peer dependencies 的方式，若手工建立依赖链接，指向实际 profile 的 `node_modules/@deepseek-ai`，不要复制凭据文件。

本次交付没有执行上述安装命令，也没有变更已运行的 profile。`npm ci --legacy-peer-deps` 用于独立开发和测试；运行插件时三个 peer dependency 由 DSH 提供。

## 最小配置

将 [config.example.yml](../config.example.yml) 的对应项合并到 profile 的 `cordis.patch.yml`，或通过宿主按 Config schema 提供的配置入口填写。需要替换实际服务地址、机器人 UID、固定 Session ID 和白名单。原子覆盖整个 config 的宿主版本，需要重述想保留的配置键。保存后重启生效。

敏感值仅存 DSH credentials 或进程环境。`botApiKeyRef`、`webhookSecretRef`、`asrApiKeyRef` 填的是**引用名**，不填实际 Key。credentials 服务存在时优先解析；未解析到再读取同名环境变量。每次请求重新解析，可以轮换凭据。ASR 自托管无鉴权服务允许空引用。

Webhook 建议绑定 loopback，由反向代理转发。精确 Webhook 路径的 GET 无需鉴权，直接返回 200，供 VoceChat 验证地址；该请求不接收消息、不返回会话数据。POST 投递要求共享 secret：支持 `Authorization: Bearer <secret>`，或在 VoceChat 的 Webhook URL 配置 `https://桥接入口/vocehook?secret=<secret>`。反向代理可代为注入 Authorization，避免 URL 中保存密钥；配置代理访问日志时应隐藏 query。插件日志不记录 URL、请求体或凭据。后台验证成功只证明 GET 可达，还需发送测试消息确认 POST 的鉴权参数确实被保留。

VoceChat 文档的 AES Webhook secret 是另一项协议，本插件当前接收明文 JSON，不支持 AES 密文，也没有把共享密钥假称平台签名。应关闭 VoceChat 的 AES 加密选项，并通过 HTTPS/受信任本地代理传输。使用强随机共享 secret。

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
| `requestTimeoutMs`, `turnTimeoutMs` | `30000`, `180000`，分别控制 API 及等待会话完成（含等待宿主空闲） |
| `maxMediaBytes`, `maxAudioSeconds` | `26214400`, `300`，检查实际字节及音频时长 |
| `maxBodyBytes`, `maxTextChars` | `262144`, `16000`，拒绝过大入站，不静默截断 |
| `textSegmentChars` | `2000`，按 Unicode code point 分段发长文本 |
| `mergeWindowMs`, `maxBatch` | `300`, `10`；按首条入队时间形成固定合并窗口，只合并同一发送者、同一目标的相邻消息 |
| `maxQueue`, `maxHistory` | `200`, `5000`；队列满返回 503；完成记录及去重窗口受历史条数上限限制 |
| `statePath`, `tempDir` | 默认 `$DSH_HOME/vocechat-bridge/state.json` 与 `tmp`；没有 DSH_HOME 则用用户 `.dsh` |
| `dedupTtlMs`, `retentionMs` | 均 `86400000`；消息记录保留两者较大值，历史条数仍有上限；媒体任务结束即清临时文件 |
| `logLevel` | `info`，可选 `debug/info/warn/error`，只输出操作与安全错误码 |
| `asrEnabled` | `false`，收到语音仍下载并检测；启用后才调用识别服务 |
| `asrBaseUrl`, `asrModel` | API base 默认为空，模型默认 `whisper-1`；兼容服务可指定自己的模型名 |
| `asrApiKeyRef`, `asrLanguage`, `asrTimeoutMs` | 空、空、`60000`；语言示例 `zh` |
| `asrAcceptedFormats` | `wav/mp3/ogg/m4a/flac/webm`；设为 `[wav]` 可强制其他格式先转换 |
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe`；可给可执行文件绝对路径 |
| `ttsProvider`, `audioUnderstandingProvider` | 保留空字符串；非空会明确拒绝未注册的配置，扩展见 PROVIDERS |

## 消息工具

所有发送工具要求明确 `destination: {kind:'user'|'group', id:数字}`，只能由固定 Session 的真实 Agent 身份调用。目标仍需通过白名单。当前 VoceChat 轮向原目标发送属于回复；向别的目标发送、或 Web/QQ 轮发起发送属于主动发送，需要 `allowProactive:true`。

| 工具 | 参数 |
| --- | --- |
| `voce_send_text` | `destination`, `text`, 可选 `replyTo` |
| `voce_send_image` | `destination`, `path` 或 `url` 二选一，可选 `name/mime/replyTo` |
| `voce_send_audio` | 同上；发送已有音频，不自动生成 TTS |
| `voce_send_file` | 同上，普通文件 |
| `voce_send_message` | `destination`, 可选 `text`, `attachments`, `replyTo`；每项附件包含 `kind`、`path` 或 `url` |
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

文字先发，附件按数组顺序逐一上传发送；一次最多 20 个附件。平台不能在单个气泡中混放这些内容，所以会拆成多条相邻消息。成功工具发送抑制本轮重复自动回复。部分成功时错误带 `sent:true` 和已经确认的 `receipts`，不会自动重发已有片段。

`replyTo` 使用 Bot API 可实现的可见 Markdown 消息 ID 引用，不是原生引用气泡。仅附件回复时先发引用文字，再发附件。音频优先 `vocechat/audio`，明确 HTTP 415 时以普通音频文件降级，并返回 `audioFallback:true`。

## 持久化与异常恢复

每条合法消息先写状态文件再返回 202；重复或被过滤事件返回 202，非法事件 400、鉴权失败 401、体积超限 413、队列满或状态写入失败 503。VoceChat 是否重试失败 Webhook 由服务端决定；插件不能代替服务端保存尚未接收的事件。

`pending` 会在启动时恢复；`processing` 重启后变为 `uncertain`。会话已经排队、输出或发送超时的情况也可能是不确定状态，不能自动重放。通过状态文件的消息 ID 与 VoceChat/DSH 记录核查后处理。媒体处理前失败记 `failed` 并保留安全错误码。不要在运行时手工修改状态文件，也不要把同一个状态文件交给多个插件实例。

临时目录仅清理插件生成的 `job-UUID` 子目录；任务结束立即删除，启动和周期扫描清理过期残留，并跳过活动任务。原始媒体存入 DSH durable attachment 后按宿主的附件保留规则管理。状态文件含聊天正文与来源，应该按聊天数据保护其目录权限。

共享会话由宿主唯一 Agent driver 处理，桥接等待当前 Web/QQ 队列空闲后使用 `followup`，不抢占。若其他渠道强制插入同轮，来源混合时停止外发。取消只停止桥接等待和发送，不取消其他渠道的 Agent 工作。图片理解需要目标会话模型支持图片；音频在当前 DSH 版本中以真实转写文本加原音频文件表示。
