"""
voice_engine 模块
赛琳娜·希声 语音引擎 — 按角色隔离声音资产

判断逻辑：
- character/{id}/voice/config.json 存在 → 该角色有语音
- 不存在 → 该角色无语音（前端不显示语音按钮）

组件：
- tts_client.py: 调用 GPT-SoVITS 智能推理引擎 API
- voice_manager.py: 核心调度，检测角色语音状态
- deploy_voice.py: 把训练权重装进角色文件夹
"""

from .voice_manager import VoiceManager
from .tts_client import TTSClient

__all__ = ["VoiceManager", "TTSClient"]
