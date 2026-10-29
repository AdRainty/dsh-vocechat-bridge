# 安装与运行

要求 DSH 0.2.1-rc.3、Node.js 22.19+。插件直接使用宿主的 `agents`、`tools`、`attachments` 服务，不连接 DSH Web RPC，不读取浏览器 cookie。压缩音频需要 FFprobe；格式转换需要 FFmpeg。PCM WAV 可以无外部解码器检查实际时长。

## 安装

源码仓库不含 `dist/`，目录安装前需要先构建；Release tgz 已包含构建产物。安装会增加默认禁用的 `vocechat-bridge` 插件项，不覆盖原桥接。

```powershell
cd ./dsh-vocechat-bridge
npm ci --legacy-peer-deps
npm run check
npm pack
dsh plugin --profile web add "$PWD"
```

也可以把 `dsh-vocechat-bridge-0.4.3.tgz` 交给 DSH 插件安装器。链接安装更新代码后，在插件页关闭再打开该插件包一次，并刷新界面加载新的 client；不必重启整个 DSH。“保存并重载后端”应用当前已加载版本的连接配置，不会替换内存中的插件代码。开发链接安装时，宿主依赖必须能从插件的真实路径解析；遵循宿主安装器解析 peer dependencies 的方式，若手工建立依赖链接，指向实际 profile 的 `node_modules/@deepseek-ai`，不要复制凭据文件。

正式发布包见 [GitHub Releases](https://github.com/AdRainty/dsh-vocechat-bridge/releases)，其 tgz 包含编译后的 `dist/`，源码仓库与自动生成的源码压缩包需自行构建。

`npm ci --legacy-peer-deps` 用于独立开发和测试；运行插件时三个 peer dependency 由 DSH 提供。安装和升级操作需在实际使用的 profile 中进行。

## 最小配置

打开 **设置 → VoceChat**，填写实际服务地址、机器人 UID、固定 Session ID、白名单和 Webhook 参数，点击“启动桥接后端”。入口位于设置导航中，桥接停止时仍可使用。也可以将 [config.example.yml](../config.example.yml) 合并到 profile 作为初始配置。

页面保存的字段写入与 state.json 同目录的 `settings.json`，优先于 profile 同名值，未保存字段继续跟随 profile/defaults。语音配置保存后下一次请求生效；连接参数、白名单、Session、防抖窗口等修改后点击“保存并重载后端”。停止会持久化 `enabled:false` 并释放监听，启动/重载会持久化 `enabled:true`；下次 DSH 加载时恢复这一选择。操作期间仍沿用既有队列与去重状态，不创建替代 Session，不停止共享 Agent。

冷启动会先加载本地启用状态，并在凭据/webServer 服务就绪时唤醒启动检查。启动失败后按 250 ms 起步、最长 5 秒间隔继续重试；同类错误只记录一次。凭据较晚加载或旧监听短暂占用端口时，不会因首次失败而放弃自动启动。页面显示“等待自动启动”及错误原因；点击停止后保存的禁用状态会取消后续重试，卸载插件也会取消重试。

敏感值仅存 DSH credentials 或进程环境。配置中的 `botApiKeyRef`、`webhookSecretRef`、`asrApiKeyRef`、`ttsApiKeyRef` 填的是**引用名**。设置页的密码输入框通过插件宿主接口写入 DSH credentials，不读取已有密钥，不把 Key 写入 settings.json。credentials 服务存在时优先解析；未解析到再读取同名环境变量。每次请求重新解析，可以轮换凭据。自定义 OpenAI 兼容的无鉴权本地服务允许空引用。

Webhook 建议绑定 loopback，由反向代理转发。已验证的访问令牌模式填写为：

```text
https://bridge.example.com/vocehook?secret=YOUR_WEBHOOK_TOKEN
```

在设置页开启“校验 Webhook 访问令牌”，把实际令牌保存在 DSH credentials 中，`webhookSecretRef` 指向该引用，例如 `VOCECHAT_WEBHOOK_TOKEN`。URL 中填写实际令牌的 URL 编码值，POST 接收端按同一值校验。反向代理也可以改为注入 `Authorization: Bearer <token>`。日志应隐藏 query，插件日志不记录 URL、请求体或凭据。

精确 Webhook 路径的 GET 无需鉴权，直接返回 200，供 VoceChat 验证地址；该请求不接收消息、不返回会话数据。**GET 验证通过不代表 POST 已通过认证。** 启用校验后，POST 缺少或携带错误令牌会返回 401；令牌凭据本身缺失也会明确报错。`webhookSecretRef:''` 可以关闭这项访问校验，这不改变 JSON 是否加密。

VoceChat 文档的 `set/get secret` 接口控制可选的**消息内容加密**。不设置时，POST 为原始 JSON，包括上述带 `?secret=...` 的接入方式；通过 `set secret` 设置 16 字节字符串后，服务端才进行 AES 加密，接收端需先解密再做 PKCS#7 去填充。当前插件处理明文 JSON，使用本接入方式时不启用该加密接口。**Bot API Key** 用于调用 Bot API；**URL 的 secret** 用于插件认证；**VoceChat 加密 secret** 用于 AES，三个用途相互独立。

首次配置完成后，将 `enabled` 改为 `true`。默认端口 **8898**，部署时确认端口可用。空白名单拒绝全部对应渠道：私聊使用 UID；群聊使用 GID。`groupSenderWhitelist` 可进一步限制授权群中的成员，空数组代表不加这一层限制。

## 配置项

完整默认值以 `src/config.ts` 为准，示例包含所有可配置项。

| 项目 | 默认及说明 |
| --- | --- |
| `enabled` | `false`，启用前校验基址、Bot UID、Session 与凭据引用 |
| `baseUrl`, `botUid` | VoceChat 基址与机器人自身 UID；`botUid` 用于回环保护 |
| `botApiKeyRef`, `webhookSecretRef` | Bot 默认 `VOCECHAT_BOT_API_KEY`，必填；Webhook 默认空，不校验访问令牌 |
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
| `historyContextMessages` | `6`；每批附带的同会话历史条数，`0` 关闭，最大 `50` |
| `historyMaxChars`, `historyTimeoutMs` | `12000`, `5000`；历史结果的 JSON 字符预算和查询超时；超限保留较新的记录，失败不阻止当前新消息 |
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

所有发送工具要求明确 `destination: {kind:'user'|'group', id:数字}`，只能由固定 Session 的真实 Agent 身份调用。目标仍需通过白名单。当前来源明确的 VoceChat 轮向原目标发送属于回复；向别的目标发送，或 Web/QQ、混合来源轮发起显式发送，属于主动发送，需要 `allowProactive:true`。

| 工具 | 参数 |
| --- | --- |
| `voce_send_text` | `destination`, `text`, 可选 `format: 'plain'|'markdown'`、`replyTo` |
| `voce_send_image` | `destination`, `path` 或 `url` 二选一，可选 `name/mime/replyTo` |
| `voce_send_audio` | 同上；发送已有音频，不自动生成 TTS |
| `voce_speak` | `destination`, `text`, 可选 `voice/instructions/replyTo`；生成并发送语音，要求启用 TTS |
| `voce_send_file` | 同上，普通文件 |
| `voce_send_message` | `destination`, 可选 `text`, `format`, `speech`, `attachments`, `replyTo`；speech 包含 text，可选 voice/instructions |
| `voce_quiet` | 无参数，在当前 VoceChat 轮安静结束 |
| `voce_get_private_history` | `uid`，可选 `limit`（默认 20，范围 1–100），查询 Bot 与该 UID 的近期私聊 |
| `voce_get_group_history` | `gid`，可选 `limit`（默认 20，范围 1–100），查询该群近期消息 |
| `voce_bridge_status` | 无参数，返回生命周期、Session ID、队列数量、历史查询状态和仅含 ID/结果的入站诊断，不含凭据与消息正文 |

两个历史工具只读，由固定 Session 的真实 Agent 身份调用，沿用私聊/群聊白名单及可选群发送者限制，不受主动发送开关影响，也不会抑制本轮自动回复。结果按旧到新排序，保留消息 ID、发送者 UID、时间、正文、附件描述及本地已有的语音转写；不重新下载历史附件或调用 ASR。`truncated:true` 表示字符预算缩短了结果。

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

所有发送工具的 `replyTo` 都使用 `POST /api/bot/reply/{mid}` 创建 VoceChat 原生引用回复，包括普通文本、Markdown、图片、文件、已有音频和 TTS 语音。填原消息的数字 ID，`destination` 仍须明确指定同一个私聊或群聊，例如：

```json
{
  "destination": {"kind":"group","id":10},
  "text":"针对这条消息的回复",
  "replyTo":1234
}
```

插件先从同一服务和 Bot 的本地入站缓冲记录核对引用消息的会话归属；未命中时查询该会话最近 100 条历史。记录属于其他会话时报 `REPLY_DESTINATION_MISMATCH`，仍无法确认时报 `REPLY_TARGET_UNVERIFIED`，均不会发送。较早且已从本地记录和历史窗口移出的消息无法用于 `replyTo`。目标白名单和主动发送开关继续生效。

长文本、文字与媒体组合、多附件回复仅首条实际发送的消息带引用，其余按原顺序发送；纯附件、纯语音直接作为原生 Reply，不额外发送占位文字。不传 `replyTo` 时使用普通发送接口；自动文本回发维持普通发送，不默认引用本批消息。已在官方 0.5.38 上验证；服务端缺少 Reply 接口或目标消息已删除时返回 HTTP 错误，不自动降级成普通发送或 Markdown 消息 ID 引用。

音频优先 `vocechat/audio`，明确 HTTP 415 时以普通音频文件降级，并返回 `audioFallback:true`；降级仍保留原生 Reply 的目标 ID。

## 附带历史与入站诊断

每批新消息完成防抖后，通过 Bot Key 查询同一私聊或群聊的历史，默认取 6 条，只附加到本次唯一的用户消息中作为背景。其他发送者及其他 Bot 的历史可以作为同群背景，但仍不与新消息合并为同一发送者，也不加入待回复队列。自身以前的回复也会保留。结构化来源中的 `messages` 只包含本批新消息 ID，`history.ids` 单独列出背景 ID。

自动背景排除本批第一条 ID 及之后的全部消息，避免忙碌排队时把尚未提交的消息提前当成背景。当前 Bot API 只有最新窗口，没有 `before` 游标；自动查询最多检查最新 100 条，再筛选早于本批的记录，超出该窗口时可能少于配置条数。私聊双方严格匹配 Bot/目标 UID，群聊严格匹配 GID，不跨会话；配置群发送者白名单后，历史也按该名单过滤，并保留 Bot 自己的回复。历史超时、旧服务没有该接口或请求失败时，本次新消息照常提交，背景与状态附安全错误码。

“设置 → VoceChat”可修改历史条数、字符预算和查询超时，保存并重载后端生效。页面还显示本次启动的 Webhook POST 次数、最近 HTTP 状态，以及最多 30 条已解析载荷的 ID、发送者和处理结果。`SELF_MESSAGE` 是自己的消息，`DESTINATION_DENIED` 是目标不在白名单，`SENDER_DENIED` 是群发送者受限，`OTHER_RECIPIENT` 是其他私聊收件人，`UNSUPPORTED_MESSAGE` 是非新消息/不支持的内容类型；正文和密钥不会进入该诊断。诊断随实例重启清空。

排查 Bot 互相漏收时，先核对服务器历史是否存在，再对照入站诊断。插件只按自身 UID 忽略自消息，不按 `is_bot` 屏蔽其他 Bot；历史存在并不等于 VoceChat 已推送该消息。若新测试时 POST 计数没有变化，应检查服务端 Webhook 投递及代理；若有 ID 和忽略原因，则按对应规则排查。历史查询只补充背景，不自动轮询补投或触发 Bot 互相回复。

## 持久化与异常恢复

每条合法消息先写状态文件再返回 202；重复或被过滤事件返回 202，非法事件 400、鉴权失败 401、体积超限 413、队列满或状态写入失败 503。VoceChat 是否重试失败 Webhook 由服务端决定；插件不能代替服务端保存尚未接收的事件。

Webhook 在本地持久化每条消息与所属缓冲区后才返回 202。缓冲键包含 VoceChat 服务/Bot、频道、目标 DSH Session、私聊/群聊目标和发送者；不同发送者不能合并。同一键的消息即使与其他来源交错到达，也按原始接收顺序合并。重复 ID 不入缓冲、不重置计时，也不触发第二次回复。

静默截止时间为 `min(末条接收时间 + 静默时长, 首条接收时间 + maxWaitMs)`。到期即持久化为不可追加的待提交批次；DSH 忙时独立计时仍继续，封批后排队。附件下载、ASR 和等待 DSH 空闲可能继续耗时，12 秒限制的是收集消息的防抖窗口。完整算法与状态说明见 [DEBOUNCE.md](DEBOUNCE.md)。

`pending` 消息及缓冲的首条/末条时间、截止时间、批次边界会在启动时恢复，不重新计算一整段等待。未提交的媒体准备与 ASR 结果可恢复；只有实际提交前才落盘 `dispatching`。该阶段崩溃后记为 `uncertain`，不自动重放。处理完成后从完成时间继续保留去重记录，受 `dedupTtlMs`、保留时间和 `maxHistory` 上限约束。

恢复时保留原会话归属；更换 Session、服务/Bot 或收紧白名单后，不匹配的批次继续保留并计入状态工具的 `blockedBatches`，不会投给新目标。状态格式自动从 v1 升级为 v2，升级与回滚前先备份，见防抖文档。不要在运行时手工修改状态文件，也不要把同一个状态文件交给多个插件实例。

临时目录仅清理插件生成的 `job-UUID` 子目录；任务结束立即删除，启动和周期扫描清理过期残留，并跳过活动任务。原始媒体存入 DSH durable attachment 后按宿主的附件保留规则管理。状态文件含聊天正文与来源，应该按聊天数据保护其目录权限。

共享会话由宿主唯一 Agent driver 处理，桥接等待当前 Web/QQ 队列空闲后使用 `followup`，不抢占。若其他渠道强制插入同轮，来源混合时停止自动回复，显式工具发送仍按主动发送开关和白名单校验。已核实的记忆指令/召回、时间快照和模型通知属于内部上下文。取消只停止桥接等待和发送，不取消其他渠道的 Agent 工作。图片理解需要目标会话模型支持图片；音频在当前 DSH 版本中以真实转写文本加原音频文件表示。
