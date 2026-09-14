#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
语音克隆训练流水线 v2
=====================
设计原则：
  1. 单文件，所有逻辑自包含，不跨文件 import 项目脚本
  2. 所有路径用绝对路径，从命令行参数传入
  3. 每步独立函数，try/except 包裹，emit JSON 进度到 stdout（兼容 SSE）
  4. 数据准备阶段（Step 0-4）：纯进程内 import（demucs/whisper/torchaudio）
  5. GPT-SoVITS 预处理（Step 5）：runpy.run_path() 进程内执行
  6. GPT-SoVITS 训练（Step 6）：subprocess，但封装可靠 executor（自动 cwd/PYTHONPATH）
  7. stderr 不当错误（jieba/torch/tqdm 都写 stderr），只有非零退出码才是错误
  8. 智能跳过：检测每步输出是否已存在，已完成则跳过

用法:
  python train_pipeline_v2.py --voice-name 秧秧 \
      --input "<用户选择的视频文件>" \
      --project-root "<当前应用数据目录>"

输入支持：
  - 视频文件 (.mp4/.mkv/.mov/.avi)
  - 音频文件 (.wav/.mp3/.m4a/.flac)
  - 已切片目录（含 metadata.json + seg_*.wav）
  - 纯人声文件（文件名含 _vocal/vocals/人声）
"""
import argparse
import json
import os
# provenance: wha9917/private-optimizations — clone-training path marker; inert.
import sys
import time
import shutil
import subprocess
import runpy
import traceback
import types
import importlib.machinery
from pathlib import Path

# 全局临时文件清理列表：训练成功后由 cleanup 函数统一删除
# - step0 多文件合并产物 _vt_merged_*.wav
# - work_dir 下的中间目录（01_extracted / 02_separated / 03_segments）
_TMP_FILES_TO_CLEANUP = []
_TMP_DIRS_TO_CLEANUP = []

# 训练阶段顺序（用于断点续传）
TRAIN_STAGES = [
    "init", "extract", "separate", "segment",
    "dataset", "gpt_prepare", "preprocess",
    "train", "refs", "deploy", "all"
]

# 全局状态文件路径（在 main 中设置）
_STATE_FILE = None
_RESUME = False
_COMPLETED_STAGES = set()


def save_state(work_dir, stage, status, **extra):
    """保存训练状态到 work_dir/state.json（用于断点续传）"""
    global _STATE_FILE
    if not work_dir:
        return
    if not _STATE_FILE:
        _STATE_FILE = os.path.join(work_dir, "state.json")
    try:
        state = {}
        if os.path.exists(_STATE_FILE):
            with open(_STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
        state["stage"] = stage
        state["status"] = status
        state["timestamp"] = time.time()
        state["work_dir"] = work_dir
        if status == "done" and stage in TRAIN_STAGES:
            _COMPLETED_STAGES.add(stage)
            state["completed_stages"] = list(_COMPLETED_STAGES)
        for k, v in extra.items():
            if v is not None:
                state[k] = v
        with open(_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def load_state(work_dir):
    """从 work_dir/state.json 读取训练状态"""
    if not work_dir:
        return None
    state_file = os.path.join(work_dir, "state.json")
    try:
        if os.path.exists(state_file):
            with open(state_file, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def is_stage_done(stage):
    """检查阶段是否已完成（用于断点续传跳过）"""
    return stage in _COMPLETED_STAGES


# ============================================================
# Fake librosa 注入（避免 numba/torch 死锁）
# ============================================================
# GPT-SoVITS 的 1B(2-get-hubert-wav32k.py) 和 1C(3-get-semantic.py) 会
# import librosa，而 librosa 依赖 numba JIT。numba 的 LLVM 线程与 PyTorch
# 线程在 Windows 上会死锁（进程卡住、RAM 极低、CPU 空）。
# 解决：在运行任何 GPT-SoVITS 脚本前，用 soundfile+scipy 构造假 librosa
# 注入 sys.modules，完全绕开 numba。
def _inject_fake_librosa():
    """注入假 librosa 模块树（resample/load/util/filters），绕开 numba 死锁"""
    # 禁用 numba JIT 缓存 & 限制线程
    os.environ.setdefault("NUMBA_DISABLE_CACHE", "1")
    os.environ.setdefault("NUMBA_NUM_THREADS", "1")
    # 不设置 NUMBA_THREADING_LAYER：'sync' 是无效值会报错，用 numba 默认值即可

    # 注意：不预加载 torch。预加载 torch 会改变 DLL 加载顺序，导致与
    # transformers (BERT) 的 DLL 冲突 → ACCESS_VIOLATION 崩溃。
    # fake librosa 完全替换 librosa，numba 永远不会被导入，无需抢占线程。
    import numpy as np
    import scipy.signal
    import soundfile as sf

    def _patched_resample(y, orig_sr, target_sr):
        # 兼容 torch tensor 输入（1B 脚本传入 torch.FloatTensor）
        # 原版 librosa 会自动转换，scipy.signal.resample_poly 不支持 torch tensor
        if hasattr(y, "numpy"):
            y = y.numpy()
        elif hasattr(y, "detach") and hasattr(y, "cpu"):
            y = y.detach().cpu().numpy()
        return scipy.signal.resample_poly(y, target_sr, orig_sr)

    def _fake_load(path, sr=22050, mono=True, offset=0.0, duration=None, dtype=np.float32):
        info = sf.info(path)
        orig_sr = info.samplerate
        start = int(offset * orig_sr) if offset else 0
        frames = int(duration * orig_sr) if duration is not None else -1
        y, sr_orig = sf.read(path, start=start, frames=frames, dtype="float32")
        # soundfile 返回 [samples, channels]，librosa 返回 [channels, samples]
        if mono:
            if len(y.shape) > 1:
                y = y.mean(axis=1)
        else:
            if len(y.shape) > 1:
                y = y.T  # [samples, channels] → [channels, samples]（与真实 librosa 一致）
        if sr is not None and sr != sr_orig:
            y = scipy.signal.resample_poly(y, sr, sr_orig)
        return y, sr

    def _fake_get_duration(y=None, sr=22050):
        return len(y) / sr if y is not None else 0.0

    def _fake_normalize(S, norm=np.inf, axis=0, threshold=None, fill=None):
        if threshold is None:
            threshold = 1e-10
        mag = np.abs(S).astype(float)
        scale = np.max(mag, axis=axis, keepdims=True)
        scale[scale < threshold] = 1.0
        return S / scale

    def _fake_pad_center(data, size, axis=-1):
        n = data.shape[axis]
        if n > size:
            raise ValueError(f"Target size ({size}) smaller than input ({n})")
        if n == size:
            return data
        left = (size - n) // 2
        right = size - n - left
        pad_width = [(0, 0)] * data.ndim
        pad_width[axis] = (left, right)
        return np.pad(data, pad_width, mode="constant")

    def _fake_tiny(x):
        if not np.issubdtype(np.asarray(x).dtype, np.floating):
            x = np.float32(x)
        return np.finfo(x.dtype).tiny

    def _fake_mel(sr, n_fft, n_mels=128, fmin=0.0, fmax=None, htk=False,
                  norm="slaney", dtype=np.float32):
        if fmax is None:
            fmax = float(sr) / 2
        fft_freqs = np.linspace(fmin, fmax, n_mels + 2)
        weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=dtype)
        fftfreqs = np.linspace(0, float(sr) / 2, 1 + n_fft // 2)
        fdiff = np.diff(fft_freqs)
        ramps = fft_freqs[:, np.newaxis] - fftfreqs
        for i in range(n_mels):
            lower = -ramps[i] / fdiff[i]
            upper = ramps[i + 2] / fdiff[i + 1]
            weights[i] = np.maximum(0, np.minimum(lower, upper))
        if norm == "slaney":
            enorm = 2.0 / (fft_freqs[2:n_mels + 2] - fft_freqs[:n_mels])
            weights *= enorm[:, np.newaxis]
        return weights

    # 构建 fake librosa 模块树
    _fl = types.ModuleType("librosa")
    _fl.__spec__ = importlib.machinery.ModuleSpec("librosa", loader=None, is_package=True)
    _fl.__path__ = []
    _fl.__file__ = "<fake_librosa>"
    _fl.resample = _patched_resample
    _fl.load = _fake_load
    _fl.get_duration = _fake_get_duration

    _fu = types.ModuleType("librosa.util")
    _fu.__spec__ = importlib.machinery.ModuleSpec("librosa.util", loader=None, is_package=True)
    _fu.__path__ = []
    _fu.normalize = _fake_normalize
    _fu.pad_center = _fake_pad_center
    _fu.tiny = _fake_tiny
    _fl.util = _fu

    _ff = types.ModuleType("librosa.filters")
    _ff.__spec__ = importlib.machinery.ModuleSpec("librosa.filters", loader=None, is_package=True)
    _ff.__path__ = []
    _ff.mel = _fake_mel
    _fl.filters = _ff

    # 注入到 sys.modules（必须在使用前完成）
    sys.modules["librosa"] = _fl
    sys.modules["librosa.util"] = _fu
    sys.modules["librosa.filters"] = _ff


# 注意：不在模块级调用 _inject_fake_librosa()。
# 模块级导入 scipy/soundfile 会改变 DLL 加载顺序，导致 1A (transformers BERT)
# 的 ACCESS_VIOLATION 崩溃。改为在 1A 完成后、1B 开始前调用。


# ============================================================
# 进度输出（JSON 行，stdout，供 Node.js SSE 捕获）
# ============================================================
def emit(stage, status, msg="", progress=0, **extra):
    """输出一行 JSON 进度。status: start/running/done/error"""
    line = json.dumps({
        "stage": stage,
        "status": status,
        "msg": msg,
        "progress": progress,
        "ts": time.time(),
        **extra,
    }, ensure_ascii=False)
    print(line, flush=True)


# ============================================================
# 路径检测
# ============================================================
def detect_gpt_sovits_root(explicit=None):
    """检测 GPT-SoVITS 安装目录"""
    if explicit and os.path.isdir(explicit):
        return os.path.abspath(explicit)
    env = os.environ.get("GPT_SOVITS_ROOT", "")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    app_root = os.path.abspath(os.environ.get("APP_ROOT") or os.path.join(os.path.dirname(__file__), ".."))
    bundled = os.path.join(app_root, "GPT-SoVITS-lite")
    if os.path.isdir(bundled):
        return bundled
    return None


def find_ffmpeg(gpt_root=None):
    """查找 ffmpeg.exe
    只使用 Python 运行时自带的 imageio_ffmpeg 或 ChatX2 包内
    GPT-SoVITS-lite/ffmpeg.exe，不回退到宿主机 PATH，保证发布包可独立运行。
    """
    # 1. imageio_ffmpeg Python 包（自带新版 ffmpeg 二进制，支持 concat filter）
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    # ChatX2 包内 GPT-SoVITS 自带的 ffmpeg 作为稳定兜底。
    if gpt_root:
        p = os.path.join(gpt_root, "ffmpeg.exe")
        if os.path.isfile(p):
            return p
    return None


# ============================================================
# Step 0: 输入识别
# ============================================================
def step0_detect_input(input_path):
    """
    识别输入类型，返回 dict:
      type: video / audio / presliced / vocal_audio
      path: 输入路径
      metadata: presliced 模式下的 metadata.json 路径
    """
    emit("input", "start", f"识别输入: {input_path}", 2)
    input_path = os.path.abspath(input_path)

    if os.path.isdir(input_path):
        # 目录：检查是否已切片（含 metadata.json + seg_*.wav）
        meta = os.path.join(input_path, "metadata.json")
        segs = [f for f in os.listdir(input_path) if f.startswith("seg_") and f.endswith(".wav")]
        if os.path.isfile(meta) and len(segs) > 0:
            emit("input", "done", f"已切片目录（{len(segs)} 段 + metadata.json），跳过提取/分离/切片",
                 10, input_type="presliced", metadata=meta, segments_count=len(segs))
            return {"type": "presliced", "path": input_path, "metadata": meta}
        # 目录但不是切片：找里面的音频/视频文件
        files = sorted([os.path.join(input_path, f) for f in os.listdir(input_path)
                 if f.lower().endswith((".mp4", ".mkv", ".mov", ".avi",
                                        ".wav", ".mp3", ".m4a", ".flac"))])
        if not files:
            raise RuntimeError(f"目录中没有视频/音频文件: {input_path}")
        if len(files) == 1:
            input_path = files[0]
            emit("input", "running", f"目录中找到文件: {os.path.basename(input_path)}", 3)
        else:
            # 多文件：用 ffmpeg 合并为一个 wav，确保所有素材都用于训练
            # 先把每个文件归一化为 16kHz mono，再 concat
            # 合并文件写到工作目录的 _tmp 子目录，方便成功后统一清理
            emit("input", "running", f"目录中找到 {len(files)} 个文件，合并为单一音频...", 3)
            _ff = find_ffmpeg(os.environ.get("GPT_SOVITS_ROOT"))
            if not _ff:
                # 没有 ffmpeg 无法合并，直接报错（不再静默降级到第一个文件，
                # 那会导致只训练第一个素材，用户不知情）
                raise RuntimeError(
                    f"目录中有 {len(files)} 个文件但未找到 ffmpeg，无法合并。"
                    f"请安装 ffmpeg 或只上传单个文件。"
                )
            try:
                # 构建 filter_complex：每个输入先 aformat 归一化，再 concat
                # 合并文件写到系统临时目录，避免输入目录只读或中文路径问题
                # 记录到全局 _TMP_FILES_TO_CLEANUP，训练成功后统一清理
                import tempfile as _tempfile
                merged_wav = os.path.join(_tempfile.gettempdir(), f"_vt_merged_{int(time.time())}.wav")

                filter_parts = []
                labels = []
                for i in range(len(files)):
                    filter_parts.append(
                        f"[{i}:a]aformat=sample_rates=16000:channel_layouts=mono[a{i}]"
                    )
                    labels.append(f"[a{i}]")
                concat_filter = "".join(labels) + f"concat=n={len(files)}:v=0:a=1[a]"
                filter_complex = ";".join(filter_parts) + ";" + concat_filter

                inputs = []
                for f in files:
                    inputs.extend(["-i", f])
                cmd = [_ff, "-y"] + inputs + [
                    "-filter_complex", filter_complex,
                    "-map", "[a]",
                    "-acodec", "pcm_s16le",
                    "-ar", "16000",
                    "-ac", "1",
                    "-loglevel", "error",
                    merged_wav,
                ]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
                if r.returncode != 0 or not os.path.isfile(merged_wav):
                    # 合并失败：直接抛错（不再静默降级到第一个文件，
                    # 那会导致只训练第一个素材，用户不知情）
                    err_msg = (r.stderr or "concat filter 执行失败").strip()[-300:]
                    raise RuntimeError(f"多文件合并失败: {err_msg}")
                input_path = merged_wav
                _TMP_FILES_TO_CLEANUP.append(merged_wav)
                emit("input", "running", f"合并完成: {len(files)} 个文件 → {os.path.basename(merged_wav)}", 4)
            except RuntimeError:
                raise
            except Exception as e:
                # 其它异常也直接报错（不再静默降级）
                raise RuntimeError(f"多文件合并异常: {str(e)[:200]}")

    ext = os.path.splitext(input_path)[1].lower()

    # 用户要求：不管什么文件都走人声分离，不再因文件名含 vocal 关键词跳过
    if ext in (".mp4", ".mkv", ".mov", ".avi"):
        result = {"type": "video", "path": input_path}
        emit("input", "done", f"视频文件，需提取音频", 5, input_type="video")
    elif ext in (".wav", ".mp3", ".m4a", ".flac"):
        result = {"type": "audio", "path": input_path}
        emit("input", "done", f"音频文件，需人声分离", 5, input_type="audio")
    else:
        raise RuntimeError(f"不支持的文件格式: {ext}")

    return result


# ============================================================
# Step 1: 音频提取（视频 → WAV）
# ============================================================
def step1_extract_audio(input_info, work_dir, ffmpeg):
    """从视频提取音频为 44.1kHz 立体声 WAV"""
    if input_info["type"] == "presliced":
        # presliced 模式：不需要提取音频，step3 直接从 metadata.json 读取切片
        emit("separate", "done", "已切片目录，跳过音频提取", 10)
        return []
    if input_info["type"] == "audio":
        # 音频文件：复制到 01_extracted/input_0.wav，待 step2 走 BS-Roformer 分离
        src = input_info["path"]
        out_dir = os.path.join(work_dir, "01_extracted")
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, "input_0.wav")
        shutil.copy2(src, dst)
        emit("separate", "done", f"音频文件已就绪，待人声分离", 10, extracted_audio=dst)
        return [dst]

    emit("separate", "start", "从视频提取音频...", 5)
    video_path = input_info["path"]
    out_dir = os.path.join(work_dir, "01_extracted")
    os.makedirs(out_dir, exist_ok=True)
    out_wav = os.path.join(out_dir, "audio_44100.wav")

    # ffmpeg 提取音频
    cmd = [
        ffmpeg, "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "44100", "-ac", "2",
        out_wav
    ]
    emit("separate", "running", f"ffmpeg 提取音频中: {os.path.basename(video_path)}", 8)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 提取失败: {result.stderr[-500:]}")
    if not os.path.isfile(out_wav) or os.path.getsize(out_wav) < 1000:
        raise RuntimeError(f"ffmpeg 输出文件无效: {out_wav}")

    emit("separate", "done", f"音频提取完成: {out_wav}", 10, extracted_audio=out_wav)
    # 返回音频文件列表，供 step2 使用
    return [out_wav]


# ============================================================
# Step 2: 人声分离（Demucs 进程内 import）
# ============================================================
def step2_separate_vocals(audio_files, work_dir, input_info, device_pref="auto"):
    """
    人声分离：
    - 已切片目录：跳过（不需要分离）
    - 所有音频/视频提取的音频：统一用 BS-Roformer 分离（不再因文件名含 vocal 跳过）
    """
    if input_info["type"] == "presliced":
        emit("separate", "done", "已切片目录，跳过人声分离", 20)
        return []

    out_dir = os.path.join(work_dir, "02_separated")
    os.makedirs(out_dir, exist_ok=True)
    all_vocals = []

    for i, af in enumerate(audio_files):
        # 所有文件统一走 BS-Roformer 人声分离（用户要求：不跳过任何文件）
        emit("separate", "running",
             f"UVR5 BS-Roformer 分离中: {os.path.basename(af)} ({i+1}/{len(audio_files)})",
             10 + int(5 * (i + 1) / len(audio_files)))
        dst = os.path.join(out_dir, f"vocals_{i}.wav")
        _uvr5_separate(af, dst, i, len(audio_files), device_pref)
        all_vocals.append(dst)

    emit("separate", "done", f"人声分离完成，得到 {len(all_vocals)} 个人声文件", 20,
         vocals=all_vocals)
    return all_vocals


def _uvr5_separate(input_wav, output_vocal, idx, total, device_pref="auto"):
    """用 UVR5 BS-Roformer 模型分离人声（GPT-SoVITS 自带，效果优于 Demucs）
    模型：model_bs_roformer_ep_317_sdr_12.9755.ckpt（SOTA 人声分离）
    可选：onnx_dereverb_By_FoxJoy 去混响（提升训练质量）
    优化：长音频自动分段处理，避免一次性加载导致 OOM
    device_pref: auto(优先GPU) / gpu / cpu
    """
    import torch
    import numpy as np
    import soundfile as sf
    import gc
    import os
    import sys
    import tempfile

    # 注入 fake librosa 绕开 numba 死锁（bsroformer.py 模块级 import librosa）
    # 必须在 import bsroformer 之前完成注入
    _inject_fake_librosa()

    # 添加 GPT-SoVITS tools/uvr5 到 sys.path（含 bsroformer.py / vr.py / mdxnet.py）
    gpt_root = os.environ.get("GPT_SOVITS_ROOT", "")
    if not gpt_root:
        gpt_root = detect_gpt_sovits_root()
    uvr5_dir = os.path.join(gpt_root, "tools", "uvr5")
    if uvr5_dir not in sys.path:
        sys.path.insert(0, uvr5_dir)

    from bsroformer import Roformer_Loader

    # 释放可能残留的内存
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # 根据 device_pref 选择处理器
    if device_pref == "cpu":
        device = "cpu"
        is_half = False
    elif device_pref == "gpu":
        if not torch.cuda.is_available():
            emit("separate", "running", "  警告：GPU 不可用，回退到 CPU", 11)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        is_half = torch.cuda.is_available()
    else:  # auto
        device = "cuda" if torch.cuda.is_available() else "cpu"
        is_half = torch.cuda.is_available()
    emit("separate", "running", f"  使用设备: {device} ({'半精度' if is_half else '全精度'})", 11)  # GPU 用半精度加速，CPU 用全精度

    # BS-Roformer 模型路径
    model_path = os.path.join(uvr5_dir, "uvr5_weights", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    if not os.path.isfile(model_path):
        raise RuntimeError(f"BS-Roformer 模型不存在: {model_path}")

    emit("separate", "running",
         f"  加载 BS-Roformer 模型 (文件 {idx+1}/{total})...", 10)

    # 加载模型（Roformer_Loader 自动处理配置和权重）
    loader = Roformer_Loader(
        model_path=model_path,
        config_path="",  # 空字符串触发默认配置（bs_roformer 内置）
        device=device,
        is_half=is_half,
    )

    # 检查音频时长，长音频分段处理避免 OOM
    info = sf.info(input_wav)
    duration_sec = info.frames / info.samplerate

    # 显存自适应分段大小：BS-Roformer 在 3.5G 卡上处理 15 分钟段会 OOM
    # 经验值：1 分钟 44.1kHz 立体声 BS-Roformer 推理约需 200-300 MiB 峰值显存
    try:
        import subprocess as _sp_vm
        r_vm = _sp_vm.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if r_vm.returncode == 0 and device == "cuda":
            free_mb = int(r_vm.stdout.strip().split('\n')[0].strip())
            emit("separate", "running", f"  [GPU] 可用显存: {free_mb} MiB", 11)
            if free_mb < 4000:
                MAX_CHUNK_MIN = 5    # 3.5G 卡：每段不超过 5 分钟
            elif free_mb < 6000:
                MAX_CHUNK_MIN = 10   # 6G 卡：每段不超过 10 分钟
            else:
                MAX_CHUNK_MIN = 20   # 8G+ 卡：20 分钟段
            emit("separate", "running",
                 f"  [GPU] 自适应分段：每段 ≤ {MAX_CHUNK_MIN} 分钟", 11)
        else:
            MAX_CHUNK_MIN = 20
    except Exception:
        MAX_CHUNK_MIN = 20

    # 段间重叠（秒）：避免接缝处可听断点，拼接时用线性交叉淡化
    OVERLAP_SEC = 1.5

    if duration_sec <= MAX_CHUNK_MIN * 60:
        # 短音频：直接处理（带 OOM 回退）
        _uvr5_process_single_with_oom_retry(
            loader, input_wav, output_vocal, idx, total,
            model_path, device_pref, device, is_half
        )
    else:
        # 长音频：用 ffmpeg 按时间分段（带重叠），逐段处理，最后交叉淡化拼接
        emit("separate", "running",
             f"  音频较长 ({duration_sec/60:.1f} 分钟)，分段处理 (文件 {idx+1}/{total})",
             11)

        # 计算分段：每段 MAX_CHUNK_MIN 分钟，相邻段重叠 OVERLAP_SEC
        chunk_dur = MAX_CHUNK_MIN * 60
        # 实际步长 = 段长 - 重叠
        step_sec = max(chunk_dur - OVERLAP_SEC, 60)
        num_chunks = max(1, int(np.ceil((duration_sec - OVERLAP_SEC) / step_sec)))

        tmp_dir = tempfile.mkdtemp(prefix="_uvr5_chunk_")
        chunk_vocals = []   # [(vocal_path, start_sec, dur_sec)]
        ff = find_ffmpeg(gpt_root)

        for ci in range(num_chunks):
            start_sec = ci * step_sec
            if start_sec >= duration_sec:
                break
            dur = min(chunk_dur, duration_sec - start_sec)
            chunk_wav = os.path.join(tmp_dir, f"chunk_{ci}.wav")
            chunk_vocal = os.path.join(tmp_dir, f"vocal_{ci}.wav")

            # ffmpeg 切分（-ss 在 -i 前是 fast seek，足够精确）
            cmd = [ff, "-y", "-ss", str(start_sec), "-t", str(dur),
                   "-i", input_wav, "-acodec", "pcm_s16le",
                   "-ar", "44100", "-ac", "2", "-loglevel", "error", chunk_wav]
            import subprocess as _sp
            r = _sp.run(cmd, capture_output=True, text=True, timeout=300)
            if r.returncode != 0 or not os.path.isfile(chunk_wav):
                raise RuntimeError(f"音频分段 {ci+1}/{num_chunks} 切分失败: {r.stderr[-200:]}")

            emit("separate", "running",
                 f"  BS-Roformer 分段 {ci+1}/{num_chunks} (文件 {idx+1}/{total}, "
                 f"{start_sec/60:.1f}~{(start_sec+dur)/60:.1f} 分钟)",
                 12 + int(6 * (ci + 1) / num_chunks))

            _uvr5_process_single_with_oom_retry(
                loader, chunk_wav, chunk_vocal, idx, total,
                model_path, device_pref, device, is_half
            )
            chunk_vocals.append((chunk_vocal, start_sec, dur))
            os.remove(chunk_wav)

            # 段间释放显存（BS-Roformer 上一批中间张量可能未释放）
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()

        # 拼接所有段（带重叠区域交叉淡化）
        import soundfile as _sf
        sr_out = 44100
        overlap_samples = int(OVERLAP_SEC * sr_out)

        if len(chunk_vocals) == 1:
            data, _ = _sf.read(chunk_vocals[0][0], dtype='float32')
            if data.ndim > 1:
                data = data.mean(axis=1)
            full_vocal = data
        else:
            full_vocal = None
            for ci, (cv, start, dur) in enumerate(chunk_vocals):
                data, _ = _sf.read(cv, dtype='float32')
                if data.ndim > 1:
                    data = data.mean(axis=1)
                if ci == 0:
                    full_vocal = data.copy()
                else:
                    # 与上一段在重叠区域做线性交叉淡化
                    # 上一段尾部 overlap_samples 样本 + 本段头部 overlap_samples 样本
                    if full_vocal is not None and len(full_vocal) >= overlap_samples and len(data) >= overlap_samples:
                        # 线性渐变权重：上一段尾部 weight 1→0，本段头部 0→1
                        fade_out = np.linspace(1.0, 0.0, overlap_samples, dtype=np.float32)
                        fade_in = np.linspace(0.0, 1.0, overlap_samples, dtype=np.float32)
                        # 混合重叠区
                        full_vocal[-overlap_samples:] = (
                            full_vocal[-overlap_samples:] * fade_out + data[:overlap_samples] * fade_in
                        )
                        # 接上本段剩余部分
                        full_vocal = np.concatenate([full_vocal, data[overlap_samples:]])
                    else:
                        # 数据太短无法重叠，直接拼接
                        full_vocal = np.concatenate([full_vocal, data])

        _sf.write(output_vocal, full_vocal, sr_out)

        # 清理临时文件
        for cv, _, _ in chunk_vocals:
            try: os.remove(cv)
            except: pass
        try: os.rmdir(tmp_dir)
        except: pass

    # 释放模型内存
    try:
        del loader.model
        del loader
    except: pass
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    emit("separate", "running",
         f"  BS-Roformer 完成 (文件 {idx+1}/{total})",
         17)


def _uvr5_process_single_with_oom_retry(loader, input_wav, output_vocal, idx, total,
                                         model_path, device_pref, device, is_half):
    """带 GPU OOM 自动 CPU 回退的单段处理
    - 先用传入的 loader（GPU）处理
    - 若 CUDA OOM 且 device_pref != 'cpu'，重新加载 CPU 模型重试该段
    - CPU 模型处理完后释放，避免后续段累积显存
    """
    try:
        _uvr5_process_single(loader, input_wav, output_vocal, idx, total)
    except RuntimeError as e:
        err_msg = str(e).lower()
        is_oom = ("out of memory" in err_msg
                  or "cuda error" in err_msg
                  or "0xc0000409" in err_msg
                  or "stack_buffer_overrun" in err_msg)
        if not is_oom or device_pref == "cpu" or device != "cuda":
            raise  # 非 OOM 或本就是 CPU，直接抛出

        emit("separate", "running",
             f"  ⚠ GPU OOM，切换 CPU 重试该段（会很慢，但能完成）...", 12)
        import torch
        import gc as _gc
        # 清空 CUDA 缓存
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        _gc.collect()

        # 重新加载 CPU 模型（is_half=False，CPU 不支持半精度）
        from bsroformer import Roformer_Loader
        cpu_loader = Roformer_Loader(
            model_path=model_path,
            config_path="",
            device="cpu",
            is_half=False,
        )
        try:
            _uvr5_process_single(cpu_loader, input_wav, output_vocal, idx, total)
            emit("separate", "running",
                 f"  ✓ CPU 回退成功，继续后续段（建议下次直接用 CPU 模式）", 12)
        finally:
            # 释放 CPU 模型（CPU 模型占内存大，不留着）
            try:
                del cpu_loader.model
                del cpu_loader
            except Exception:
                pass
            _gc.collect()


def _uvr5_process_single(loader, input_wav, output_vocal, idx, total):
    """用 Roformer_Loader 处理单个音频文件（不含去混响）
    Roformer_Loader._path_audio_ 会自动处理加载、分离、保存
    """
    import os
    # _path_audio_ 签名: (input, others_root, vocal_root, format, is_hp3=False)
    # 它会在 vocal_root 下生成 {basename}_vocals.wav
    vocal_root = os.path.dirname(output_vocal)
    others_root = os.path.join(vocal_root, "_instruments_tmp")
    os.makedirs(vocal_root, exist_ok=True)
    os.makedirs(others_root, exist_ok=True)

    loader._path_audio_(input_wav, others_root, vocal_root, "wav", is_hp3=False)

    # BS-Roformer 输出文件名: {basename}_vocals.wav
    base = os.path.splitext(os.path.basename(input_wav))[0]
    generated = os.path.join(vocal_root, f"{base}_vocals.wav")
    if not os.path.isfile(generated):
        raise RuntimeError(f"BS-Roformer 未生成输出: {generated}")

    # 重命名为期望的 output_vocal
    if os.path.abspath(generated) != os.path.abspath(output_vocal):
        import shutil
        shutil.move(generated, output_vocal)

    # 清理伴奏临时文件
    import shutil
    try: shutil.rmtree(others_root, ignore_errors=True)
    except: pass


# ============================================================
# Step 3: 切片 + ASR 标注
# ============================================================

def _force_split_by_energy(wav_path, start_sec=None, end_sec=None,
                            target_min=5.0, target_max=15.0):
    """按短时能量最低点强制切分长音频，保证每段 target_min~target_max 秒。

    用于 VAD 切不开（BS-Roformer 输出几乎无静音）的兜底场景。
    在 [cur+target_min, cur+target_max] 范围内扫描 300ms 窗口能量，
    取能量最低点作为切分边界（模拟"相对静音"处切分）。
    """
    import soundfile as sf
    import numpy as np

    audio, sr = sf.read(wav_path)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    total = len(audio) / sr
    s = start_sec if start_sec is not None else 0.0
    e = end_sec if end_sec is not None else total

    segments = []
    cur = s
    window = max(1, int(0.3 * sr))  # 300ms 能量窗口
    while cur < e:
        target_end = min(cur + target_max, e)
        # 剩余不足 target_min*1.5 → 直接收尾
        if e - cur <= target_min * 1.5:
            segments.append([cur, e])
            break
        # 在 [cur+target_min, cur+target_max] 找能量最低点
        search_start = int((cur + target_min) * sr)
        search_end = min(int((cur + target_max) * sr), len(audio))
        if search_start + window >= search_end:
            segments.append([cur, target_end])
            cur = target_end
            continue
        # 步长 = window/2，滑窗计算 RMS
        step = max(1, window // 2)
        energies = []
        for j in range(search_start, search_end - window, step):
            rms = float(np.sqrt(np.mean(audio[j:j+window].astype(np.float32)**2)))
            energies.append((j, rms))
        if not energies:
            segments.append([cur, target_end])
            cur = target_end
            continue
        min_j, _ = min(energies, key=lambda x: x[1])
        cut_sec = (min_j + window // 2) / sr
        segments.append([cur, cut_sec])
        cur = cut_sec
    return segments


def _vad_split(funasr_vad_model, wav_path):
    """用 FunASR VAD 模型独立切分，返回 [[start_sec, end_sec], ...]。
    如果 VAD 失败或只返回 1 段且过长，返回空列表（由调用方走兜底）。
    """
    res = funasr_vad_model.generate(input=wav_path)
    if not res:
        return []
    # FunASR VAD 返回: [{"value": [[start_ms, end_ms], ...]}]
    value = res[0].get("value", []) if isinstance(res[0], dict) else []
    return [[s/1000.0, e/1000.0] for s, e in value]


def _load_funasr_vad(gpt_root):
    """加载 FunASR FSMN-VAD 模型（用于独立 VAD 切分）"""
    from funasr import AutoModel
    vad_path = os.path.join(gpt_root, "tools", "asr", "models",
                            "speech_fsmn_vad_zh-cn-16k-common-pytorch")
    vad_path = vad_path if os.path.exists(vad_path) else "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
    return AutoModel(model=vad_path, model_revision="v2.0.4", disable_pbar=False)


def _load_funasr_asr(gpt_root):
    """加载 FunASR Paraformer-large ASR 模型（带 VAD+标点，用于短片段识别）"""
    from funasr import AutoModel
    models_dir = os.path.join(gpt_root, "tools", "asr", "models")
    path_asr  = os.path.join(models_dir, "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
    path_vad  = os.path.join(models_dir, "speech_fsmn_vad_zh-cn-16k-common-pytorch")
    path_punc = os.path.join(models_dir, "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")
    path_asr  = path_asr  if os.path.exists(path_asr)  else "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
    path_vad  = path_vad  if os.path.exists(path_vad)  else "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
    path_punc = path_punc if os.path.exists(path_punc) else "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"
    return AutoModel(
        model=path_asr, model_revision="v2.0.4",
        vad_model=path_vad, vad_model_revision="v2.0.4",
        punc_model=path_punc, punc_model_revision="v2.0.4",
        disable_pbar=False,
    )
def step3_segment_transcribe(vocals, work_dir, input_info, device_pref="auto"):
    """
    切片 + 标注：
    - presliced 模式：直接用 metadata.json
    - 否则：静音切片 + Whisper 标注
    device_pref: auto(优先GPU) / gpu / cpu
    """
    out_dir = os.path.join(work_dir, "03_segments")
    os.makedirs(out_dir, exist_ok=True)

    if input_info["type"] == "presliced":
        # 直接从 presliced 目录构建 manifest
        meta_path = input_info["metadata"]
        emit("segment", "start", "从 metadata.json 加载切片...", 20)
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        segments = meta.get("segments", [])
        manifest_segs = []
        skipped = 0
        for i, seg in enumerate(segments):
            audio_file = seg.get("audio_file", "")
            text = seg.get("text", "").strip()
            if not audio_file or not text:
                skipped += 1
                continue
            wav_path = os.path.join(input_info["path"], audio_file)
            if not os.path.isfile(wav_path):
                skipped += 1
                continue
            manifest_segs.append({
                "wav_path": wav_path,
                "text": text,
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "duration": seg.get("end", 0) - seg.get("start", 0),
                "emotion": seg.get("emotion", ""),
                "sentiment": seg.get("sentiment", ""),
            })
            if (i + 1) % 20 == 0:
                emit("segment", "running", f"已加载 {i+1}/{len(segments)} 个切片...",
                     20 + int(15 * (i + 1) / len(segments)))
        manifest_path = os.path.join(out_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"segments": manifest_segs}, f, ensure_ascii=False, indent=2)
        emit("segment", "done",
             f"已加载 {len(manifest_segs)} 个切片（跳过 {skipped} 个无效），跳过 Whisper",
             35, segments=len(manifest_segs), manifest=manifest_path)
        return manifest_path

    # 切片 + ASR 标注（先切片再 ASR，避免长音频整段返回 1 句）
    # 流程：VAD 切分 → 超长段强制能量切分 → 切 wav → 对每片做 ASR
    emit("segment", "start", "切片 + ASR 标注...", 20)
    import torch as _torch
    import soundfile as sf
    import numpy as np

    # 设备选择：auto 模式默认 GPU（与 BS-Roformer 一致），死锁时回退 CPU
    if device_pref == "cpu":
        asr_device = "cpu"
    elif device_pref == "gpu":
        asr_device = "cuda" if _torch.cuda.is_available() else "cpu"
        if asr_device == "cpu":
            emit("segment", "running", "  GPU 不可用，ASR 回退到 CPU", 22)
    else:  # auto - 默认用 GPU（已通过 run_patched.py 修复 numba 死锁）
        asr_device = "cuda" if _torch.cuda.is_available() else "cpu"

    gpt_root = os.environ.get("GPT_SOVITS_ROOT", "") or detect_gpt_sovits_root()

    # ========== 阶段1: 切片 ==========
    # 先用 FunASR VAD 独立切分；切不开（BS-Roformer 输出几乎无静音）则按能量最低点强制切分
    emit("segment", "running", "阶段1: 音频切片（VAD + 能量兜底）...", 22)

    # 尝试加载 FunASR VAD（独立切分用，与 ASR 模型分离）
    funasr_vad = None
    try:
        emit("segment", "running", "  加载 FunASR VAD 模型...", 22)
        funasr_vad = _load_funasr_vad(gpt_root)
        emit("segment", "running", "  FunASR VAD 加载完成", 23)
    except Exception as e:
        emit("segment", "running",
             f"  FunASR VAD 加载失败 ({type(e).__name__})，将用纯能量切分", 23)

    PAD_SEC = 0.15  # 前后各留 150ms，保留自然停顿与拖音尾巴
    all_slices = []  # [{wav_path, start, end, duration}, ...]

    for vi, vf in enumerate(vocals):
        info = sf.info(vf)
        total_dur = info.frames / info.samplerate
        emit("segment", "running",
             f"  切分 {os.path.basename(vf)} ({vi+1}/{len(vocals)}, {total_dur:.1f}s)...",
             22 + int(5 * (vi + 1) / len(vocals)))

        vad_segs = []
        if funasr_vad is not None:
            try:
                vad_segs = _vad_split(funasr_vad, vf)
            except Exception:
                vad_segs = []

        # 判断 VAD 是否有效：段数太少或单段过长 → 走能量切分
        need_force = (not vad_segs) or (
            len(vad_segs) == 1 and (vad_segs[0][1] - vad_segs[0][0]) > 30
        ) or sum(e - s for s, e in vad_segs) < total_dur * 0.3

        if need_force:
            emit("segment", "running",
                 f"  VAD 切不开（{len(vad_segs)} 段），按能量最低点强制切分...",
                 23 + int(3 * (vi + 1) / len(vocals)))
            # 整文件能量切分
            raw_segs = _force_split_by_energy(vf, target_min=5.0, target_max=15.0)
        else:
            raw_segs = vad_segs
            # 对超长段（>30s）在段内强制切分
            refined = []
            for s, e in raw_segs:
                if e - s > 30:
                    refined.extend(_force_split_by_energy(vf, s, e, target_min=5.0, target_max=15.0))
                else:
                    refined.append([s, e])
            raw_segs = refined

        emit("segment", "running",
             f"  切分为 {len(raw_segs)} 段（每段 {min(e-s for s,e in raw_segs):.1f}~{max(e-s for s,e in raw_segs):.1f}s）",
             23 + int(5 * (vi + 1) / len(vocals)))

        # 切 wav 文件（前后留 PAD_SEC padding）
        audio_data, sr = sf.read(vf)
        if audio_data.ndim > 1:
            audio_data = audio_data.mean(axis=1)
        for s, e in raw_segs:
            start_sample = max(0, int((s - PAD_SEC) * sr))
            end_sample = min(len(audio_data), int((e + PAD_SEC) * sr))
            clip = audio_data[start_sample:end_sample]
            idx = len(all_slices)
            clip_path = os.path.join(out_dir, f"seg_{idx:04d}.wav")
            sf.write(clip_path, clip, sr)
            all_slices.append({
                "wav_path": clip_path,
                "start": s, "end": e, "duration": e - s,
            })

    emit("segment", "running",
         f"切片完成，共 {len(all_slices)} 段，开始 ASR 标注...",
         30)

    # ========== 阶段2: 对每个小片段做 ASR ==========
    all_segments = []
    asr_engine = "funasr"

    try:
        emit("segment", "running",
             f"加载 FunASR Paraformer-large ASR 模型 ({asr_device.upper()})...", 30)
        funasr_asr = _load_funasr_asr(gpt_root)
        emit("segment", "running", "FunASR ASR 加载完成，开始识别...", 32)

        for i, slc in enumerate(all_slices):
            emit("segment", "running",
                 f"FunASR 识别: seg_{i:04d}.wav ({i+1}/{len(all_slices)}, {slc['duration']:.1f}s)",
                 30 + int(20 * (i + 1) / len(all_slices)))
            try:
                res = funasr_asr.generate(input=slc["wav_path"])
                text = res[0].get("text", "").strip() if res and isinstance(res[0], dict) else ""
            except Exception as e:
                text = ""
                emit("segment", "running",
                     f"  seg_{i:04d} 识别失败: {type(e).__name__}", 32)
            if not text:
                continue
            all_segments.append({
                "wav_path": slc["wav_path"],
                "text": text,
                "start": slc["start"], "end": slc["end"],
                "duration": slc["duration"],
            })

    except Exception as funasr_err:
        # === 回退到 openai-whisper medium ===
        asr_engine = "whisper"
        emit("segment", "running",
             f"FunASR ASR 加载失败 ({type(funasr_err).__name__}: {str(funasr_err)[:80]})，回退到 Whisper medium...",
             32)
        import whisper
        import whisper.audio as whisper_audio
        import torchaudio

        # 补丁 whisper 的 load_audio（避免 ffmpeg 依赖问题）
        original_load_audio = whisper_audio.load_audio
        def patched_load_audio(file, sr=16000):
            if isinstance(file, str) and os.path.isfile(file):
                wav, orig_sr = torchaudio.load(file)
                if wav.shape[0] > 1:
                    wav = wav.mean(dim=0)
                else:
                    wav = wav.squeeze(0)
                if orig_sr != sr:
                    wav = torchaudio.functional.resample(wav, orig_sr, sr)
                return wav.numpy()
            return original_load_audio(file, sr)
        whisper_audio.load_audio = patched_load_audio

        # 补丁 whisper 的 _download：跳过 sha256 校验避免 OOM
        _original_download = whisper._download
        def _patched_download(url, download_root, in_memory):
            if download_root is None:
                default = os.path.join(os.path.expanduser("~"), ".cache")
                download_root = os.path.join(os.getenv("XDG_CACHE_HOME", default), "whisper")
            download_target = os.path.join(download_root, os.path.basename(url))
            if os.path.isfile(download_target):
                size_mb = os.path.getsize(download_target) // (1024 * 1024)
                if size_mb >= 100:
                    return download_target
                try:
                    os.remove(download_target)
                except Exception:
                    pass
            return _original_download(url, download_root, in_memory)
        whisper._download = _patched_download

        whisper_device = asr_device
        model_size = "medium"
        model = None
        for try_size in ["medium", "small", "base"]:
            try:
                emit("segment", "running",
                     f"加载 Whisper {try_size} ({whisper_device.upper()})...", 32)
                model = whisper.load_model(try_size, device=whisper_device)
                model_size = try_size
                break
            except (MemoryError, Exception) as e:
                emit("segment", "running",
                     f"Whisper {try_size} 加载失败 ({type(e).__name__})，尝试降级...", 32)
                import gc; gc.collect()
                continue
        if model is None:
            raise RuntimeError("FunASR 和 Whisper 均加载失败，无法继续 ASR 标注")
        if model_size != "medium":
            emit("segment", "running",
                 f"已降级到 Whisper {model_size}（中文识别质量略低）", 33)
        emit("segment", "running", f"Whisper 模型加载完成 ({model_size})，开始识别...", 33)

        for i, slc in enumerate(all_slices):
            emit("segment", "running",
                 f"Whisper 识别: seg_{i:04d}.wav ({i+1}/{len(all_slices)}, {slc['duration']:.1f}s)",
                 30 + int(20 * (i + 1) / len(all_slices)))
            try:
                result = model.transcribe(slc["wav_path"], language="zh", verbose=False)
                text = result.get("text", "").strip()
            except Exception as e:
                text = ""
                emit("segment", "running",
                     f"  seg_{i:04d} 识别失败: {type(e).__name__}", 33)
            if not text:
                continue
            all_segments.append({
                "wav_path": slc["wav_path"],
                "text": text,
                "start": slc["start"], "end": slc["end"],
                "duration": slc["duration"],
            })

    # 跳过空文本的段
    valid_segments = [s for s in all_segments if s["text"]]
    skipped = len(all_segments) - len(valid_segments)

    emit("segment", "running",
         f"ASR 识别完成（引擎: {asr_engine}），有效 {len(valid_segments)} 段（跳过 {skipped} 空文本）",
         34)

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"segments": valid_segments}, f, ensure_ascii=False, indent=2)
    emit("segment", "done",
         f"切片+标注完成，共 {len(valid_segments)} 段（引擎: {asr_engine}）",
         35, segments=len(valid_segments), manifest=manifest_path)
    return manifest_path


# ============================================================
# Step 4: GPT-SoVITS 格式转换
# ============================================================
def step4_gptsovits_prepare(manifest_path, gpt_root, char_name, ffmpeg):
    """
    转换为 GPT-SoVITS 格式：
    - 32kHz 单声道 WAV + 响度归一化
    - 生成 <char_name>.list（绝对路径，格式: wav_path|spk_name|language|text）
    路径约定：wav 和 list 文件放在 GPT_SoVITS/raw/（与原版 GPT-SoVITS 一致）
    """
    emit("gpt_prepare", "start", "转换为 GPT-SoVITS 格式 (32kHz + 响度归一化)...", 35)

    gpt_output = os.path.join(gpt_root, "GPT_SoVITS", "raw")
    os.makedirs(gpt_output, exist_ok=True)

    # 清理旧数据（只删除当前角色的文件，避免误删其他角色）
    for old in os.listdir(gpt_output):
        if old.startswith(f"{char_name}_") or old == f"{char_name}.list":
            try:
                os.remove(os.path.join(gpt_output, old))
            except OSError:
                pass

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    segments = manifest.get("segments", [])
    if not segments:
        raise RuntimeError("manifest 中没有切片数据")

    emit("gpt_prepare", "running", f"转换 {len(segments)} 个切片...", 37)
    samples = []
    success = 0
    for i, seg in enumerate(segments):
        src = seg["wav_path"]
        if not os.path.isfile(src):
            emit("gpt_prepare", "running", f"  跳过（文件不存在）: {os.path.basename(src)}", 37)
            continue
        basename = f"{char_name}_{i:04d}"
        dst = os.path.join(gpt_output, f"{basename}.wav")
        # ffmpeg 转换：32kHz 单声道 + 响度归一化
        cmd = [
            ffmpeg, "-y", "-i", src,
            "-ac", "1", "-ar", "32000",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
            dst
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode == 0 and os.path.isfile(dst):
            samples.append({"wav": dst, "text": seg["text"].strip()})
            success += 1
        else:
            emit("gpt_prepare", "running", f"  转换失败: {os.path.basename(src)}", 37)
        if (i + 1) % 20 == 0:
            emit("gpt_prepare", "running", f"  进度: {i+1}/{len(segments)} (成功 {success})",
                 37 + int(15 * (i + 1) / len(segments)))

    # 生成 <char_name>.list（绝对路径）
    list_path = os.path.join(gpt_output, f"{char_name}.list")
    with open(list_path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(f"{s['wav']}|{char_name}|zh|{s['text']}\n")

    if not samples:
        raise RuntimeError("格式转换失败：没有成功转换任何切片")

    emit("gpt_prepare", "done",
         f"转换完成: {success}/{len(segments)} → {gpt_output}（selina.list {len(samples)} 条）",
         50, gpt_output=gpt_output, list_path=list_path, samples=len(samples))
    return gpt_output, list_path


# ============================================================
# Step 5: 预处理 1A/1B/1C（runpy 进程内执行）
# ============================================================
def step5_preprocess(gpt_root, char_name, list_path):
    """GPT-SoVITS 数据预处理：1A 文本分词 + 1B HuBERT特征 + 1C 语义Token"""
    emit("preprocess", "start", "数据预处理（1A 文本 + 1B 语音特征 + 1C 语义Token）...", 50)

    exp_name = f"{char_name}_core"
    exp_dir = os.path.join(gpt_root, "GPT_SoVITS", "logs", exp_name)
    os.makedirs(exp_dir, exist_ok=True)

    # 清理旧的预处理数据（避免 checkpoint skip bug）
    for sub in ["2-name2text.txt", "2-name2text-0.txt"]:
        p = os.path.join(exp_dir, sub)
        if os.path.isfile(p):
            os.remove(p)
    for sub in ["3-bert", "4-cnhubert", "5-wav32k", "6-name2semantic.tsv", "6-name2semantic-0.tsv"]:
        p = os.path.join(exp_dir, sub)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)

    python_exec = sys.executable
    bert_dir = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
    ssl_dir = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
    s2g_path = "GPT_SoVITS/pretrained_models/s2Gv3.pth"

    # ---------- 1A: 文本分词 ----------
    emit("preprocess", "running", "[1A] 文本分词与特征提取...", 52)
    env_1a = {
        "inp_text": list_path,
        "inp_wav_dir": os.path.dirname(list_path),
        "exp_name": exp_name,
        "opt_dir": exp_dir,
        "bert_pretrained_dir": bert_dir,
        "i_part": "0", "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0", "is_half": "True",
    }
    _run_gptsovits_script(
        os.path.join(gpt_root, "GPT_SoVITS", "prepare_datasets", "1-get-text.py"),
        gpt_root, env_1a, "1A"
    )
    # 合并 2-name2text-0.txt → 2-name2text.txt
    txt_0 = os.path.join(exp_dir, "2-name2text-0.txt")
    txt_final = os.path.join(exp_dir, "2-name2text.txt")
    if os.path.isfile(txt_0):
        with open(txt_0, "r", encoding="utf-8") as f:
            lines = [l for l in f.read().strip().split("\n") if l.strip()]
        with open(txt_final, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.remove(txt_0)
        emit("preprocess", "running", f"[1A] 完成: {len(lines)} 条文本", 55)

    # ---------- 1B: 语音自监督特征 ----------
    # 1A 已完成（torch/transformers 已加载）。现在注入 fake librosa，
    # 防止 1B/1C 的 `import librosa` 触发 numba JIT 与 torch 死锁。
    # 延迟到此处注入，避免 scipy/soundfile 的 DLL 与 1A 的 transformers 冲突。
    _inject_fake_librosa()
    emit("preprocess", "running", "[1B] HuBERT 语音特征提取...", 57)
    env_1b = {
        "inp_text": list_path,
        "inp_wav_dir": os.path.dirname(list_path),
        "exp_name": exp_name,
        "opt_dir": exp_dir,
        "cnhubert_base_dir": ssl_dir,
        "i_part": "0", "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0", "is_half": "True",
    }
    _run_gptsovits_script(
        os.path.join(gpt_root, "GPT_SoVITS", "prepare_datasets", "2-get-hubert-wav32k.py"),
        gpt_root, env_1b, "1B"
    )
    # 1B 产物校验：4-cnhubert 和 5-wav32k 必须有文件，否则训练时 ZeroDivisionError
    hubert_dir = os.path.join(exp_dir, "4-cnhubert")
    wav32k_dir = os.path.join(exp_dir, "5-wav32k")
    hubert_files = [f for f in os.listdir(hubert_dir) if f.endswith(".pt")] if os.path.isdir(hubert_dir) else []
    wav32k_files = [f for f in os.listdir(wav32k_dir) if f.endswith(".wav")] if os.path.isdir(wav32k_dir) else []
    if not hubert_files or not wav32k_files:
        _diag = []
        if not hubert_files:
            _diag.append(f"4-cnhubert 目录为空或不存在: {hubert_dir}")
        if not wav32k_files:
            _diag.append(f"5-wav32k 目录为空或不存在: {wav32k_dir}")
        _diag.append(f"inp_wav_dir={os.path.dirname(list_path)}")
        _diag.append(f"list_path={list_path}")
        # 检查 wav 文件是否存在
        _wav_dir = os.path.dirname(list_path)
        if os.path.isdir(_wav_dir):
            _wavs = [f for f in os.listdir(_wav_dir) if f.endswith(".wav")]
            _diag.append(f"inp_wav_dir 中 wav 文件数: {len(_wavs)}")
        else:
            _diag.append(f"inp_wav_dir 不存在: {_wav_dir}")
        raise RuntimeError(
            f"[1B] HuBERT 特征提取失败，未产出任何文件。\n" +
            "\n".join(_diag) +
            "\n请检查音频文件是否存在且可读取，HuBERT 模型是否完整。"
        )
    emit("preprocess", "running", f"[1B] 完成: {len(hubert_files)} 个 HuBERT 特征, {len(wav32k_files)} 个 32k wav", 62)

    # ---------- 1C: 语义Token ----------
    emit("preprocess", "running", "[1C] 语义Token提取...", 64)
    env_1c = {
        "inp_text": list_path,
        "exp_name": exp_name,
        "opt_dir": exp_dir,
        "pretrained_s2G": s2g_path,
        "s2config_path": "GPT_SoVITS/configs/s2.json",
        "i_part": "0", "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0", "is_half": "True",
    }
    _run_gptsovits_script(
        os.path.join(gpt_root, "GPT_SoVITS", "prepare_datasets", "3-get-semantic.py"),
        gpt_root, env_1c, "1C"
    )
    # 合并 6-name2semantic-0.tsv → 6-name2semantic.tsv
    tsv_0 = os.path.join(exp_dir, "6-name2semantic-0.tsv")
    tsv_final = os.path.join(exp_dir, "6-name2semantic.tsv")
    if os.path.isfile(tsv_0):
        with open(tsv_0, "r", encoding="utf-8") as f:
            lines = [l for l in f.read().strip().split("\n") if l.strip()]
        with open(tsv_final, "w", encoding="utf-8") as f:
            f.write("item_name\tsemantic_audio\n")
            f.write("\n".join(lines) + "\n")
        os.remove(tsv_0)
        emit("preprocess", "running", f"[1C] 完成: {len(lines)} 条", 68)
    else:
        # 1C 未产出 6-name2semantic-0.tsv，可能 s2Gv3.pth 加载失败
        raise RuntimeError(
            f"[1C] 语义Token提取失败，未产出 6-name2semantic-0.tsv。\n"
            f"exp_dir={exp_dir}\n"
            f"pretrained_s2G={s2g_path}\n"
            f"请检查 s2Gv3.pth 模型文件是否存在且可加载。"
        )

    emit("preprocess", "done", "预处理完成（1A + 1B + 1C）", 70, exp_dir=exp_dir)
    return exp_dir


def _run_gptsovits_script(script_path, gpt_root, env_extra, label):
    """
    进程内执行 GPT-SoVITS 预处理脚本（runpy.run_path）
    优势：继承当前进程的 sys.path 和环境，不需要 PYTHONPATH 传递
    """
    old_cwd = os.getcwd()
    old_env = {}
    for k, v in env_extra.items():
        old_env[k] = os.environ.get(k)
        os.environ[k] = v

    # 把 GPT-SoVITS 根目录加入 sys.path（让脚本内的 from text.cleaner import ... 能找到）
    gpt_pkg = os.path.join(gpt_root, "GPT_SoVITS")
    added_paths = []
    for p in [gpt_root, gpt_pkg]:
        if p not in sys.path:
            sys.path.insert(0, p)
            added_paths.append(p)

    try:
        os.chdir(gpt_root)
        emit("preprocess", "running", f"  [{label}] 执行 {os.path.basename(script_path)}...", 0)
        # runpy.run_path 在当前进程命名空间执行脚本，继承 sys.path
        runpy.run_path(script_path, run_name="__main__")
    except SystemExit as e:
        if e.code and e.code != 0:
            raise RuntimeError(f"[{label}] 脚本退出码 {e.code}")
    except Exception as e:
        raise RuntimeError(f"[{label}] 执行失败: {e}\n{traceback.format_exc()[-500:]}")
    finally:
        os.chdir(old_cwd)
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for p in added_paths:
            if p in sys.path:
                sys.path.remove(p)


# ============================================================
# Step 6: 训练 SoVITS + GPT（subprocess + 可靠 executor）
# ============================================================
def _ensure_gpu_memory_for_training(min_free_mb=4000):
    """
    训练前确保 GPU 有足够显存。返回释放后的可用显存（MiB），供调用方决定 batch_size。
    v3 LoRA 训练需加载 s2Gv3.pth + BERT + HuBERT，约 3-4GB。
    如果可用显存不足，停止占用显存的 TTS 服务（默认监听 ChatX2 的 9882 端口）并清空 CUDA 缓存。
    Windows 上 CUDA OOM 常表现为 0xC0000005/0xC0000409（ACCESS_VIOLATION/STACK_BUFFER_OVERRUN），
    而非明确的 "CUDA out of memory"。
    """
    try:
        # 先清空本进程的 CUDA 缓存（前置阶段 FunASR/HuBERT 可能残留显存）
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                emit("train", "running", "[GPU] 已清空 CUDA 缓存", 0)
        except Exception:
            pass

        import subprocess as _sp
        # 查询 GPU 显存
        r = _sp.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if r.returncode != 0:
            return -1  # nvidia-smi 不可用，返回 -1 表示未知，调用方按宽松处理
        free_mb = int(r.stdout.strip().split('\n')[0].strip())
        emit("train", "running", f"[GPU] 可用显存: {free_mb} MiB (舒适阈值 ≥{min_free_mb} MiB)", 0)
        if free_mb >= min_free_mb:
            return free_mb  # 显存充足

        emit("train", "running", f"[GPU] 显存不足，尝试停止 TTS 服务释放显存...", 0)
        # 查找监听 ChatX2 TTS 端口的进程（可通过 CHATX2_TTS_PORT/TTS_PORT 覆盖）
        tts_port = str(os.environ.get("CHATX2_TTS_PORT") or os.environ.get("TTS_PORT") or "9882").strip()
        if not tts_port.isdigit():
            tts_port = "9882"
        r2 = _sp.run(
            f'netstat -ano | findstr :{tts_port} | findstr LISTEN',
            shell=True, capture_output=True, text=True, timeout=5
        )
        pids = set()
        for line in r2.stdout.strip().split('\n'):
            parts = line.split()
            if len(parts) >= 5:
                try:
                    pids.add(int(parts[-1]))
                except ValueError:
                    pass
        for pid in pids:
            try:
                _sp.run(["taskkill", "/F", "/PID", str(pid)],
                        capture_output=True, timeout=5)
                emit("train", "running", f"[GPU] 已停止 TTS 服务 PID {pid}", 0)
            except Exception:
                pass
        # 等待显存释放
        import time as _time
        _time.sleep(3)
        # 再次清空缓存
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        r3 = _sp.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if r3.returncode == 0:
            free_mb = int(r3.stdout.strip().split('\n')[0].strip())
            emit("train", "running", f"[GPU] 释放后可用显存: {free_mb} MiB", 0)
        return free_mb
    except Exception as e:
        emit("train", "running", f"[GPU] 显存检查失败: {e}", 0)
        return -1


def step6_train(gpt_root, char_name, exp_dir):
    """训练 SoVITS（v3 LoRA）+ GPT（带跳过逻辑）"""
    emit("train", "start", "开始训练 GPT-SoVITS（v3 LoRA）...", 70)

    # GPU 显存预检查：TTS 服务可能占用显存导致训练 0xC0000005/0xC0000409 崩溃
    # 返回释放后的可用显存，供 batch_size 自适应决策
    gpu_free_mb = _ensure_gpu_memory_for_training(min_free_mb=4000)
    # 临界值检查：低于 3000 MiB 即使 batch_size=1 + fp16 也必崩，直接拒绝训练
    # （避免硬跑到 native 层出一个看不懂的 0xC0000409 退出码）
    GPU_CRITICAL_MIN_MB = 3000
    if 0 <= gpu_free_mb < GPU_CRITICAL_MIN_MB:
        raise RuntimeError(
            f"GPU 可用显存仅 {gpu_free_mb} MiB，低于 v3 LoRA 训练最低要求 {GPU_CRITICAL_MIN_MB} MiB。"
            f"请关闭其他占用显存的程序（浏览器/其他 GPU 进程）后重试，"
            f"或改用 CPU 训练（--device cpu，会很慢），或退回 v2 训练路线。"
        )

    exp_name = f"{char_name}_core"
    python_exec = sys.executable

    # 检查已有权重（跳过已完成的训练）
    sovits_w = _find_latest_weight(
        os.path.join(gpt_root, "SoVITS_weights_v3_core"), exp_name, ".pth"
    )
    gpt_w = _find_latest_weight(
        os.path.join(gpt_root, "GPT_weights_v3_core"), exp_name, ".ckpt"
    )

    # ---------- SoVITS 训练 ----------
    if sovits_w:
        emit("train", "running", f"[SoVITS] 已有权重，跳过训练: {os.path.basename(sovits_w)}", 80)
    else:
        # 清理旧的训练 checkpoint（避免 skip bug）
        s2_dir = os.path.join(exp_dir, "logs_s2_v3_lora_32")
        if os.path.isdir(s2_dir):
            for f in os.listdir(s2_dir):
                if "G_233333333333" in f or f.startswith("events.out.tfevents"):
                    try:
                        os.remove(os.path.join(s2_dir, f))
                    except OSError:
                        pass

        emit("train", "running", "[SoVITS] 配置训练参数...", 72)
        sovits_config = _build_sovits_config(gpt_root, exp_name, exp_dir, gpu_free_mb)
        tmp_config_s2 = os.path.join(gpt_root, "TEMP", "tmp_s2_v3.json")
        os.makedirs(os.path.dirname(tmp_config_s2), exist_ok=True)
        with open(tmp_config_s2, "w", encoding="utf-8") as f:
            json.dump(sovits_config, f, ensure_ascii=False)

        emit("train", "running", "[SoVITS] 训练音色模型 (v3 LoRA, 单进程模式)...", 73)
        _run_train_subprocess(
            f'"{python_exec}" GPT_SoVITS/_s2_train_direct.py --config "{tmp_config_s2}"',
            gpt_root, "SoVITS"
        )
        emit("train", "running", "[SoVITS] 训练完成", 80)

        sovits_w = _find_latest_weight(
            os.path.join(gpt_root, "SoVITS_weights_v3_core"), exp_name, ".pth"
        )
        if not sovits_w:
            # savee() 可能因内存不足失败，尝试从 LoRA checkpoint 恢复权重
            emit("train", "running", "[SoVITS] 权重文件缺失，尝试从 checkpoint 恢复...", 81)
            sovits_w = _recover_sovits_from_checkpoint(gpt_root, exp_dir, exp_name)
        if not sovits_w:
            raise RuntimeError(
                "SoVITS 训练完成但未找到权重文件，且从 checkpoint 恢复失败。"
                "可能是训练时内存不足导致 savee() 失败。"
                "请关闭其他程序后重试，或手动运行 savee() 恢复。"
            )

    # ---------- GPT 训练 ----------
    if gpt_w:
        emit("train", "running", f"[GPT] 已有权重，跳过训练: {os.path.basename(gpt_w)}", 90)
    else:
        try:
            # GPT 训练前再次检查 GPU 显存（SoVITS 训练后 TTS 可能被 ensureTTSRunning 自动重启）
            gpu_free_mb = _ensure_gpu_memory_for_training(min_free_mb=4000)
            if 0 <= gpu_free_mb < GPU_CRITICAL_MIN_MB:
                raise RuntimeError(
                    f"GPT 训练前 GPU 可用显存仅 {gpu_free_mb} MiB，低于最低要求 {GPU_CRITICAL_MIN_MB} MiB。"
                    f"请关闭其他占用显存的程序后重试。"
                )
            emit("train", "running", "[GPT] 配置训练参数...", 82)
            gpt_config = _build_gpt_config(gpt_root, exp_name, exp_dir, gpu_free_mb)
            tmp_config_s1 = os.path.join(gpt_root, "TEMP", "tmp_s1_v3.yaml")
            with open(tmp_config_s1, "w", encoding="utf-8") as f:
                import yaml
                yaml.dump(gpt_config, f, default_flow_style=False, allow_unicode=True)

            emit("train", "running", "[GPT] 训练韵律模型 (~5-10分钟)...", 83)
            _run_train_subprocess(
                f'"{python_exec}" GPT_SoVITS/s1_train.py --config_file "{tmp_config_s1}"',
                gpt_root, "GPT"
            )
            emit("train", "running", "[GPT] 训练完成", 90)

            gpt_w = _find_latest_weight(
                os.path.join(gpt_root, "GPT_weights_v3_core"), exp_name, ".ckpt"
            )
        except Exception as gpt_err:
            emit("train", "running",
                 f"[GPT] 训练失败: {gpt_err}，尝试回退到预训练模型...", 90)
            gpt_w = None

        if not gpt_w:
            # GPT 训练未产出权重或失败，回退到预训练模型（语音可用但韵律为默认）
            pretrained_gpt = os.path.join(gpt_root, "GPT_SoVITS", "pretrained_models", "s1v3.ckpt")
            if os.path.isfile(pretrained_gpt):
                emit("train", "running",
                     f"[GPT] 回退到预训练模型: {os.path.basename(pretrained_gpt)}", 90)
                gpt_w = pretrained_gpt
            else:
                raise RuntimeError(
                    "GPT 训练失败且预训练模型 s1v3.ckpt 不存在。"
                    "请检查 GPT_SoVITS/pretrained_models/ 目录。"
                )

    emit("train", "done", f"训练完成: SoVITS={os.path.basename(sovits_w)}, GPT={os.path.basename(gpt_w)}",
         90, sovits_weights=sovits_w, gpt_weights=gpt_w)
    return gpt_w, sovits_w


def _build_sovits_config(gpt_root, exp_name, exp_dir, gpu_free_mb=-1):
    """构建 SoVITS v3 LoRA 训练配置
    gpu_free_mb: 释放后可用显存（MiB），<0 表示未知（按默认保守值）。
    显存 < 4500 MiB 时自动降为 batch_size=1 + 强制 fp16，避免 native 层 OOM 崩溃。
    """
    config_path = os.path.join(gpt_root, "GPT_SoVITS", "configs", "s2.json")
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    EPOCHS = 3
    LORA_RANK = 32
    # 显存自适应 batch_size：≥4500 MiB 用 2，否则用 1（v3 LoRA 在 3.5G 卡上必须 batch_size=1）
    GPU_LOW_MB = 4500
    if 0 <= gpu_free_mb < GPU_LOW_MB:
        BATCH_SIZE = 1
        emit("train", "running",
             f"[SoVITS] 显存 {gpu_free_mb} MiB < {GPU_LOW_MB} MiB，batch_size=1 + fp16 兜底", 0)
    else:
        BATCH_SIZE = 2

    data["train"]["batch_size"] = BATCH_SIZE
    data["train"]["epochs"] = EPOCHS
    data["train"]["pretrained_s2G"] = "GPT_SoVITS/pretrained_models/s2Gv3.pth"
    # v3 LoRA trainer only creates/loads net_g; it has no discriminator.
    data["train"]["pretrained_s2D"] = ""
    data["train"]["if_save_latest"] = True
    data["train"]["if_save_every_weights"] = True
    data["train"]["save_every_epoch"] = 1
    data["train"]["gpu_numbers"] = "0"
    data["train"]["grad_ckpt"] = True  # 梯度检查点：省显存换算力
    data["train"]["lora_rank"] = LORA_RANK
    data["model"]["version"] = "v3"
    data["data"]["exp_dir"] = data["s2_ckpt_dir"] = exp_dir
    data["save_weight_dir"] = "SoVITS_weights_v3_core"
    data["name"] = exp_name
    data["version"] = "v3"

    import torch
    if torch.cuda.is_available():
        # 显式开启 fp16（s2.json 默认已是 true，这里强制确认，防止被其他逻辑改掉）
        data["train"]["fp16_run"] = True
    else:
        data["train"]["fp16_run"] = False

    return data


def _build_gpt_config(gpt_root, exp_name, exp_dir, gpu_free_mb=-1):
    """构建 GPT 训练配置
    gpu_free_mb: 释放后可用显存（MiB），低显存时 batch_size 降为 1。
    """
    import yaml
    config_path = os.path.join(gpt_root, "GPT_SoVITS", "configs", "s1longer-v2.yaml")
    if not os.path.isfile(config_path):
        config_path = os.path.join(gpt_root, "GPT_SoVITS", "configs", "s1longer.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    EPOCHS = 10
    # 显存自适应：GPT 训练比 SoVITS 轻，但低显存仍需 batch_size=1
    GPU_LOW_MB = 4500
    if 0 <= gpu_free_mb < GPU_LOW_MB:
        BATCH_SIZE = 1
    else:
        BATCH_SIZE = 2

    data["train"]["batch_size"] = BATCH_SIZE
    data["train"]["epochs"] = EPOCHS
    data["pretrained_s1"] = "GPT_SoVITS/pretrained_models/s1v3.ckpt"
    data["train"]["save_every_n_epoch"] = 1
    data["train"]["if_save_every_weights"] = True
    data["train"]["if_save_latest"] = True
    data["train"]["if_dpo"] = False
    data["train"]["half_weights_save_dir"] = "GPT_weights_v3_core"
    data["train"]["exp_name"] = exp_name
    # Windows: num_workers > 0 + persistent_workers 会导致 GPT 训练 dataloader 死锁
    # （GPU 9% 利用率，进程不退出，已在本机复现）。设为 0 走主进程加载。
    # data_module.py 已修改为 num_workers=0 时不传 persistent_workers/prefetch_factor。
    data["data"]["num_workers"] = 0
    data["train_semantic_path"] = os.path.join(exp_dir, "6-name2semantic.tsv")
    data["train_phoneme_path"] = os.path.join(exp_dir, "2-name2text.txt")
    data["output_dir"] = os.path.join(exp_dir, "logs_s1_v3")

    return data


def _run_train_subprocess(cmd, gpt_root, label, max_retries=3):
    """
    可靠的子进程执行器（带 DLL 冲突自动重试 + 前台降级）：
    - 自动设置 cwd=gpt_root
    - 自动设置 PYTHONPATH（GPT_SoVITS 包路径）
    - stderr 不当错误（torch/tqdm 写 stderr）
    - 实时输出日志
    - 退出码 0xC0000005/0xC0000409 (ACCESS_VIOLATION/STACK_BUFFER_OVERRUN) 时自动重试（非确定性）
    - 多次重试仍失败时降级到前台同步执行（绕开子进程 DLL 状态污染）
    """
    # 0xC0000005 = STATUS_ACCESS_VIOLATION（DLL 冲突典型退出码）
    # 0xC0000409 = STATUS_STACK_BUFFER_OVERRUN（native 层 OOM 常见退出码，3221226505）
    # 0xC0000374 = STATUS_HEAP_CORRUPTION（3221226356）
    # 这三个码在 Windows 上常因 CUDA OOM / DLL 冲突触发，属非确定性，值得重试
    DLL_CRASH_CODES = {0xC0000005, 3221225477, 3221226356, 0xC0000409, 3221226505}

    env = os.environ.copy()
    gpt_pkg = os.path.join(gpt_root, "GPT_SoVITS")
    pp_parts = [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]
    for p in [gpt_root, gpt_pkg]:
        if p and p not in pp_parts:
            pp_parts.insert(0, p)
    env["PYTHONPATH"] = os.pathsep.join(pp_parts)
    env["version"] = "v3"
    env["PYTHONUNBUFFERED"] = "1"
    # 绕开 torch/transformers DLL 冲突：禁用 torch JIT，减少 DLL 加载
    env.setdefault("PYTORCH_JIT", "0")
    env.setdefault("TOKENIZERS_PARALLELISM", "false")

    last_rc = None
    for attempt in range(1, max_retries + 1):
        emit("train", "running", f"  [{label}] 训练尝试 {attempt}/{max_retries}", 0)
        try:
            proc = subprocess.Popen(
                cmd, shell=True, cwd=gpt_root, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, universal_newlines=True
            )
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    emit("train", "running", f"  [{label}] {line}", 0)
            proc.wait()
            last_rc = proc.returncode
            if proc.returncode == 0:
                return  # 成功
            if proc.returncode not in DLL_CRASH_CODES:
                # 非 DLL 冲突错误（如 OOM、配置错误），不重试直接报错
                raise RuntimeError(f"[{label}] 训练失败，退出码 {proc.returncode}")
            # DLL 冲突：重试
            emit("train", "running",
                 f"  [{label}] DLL 冲突崩溃 (rc={proc.returncode})，{attempt}/{max_retries}，等待 5s 后重试...",
                 0)
            import time as _time
            _time.sleep(5)
        except RuntimeError:
            raise  # 非 DLL 错误直接抛出
        except Exception as e:
            emit("train", "running", f"  [{label}] 子进程异常: {e}，重试 {attempt}/{max_retries}", 0)
            import time as _time
            _time.sleep(5)

    # 所有重试都失败：降级到前台同步执行（绕开子进程 DLL 状态）
    emit("train", "running",
         f"  [{label}] 子进程训练 {max_retries} 次均崩溃，降级到前台同步执行模式...",
         0)
    emit("train", "running",
         f"  [{label}] 注意：前台模式不实时输出日志，请耐心等待（10 epochs 约 5 分钟）",
         0)
    import time as _time
    _t0 = _time.time()
    try:
        result = subprocess.run(
            cmd, shell=True, cwd=gpt_root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=900  # 15 分钟超时
        )
        elapsed = _time.time() - _t0
        # 输出最后 30 行日志（避免刷屏）
        tail_lines = result.stdout.strip().split('\n')[-30:] if result.stdout else []
        for line in tail_lines:
            emit("train", "running", f"  [{label}] {line.rstrip()}", 0)
        emit("train", "running",
             f"  [{label}] 前台执行完成，耗时 {elapsed:.0f}s，退出码 {result.returncode}",
             0)
        if result.returncode != 0:
            raise RuntimeError(f"[{label}] 前台执行仍失败，退出码 {result.returncode}")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"[{label}] 前台执行超时（15分钟）")
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"[{label}] 前台执行异常: {e}")


def _find_latest_weight(weight_dir, exp_name, ext):
    """在权重目录中找最新的匹配文件"""
    if not os.path.isdir(weight_dir):
        return None
    cands = sorted(
        [os.path.join(weight_dir, f) for f in os.listdir(weight_dir)
         if f.startswith(exp_name) and f.endswith(ext)],
        key=os.path.getmtime, reverse=True
    )
    return cands[0] if cands else None


def _recover_sovits_from_checkpoint(gpt_root, exp_dir, exp_name):
    """从 LoRA checkpoint 恢复 SoVITS 权重（savee 失败时的兜底）

    训练时 savee() 可能因内存不足失败，但 LoRA checkpoint (G_233333333333.pth) 已保存。
    此函数加载 checkpoint，提取模型权重，调用 savee 重新生成最终权重。
    """
    import subprocess
    # 查找 LoRA checkpoint 目录
    lora_dirs = []
    if os.path.isdir(exp_dir):
        for d in os.listdir(exp_dir):
            if d.startswith("logs_s2_v3_lora_"):
                lora_dirs.append(os.path.join(exp_dir, d))
    if not lora_dirs:
        return None

    # 找最新的 checkpoint
    ckpt_path = None
    for d in sorted(lora_dirs, key=os.path.getmtime, reverse=True):
        latest = os.path.join(d, "G_233333333333.pth")
        if os.path.isfile(latest):
            ckpt_path = latest
            break
        # 也查找 G_*.pth（非 latest 模式）
        pths = sorted([os.path.join(d, f) for f in os.listdir(d) if f.startswith("G_") and f.endswith(".pth")],
                      key=os.path.getmtime, reverse=True)
        if pths:
            ckpt_path = pths[0]
            break
    if not ckpt_path:
        return None

    emit("train", "running", f"[SoVITS] 从 checkpoint 恢复: {os.path.basename(ckpt_path)}", 81)

    # 用独立进程恢复（避免主进程内存不足）
    python_exec = _detect_python_exec()
    recover_script = f'''
import sys, os, torch
from collections import OrderedDict
sys.path.insert(0, r"{gpt_root}")
sys.path.insert(0, os.path.join(r"{gpt_root}", "GPT_SoVITS"))
os.chdir(r"{gpt_root}")
from process_ckpt import savee

ckpt = torch.load(r"{ckpt_path}", map_location="cpu")
model_state = ckpt["model"] if "model" in ckpt else ckpt
sim_ckpt = OrderedDict()
for key in model_state:
    sim_ckpt[key] = model_state[key].half().cpu()

class FakeHps:
    save_weight_dir = "SoVITS_weights_v3_core"
    name = "{exp_name}"

os.makedirs("SoVITS_weights_v3_core", exist_ok=True)
name = "{exp_name}_recovered_s" + str(ckpt.get("iteration", 0)) + "_l32"
result = savee(sim_ckpt, name, ckpt.get("iteration", 0), 0, FakeHps(), lora_rank=32)
target = os.path.join("SoVITS_weights_v3_core", name + ".pth")
if os.path.exists(target):
    print("RECOVERED:" + os.path.abspath(target))
else:
    print("FAILED:" + str(result))
'''
    try:
        result = subprocess.run(
            [python_exec, "-c", recover_script],
            capture_output=True, text=True, timeout=300,
            cwd=gpt_root,
            env={**os.environ, "PYTHONNOUSERSITE": "1"}
        )
        for line in result.stdout.splitlines():
            if line.startswith("RECOVERED:"):
                recovered_path = line[len("RECOVERED:"):]
                emit("train", "running", f"[SoVITS] 权重恢复成功: {os.path.basename(recovered_path)}", 82)
                return recovered_path
        # 失败时打印错误
        emit("train", "running", f"[SoVITS] 恢复失败: {result.stdout[-500:] if result.stdout else ''} {result.stderr[-500:] if result.stderr else ''}", 81)
        return None
    except Exception as e:
        emit("train", "running", f"[SoVITS] 恢复异常: {e}", 81)
        return None


def _detect_python_exec():
    """检测当前环境的 Python 可执行文件路径"""
    # 优先使用 runtimeFlavor.pythonExe（发布包内嵌 python_env）
    for mod_name in ["runtimeFlavor"]:
        try:
            mod = __import__(mod_name)
            if hasattr(mod, "pythonExe") and mod.pythonExe and os.path.isfile(mod.pythonExe):
                return mod.pythonExe
        except ImportError:
            pass
    # 回退到 sys.executable
    return sys.executable


# ============================================================
# Step 7: 情感参考音选择（韵律分析 + 8 情感分类）
# ============================================================
def step7_select_refs(gpt_root, char_name, manifest_path, gpt_output):
    """
    基于韵律分析为 8 种情感选择最佳参考音：
    - 提取 F0/能量/语速/停顿
    - 分类到 8 种情感（gentle/comfort/sad/sad_question/question/strong/excited/shy_happy）
    - 每种情感选 1 个最佳参考（3-8秒，静音比<65%）
    - 转换为 32kHz WAV + 生成 ref_texts.txt
    """
    emit("refs", "start", "情感参考音选择（韵律分析中）...", 90)

    import numpy as np
    import soundfile as sf
    from scipy.signal import correlate

    gpt_ref = os.path.join(gpt_root, "ref_audio", char_name)
    os.makedirs(gpt_ref, exist_ok=True)

    # 清理旧的参考音
    for sub in os.listdir(gpt_ref):
        p = os.path.join(gpt_ref, sub)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                os.remove(p)
            except OSError:
                pass

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    segments = manifest.get("segments", [])
    if not segments:
        raise RuntimeError("manifest 中没有切片，无法选择参考音")

    emit("refs", "running", f"分析 {len(segments)} 个切片的韵律特征...", 91)

    # 提取韵律特征
    prosody_list = []
    for i, seg in enumerate(segments):
        wav_path = seg["wav_path"]
        if not os.path.isfile(wav_path):
            continue
        try:
            audio, sr = sf.read(wav_path)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if len(audio) < sr * 0.5:  # <0.5秒跳过
                continue
            feats = _extract_prosody(audio, sr)
            feats["wav_path"] = wav_path
            feats["text"] = seg["text"]
            feats["idx"] = i
            # 保留 metadata 情感标签（来自 presliced NLP 分析）
            feats["meta_emotion"] = seg.get("emotion", "")  # 可能是 "平静(中性)" 或 "平静"
            feats["meta_sentiment"] = seg.get("sentiment", "")
            prosody_list.append(feats)
        except Exception as e:
            emit("refs", "running", f"  跳过（分析失败）: {os.path.basename(wav_path)}", 91)
        if (i + 1) % 20 == 0:
            emit("refs", "running", f"  韵律分析进度: {i+1}/{len(segments)}", 91)

    if not prosody_list:
        raise RuntimeError("没有可用的韵律分析结果")

    # 分类到 8 种情感（优先用 metadata 标签，韵律兜底）
    for p in prosody_list:
        # 从 "平静(中性)" 提取 "平静"
        me = p.get("meta_emotion", "")
        if "(" in me:
            me = me.split("(")[0].strip()
        p["emotion"] = _classify_emotion(p, meta_emotion=me, meta_sentiment=p.get("meta_sentiment", ""))

    # 统计
    emotion_counts = {}
    for p in prosody_list:
        e = p["emotion"]
        emotion_counts[e] = emotion_counts.get(e, 0) + 1
    stats = ", ".join(f"{k}:{v}" for k, v in sorted(emotion_counts.items(), key=lambda x: -x[1]))
    emit("refs", "running", f"情感分类统计: {stats}", 92)

    # 每种情感选最佳参考（确保不同情感选择不同音频 - 去重）
    emotions = ["gentle", "comfort", "sad", "sad_question", "question",
                "strong", "excited", "shy_happy"]
    ffmpeg = find_ffmpeg(gpt_root)
    selected = {}
    used_indices = set()  # 已选中的切片 idx，避免重复

    def _score(p):
        """优选：3-8秒（避免截取），静音比<40%（避免跳字），语速适中"""
        s = 0
        # 时长：3-8秒最佳（GPT-SoVITS 要求 3-10 秒，避免>10s 需截取导致 prompt_text 不匹配）
        if 3.0 <= p["duration"] <= 8.0:
            s += 15
        elif p["duration"] >= 2.0:
            s += 5
        # 超过 10 秒的切片扣分（需要截取，prompt_text 会不匹配）
        if p["duration"] > 10.0:
            s -= 20
        # 静音比：严格阈值（>50% 会导致 GPT-SoVITS 学到静音模式→跳字/过早终止）
        if p["silence_ratio"] < 0.30:
            s += 20
        elif p["silence_ratio"] < 0.40:
            s += 15
        elif p["silence_ratio"] < 0.50:
            s += 5
        elif p["silence_ratio"] >= 0.55:
            s -= 15  # 高静音比严重扣分
        # 语速适中（中位数 13 左右）
        s -= abs(p["speaking_rate"] - 13.0) * 0.5
        return s

    # 跨情感借用映射（当某情感候选不足时）
    FALLBACK = {
        "strong": ["excited", "question", "gentle"],
        "shy_happy": ["gentle", "comfort"],
        "sad_question": ["sad", "gentle"],
        "excited": ["strong", "question"],
        "sad": ["sad_question", "gentle"],
        "comfort": ["gentle", "question"],
        "question": ["gentle", "comfort"],
        "gentle": ["comfort", "question"],
    }

    def _pick_best(candidates, max_silence=0.50):
        """从候选中挑选：3-10s + 静音比<max_silence + rms>0.01"""
        filtered = [p for p in candidates
                    if 3.0 <= p["duration"] <= 10.0
                    and p["silence_ratio"] < max_silence
                    and p.get("overall_rms", p.get("rms_mean", 0)) >= 0.01]
        if not filtered:
            return None
        filtered.sort(key=_score, reverse=True)
        return filtered[0]

    for emotion in emotions:
        own_cands = [p for p in prosody_list if p["emotion"] == emotion and p["idx"] not in used_indices]
        best = _pick_best(own_cands, max_silence=0.50)
        if best is None and own_cands:
            best = _pick_best(own_cands, max_silence=0.65)
        borrow_note = ""
        if best is None:
            for fb_emotion in FALLBACK.get(emotion, ["gentle"]):
                fb_cands = [p for p in prosody_list
                            if p["emotion"] == fb_emotion and p["idx"] not in used_indices]
                best = _pick_best(fb_cands, max_silence=0.50)
                if best is None and fb_cands:
                    best = _pick_best(fb_cands, max_silence=0.65)
                if best is not None:
                    borrow_note = f" [borrowed from {fb_emotion}]"
                    break
        if best is None:
            all_cands = [p for p in prosody_list if p["idx"] not in used_indices]
            best = _pick_best(all_cands, max_silence=0.65)
        if best is None:
            all_cands = [p for p in prosody_list if p["idx"] not in used_indices]
            if all_cands:
                all_cands.sort(key=_score, reverse=True)
                best = all_cands[0]
        if best is None:
            emit("refs", "running", f"  {emotion}: 无可用候选，跳过",
                 92 + int(5 * (emotions.index(emotion) + 1) / len(emotions)))
            continue

        used_indices.add(best["idx"])

        ref_dir = os.path.join(gpt_ref, emotion)
        os.makedirs(ref_dir, exist_ok=True)
        ref_wav = os.path.join(ref_dir, "ref_0.wav")
        # 转换为 32kHz 单声道（不截取，避免 prompt_text 与音频不匹配 → 跳字）
        src_path = best["wav_path"]
        if ffmpeg:
            cmd = [ffmpeg, "-y", "-i", src_path,
                   "-ac", "1", "-ar", "32000", ref_wav]
            subprocess.run(cmd, capture_output=True, timeout=30)
        else:
            shutil.copy2(src_path, ref_wav)
        # 保存文本（与参考音完全一致，未截取）
        with open(os.path.join(ref_dir, "ref_texts.txt"), "w", encoding="utf-8") as f:
            f.write(f"ref_0.wav|{best['text']}\n")
        selected[emotion] = {
            "wav": ref_wav,
            "text": best["text"],
            "duration": best["duration"],
            "source_idx": best["idx"]
        }
        emit("refs", "running",
             f"  {emotion}: 选中 #{best['idx']} ({best['duration']:.1f}s, 静音{best['silence_ratio']*100:.0f}%){borrow_note}",
             92 + int(5 * (emotions.index(emotion) + 1) / len(emotions)))

    emit("refs", "done", f"参考音选择完成（{len(selected)} 种情感）", 95,
         ref_dir=gpt_ref, selected=selected)
    return gpt_ref, selected


def _extract_prosody(audio, sr):
    """提取韵律特征：F0/能量/语速/停顿"""
    import numpy as np
    from scipy.signal import correlate

    duration = len(audio) / sr

    # 能量 (RMS)
    frame_len = int(sr * 0.025)
    hop = int(sr * 0.010)
    frames = [audio[i:i+frame_len] for i in range(0, len(audio)-frame_len, hop)]
    rms = np.array([np.sqrt(np.mean(f**2)) for f in frames]) if frames else np.array([0])
    rms_mean = float(np.mean(rms))

    # 静音比
    threshold = max(0.015, float(np.sqrt(np.mean(audio**2))) * 0.4)
    silence_frames = np.sum(rms < threshold)
    silence_ratio = float(silence_frames / len(rms)) if len(rms) > 0 else 1.0

    # F0 (自相关法) - 修复：限制 lag 范围在 [sr/400, sr/80] 对应 F0 80-400Hz
    frame_40ms = int(sr * 0.04)
    lag_min = int(sr / 400.0)  # F0 上限 400Hz
    lag_max = int(sr / 80.0)   # F0 下限 80Hz
    f0_list = []
    for i in range(0, len(audio) - frame_40ms, hop):
        seg = audio[i:i+frame_40ms]
        if np.sqrt(np.mean(seg**2)) < threshold:
            continue
        seg = seg - np.mean(seg)
        autocorr = correlate(seg, seg, mode='full')[len(seg)-1:]
        # 只在 [lag_min, lag_max] 范围内找峰值（人声 F0 80-400Hz）
        window = autocorr[lag_min:lag_max + 1]
        if len(window) > 0 and np.max(window) > 0:
            lag = np.argmax(window) + lag_min
            if lag > 0:
                f0_list.append(sr / lag)
    f0_mean = float(np.mean(f0_list)) if f0_list else 0
    f0_std = float(np.std(f0_list)) if f0_list else 0

    # 语速（粗估：能量变化次数 / 时长）
    energy_changes = np.sum(np.abs(np.diff(rms)) > np.std(rms) * 0.3)
    speaking_rate = float(energy_changes / max(duration, 0.1))

    return {
        "duration": duration,
        "rms_mean": rms_mean,
        "silence_ratio": silence_ratio,
        "f0_mean": f0_mean,
        "f0_std": f0_std,
        "speaking_rate": speaking_rate,
    }


def _classify_emotion(p, meta_emotion="", meta_sentiment=""):
    """
    基于 metadata 情感标签 + 韵律特征分类到 8 种情感。
    优先使用 metadata 的 fine_emotion（来自 NLP 模型），韵律特征作为辅助/兜底。

    metadata fine_emotion 映射：
      悲伤/愤怒/紧张 → sad/strong/excited 类
      平静/赞许      → gentle/comfort 类
      乐观/喜悦/好笑 → excited/shy_happy 类
    """
    f0 = p.get("f0_mean", 0)
    f0_std = p.get("f0_std", 0)
    rms = p.get("rms_mean", 0)
    sr_rate = p.get("speaking_rate", 0)
    silence = p.get("silence_ratio", 0)

    me = (meta_emotion or "").strip()
    ms = (meta_sentiment or "").strip()

    # ---------- 优先使用 metadata 情感标签 ----------
    if me == "悲伤":
        # 悲伤 + 低能量 + 高静音 → sad_question（隐忍轻声）
        if rms < 0.025 or silence > 0.65:
            return "sad_question"
        return "sad"
    if me == "愤怒":
        # 愤怒通常高能量，但战双角色克制 → strong
        return "strong"
    if me == "紧张":
        # 紧张：高 F0 变化 + 较快语速 → question 或 strong
        if f0_std > 40:
            return "question"
        return "strong"
    if me == "好笑":
        # 好笑/小高兴 → shy_happy
        return "shy_happy"
    if me == "喜悦":
        # 喜悦 → excited 或 shy_happy
        if rms > 0.035:
            return "excited"
        return "shy_happy"
    if me == "乐观":
        # 乐观：积极但温和 → comfort 或 gentle
        if silence > 0.6:
            return "comfort"
        return "gentle"
    if me == "赞许":
        # 赞许：积极，有情感起伏 → comfort 或 gentle
        if f0_std > 50 and sr_rate > 12:
            return "excited"
        return "comfort"
    if me == "平静":
        # 平静 → gentle 或 question（看是否有疑问语气）
        if f0_std > 60:
            return "question"
        return "gentle"

    # ---------- 韵律特征兜底（无 metadata 时） ----------
    # 悲伤后轻声问：低 F0 + 低能量 + 高静音
    if 80 < f0 < 180 and rms < 0.025 and silence > 0.5:
        return "sad_question"
    # 悲伤：低 F0 + 低 F0 变化
    if 80 < f0 < 200 and f0_std < 30:
        return "sad"
    # 激动：高 F0 + 高能量
    if f0 > 280 and rms > 0.04:
        return "excited"
    # 坚定：中 F0 + 低 F0 变化 + 低静音
    if 200 < f0 < 280 and f0_std < 30 and silence < 0.4:
        return "strong"
    # 安慰：中低 F0 + 中等静音
    if f0 < 220 and 0.4 < silence < 0.65:
        return "comfort"
    # 害羞高兴：低 F0 + 高 F0 变化
    if 80 < f0 < 200 and f0_std > 40:
        return "shy_happy"
    # 疑问：高 F0 变化
    if f0_std > 50:
        return "question"
    # 默认：温柔
    return "gentle"


def _load_existing_refs(ref_dir):
    """从 ref_audio 目录重建 selected_refs 字典（用于 refs 阶段跳过时恢复状态）
    扫描 ref_dir/<emotion>/ref_0.wav 和 ref_dir/<emotion>/ref_texts.txt
    """
    if not os.path.isdir(ref_dir):
        return {}
    selected = {}
    for emotion in os.listdir(ref_dir):
        emo_dir = os.path.join(ref_dir, emotion)
        if not os.path.isdir(emo_dir):
            continue
        ref_wav = os.path.join(emo_dir, "ref_0.wav")
        if not os.path.isfile(ref_wav):
            continue
        # 读取参考音文本
        text = ""
        text_file = os.path.join(emo_dir, "ref_texts.txt")
        if os.path.isfile(text_file):
            try:
                with open(text_file, "r", encoding="utf-8") as f:
                    line = f.readline().strip()
                    if "|" in line:
                        text = line.split("|", 1)[1]
                    else:
                        text = line
            except Exception:
                pass
        selected[emotion] = {"wav": ref_wav, "text": text}
    return selected


# ============================================================
# Step 8: 部署到 GPT-SoVITS/voices/<voice_name>/
# ============================================================
def step8_deploy(gpt_root, voice_name, project_root, gpt_w, sovits_w, ref_dir, selected_refs):
    """部署权重 + 参考音 + config.json 到 GPT-SoVITS/voices/<voice_name>/ 目录"""
    emit("deploy", "start", f"部署到 voices/{voice_name}/...", 95)

    # 新架构：语音统一存储在 GPT-SoVITS/voices/<voice_name>/
    voices_dir = os.path.abspath(
        os.environ.get("USER_VOICES_DIR") or os.path.join(os.path.dirname(gpt_root), "voices")
    )
    voice_dir = os.path.join(voices_dir, voice_name)
    refs_dir = os.path.join(voice_dir, "refs")
    os.makedirs(refs_dir, exist_ok=True)

    # 备份旧的权重（如果有）
    backup_dir = os.path.join(voice_dir, f"backup_{int(time.time())}")
    old_gpt = os.path.join(voice_dir, "gpt.ckpt")
    old_sovits = os.path.join(voice_dir, "sovits.pth")
    if os.path.isfile(old_gpt) or os.path.isfile(old_sovits):
        os.makedirs(os.path.join(backup_dir, "refs"), exist_ok=True)
        if os.path.isfile(old_gpt):
            shutil.copy2(old_gpt, os.path.join(backup_dir, "gpt.ckpt"))
        if os.path.isfile(old_sovits):
            shutil.copy2(old_sovits, os.path.join(backup_dir, "sovits.pth"))
        old_refs = os.path.join(voice_dir, "refs")
        if os.path.isdir(old_refs):
            for f in os.listdir(old_refs):
                if f.endswith(".wav"):
                    shutil.copy2(os.path.join(old_refs, f), os.path.join(backup_dir, "refs", f))
        emit("deploy", "running", f"已备份旧权重到 {os.path.basename(backup_dir)}", 96)

    # 复制新权重（带安全检查，防止 None 或文件不存在导致崩溃）
    if gpt_w and os.path.isfile(gpt_w):
        shutil.copy2(gpt_w, old_gpt)
        emit("deploy", "running", f"GPT 权重已部署: {os.path.basename(gpt_w)}", 97)
    else:
        emit("deploy", "running", f"[警告] GPT 权重缺失（{gpt_w}），跳过部署", 97)
    if sovits_w and os.path.isfile(sovits_w):
        shutil.copy2(sovits_w, old_sovits)
        emit("deploy", "running", f"SoVITS 权重已部署: {os.path.basename(sovits_w)}", 97)
    else:
        raise RuntimeError(f"SoVITS 权重文件不存在: {sovits_w}，无法部署")

    # 复制参考音
    if isinstance(selected_refs, dict):
        for emotion, info in selected_refs.items():
            src = info.get("wav") if isinstance(info, dict) else None
            if src and os.path.isfile(src):
                dst = os.path.join(refs_dir, f"{emotion}_0.wav")
                shutil.copy2(src, dst)
            else:
                emit("deploy", "running", f"[警告] 参考音 {emotion} 源文件缺失，跳过", 98)
    emit("deploy", "running", f"参考音已部署: {len(selected_refs) if isinstance(selected_refs, dict) else 0} 种情感", 98)

    # 生成 config.json
    config = _build_voice_config(voice_name, selected_refs)
    config_path = os.path.join(voice_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    emit("deploy", "running", "config.json 已生成", 99)

    emit("deploy", "done",
         f"部署完成 → {voice_dir}（切换语音即可使用，无需重启 TTS）",
         100, voice_dir=voice_dir)
    return voice_dir


def _build_voice_config(voice_name, selected_refs):
    """生成语音 config.json（8 情感 emotion_profiles）"""
    tts_port = str(os.environ.get("CHATX2_TTS_PORT") or os.environ.get("TTS_PORT") or "9882").strip()
    if not tts_port.isdigit():
        tts_port = "9882"
    # 情感配置模板
    emotion_templates = {
        "comfort": {
            "desc": "安慰/坚定陪伴",
            "character_note": "不是软弱的安慰，是'我在'的力量感",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.95,
            "intensity": "medium", "pause_style": "comfort",
            "ref_candidates": ["gentle", "sad", "neutral"],
        },
        "sad_question": {
            "desc": "伤心后轻声问",
            "character_note": "像怕惊扰对方，小心翼翼地轻声问",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.9,
            "intensity": "medium", "pause_style": "heavy_whisper",
            "ref_candidates": ["sad", "gentle", "neutral"],
        },
        "question": {
            "desc": "温柔关切地问",
            "character_note": "文学少女式的关切，轻柔而不追问",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.95,
            "intensity": "low", "pause_style": "gentle_ask",
            "ref_candidates": ["gentle", "neutral"],
        },
        "gentle": {
            "desc": "温柔/日常",
            "character_note": "文学少女的日常，克制而温暖",
            "temperature": 0.6, "top_p": 0.8, "speed": 1.0,
            "intensity": "low", "pause_style": "medium",
            "ref_candidates": ["gentle", "neutral"],
        },
        "sad": {
            "desc": "悲伤/隐忍",
            "character_note": "刚强的少女不会大哭，是隐忍的、克制的悲伤",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.9,
            "intensity": "medium", "pause_style": "heavy",
            "ref_candidates": ["sad", "gentle", "neutral"],
        },
        "strong": {
            "desc": "刚强/坚定",
            "character_note": "轻柔外表下的钢铁意志，语速慢但有力",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.95,
            "intensity": "medium", "pause_style": "firm",
            "ref_candidates": ["gentle", "neutral"],
        },
        "excited": {
            "desc": "激动/警觉",
            "character_note": "即使激动也是克制的，不会失态",
            "temperature": 0.6, "top_p": 0.8, "speed": 1.05,
            "intensity": "medium", "pause_style": "light",
            "ref_candidates": ["excited", "surprised", "neutral"],
        },
        "shy_happy": {
            "desc": "害羞/小高兴",
            "character_note": "嘴上抱怨心里甜，文学少女的别扭与欢喜",
            "temperature": 0.6, "top_p": 0.8, "speed": 0.95,
            "intensity": "low", "pause_style": "shy",
            "ref_candidates": ["gentle", "sad", "neutral"],
        },
    }

    emotion_profiles = {}
    for emotion, info in selected_refs.items():
        tpl = emotion_templates.get(emotion, emotion_templates["gentle"])
        emotion_profiles[emotion] = {
            **tpl,
            "ref_audio": f"refs/{emotion}_0.wav",
            "prompt_text": info["text"],
        }

    return {
        "voice_name": voice_name,
        "character_name": voice_name,
        "protected": False,
        "inference_mode": "v1_zero_shot_shared_base",
        "shared_sovits": "GPT_SoVITS/pretrained_models/s2G488k.pth",
        "reference_policy": "same_voice_only",
        "gpt_weights": "gpt.ckpt",
        "sovits_weights": "sovits.pth",
        "tts_api": f"http://127.0.0.1:{tts_port}",
        "default_emotion": "auto",
        "lang": "zh",
        "character_core": "轻柔文学少女，内心刚强，喜欢着用户",
        "emotion_profiles": emotion_profiles,
        "globalSpeedOffset": 0.0,
        "globalTempOffset": 0.0,
        "defaultEmotion": "auto",
    }


# ============================================================
# 主流程
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="语音克隆训练流水线 v2")
    parser.add_argument("--voice-name", required=True, help="语音名称（用于命名语音库目录）")
    parser.add_argument("--input", required=True, help="输入路径（视频/音频/已切片目录）")
    parser.add_argument("--project-root", default=None, help="当前应用数据或训练工作目录")
    parser.add_argument("--gpt-sovits-root", default=None, help="GPT-SoVITS 安装目录")
    parser.add_argument("--work-dir", default=None, help="工作目录（默认: voice-cloning/output/train_{voice_name}_{ts}）")
    # 兼容旧参数（可选，不影响新架构）
    parser.add_argument("--char-id", default=None, help="（兼容旧参数，已弃用）")
    parser.add_argument("--char-name", default=None, help="（兼容旧参数，已弃用）")
    parser.add_argument("--device", default="auto", choices=["auto", "gpu", "cpu"],
                        help="处理器选择：auto(自动,优先GPU) / gpu / cpu")
    parser.add_argument("--resume", action="store_true", help="断点续传模式：从 state.json 读取已完成阶段并跳过")
    args = parser.parse_args()

    # 新架构：voice_name 既是语音名称也是训练标识
    voice_name = args.voice_name

    # 断点续传：加载已完成阶段
    global _RESUME, _COMPLETED_STAGES, _STATE_FILE
    _RESUME = args.resume

    emit("init", "start", "初始化训练环境...", 0)

    try:
        # 路径检测
        project_root = args.project_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        gpt_root = detect_gpt_sovits_root(args.gpt_sovits_root)
        if not gpt_root:
            raise RuntimeError("未找到 GPT-SoVITS 安装目录，请用 --gpt-sovits-root 指定")
        # 设置环境变量，让 step2_separate_vocals 等函数能读取
        os.environ["GPT_SOVITS_ROOT"] = gpt_root
        ffmpeg = find_ffmpeg(gpt_root)
        if not ffmpeg:
            raise RuntimeError("未找到 ffmpeg")

        # 工作目录
        if args.work_dir:
            work_dir = os.path.abspath(args.work_dir)
        else:
            ts = int(time.time())
            vc_dir = os.path.join(os.path.dirname(project_root), "voice-cloning")
            # 用 voice_name 生成安全目录名（替换非法字符）
            safe_name = "".join(c for c in voice_name if c.isalnum() or c in "._-") or "voice"
            work_dir = os.path.join(vc_dir, "output", f"train_{safe_name}_{ts}")
        os.makedirs(work_dir, exist_ok=True)

        # 断点续传：读取 state.json
        if _RESUME:
            prev_state = load_state(work_dir)
            if prev_state and "completed_stages" in prev_state:
                _COMPLETED_STAGES = set(prev_state["completed_stages"])
                emit("init", "running",
                     f"断点续传模式：已完成阶段 {sorted(_COMPLETED_STAGES)}，将跳过这些阶段",
                     1)
            else:
                emit("init", "running",
                     f"未找到有效的 state.json，从头开始训练",
                     1)

        save_state(work_dir, "init", "running", voice_name=voice_name, input=args.input, device=args.device, gpt_root=gpt_root)

        emit("init", "running",
             f"项目: {project_root}\n  GPT-SoVITS: {gpt_root}\n  ffmpeg: {ffmpeg}\n  工作目录: {work_dir}\n  输入: {args.input}\n  语音名称: {voice_name}",
             2)
        emit("init", "done", "环境就绪", 5)
        save_state(work_dir, "init", "done", voice_name=voice_name, input=args.input, device=args.device, gpt_root=gpt_root)

        # Step 0: 输入识别
        input_info = step0_detect_input(args.input)

        # Step 1: 音频提取（视频→WAV）
        if is_stage_done("extract"):
            emit("extract", "done", "跳过（已完成）", 10)
            extract_dir = os.path.join(work_dir, "01_extracted")
            audio_files = [os.path.join(extract_dir, f) for f in os.listdir(extract_dir)] if os.path.isdir(extract_dir) else []
        else:
            save_state(work_dir, "extract", "running")
            audio_files = step1_extract_audio(input_info, work_dir, ffmpeg)
            save_state(work_dir, "extract", "done")

        # Step 2: 人声分离
        if is_stage_done("separate"):
            emit("separate", "done", "跳过（已完成）", 20)
            sep_dir = os.path.join(work_dir, "02_separated")
            vocals = [os.path.join(sep_dir, f) for f in os.listdir(sep_dir)] if os.path.isdir(sep_dir) else []
        else:
            save_state(work_dir, "separate", "running")
            vocals = step2_separate_vocals(audio_files, work_dir, input_info, args.device)
            save_state(work_dir, "separate", "done")

        # Step 3: 切片 + 标注
        if is_stage_done("segment"):
            emit("segment", "done", "跳过（已完成）", 35)
            manifest_path = os.path.join(work_dir, "03_segments", "manifest.json")
        else:
            save_state(work_dir, "segment", "running")
            manifest_path = step3_segment_transcribe(vocals, work_dir, input_info, args.device)
            save_state(work_dir, "segment", "done", manifest_path=manifest_path)

        # Step 4: GPT-SoVITS 格式转换（用 voice_name 作为训练标识）
        # resume 完整性校验：即使 state.json 标记 done，但 list 文件可能被清理，
        # 需检查 list_path 实际存在；缺失则重新执行 gpt_prepare
        _expected_list = os.path.join(gpt_root, "GPT_SoVITS", "raw", f"{voice_name}.list")
        if is_stage_done("gpt_prepare") and os.path.isfile(_expected_list):
            emit("gpt_prepare", "done", "跳过（已完成）", 45)
            gpt_output = os.path.join(gpt_root, "GPT_SoVITS", "raw")
            list_path = _expected_list
        else:
            if is_stage_done("gpt_prepare"):
                emit("gpt_prepare", "running", "list 文件缺失，重新生成...", 35)
            save_state(work_dir, "gpt_prepare", "running")
            gpt_output, list_path = step4_gptsovits_prepare(manifest_path, gpt_root, voice_name, ffmpeg)
            save_state(work_dir, "gpt_prepare", "done")

        # Step 5: 预处理 1A/1B/1C
        # resume 完整性校验：检查 preprocess 所有产物是否存在
        # 2-name2text.txt（1A）、4-cnhubert/*.pt（1B）、5-wav32k/*.wav（1B）
        _exp_dir_check = os.path.join(gpt_root, "GPT_SoVITS", "logs", f"{voice_name}_core")
        _txt_ok = os.path.isfile(os.path.join(_exp_dir_check, "2-name2text.txt"))
        _hubert_dir = os.path.join(_exp_dir_check, "4-cnhubert")
        _wav32k_dir = os.path.join(_exp_dir_check, "5-wav32k")
        _hubert_ok = os.path.isdir(_hubert_dir) and len([f for f in os.listdir(_hubert_dir) if f.endswith(".pt")]) > 0
        _wav32k_ok = os.path.isdir(_wav32k_dir) and len([f for f in os.listdir(_wav32k_dir) if f.endswith(".wav")]) > 0
        if is_stage_done("preprocess") and _txt_ok and _hubert_ok and _wav32k_ok:
            emit("preprocess", "done", "跳过（已完成）", 65)
            exp_dir = _exp_dir_check
        else:
            if is_stage_done("preprocess"):
                _missing = []
                if not _txt_ok: _missing.append("2-name2text.txt")
                if not _hubert_ok: _missing.append("4-cnhubert/*.pt")
                if not _wav32k_ok: _missing.append("5-wav32k/*.wav")
                emit("preprocess", "running", f"预处理产物缺失({', '.join(_missing)})，重新执行...", 55)
            save_state(work_dir, "preprocess", "running")
            exp_dir = step5_preprocess(gpt_root, voice_name, list_path)
            save_state(work_dir, "preprocess", "done", exp_dir=exp_dir)

        # Step 6: 训练 SoVITS + GPT
        exp_name = f"{voice_name}_core"
        if is_stage_done("train"):
            # 用 _find_latest_weight 查找实际权重（而非硬编码路径）
            # 防止 state.json 标记 done 但权重实际缺失（如 GPT 训练未执行）
            sovits_w = _find_latest_weight(
                os.path.join(gpt_root, "SoVITS_weights_v3_core"), exp_name, ".pth"
            )
            gpt_w = _find_latest_weight(
                os.path.join(gpt_root, "GPT_weights_v3_core"), exp_name, ".ckpt"
            )
            if sovits_w and gpt_w:
                emit("train", "done", "跳过（已完成）", 85)
            else:
                # 部分权重缺失，重新执行 train（step6_train 会跳过已有的权重）
                _missing = []
                if not sovits_w: _missing.append("SoVITS")
                if not gpt_w: _missing.append("GPT")
                emit("train", "running", f"权重缺失({', '.join(_missing)})，继续训练...", 82)
                save_state(work_dir, "train", "running")
                gpt_w, sovits_w = step6_train(gpt_root, voice_name, exp_dir)
                save_state(work_dir, "train", "done")
        else:
            save_state(work_dir, "train", "running")
            gpt_w, sovits_w = step6_train(gpt_root, voice_name, exp_dir)
            save_state(work_dir, "train", "done")

        # Step 7: 情感参考音选择
        if is_stage_done("refs"):
            # 从 ref_audio 目录重建 selected_refs（step7 把参考音放在 gpt_root/ref_audio/<voice_name>/）
            ref_dir = os.path.join(gpt_root, "ref_audio", voice_name)
            selected_refs = _load_existing_refs(ref_dir)
            if selected_refs:
                emit("refs", "done", f"跳过（已完成，{len(selected_refs)} 种情感）", 92)
            else:
                # ref_audio 目录不存在或为空，需要重新执行 refs
                emit("refs", "running", "参考音产物缺失，重新执行...", 88)
                save_state(work_dir, "refs", "running")
                ref_dir, selected_refs = step7_select_refs(gpt_root, voice_name, manifest_path, gpt_output)
                save_state(work_dir, "refs", "done")
        else:
            save_state(work_dir, "refs", "running")
            ref_dir, selected_refs = step7_select_refs(gpt_root, voice_name, manifest_path, gpt_output)
            save_state(work_dir, "refs", "done")

        # Step 8: 部署到 GPT-SoVITS/voices/<voice_name>/
        if is_stage_done("deploy"):
            emit("deploy", "done", "跳过（已完成）", 99)
        else:
            save_state(work_dir, "deploy", "running")
            step8_deploy(gpt_root, voice_name, project_root,
                         gpt_w, sovits_w, ref_dir, selected_refs)
            save_state(work_dir, "deploy", "done")

        emit("all", "done", f"训练完成！语音已部署到 voices/{voice_name}/，切换语音即可使用。", 100)
        save_state(work_dir, "all", "done")

        # 训练成功后自动清理无用临时文件（失败时保留以供调试）
        try:
            cleanup_temp_files(work_dir, success=True, gpt_root=gpt_root, voice_name=voice_name)
            emit("cleanup", "done", "已清理临时文件（合并wav、训练中间产物、上传音频）", 100)
        except Exception as ce:
            emit("cleanup", "running", f"清理临时文件时出错（不影响训练结果）: {ce}", 100)

    except Exception as e:
        # 失败时也尝试清理 %TEMP% 下的合并 wav（避免磁盘累积），但保留 work_dir 供调试
        try:
            cleanup_temp_files(None, success=False)
        except Exception:
            pass
        emit("all", "error", f"训练失败: {e}\n{traceback.format_exc()[-800:]}", 0)
        sys.exit(1)


def cleanup_temp_files(work_dir, success, gpt_root=None, voice_name=None):
    """训练结束后清理无用临时文件
    - 无论成功失败：删除 %TEMP%\\_vt_merged_*.wav（step0 合并产物）
    - 仅成功时：
      1. 删除 work_dir 下的 01_extracted/02_separated/03_segments
      2. 删除 GPT-SoVITS/logs/<voice>_core 下的训练中间产物
         （logs_s2_v3_lora_*/4-cnhubert/5-wav32k/3-bert/eval，
          这些是训练过程中的临时特征/ checkpoint，训练完成后无用）
      3. 删除 _train_uploads 上传的原始音频
    - 失败时：保留所有产物供调试和断点续传
    """
    # 1. 清理 step0 多文件合并的临时 wav（无论成功失败都清理）
    for tmp_file in _TMP_FILES_TO_CLEANUP:
        try:
            if os.path.isfile(tmp_file):
                os.remove(tmp_file)
        except Exception:
            pass

    # 2. 扫描 %TEMP% 目录下所有 _vt_merged_*.wav（兜底，防止异常未记录到列表）
    try:
        import tempfile as _tempfile
        tmp_dir = _tempfile.gettempdir()
        for f in os.listdir(tmp_dir):
            if f.startswith("_vt_merged_") and f.endswith(".wav"):
                try:
                    os.remove(os.path.join(tmp_dir, f))
                except Exception:
                    pass
    except Exception:
        pass

    # 3. 仅成功时清理（失败时保留供调试和断点续传）
    if not success or not work_dir:
        return

    # 3a. 清理 work_dir 的中间目录
    for sub in ["01_extracted", "02_separated", "03_segments"]:
        d = os.path.join(work_dir, sub)
        try:
            if os.path.isdir(d):
                shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass

    # 3b. 清理 GPT-SoVITS/logs/<voice>_core 下的训练中间产物
    #     这些目录占用大量空间（可达 2GB+），训练完成后不再需要
    if gpt_root and voice_name:
        exp_dir = os.path.join(gpt_root, "GPT_SoVITS", "logs", f"{voice_name}_core")
        if os.path.isdir(exp_dir):
            # 训练中间产物子目录（HuBERT 特征、wav32k、BERT、LoRA checkpoint、eval）
            train_tmp_subs = [
                "logs_s2_v3_lora_32",  # LoRA checkpoint（权重已保存到 SoVITS_weights_v3_core）
                "4-cnhubert",          # HuBERT 特征文件
                "5-wav32k",            # 32kHz wav 中间产物
                "3-bert",              # BERT 特征文件
                "eval",                # 评估产物
            ]
            for sub in train_tmp_subs:
                d = os.path.join(exp_dir, sub)
                try:
                    if os.path.isdir(d):
                        shutil.rmtree(d, ignore_errors=True)
                        emit("cleanup", "running", f"已清理训练中间产物: {sub}", 100)
                except Exception:
                    pass
            # 清理 TensorBoard 事件文件
            try:
                for f in os.listdir(exp_dir):
                    if f.startswith("events.out.tfevents"):
                        os.remove(os.path.join(exp_dir, f))
            except Exception:
                pass

    # 3c. 清理 _train_uploads 上传的原始音频（训练完成后不再需要）
    if gpt_root:
        uploads_dir = os.path.join(os.path.dirname(gpt_root), "voice_engine", "_train_uploads")
        if os.path.isdir(uploads_dir):
            try:
                shutil.rmtree(uploads_dir, ignore_errors=True)
                emit("cleanup", "running", "已清理上传的原始音频", 100)
            except Exception:
                pass


if __name__ == "__main__":
    main()
