# iris-chat 项目介绍

iris-chat 是一个可复刻的 Electron + TypeScript 3D 角色聊天开发框架：PMX 桌宠渲染 +
完整对话服务（LLM、记忆、语音识别、语音合成）+ 语音克隆训练，全部运行在本机。
GitHub 仓库只含源码和小型示例资源，不含 GPT-SoVITS、Python/Torch、CUDA、语音权重或 API 密钥——
这些大件按 [README-部署指南.md](README-部署指南.md) 准备。

## 功能总览

- **3D 桌宠**：PMX 模型渲染（three-mmd-loader）、口型同步、表情、VMD 动作、物理、拖动、缩放、转身、待机池。
- **对话**：LLM 对话（情绪/口型/动作标签驱动表演）、聊天历史、长期记忆、搜索蒸馏、角色 Skill 与表情包。
- **语音**：本机 GPT-SoVITS 合成（CPU/GPU 自动选择）、长句分段流式播放、麦克风语音输入（ASR）。
- **语音克隆**：内置训练页——音频收集、切片、标注、训练、部署为可选声音。
- **多窗口**：聊天窗、桌宠窗、输入条窗；背景、灯光、透明、鼠标穿透、托盘恢复。

## 架构与调用流程

```
Electron 主进程（electron/）
  ├─ 聊天窗 / 桌宠窗 / 输入条窗（src/ 渲染层，three.js PMX）
  └─ 启动并监视 chat5-compat/server.js
        ├─ /api/chat → LLM Provider（OpenAI / Anthropic / 自定义 compatible 接口）
        │     → 情绪、口型、动作匹配 → 桌宠表演
        └─ POST 127.0.0.1:9882/tts/json → tts_engine/selina_tts_api.py
              → GPT-SoVITS（runtime/gpt-sovits，CPU 或 GPU）→ WAV → 播放 + 口型 + 语音动作
```

短句直接合成；长句按标点和可朗读字数分段，首段完成即可播放，后续段无缝排队。
在 mute 或纯文字模式下只显示文本，不会生成假口型。

## 目录地图

| 目录 | 内容 |
|---|---|
| `src/` | 渲染层：模型加载、动作/物理、灯光、桌面桌宠渲染器、对话控制器、模型包类型 |
| `electron/` | 主进程：窗口生命周期、模式控制、托盘、IPC 策略 |
| `chat5-compat/` | 对话服务（Express，127.0.0.1:3003）：`server.js` + `services/`（LLM 客户端、记忆、蒸馏、TTS 预检、ASR）+ `prompts/` + `public/`（网页聊天 UI）+ `character/1/`（默认角色包）+ `tts_engine/`（GPT-SoVITS Python 封装）+ `voice_engine/`（克隆训练管线），详见 [chat5-compat/README.md](chat5-compat/README.md) |
| `models/` | 模型包目录 + 共享 VMD/语音动作池，包格式见 [models/README.md](models/README.md) |
| `scripts/` | 运行时安装/检查/启动/切换、GPU 驱动检查、克隆训练安装、发布准备 |
| `tests/` | Vitest 单元测试 + Playwright e2e |
| `docs/superpowers/` | 内部工作流文档 |

## 通用表演池与模型适配

表情配方、动作池、语音动作池是全局共享的；每个模型用自己的 `manifest.json` 独立描述
Morph、骨骼、口型、视线和物理映射。框架只执行 manifest 里映射过的部分——不会把
赛琳娜专属 Morph 强行套给其他模型。动作结束后恢复当前角色的默认待机；
头部语音动作不替换身体待机。

## 角色与设置页

- 创建多角色，搜索蒸馏生成 Skill；用户称呼和额外设定优先于风格约束，且可手动编辑。
- 语音设置页选择声音、参考音频和 CPU/GPU 设备。
- 模型页支持模型、头像、背景、灯光、缩放、透明、穿透、转身、待机配置。

## LLM Provider

默认 Provider 是空的 custom 配置。支持 OpenAI-compatible `chat/completions`、
Anthropic-compatible `messages`，以及动态 `models` 列表。配置里的示例只是格式示范，
必须填入自己的地址和密钥（保存在 userData，不进 Git）。

## 构建与发布边界

- `npm run start`：构建 + 运行；`npm run build`：仅构建渲染层；`npm run test` / `npm run test:e2e`。
- 打包配置在 `package.json` 的 `build` 字段（electron-builder，输出 `release-dist/`，非 asar）。
- 永远不要提交：`runtime/`、`node_modules/`、`dist/`、userData、API Key、
  `pth`/`ckpt`/`safetensors` 权重、聊天历史和记忆文件。
- `models/` 内的示例模型仅限本地开发，授权禁止二次配布（详见 models/README.md）。

## 下一步

完整语音部署按 [README-部署指南.md](README-部署指南.md) 执行；英文版见
[README-Deployment-Guide.en.md](README-Deployment-Guide.en.md)。
