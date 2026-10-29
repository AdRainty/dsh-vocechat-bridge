# 从旧 Webhook 桥接迁移与回滚

本次开发没有修改 `vocechat-bridge`、QQ 桥接、SOUL、记忆或自主定时任务，也没有执行生产切换。新插件默认禁用，使用独立 8898 端口和独立状态目录。

升级到 v0.2.0 时，先停插件并备份本地状态；新状态格式为 v2，支持恢复静默计时和已封批队列。默认私聊 4 秒、群聊 1.5 秒、最长 12 秒封批。删除旧 `mergeWindowMs` 或设为 0 后再使用新参数；状态升级与降级注意事项见 [DEBOUNCE.md](DEBOUNCE.md)。

v0.3.x 保持 v2 状态格式，新增 OpenAI/MiMo 识别合成。v0.3.1 修复设置入口，改为与 `dsh-bili-scroll` 相同的 **设置 → VoceChat**，并提供启动/停止/重载按钮。链接安装升级后先在插件页关闭再打开该插件一次，刷新界面；之后可直接在设置页控制后端，不必重启 DSH。

原有 `asrEnabled/asrBaseUrl/asrModel/asrApiKeyRef` 配置继续使用标准 OpenAI 转写协议；旧的空 `ttsProvider` 按 `openai` 兼容，合成仍需显式启用。页面保存的字段写入插件 settings.json 并优先于 profile，同名字段以后在页面调整。旧 MiMo 的 `MIMO_*` 环境配置不会自动导入：将 `asrProvider/ttsProvider` 设为 `mimo`，使用 `MIMO_API_KEY` 引用；模型、音色、描述按 [PROVIDERS.md](PROVIDERS.md) 配置。

## 切换步骤

1. 备份旧桥接的启动方式、环境配置、Webhook URL 和 DSH profile 的 `cordis.patch.yml`；凭据备份放在受保护位置。记录旧监听端口、Bot UID 和目标 Session ID。不要把含密钥的配置复制进本项目。
2. 安装本插件，先保持 `enabled:false`。按 USAGE 填写相同的**已有 Session ID**，不要新建 Session；配置 Bot Key 的凭据引用、机器人自身 UID、UID/GID 白名单。
3. 确认可用的 ASR 服务；本地兼容服务不需要云端 Key。运行 `npm run check`。图片需要支持图片输入的目标模型；压缩音频检查 FFprobe，转换检查 FFmpeg。
4. 用独立测试 Bot/测试群验证文字、图片、文件、语音和组合发送。独立测试可以使用同一插件实现与单独 statePath；正式会话联调会实际写入会话历史并可能产生模型费用。
5. 正式切换时，先停止旧桥接进程及会自动拉起它的 watchdog/启动任务，在本插件设置页点击“启动桥接后端”，并把 VoceChat Webhook 改到新端点。不要同时让旧桥接与新插件接收同一个 Bot 的相同事件，否则各自去重无法阻止跨进程重复回复。
6. 新端点 GET 无需鉴权即可返回 200；POST 默认接收明文 JSON，不填 Secret 也可工作。VoceChat 后台的 AES Secret 留空；只有开启插件可选的访问令牌校验时，才需配置 URL query 或代理 Authorization。发送一次私聊和群聊，核对原目标回复、图片/音频与白名单；在 DSH Web 和 QQ 各发一条测试消息，确认没有自动转到 VoceChat。
7. 确认完成前保留旧程序与备份。不要导入旧 `[img:...]`、`<noop>` 或“所有会话回复都转发”的消息协议；新插件通过工具与本轮来源完成这些行为。

## 旧脚本中需要保留的迁移经验

以下依据旧 `vocechat-bridge/bridge.mjs` 的 `onSessionEvent`、`pushIncoming`、`groupIdOf`、`mimoAsr` 以及《移植说明-群聊与语音.md》核对。它们是部署时踩过的兼容问题；新插件的对应行为和差异必须一起检查。

### 主动开口不能误发给最近来信人

旧脚本将 `lastUid` 初始化为 `VOCE_DEFAULT_UID`，收到有效且非 Bot 的用户消息时更新为最近来信人的 UID。非桥接触发的会话轮次也会转发，目标取当时的 `lastUid`；配置 `VOCE_DEFAULT_GID` 时，主动消息按该群路由。这样会让 Web、其他渠道或自主任务的输出继承一个与当前意图无关的接收者。`VOCE_DEFAULT_UID` 只是初始值，并不能固定住之后的私聊目标；重启后尚未收到消息且没有默认 UID 时，旧出口还会因缺少 UID 跳过发送。

新插件没有“最近来信人”兜底：普通自动回复绑定触发消息的目标；主动发送必须调用 `voce_send_*`，显式提供 `destination`，同时满足目标白名单和 `allowProactive:true`。旧环境里的默认 UID/GID 不能自动转换成新插件的主动收件人配置。要恢复主动开口，需要让原有调用方明确选择目标，本插件不实现自主调度。

迁移验证：让两个不同 UID 先后来信，再从 Web 或其他渠道产生会话输出，确认不会自动发给最后来信人；然后使用明确目标测试一次主动发送，核对实际接收者。不要用生产用户互相可见的内容测试。

### 群 ID 的四个兼容位置要逐项核对

旧 `groupIdOf(payload, detail)` 依次尝试下面四个对象。在每个对象内，优先读 `gid`，其次 `group_id`，最后仅在 `type === 'group'` 时读 `id`，取第一个有效的正数：

| 顺序 | 旧脚本尝试的位置 |
| --- | --- |
| 1 | `detail.target` |
| 2 | `payload.target` |
| 3 | `detail.properties` |
| 4 | `payload.properties` |

当前新插件的 [入站解析](../src/inbound.ts) 按官方 Webhook 形状读取顶层 `payload.target.gid` 或 `payload.target.uid`，**没有移植上述四位置及别名兜底**。不能因为旧脚本能收群消息，就认为同一份旧载荷可以直接迁移。如果实际群 ID 只出现在其他位置，载荷可能被拒；若同时带有可被解释为私聊的 `target.uid`，还存在被误判为私聊的风险，应在启用前排除。

迁移验证：用测试群取得脱敏的 Webhook 样本，核对群消息最终解析为 `{kind:'group', id:实际GID}`，回复端点为 `send_to_group`。若部署产生非标准载荷，先在入口适配成官方结构，或基于实际样本增加解析适配及回归测试，再进行切换；遇到多个群 ID 字段冲突时应拒绝，而不是猜测一个目标。不要在普通日志中保留原始载荷、聊天正文或凭据。

旧脚本还使用全局 `REPLY_SCOPE` 保存群目标，依赖串行处理。移植时不能让并发消息共享可变目标；新插件将 `destination` 保存在每条结构化消息和本轮状态中。

### ASR 的容器、采样率、声道与请求协议要分别确认

旧脚本记录的实际问题是：手机语音可能为 M4A，而当时接入的 ASR 只接受 WAV/MP3。`mimoAsr` 对非 `.wav`/`.mp3` 文件先执行 FFmpeg，转换为 **16 kHz、单声道 WAV**，再按旧服务要求编码请求；已有 WAV/MP3 则直接上传。只改文件扩展名或 MIME 不会完成音频转换。

新插件的标准 OpenAI Provider 默认接受 WAV、MP3、OGG、M4A、FLAC、WebM 并直接上传，不能据此推断实际 ASR 服务支持全部格式。对仅接受 WAV 的服务可设置：

```yaml
asrAcceptedFormats: ['wav']
ffmpegPath: ffmpeg
ffprobePath: ffprobe
```

标准 OpenAI Provider 下，此配置会把 **M4A 等非 WAV 容器**转换为 16 kHz、单声道、PCM WAV；**已有 WAV 不会重新采样或混为单声道**。v0.3.0 的 **MiMo Provider 则对全部输入强制归一化为 16 kHz 单声道 PCM WAV**，保留原文件供 DSH 附件使用。用实际样本检查 FFprobe 结果，不能仅检查 `.wav` 后缀。依赖、大小、时长及格式错误应明确处理，失败时不生成转写。

另外，旧 `mimoAsr` 使用 `/chat/completions` 的 JSON `input_audio` / Base64 协议；v0.3.0 已由 MiMo Provider 封装，标准 OpenAI Provider 继续使用 `/audio/transcriptions` 的 multipart 协议。迁移时必须选择正确厂家，不能只替换模型名。配置和扩展方法见 [PROVIDERS.md](PROVIDERS.md)。

迁移验证：至少使用一条手机 M4A 和一条已有 WAV，分别确认实际上传格式、采样率、声道和识别结果，并测试格式拒绝或转写失败的处理。先在测试服务完成这些检查，再替换正式语音链路。

## 回滚

1. 在“设置 → VoceChat”点击“停止”，再在插件管理页关闭该插件；确认状态工具显示停止或插件已经卸载。页面保存过 enabled 时，以插件 settings.json 为准，单改 profile 的同名值不会覆盖它。
2. 把 VoceChat Webhook URL 恢复为备份中的旧地址，再恢复旧桥接进程与原 watchdog。核对旧端口监听与消息发送。
3. 保留新插件 `state.json` 供核查 `pending/uncertain` 消息。不要让两套程序同时自动重放；逐条核对消息 ID，再决定是否人工补发。
4. 如需卸载，通过 DSH 插件管理移除 `vocechat-bridge`。状态目录和宿主持久附件属于聊天数据，确认不再需要后再自行清理。

桥接不改原 Session ID、人格或长期记忆文件；正式测试产生的会话聊天历史仍会保留，回滚通信插件不会回滚聊天记录。
