"""
部署脚本：把 GPT-SoVITS 训练出的权重 + 参考音部署到角色 voice 文件夹

用法:
    python deploy_voice.py --char 1 --name 赛琳娜

    # 指定 ChatX2 包内 GPT-SoVITS-lite 权重路径
    python deploy_voice.py --char 1 --name 赛琳娜 \
        --gpt "GPT-SoVITS-lite/GPT_weights_v3_core/selina_core-e10.ckpt" \
        --sovits "GPT-SoVITS-lite/SoVITS_weights_v3_core/selina_core_e3_l32.pth"

部署后结构:
    character/1/voice/
    ├── config.json          ← 声音配置（7种情感+角色特质）
    ├── gpt.ckpt             ← GPT权重（语气/韵律）
    ├── sovits.pth           ← SoVITS权重（音色）
    └── refs/                ← 情感参考音
        ├── comfort_0.wav
        ├── gentle_0.wav
        ├── sad_0.wav
        └── ...
"""
import argparse
import json
import os
import shutil
from pathlib import Path

PROJECT_ROOT = Path(os.environ.get("APP_ROOT") or Path(__file__).parent.parent).resolve()
CHARACTER_ROOT = Path(os.environ.get("CHARACTER_DIR") or PROJECT_ROOT / "character").resolve()
GPT_SOVITS_ROOT = Path(os.environ.get("GPT_SOVITS_ROOT") or PROJECT_ROOT / "GPT-SoVITS-lite").resolve()

# 默认权重路径（赛琳娜核心集模型）
DEFAULT_GPT = str(GPT_SOVITS_ROOT / "GPT_weights_v3_core" / "selina_core-e10.ckpt")
DEFAULT_SOVITS = str(GPT_SOVITS_ROOT / "SoVITS_weights_v3_core" / "selina_core_e3_l32.pth")

# 参考音频目录
REF_AUDIO_ROOT = str(GPT_SOVITS_ROOT / "ref_audio" / "selina")

# 7种情感配置（融入智能推理引擎的角色特质）
# 安全阈值：temperature ≥ 0.6, top_p ≥ 0.8（低于此值 GPT-SoVITS v3 会提前终止生成产生白噪音）
# 情感差异通过 ref_audio / pause_style / speed 体现，不通过低 temperature/top_p
# 与 selina_tts_engine.py 的 EMOTION_RULES 保持一致
EMOTION_CONFIG = {
    "comfort": {
        "desc": "安慰/坚定陪伴",
        "character_note": "不是软弱的安慰，是'我在'的力量感",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "medium",
        "pause_style": "comfort",
        "ref_candidates": ["gentle", "sad", "neutral"],
        "ref_dir": "gentle",
    },
    "sad_question": {
        "desc": "伤心后轻声问",
        "character_note": "像怕惊扰对方，小心翼翼地轻声问",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "medium",
        "pause_style": "heavy_whisper",
        "ref_candidates": ["sad", "gentle", "neutral"],
        "ref_dir": "sad",
    },
    "question": {
        "desc": "温柔关切地问",
        "character_note": "文学少女式的关切，轻柔而不追问",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "low",
        "pause_style": "gentle_ask",
        "ref_candidates": ["gentle", "neutral"],
        "ref_dir": "gentle",
    },
    "gentle": {
        "desc": "温柔/日常",
        "character_note": "文学少女的日常，克制而温暖",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "low",
        "pause_style": "medium",
        "ref_candidates": ["gentle", "neutral"],
        "ref_dir": "gentle",
    },
    "sad": {
        "desc": "悲伤/隐忍",
        "character_note": "刚强的少女不会大哭，是隐忍的、克制的悲伤",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "medium",
        "pause_style": "heavy",
        "ref_candidates": ["sad", "gentle", "neutral"],
        "ref_dir": "sad",
    },
    "strong": {
        "desc": "刚强/坚定",
        "character_note": "轻柔外表下的钢铁意志，语速慢但有力",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "medium",
        "pause_style": "firm",
        "ref_candidates": ["gentle", "neutral"],
        "ref_dir": "neutral",
    },
    "excited": {
        "desc": "激动/警觉",
        "character_note": "即使激动也是克制的，不会失态",
        "temperature": 0.65,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "medium",
        "pause_style": "light",
        "ref_candidates": ["excited", "surprised", "neutral"],
        "ref_dir": "excited",
    },
    "shy_happy": {
        "desc": "害羞/小高兴",
        "character_note": "嘴上抱怨心里甜，文学少女的别扭与欢喜",
        "temperature": 0.60,
        "top_p": 0.80,
        "speed": 0.96,
        "intensity": "low",
        "pause_style": "shy",
        "ref_candidates": ["happy", "gentle", "neutral"],
        "ref_dir": "gentle",
    },
}


def read_ref_texts(ref_dir: Path) -> dict:
    """读取参考音频对应的文本"""
    texts_file = ref_dir / "ref_texts.txt"
    texts = {}
    if texts_file.exists():
        for line in texts_file.read_text(encoding="utf-8").splitlines():
            if "|" in line:
                wav_name, text = line.split("|", 1)
                texts[wav_name.strip()] = text.strip()
    return texts


def deploy(char_id: str, gpt_path: str, sovits_path: str, name: str):
    """部署权重+参考音到角色voice文件夹"""
    voice_dir = CHARACTER_ROOT / str(char_id) / "voice"
    refs_dir = voice_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== 部署角色 {char_id} ({name}) 的声音资产 ===\n")

    # 1. 拷贝权重
    print("[1/3] 拷贝权重...")
    if Path(gpt_path).exists():
        shutil.copy(gpt_path, voice_dir / "gpt.ckpt")
        print(f"  GPT: {gpt_path}")
        print(f"  → {voice_dir / 'gpt.ckpt'}")
    else:
        print(f"  [警告] GPT权重不存在: {gpt_path}")
        return False

    if Path(sovits_path).exists():
        shutil.copy(sovits_path, voice_dir / "sovits.pth")
        print(f"  SoVITS: {sovits_path}")
        print(f"  → {voice_dir / 'sovits.pth'}")
    else:
        print(f"  [警告] SoVITS权重不存在: {sovits_path}")
        return False

    # 2. 拷贝参考音频
    print("\n[2/3] 拷贝参考音频...")
    emotions_config = {}
    for emotion, cfg in EMOTION_CONFIG.items():
        ref_source_dir = Path(REF_AUDIO_ROOT) / cfg["ref_dir"]
        if not ref_source_dir.exists():
            print(f"  [跳过] {emotion}: 参考音频目录不存在 {ref_source_dir}")
            continue

        ref_texts = read_ref_texts(ref_source_dir)
        ref_files = sorted([f for f in ref_source_dir.iterdir() if f.suffix == ".wav"])

        if not ref_files:
            print(f"  [跳过] {emotion}: 没有wav文件")
            continue

        # 用第一个参考音
        ref_file = ref_files[0]
        ref_text = ref_texts.get(ref_file.name, "")
        dest_name = f"{emotion}_0.wav"
        dest_path = refs_dir / dest_name
        shutil.copy(ref_file, dest_path)

        emotions_config[emotion] = {
            "desc": cfg["desc"],
            "character_note": cfg["character_note"],
            "temperature": cfg["temperature"],
            "top_p": cfg["top_p"],
            "speed": cfg["speed"],
            "intensity": cfg["intensity"],
            "pause_style": cfg["pause_style"],
            "ref_candidates": cfg["ref_candidates"],
            "ref_audio": f"refs/{dest_name}",
            "prompt_text": ref_text,
        }
        print(f"  {emotion}: {ref_file.name} → {dest_name} (文本: {ref_text[:20]}...)")

    # 3. 生成config.json（与 character/1/voice/config.json 格式一致）
    print("\n[3/3] 生成 config.json...")
    tts_port = str(os.environ.get("CHATX2_TTS_PORT") or os.environ.get("TTS_PORT") or "9882").strip()
    if not tts_port.isdigit():
        tts_port = "9882"
    config = {
        "character_id": char_id,
        "character_name": name,
        "gpt_weights": "gpt.ckpt",
        "sovits_weights": "sovits.pth",
        "tts_api": f"http://127.0.0.1:{tts_port}",
        "default_emotion": "auto",
        "lang": "zh",
        "character_core": "轻柔文学少女，内心刚强，喜欢着用户",
        "emotion_profiles": emotions_config,
        "globalSpeedOffset": 0.0,
        "globalTempOffset": 0.0,
        "defaultEmotion": "auto",
    }

    config_path = voice_dir / "config.json"
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"  → {config_path}")

    print(f"\n=== 部署完成！===\n")
    print(f"角色 {char_id} ({name}) 的声音资产已部署到:")
    print(f"  {voice_dir}")
    print(f"\n文件结构:")
    print(f"  voice/")
    print(f"  ├── config.json          ({len(emotions_config)}种情感)")
    print(f"  ├── gpt.ckpt             (GPT权重)")
    print(f"  ├── sovits.pth           (SoVITS权重)")
    print(f"  └── refs/                ({len(emotions_config)}个参考音)")
    print(f"\n现在启动TTS服务即可使用:")
    print(f"  python {GPT_SOVITS_ROOT / 'selina_tts_api.py'}")
    return True


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="部署训练权重到角色voice文件夹")
    p.add_argument("--char", required=True, help="角色ID，对应 character/<id>")
    p.add_argument("--gpt", default=DEFAULT_GPT, help="GPT .ckpt 路径")
    p.add_argument("--sovits", default=DEFAULT_SOVITS, help="SoVITS .pth 路径")
    p.add_argument("--name", default="赛琳娜", help="角色名")
    a = p.parse_args()
    deploy(a.char, a.gpt, a.sovits, a.name)
