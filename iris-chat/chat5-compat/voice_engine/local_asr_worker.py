"""ChatX2 本地短语音识别工作进程。

协议：stdin/stdout 每行一个 JSON。音频通过 base64 进入内存，ffmpeg 在管道中
转成 16 kHz 单声道 WAV；FunASR 只读取本地模型，不进行网络下载。
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path


MODEL_NAMES = {
    "asr": (
        "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    ),
    "vad": ("speech_fsmn_vad_zh-cn-16k-common-pytorch",),
    "punc": (
        "punc_ct-transformer_cn-en-common-vocab471067-large",
        "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    ),
    # SenseVoice-Small：单模型 230MB，自带标点，CTC 推理快，
    # 中文/中英混说/方言口语鲁棒性优于 paraformer 组合。
    "sense_voice": ("SenseVoiceSmall", "sense_voice_small"),
}

_model = None


def _candidate_model_roots() -> list[Path]:
    roots: list[Path] = []
    configured = os.environ.get("CHATX2_ASR_MODEL_ROOT", "").strip()
    if configured:
        roots.append(Path(configured))

    gpt_root = os.environ.get("CHATX2_GPT_SOVITS_ROOT", "").strip()
    if gpt_root:
        roots.append(Path(gpt_root) / "tools" / "asr" / "models")

    # 不隐式读取开发机/用户目录的 ModelScope 缓存。发布包必须只依赖
    # ChatX2 自身或用户明确配置的 CHATX2_ASR_MODEL_ROOT。
    modelscope_cache = os.environ.get("MODELSCOPE_CACHE", "").strip()
    if modelscope_cache:
        roots.append(Path(modelscope_cache) / "hub" / "iic")
        roots.append(Path(modelscope_cache) / "iic")

    unique: list[Path] = []
    for root in roots:
        resolved = root.expanduser().resolve()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def _find_local_model(kind: str) -> Path | None:
    for root in _candidate_model_roots():
        for name in MODEL_NAMES[kind]:
            candidate = root / name
            if candidate.is_dir():
                return candidate
    return None


def _require_local_model(kind: str) -> Path:
    found = _find_local_model(kind)
    if found is not None:
        return found
    searched = ", ".join(str(root) for root in _candidate_model_roots())
    raise RuntimeError(f"缺少本地 {kind.upper()} 模型；已检查：{searched}")


def _load_model():
    global _model
    if _model is not None:
        return _model

    # FunASR/ModelScope 会向 stdout 打印日志；协议 stdout 必须只含 JSON。
    with contextlib.redirect_stdout(sys.stderr):
        from funasr import AutoModel

        device = os.environ.get("CHATX2_ASR_DEVICE", "cpu").strip().lower()
        if device not in {"cpu", "cuda"}:
            device = "cpu"

        # 优先 SenseVoice-Small：单模型自带标点、体积小、推理快。
        # 找不到模型或加载失败时回退 paraformer + VAD + punc 组合。
        sv_path = _find_local_model("sense_voice")
        if sv_path is not None:
            try:
                print(
                    f"[LocalASR] loading SenseVoiceSmall on {device}: {sv_path}",
                    file=sys.stderr,
                    flush=True,
                )
                _model = ("sense_voice", AutoModel(
                    model=str(sv_path),
                    trust_remote_code=True,
                    disable_update=True,
                    disable_pbar=True,
                    device=device,
                ))
                return _model
            except Exception as error:
                print(
                    f"[LocalASR] SenseVoice load failed, fallback to paraformer: {error}",
                    file=sys.stderr,
                    flush=True,
                )

        asr_path = _require_local_model("asr")
        vad_path = _require_local_model("vad")
        punc_path = _require_local_model("punc")
        print(
            f"[LocalASR] loading FunASR on {device}: {asr_path.name}",
            file=sys.stderr,
            flush=True,
        )
        _model = ("paraformer", AutoModel(
            model=str(asr_path),
            vad_model=str(vad_path),
            punc_model=str(punc_path),
            disable_update=True,
            disable_pbar=True,
            device=device,
        ))
    return _model


def _decode_audio(audio: bytes) -> tuple[object, int]:
    import soundfile as sf

    ffmpeg = os.environ.get("CHATX2_FFMPEG_PATH", "").strip()
    if not ffmpeg:
        raise RuntimeError("ChatX2 包内 ffmpeg 不可用，无法解码录音。")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            "pipe:1",
        ],
        input=audio,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=45,
        check=False,
        creationflags=flags,
    )
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"录音解码失败：{detail[-300:] or 'ffmpeg 未返回音频'}")
    waveform, sample_rate = sf.read(io.BytesIO(result.stdout), dtype="float32", always_2d=False)
    if getattr(waveform, "size", 0) == 0:
        raise RuntimeError("录音为空，请重试。")
    return waveform, int(sample_rate)


def _clean_text(value: object) -> str:
    text = str(value or "").strip()
    text = re.sub(r"<\|[^|>]+\|>", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _transcribe(audio: bytes) -> str:
    waveform, sample_rate = _decode_audio(audio)
    if sample_rate != 16000:
        raise RuntimeError(f"音频采样率转换失败：{sample_rate} Hz")
    kind, model = _load_model()
    with contextlib.redirect_stdout(sys.stderr):
        if kind == "sense_voice":
            # SenseVoice rich transcription 自带 <|zh|><|NEUTRAL|> 等
            # 语种/情感标签，_clean_text 会统一剥掉。
            result = model.generate(input=waveform, cache={}, language="auto", use_itn=True)
        else:
            result = model.generate(input=waveform, batch_size_s=30)
    if not result:
        return ""
    first = result[0]
    value = first.get("text", "") if isinstance(first, dict) else first
    return _clean_text(value)


def _respond(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> None:
    _respond({"type": "ready"})
    for raw_line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", ""))
            audio = base64.b64decode(request.get("audioBase64", ""), validate=True)
            if not audio:
                raise RuntimeError("录音为空，请重试。")
            text = _transcribe(audio)
            if not text:
                raise RuntimeError("没有识别到清晰的语音，请重试。")
            _respond({"type": "result", "id": request_id, "success": True, "text": text})
        except Exception as error:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            _respond(
                {
                    "type": "result",
                    "id": request_id,
                    "success": False,
                    "error": str(error) or type(error).__name__,
                }
            )


if __name__ == "__main__":
    main()
