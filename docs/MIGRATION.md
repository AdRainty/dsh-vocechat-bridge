# 从旧 Webhook 桥接迁移与回滚

本次开发没有修改 `vocechat-bridge`、QQ 桥接、SOUL、记忆或自主定时任务，也没有执行生产切换。新插件默认禁用，使用独立 8898 端口和独立状态目录。

## 切换步骤

1. 备份旧桥接的启动方式、环境配置、Webhook URL 和 DSH profile 的 `cordis.patch.yml`；凭据备份放在受保护位置。记录旧监听端口、Bot UID 和目标 Session ID。不要把含密钥的配置复制进本项目。
2. 安装本插件，先保持 `enabled:false`。按 USAGE 填写相同的**已有 Session ID**，不要新建 Session；配置 Bot Key 的凭据引用、机器人自身 UID、UID/GID 白名单。
3. 确认可用的 ASR 服务；本地兼容服务不需要云端 Key。运行 `npm run check`。图片需要支持图片输入的目标模型；压缩音频检查 FFprobe，转换检查 FFmpeg。
4. 用独立测试 Bot/测试群验证文字、图片、文件、语音和组合发送。独立测试可以使用同一插件实现与单独 statePath；正式会话联调会实际写入会话历史并可能产生模型费用。
5. 正式切换时，先停止旧桥接进程及会自动拉起它的 watchdog/启动任务，再启用插件、重启 DSH profile，并把 VoceChat Webhook 改到新端点。不要同时让旧桥接与新插件接收同一个 Bot 的相同事件，否则各自去重无法阻止跨进程重复回复。
6. 新端点 GET 验证必须带共享 secret；确认 Webhook 不启用旧 AES 加密。发送一次私聊和群聊，核对原目标回复、图片/音频与白名单；在 DSH Web 和 QQ 各发一条测试消息，确认没有自动转到 VoceChat。
7. 确认完成前保留旧程序与备份。不要导入旧 `[img:...]`、`<noop>` 或“所有会话回复都转发”的消息协议；新插件通过工具与本轮来源完成这些行为。

## 回滚

1. 将新插件 `enabled` 设为 `false`，重启该 DSH profile；确认状态工具显示停止或插件已经卸载。
2. 把 VoceChat Webhook URL 恢复为备份中的旧地址，再恢复旧桥接进程与原 watchdog。核对旧端口监听与消息发送。
3. 保留新插件 `state.json` 供核查 `pending/uncertain` 消息。不要让两套程序同时自动重放；逐条核对消息 ID，再决定是否人工补发。
4. 如需卸载，通过 DSH 插件管理移除 `vocechat-bridge`。状态目录和宿主持久附件属于聊天数据，确认不再需要后再自行清理。

桥接不改原 Session ID、人格或长期记忆文件；正式测试产生的会话聊天历史仍会保留，回滚通信插件不会回滚聊天记录。
