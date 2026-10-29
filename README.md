# dsh-vocechat-bridge

连接 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 与 [VoceChat](https://voce.chat/) 的第三方插件。在 VoceChat 私聊或群聊中使用已有 DSH 会话，收发文字、图片、文件与语音，并保留该会话原有的人格、记忆和工具权限。

**当前版本：0.4.5 · 许可证：Apache-2.0**

- [GitHub](https://github.com/AdRainty/dsh-vocechat-bridge)
- [GitLab](https://gitlab.adrainty.online/dsh-plugins/dsh-vocechat-bridge)
- 上游：[DSH](https://github.com/deepseek-ai/deepseek-harness) · [VoceChat Server](https://github.com/Privoce/vocechat-server-rust) · [VoceChat 文档](https://doc.voce.chat/)

## 功能

- **双向消息**：私聊、群聊、普通文本、Markdown、图片、文件、已有音频及组合发送。
- **语音**：支持标准 OpenAI 协议和小米 MiMo 的识别与合成。语音输入同时附带真实转写与原始文件；识别失败会标明原因。
- **固定会话**：绑定已有 DSH Session，按当前消息的来源回复；主动发送要求明确目标并受配置限制。
- **消息缓冲**：按频道、会话、目标和发送者分别持久化防抖批次，支持忙碌排队、崩溃恢复与重复投递去重。
- **历史上下文**：每批默认附带 6 条更早的同会话消息，另有私聊、群聊最近 N 条查询工具。
- **设置页**：在 DSH 的“设置 → VoceChat”配置连接、白名单和语音，控制启动、停止和重载。启用状态会保存，DSH 下次启动时自动恢复。

插件负责通信和媒体处理；人格、长期记忆与自主调度由 DSH 及相应插件管理。

## 运行要求

| 组件 | 要求 |
| --- | --- |
| DSH | 已在 `0.2.1-rc.3` 核实插件接口；升级宿主后应重新验证兼容性 |
| Node.js | `22.19.0` 或更新版本 |
| VoceChat | 可使用 Bot API 和 Webhook；主要联调版本为 `0.5.38` |
| FFprobe / FFmpeg | 压缩音频探测、格式转换或 MiMo 音频归一化时需要 |
| ASR / TTS 服务 | 可选；配置服务端点、模型和凭据引用后分别启用 |

桥接、ASR 和 TTS 默认关闭。默认绑定 `127.0.0.1:8898`；私聊和群聊白名单默认均为空，对应渠道不会被接收。

## 安装

从任一代码仓库克隆，然后在插件目录中构建并安装：

```sh
git clone https://github.com/AdRainty/dsh-vocechat-bridge.git
cd dsh-vocechat-bridge
npm ci --legacy-peer-deps
npm run build
dsh plugin --profile web add "$PWD"
```

源码仓库不保留 `dist/`；上述构建步骤会生成插件入口 `dist/index.js`。运行时所需的三个 `@deepseek-ai/*` peer dependency 由 DSH 宿主提供。

也可以直接下载 [GitHub Releases](https://github.com/AdRainty/dsh-vocechat-bridge/releases) 中的插件 tgz。发布包内含 `dist/`、客户端入口、配置和许可文件，无需自行编译；可通过 DSH 插件安装器安装。维护者运行 `npm pack` 可生成相同结构的 `dsh-vocechat-bridge-0.4.5.tgz`。

链接安装更新代码后，需要重载**插件包**才能替换已加载模块；宿主启用 HMR 时也可能自动重载。“保存并重载后端”用于应用连接配置，不负责重新导入代码。详见[安装与运行](docs/USAGE.md)。

## 首次配置

1. 在 VoceChat 创建 Bot，取得 Bot API Key 和 Bot 自身 UID。
2. 在 DSH 打开“设置 → VoceChat”，填写 VoceChat 基址、Bot UID、已有 Session ID，以及允许通信的私聊 UID / 群聊 GID。
3. 保存 Bot Key 到 DSH 凭据库。配置中的 `botApiKeyRef` 填引用名，例如 `VOCECHAT_BOT_API_KEY`，不要把真实 Key 写进 YAML、源码或仓库。
4. 使用已验证的访问令牌模式：在插件中开启“校验 Webhook 访问令牌”，保存专用令牌，并将 `webhookSecretRef` 指向相应凭据引用，例如 `VOCECHAT_WEBHOOK_TOKEN`。配置监听和反向代理后启动桥接。
5. 在 VoceChat 填写 Webhook：`https://bridge.example.com/vocehook?secret=YOUR_WEBHOOK_TOKEN`。把占位值替换为同一实际访问令牌的 URL 编码值。
6. GET 返回 200 只表示地址验证通过；POST 还需通过访问令牌校验。发送一条授权私聊或群聊消息，检查它是否进入绑定的 DSH 会话，以及回复是否回到原目标。

上述带 `?secret=...` 的地址已验证可用，POST 内容仍是明文 JSON。URL 中的 `secret` 是**本插件的访问令牌**，用于接收端认证。

VoceChat 文档中的 `set/get secret` 是另一套**可选消息加密接口**：不设置时发送原始 JSON；设置 16 字节字符串后，服务端才会对推送内容做 AES 加密，接收端需要解密并进行 PKCS#7 去填充。当前插件不做 AES 解密，因此使用上述接入方式时保持该加密接口未设置。Bot API Key 独立用于访问 Bot API。

配置文件方式见 [config.example.yml](config.example.yml)。示例域名和 ID 均为占位值，实际连接信息需由部署者填写。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `voce_send_text` | 发送普通文本或 Markdown，`replyTo` 支持原生 Reply 引用 |
| `voce_send_image` / `voce_send_audio` / `voce_send_file` | 上传并发送本地或允许来源的媒体 |
| `voce_send_message` | 按顺序组合文字、媒体和可选合成语音 |
| `voce_speak` | 使用已配置的 TTS 合成并发送语音 |
| `voce_get_private_history` / `voce_get_group_history` | 查询指定私聊或群聊最近 N 条消息 |
| `voce_quiet` | 安静结束当前 VoceChat 回合 |
| `voce_bridge_status` | 查看生命周期、缓冲与入站诊断，不返回凭据或消息正文 |

所有发送工具都要求显式 `destination: { kind: 'user' | 'group', id: 数字 }`，并检查目标白名单。主动发送需开启 `allowProactive`。本地媒体使用 DSH 的文件读取能力，相对路径按当前会话工作区解析，支持 `~/…`。设置页的 `allowedLocalRoots` 留空即可跟随宿主读取权限；填写目录时增加额外限制。远程媒体仍受来源及网络访问规则限制。

普通自动回复在 DSH 回合完成后发送最终文本；成功使用发送工具后会抑制重复自动回复。已核实的记忆召回、时间快照和模型切换通知属于内部上下文，不会被当成其他渠道输入。

## 消息缓冲与默认行为

| 参数 | 默认值 |
| --- | --- |
| 私聊静默窗口 | 4 秒 |
| 群聊静默窗口 | 1.5 秒 |
| 单批最长等待 | 12 秒 |
| 每批最多原始消息数 | 10 条 |
| 自动附带历史 | 6 条；可设为 0 关闭 |
| 历史工具条数 | 默认 20，范围 1–100 |
| 长文本发送分段 | 每条最多 2000 个 Unicode code point |

新消息重置静默计时，最长等待到期则封批；不同发送者不会合并。批次保留原始顺序、消息 ID、附件和已有转写。提交结果不确定的批次不会在重启后自动重放，避免重复回复。

算法和恢复语义见[防抖合并](docs/DEBOUNCE.md)。

## 为什么另一只 Bot 的消息收不到

在已验证的**官方 VoceChat 0.5.38 Linux amd64** 发行包和镜像中，Webhook 转发函数会跳过 `is_bot = true` 的发送者。因此 Bot 消息可以出现在聊天历史和 SSE 中，却没有被 POST 到接收插件。给 Bot 改密码，或换成普通用户 Token 调用发送接口，都不会改变其 Bot 身份。

插件会忽略**自身**消息；允许范围内的其他 Bot 消息如果确实被投递到 Webhook，会正常进入队列。群聊可通过 `groupSenderWhitelist` 选择允许触发回复的用户或 Bot。

SSE 是可行的另一条入站路径：Bot 的用户登录 Token 可以订阅用户事件流并收到其他 Bot 消息，Bot API Key 则不能替代该 Token。**当前插件尚未实现 SSE 接收。**

详见 [Bot 消息的现象、结论与 SSE 方案](docs/BOT-MESSAGES.md)。

## 安全与配置

- 默认基址、Bot UID、Session 为空或未配置值；未配置完整时无法启动。
- Key 保存在 DSH credentials 或进程环境中；源码中的 `*_API_KEY` 是引用名。
- 设置页不回传已有 Key，日志及入站诊断不输出凭据或消息正文。
- 本地媒体通过 DSH 文件系统读取，可额外限制目录；远程媒体默认拒绝，下载禁止重定向并检查地址和大小。
- 历史内容作为外部背景传入，不作为新的用户请求执行。

不要提交真实 `.env`、凭据库、部署配置、会话日志、媒体或运行状态。变更部署前保留配置备份，并确保同一 Bot 的相同事件只有一个有效处理入口。

## 文档与开发

固定会话与渠道桥接方式参考了 [sj244/dsh-qq-bridge](https://github.com/sj244/dsh-qq-bridge)。

- [安装、配置和工具说明](docs/USAGE.md)
- [升级、配置迁移与回滚](docs/MIGRATION.md)
- [语音 Provider、OpenAI 与 MiMo](docs/PROVIDERS.md)
- [DSH 接口](docs/DSH-API.md) · [VoceChat API](docs/VOCECHAT-API.md)
- [验证记录与限制](docs/VALIDATION.md)
- [开发约定与原始验收要求](AGENTS.md)

```sh
npm run check
npm pack
```

当前功能基线通过 105 项自动化检查，并有真实发行库兼容性、媒体探测、VoceChat 消息收发及隔离服务端验证记录。具体版本和真实服务联调范围以验证文档为准。

维护者推送与 `package.json` 版本一致的 `v*` 标签时，GitHub Actions 会构建并发布 tgz 和 `SHA256SUMS`；构建产物不提交到 Git。

## 许可证与上游

本项目原创插件代码采用 [Apache License 2.0](LICENSE)，版权与归属见 [NOTICE](NOTICE)。DSH 使用 MIT；VoceChat 服务端、官方镜像和 Web 客户端具有各自的许可，其中包含商业使用限制或 copyleft 条款。本项目不重新许可这些上游组件。

完整范围、上游链接及保留声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立第三方集成，不代表 DeepSeek 或 Privoce 官方。
