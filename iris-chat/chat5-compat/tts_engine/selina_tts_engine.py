"""
赛琳娜·希声 智能推理引擎

角色核心：轻柔文学少女，内心刚强，喜欢着用户
- 默认语气：温柔、克制、有呼吸感的停顿
- 安慰时：坚定陪伴，不是软弱，而是"我在"的力量感
- 伤心/难过后疑问句：轻声，像怕惊扰对方
- 问句：温柔关切，不是质问
- 刚强时刻：语气沉稳，语速放慢但有力

自动处理：
1. 停顿排版（省略号=拖长，逗号=短停，问句前加省略号=轻声）
2. 固定说话人参考音频（情绪只改变韵律）
3. 在保真范围内调整语速、音调、力度与停顿
4. 情感强度（intensity）自动判断 + 角色一致性修正
5. 长句自动分段
"""
import os
import sys
import re
import math
import numpy as np

from voice_identity import (
    POLICY_VERSION as VOICE_IDENTITY_POLICY_VERSION,
    apply_identity_seed,
    get_emotion_prosody,
    resolve_identity_reference,
    sanitize_runtime_params,
)

# GPU 显存管理优化：设置 PyTorch CUDA 内存分配策略
# - expandable_segments:True 允许 PyTorch 动态释放显存段，避免碎片累积
# - max_split_size_mb:128 限制大块分配，减少 OOM 风险
if "PYTORCH_CUDA_ALLOC_CONF" not in os.environ:
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True,max_split_size_mb:128"

# GPU 加速配置：仅在 CUDA 可用时启用 cuDNN benchmark，避免 CPU 模式下的额外开销
import torch
if torch.cuda.is_available():
    # 启用 cuDNN benchmark 自动选择最优卷积算法
    torch.backends.cudnn.benchmark = True
    torch.backends.cudnn.deterministic = False
# 限制 CPU 线程数，避免与 GPU 推理争抢资源（CPU 模式下也限制以保持一致性）
torch.set_num_threads(4)

def _release_cuda_cache_under_pressure(threshold=0.86):
    """Release allocator blocks only near VRAM pressure; keep warm caches otherwise."""
    if not torch.cuda.is_available():
        return False
    try:
        device = torch.cuda.current_device()
        total = torch.cuda.get_device_properties(device).total_memory
        reserved = torch.cuda.memory_reserved(device)
        if total > 0 and reserved / total >= threshold:
            torch.cuda.empty_cache()
            return True
    except Exception:
        return False
    return False

OWNER_TRACE = "wha1999/core/tts"
# provenance: wha9917/private-optimizations — identity/voice tuning marker; inert.

# 应用与用户数据目录：均由 Electron 注入；独立运行时回退到当前发布包。
APP_ROOT = os.path.abspath(
    os.environ.get("APP_ROOT") or os.path.join(os.path.dirname(__file__), "..")
)
APP_DATA_ROOT = os.path.abspath(os.environ.get("APP_DATA_DIR") or APP_ROOT)

# GPT-SoVITS 路径配置：只接受环境变量或当前发布包内资源，不搜索开发机目录。
def _resolve_gpt_sovits_root():
    root = os.environ.get("GPT_SOVITS_ROOT", "")
    if root and os.path.isdir(os.path.join(root, "GPT_SoVITS")):
        return os.path.abspath(root)
    bundled = os.path.join(APP_ROOT, "GPT-SoVITS-lite")
    if os.path.isdir(os.path.join(bundled, "GPT_SoVITS")):
        return bundled
    raise RuntimeError("未找到包内 GPT-SoVITS-lite，请检查发布资源是否完整")

GPT_SOVITS_ROOT = _resolve_gpt_sovits_root()
_RUNTIME_CACHE_DIR = os.path.join(APP_DATA_ROOT, "cache")
os.makedirs(_RUNTIME_CACHE_DIR, exist_ok=True)
# inference_webui 会读取并回写权重状态。必须放入 userData，避免写包内目录，
# 也避免把某台开发机的绝对路径带到另一台电脑。
os.environ.setdefault(
    "GPT_SOVITS_WEIGHT_FILE",
    os.path.join(_RUNTIME_CACHE_DIR, "gpt_sovits_weight.json"),
)
os.environ.setdefault(
    "gpt_path",
    os.path.join(
        GPT_SOVITS_ROOT,
        "GPT_SoVITS", "pretrained_models",
        "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
    ),
)
os.environ.setdefault(
    "sovits_path",
    os.path.join(
        GPT_SOVITS_ROOT,
        "GPT_SoVITS", "pretrained_models", "s2G488k.pth",
    ),
)
if GPT_SOVITS_ROOT not in os.environ.get("PATH", ""):
    os.environ["PATH"] = GPT_SOVITS_ROOT + ";" + os.environ.get("PATH", "")

os.chdir(GPT_SOVITS_ROOT)
sys.path.insert(0, GPT_SOVITS_ROOT)
# inference_webui.py 内部 `from text.LangSegmenter import ...` 需要 GPT_SoVITS/ 在 sys.path
sys.path.insert(0, os.path.join(GPT_SOVITS_ROOT, "GPT_SoVITS"))
# BigVGAN/ 下的 bigvgan.py 用裸导入（v3 路径用，v1 不需要但加入 sys.path 无害）
sys.path.insert(0, os.path.join(GPT_SOVITS_ROOT, "GPT_SoVITS", "BigVGAN"))
# v1 zero-shot 模式：用 v1 预训练模型 + 参考音频决定音色
# v3 LoRA 模式音色由训练数据决定，与 v1 zero-shot 完全不同，会导致音色不对
os.environ["version"] = "v1"

# 延迟导入 inference_webui（避免模块加载时卡住）
_change_gpt_weights = None
_change_sovits_weights = None
_get_tts_wav = None
_i18n = None


def _configure_ar_early_stop(text):
    """Bound runaway AR decoding for the short units used by ChatX2.

    GPT-SoVITS exposes ``max_sec`` as a module global and derives the semantic
    early-stop token count from it.  The model config is tuned for long generic
    paragraphs (up to roughly 30s), while ChatX2 deliberately feeds units of at
    most 22 Chinese characters.  A bounded 8–12s window leaves ample room for
    natural pauses but prevents a rare EOS failure from spending 30s on one
    short sentence.  The original model cap is never increased.
    """
    try:
        import GPT_SoVITS.inference_webui as _iw
        original = getattr(_iw, "_chatx2_original_max_sec", getattr(_iw, "max_sec", 30))
        try:
            original = max(1, int(float(original)))
        except (TypeError, ValueError):
            original = 30
        if not hasattr(_iw, "_chatx2_original_max_sec"):
            _iw._chatx2_original_max_sec = original

        try:
            configured_cap = int(float(os.environ.get("CHATX2_AR_MAX_SEC", "12")))
        except (TypeError, ValueError):
            configured_cap = 12
        configured_cap = max(8, min(30, configured_cap))
        chinese_chars = len([char for char in str(text or "") if "\u4e00" <= char <= "\u9fff"])
        recommended = max(8, min(configured_cap, int(math.ceil(chinese_chars / 2.5 + 4))))
        _iw.max_sec = min(original, recommended)
    except Exception:
        # The fallback engine/API remains usable if an alternate inference
        # backend does not expose max_sec.
        return

def _ensure_inference_webui():
    global _change_gpt_weights, _change_sovits_weights, _get_tts_wav, _i18n
    if _change_gpt_weights is None:
        print("[engine] 延迟导入 GPT_SoVITS.inference_webui ...", flush=True)
        from GPT_SoVITS.inference_webui import (
            change_gpt_weights, change_sovits_weights,
            get_tts_wav, i18n
        )
        _change_gpt_weights = change_gpt_weights
        _change_sovits_weights = change_sovits_weights
        _get_tts_wav = get_tts_wav
        _i18n = i18n
        print("[engine] inference_webui 导入完成", flush=True)
        # v1 zero-shot 模式下 BigVGAN 保持原始 fp16（v1 本就是 fp16 训练的，转 fp32 会改变音色细节）
        # fp32 转换是 v3 专用补丁（修复 Snake 激活静音），v1 不需要
        # 性能探针默认关闭，避免正式版每次推理额外包装与写日志；排障时显式开启。
        if os.environ.get("TTS_ENABLE_PROFILING", "0") == "1":
            try:
                from profiling_probe import install_probe
                install_probe()
            except Exception as e:
                print(f"[engine] profiling probe 安装失败: {e}", flush=True)


# ============================================================
# 生成日志
# ============================================================
TTS_LOG_DIR = os.path.abspath(
    os.environ.get("TTS_LOG_DIR") or os.path.join(APP_DATA_ROOT, "logs")
)
os.makedirs(TTS_LOG_DIR, exist_ok=True)
TTS_LOG_FILE = os.path.join(TTS_LOG_DIR, "tts_generation.log")

def _log_generation(**kwargs):
    """记录每次语音生成的完整信息"""
    import json
    import time
    kwargs["timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with open(TTS_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(kwargs, ensure_ascii=False) + "\n")
    except:
        pass


# ============================================================
# 文本预处理 — 只提取角色实际说的话
# 括号内容（动作描写/背景信息）不配音
# ============================================================
def extract_spoken_text(text):
    """
    三步清洗：
    1. 去动作描写（括号/星号内容）
    2. 清理多余标点（开头省略号、连续省略号、多个问号/感叹号）
    3. 保留角色口癖（嗯/啊/呀/呢/吗/指挥/您 不被清理）
    4. 过滤英文和emoji（GPT-SoVITS 训练的是中文，遇到英文/emoji会合成失败）
    """
    # 第一步：去动作描写
    # 大中小括号内容都不发音：中文圆括号（）、英文圆括号()、中文方括号【】、英文方括号[]、大括号{}、星号**
    # 注意：[语气:xx] 和 [/语气] 是 TTS 语气标记，必须保护（用 negative lookahead 排除）
    text = re.sub(r'（[^）]*）', '', text)
    text = re.sub(r'\([^)]*\)', '', text)
    text = re.sub(r'【[^】]*】', '', text)
    # 英文方括号：剥离非语气标记的 [...]（如 [2026-07-01 02:53:12] 日期、[动作描写]）
    text = re.sub(r'\[(?!语气:|/语气\])[^]]*\]', '', text)
    # 大括号 {...}（动作描写/系统标记）
    text = re.sub(r'\{[^}]*\}', '', text)
    text = re.sub(r'\*[^*]*\*', '', text)

    # 1.4 去掉引号字符（引号残留产生孤立段→GPT-SoVITS 杂音）
    # 只去引号符号本身，保留引号内的文字
    text = text.replace('"', '').replace('"', '').replace('"', '')
    text = text.replace('「', '').replace('」', '')
    text = text.replace('『', '').replace('』', '')
    # 半角~替换为全角～（GPT-SoVITS 对半角~处理不佳→杂音）
    text = text.replace('~', '～')

    # 1.5 移除emoji（各种emoji范围）
    text = re.sub(
        r'[\U0001F300-\U0001F9FF\U0001FA00-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F02F\U0001F0A0-\U0001F0FF\U0001F100-\U0001F1FF\U0001F200-\U0001F2FF]',
        '', text
    )
    # 1.6 移除英文单词（连续2个及以上英文字母，GPT-SoVITS 无法合成英文）
    if re.search(r'[a-zA-Z]{2,}', text):
        text = re.sub(r'\s*[a-zA-Z]+\.?\s*', '，', text)
        while '，，' in text:
            text = text.replace('，，', '，')

    # 第二步：清理多余标点
    # 去除开头的省略号
    text = text.lstrip("……")
    # 合并连续省略号
    while "…………" in text:
        text = text.replace("…………", "……")
    # 多个问号/感叹号合并为一个
    text = re.sub(r'？{2,}', '？', text)
    text = re.sub(r'！{2,}', '！', text)
    # 去除多余空行和空格
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    text = ''.join(lines)
    text = text.strip()

    # 第三步：角色口癖已自然保留（嗯/啊/呀/呢/吗/指挥/您 不在删除规则中）
    return text


# ============================================================
# 情感分类规则 — 基于赛琳娜角色核心
# 轻柔文学少女 + 内心刚强 + 喜欢着用户
# ============================================================
EMOTION_RULES = {
    "comfort": {
        "keywords": ["别怕", "陪", "没事", "不要紧", "放心", "安心", "别担心", "会好的",
                     "我在", "不会离开", "保护", "安全", "别哭", "我在这里",
                     "不会的", "有我在", "交给我", "慢慢来", "你已经很好了",
                     "我会陪你", "别一个人撑着"],
        "pause_style": "comfort",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.95,
        "pause_scale": 1.04,
        "intensity": "medium",
        "desc": "安慰/坚定陪伴",
        "character_note": "不是软弱的安慰，是'我在'的力量感",
        "ref_candidates": ["gentle", "sad", "neutral"],
    },
    "sad_question": {
        "keywords": [],
        "pause_style": "heavy_whisper",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.9,
        "pause_scale": 1.10,
        "intensity": "medium",
        "desc": "伤心后轻声问",
        "character_note": "像怕惊扰对方，小心翼翼地轻声问",
        "ref_candidates": ["sad", "gentle", "neutral"],
    },
    "question": {
        "keywords": [],
        "pause_style": "gentle_ask",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.95,
        "pause_scale": 1.02,
        "intensity": "low",
        "desc": "温柔关切地问",
        "character_note": "文学少女式的关切，轻柔而不追问",
        "ref_candidates": ["gentle", "neutral"],
    },
    "gentle": {
        "keywords": ["嗯", "好", "知道", "明白", "理解", "辛苦", "谢谢", "温柔",
                     "喜欢", "想", "念", "等", "一直"],
        "pause_style": "medium",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 1.0,
        "pause_scale": 1.0,
        "intensity": "low",
        "desc": "温柔/日常",
        "character_note": "文学少女的日常，克制而温暖",
        "ref_candidates": ["gentle", "neutral"],
    },
    "sad": {
        "keywords": ["再见", "离开", "失去", "遗憾", "对不起", "抱歉", "想念", "回忆",
                     "难过", "伤心", "泪", "痛", "孤独", "寂寞", "忘记", "消失",
                     "梦醒", "回不去", "等不到"],
        "pause_style": "heavy",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.9,
        "pause_scale": 1.10,
        "intensity": "medium",
        "desc": "悲伤/隐忍",
        "character_note": "刚强的少女不会大哭，是隐忍的、克制的悲伤",
        "ref_candidates": ["sad", "gentle", "neutral"],
    },
    "strong": {
        "keywords": ["一定", "绝对", "必须", "不会退", "战斗", "守护", "誓",
                     "约定", "承诺", "信", "力量", "坚强", "不会放弃",
                     "我会做到", "请相信我", "我还在", "不能退后"],
        "pause_style": "firm",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.95,
        "pause_scale": 0.96,
        "intensity": "medium",
        "desc": "刚强/坚定",
        "character_note": "轻柔外表下的钢铁意志，语速慢但有力",
        "ref_candidates": ["gentle", "neutral"],
    },
    "excited": {
        "keywords": ["太棒", "厉害", "冲", "敌人", "危险", "快跑",
                     "小心", "成功了", "终于", "来不及了"],
        "pause_style": "light",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 1.05,
        "pause_scale": 0.88,
        "intensity": "medium",
        "desc": "激动/警觉",
        "character_note": "即使激动也是克制的，不会失态",
        "ref_candidates": ["excited", "surprised", "neutral"],
    },
    "shy_happy": {
        "keywords": ["当真", "害羞", "高兴", "开心", "期待",
                     "心跳", "脸红", "不好意思", "哪有", "才不是", "讨厌啦",
                     "哼", "真是的", "拿你没办法", "您要对我负责",
                     "害羞地", "小声地", "别扭地", "喜欢", "笨蛋",
                     "别这样看我"],
        "pause_style": "shy",
        "temperature": 0.6,
        "top_p": 0.72,
        "speed": 0.97,
        "pause_scale": 1.06,
        "intensity": "low",
        "desc": "害羞/小高兴",
        "character_note": "嘴上抱怨心里甜，文学少女的别扭与欢喜",
        "ref_candidates": ["happy", "gentle", "neutral"],
    },
}

# ============================================================
# 段内局部语气预设 — [语气:类型]文字[/语气] 标记的参数覆盖
# 安全约束：temperature ≥ 0.6, top_p ≥ 0.8（低于此值 GPT-SoVITS v3 会提前终止）
# ============================================================
TONE_PRESETS = {
    "温柔": {"emotion": "comfort",   "temperature": 0.62, "top_p": 0.80, "speed": 0.96},
    "坚定": {"emotion": "strong",    "temperature": 0.62, "top_p": 0.80, "speed": 0.97},
    "兴奋": {"emotion": "excited",   "temperature": 0.62, "top_p": 0.80, "speed": 1.06},
    "开心": {"emotion": "shy_happy", "temperature": 0.65, "top_p": 0.80, "speed": 1.05},
    "害羞": {"emotion": "shy_happy", "temperature": 0.62, "top_p": 0.80, "speed": 0.96},
    "疑惑": {"emotion": "question",  "temperature": 0.62, "top_p": 0.80, "speed": 0.97},
    "俏皮": {"emotion": "excited",   "temperature": 0.62, "top_p": 0.80, "speed": 1.04},
    "悲伤": {"emotion": "sad",       "temperature": 0.62, "top_p": 0.80, "speed": 0.94},
    "生气": {"emotion": "strong",    "temperature": 0.62, "top_p": 0.80, "speed": 0.97},
}

# 局部语气标记正则：[语气:类型]文字[/语气]
_TONE_TAG_RE = re.compile(r'\[语气:([^\]]+)\](.*?)\[/语气\]', re.DOTALL)

# 这些连接词只是语义转折，不应触发完整的情绪强度。短的局部语气段也
# 需要收敛，否则独立合成后再拼接会像突然换了一个说话人。
_TRANSITION_LEAD_RE = re.compile(
    r'^\s*(?:但是|不过|只是|然而|可是|却|其实|原来|所以|因此|反而|'
    r'话虽如此|即便如此)'
)


def _tone_blend_factor(text):
    """返回局部语气相对主情绪的混合比例（1=完整，越小越克制）。"""
    value = str(text or '').strip()
    if _TRANSITION_LEAD_RE.match(value):
        return 0.52
    if len(value) <= 8:
        return 0.68
    return 1.0


def _parse_tone_segments(text, default_emotion):
    """把含 [语气:xx]文字[/语气] 标记的文本切成 (text, emotion, is_tone) 三元组列表。

    - 非 tone 段：emotion=default_emotion, is_tone=False
    - tone 段：emotion=TONE_PRESETS[type]["emotion"], is_tone=True
    - 短文本(<3字)的 tone 段合并到前一段（避免 GPT-SoVITS 短文本合成不稳定）
    - 无标记时返回 [(text, default_emotion, False)]
    """
    if not _TONE_TAG_RE.search(text):
        return [(text, default_emotion, False)]

    segments = []
    last_idx = 0
    for m in _TONE_TAG_RE.finditer(text):
        # 标记前的普通文本
        if m.start() > last_idx:
            plain = text[last_idx:m.start()]
            if plain.strip():
                segments.append((plain, default_emotion, False))
        # 标记包裹的文本
        tone_type = m.group(1).strip()
        tone_text = m.group(2).strip()
        preset = TONE_PRESETS.get(tone_type)
        if preset and tone_text:
            segments.append((tone_text, preset["emotion"], True, tone_type))
        elif tone_text:
            # 未知类型，保留文本但不当 tone 段
            segments.append((tone_text, default_emotion, False))
        last_idx = m.end()
    # 末尾普通文本
    if last_idx < len(text):
        plain = text[last_idx:]
        if plain.strip():
            segments.append((plain, default_emotion, False))

    # 短 tone 段(<3字)合并到前一段非 tone
    merged = []
    for seg in segments:
        if len(seg) >= 4 and seg[2] is True and len(seg[0]) < 3:
            if merged:
                prev = merged[-1]
                merged[-1] = (prev[0] + seg[0], prev[1], prev[2])
            else:
                merged.append((seg[0], seg[1], False))
        else:
            merged.append(seg)
    return merged if merged else [(text, default_emotion, False)]


def _apply_fade(audio, sr, fade_ms=5):
    """对音频首尾加 fade_ms 毫秒线性淡入淡出，消除直流偏移突变导致的点击声。"""
    fade_samples = int(sr * fade_ms / 1000)
    if fade_samples <= 0 or len(audio) < fade_samples * 2:
        return audio
    fade_in = np.linspace(0, 1, fade_samples, dtype=audio.dtype)
    fade_out = np.linspace(1, 0, fade_samples, dtype=audio.dtype)
    audio = audio.copy()
    audio[:fade_samples] *= fade_in
    audio[-fade_samples:] *= fade_out
    return audio


def _append_audio_piece(buf_list, piece, sr, fade_ms=5, silence_s=0.0, crossfade_ms=50):
    """把一段音频加到缓冲列表，可选加首尾淡入淡出 + 段间静音。
    crossfade_ms: 与上一段末尾做交叉淡入淡出（掩盖拼接处音高跳变），0=禁用。
    """
    if piece is None or len(piece) == 0:
        return
    piece = _apply_fade(piece, sr, fade_ms)

    # ★ 交叉淡入淡出：与上一段末尾重叠 crossfade_ms，掩盖 AR_T2S 多段独立采样导致的音高跳变
    if crossfade_ms > 0 and buf_list:
        # 找到最后一段非静音的音频（跳过段间静音 zeros）
        last_audio_idx = None
        for i in range(len(buf_list) - 1, -1, -1):
            if len(buf_list[i]) > 0 and not np.all(buf_list[i] == 0):
                last_audio_idx = i
                break
        if last_audio_idx is not None:
            last_audio = buf_list[last_audio_idx]
            cf_samples = int(sr * crossfade_ms / 1000)
            cf_samples = min(cf_samples, len(last_audio) // 2, len(piece) // 2)
            if cf_samples > 10:
                # 在上一段末尾 cf_samples 范围内做淡出，新段开头 cf_samples 做淡入，逐点相加
                fade_out = np.linspace(1, 0, cf_samples, dtype=np.float32)
                fade_in = np.linspace(0, 1, cf_samples, dtype=np.float32)
                # 裁掉新段开头的 _apply_fade 淡入（避免双重淡入），改成 crossfade
                piece = piece.copy()
                # 上一段末尾 crossfade 区间
                tail = last_audio[-cf_samples:].copy()
                # 新段开头 crossfade 区间
                head = piece[:cf_samples].copy()
                # 重叠相加（音量归一化避免叠加后变大）
                merged = tail * fade_out + head * fade_in
                buf_list[last_audio_idx] = last_audio[:-cf_samples]
                piece[cf_samples:] = piece[cf_samples:]
                piece = np.concatenate([merged, piece[cf_samples:]])

    buf_list.append(piece)
    if silence_s > 0:
        buf_list.append(np.zeros(int(sr * silence_s), dtype=np.float32))


def _trim_head_noise(audio_data, sr, threshold=0.02, max_trim_s=0.15):
    """裁掉开头低幅值噪声（如 h 辅音摩擦音），保留有效语音起始。
    用更激进的阈值扫描开头，找到第一个 RMS>threshold 的帧，裁掉之前的样本。
    max_trim_s: 最多裁剪多少秒（避免裁掉太多）
    """
    if len(audio_data) == 0 or sr <= 0:
        return audio_data
    frame_len = max(1, int(sr * 0.005))  # 5ms 帧
    max_trim_samples = int(sr * max_trim_s)
    for i in range(0, min(len(audio_data) - frame_len, max_trim_samples), frame_len):
        frame = audio_data[i:i+frame_len]
        rms = float(np.sqrt(np.mean(frame**2)))
        if rms >= threshold:
            # 找到有效语音起始，裁掉之前的噪声
            if i > 0:
                return audio_data[i:].copy()
            return audio_data
    return audio_data  # 没找到有效语音，不裁剪


# 语气词结尾处理：让特定结尾的字轻一点/拖长一点，语气词重一点
# 结尾字 → fade_out 时长（秒），0 表示不处理
ENDING_LIGHT_FADE = {
    "？": 0.35,   # 问号结尾：最后一个字拖长轻一点
    "?": 0.35,
    "了": 0.25,   # 语气词结尾：轻一点
    "吗": 0.25,
    "嘛": 0.25,
    "呢": 0.25,
    "呀": 0.20,
    "哦": 0.25,
    "噢": 0.25,
    "吧": 0.20,
    "啊": 0.20,
    "。": 0.15,   # 句号轻微收尾
}


def _apply_ending_treatment(audio_data, sr, text, is_tone=False, tone_type=None, ending_offset=0.0):
    """根据文本结尾调整音频：疑问/语气词结尾轻一点拖长，语气词重一点。
    text: 该段的原始文本（用于判断结尾字）
    is_tone: 是否是 tone 段
    tone_type: tone 类型（如"生气"）
    ending_offset: 用户微调尾音柔化偏移
        >0: 更柔更轻（fade 时长加长，终点音量更低）
        <0: 更短更有力（fade 时长缩短，终点音量更高）
        =0: 默认（fade 到 0.3）
    """
    if len(audio_data) == 0 or sr <= 0:
        return audio_data
    result = audio_data.copy()
    text = str(text or '').strip()

    # 1. tone 段：语气词重一点（音量增益）
    if is_tone and tone_type in ("生气", "兴奋", "俏皮"):
        # 取开头 500ms 做增益（语气词通常在开头）
        gain_samples = min(int(sr * 0.5), len(result))
        gain = np.linspace(1.25, 1.0, gain_samples)  # 渐减增益，避免突变
        result[:gain_samples] *= gain
        print(f"  [语气词增益] {tone_type} 段开头 {gain_samples/sr:.2f}s ×1.25→1.0")

    # 2. 结尾字处理：疑问/语气词结尾轻一点
    if text:
        # 取最后一个字（中文）或标点
        last_char = text[-1] if text else ''
        # 如果结尾是标点，取前一个字
        if last_char in '。？！.!?,，':
            check_char = text[-2] if len(text) >= 2 else text[-1]
        else:
            check_char = last_char

        fade_s = 0.0
        # 问号结尾：拖长轻一点
        if last_char in '？?':
            fade_s = ENDING_LIGHT_FADE.get('？', 0.35)
        # 语气词结尾：轻一点
        elif check_char in ENDING_LIGHT_FADE:
            fade_s = ENDING_LIGHT_FADE.get(check_char, 0.20)
        # 句号结尾：轻微收尾
        elif last_char in '。.':
            fade_s = ENDING_LIGHT_FADE.get('。', 0.15)

        # 用户微调：ending_offset 影响 fade 时长和终点音量
        # >0: 时长加长（×(1+offset)），终点音量降低（0.3 → max(0.05, 0.3-offset*0.25)）
        # <0: 时长缩短（×(1+offset)），终点音量升高（0.3 → min(0.7, 0.3-offset*0.4)）
        try:
            eo = float(ending_offset) if ending_offset is not None else 0.0
        except (TypeError, ValueError):
            eo = 0.0
        if eo != 0.0 and fade_s > 0:
            fade_s = max(0.05, fade_s * (1.0 + eo))
            target_vol = 0.3 - eo * 0.25 if eo > 0 else 0.3 - eo * 0.4
            target_vol = max(0.05, min(0.7, target_vol))
        else:
            target_vol = 0.3

        if fade_s > 0:
            fade_samples = min(int(sr * fade_s), len(result) // 2)  # 不超过一半
            if fade_samples > 10:
                # 线性 fade out（音量逐渐降到 target_vol，保留尾音）
                fade_curve = np.linspace(1.0, target_vol, fade_samples)
                result[-fade_samples:] *= fade_curve
                print(f"  [结尾轻化] '{check_char}' 结尾 {fade_samples/sr:.2f}s fade out →{target_vol:.2f} (eo={eo:+.2f})")

    return result


def _detect_audio_quality(audio_data, sr, text_len=10):
    """检测合成音频质量，返回 (is_bad, reason)。
    检测：1) 过短（提前终止）2) 远短于预期（AR模型提前终止）3) 白噪音（高频比高）4) 全静音
    """
    if len(audio_data) == 0:
        return True, "空音频"
    duration = len(audio_data) / sr
    # 1. 过短检测：文本长度对应预期时长，中文约 4字/秒
    expected_min = max(0.5, text_len / 5.0)  # 预期最短时长（保守估计）
    if duration < expected_min * 0.4 and duration < 1.5:
        return True, f"过短({duration:.2f}s, 预期>{expected_min*0.4:.2f}s)"
    # 1.5 远短于预期检测：duration < expected*0.5 触发重试
    # 场景：GPT-SoVITS v3 AR模型提前终止，生成时长明显短于文本应有的时长
    # 例：9字文本预期2.25s，实际只生成1.13s（50%）→ 重试
    expected_dur = max(0.5, text_len / 4.0)  # 中文约 4字/秒
    if text_len >= 6 and duration < expected_dur * 0.5:
        return True, f"提前终止({duration:.2f}s, 预期~{expected_dur:.2f}s, {duration/expected_dur*100:.0f}%)"
    # 2. 全静音检测
    rms = float(np.sqrt(np.mean(audio_data**2)))
    if rms < 0.005:
        return True, f"全静音(RMS={rms:.4f})"
    # 3. 白噪音检测：高频能量占比 > 60% 且 RMS > 0.1
    if len(audio_data) > sr * 0.1:  # 至少 100ms
        # 取中段 500ms 做检测（避免开头/结尾淡入淡出影响）
        mid_start = len(audio_data) // 4
        mid_end = min(mid_start + int(sr * 0.5), len(audio_data))
        mid = audio_data[mid_start:mid_end]
        if len(mid) > 100:
            fft = np.abs(np.fft.rfft(mid))
            total_energy = float(np.sum(fft**2)) + 1e-10
            high_freq_energy = float(np.sum(fft[len(fft)//2:]**2))
            hf_ratio = high_freq_energy / total_energy
            mid_rms = float(np.sqrt(np.mean(mid**2)))
            if hf_ratio > 0.6 and mid_rms > 0.1:
                return True, f"白噪音(高频比={hf_ratio:.2f}, RMS={mid_rms:.3f})"
    return False, "OK"


def should_keep_quality_retry_audio(reason, sample_count, sample_rate):
    """Keep usable final audio so a later sentence is not silently dropped.

    A short segment can indicate an early EOS, but it is still preferable to
    retaining it than dropping the whole sentence. Empty, silent, and
    white-noise output remain rejected because they cannot carry speech.
    """
    if sample_count <= 0 or sample_rate <= 0:
        return False
    reason_text = str(reason or "")
    return not any(marker in reason_text for marker in ("空音频", "全静音", "白噪音"))


# 伤心/难过关键词（用于检测伤心后疑问句）
SAD_KEYWORDS = {"难过", "伤心", "泪", "痛", "遗憾", "失去", "离开",
                "再见", "抱歉", "对不起", "想念", "回忆", "害怕", "孤单", "寂寞",
                "不要我", "忘记", "消失", "等不到", "回不去"}


def _has_sad_context(text):
    """检测文本是否包含真正的伤心/难过语境（排除'哭笑不得'等）"""
    for kw in SAD_KEYWORDS:
        if kw in text:
            return True
    # "哭"单独出现才算伤心，"哭笑不得"不算
    if "哭" in text and "笑" not in text:
        return True
    return False


def _has_question(text):
    """检测文本是否包含问句"""
    return "？" in text or "?" in text


def classify_emotion(text):
    """
    情感分类（优化版）
    优先级：shy_happy > sad_question > comfort > excited > strong > question > sad > gentle
    返回 (emotion, intensity) 元组
    """
    # 0. shy_happy（最高优先，体现角色关系感）
    shy_kws = EMOTION_RULES["shy_happy"]["keywords"]
    shy_count = sum(1 for kw in shy_kws if kw in text)
    if shy_count >= 2:
        return "shy_happy", "high"
    if shy_count == 1:
        return "shy_happy", "medium"

    # 1. 伤心语境 + 问句 → 轻声问
    if _has_sad_context(text) and _has_question(text):
        return "sad_question", "medium"

    # 2. 安慰陪伴
    comfort_kws = EMOTION_RULES["comfort"]["keywords"]
    comfort_count = sum(1 for kw in comfort_kws if kw in text)
    if comfort_count >= 2:
        return "comfort", "high"
    if comfort_count == 1:
        # 问句里有安慰关键词，优先安慰
        if _has_question(text):
            return "comfort", "medium"
        return "comfort", "medium"

    # 3. 危险/警觉
    excited_kws = EMOTION_RULES["excited"]["keywords"]
    excited_count = sum(1 for kw in excited_kws if kw in text)
    if excited_count >= 2:
        return "excited", "high"
    if excited_count == 1:
        return "excited", "medium"

    # 4. 坚定承诺
    strong_kws = EMOTION_RULES["strong"]["keywords"]
    strong_count = sum(1 for kw in strong_kws if kw in text)
    if strong_count >= 2:
        return "strong", "high"
    if strong_count == 1:
        return "strong", "medium"

    # 5. 普通疑问
    if _has_question(text):
        return "question", "low"

    # 6. 悲伤
    sad_kws = EMOTION_RULES["sad"]["keywords"]
    sad_count = sum(1 for kw in sad_kws if kw in text)
    if sad_count >= 2:
        return "sad", "high"
    if sad_count == 1:
        return "sad", "medium"

    # 7. 默认温柔
    return "gentle", "low"


# ============================================================
# 角色一致性修正 + 情绪冷却
# ============================================================
# 按角色隔离情绪历史，防止跨角色串味
_emotion_history = {}  # {char_id: [emotion, ...]}
_MAX_SAME_EMOTION = 3  # 连续3次同一情感后降级

# 过激情绪压制关键词
_OVERINTENSE_KEYWORDS = {
    "哭死", "崩溃", "受不了了", "疯了", "绝望", "撕心裂肺",
    "暴怒", "怒吼", "尖叫", "歇斯底里"
}

def normalize_emotion(emotion, intensity, text, char_id="default", allow_cooldown=True):
    """
    角色一致性修正：
    1. 过激情绪压制（赛琳娜不会歇斯底里）
    2. 情绪冷却（防止连续多句同一种强烈情绪）— 按角色隔离
    3. intensity 上限控制
    """
    global _emotion_history

    # 1. 过激情绪压制
    if any(kw in text for kw in _OVERINTENSE_KEYWORDS):
        if intensity == "high":
            intensity = "medium"
        if emotion == "sad":
            emotion = "comfort"

    # 2. 情绪冷却（按角色隔离）
    hist = _emotion_history.setdefault(char_id, [])
    hist.append(emotion)
    if len(hist) > 10:
        _emotion_history[char_id] = hist[-10:]

    if allow_cooldown and len(hist) >= _MAX_SAME_EMOTION:
        recent = hist[-_MAX_SAME_EMOTION:]
        if all(e == emotion for e in recent):
            if emotion == "sad":
                emotion = "gentle"
            elif emotion == "shy_happy":
                emotion = "gentle"
            elif emotion == "excited":
                emotion = "strong"
            elif emotion == "comfort":
                emotion = "gentle"
            intensity = "low"

    # 3. intensity 上限
    if emotion in ("excited", "sad") and intensity == "high":
        intensity = "medium"

    return emotion, intensity


# ============================================================
# 停顿排版
# ============================================================
def _limit_ellipsis(text, max_per_15chars=1, max_per_sentence=2):
    """限制省略号密度：每15个字符最多1个，每句最多2个"""
    # 计算当前省略号数量
    count = text.count("……")
    chars = len([c for c in text if '\u4e00' <= c <= '\u9fff'])
    if chars == 0:
        return text

    allowed = max(1, chars // 15)
    if count <= allowed and count <= max_per_sentence:
        return text

    # 需要删除多余的省略号，优先保留问号前和句号前的
    # 简单策略：从后往前删
    result = list(text)
    removed = 0
    to_remove = count - min(allowed, max_per_sentence)

    # 优先删除不在问号/句号前的省略号
    i = len(result) - 2
    while i >= 0 and removed < to_remove:
        if result[i] == '…' and i + 1 < len(result) and result[i+1] == '…':
            # 检查后面是否是问号或句号
            next_char = result[i+2] if i + 2 < len(result) else ''
            if next_char not in ('？', '。', '！'):
                result[i] = ''
                result[i+1] = ''
                removed += 1
        i -= 1

    # 如果还不够，从前往后删
    i = 0
    while i < len(result) - 1 and removed < to_remove:
        if result[i] == '…' and result[i+1] == '…':
            result[i] = ''
            result[i+1] = ''
            removed += 1
        i += 1

    return ''.join(result)


def add_pauses(text, style="medium"):
    """
    根据情感类型添加停顿标记

    重要：GPT-SoVITS 把"……"解释为约1秒的长停顿。
    过多省略号会导致音频碎片化（长静音+短语音交替）。
    策略：保留原始逗号做短停，只在关键位置用省略号做轻声/拖长效果。

    风格说明：
    - comfort: 安慰/坚定陪伴，逗号保留，句号/问号前加省略号=沉稳收尾
    - heavy: 悲伤，逗号保留但句号前加短停，问号前轻声
    - heavy_whisper: 伤心后轻声问，问号前省略号=轻声，逗号保留
    - gentle_ask: 温柔关切地问，问号前省略号=轻声，逗号保留
    - firm: 刚强坚定，逗号保留=短停（坚定不犹豫）
    - medium: 日常，保持原标点
    - light: 激动，保持原样
    - shy: 害羞小高兴，问号前省略号=犹豫
    """
    if style == "comfort":
        # 安慰：逗号保留（坚定陪伴感），句号/问号前加省略号=沉稳收尾
        text = text.replace("。", "……。")
        text = text.replace("！", "……！")
        text = text.replace("？", "……？")

    elif style == "heavy":
        # 悲伤：逗号保留（短停=坚定陪伴感），句号/问号前加省略号=沉稳收尾
        text = text.replace("。", "……。")
        text = text.replace("！", "……！")
        text = text.replace("？", "……？")

    elif style == "heavy_whisper":
        # 伤心后轻声问：问号前省略号=轻声拖长，逗号保留
        text = text.replace("？", "……？")
        text = text.replace("?", "……？")
        text = text.replace("。", "……。")
        text = text.replace("！", "……！")

    elif style == "gentle_ask":
        # 温柔关切地问：问号前省略号=轻声，逗号保留
        text = text.replace("？", "……？")
        text = text.replace("?", "……？")
        text = text.replace("。", "……。")

    elif style == "firm":
        # 刚强坚定：逗号保留=短停（坚定不犹豫）
        text = text.replace("。", "……。")
        text = text.replace("！", "……！")

    elif style == "light":
        # 激动语气少停顿，但顿号→逗号（GPT-SoVITS 对顿号停顿太短）
        text = text.replace("、", "，")
        text = text.replace(",", "，")

    elif style == "shy":
        # 害羞小高兴：问号前省略号=害羞犹豫，逗号保留
        text = text.replace("？", "……？")
        text = text.replace("?", "……？")
        text = text.replace("。", "……。")

    else:
        # medium: 日常，在句号/问号/感叹号前加短停顿（逗号=轻停顿）
        # GPT-SoVITS 对"，"有内置短停顿，但对"。""？"停顿不明显，
        # 用"，"替换句末标点前的位置来强制短停顿（保持日常感，不像……那样沉稳）
        text = text.replace("。", "，。")
        text = text.replace("！", "，！")
        text = text.replace("？", "，？")
        text = text.replace("?", "，？")

    # 去掉连续多个省略号
    while "…………" in text:
        text = text.replace("…………", "……")

    # 限制省略号密度
    text = _limit_ellipsis(text)

    return text


# ============================================================
# 推理引擎
# ============================================================
# 语音库 — 动态扫描，语音独立于角色
# 新架构：包内 voices 与 userData/voices 双目录扫描。
# 兼容旧架构：userData/characters/<id>/voice/。
import json as _json

BUNDLED_VOICES_DIR = os.path.abspath(os.environ.get("BUNDLED_VOICES_DIR") or os.path.join(APP_ROOT, "voices"))
USER_VOICES_DIR = os.path.abspath(os.environ.get("USER_VOICES_DIR") or BUNDLED_VOICES_DIR)
VOICE_DIRS = list(dict.fromkeys([USER_VOICES_DIR, BUNDLED_VOICES_DIR]))
CHARACTER_DIR = os.path.abspath(os.environ.get("CHARACTER_DIR") or os.path.join(APP_ROOT, "character"))

# 兼容旧架构：char_id → 权重前缀 + 训练时参考音目录（仅用于 ref_audio 回退）
_LEGACY_CHAR_MAP = {
    "1": {"prefix": "selina_core", "ref_dir": "selina", "name": "赛琳娜"},
    "2": {"prefix": "秧秧_core",   "ref_dir": "秧秧",   "name": "秧秧"},
}


def scan_voices():
    """动态扫描所有可用语音。
    返回 {voice_name: {gpt_path, sovits_path, config_path, refs_dir, voice_dir, source, char_id}}
    """
    voices = {}
    # 1. 用户声音优先，其次包内声音；同名时 userData 覆盖 bundled。
    for voices_dir in VOICE_DIRS:
        if not os.path.isdir(voices_dir):
            continue
        for name in os.listdir(voices_dir):
            if name in voices:
                continue
            vdir = os.path.join(voices_dir, name)
            if not os.path.isdir(vdir):
                continue
            gpt = os.path.join(vdir, "gpt.ckpt")
            sovits = os.path.join(vdir, "sovits.pth")
            if not (os.path.isfile(gpt) and os.path.isfile(sovits)):
                continue
            config = os.path.join(vdir, "config.json")
            voices[name] = {
                "gpt_path": gpt,
                "sovits_path": sovits,
                "config_path": config if os.path.isfile(config) else None,
                "refs_dir": os.path.join(vdir, "refs"),
                "voice_dir": vdir,
                "source": "user" if voices_dir == USER_VOICES_DIR else "bundled",
                "char_id": None,
            }
    # 2. 兼容角色目录内的旧 voice/ 结构。
    if os.path.isdir(CHARACTER_DIR):
        for cid in os.listdir(CHARACTER_DIR):
            cdir = os.path.join(CHARACTER_DIR, cid)
            if not os.path.isdir(cdir):
                continue
            vdir = os.path.join(cdir, "voice")
            if not os.path.isdir(vdir):
                continue
            gpt = os.path.join(vdir, "gpt.ckpt")
            sovits = os.path.join(vdir, "sovits.pth")
            if not (os.path.isfile(gpt) and os.path.isfile(sovits)):
                continue
            config = os.path.join(vdir, "config.json")
            vname = cid
            if os.path.isfile(config):
                try:
                    with open(config, "r", encoding="utf-8") as f:
                        cfg = _json.load(f)
                    vname = cfg.get("character_name") or cid
                except Exception:
                    pass
            # 不覆盖新架构的同名语音
            if vname not in voices:
                voices[vname] = {
                    "gpt_path": gpt,
                    "sovits_path": sovits,
                    "config_path": config if os.path.isfile(config) else None,
                    "refs_dir": os.path.join(vdir, "refs"),
                    "voice_dir": vdir,
                    "source": "legacy",
                    "char_id": cid,
                }
    return voices


def resolve_voice_name(voice_name=None, char_id=None):
    """根据 voice_name 或 char_id 解析出实际语音名称。
    优先级：voice_name > char_id 映射 > 第一个可用语音
    """
    voices = scan_voices()
    if voice_name and voice_name in voices:
        return voice_name
    if char_id:
        # 旧架构映射
        legacy = _LEGACY_CHAR_MAP.get(str(char_id))
        if legacy and legacy["name"] in voices:
            return legacy["name"]
        # 兼容：character/<id>/voice/ 的 char_id 直接作为语音名（数字ID不会命中）
        # 尝试用 char_id 找 legacy 语音
        for vname, info in voices.items():
            if info.get("char_id") == str(char_id):
                return vname
    # 回退到第一个可用语音
    if voices:
        return sorted(voices.keys())[0]
    return None


class SelinaTTS:
    def __init__(self, use_core=True):
        # 延迟导入 inference_webui
        _ensure_inference_webui()
        self.change_gpt = _change_gpt_weights
        self.change_sovits = _change_sovits_weights
        self._use_core = use_core

        # 权重目录（仅用于旧架构 _find_weight_files 回退）
        if use_core:
            self.sovits_dir = os.path.join(GPT_SOVITS_ROOT, "SoVITS_weights_v3_core")
            self.gpt_dir = os.path.join(GPT_SOVITS_ROOT, "GPT_weights_v3_core")
        else:
            self.sovits_dir = os.path.join(GPT_SOVITS_ROOT, "SoVITS_weights_v3")
            self.gpt_dir = os.path.join(GPT_SOVITS_ROOT, "GPT_weights_v3")

        # 当前已加载的语音名称（None=未加载）
        self._current_voice = None
        self._voice_info = None
        # One identity reference per voice. Emotion must never change this key.
        self._ref_cache = {}

    def switch_voice(self, voice_name):
        """切换语音权重。如果 voice_name 与当前相同则跳过。"""
        if voice_name == self._current_voice and self._voice_info:
            return True
        voices = scan_voices()
        info = voices.get(voice_name)
        if not info:
            print(f"[engine] 未知语音 voice_name={voice_name}，可用: {list(voices.keys())}", flush=True)
            return False

        sovits_path = info["sovits_path"]
        gpt_path = info["gpt_path"]
        print(f"[engine] 切换语音 → {voice_name} (source={info['source']})", flush=True)

        # v1 zero-shot 模式：不加载自定义 SoVITS 权重（v3 LoRA 会导致音色变化）
        # 保持 v1 预训练模型（s2G488k.pth），用参考音频决定音色（zero-shot 克隆）
        # 仅加载 GPT 权重（韵律模型，不影响音色）
        print(f"[engine] 使用 v1 zero-shot 模式（参考音频决定音色，不加载 v3 SoVITS）", flush=True)
        print(f"加载 GPT: {gpt_path}", flush=True)
        self.change_gpt(gpt_path=gpt_path)
        print(f"[engine] GPT 加载完成", flush=True)
        self._current_voice = voice_name
        self._voice_info = info
        # 切换语音后清空参考音频缓存
        self._ref_cache = {}
        # 正式运行默认关闭 profiling，避免每次切换角色都重新包装推理函数。
        # 排障时显式设置 TTS_ENABLE_PROFILING=1，启动阶段会安装一次探针。
        if os.environ.get("TTS_ENABLE_PROFILING", "0") == "1":
            try:
                from profiling_probe import install_probe
                install_probe()
            except Exception:
                pass
        return True

    def switch_character(self, char_id):
        """兼容旧接口：根据 char_id 切换语音。"""
        voice_name = resolve_voice_name(char_id=char_id)
        if not voice_name:
            print(f"[engine] 无可用语音 (char_id={char_id})", flush=True)
            return False
        return self.switch_voice(voice_name)

    def _find_ref(self, emotion="gentle", char_id="1", voice_name=None):
        """Resolve one stable identity reference for the selected voice."""
        # 解析语音名称
        if not voice_name:
            voice_name = resolve_voice_name(char_id=char_id) or "default"
        cache_key = f"{voice_name}:identity:{VOICE_IDENTITY_POLICY_VERSION}"
        if cache_key in self._ref_cache:
            return self._ref_cache[cache_key]

        identity_emotion = "gentle"
        candidates = [identity_emotion, "neutral"]

        voices = scan_voices()
        vinfo = voices.get(voice_name)

        # 1. 优先：从语音目录的 config.json + refs/ 读取（新架构 + 旧架构部署的 refs）
        if vinfo:
            voice_dir = vinfo["voice_dir"]
            config_path = vinfo.get("config_path")
            if config_path and os.path.isfile(config_path):
                try:
                    with open(config_path, "r", encoding="utf-8") as f:
                        cfg = _json.load(f)
                    resolved = resolve_identity_reference(cfg, voice_dir)
                    if resolved[0]:
                        self._ref_cache[cache_key] = resolved
                        return resolved
                except Exception:
                    pass
            # Legacy voice folders still use gentle_0.wav as their identity.
            refs_dir = vinfo.get("refs_dir")
            if refs_dir and os.path.isdir(refs_dir):
                for cand in candidates:
                    ref_path = os.path.join(refs_dir, f"{cand}_0.wav")
                    if os.path.isfile(ref_path):
                        self._ref_cache[cache_key] = (ref_path, "")
                        return ref_path, ""

        # 2. 兼容旧架构：从 GPT-SoVITS/ref_audio/<ref_dir>/<emotion>/ 读取（训练时参考音）
        legacy = _LEGACY_CHAR_MAP.get(str(char_id)) if char_id else None
        if legacy:
            ref_root = os.path.join(GPT_SOVITS_ROOT, "ref_audio", legacy["ref_dir"])
            for cand in candidates:
                ref_dir = os.path.join(ref_root, cand)
                if os.path.exists(ref_dir):
                    refs = sorted(f for f in os.listdir(ref_dir) if f.endswith(".wav"))
                    if refs:
                        chosen = refs[0]
                        ref_path = os.path.join(ref_dir, chosen)
                        ref_text = self._find_text_for_wav(os.path.splitext(chosen)[0], char_id)
                        self._ref_cache[cache_key] = (ref_path, ref_text)
                        return ref_path, ref_text

            # 3. 从训练数据 raw/<ref_dir>/ 中找
            raw_dir_name = legacy["ref_dir"]
            wav_dir = os.path.join(GPT_SOVITS_ROOT, "raw", raw_dir_name)
            best_ref, best_score, best_text = None, -999, ""
            if os.path.exists(wav_dir):
                for wav_name in sorted(os.listdir(wav_dir)):
                    if not wav_name.endswith(".wav"):
                        continue
                    wav_path = os.path.join(wav_dir, wav_name)
                    try:
                        y, sr = librosa.load(wav_path, sr=32000)
                        duration = len(y) / sr
                        if duration < 3.0 or duration > 7.0:
                            continue
                        onset = librosa.onset.onset_detect(y=y, sr=sr)
                        if len(onset) < 3:
                            continue
                        onset_times = librosa.frames_to_time(onset, sr=sr)
                        intervals = np.diff(onset_times)
                        score = -np.std(intervals) * 2.0 + np.mean(intervals) * 4.0
                        if score > best_score:
                            best_score = score
                            best_ref = wav_path
                            best_text = self._find_text_for_wav(os.path.splitext(wav_name)[0], char_id)
                    except Exception:
                        continue
            if best_ref:
                self._ref_cache[cache_key] = (best_ref, best_text)
                return best_ref, best_text

            # 4. 最终回退：gentle 目录
            ref_dir = os.path.join(ref_root, "gentle")
            if os.path.exists(ref_dir):
                refs = [f for f in os.listdir(ref_dir) if f.endswith(".wav")]
                if refs:
                    ref_path = os.path.join(ref_dir, refs[0])
                    ref_text = self._find_text_for_wav(os.path.splitext(refs[0])[0], char_id)
                    self._ref_cache[cache_key] = (ref_path, ref_text)
                    return ref_path, ref_text

        return None, ""

    def _find_text_for_wav(self, wav_name, char_id="1"):
        info = _LEGACY_CHAR_MAP.get(str(char_id), _LEGACY_CHAR_MAP["1"])
        raw_dir_name = info["ref_dir"]
        # 尝试 {ref_dir}.list 或 selina.list
        for list_name in [f"{raw_dir_name}.list", "selina.list"]:
            label_file = os.path.join(GPT_SOVITS_ROOT, "raw", raw_dir_name, list_name)
            if os.path.exists(label_file):
                with open(label_file, "r", encoding="utf-8") as f:
                    for line in f:
                        if wav_name in line:
                            parts = line.strip().split("|")
                            if len(parts) >= 4:
                                return parts[3]
        # 也尝试从 ref_texts.txt 读取
        ref_texts_file = os.path.join(GPT_SOVITS_ROOT, "ref_audio", info["ref_dir"], "ref_texts.txt")
        if os.path.exists(ref_texts_file):
            with open(ref_texts_file, "r", encoding="utf-8") as f:
                for line in f:
                    if wav_name in line:
                        parts = line.strip().split("|")
                        if len(parts) >= 2:
                            return parts[-1]
        return ""

    def synthesize(self, text, emotion=None, output_path=None, override_params=None, char_id="default", voice_name=None):
        """
        智能合成：文本预处理 → 自动判断情感+强度 → 角色一致性修正 → 添加停顿 → 选参考音频 → 合成
        override_params: 用户微调参数覆盖
        char_id: 角色ID，用于情绪冷却隔离（兼容旧接口）
        voice_name: 语音名称（新架构，优先于 char_id 用于权重切换）
        """
        # 确保 inference_webui 已导入（首次调用时执行）
        _ensure_inference_webui()
        get_tts_wav = _get_tts_wav
        i18n = _i18n
        import soundfile as sf

        # 0a. 切换语音权重（优先 voice_name，兼容 char_id）
        target_voice = resolve_voice_name(voice_name=voice_name, char_id=char_id)
        if target_voice:
            if not self.switch_voice(target_voice):
                print(f"[警告] 语音 {target_voice} 权重切换失败，使用当前权重")
        elif self._current_voice is None:
            # 首次调用且无指定语音，加载第一个可用语音
            voices = scan_voices()
            if voices:
                first = sorted(voices.keys())[0]
                print(f"[engine] 首次合成，自动加载语音: {first}", flush=True)
                self.switch_voice(first)

        # 0. 文本预处理
        original_text = text
        text = extract_spoken_text(text)
        if not text:
            print("[跳过] 去除括号后没有可配音的内容")
            return None

        # 1. 自动判断情感 + 强度
        emotion_was_explicit = emotion is not None
        if emotion is None:
            emotion, intensity = classify_emotion(text)
        else:
            intensity = EMOTION_RULES.get(emotion, EMOTION_RULES["gentle"]).get("intensity", "medium")

        # 2. 角色一致性修正
        emotion, intensity = normalize_emotion(
            emotion,
            intensity,
            text,
            char_id=char_id,
            allow_cooldown=not emotion_was_explicit,
        )

        rule = EMOTION_RULES.get(emotion, EMOTION_RULES["gentle"])
        print(f"[情感] {rule['desc']} ({emotion}) intensity={intensity}")

        # 3. 文本预处理：省略号替换 + 停顿
        #    省略号"……"是 GPT-SoVITS 的老大难：文本前端对中文省略号没有可靠映射，
        #    AR 模型训练时很少见到这个符号，遇到"……"经常跳过后面内容或对齐乱掉。
        #    解决：把"……"替换成逗号"，"（保留停顿语气，避免跳字）。
        import re as _re
        cleaned_text = text
        # 过滤引号字符（引号残留产生孤立段→GPT-SoVITS 杂音）+ 半角~→全角～
        cleaned_text = cleaned_text.replace('"', '').replace('"', '').replace('"', '')
        cleaned_text = cleaned_text.replace('「', '').replace('」', '')
        cleaned_text = cleaned_text.replace('『', '').replace('』', '')
        cleaned_text = cleaned_text.replace('~', '～')
        # 过滤英文单词和emoji（GPT-SoVITS 训练的是中文，遇到英文/emoji会合成失败变杂音）
        # 1. 移除emoji（各种emoji范围）
        cleaned_text = _re.sub(
            r'[\U0001F300-\U0001F9FF\U0001FA00-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F02F\U0001F0A0-\U0001F0FF\U0001F100-\U0001F1FF\U0001F200-\U0001F2FF]',
            '', cleaned_text
        )
        # 2. 移除英文单词（连续的英文字母，保留标点和空格）
        #    常见情况：AI 偶尔输出英文歌词/短语，GPT-SoVITS 无法合成
        if _re.search(r'[a-zA-Z]{2,}', cleaned_text):
            # 英文单词前后可能有空格，移除英文单词+多余空格
            removed = _re.findall(r'[a-zA-Z]+', cleaned_text)
            print(f"  [过滤英文] 移除英文: {removed}")
            # 移除英文单词及其前后的英文标点和空格
            cleaned_text = _re.sub(r'\s*[a-zA-Z]+\.?\s*', '，', cleaned_text)
            # 清理移除后可能产生的多余逗号、连续逗号
            while '，，' in cleaned_text:
                cleaned_text = cleaned_text.replace('，，', '，')
            cleaned_text = _re.sub(r'^[，,]\s*', '', cleaned_text)  # 去开头逗号
            cleaned_text = _re.sub(r'\s{2,}', ' ', cleaned_text)
        # 替换所有省略号变体：……（中文）、...（3点）、….（混合）→ 逗号
        cleaned_text = _re.sub(r'…{2,}|\.{3,}|…\.+', '，', cleaned_text)
        # 清理连续逗号（替换后可能产生，，）
        while '，，' in cleaned_text:
            cleaned_text = cleaned_text.replace('，，', '，')
        # 去掉开头的逗号（如果省略号在句首）
        cleaned_text = cleaned_text.lstrip('，').lstrip()

        pause_style = rule["pause_style"]
        if override_params and "pause_style" in override_params:
            pause_style = override_params["pause_style"]
        # 软切分模式下统一用 light 风格（不在句末加省略号），段间静音负责句末停顿
        paused_text = add_pauses(cleaned_text, "light")
        print(f"[排版] style={pause_style}→light(软切分) | 省略号→逗号 | {text} → {paused_text}")

        # 4. 选择参考音频
        ref_audio, ref_text = self._find_ref(emotion, char_id=char_id, voice_name=target_voice)
        print(f"[参考] {ref_audio}")

        # 5. Identity-locked inference parameters. Sampling remains identical
        # across emotions; only restrained prosody is allowed to vary.
        requested_params = dict(override_params or {})
        if "speed" not in requested_params:
            requested_params["speed"] = get_emotion_prosody(emotion)["speed"]
        stable_params = sanitize_runtime_params(emotion, requested_params)
        try:
            request_retry_index = max(0, int(stable_params.get("_retry_index", 0)))
        except (TypeError, ValueError):
            request_retry_index = 0
        final_speed = stable_params["speed"] + stable_params["speed_offset"]
        stable_params["speed"] = sanitize_runtime_params(emotion, {"speed": final_speed})["speed"]
        override_params = stable_params
        temp = stable_params["temperature"]
        top_p = stable_params["top_p"]
        speed = stable_params["speed"]
        effective_speed = speed
        if "intensity" in stable_params:
            intensity = stable_params["intensity"]

        print(
            f"[参数] identity={VOICE_IDENTITY_POLICY_VERSION}, "
            f"temperature={temp:.2f}, top_p={top_p:.2f}, speed={effective_speed:.2f}"
        )

        # 6. 软切分：按句末标点（。？！；）切成单句，每句单独用"不切"合成
        #    这样既绕开 GPT-SoVITS 多句合成 STACK_OVERFLOW 崩溃（硬约束：character/2 必须"不切"），
        #    又能在句末插入静音实现停顿梯度（。？！ > ； > ，）。
        import re
        import torch

        how_to_cut_opt0 = i18n("不切")
        how_to_cut = how_to_cut_opt0
        pause_second = 0.05

        # 句末标点静音时长表（秒）——贴近自然朗读停顿规律
        # 句号/问号/感叹号 > 分号，确保句末有明显停顿
        # 用户可通过全局"句间停顿"偏移（pause_offset）放大这些值
        SENTENCE_PAUSE = {
            "。": 0.65, "？": 0.75, "！": 0.75, "；": 0.50,
            "?": 0.75, "!": 0.75, ";": 0.50,
        }
        DEFAULT_PAUSE = 0.50  # 无标点结尾时的默认停顿

        # 用户微调：全局句间停顿偏移（0=默认, 0~2.0 可调）
        # 用乘法放大：实际停顿 = 基础停顿 × (1 + pause_offset)
        pause_offset = 0.0
        if override_params and "pause_offset" in override_params:
            try:
                pause_offset = float(override_params["pause_offset"])
            except (TypeError, ValueError):
                pause_offset = 0.0
        # 情绪只改变节奏，不改变身份采样：悲伤/害羞给句末更多呼吸，
        # 开心/兴奋略收短停顿，避免每种情绪都读成同一条平直语速。
        emotion_pause_scale = float(rule.get("pause_scale", 1.0))
        emotion_pause_scale = max(0.84, min(1.14, emotion_pause_scale))
        pause_multiplier = (1.0 + max(0.0, pause_offset)) * emotion_pause_scale
        print(
            f"[停顿] pause_offset={pause_offset:.2f} "
            f"emotion_scale={emotion_pause_scale:.2f} → multiplier={pause_multiplier:.2f}"
        )

        # 用户微调：整体音量偏移、开头淡入时长、整体柔和度（已合并尾音柔化）
        volume_offset = 0.0
        fadein_s = 0.015  # 默认 15ms
        soft_offset = 0.0
        if override_params:
            if "volume_offset" in override_params:
                try: volume_offset = float(override_params["volume_offset"])
                except (TypeError, ValueError): volume_offset = 0.0
            if "fadein" in override_params:
                try: fadein_s = max(0.0, min(0.5, float(override_params["fadein"])))
                except (TypeError, ValueError): fadein_s = 0.015
            if "soft_offset" in override_params:
                try: soft_offset = float(override_params["soft_offset"])
                except (TypeError, ValueError): soft_offset = 0.0
        if volume_offset != 0.0:
            print(f"[音量] volume_offset={volume_offset:+.2f} → 增益×{1.0+volume_offset:.2f}")
        if soft_offset != 0.0:
            print(f"[柔和度] soft_offset={soft_offset:+.2f} ({'更柔更轻(含尾音柔化)' if soft_offset>0 else '更有力'})")

        def _trim_silence(audio_data, sr, max_trim=0.5, keep=0.1):
            """裁剪音频开头/结尾的长静音 + 压缩中间 >2s 的长静音段。
            避免多段拼接时静音累加导致"跳字/不流利"。
            max_trim: 开头/结尾最多裁剪多少秒
            keep: 裁剪后保留的缓冲静音时长
            """
            if len(audio_data) == 0 or sr <= 0:
                return audio_data
            # 计算 RMS（25ms 帧）
            frame_len = max(1, int(sr * 0.025))
            hop = max(1, frame_len // 2)
            overall_rms = float(np.sqrt(np.mean(audio_data**2))) if len(audio_data) > 0 else 0
            if overall_rms < 1e-5:
                return audio_data  # 几乎全静音，不裁剪
            threshold = max(0.015, overall_rms * 0.4)

            # 找开头第一个非静音帧
            first_voice = 0
            max_trim_samples = int(sr * max_trim)
            for i in range(0, min(len(audio_data) - frame_len, max_trim_samples), hop):
                frame = audio_data[i:i+frame_len]
                if np.sqrt(np.mean(frame**2)) >= threshold:
                    first_voice = i
                    break
            else:
                first_voice = min(max_trim_samples, len(audio_data) // 4)

            # 找结尾最后一个非静音帧
            last_voice = len(audio_data)
            for i in range(len(audio_data) - frame_len, max(first_voice, len(audio_data) - max_trim_samples - frame_len), -hop):
                frame = audio_data[i:i+frame_len]
                if np.sqrt(np.mean(frame**2)) >= threshold:
                    last_voice = i + frame_len
                    break
            else:
                last_voice = len(audio_data)

            # 保留 keep 秒缓冲
            keep_samples = int(sr * keep)
            start = max(0, first_voice - keep_samples)
            end = min(len(audio_data), last_voice + keep_samples)

            trimmed = audio_data[start:end]

            # 压缩中间 >2s 的长静音段（GPT-SoVITS 有时会在语音中间生成异常长静音）
            # 检测连续静音段，>2s 的压缩到 0.8s
            if len(trimmed) > sr * 2:  # 至少 2 秒才处理
                # 标记静音帧
                is_silent = np.zeros(len(trimmed), dtype=bool)
                for i in range(0, len(trimmed) - frame_len, hop):
                    frame = trimmed[i:i+frame_len]
                    is_silent[i:i+frame_len] = np.sqrt(np.mean(frame**2)) < threshold

                # 找连续静音段
                segments_to_keep = []
                seg_start = 0
                in_silence = False
                sil_start = 0
                max_silence_keep = int(sr * 0.8)  # 长静音压缩到 0.8s
                long_silence_threshold = int(sr * 2.0)  # >2s 视为长静音

                result_parts = []
                i = 0
                while i < len(trimmed):
                    # 找连续静音段
                    if is_silent[i]:
                        sil_start = i
                        while i < len(trimmed) and is_silent[i]:
                            i += 1
                        sil_end = i
                        sil_len = sil_end - sil_start
                        if sil_len > long_silence_threshold:
                            # 长静音：只保留前 max_silence_keep 个样本
                            result_parts.append(trimmed[sil_start:sil_start + max_silence_keep])
                        else:
                            # 短静音：保留
                            result_parts.append(trimmed[sil_start:sil_end])
                    else:
                        voice_start = i
                        while i < len(trimmed) and not is_silent[i]:
                            i += 1
                        result_parts.append(trimmed[voice_start:i])

                if result_parts:
                    new_trimmed = np.concatenate(result_parts)
                    if len(new_trimmed) < len(trimmed):
                        old_dur = len(trimmed) / sr
                        new_dur = len(new_trimmed) / sr
                        print(f"  [压缩长静音] {old_dur:.2f}s → {new_dur:.2f}s")
                        trimmed = new_trimmed

            if len(trimmed) < len(audio_data):
                trimmed_dur = len(trimmed) / sr
                orig_dur = len(audio_data) / sr
                print(f"  [裁剪] {orig_dur:.2f}s → {trimmed_dur:.2f}s")
            return trimmed

        # 切分：按。？！；切，保留标点。逗号、顿号保留在句内（由 add_pauses 处理）
        def _split_sentences(txt):
            """按句末标点切分，返回 [(sentence, end_punct), ...]"""
            # 用正则匹配：非句末标点的字符 + 可选的句末标点
            parts = re.findall(r'[^。？！；!?]+[。？！；!?]?', txt)
            segs = []
            buf = ""
            for p in parts:
                p = p.strip()
                if not p:
                    continue
                # 清理段首尾的引号残留（"""「」『』），避免引号被朗读产生杂音
                p = p.strip('""""「」『』\'\" ')
                if not p:
                    continue
                end_p = p[-1] if p[-1] in "。？！；!?" else ""
                # 太短的片段（<10字）合并到相邻段，避免 GPT-SoVITS 对超短文本/拟声词合成产生杂音或全静音
                # "菲比丘比，诶？"（8字）这种拟声词单独合成会生成全静音
                if len(p) < 10:
                    if not segs:
                        # 首段：累积到 buf，合并到下一段
                        buf += p
                        continue
                    else:
                        # 非首段：合并到前一段
                        last_text, last_p = segs[-1]
                        segs[-1] = (last_text + p, last_p)
                        continue
                if buf:
                    p = buf + p
                    buf = ""
                segs.append((p, end_p))
            if buf:
                # 末尾残余片段合并到上一段
                if segs:
                    last_text, last_p = segs[-1]
                    segs[-1] = (last_text + buf, last_p)
                else:
                    segs.append((buf, ""))

            # 长段按逗号二次切分（>22字）：避免 GPT-SoVITS AR 模型 T2S 步数暴增导致卡顿
            # T2S 步数与文本长度非线性增长：22字约400步，35字约1000步，40字约1400步
            # 切分后中间片以逗号结尾（短停），最后一片保留原句末标点
            MAX_LEN = 22
            refined = []
            for text, end_p in segs:
                if len(text) <= MAX_LEN:
                    refined.append((text, end_p))
                    continue
                # 按逗号切分
                comma_parts = re.split(r'(，)', text)
                chunks = []
                cur = ""
                for cp in comma_parts:
                    if len(cur) + len(cp) > MAX_LEN and cur:
                        chunks.append(cur)
                        cur = cp
                    else:
                        cur += cp
                if cur:
                    chunks.append(cur)
                # 给中间片加逗号结尾，最后一片保留原标点
                for i, ck in enumerate(chunks):
                    ck = ck.strip()
                    if not ck:
                        continue
                    if i < len(chunks) - 1:
                        if not ck.endswith('，'):
                            ck = ck + '，'
                        refined.append((ck, '，'))
                    else:
                        refined.append((ck, end_p))
            segs = refined

            # 长段切分后再次合并短段（<10字）：长段切分可能产生短片段如"菲比丘比，诶？"
            # 这种拟声词短段单独合成会全静音，必须合并到相邻段
            merged = []
            for text, end_p in segs:
                if len(text) < 10 and merged:
                    prev_text, prev_p = merged[-1]
                    merged[-1] = (prev_text + text, prev_p)
                elif len(text) < 10 and not merged:
                    # 首段短：累积到下一段
                    buf2 = text
                    # 暂存，合并到下一个
                    merged.append((text, end_p))  # 先放入，下一个循环会处理
                else:
                    if merged and len(merged[-1][0]) < 10:
                        # 前一段是短段，合并当前段
                        prev_text, prev_p = merged[-1]
                        merged[-1] = (prev_text + text, end_p)
                    else:
                        merged.append((text, end_p))
            # 最终检查：如果首段仍<10字，合并到第二段
            if len(merged) >= 2 and len(merged[0][0]) < 10:
                first_text, first_p = merged[0]
                second_text, second_p = merged[1]
                merged[1] = (first_text + second_text, second_p)
                merged.pop(0)
            segs = merged
            return segs

        segments = _split_sentences(paused_text)
        # 如果只有一段或没切出来，退回整段合成（原行为）
        if len(segments) <= 1:
            segments = [(paused_text, "")]

        print(f"[软切分] {len(segments)} 段: {[(s[:12]+'..' if len(s)>12 else s, p) for s, p in segments]}")

        all_audio = []
        sr_out = None

        # 检测段内局部语气标记 [语气:类型]文字[/语气]
        # 有标记时跳过 _split_sentences 的切句（避免标记内的。？！切断标记），
        # 直接用 _parse_tone_segments 的结果作为合成单元
        has_tone_tags = _TONE_TAG_RE.search(paused_text) is not None
        if has_tone_tags:
            print(f"[局部语气] 检测到 [语气:xx] 标记，启用段内语气切换模式")
            # 直接按 tone 段切，不按句末标点切
            tone_units = _parse_tone_segments(paused_text, emotion)
            # 转成统一的遍历单元列表：(t_text, is_tone, tone_type, end_punct)
            units = []
            for tu in tone_units:
                u_text = tu[0].strip()
                if not u_text:
                    continue
                u_is_tone = tu[2]
                u_tone_type = tu[3] if len(tu) > 3 else None
                # 取末尾标点作为段间停顿依据
                u_end_punct = ""
                for pc in (u_text[-1:] if u_text else ""):
                    if pc in SENTENCE_PAUSE or pc in "?!;":
                        u_end_punct = pc
                units.append((u_text, u_is_tone, u_tone_type, u_end_punct))
        else:
            # 无 tone 标记：用原 _split_sentences 结果，每个 seg 内只有一个普通段
            units = []
            for seg_text, end_punct in segments:
                if seg_text.strip():
                    units.append((seg_text.strip(), False, None, end_punct))

        for idx, (t_text, is_tone, tone_type, end_punct) in enumerate(units):
            if not t_text.strip():
                continue

            unit_emotion = emotion
            # Tone segments share the same identity reference and sampling.
            if is_tone and tone_type and tone_type in TONE_PRESETS:
                preset = TONE_PRESETS[tone_type]
                unit_emotion = preset["emotion"]
                t_ref_audio, t_ref_text = ref_audio, ref_text
                tone_blend = _tone_blend_factor(t_text)
                tone_params = sanitize_runtime_params(unit_emotion, {
                    **stable_params,
                    # 短转折段只向目标情绪靠近一部分，避免“但是/不过”
                    # 变成突兀的高兴、悲伤或害羞声线。
                    "speed": effective_speed + (
                        get_emotion_prosody(unit_emotion)["speed"] - effective_speed
                    ) * tone_blend,
                    "speed_offset": 0,
                })
                t_temp = tone_params["temperature"]
                t_top_p = tone_params["top_p"]
                t_eff_speed = tone_params["speed"]
                print(
                    f"[合成] 单元{idx+1}/{len(units)} tone "
                    f"[{tone_type}→{unit_emotion}]: {t_text[:30]} "
                    f"blend={tone_blend:.2f} identity-ref=shared speed={t_eff_speed:.2f}"
                )
            else:
                t_ref_audio, t_ref_text = ref_audio, ref_text
                t_temp, t_top_p, t_eff_speed = temp, top_p, effective_speed
                print(f"[合成] 单元{idx+1}/{len(units)}: {t_text[:30]}{'..' if len(t_text)>30 else ''}")

            unit_prosody = get_emotion_prosody(unit_emotion)
            if is_tone:
                tone_blend = _tone_blend_factor(t_text)
                # 能量变化同样做缓冲；保留音色，只让情绪色彩轻轻带过。
                unit_prosody["energy"] = 1.0 + (
                    float(unit_prosody.get("energy", 1.0)) - 1.0
                ) * tone_blend
            _configure_ar_early_stop(t_text)

            try:
                # 重试机制：检测音频质量，异常（白噪音/过短/全静音）则用稍高 temp 重试
                # 最多重试 1 次（避免总时间过长导致 API 超时）；仍失败则跳过该段（绝不把杂音放进最终音频）
                max_retries = 1
                audio_seg = None
                sr_seg = None
                for retry in range(max_retries + 1):
                    cur_temp = t_temp
                    if retry > 0:
                        print(f"  单元{idx+1} 第{retry}次重试（保持身份采样，切换确定性seed）")
                    apply_identity_seed(
                        target_voice or self._current_voice,
                        request_retry_index + retry,
                    )
                    # ★ GPU 加速：用 torch.inference_mode() 禁用 autograd，减少显存开销
                    with torch.inference_mode():
                        result = get_tts_wav(
                            ref_wav_path=t_ref_audio,
                            prompt_text=t_ref_text,
                            prompt_language="中文",
                            text=t_text,
                            text_language="中文",
                            how_to_cut=how_to_cut,
                            top_p=t_top_p,
                            temperature=cur_temp,
                            pause_second=pause_second,
                            speed=t_eff_speed,
                            # sample_steps=4,  # v3默认8；降到4导致CFM扩散不充分，音色保真度下降。恢复默认8保证音色
                        )
                    result_list = list(result)
                    if not result_list:
                        print(f"  单元{idx+1} 无音频返回")
                        break
                    # 合并所有段
                    chunks = []
                    sr_seg = result_list[0][0]
                    for sr_i, au_i in result_list:
                        if au_i.dtype == np.int16:
                            au_i = au_i.astype(np.float32) / 32768.0
                        elif au_i.dtype != np.float32:
                            au_i = au_i.astype(np.float32)
                        chunks.append(au_i)
                    audio_seg = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
                    # 裁剪开头/结尾的长静音
                    audio_seg = _trim_silence(audio_seg, sr_seg, max_trim=0.5, keep=0.1)
                    # 质量检测：白噪音/过短/全静音
                    is_bad, reason = _detect_audio_quality(audio_seg, sr_seg, text_len=len(t_text))
                    if is_bad:
                        print(f"  单元{idx+1} 音频异常: {reason}")
                        if retry >= max_retries and should_keep_quality_retry_audio(
                            reason, len(audio_seg), sr_seg
                        ):
                            print(f"  单元{idx+1} 最终重试保留非静音音频，避免丢失后续句子")
                            break
                        audio_seg = None
                        continue  # 触发重试
                    break  # 质量OK，结束重试

                if audio_seg is not None and sr_seg is not None:
                    # Keep emotional color in prosody without replacing the
                    # speaker reference. Local tone pitch is relative to the
                    # main emotion because the final global pitch is applied later.
                    main_pitch = get_emotion_prosody(emotion)["pitchSemitones"]
                    local_pitch_delta = unit_prosody["pitchSemitones"] - main_pitch if is_tone else 0.0
                    if abs(local_pitch_delta) > 0.01:
                        try:
                            import librosa
                            audio_seg = librosa.effects.pitch_shift(
                                audio_seg.astype(np.float32), sr=sr_seg, n_steps=local_pitch_delta
                            )
                        except Exception as pitch_error:
                            print(f"  [局部音调] 跳过: {pitch_error}")
                    audio_seg = np.clip(
                        audio_seg * float(unit_prosody["energy"]), -1.0, 1.0
                    ).astype(np.float32)
                    # 语气词结尾处理：柔和度 > 0 时自动加强尾音柔化（合并原 ending_offset）
                    audio_seg = _apply_ending_treatment(audio_seg, sr_seg, t_text, is_tone=is_tone, tone_type=tone_type, ending_offset=soft_offset)
                    # tone 段：额外裁掉开头低幅值噪声（h 辅音摩擦音等）+ 更长淡入
                    # 普通段：8ms 淡入淡出
                    if is_tone:
                        audio_seg = _trim_head_noise(audio_seg, sr_seg, threshold=0.02, max_trim_s=0.15)
                        # tone 段：保留 120ms 段间静音做停顿，禁用 crossfade（静音后再 crossfade 无意义）
                        _append_audio_piece(all_audio, audio_seg, sr_seg, fade_ms=12, silence_s=0.0, crossfade_ms=15)
                    else:
                        # 普通段：50ms crossfade 掩盖拼接处音高跳变，无段间静音（保持连贯）
                        _append_audio_piece(all_audio, audio_seg, sr_seg, fade_ms=8, silence_s=0.0, crossfade_ms=50)
                    sr_out = sr_seg
                else:
                    print(f"  单元{idx+1} 重试{max_retries}次仍异常，跳过该段（不放入杂音）")
            except Exception as e:
                print(f"  单元{idx+1} 合成失败: {e}")
                import traceback
                traceback.print_exc()

            # 段间插入静音（按结尾标点决定时长）——最后一段不插
            # tone 段后用短停顿（0.2s），普通段用原句末停顿
            if idx < len(units) - 1 and sr_out:
                if has_tone_tags:
                    # 关键词强调只留自然的轻停顿，避免独立合成单元产生“逐词朗读”感。
                    gap = 0.10 if is_tone else 0.08
                else:
                    gap = SENTENCE_PAUSE.get(end_punct, DEFAULT_PAUSE) * pause_multiplier
                silence = np.zeros(int(sr_out * gap), dtype=np.float32)
                all_audio.append(silence)
                print(f"  [停顿] +{gap:.2f}s 静音 (标点='{end_punct}' {'tone' if is_tone else 'normal'})")

        # 6.5 保底合成：所有段都被质量检测跳过导致 all_audio 为空时，
        # 对最后一段用高 temp 保底合成（拟声词/感叹词本来就短，跳过过短检测，只拒绝全静音/白噪音）
        # 场景："菲比丘比，诶？" / "哼！真是的..." 这类短文本单段失败后整句无音频→API 500
        if not all_audio and units:
            last_text = units[-1][0] if units[-1] else paused_text
            last_text = last_text.strip()
            if last_text:
                print(f"[保底] 所有段失败，对最后一段保底合成: {last_text[:30]}")
                try:
                    apply_identity_seed(
                        target_voice or self._current_voice,
                        request_retry_index + max_retries + 1,
                    )
                    _configure_ar_early_stop(last_text)
                    with torch.inference_mode():
                        result = get_tts_wav(
                            ref_wav_path=ref_audio,
                            prompt_text=ref_text,
                            prompt_language="中文",
                            text=last_text,
                            text_language="中文",
                            how_to_cut=how_to_cut,
                            top_p=top_p,
                            temperature=temp,
                            pause_second=pause_second,
                            speed=effective_speed,
                            # sample_steps=4,  # 与主路径保持一致，恢复默认8保证音色
                        )
                    result_list = list(result)
                    if result_list:
                        chunks = []
                        sr_fallback = result_list[0][0]
                        for sr_i, au_i in result_list:
                            if au_i.dtype == np.int16:
                                au_i = au_i.astype(np.float32) / 32768.0
                            elif au_i.dtype != np.float32:
                                au_i = au_i.astype(np.float32)
                            chunks.append(au_i)
                        audio_fallback = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
                        audio_fallback = _trim_silence(audio_fallback, sr_fallback, max_trim=0.5, keep=0.1)
                        # 保底只拒绝全静音/白噪音（接受过短——拟声词/感叹词正常就短）
                        is_bad, reason = _detect_audio_quality(audio_fallback, sr_fallback, text_len=len(last_text))
                        if "全静音" in reason or "白噪音" in reason:
                            print(f"[保底] 仍失败: {reason}")
                        else:
                            print(f"[保底] 成功: {len(audio_fallback)/sr_fallback:.1f}s ({reason})")
                            audio_fallback = _apply_ending_treatment(audio_fallback, sr_fallback, last_text, ending_offset=soft_offset)
                            _append_audio_piece(all_audio, audio_fallback, sr_fallback, fade_ms=8, silence_s=0.0)
                            sr_out = sr_fallback
                except Exception as e:
                    print(f"[保底] 异常: {e}")

        # 7. 拼接输出
        if all_audio and sr_out:
            # 打印 profiling 汇总（测量 AR/CFM/BigVGAN 三段耗时）
            if os.environ.get("TTS_ENABLE_PROFILING", "0") == "1":
                try:
                    from profiling_probe import print_summary, reset_timings
                    print_summary()
                    reset_timings()
                except Exception:
                    pass
            combined = np.concatenate(all_audio)

            # 用户微调：全局音调偏移（半音，正值变高，负值变低）
            # 用 librosa 相位重构算法后处理（不改变语速，只改变基频）
            pitch_offset = get_emotion_prosody(emotion)["pitchSemitones"]
            if override_params and "pitch_offset" in override_params:
                try:
                    pitch_offset += float(override_params["pitch_offset"])
                except (TypeError, ValueError):
                    pass
            pitch_offset = sanitize_runtime_params(emotion, {"pitch_offset": pitch_offset})["pitch_offset"]
            if abs(pitch_offset) > 0.01:
                try:
                    import librosa
                    print(f"[音调] pitch_offset={pitch_offset:.2f} 半音，应用 librosa.effects.pitch_shift")
                    combined = librosa.effects.pitch_shift(
                        combined.astype(np.float32), sr=sr_out, n_steps=pitch_offset
                    )
                    print(f"[音调] 完成，时长保持 {len(combined)/sr_out:.1f}s")
                except Exception as e:
                    print(f"[音调] pitch_shift 失败: {e}，跳过音调偏移")

            # Timbre-preserving softness: mild gain/dynamics only. The former
            # aggressive low-pass changed the spectral envelope and sounded
            # like a different speaker.
            if soft_offset != 0.0:
                try:
                    soft_vol = max(0.92, min(1.08, 1.0 - soft_offset * 0.12))
                    combined = (combined * soft_vol).astype(np.float32)
                    compress_factor = 0.0
                    if soft_offset > 0:
                        compress_factor = min(0.08, soft_offset * 0.2)
                        combined = combined - compress_factor * (combined - np.tanh(combined))
                    if soft_offset > 0:
                        tail_s = min(0.3, 0.16 + soft_offset * 0.1)
                        tail_samples = int(sr_out * tail_s)
                        if tail_samples > 10 and len(combined) > tail_samples * 2:
                            tail_target = max(0.88, 0.96 - soft_offset * 0.12)
                            tail_curve = np.linspace(1.0, tail_target, tail_samples)
                            combined[-tail_samples:] *= tail_curve
                    combined = np.clip(combined, -1.0, 1.0).astype(combined.dtype)
                    print(
                        f"[柔和度] soft_offset={soft_offset:+.2f} → "
                        f"音量×{soft_vol:.2f} + 轻压缩{compress_factor:.2f} + 轻尾音（无低通）"
                    )
                except Exception as e:
                    print(f"[柔和度] 处理失败: {e}，跳过")

            # 用户微调：整体音量偏移（正值更响，负值更轻）
            if volume_offset != 0.0:
                vol_gain = max(0.3, min(2.0, 1.0 + volume_offset))
                combined = (combined * vol_gain).astype(combined.dtype)
                # 防止削波（clip 到 [-1, 1]）
                combined = np.clip(combined, -1.0, 1.0)
                print(f"[音量] 应用增益 ×{vol_gain:.2f}，已防削波")

            # 整段开头加淡入（默认 15ms，用户可调），消除 GPT-SoVITS 首样本瞬态噪音
            head_fade = int(sr_out * fadein_s)
            if head_fade > 0 and len(combined) > head_fade:
                combined[:head_fade] *= np.linspace(0, 1, head_fade, dtype=combined.dtype)
            if output_path is None:
                import time
                output_path = os.path.join(GPT_SOVITS_ROOT, "test_output_smart",
                                          f"selina_{emotion}_{int(time.time())}.wav")
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            sf.write(output_path, combined, sr_out, subtype="PCM_16")
            print(f"[输出] {output_path} ({len(combined)/sr_out:.1f}s)")

            # 8. 记录生成日志
            _log_generation(
                raw_text=original_text,
                spoken_text=text,
                emotion=emotion,
                intensity=intensity,
                pause_text=paused_text,
                ref_audio=ref_audio,
                temperature=temp,
                top_p=top_p,
                speed=speed,
                output=output_path,
            )

            # Keep the CUDA allocator warm between requests. Emptying it after
            # every reply forces the next synthesis to rebuild large buffers.
            _release_cuda_cache_under_pressure()

            return output_path
        return None


# ============================================================
# 测试
# ============================================================
if __name__ == "__main__":
    tts = SelinaTTS(use_core=True)

    test_cases = [
        # 安慰/坚定陪伴
        ("别怕，我在这里陪着你", "comfort"),
        ("你还好吗？不要太勉强自己", "comfort"),
        ("别担心，一切都会好起来的", None),
        ("我来保护你", None),
        # 伤心后轻声问
        ("我很难过……你还会回来吗？", None),
        ("好伤心，你还好吗？", None),
        ("失去的东西……还能找回来吗？", None),
        # 温柔关切地问
        ("你今天过得怎么样？", None),
        ("在想什么呢？", None),
        ("是不是很累？", None),
        # 温柔/日常
        ("指挥官，今天也要一起努力哦", "gentle"),
        ("嗯，我知道了", None),
        ("今天的任务已经完成了", "gentle"),
        # 刚强/坚定
        ("我一定会守护你的", None),
        ("这是我的约定，绝对不会改变", None),
        # 激动/警觉
        ("快跑！这里很危险！", "excited"),
        # 悲伤/隐忍
        ("再见了，指挥官", "sad"),
        ("我……会一直陪在你身边的", "comfort"),
    ]

    output_dir = os.path.join(GPT_SOVITS_ROOT, "test_output_smart_v2")
    os.makedirs(output_dir, exist_ok=True)

    for i, (text, emotion) in enumerate(test_cases):
        print(f"\n{'='*50}")
        print(f"测试 {i+1}: {text} (指定情感: {emotion or '自动'})")
        if emotion is None:
            detected, intensity = classify_emotion(text)
        else:
            detected = emotion
            intensity = EMOTION_RULES.get(detected, EMOTION_RULES["gentle"]).get("intensity", "medium")
        rule = EMOTION_RULES.get(detected, EMOTION_RULES["gentle"])
        print(f"  → 情感: {rule['desc']} | intensity={intensity} | 排版: {rule['pause_style']} | t={rule['temperature']} p={rule['top_p']} speed={rule.get('speed', 1.0)}")
        paused = add_pauses(text, rule["pause_style"])
        print(f"  → 排版后: {paused}")
        output_path = os.path.join(output_dir, f"v2_{i:02d}_{detected}.wav")
        tts.synthesize(text, emotion=emotion, output_path=output_path)

    print(f"\n全部完成！输出: {output_dir}")
