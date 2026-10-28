# 音频与 Provider 扩展

本版内置 `OpenAICompatibleAsr`，实现可由管理员指定地址的 multipart 转写协议，可以连接兼容此协议的本地 Whisper / faster-whisper HTTP 服务。不会下载或启动 Whisper，也不会自动选择云端服务、生成凭据或调用真实模型。

## 启用转写

在插件配置中设置以下字段。`asrBaseUrl` 是 API 根地址，插件在其后追加 `/audio/transcriptions`；例如本地服务完整 endpoint 是 `http://127.0.0.1:8000/v1/audio/transcriptions`，则填 `http://127.0.0.1:8000/v1`。

```yaml
asrEnabled: true
asrBaseUrl: 'http://127.0.0.1:8000/v1'
asrModel: 'whisper-large-v3'
asrAcceptedFormats: ['wav'] # 仅接受 WAV 的服务；其他格式经 FFmpeg 转码
asrApiKeyRef: ''       # 无鉴权的本地服务可留空；否则填 DSH 凭据引用名
asrLanguage: 'zh'     # 留空由服务识别
asrTimeoutMs: 60000
maxMediaBytes: 26214400
maxAudioSeconds: 300
ffmpegPath: 'ffmpeg'
ffprobePath: 'ffprobe'
```

模型名称必须与所使用服务的配置一致。音频会上传到 `asrBaseUrl` 指定的服务；仅对希望使用的转写服务启用该配置。兼容服务可使用自己的鉴权方式，但当前内置实现只支持可选的 `Authorization: Bearer`。凭据通过注入的 resolver 按请求重新读取，配置文件保存引用名。

协议字段为 multipart `file`、`model`、`response_format=json` 和可选 `language`，期望 JSON 响应 `{ "text": "转写文字" }`，可附带 `language`。字段依据 [OpenAI 官方 transcription API 文档](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) 核实；这里只适配共同字段，不承诺任意兼容服务支持全部容器、模型或特殊参数。

空响应、无文字、无效 JSON、HTTP 错误、网络失败和超时均返回明确错误，绝不填入示例转写或推测内容。Provider 响应正文和凭据不会进入错误文本。HTTP 重定向被拒绝，防止鉴权头被转交其他地址。

## 格式、时长与转换

音频实际容器通过文件字节识别，忽略不可信的文件扩展名和 MIME 声明。本版识别 WAV、MP3、OGG（包括 Opus）、M4A、FLAC 和 WebM；容器可识别不代表所用服务支持内部编码。

- 普通 PCM / IEEE float WAV 从 RIFF chunk、采样率、帧宽及实际数据长度计算时长，无须 FFprobe。
- 压缩音频和扩展 WAV 使用 FFprobe 检查音轨和时长；缺少依赖、无法解码或无法确定时长时拒绝处理。
- 在下载及音频处理阶段限制大小；探测后限制时长；转写请求限制超时和响应大小。未启用 ASR 时，桥接仍验证音频格式和时长。
- 内置 Provider 默认直接上传上述六类容器。对只接受 WAV 的服务，在插件配置中指定 `asrAcceptedFormats: ['wav']`（程序调用参数为 `acceptedFormats: ['wav']`），将其余容器经 FFmpeg 转成 16 kHz 单声道 PCM WAV。列表不得为空；若拒绝原格式且未包含 WAV，则明确报错，不尝试其他输出编码。
- `acceptedFormats` 控制容器接受范围，不强制归一化已接受的音频：例如 `['wav']` 下，已有 WAV 会保留原采样率、声道和编码。服务若要求所有输入均为 16 kHz 单声道 PCM，需要上游预处理或扩展 Provider；当前没有强制重采样开关。旧脚本的实际格式与协议差异见 [迁移经验](MIGRATION.md#asr-的容器采样率声道与请求协议要分别确认)。
- 转换使用 `execFile` 参数数组启动进程，不通过 shell 拼接附件名称或命令。FFmpeg / FFprobe 只允许 `file,pipe` 协议，不能因媒体内嵌引用发起网络请求。
- 转换前后都检查文件，转换输出超限时拒绝转写；临时转换目录在成功、失败及取消后均清理。入站原始下载文件的生命周期由桥接管理。

安装 FFmpeg 时也须安装 FFprobe，并将二者加入 PATH，或配置其可执行文件的完整路径。插件不会安装系统软件。依赖不存在时错误会明确说明缺少 FFprobe 或 FFmpeg。Windows 启动这些处理进程不会打开终端窗口。

## ASR 扩展接口

接口定义位于 `src/audio.ts`，发布包从 `dsh-vocechat-bridge/audio` 导出声明。

```ts
interface AudioFile {
  path: string;
  name?: string;
  mime?: string;
}
interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}
interface AsrProvider {
  transcribe(file: AudioFile, signal?: AbortSignal): Promise<TranscriptionResult>;
}
```

内置实现的独立用法：

```ts
import { OpenAICompatibleAsr } from 'dsh-vocechat-bridge/audio';

const asr = new OpenAICompatibleAsr({
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'whisper-large-v3',
  language: 'zh',
  acceptedFormats: ['wav'],
  maxBytes: 25 * 1024 * 1024,
  maxDurationSeconds: 300,
  timeoutMs: 60000,
  // resolveApiKey: () => credentialService.resolve('LOCAL_ASR_KEY'),
});
const result = await asr.transcribe({ path: '/trusted-cache/voice.ogg' }, abortController.signal);
```

Aliyun Bailian 的专属鉴权、异步任务及响应格式应另行实现 `AsrProvider`，不能假设它们等同于此 multipart 协议。接入厂商适配器时，应在独立服务工厂中选择实现，再将结果放回统一消息结构；不要把厂商密钥、上传 URL 或原始请求拼入模型消息。服务工厂的替换需要代码扩展，本版没有宣称已内置百炼适配器。

## 音频理解与 TTS

本阶段只预留这两个独立接口，没有内置模型实现，也不自动启用。已有音频文件可以通过发送工具上传，无需 TTS。

```ts
interface AudioUnderstandingProvider {
  understand(file: AudioFile, signal?: AbortSignal): Promise<{
    description: string;
    acousticCues?: string[];
    nonSpeechSounds?: string[];
    environmentalSounds?: string[];
    uncertainInterpretations?: string[];
  }>;
}

interface TtsProvider {
  synthesize(text: string, options?: {
    voice?: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<AudioFile>;
}
```

未来接入 Qwen Omni 时，音频理解应与 ASR 分别配置启用开关：既可只转写，也可只分析声音，或两个都使用。应明确记录分析来源，并把情绪等解释性结论放入 `uncertainInterpretations`，不能当作用户自述或医学判断。返回的 TTS 音频继续经过同一验证、大小时长限制及上传发送路径，不改变普通文本回复的默认行为。

## 验证范围

`tests/audio.test.ts` 启动本机 Mock HTTP 服务验证 multipart 协议、凭据重新解析、成功转写响应、无凭据本地服务、HTTP/JSON/空转写错误、超时、取消、响应超限、重定向拒绝及缺少音频依赖。

若本机存在 FFmpeg 和 FFprobe，还会实际生成 FLAC、检测时长、转成 WAV 并上传到 Mock 服务，检查成功及失败后的临时目录清理。缺少依赖时该转码用例会标记为跳过。Mock 返回文字用于验证数据流，不是实际语音模型的准确率验证。本次开发未对真实 ASR 模型或云端凭据发起调用。
