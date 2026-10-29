# 语音设置与 Provider

v0.3.0 内置标准 OpenAI 与小米 MiMo 的语音识别、合成。厂家差异封装在 Provider 中，桥接和 Agent 使用统一的转写、语音发送结构。Qwen Omni 等音频理解仍是独立扩展，没有混入 ASR。

## 设置页

安装并重启对应 profile 后，打开 DSH 侧栏 **插件 → VoceChat 语音**：

1. 语音总开关控制模型调用；识别、合成各有独立开关，默认都关闭。
2. 分别选择 **OpenAI 标准接口** 或 **小米 MiMo**，填写模型、API 根地址、Key 引用和 Key。
3. 地址、模型、音色留空时跟随厂家默认值；切换厂家会清除这些覆盖值，并选择该厂家的凭据引用。
4. 合成可选择 WAV/MP3、音色 ID 和声线/语气描述。MiMo voicedesign 需要填写描述。
5. 保存后配置持久化到宿主 profile，下一次语音请求生效；已有请求继续使用开始时的设置。

页面注册在宿主 `plugins.item`，使用 `configForms` 的原子字段修改与版本检查。语音字段通过 Config 的 `.volatile()` 声明；本页不是仅导出 Schema 的占位页。服务未加载时不显示，部署只读时禁止保存。bundle 的插件 entry id 应保持 `vocechat-bridge`。

密码输入只用于写入 DSH credentials；已有 Key 不会读回页面。留空保留原 Key。配置文件保存凭据引用名；后台每次请求从 credentials 或同名环境变量解析，不在日志中输出凭据或服务响应正文。

## 请求协议

| 厂家 | 识别 | 合成 | 默认模型 |
| --- | --- | --- | --- |
| OpenAI 标准接口 | `/audio/transcriptions`，multipart 的 `file/model/response_format=json`，可选 `language`；返回 `text` | `/audio/speech`，JSON 的 `model/input/voice/response_format`，可选 `instructions`；返回音频字节 | `whisper-1` / `gpt-4o-mini-tts` |
| 小米 MiMo | `/chat/completions`，`input_audio` data URL 与 `asr_options.language`；读取 `choices[0].message.content` | `/chat/completions`，assistant 消息为待合成文本，user 消息为描述；读取 `choices[0].message.audio.data` | `mimo-v2.5-asr` / `mimo-v2.5-tts` |

OpenAI 默认 API 根地址为 `https://api.openai.com/v1`，音色 `alloy`；MiMo 为 `https://api.xiaomimimo.com/v1`，音色 `mimo_default`。均使用 Bearer 鉴权。MiMo voicedesign 自动省略 `audio.voice`；当前不支持 voiceclone。标准接口的风格描述是否生效取决于所选模型。

协议依据：[OpenAI 转写](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[OpenAI 合成](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)、[MiMo 识别](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)、[MiMo 合成](https://mimo.mi.com/docs/zh-CN/api/audio/tts)。模型可用性以所用服务为准，设置页允许覆盖模型名。

## 配置示例

MiMo 的识别和合成使用同一凭据引用，实际 Key 保存在 DSH credentials 或进程环境：

```yaml
voiceEnabled: true
asrEnabled: true
asrProvider: mimo
asrBaseUrl: ''
asrModel: ''
asrApiKeyRef: MIMO_API_KEY
asrLanguage: auto
ttsEnabled: true
ttsProvider: mimo
ttsBaseUrl: ''
ttsModel: mimo-v2.5-tts
ttsApiKeyRef: MIMO_API_KEY
ttsVoice: mimo_default
ttsInstructions: '语速自然，语气平静。'
ttsFormat: wav
```

使用 MiMo 音色设计时，将 `ttsModel` 改为 `mimo-v2.5-tts-voicedesign` 并填写 `ttsInstructions`；插件不会因为填写了风格描述而擅自替换模型。

本地 Whisper / faster-whisper 兼容 HTTP 服务继续使用标准转写 Provider：

```yaml
voiceEnabled: true
asrEnabled: true
asrProvider: openai
asrBaseUrl: 'http://127.0.0.1:8000/v1'
asrModel: whisper-large-v3
asrApiKeyRef: '' # 无鉴权本地服务；需要鉴权时填写引用
asrAcceptedFormats: ['wav']
asrLanguage: zh
```

官方默认地址下未指定引用时，OpenAI 使用 `OPENAI_API_KEY`，MiMo 使用 `MIMO_API_KEY`。自定义 OpenAI 兼容地址和空引用表示不发鉴权头；如需 Key，设置引用名。

## 音频输入与 DSH 消息

下载后先检查真实容器、字节大小和时长。MiMo 输入统一经 FFmpeg 转为 **16 kHz、单声道、PCM s16le WAV**，只把转换后的副本送去识别，原文件不改动。标准 OpenAI Provider 根据 `asrAcceptedFormats` 决定是否转换：设为 `[wav]` 只会转换其他容器，已接受 WAV 不强制重采样。

语音与同批文字、附件合并成一条 DSH 用户消息，内容包括：

- 转写文本，标注原消息 ID 和文件名，使多条语音可以对应。
- 通过 DSH attachments 保存的**原始音频文件**，包含原字节和文件名。
- source 中有序保存的原消息 ID、发送者、时间、附件元数据及转写结果。

DSH 0.2.1-rc.3 没有原生 audio 内容块，因此原音频使用 durable `file` reference；是否能直接理解声音取决于目标模型和宿主工具。插件不会声称文本模型已经听到音频。识别关闭或失败时仍保留原文件，并给出不可用说明；不会伪造转写。已持久化的转写结果在未提交批次恢复时复用。

## 语音输出

启用 TTS 后，Agent 使用 `voce_speak` 或组合消息中的 `speech`，不依赖文本标记，也不强制每条普通回复合成语音：

```json
{
  "destination": {"kind":"user","id":1},
  "text": "这是文字说明",
  "speech": {"text":"这是语音内容","instructions":"自然一点，放慢语速。"}
}
```

上述为 `voce_send_message` 参数；单独 `voce_speak` 使用顶层 `text`、可选 `voice/instructions`。合成成功且校验真实容器、时长、大小后上传为 `vocechat/audio`；文件降级、白名单、来源隔离和部分成功处理沿用现有发送路径。合成失败时不会先发送文字。暂存副本在成功、失败或取消后清理，Agent 无需获得临时目录的读取权限。

## 扩展与验证

ASR 使用 `AsrProvider.transcribe(file, signal)`，统一返回 `{text, language?, durationSeconds?}`。TTS 使用 `TtsProvider.synthesize(text, {voice?, instructions?, signal?})`，统一返回 `{bytes, name, mime, durationSeconds}`。发布包从 `/audio` 导出接口，从 `/speech` 导出 `createAsrProvider`、`createTtsProvider`、`speechOptions`。

识别与合成均限制超时和响应大小，拒绝重定向，不把 API Key 或供应商响应正文拼入错误。FFmpeg/FFprobe 通过参数数组执行，只允许 `file,pipe` 协议，Windows 不弹终端窗口。压缩音频时长检查需要 FFprobe，MiMo 归一化需要 FFmpeg；插件不安装系统依赖或本地模型。

本次仅新增两项功能测试：MiMo 识别请求/真实 WAV 归一化，以及两家 TTS 经合成、校验、上传、语音发送的本地闭环。原有转写和 DSH 附件验证继续复用；这些本地服务返回固定测试内容，不代表已经调用云端模型。
