"""
通用包装器：在运行 GPT-SoVITS 脚本前，注入假 librosa 模块
完全避免 numba JIT 与 PyTorch 线程冲突导致的死锁。

用法:
    python run_patched.py <script.py> [args...]
"""
import sys
import os
import types
import importlib.util
import importlib
import importlib.machinery
import runpy
import numpy as np
import scipy.signal
import scipy
import scipy.fft


def _install_headless_gradio_stub():
    """Keep GPT-SoVITS inference importable without shipping the WebUI stack.

    ChatX2 calls the inference functions directly; it never launches the
    Gradio page.  The embedded GPU runtime intentionally does not include the
    large Gradio dependency tree, so provide only the tiny API surface used
    while inference_webui.py builds its optional UI at import time.
    """
    if os.environ.get("CHATX2_HEADLESS_GRADIO", "1").lower() in ("0", "false", "no"):
        return
    try:
        import gradio  # noqa: F401
        print("[run_patched] gradio import succeeded", flush=True)
        return
    except Exception as exc:
        print(f"[run_patched] gradio import failed: {exc}", flush=True)
        pass

    class _Component:
        def __init__(self, *args, **kwargs):
            self.value = kwargs.get("value")
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def click(self, *args, **kwargs):
            return self
        def change(self, *args, **kwargs):
            return self

    class _Blocks(_Component):
        def queue(self, *args, **kwargs):
            return self
        def launch(self, *args, **kwargs):
            return self

    class _GradioStub(types.ModuleType):
        def __init__(self):
            super().__init__("gradio")
            self.__path__ = []
            self.Blocks = _Blocks
            for name in ("Group", "Row", "Column", "Markdown", "Dropdown",
                         "Button", "Audio", "Checkbox", "File", "Textbox",
                         "Radio", "Slider"):
                setattr(self, name, _Component)
        @staticmethod
        def Warning(message):
            print(f"[TTS] {message}", flush=True)

    sys.modules["gradio"] = _GradioStub()
    print("[run_patched] headless gradio stub enabled", flush=True)

_install_headless_gradio_stub()

# 禁用 numba JIT 缓存 & 限制线程，避免与 PyTorch 线程冲突
os.environ.setdefault("NUMBA_DISABLE_CACHE", "1")
os.environ.setdefault("NUMBA_NUM_THREADS", "1")
# 不设置 NUMBA_THREADING_LAYER：'sync' 是无效值会报错，用 numba 默认值即可

# 如果设置了 RUN_PATCHED_SKIP_TORCH，跳过 torch 预加载
if not os.environ.get("RUN_PATCHED_SKIP_TORCH"):
    try:
        import torch  # 预加载 PyTorch，抢占线程资源
        try:
            import torch._dynamo._trace_wrapped_higher_order_op as _torch_hop
            if not hasattr(_torch_hop, "TransformGetItemToIndex"):
                class TransformGetItemToIndex:
                    def __enter__(self): return self
                    def __exit__(self, *exc): return False
                _torch_hop.TransformGetItemToIndex = TransformGetItemToIndex
        except Exception:
            pass
    except:
        pass


def _patched_resample(y, orig_sr, target_sr):
    """用 scipy.signal.resample_poly 替代 librosa.resample"""
    return scipy.signal.resample_poly(y, target_sr, orig_sr)


def _fake_normalize(S, norm=np.inf, axis=0, threshold=None, fill=None):
    """简化的 librosa.util.normalize"""
    if threshold is None:
        threshold = 1e-10
    mag = np.abs(S).astype(float)
    scale = np.max(mag, axis=axis, keepdims=True)
    scale[scale < threshold] = 1.0
    return S / scale


def _fake_pad_center(data, size, axis=-1):
    """简化的 librosa.util.pad_center"""
    n = data.shape[axis]
    if n > size:
        raise ValueError(f"Target size ({size}) is smaller than input size ({n})")
    if n == size:
        return data
    left = (size - n) // 2
    right = size - n - left
    pad_width = [(0, 0)] * data.ndim
    pad_width[axis] = (left, right)
    return np.pad(data, pad_width, mode="constant")


def _fake_tiny(x):
    """librosa.util.tiny: 返回最小正数"""
    if not np.issubdtype(np.asarray(x).dtype, np.floating):
        x = np.float32(x)
    return np.finfo(x.dtype).tiny


def _fake_mel(sr, n_fft, n_mels=128, fmin=0.0, fmax=None, htk=False, norm="slaney", dtype=np.float32):
    """简化的 librosa.filters.mel: 生成 mel 滤波器组"""
    if fmax is None:
        fmax = float(sr) / 2
    # 简化实现：生成三角滤波器
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


def _fake_get_duration(y=None, sr=22050):
    """librosa.get_duration: 返回音频时长(秒)"""
    if y is None:
        return 0.0
    return len(y) / sr


def _fake_pitch_shift(y, sr, n_steps, bins_per_octave=12, **kwargs):
    """Pitch-shift audio without importing librosa/numba.

    The embedded runtime intentionally replaces librosa with this lightweight
    module.  torchaudio is already part of both bundled CPU/GPU runtimes and
    provides the same length-preserving effect used by the TTS tuning panel.
    Fractional slider values are blended between neighboring integer steps
    because the bundled torchaudio operator accepts integer steps; zero remains
    a no-op.
    """
    import torch
    import torchaudio

    source = np.asarray(y, dtype=np.float32)
    original_shape = source.shape
    if source.ndim == 1:
        waveform = torch.from_numpy(source).unsqueeze(0)
    elif source.ndim == 2:
        waveform = torch.from_numpy(source)
    else:
        raise ValueError("pitch_shift expects a mono or channel-first waveform")

    try:
        steps_value = float(n_steps)
    except (TypeError, ValueError):
        steps_value = 0.0
    direction = -1 if steps_value < 0 else 1
    magnitude = abs(steps_value)
    lower = int(np.floor(magnitude))
    fraction = magnitude - lower

    def apply_integer_step(step):
        if step == 0:
            return waveform
        with torch.inference_mode():
            return torchaudio.functional.pitch_shift(
                waveform,
                sample_rate=int(sr),
                n_steps=direction * step,
                bins_per_octave=int(bins_per_octave),
            )

    lower_waveform = apply_integer_step(lower)
    if fraction > 1e-5:
        upper_waveform = apply_integer_step(lower + 1)
        shifted = lower_waveform * (1.0 - fraction) + upper_waveform * fraction
    else:
        shifted = lower_waveform
    result = shifted.detach().cpu().numpy().astype(np.float32, copy=False)
    if len(original_shape) == 1:
        return result[0]
    return result


def _fake_load(path, sr=22050, mono=True, offset=0.0, duration=None, dtype=np.float32):
    """简化的 librosa.load：用 soundfile 读取 + scipy 重采样"""
    import soundfile as sf
    info = sf.info(path)
    orig_sr = info.samplerate
    start = int(offset * orig_sr) if offset else 0
    if duration is not None:
        frames = int(duration * orig_sr)
    else:
        frames = -1
    y, sr_orig = sf.read(path, start=start, frames=frames, dtype="float32")
    if mono and len(y.shape) > 1:
        y = y.mean(axis=1)
    if sr is not None and sr != sr_orig:
        y = scipy.signal.resample_poly(y, sr, sr_orig)
    return y, sr


# ============================================================
# 构建假 librosa 模块树
# ============================================================
_fake_librosa = types.ModuleType("librosa")
_fake_librosa.__spec__ = importlib.machinery.ModuleSpec("librosa", loader=None, is_package=True)
_fake_librosa.__path__ = []
_fake_librosa.__file__ = "<fake_librosa>"
_fake_librosa.resample = _patched_resample
_fake_librosa.get_duration = _fake_get_duration
_fake_librosa.load = _fake_load

# librosa.util
_fake_util = types.ModuleType("librosa.util")
_fake_util.__spec__ = importlib.machinery.ModuleSpec("librosa.util", loader=None, is_package=True)
_fake_util.__path__ = []
_fake_util.normalize = _fake_normalize
_fake_util.pad_center = _fake_pad_center
_fake_util.tiny = _fake_tiny
_fake_librosa.util = _fake_util

# librosa.filters
_fake_filters = types.ModuleType("librosa.filters")
_fake_filters.__spec__ = importlib.machinery.ModuleSpec("librosa.filters", loader=None, is_package=True)
_fake_filters.__path__ = []
_fake_filters.mel = _fake_mel
_fake_librosa.filters = _fake_filters

# librosa.effects (used only for optional pitch tuning in ChatX2)
_fake_effects = types.ModuleType("librosa.effects")
_fake_effects.__spec__ = importlib.machinery.ModuleSpec("librosa.effects", loader=None, is_package=True)
_fake_effects.__path__ = []
_fake_effects.pitch_shift = _fake_pitch_shift
_fake_librosa.effects = _fake_effects

# 注入到 sys.modules
sys.modules["librosa"] = _fake_librosa
sys.modules["librosa.util"] = _fake_util
sys.modules["librosa.filters"] = _fake_filters
sys.modules["librosa.effects"] = _fake_effects

print("[run_patched] 已注入假 librosa 模块（resample/util/filters.mel/effects.pitch_shift）", flush=True)
print("[run_patched] NUMBA_DISABLE_CACHE=1", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python run_patched.py <script.py> [args...]")
        sys.exit(1)
    script = sys.argv[1]
    sys.argv = [script] + sys.argv[2:]
    print(f"[run_patched] 运行: {script}", flush=True)
    runpy.run_path(script, run_name="__main__")
