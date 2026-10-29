# VoceChat API 调查记录

调查日期：2026-10-29。实现依据官方 Bot 文档、公开 Rust 源码以及实际部署的 API 验证。已验证真实私聊的普通文本、Markdown、图片与语音双向收发，结果见 [VALIDATION.md](VALIDATION.md)；真实 DSH Agent 与 ASR 全链路仍待验证。

## 来源与核实结论

- [官方 Bot 与 Webhook 文档](https://doc.voce.chat/bot/bot-and-webhook)：Webhook 地址必须能 GET 返回 200，消息以 POST JSON 送达。消息包含 `created_at`、`from_uid`、`mid`、`target: {uid}` 或 `{gid}` 以及 `detail`。`detail.type` 为 `normal` 或 `reply` 才是新内容；`reaction` 是修改、删除或点赞，不应驱动 Agent。`reply` 的 `detail.mid` 指被回复的消息。
- [官方 Bot API 目录](https://doc.voce.chat/api/get-all-groups-related-to-the-current-user-1) 与 [bot.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/bot.rs)：Bot Key 使用 `x-api-key`。文本用 `POST /api/bot/send_to_user/{uid}` 或 `/api/bot/send_to_group/{gid}`，Content-Type 是 `text/plain` 或 `text/markdown`，body 是文本，返回数字消息 ID。
- 同一 `bot.rs` 与 [resource.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/resource.rs)：上传先 `POST /api/bot/file/prepare`，JSON `{filename, content_type}` 返回 JSON 字符串 UUID；再 `POST /api/bot/file/upload`，multipart 字段 `file_id`、`chunk_data`（二进制）和 `chunk_is_last=true`，返回 `{path,size,hash,image_properties?}`。图片与文件均用 Content-Type `vocechat/file`，body 为 JSON `{path}`。每个附件独立发送，组合消息由桥接层按顺序串行发送。
- [message.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/message.rs) 的 `parse_properties_from_base64`：`X-Properties` 是 **Base64 编码的 UTF-8 JSON**，不能直接把原始 JSON 写入 header。中文名正常编码，无需损坏字符串或重试重复发消息。
- `resource.rs` 的 `download_file`：下载路径固定 `/api/resource/file?file_path=年/月/日/UUID`；路径来自文件消息 `detail.content`，不是任意 URL。服务端也按附件元数据确定 MIME。插件仅接受资源 ID，禁止 URL、盘符、路径穿越与额外查询参数。

## 历史查询与部署版本差异

在实际部署的 **VoceChat 0.5.38** 上只读核对 `/api/spec` 并成功调用：`GET /api/bot/user/{uid}/messages?context=N` 和 `GET /api/bot/group/{gid}/messages?context=N`，均使用 `x-api-key`，返回 `ChatMessage[]`，含 Bot 自己和其他 Bot 的消息。`context` 是条数；群接口另有可选 `user_id`，本插件不传，以取得同群完整背景。插件工具限制 N 为 1–100，响应限制 2 MiB，归一化后按消息 ID 从旧到新返回，并再次核对会话归属。

不要把这两个 Bot 接口写成 `/api/user/{uid}/history?limit=N` 或 `/api/group/{gid}/history?limit=N`：后两者需要普通用户 Token，Bot Key 不等于用户登录 Token。当前 Bot 历史端点没有 `before` 参数；自动背景检查最新 100 条并筛选早于当前批次的消息。旧部署不支持时返回安全错误码，新消息仍正常提交，不尝试读取管理员凭据或登录态。

公开 Rust master 源码并不覆盖该部署的全部新增能力。0.5.38 OpenAPI 还列出 `POST /api/bot/reply/{mid}`，当前 `replyTo` 使用该端点实现原生引用。Bot 历史可见性与 Webhook 投递是两条链路，不能用“能查到”推断“已经 POST 到插件”；本地入站诊断只记录 ID、结果及忽略原因。

## Bot 消息与 Webhook

Bot 消息能出现在历史和 SSE 中，却不一定触发 Webhook。已验证版本的现象、结论与 SSE 方向见 [Bot 互通说明](BOT-MESSAGES.md)。

## 音频兼容

实际部署验证支持 `vocechat/audio`，手机显示语音条；真实私聊已上传并以该类型发送 M4A，确认可播放，未发生降级。公开官方文档和当前可访问 Rust 源码未列出此类型，服务器版本可能存在差异。因此插件默认尝试 `vocechat/audio`；只在明确收到 HTTP 415（媒体类型不支持）时降级为 `vocechat/file` 音频附件，并返回 `audioFallback: true`。鉴权失败、超时或一般服务错误不重试发送，避免重复消息。

## 指定消息回复的限制

公开 Rust master 中的 Bot 发送函数创建 `normal` 消息；普通用户 Token 的回复接口不能直接假设可用 Bot Key。官方 0.5.38 的专用 Bot Reply 接口为 `POST /api/bot/reply/{mid}`，使用 `x-api-key`，支持与普通发送相同的 `text/plain`、`text/markdown`、`vocechat/file` 和 `vocechat/audio` 请求体、Base64 `X-Properties`，返回新消息的数字 ID。存储结果为 `detail.type: reply`、`detail.mid: 被引用的消息 ID`；正文保持原文。

Reply 端点按原消息 ID 决定会话，因此桥接层在上传、TTS 和发送前，先核对本地同源入站记录；否则查询显式 `destination` 的最近 100 条历史并核对 ID 与会话。不能确认归属时拒绝发送，避免 ID 绕过目标白名单。长文分段和组合发送仅首条消息带原生引用；媒体独立回复无需文字占位。语音 HTTP 415 的文件格式降级仍使用同一个 Reply 端点；HTTP 404、超时及其他失败不回退为普通发送，避免意外失去引用或重发。

2026-10-30 使用未修改的官方 0.5.38 服务在本地隔离账号验证：私聊、群聊、引用 Bot 自己发出的消息、图片、文件、语音及组合发送均保存正确的原生 Reply 关系；另验证不同会话的 ID 被桥接层拒绝。未使用生产凭据或发送到真实会话。

## Webhook 鉴权与加密

已验证的接入地址为 `https://bridge.example.com/vocehook?secret=YOUR_WEBHOOK_TOKEN`：这里的 query `secret` 是插件的访问令牌，开启校验后按 `webhookSecretRef` 指向的凭据验证 POST，也支持代理提供 Authorization。GET 不要求该令牌并返回 200，因而地址验证与消息认证需要分别核对。

VoceChat 文档的 `set/get secret` 是可选的消息内容加密 API，不是通用 HMAC 签名 header。不设置时直接推送原始 JSON；设置 16 字节字符串后才会 AES 加密，接收端需解密和 PKCS#7 去填充。当前插件没有 AES 解密步骤，使用上述接入方式时不启用该加密 API。query 令牌本身不会使消息内容变成 AES 密文。

## 传输安全与凭据

Bot API 基址是管理员配置，允许内网自托管服务。附件内容不能修改 API 基址或下载 endpoint。所有 API 请求禁重定向、设超时并限制响应大小；错误只包含操作错误码及 HTTP 状态，不包含响应体、原始 URL 或 Key。

DSH Agent 出站本地文件通过宿主 `fs.resolve` / `fs.stat` / `fs.readBytes` 读取，复用会话的工作区路径解析、文件读取能力及单次读取字节上限。插件不修改宿主权限模式；宿主读取失败时直接报错，不退回 Node 读取。`allowedLocalRoots` 留空使用宿主授权，填写时追加 `realpath` 目录边界检查，阻止路径前缀近邻和符号链接逃逸。没有宿主文件服务的程序化调用继续要求目录白名单。

远程文件默认全部拒绝，需配置精确允许 origin；DNS 每次解析检查全部地址，并把通过检查的地址固定到连接，阻止 DNS 重绑定。只接受公网 HTTP(S)，拒绝私网、loopback、链路本地、IPv4 映射 IPv6、其他特殊地址和重定向。远程下载不带 VoceChat Key。

## 自动化验证边界

`tests/vocechat.test.ts` 使用本地 HTTP Mock 检查端点、Content-Type、Base64 元数据、multipart 实际字节、下载参数、大小限制、路径白名单、错误脱敏、取消和音频兼容降级。公网地址分类和拒绝路径离线验证。用户授权的真实 VoceChat 私聊收发另行通过临时 Bot 联调验证，且得到客户端显示与播放确认；这些结果不代替群聊、DSH Agent 或 ASR 的真实全链路验证。
