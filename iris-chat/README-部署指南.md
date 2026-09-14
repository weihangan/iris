# iris-chat 完整部署指南（AI 可执行）

本文件面向人类和 AI 操作者：从零开始下载依赖、准备语音运行时、启动完整语音版 iris-chat。
每一步都带有验证命令，全部通过即部署成功。

## 0. 前置条件

| 依赖 | 版本 | 用途 | 检查命令 |
|---|---|---|---|
| Windows 10/11 x64 | — | 运行环境 | — |
| Node.js | 18+ | 应用本体 | `node -v` |
| npm | 9+ | 依赖安装 | `npm -v` |
| Python | 3.11（含 py launcher） | 创建 CPU/GPU 虚拟环境 | `py -3.11 -V` |
| git | 任意较新版本 | 克隆 GPT-SoVITS | `git -v` |
| NVIDIA 驱动 | 较新版本 | 仅 GPU 语音需要，无独显走 CPU | `nvidia-smi` |

Python 从 https://www.python.org/downloads/ 安装时勾选 "py launcher"。
GPT-SoVITS 推理源码约 2.21 GB，CPU Python/Torch 约 1.21 GB，GPU Python/Torch 约 4.57 GB，
预训练底模和声音权重另计——这些都不在仓库里，由下述步骤自动或手动准备。

## 1. 安装项目依赖

```powershell
npm install
npm run check
```

`npm run check` 是 TypeScript 类型检查，必须无错误退出。

## 2. 一键安装语音运行时

```powershell
npm run runtime:install
```

脚本（`scripts/install-runtime.ps1`）会：

1. 在仓库根创建 `runtime/` 目录；
2. 用 py launcher 创建 `runtime/python_cpu/` 和 `runtime/python_gpu/` 两个 venv，
   分别安装 CPU 版和 CUDA 12.6 版 PyTorch 及公共依赖；
3. 克隆 GPT-SoVITS 源码到 `runtime/gpt-sovits/`；
4. 写入 `runtime/runtime-config.json`。

只需 CPU 时可改为：`powershell -File scripts/install-runtime.ps1 -Device cpu`。
无法使用 git 时可加 `-SkipGptClone`，然后手动把 GPT-SoVITS 源码放到 `runtime/gpt-sovits/`。

验证：

```powershell
Test-Path .\runtime\python_cpu\python.exe     # True
Test-Path .\runtime\python_gpu\python.exe     # True（装了 GPU 才有）
Test-Path .\runtime\gpt-sovits\api.py         # True
npm run tts:check:cpu    # CPU 运行时自检通过
npm run tts:check:gpu    # 装了 GPU 才需要
```

## 3. GPU/CUDA 验证（仅 GPU 模式需要）

```powershell
npm run gpu:check
runtime\python_gpu\python.exe -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.version.cuda)"
```

`cuda_available` 必须为 True；`nvidia-smi` 必须正常。GPU Torch 自带 CUDA 运行库，
普通推理不需要安装 CUDA Toolkit（只有编译扩展才需要：https://developer.nvidia.com/cuda-downloads ）。
驱动从 https://www.nvidia.com/Download/index.aspx 下载。
**没有 N 卡或验证失败时直接使用 CPU 模式（第 5 步改用 `tts:cpu`），功能完整只是合成速度慢。**

## 4. 放置 GPT-SoVITS 底模和声音权重（必须手动）

克隆下来的 GPT-SoVITS 只有源码，**没有底模和权重，不放置就无法出声**。这些文件因版权原因不由本仓库分发。

1. **预训练底模**：按 GPT-SoVITS 官方文档（https://github.com/RVC-Boss/GPT-SoVITS ）
   下载其版本对应的预训练模型包（HuggingFace `lj1995/GPT-SoVITS` 或官方整合包），
   解压到 `runtime/gpt-sovits/GPT_SoVITS/pretrained_models/`，包含 HuBERT、BERT、
   GPT（s1）和 SoVITS（s2）底模。
2. **声音权重**：在应用的语音训练页训练出自己的 `.ckpt`（GPT）和 `.pth`（SoVITS），
   或导入已有权重；训练产物和参考音频保存在 userData，不会进 Git。
3. 在应用的 **语音设置页** 选择声音、配置参考音频；`chat5-compat/voice_engine/deploy_voice.py`
   负责把训练好的权重部署为可选用声音。

验证：应用内 `语音状态` 显示底模和至少一个可用声音；不要提交任何 `pth`/`ckpt`/`safetensors`。

## 5. 启动

保持两个窗口的顺序：

```powershell
# 窗口 A：先启动 TTS（保持运行）
npm run tts:cpu      # 或 npm run tts:gpu

# 窗口 B：启动应用
npm run start
```

TTS 健康检查（脚本使用端口 9882，并启动 `runtime/gpt-sovits/api.py`）：

```powershell
Invoke-RestMethod http://127.0.0.1:9882/status
Invoke-RestMethod http://127.0.0.1:9882/device
```

`npm run start` 会构建渲染层并启动 Electron，同时拉起 `chat5-compat/server.js`（127.0.0.1:3003）。

## 6. 调用链（排障时对照）

```
用户输入 → /api/chat → LLM Provider → 情绪/口型/动作匹配
       → POST http://127.0.0.1:9882/tts/json（chat5-compat/server.js）
       → tts_engine/selina_tts_api.py → GPT-SoVITS → WAV
       → 前端播放、口型、表情、语音动作
```

短句直接合成；长句按标点和可朗读字数分段，首段完成即可播放。
常用接口：`/api/runtime`、`/api/voice/status`、`/api/voice/speak`、`/api/voice/speak/stream`、`/api/voices`、`/api/chat`。

## 7. 模型包（PMX）

模型包放在 `models/<包名>/`，一个 `manifest.json` 加 PMX/贴图，格式和字段见
[models/README.md](models/README.md)。仓库自带 `models/赛琳娜Q` 最小示例。
注意：**示例模型仅限本地框架开发，其授权禁止二次配布**；对外分享前请替换为你有权分发的模型。

## 8. 故障排查

| 症状 | 处理 |
|---|---|
| `install-runtime.ps1` 报找不到 py | 安装 Python 3.11 并勾选 py launcher，或 `-PythonLauncher <路径>` |
| 报缺 git | 安装 git，或 `-SkipGptClone` 后手动放置 GPT-SoVITS |
| Python 找不到 / TTS 起不来 | 检查 `runtime/` 三个路径是否齐全（第 2 步验证命令） |
| CUDA 不可用 | 查驱动、`nvidia-smi`、重跑第 3 步验证；失败就用 CPU 模式 |
| 9882 端口占用 | 任务管理器结束旧 TTS/python 进程后重启 |
| 有文字没语音 | 先查 `/api/voice/status`，再确认第 4 步的底模、权重和参考音频已就位 |
| 模型动作缺失 | 对照 [models/README.md](models/README.md) 检查 manifest 的骨骼/Morph 映射 |

## 9. AI 验收清单

- [ ] `npm run check` 通过
- [ ] `runtime/python_cpu/python.exe` 可导入 torch；GPU 时 `torch.cuda.is_available()` 为 True
- [ ] `runtime/gpt-sovits/api.py` 存在，`http://127.0.0.1:9882/status` 返回成功
- [ ] `/api/runtime` 显示正确设备（cpu/gpu）
- [ ] 短句 `POST /api/voice/speak` 返回 WAV
- [ ] `npm run start` 打开界面，输入文字有回复和语音
- [ ] 仓库内没有密钥、userData、聊天记录、大模型权重（`npm run audit:iris` 可辅助检查）
