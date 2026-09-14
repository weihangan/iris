"""
赛琳娜·希声 TTS 客户端
调用 GPT-SoVITS 智能推理引擎 API（selina_tts_api.py，ChatX2 默认端口9882）

特点：
- 融入7种情感智能引擎（comfort/sad_question/question/gentle/sad/strong/excited）
- 自动停顿排版（省略号=拖长，问号前省略号=轻声）
- 角色特质：轻柔文学少女 + 内心刚强 + 喜欢着用户
"""
import requests
import os
from pathlib import Path


class TTSClient:
    """调用赛琳娜智能TTS API的客户端"""

    def __init__(self, host="127.0.0.1", port=None):
        # ChatX2 runs its owned TTS instance on 9882.  Keep explicit ports
        # working for legacy callers, while making standalone clone tools
        # follow the packaged runtime instead of the old 9880 default.
        if port is None:
            port = os.environ.get("CHATX2_TTS_PORT") or os.environ.get("TTS_PORT") or "9882"
        self.base = f"http://{host}:{port}"

    def is_available(self) -> bool:
        """检查TTS服务是否可用"""
        try:
            r = requests.get(f"{self.base}/status", timeout=3)
            return r.status_code == 200
        except:
            return False

    def get_emotions(self) -> dict:
        """获取所有情感类型及参数"""
        try:
            r = requests.get(f"{self.base}/emotions", timeout=5)
            if r.status_code == 200:
                return r.json()
        except:
            pass
        return {}

    def synthesize(self, text: str, emotion: str = "auto") -> dict:
        """
        合成语音，返回JSON结果

        Args:
            text: 要合成的文本
            emotion: 情感类型，auto=自动检测

        Returns:
            {
                "audio_url": "/audio/xxx.wav",  # 音频URL（需拼接base）
                "emotion": "comfort",            # 实际情感
                "desc": "安慰/坚定陪伴",          # 情感描述
                "character_note": "...",         # 角色诠释
                "temperature": 0.45,
                "top_p": 0.65,
                "pause_style": "heavy",
                "duration": 3.5,
                "text": "..."
            }
            失败返回 None
        """
        try:
            r = requests.post(
                f"{self.base}/tts/json",
                json={"text": text, "emotion": emotion},
                timeout=120,
            )
            if r.status_code == 200:
                return r.json()
            else:
                print(f"[TTSClient] 合成失败: {r.status_code} {r.text}")
        except Exception as e:
            print(f"[TTSClient] 连接失败: {e}")
        return None

    def synthesize_wav(self, text: str, emotion: str = "auto") -> bytes:
        """
        合成语音，直接返回WAV字节流

        Args:
            text: 要合成的文本
            emotion: 情感类型，auto=自动检测

        Returns:
            WAV字节流，失败返回 None
        """
        try:
            r = requests.post(
                f"{self.base}/tts",
                json={"text": text, "emotion": emotion},
                timeout=120,
            )
            if r.status_code == 200:
                return r.content
            else:
                print(f"[TTSClient] 合成失败: {r.status_code}")
        except Exception as e:
            print(f"[TTSClient] 连接失败: {e}")
        return None

    def download_audio(self, audio_url: str, save_path: str) -> bool:
        """下载音频文件到本地"""
        try:
            r = requests.get(f"{self.base}{audio_url}", timeout=30)
            if r.status_code == 200:
                Path(save_path).parent.mkdir(parents=True, exist_ok=True)
                with open(save_path, "wb") as f:
                    f.write(r.content)
                return True
        except Exception as e:
            print(f"[TTSClient] 下载失败: {e}")
        return False


if __name__ == "__main__":
    # 测试
    client = TTSClient()

    print("检查服务状态...")
    if not client.is_available():
        print("TTS服务未启动！请先运行: python selina_tts_api.py")
        exit(1)

    print("服务可用！")
    print("\n情感类型:")
    emotions = client.get_emotions()
    for emo, info in emotions.items():
        print(f"  {emo}: {info['desc']} (t={info['temperature']}, p={info['top_p']})")

    print("\n测试合成:")
    result = client.synthesize("别怕，我在这里陪着你")
    if result:
        print(f"  情感: {result['desc']} ({result['emotion']})")
        print(f"  角色: {result['character_note']}")
        print(f"  时长: {result['duration']}s")
        print(f"  音频: {result['audio_url']}")
