"""
用达摩ASR重新对音频打标
GPT-SoVITS自带的ASR工具，中文识别比Whisper更准确
"""
import os
import sys

APP_ROOT = os.path.abspath(os.environ.get("APP_ROOT") or os.path.join(os.path.dirname(__file__), ".."))
APP_DATA_DIR = os.path.abspath(os.environ.get("APP_DATA_DIR") or APP_ROOT)
GPT_SOVITS_ROOT = os.path.abspath(os.environ.get("GPT_SOVITS_ROOT") or os.path.join(APP_ROOT, "GPT-SoVITS-lite"))
if GPT_SOVITS_ROOT not in os.environ.get("PATH", ""):
    os.environ["PATH"] = GPT_SOVITS_ROOT + ";" + os.environ.get("PATH", "")

os.chdir(GPT_SOVITS_ROOT)
sys.path.insert(0, GPT_SOVITS_ROOT)

WAV_DIR = os.path.abspath(os.environ.get("ASR_WAV_DIR") or os.path.join(APP_DATA_DIR, "training", "raw", "selina"))
OUTPUT_DIR = os.path.join(APP_DATA_DIR, "training", "asr_opt")
os.makedirs(OUTPUT_DIR, exist_ok=True)

python_exec = sys.executable

# 使用达摩ASR
asr_script = os.path.join(GPT_SOVITS_ROOT, "tools", "asr", "fasterwhisper_asr.py")
if not os.path.exists(asr_script):
    asr_script = os.path.join(GPT_SOVITS_ROOT, "tools", "asr", "funasr_asr.py")

# 查找可用的ASR脚本
asr_dir = os.path.join(GPT_SOVITS_ROOT, "tools", "asr")
print(f"ASR目录: {asr_dir}")
if os.path.exists(asr_dir):
    for f in os.listdir(asr_dir):
        if f.endswith(".py"):
            print(f"  {f}")

# 直接用funasr做ASR
print("\n使用FunASR（达摩ASR）重新打标...")

import json
import torch
import numpy as np
import soundfile as sf
from funasr import AutoModel

# 加载达摩ASR模型
print("加载达摩ASR模型...")
model = AutoModel(
    model="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    punc_model="iic/punc_ct-transformer_cn-en-common-vocab471067-large",
    # 使用本地缓存
    disable_update=True,
)

# 处理所有WAV文件
wav_files = sorted([f for f in os.listdir(WAV_DIR) if f.endswith(".wav")])
print(f"共 {len(wav_files)} 个WAV文件")

results = []
for i, wav_name in enumerate(wav_files):
    wav_path = os.path.join(WAV_DIR, wav_name)
    if i % 50 == 0:
        print(f"  处理 {i+1}/{len(wav_files)}: {wav_name}")

    try:
        result = model.generate(input=wav_path, batch_size_s=300)
        if result and len(result) > 0:
            text = result[0]["text"] if isinstance(result[0], dict) else str(result[0])
            # 清理文本
            text = text.strip()
            if text:
                results.append(f"{wav_path}|selina|zh|{text}")
            else:
                print(f"  空文本: {wav_name}")
        else:
            print(f"  无结果: {wav_name}")
    except Exception as e:
        print(f"  错误 {wav_name}: {e}")

# 保存结果
output_list = os.path.join(WAV_DIR, "selina_damo.list")
with open(output_list, "w", encoding="utf-8") as f:
    f.write("\n".join(results) + "\n")

print(f"\n完成！输出: {output_list}")
print(f"成功标注: {len(results)} 条")

# 对比旧标注
old_list = os.path.join(WAV_DIR, "selina.list")
if os.path.exists(old_list):
    with open(old_list, "r", encoding="utf-8") as f:
        old_lines = [l.strip() for l in f if l.strip()]
    print(f"旧标注: {len(old_lines)} 条")
    print(f"新标注: {len(results)} 条")

    # 显示几个对比
    print("\n对比示例（旧 → 新）:")
    old_dict = {}
    for line in old_lines:
        parts = line.split("|")
        if len(parts) >= 4:
            name = os.path.basename(parts[0])
            old_dict[name] = parts[3]

    new_dict = {}
    for line in results:
        parts = line.split("|")
        if len(parts) >= 4:
            name = os.path.basename(parts[0])
            new_dict[name] = parts[3]

    count = 0
    for name in sorted(old_dict.keys()):
        if name in new_dict and old_dict[name] != new_dict[name]:
            print(f"  {name}:")
            print(f"    旧: {old_dict[name]}")
            print(f"    新: {new_dict[name]}")
            count += 1
            if count >= 10:
                break
