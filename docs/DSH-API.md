# DSH 接口核实与桥接边界

核实版本：**0.2.1-rc.3**。使用本机安装包 `app.asar/dsh/node_modules/@deepseek-ai/` 中的已发行源码及包版本作为实现依据；参考仓库为 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 和本工作区的 `dsh-qq-bridge`。未修改宿主、已有会话配置、SOUL 或记忆文件。

## 核实到的接口

v0.4.6 的入站引用沿用一条 `createUserMessage`：`source.messages` 仍只列本批新消息，新增可选 `replyTo` 与引用可用状态。被引用的原文以明确标注的用户消息背景提供；引用图片、文件及原音频沿用原生 `image` / `file` 内容块，已有转写放在背景中。系统上下文只带关系元数据，不把被引用原文放入更高权限角色，也不为旧消息新建回合。

| 发行包与源码位置 | 实际接口及用途 |
| --- | --- |
| `dsh-agent/lib/index.js`，`Agents.get/resume/withInitiator` | `get(id)` 获取固定 ID 的 live Agent；缺失时 `resume({resumeSessionId,agentOptions,setup,signal})` 恢复同一持久会话。绝不创建替代会话或回退到活跃会话。 |
| `dsh-agent-loop/lib/index.js`，806–808、870–875 行 | `agent.followup(message)` 返回 **void**，插入 `next-turn` inbox；`agent.whenIdle()` 等待宿主现有 driver 及其队列清空。`await followup()` 无法等待回复。 |
| `dsh-agent-loop/lib/index.js`，945、1067–1073、1029 行 | 事件顺序为 `turn/start` → `user/message` → `assistant/message` → `turn/end`。必须在 `followup()` 前注册监听，并以注入消息的稳定 `id` 认领具体 turn。 |
| `dsh-agent-loop/lib/index.js`，218、338–346 行；本机上下文生产者 | 内部 user-role 上下文包括 `runtime-context`、`time-context/snapshot`、`dsh-mnemon/instructions` 与 `dsh-mnemon/recall`；它们不代表新增渠道输入。按已核实的 kind/form 精确识别，不按插件名前缀放行。 |
| `dsh-agent/lib/index.js`，133–146 行 | 模型切换通知使用 `source.kind:'model-selection', form:'notice'`，同样属于内部上下文。 |
| `dsh-llm/lib/index.js`，37–63 行 | `createUserMessage({content,source})` 生成稳定 UUID，并 deep-freeze 消息。插件来源使用 producer-owned `kind:'plugin:dsh-vocechat-bridge'`，来源元数据保留 channel、destination、消息 ID、发送者、时间及附件信息。 |
| `dsh-session-query/lib/index.js`，350、450–480、1064 行 | `observeSession(id,{projectionMode:'all',signal})` 返回 observation lease；模型选择位于 `observation.projections.values.modelSelection.pending`，preset 位于 `values.agentPreset`。lease 使用 **`[Symbol.dispose]()`** 释放。 |
| `dsh-api-session-controller/lib/index.js`，274–300 行 | 官方 GUI 选择模型的优先级为 pending model selection → 最近 `request/header` → 部署默认。桥接冷恢复遵循此顺序，且不把由 adapter 默认提供的 reasoning effort 固化为用户选择。 |
| `dsh-agent-preset-registry/lib/index.js`，686 行 | `agentPresets.mount(agentCtx,presetId)` 在 Agent setup 中恢复原 preset 的插件组合。未指定覆盖时使用该会话记录的 preset；没有记录时沿用宿主默认。 |
| `dsh-attachment/lib/index.js`，228、273 行及 `saveFile` | 图片通过 `attachments.saveImages([{data,mediaType,name}])` 存为 durable image references；文件通过 `saveFile({data,name})` 存为 durable file references。临时下载文件清理后，会话中的持久附件仍有效。 |
| `dsh-tools/lib/index.js`，838、3238–3254 行 | `defineTool` 编译并校验参数；`execute(args,exec)` 的 `exec.agent` 是调用会话身份，`exec.signal` 是取消信号，`exec.concludeTurn()` 可结束本轮。 |
| `dsh-system-prompt/lib/index.js`，context 注册 | 通过目标 `agent.ctx.get('systemPrompt').context(...)` 注册短小的动态 transport context，提供本轮结构化来源与工具说明；不替换 persona，不在每条用户消息后追加协议说明。 |

## 原生多模态能力

当前版本提供 `text`、`image`、`file` 输入内容块，没有可以直接投递模型的原生 `audio` 块。音频接收采用两个独立表示：真实 ASR 转写作为文本内容，原音频作为持久文件附件。ASR 关闭或失败时明确显示不可用信息，不伪造转写。

图片以原生 image reference 进入会话。目标模型必须支持图片输入才能理解图片；对于纯文本模型，宿主会进行 text-only 投影并显示 image omitted。本插件不额外调用视觉模型，不假称文本模型已经看懂图片。

## 共享会话与来源隔离

桥接在入站队列中按顺序处理，并在每轮调用前等待宿主 `whenIdle()`。投递仅使用 `followup`，保持宿主唯一 driver 的串行语义，不使用 `steer`、不取消 Web 或 QQ 的工作。

v0.2.0 先按来源/会话/发送者完成独立防抖并封批，再准备附件与 ASR。`DshSessionPort` 将一个批次构造成一条 `createUserMessage`，保留有序内容块及全部原始消息元数据，只调用一次 `followup`。等待 `whenIdle()` 期间维持可恢复状态，不消耗本轮 `turnTimeoutMs`；在 followup 前通过插件自己的提交屏障持久化 `dispatching`，随后才开始计算本轮超时。这是桥接内部协作接口，不是新增宿主 API。

自动回复必须同时满足：固定会话 ID、自己生成的入站 message ID、该 message 所属 turn、正常 `completed` 结束。只读取最后 step 的文本，避免把工具前的过程叙述当最终回复发送。

若其他渠道在同轮插入外部 user-role 消息，该轮标记为来源混合：自动回复关闭。内部运行上下文、已核实的记忆召回、时间快照和模型切换通知不会触发这一保护。未知生产者或同一生产者的其他 form 仍作为外部输入处理，避免把真实的新任务误当成背景。

主动工具发送必须显式给出 `{kind:'user'|'group',id:number}`，调用者须是配置的目标会话，发送层继续校验 UID/GID 白名单。发往当前来源以外的目标，或由 Web/QQ、混合来源轮次调用工具，属于主动发送，受 `allowProactive` 开关约束。历史查询只读，独立校验固定 Session 的真实 Agent 与目标白名单，不依赖自动回复归属，也不受主动发送开关影响。

成功工具发送会抑制本轮重复自动文本。组合发送部分成功后失败，也抑制自动文本；返回的错误应由 Agent 处理，不自动重传已经发送的片段。`voce_quiet` 设置本轮 quiet 并调用宿主 `concludeTurn()`，无需 `<noop>` 等文本标记。

取消只停止桥接等待和外发，不取消共享 Agent。提交前停止的批次保留为 ready，重启可继续；持久化 dispatching 后未确认完成的消息不能当作未投递重新提交，运行层将其记录为 uncertain，供人工核查。其他渠道排在自己之前的独立 turn 不会抑制本轮回复；只有同轮来源混合才关闭自动外发。

## 验证记录

`tests/dsh.test.ts` 当前 **22 个测试通过**，覆盖来源归属、共享会话顺序、其他渠道混入、最后 step、失败 turn、冷恢复、模型和 preset 恢复、observation lease 释放、原生附件、取消、工具发送、部分成功与 quiet，以及合并批次单条投递、提交屏障、忙碌等待超时隔离、不同发送者拒绝合并和前置 Web turn 隔离。v0.4.1 增加内部上下文误判及混合回合显式读取/主动发送的验证；相同生产者的未知 form、未授权目标与关闭主动发送仍被正确限制。

另外使用本机 **真实 0.2.1-rc.3** `dsh-tools.defineTool` 编译全部十个工具的参数 schema（含 `voce_speak` 与两个历史查询工具），均通过；使用真实 `dsh-llm.createUserMessage` 和 `dsh-session.Session.create/append` 验证结构化插件 source 的 `user/message`，已被宿主接受且消息不可变。这些验证只在内存中执行，不连接生产会话、不调用模型、不发送真实消息。

完整插件入口也已执行本机 smoke：加载实际 `dist/index.js`，使用真实 Schemastery 解析默认配置、真实 `defineTool` 编译和校验工具，在假 Cordis ctx 中调用 `apply`、effect 与重复 dispose。结果：默认 disabled、十个工具注册成功、`listenCalls:0`、正常清理、用户配置写入/模型调用/真实消息均为零。

客户端只注入 `slots`，在 `settings.section` 注册“VoceChat”；宿主可选注入 `webServer`，挂载 `/api/vocechat-bridge/settings`。

表单值保存在插件自己的 `settings.json`，优先于 profile 同名值，避免桌面启动方式缺少 root Include 时宿主设置写入失败。原 Config 和语音 `.volatile()` 保留兼容；凭据通过宿主 `credentials.describe/set` 操作，不回传实际 Key。启动/停止/重载由 `BridgeRuntime` 串行执行，重建 Bridge 和 SessionPort；工具通过动态代理使用当前实例，停止设置页不会停止 DSH 的 webServer 或共享 Agent。客户端在只有 slots 的测试环境验证注册和保存；本地真实 HTTP 验证监听启停重载，未在用户窗口中点击操作。

自动启动由 `AutoStartController` 管理，先等设置加载，监听可选 `credentials/webServer` 服务就绪，并对启动失败做有上限间隔的重试。旧的一次性 `ready.then(runtime.start)` 在首次启动失败后不再恢复，已移除。持久 enabled 为 false 或插件卸载时取消重试，避免用户停止后又被后台拉起。

`verify-host.cjs` 还用真实入口连续挂载两次隔离的启用实例：第一轮凭据迟到，第二轮直接读取持久 enabled，两轮均自动建立真实本机监听并返回 GET 200。该检查使用假的凭据/Agent，不会替用户重启整个 DSH。

可复现脚本为 `scripts/verify-host.cjs`，先运行 `npm run build`，再使用安装版本的 Electron 可执行程序运行：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DSH 安装目录>\DeepSeek Harness.exe' scripts\verify-host.cjs '<DSH 安装目录>\resources\app.asar'
```

脚本借助 Electron 自带的 ASAR 只读文件系统访问发行库，并使用进程内 `module.registerHooks` 将插件三个 peer imports 指向该版本。无需解包、安装、junction 或更改宿主依赖；fake state/temp 路径仅指向工作区内临时目录，结束后清理。此脚本需要宿主内置 Node 支持 `registerHooks`（本次测试的 Electron 内置 Node 24 已支持）。

以上属于 mock 会话自动化测试与真实发行库兼容性验证，**不等于已在真实 DSH 会话、真实 VoceChat 服务及付费 ASR 上完成端到端联调**。
