# 第三方与许可声明

核对日期：2026-10-29。本文件记录本项目的集成边界、参考实现和已核实的上游许可；具体上游版本以其随附许可为准。

## 本项目的许可范围

`dsh-vocechat-bridge` 原创插件代码、相应构建产物及原创文档自本次发行起采用 [Apache License 2.0](LICENSE)。版权和项目归属见 [NOTICE](NOTICE)。

本仓库与 npm 包没有打包 DSH 宿主、VoceChat 服务端、VoceChat Web 客户端或官方/修补 Docker 镜像。运行时通过 DSH 提供的接口和 VoceChat HTTP API 集成；上游软件自身的使用、修改和再分发仍须遵守各自的许可。

v0.4.1 及更早提交保留其当时的 MIT 授权。此次许可变更不撤销已授予的权利。

## DeepSeek Harness

- 项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 官方许可：[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)
- 版权：Copyright (c) 2026 DeepSeek
- 本项目使用：宿主提供的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` peer dependency，以及 Agent、Session、附件和设置接口。

MIT 允许使用、修改与再分发，复制其软件或实质部分时需要保留版权与许可声明。为保留归属，附有上游完整 [MIT 许可文本](licenses/DeepSeek-Harness-MIT.txt)。DSH 自身包含的其他依赖见其 [THIRD_PARTY_NOTICES.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md)，这些组件未随本插件重新打包。

## VoceChat 服务端与官方镜像

- 项目：[Privoce/vocechat-server-rust](https://github.com/Privoce/vocechat-server-rust)
- 官方许可文件：[license](https://github.com/Privoce/vocechat-server-rust/blob/master/license)
- 官方镜像：[privoce/vocechat-server](https://hub.docker.com/r/privoce/vocechat-server)

官方许可文件和 README 对组件分别声明：

| 组件 | 上游声明 |
| --- | --- |
| 服务端代码 | Big Time Public License 2.0.0 |
| 官方 Docker 镜像 | Creative Commons Attribution-NonCommercial 4.0 International |

Big Time Public License 按非商业用途、小型企业及大型企业分别规定授权条件，并要求转交其条款/链接和相应 Required Notice。不能据此概括为无限制商业使用。CC BY-NC 4.0 包含署名、非商业用途等条件，分享修改版本还应标明修改；具体见[完整法律文本](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en)。

公开仓库的 `Cargo.toml` 虽然写有 `license = "MIT"`，但这与仓库 `license` 和 README 的组件声明不一致。本项目不以该元数据字段推定官方服务端或镜像可按 MIT 使用，也不将它们改授 Apache-2.0。

本插件只实现 API 客户端与 Webhook 接收端，没有分发官方二进制或修补镜像。兼容性调查的结论不改变上游授权；对服务端或镜像的修改和再分发，需要另行遵守实际版本的上游条款及其包含组件的许可。

## VoceChat Web

- 项目：[Privoce/vocechat-web](https://github.com/Privoce/vocechat-web)
- 官方许可：[GNU GPL version 3](https://github.com/Privoce/vocechat-web/blob/main/LICENSE)

该仓库用于核对浏览器发送、事件流和 Bot 设置行为。本插件不打包其前端代码或静态资源；它的 GPL 许可不因本项目使用 Apache-2.0 而改变。

## 参考实现与工具

- [sj244/dsh-qq-bridge](https://github.com/sj244/dsh-qq-bridge)：DSH 固定会话和渠道桥接方式的参考。上游为 [MIT](https://github.com/sj244/dsh-qq-bridge/blob/main/LICENSE)，Copyright (c) 2026 sj244；保留其[许可文本](licenses/dsh-qq-bridge-MIT.txt)。
- FFmpeg / FFprobe：可选外部程序，由部署者单独安装；构建选项不同可能适用 LGPL、GPL 或其他组件条款，不随本 npm 包分发。
- TypeScript：开发构建工具，Apache-2.0；Node.js 类型定义为开发依赖，MIT。它们的安装副本和许可由包管理器管理。

标准 OpenAI 协议与小米 MiMo 的支持不授予相关 API 服务、模型或音色的使用权；服务商的账户条款、费用和内容使用条件由部署者与服务商约定。

## 商标

DeepSeek、VoceChat、Privoce 及其他产品名称属于各自权利人。本项目仅使用名称说明兼容性，不授予商标权，也不声称获得官方背书。
