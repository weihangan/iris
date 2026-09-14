# iris-chat

**English** | [中文](#中文)

iris-chat is a replicable Electron + TypeScript 3D character-chat development
framework: PMX desktop-pet rendering + a full local conversation service
(LLM, memory, ASR, GPT-SoVITS TTS) + voice-clone training. The repo contains
source and small example assets only — heavy runtimes (GPT-SoVITS,
Python/Torch, CUDA, voice weights) and API keys are prepared per the
deployment guide.

## Documentation

| Doc | Language | Content |
|---|---|---|
| [README-Project-Introduction.en.md](README-Project-Introduction.en.md) | English | Features, architecture, repository map, extension points |
| [README-Deployment-Guide.en.md](README-Deployment-Guide.en.md) | English | AI-executable deployment: prerequisites, runtime install, GPT-SoVITS base models, startup, checklist |
| [README-项目介绍.md](README-项目介绍.md) | 中文 | 功能、架构、目录地图、扩展方式 |
| [README-部署指南.md](README-部署指南.md) | 中文 | AI 可执行部署：前置条件、运行时安装、GPT-SoVITS 底模、启动、验收清单 |

Quick start: `npm install` → `npm run runtime:install` → place GPT-SoVITS base
models and voice weights → `npm run tts:cpu` (or `tts:gpu`) → `npm run start`.

---

<a id="中文"></a>

**中文** | [English](#iris-chat)

iris-chat 是一个可复刻的 Electron + TypeScript 3D 角色聊天开发框架：PMX 桌宠渲染 +
本机完整对话服务（LLM、记忆、语音识别、GPT-SoVITS 语音合成）+ 语音克隆训练。
仓库只含源码和小型示例资源——GPT-SoVITS、Python/Torch、CUDA、语音权重等大件和
API 密钥按部署指南准备。

## 文档

见上表，四份文档中英各两份：项目介绍（功能与架构）和部署指南（从零到完整语音）。

快速开始：`npm install` → `npm run runtime:install` → 放置 GPT-SoVITS 底模和声音权重
→ `npm run tts:cpu`（或 `tts:gpu`）→ `npm run start`。
