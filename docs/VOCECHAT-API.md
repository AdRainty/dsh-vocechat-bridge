# VoceChat API 调查记录

调查日期：2026-10-29。实现优先依据官方 Bot 文档、公开 Rust 源码和本工作区旧桥接代码。已验证真实私聊的普通文本、Markdown、图片与语音双向收发，结果见 [VALIDATION.md](VALIDATION.md)；真实 DSH Agent 与 ASR 全链路仍待验证。

## 来源与核实结论

- [官方 Bot 与 Webhook 文档](https://doc.voce.chat/bot/bot-and-webhook)：Webhook 地址必须能 GET 返回 200，消息以 POST JSON 送达。消息包含 `created_at`、`from_uid`、`mid`、`target: {uid}` 或 `{gid}` 以及 `detail`。`detail.type` 为 `normal` 或 `reply` 才是新内容；`reaction` 是修改、删除或点赞，不应驱动 Agent。`reply` 的 `detail.mid` 指被回复的消息。
- [官方 Bot API 目录](https://doc.voce.chat/api/get-all-groups-related-to-the-current-user-1) 与 [bot.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/bot.rs)：Bot Key 使用 `x-api-key`。文本用 `POST /api/bot/send_to_user/{uid}` 或 `/api/bot/send_to_group/{gid}`，Content-Type 是 `text/plain` 或 `text/markdown`，body 是文本，返回数字消息 ID。
- 同一 `bot.rs` 与 [resource.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/resource.rs)：上传先 `POST /api/bot/file/prepare`，JSON `{filename, content_type}` 返回 JSON 字符串 UUID；再 `POST /api/bot/file/upload`，multipart 字段 `file_id`、`chunk_data`（二进制）和 `chunk_is_last=true`，返回 `{path,size,hash,image_properties?}`。图片与文件均用 Content-Type `vocechat/file`，body 为 JSON `{path}`。每个附件独立发送，组合消息由桥接层按顺序串行发送。
- [message.rs](https://github.com/Privoce/vocechat-server-rust/blob/master/src/api/message.rs) 的 `parse_properties_from_base64`：`X-Properties` 是 **Base64 编码的 UTF-8 JSON**，不能照搬旧桥接的原始 JSON header。中文名正常编码，无需损坏字符串或重试重复发消息。
- `resource.rs` 的 `download_file`：下载路径固定 `/api/resource/file?file_path=年/月/日/UUID`；路径来自文件消息 `detail.content`，不是任意 URL。服务端也按附件元数据确定 MIME。插件仅接受资源 ID，禁止 URL、盘符、路径穿越与额外查询参数。

## 历史查询与部署版本差异

在实际部署的 **VoceChat 0.5.38** 上只读核对 `/api/spec` 并成功调用：`GET /api/bot/user/{uid}/messages?context=N` 和 `GET /api/bot/group/{gid}/messages?context=N`，均使用 `x-api-key`，返回 `ChatMessage[]`，含 Bot 自己和其他 Bot 的消息。`context` 是条数；群接口另有可选 `user_id`，本插件不传，以取得同群完整背景。插件工具限制 N 为 1–100，响应限制 2 MiB，归一化后按消息 ID 从旧到新返回，并再次核对会话归属。

不要把这两个 Bot 接口写成 `/api/user/{uid}/history?limit=N` 或 `/api/group/{gid}/history?limit=N`：后两者需要普通用户 Token，Bot Key 不等于用户登录 Token。当前 Bot 历史端点没有 `before` 参数；自动背景检查最新 100 条并筛选早于当前批次的消息。旧部署不支持时返回安全错误码，新消息仍正常提交，不尝试读取管理员凭据或登录态。

公开 Rust master 源码并不覆盖该部署的全部新增能力。0.5.38 OpenAPI 还列出 `POST /api/bot/reply/{mid}`；当前 `replyTo` 仍保持既有的可见引用行为，尚未切换该新增端点。Bot 历史可见性与 Webhook 投递是两条链路，不能用“能查到”推断“已经 POST 到插件”；本地入站诊断只记录 ID、结果及忽略原因。

## 音频兼容

工作区 `vocechat-bridge/vocechat-media.mjs` 记录实际部署支持 `vocechat/audio`，手机显示语音条；本次真实私聊也已上传并以该类型发送 M4A，用户确认可播放，未发生降级。公开官方文档和当前可访问 Rust 源码未列出此类型，服务器版本可能存在差异。因此插件默认尝试 `vocechat/audio`；只在明确收到 HTTP 415（媒体类型不支持）时降级为 `vocechat/file` 音频附件，并返回 `audioFallback: true`。鉴权失败、超时或一般服务错误不重试发送，避免重复消息。

## 指定消息回复的限制

公开 Rust master 中的 Bot 发送函数创建 `normal` 消息；普通用户 Token 的回复接口不能直接假设可用 Bot Key。实际 0.5.38 已提供专用 Bot reply 端点，见上文，但本插件的 `replyTo` 仍使用 `> 回复消息 #MID` 的 Markdown 可见引用，提供逻辑关联；不是原生可点击引用气泡。组合消息的关联由桥接层首条文字承担。

## Webhook 鉴权与加密

官方文档没有通用的 HMAC 签名 header。文档描述的是可选 16 字节 secret 和 AES 加密，而不是请求签名。当前插件接收明文 JSON；精确路径的 GET 无需鉴权即返回 200，仅用于地址验证；POST 默认不要求 Secret，仅在显式设置 `webhookSecretRef` 后校验 query/Authorization。VoceChat 的 AES Secret 留空即可推送明文；不要把 AES 密文直接接入此 JSON 接收器，也不要把插件的可选访问令牌当作 VoceChat 原生签名。

## 传输安全与凭据

Bot API 基址是管理员配置，允许内网自托管服务。附件内容不能修改 API 基址或下载 endpoint。所有 API 请求禁重定向、设超时并限制响应大小；错误只包含操作错误码及 HTTP 状态，不包含响应体、原始 URL 或 Key。

Agent 出站本地文件必须位于管理员明确允许的目录；检查 `realpath`，阻止路径前缀近邻和符号链接逃逸。远程文件默认全部拒绝，需配置精确允许 origin；DNS 每次解析检查全部地址，并把通过检查的地址固定到连接，阻止 DNS 重绑定。只接受公网 HTTP(S)，拒绝私网、loopback、链路本地、IPv4 映射 IPv6、其他特殊地址和重定向。远程下载不带 VoceChat Key。

## 自动化验证边界

`tests/vocechat.test.ts` 使用本地 HTTP Mock 检查端点、Content-Type、Base64 元数据、multipart 实际字节、下载参数、大小限制、路径白名单、错误脱敏、取消和音频兼容降级。公网地址分类和拒绝路径离线验证。用户授权的真实 VoceChat 私聊收发另行通过临时 Bot 联调验证，且得到客户端显示与播放确认；这些结果不代替群聊、DSH Agent 或 ASR 的真实全链路验证。
