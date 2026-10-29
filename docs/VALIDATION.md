# 验证记录与限制

日期：2026-10-29，Windows，Node.js **22.19.0**，TypeScript **5.9.3**。本机 DSH 发行版本 **0.2.1-rc.3**。

## 自动化与本机运行

v0.3.1 执行 `npm run check`：TypeScript 严格编译通过，**100 项自动化测试通过，0 失败，0 跳过**。语音版本增加两项功能测试，设置页修复增加两项 API/生命周期功能测试，另为用户反馈补一项冷启动回归，其余复用原有套件。

| 套件 | 数量 | 验证内容 |
| --- | ---: | --- |
| `audio.test.ts` | 15 | 文件 magic、WAV 实际时长、压缩格式探测、大小/时长限制、multipart ASR、无鉴权本地服务、HTTP/连接/格式错误、超时取消、凭据去敏、真实 FFmpeg 转码及清理 |
| `bridge.test.ts` | 31 | Webhook 无鉴权 GET 验证与 POST 鉴权、文本/Markdown 出站、私聊/群聊、白名单/去重、持久 ACK、防抖与忙碌封批、背压、语音成功失败、图片/文件入站、组合发送、部分成功、停止屏障、崩溃前转写缓存、目标会话变更隔离及长期缓冲去重 |
| `dsh.test.ts` | 19 | 固定 Session、宿主忙碌队列、单批单条用户消息、提交屏障与超时边界、消息 ID/turn 归属、其他渠道混入、原生附件、冷恢复模型/preset、lease 释放、工具来源身份、quiet、失败与取消 |
| `vocechat.test.ts` | 12 | 官方端点、原生 Markdown 及格式校验、Base64 X-Properties、实际 multipart 字节、音频 415 降级、资源路径、本地 realpath 白名单、格式/大小/上传异常、公网地址与 origin 拒绝、禁止重定向、响应流超时 |
| `live-webhook.test.ts` | 4 | 隔离接收程序的 GET/POST 行为、诊断记录脱敏、禁止真实 DSH/ASR/发送、媒体开关与音频探测、明文审计，以及终止子进程后的缓冲恢复/重复投递 |
| `debounce.test.ts` | 14 | 固定时间验证 4s/1.5s/12s 默认值、静默重置、最长等待、独立键与交错顺序、封批上限、磁盘时间戳/附件/ASR 保留、提交前恢复、提交后隔离、v1 升级及完成后去重保留 |
| `speech.test.ts` | 2 | MiMo 请求和真实 16 kHz 单声道 WAV 归一化、原文件不变；OpenAI/MiMo 两家 TTS 到 VoceChat 语音发送闭环、实时配置与关闭开关、暂存清理 |
| `settings.test.ts` | 3 | 设置 API 启动/重载/停止真实本地监听、无 Secret 启动并接受明文 POST、停止后设置仍可用、配置重启保留、实例代理更新与卸载防重启；跨来源/非 JSON/过期版本/无效配置拒绝及密钥不回传；模拟冷启动时凭据迟到，验证持久 enabled 恢复、启动重试与停止后取消 |

测试启动真实的本地 HTTP Mock VoceChat/ASR 服务，使用假的 DSH 会话进行闭环。没有把 Mock 的固定转写结果当成真实语音识别能力。ASR provider 确实发送 multipart 文件并解析服务响应，但本次没有启动 Whisper 模型或请求云端模型。

本机已经实际运行 FFprobe/FFmpeg：生成 FLAC，检测容器与时长，转换 16kHz 单声道 PCM WAV，检查输出超限拒绝以及临时文件清理。缺失 FFprobe/FFmpeg 分支也有明确错误测试。

测试按文件串行执行并设置 30 秒上限；这台 Windows/Node 环境并行运行多个测试进程时曾出现关闭本地 Mock 连接等待不结束，改为串行后完整套件正常退出。桥接自身的消息并发仍有独立测试。

## 真实发行库兼容性

使用本机 DSH `app.asar` 内的真实库验证：

- `createUserMessage` 与 Session event 校验接受结构化插件来源，消息被冻结。
- 真实 `defineTool` 编译八个工具并执行参数校验，包含 `voce_speak`。
- 真实 Schemastery 解析默认禁用配置及语音 volatile 字段。
- 通过轻量 React hooks 驱动实际客户端模块，在仅有 `slots`、没有 `configForms/locale/remote` 的环境检查 `settings.section` 注册、厂家切换、API 凭据写入和保存；保存值再次交给真实宿主 Schema 校验。该步骤使用假服务，尚未在真实浏览器中点击页面。
- 加载打包入口 `dist/index.js`，在假 ctx 中执行 `apply/effect/dispose`；无监听、无用户配置写入、无模型调用、无真实消息。

另外执行了真实发行库上的冷启动入口检查：在隔离临时目录预存 `enabled:true`，第一次挂载让凭据稍后就绪，确认自动恢复并能通过真实 HTTP GET；卸载后保留启用状态，再挂载第二个实例，无需调用启动按钮便建立监听。两个监听均为本机随机端口，结束后清理；凭据与 Agent 为测试替身，没有重启用户的 DSH、写用户配置或调用真实模型。

可复现命令见 [DSH-API.md](DSH-API.md)，脚本为 `scripts/verify-host.cjs`。这验证入口与发行库兼容性，不代表生产服务已切换。

## 真实 VoceChat 接收与待验证范围

尚未在真实 VoceChat Bot、真实 DSH Session 与真实 ASR 模型三者连接的环境中端到端发送测试消息。未改旧 Webhook、watchdog 或生产 profile。部署时按 [MIGRATION.md](MIGRATION.md) 在测试 Bot/群验证后再切换。

本次已在用户授权的真实服务上使用临时 Bot Key 读取 `GET /api/bot`，返回 200；该部署的 `/api/bot/` 返回 404，不能据此判断 Key 失效。使用独立接收程序 `scripts/live-webhook.mjs` 供临时 Bot 联调，复用生产 Bridge，但 SessionPort 仅记录本地处理结果，不连接真实 DSH 或 ASR，不发送回复。它可记录 GET/POST 状态、规范化结果和下载媒体的大小/哈希/音频信息，不记录密钥、query 值或正文；运行凭据与日志位于 Git 忽略的受限 `.runtime/` 目录。

2026-10-29 已实际收到远端 VoceChat 的 GET 地址验证，返回 200。本机 GET 不带密钥也返回 200，POST 未鉴权返回 401；配置完整接收地址后，首轮 **6 条真实私聊推送全部返回 202，6 条处理完成，0 条失败**。VoceChat 的可选 AES secret 保持留空，接收的是明文 JSON；URL 访问令牌是独立的接收端鉴权。

| 用户测试内容 | 实际接收结果 |
| --- | --- |
| 普通文本 | 接收并进入结构化处理 |
| Markdown | 接收并保留 Markdown 语法；不在普通日志记录正文 |
| 带附件消息 | 文字与图片分别投递；JPEG 实际下载 335056 字节 |
| 语音 | 实际下载 49880 字节，探测为 M4A / audio/mp4，时长 2.960544 秒 |

另从本轮语音附件取得真实音频，实际执行 FFmpeg 转码，并用 FFprobe 验证输出为 **PCM s16le、16000 Hz、1 声道 WAV**；输出 95188 字节，时长 2.972188 秒。下载与转换临时文件已清理。本步骤没有调用 ASR，不能据此宣称已经识别语音内容。

已验证的真实入站链路为 VoceChat 私聊推送 → 接收/规范化/去重队列 → 附件下载与音频探测/转换。真实出站结果见下文；群聊、真实 DSH Agent 驱动的回复和真实 ASR 转写仍待对应服务联调，相关自动化 Mock 结果分别记录在上表。

后续未带 URL 访问令牌的推送曾在旧版鉴权阶段返回 401，并未进入上述处理统计。独立测试程序可通过 `requireWebhookToken:false` 关闭审计端令牌要求。**v0.3.1 正式插件也支持可选令牌**：默认 `webhookSecretRef:''`，不填 Secret 即接收明文 JSON；显式配置引用时才校验，缺失凭据或错误令牌会拒绝。这个访问令牌与 VoceChat 后台可选的 AES Secret 分开。

2026-10-29 北京时间 11:34:01，明文审计模式实际收到一条远端私聊 POST：未带 query 访问令牌、未带 Authorization，返回 202，规范化与处理完成。累计真实消息处理完成 7 条，队列内失败与不确定状态均为 0；早先鉴权拒绝的请求不计入此处理数量。

### 真实私聊回发

按用户明确指令，固定到其刚才来信的已确认私聊目标，依次通过生产 `VoceChatClient` 回发以下 4 条消息。未使用全局“最近来信人”自动路由，未发送到其他用户或群；每条均获得服务端消息 ID，用户随后确认四条都正常显示、语音可以播放。

| 类型 | 实际结果 |
| --- | --- |
| 普通文本 | `text/plain` 发送成功，用户确认收到 |
| Markdown | `text/markdown` 发送成功，用户确认正常渲染；使用显式 `format: 'markdown'`，未附加引用前缀 |
| 图片附件 | JPEG 335056 字节，真实 prepare → multipart upload → `vocechat/file` 发送成功，用户确认可预览 |
| 语音 | M4A 49880 字节、约 2.96 秒，真实上传后以 `vocechat/audio` 发送成功，没有 HTTP 415 降级，用户确认可播放 |

图片与语音为用户本轮测试素材的原样回传；未调用 TTS 或 ASR，也未借助真实 DSH Agent。这次验证了真实 Bot API 的双向通信和媒体上传/下载，不代表 Agent 工具执行、自动回复或模型能力已完成真实全链路验证。

## 已知限制

1. Bot API 的 `replyTo` 为可见 Markdown 消息 ID 引用，不是原生引用气泡；媒体组合拆为有序多条。`vocechat/audio` 的兼容差异及 HTTP 415 降级见 API 调查记录。
2. 当前只接收明文 JSON Webhook；VoceChat 可选 AES 密文不受支持，也没有原生 HMAC 签名协议可供验证。共享 secret 与反向代理承担入口认证。
3. 只接收官方 Webhook 投递的消息。不补轮询其他机器人消息，不实现表情包管理、人格、记忆或自主定时调度。
4. 图片理解依赖目标模型的图片输入能力；DSH 本版本没有原生 audio block，采用标注消息 ID/文件名的转写文本加原音频文件。已内置 OpenAI 标准及 MiMo ASR/TTS；阿里百炼专用协议和 Qwen Omni 仍为扩展点。新增语音验证使用本地 HTTP 测试服务，未调用真实云端 ASR/TTS。
5. Webhook ACK 与发送 API 之间没有分布式事务。网络断开可能出现服务端已发送而客户端未确认；已入队/已启动 turn 的不确定结果不自动重试。断电级别持久化和严格 exactly-once 不在本版保证范围内。
6. 去重使用全局 VoceChat mid，受 `dedupTtlMs` 与 `maxHistory` 限制；不要让多个 Bot/多个进程共用同一个 statePath。群白名单授权整个群，需更细限制时配置 groupSenderWhitelist。
7. 固定 Session 的 Web/QQ 队列若持续繁忙，已封批消息继续排队，不抢占，也不消耗本轮 turnTimeoutMs。实际提交后的超时或崩溃仍会隔离为 uncertain；其他渠道主动 steer 造成同轮来源混合时停止外发。
8. ASR/VoceChat API 基址是管理员配置，允许内网自托管地址。远程出站媒体只允许配置的公网 origin；不支持出站媒体的私网 URL、重定向或 HTTP 代理自定义路由。
9. 取消/禁用只停止桥接等待和发送，不取消共享 Agent。已经入队的 Agent 工作可能继续完成，不会在桥接停止后自动转发结果。
10. 状态文件保留必要聊天内容；DSH durable attachments 由宿主保留。自动清理仅处理插件临时目录，管理聊天历史与宿主附件仍遵循 DSH 规则。
