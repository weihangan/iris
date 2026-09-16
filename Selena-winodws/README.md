# Selena-winodws — Windows 完整版

这是《战双·赛琳娜》桌面 AI 桌宠的 **Windows 完整可运行版**（克隆了赛琳娜语音、导入了其多种模型）。

## 为什么这里只有说明，没有安装包？

完整版约 **15.9GB**，超过 GitHub 单文件 100MB / 仓库容量限制，因此不存为仓库文件，而是发布在 **Releases（发行版）** 供下载。

## 下载完整版

> **Download →** [**iris Releases v1.1.0**](https://github.com/weihangan/iris/releases/tag/v1.1.0)

向下翻到 **Assets** 区域，下载全部 **9 个分卷**：

- `Selena-winodws.zip.001`
- `Selena-winodws.zip.002`
- `Selena-winodws.zip.003`
- `Selena-winodws.zip.004`
- `Selena-winodws.zip.005`
- `Selena-winodws.zip.006`
- `Selena-winodws.zip.007`
- `Selena-winodws.zip.008`
- `Selena-winodws.zip.009`

**解压方法：** 把 9 个分卷放到同一文件夹，用 **7-Zip** 等工具解压第一个 `Selena-winodws.zip.001`，即可得到完整运行包。

## v1.1.0 完整版含哪些能力

- **对话**：接入 DeepSeek / GLM / Kimi / Qwen / Claude 等大模型 API；支持识图聊天、自主开启话题、长期记忆。
- **语音**：GPT-SoVITS 角色语音克隆与输出；语音输入；真人化自然停顿与情感。
- **表演**：模型切换、情绪驱动动作/表情、语音动作联动。
- **性能优化**：LLM 边生成边合成（首句约 2-3 秒出声）、语音输入按需启动、语音模型 fp16 半精度加载（内存占用近乎减半）、关闭 g2pw（省约 600MB）、修复 IPv6 解析延迟。

> 详细改动见本目录同级的发布说明；完整技术细节见仓库根 `README.md` 的「v1.1.0 性能与内存优化」章节。
