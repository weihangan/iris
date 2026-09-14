"""
赛琳娜·希声 声音管理器
核心调度：检测哪些角色有声音，按角色隔离声音资产

判断逻辑：
- character/{id}/voice/config.json 存在 → 该角色有语音
- 不存在 → 该角色无语音（前端不显示语音按钮）

config.json 格式：
{
  "character_id": "1",
  "character_name": "赛琳娜",
  "tts_api": "http://127.0.0.1:9882",  // TTS API地址
  "default_emotion": "auto",            // 默认情感，auto=自动检测
  "emotions": {                          // 该角色支持的情感（从TTS引擎获取）
    "comfort": {"desc": "安慰/坚定陪伴", ...},
    "sad_question": {"desc": "伤心后轻声问", ...},
    ...
  }
}
"""
import json
import time
import os
from pathlib import Path
from .tts_client import TTSClient

PROJECT_ROOT = Path(os.environ.get("APP_ROOT") or Path(__file__).parent.parent).resolve()
CHARACTER_ROOT = Path(os.environ.get("CHARACTER_DIR") or PROJECT_ROOT / "character").resolve()
OUTPUT_DIR = Path(os.environ.get("TTS_OUTPUT_DIR") or PROJECT_ROOT / "voice_engine" / "output").resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class VoiceManager:
    """声音管理器：检测角色是否有语音，调度TTS合成"""

    def __init__(self, tts_host="127.0.0.1", tts_port=None):
        if tts_port is None:
            tts_port = os.environ.get("CHATX2_TTS_PORT") or os.environ.get("TTS_PORT") or "9882"
        self.client = TTSClient(tts_host, tts_port)
        self._tts_available = None  # 缓存TTS服务状态

    def voice_dir(self, char_id: str) -> Path:
        """角色的voice目录路径"""
        return CHARACTER_ROOT / str(char_id) / "voice"

    def has_voice(self, char_id: str) -> bool:
        """
        ★决定前端是否显示语音按钮
        character/{id}/voice/config.json 存在 → 有语音
        """
        return (self.voice_dir(char_id) / "config.json").exists()

    def is_tts_available(self) -> bool:
        """TTS服务是否可用（缓存结果，避免频繁请求）"""
        if self._tts_available is None:
            self._tts_available = self.client.is_available()
        return self._tts_available

    def _load_config(self, char_id: str) -> dict:
        """加载角色的voice配置"""
        cfg_path = self.voice_dir(char_id) / "config.json"
        if not cfg_path.exists():
            return {}
        try:
            return json.loads(cfg_path.read_text(encoding="utf-8"))
        except:
            return {}

    def list_emotions(self, char_id: str) -> list:
        """
        列出该角色支持的情感
        优先用config.json里的，没有就从TTS引擎获取
        """
        if not self.has_voice(char_id):
            return []

        cfg = self._load_config(char_id)
        emotions = cfg.get("emotions", {})

        if emotions:
            return [{"id": k, "desc": v.get("desc", k)} for k, v in emotions.items()]

        # 从TTS引擎获取
        if self.is_tts_available():
            all_emotions = self.client.get_emotions()
            return [{"id": k, "desc": v.get("desc", k)} for k, v in all_emotions.items()]

        return []

    def speak(self, char_id: str, text: str, emotion: str = None) -> dict:
        """
        给角色合成语音

        Args:
            char_id: 角色ID
            text: 要合成的文本
            emotion: 情感类型，None=用角色默认，"auto"=自动检测

        Returns:
            {
                "success": True,
                "audio_url": "/audio/xxx.wav",  # TTS服务上的音频URL
                "audio_path": str(PROJECT_ROOT / "audio" / "xxx.wav"), # 本地保存路径示例
                "emotion": "comfort",
                "desc": "安慰/坚定陪伴",
                "character_note": "...",
                "duration": 3.5,
                "text": "..."
            }
            没有声音资产返回 {"success": False, "reason": "no_voice"}
            TTS服务不可用返回 {"success": False, "reason": "tts_unavailable"}
        """
        # 1. 检查角色是否有语音
        if not self.has_voice(char_id):
            return {"success": False, "reason": "no_voice"}

        # 2. 检查TTS服务
        if not self.is_tts_available():
            return {"success": False, "reason": "tts_unavailable"}

        # 3. 确定情感
        cfg = self._load_config(char_id)
        if emotion is None:
            emotion = cfg.get("default_emotion", "auto")

        # 4. 调用TTS合成
        result = self.client.synthesize(text, emotion=emotion)
        if not result:
            return {"success": False, "reason": "synthesis_failed"}

        # 5. 下载音频到本地output目录（可选，前端也可以直接用audio_url）
        char_name = cfg.get("character_name", f"char{char_id}")
        filename = f"char{char_id}_{result['emotion']}_{int(time.time()*1000)}.wav"
        local_path = OUTPUT_DIR / filename

        if self.client.download_audio(result["audio_url"], str(local_path)):
            result["audio_path"] = str(local_path)
            result["local_filename"] = filename

        result["success"] = True
        result["character_id"] = char_id
        result["character_name"] = char_name
        return result

    def get_status(self, char_id: str) -> dict:
        """获取角色的语音状态"""
        has_voice = self.has_voice(char_id)
        tts_available = self.is_tts_available()

        status = {
            "has_voice": has_voice,
            "tts_available": tts_available,
            "can_speak": has_voice and tts_available,
        }

        if has_voice:
            cfg = self._load_config(char_id)
            status["character_name"] = cfg.get("character_name", "")
            status["default_emotion"] = cfg.get("default_emotion", "auto")
            status["emotions"] = self.list_emotions(char_id)

        return status


if __name__ == "__main__":
    # 测试
    vm = VoiceManager()

    print("=== 声音管理器测试 ===\n")

    # 检查各角色语音状态
    for char_id in ["1", "2", "3"]:
        status = vm.get_status(char_id)
        print(f"角色 {char_id}:")
        print(f"  有语音: {status['has_voice']}")
        print(f"  TTS可用: {status['tts_available']}")
        print(f"  可说话: {status['can_speak']}")
        if status['has_voice']:
            print(f"  角色名: {status.get('character_name', '')}")
            print(f"  情感数: {len(status.get('emotions', []))}")
        print()

    # 测试合成
    if vm.get_status("1")["can_speak"]:
        print("测试合成: '别怕，我在这里陪着你'")
        result = vm.speak("1", "别怕，我在这里陪着你")
        if result["success"]:
            print(f"  情感: {result['desc']} ({result['emotion']})")
            print(f"  时长: {result['duration']}s")
            print(f"  本地文件: {result.get('audio_path', '未下载')}")
        else:
            print(f"  失败: {result.get('reason')}")
