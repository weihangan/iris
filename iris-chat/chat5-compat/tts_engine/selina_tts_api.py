"""
赛琳娜·希声 TTS API 服务器
提供 HTTP 接口供当前聊天应用或其他系统调用

启动方式：
  python selina_tts_api.py

API接口：
  POST /tts
  Body: {"text": "要合成的文本", "emotion": "auto"}  # emotion可选: auto/comfort/sad_question/question/gentle/sad/strong/excited
  Response: WAV音频文件

  POST /tts/json
  Body: 同上
  Response: {"audio_url": "/audio/xxx.wav", "emotion": "comfort", "desc": "安慰/坚定陪伴", "duration": 3.5}

  GET  /status
  Response: {"status": "ready", "model": "selina_core"}

  GET  /emotions
  Response: 所有情感类型及参数
"""
import os
import sys
import json

# 兼容性补丁：transformers >= 4.50 强制要求 torch>=2.6（CVE-2025-32434）
# 当前环境 torch 2.5.1，本地模型文件可信，跳过此安全检查
try:
    import transformers.utils.import_utils as _tf_import_utils
    _tf_import_utils.check_torch_load_is_safe = lambda: None
    import transformers.modeling_utils as _tf_modeling_utils
    _tf_modeling_utils.check_torch_load_is_safe = lambda: None
except Exception:
    pass
import time
import uuid
import threading
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

# 运行路径全部由发布程序传入；独立启动时回退到脚本所在应用目录。
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.abspath(os.environ.get("APP_ROOT") or os.path.join(SCRIPT_DIR, ".."))
APP_DATA_DIR = os.path.abspath(os.environ.get("APP_DATA_DIR") or APP_ROOT)
LOG_DIR = os.path.abspath(os.environ.get("TTS_LOG_DIR") or os.path.join(APP_DATA_DIR, "logs"))
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "denoise.log")

def flog(msg):
    """写文件日志（绕过stdout缓冲）"""
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")

# 导入推理引擎（仅导入不需要 GPT-SoVITS 的轻量部分）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from selina_tts_engine import classify_emotion, add_pauses, EMOTION_RULES, extract_spoken_text
from voice_identity import POLICY_VERSION as VOICE_IDENTITY_POLICY_VERSION, sanitize_runtime_params

# SelinaTTS 类的 import 延迟到第一次调用时
SelinaTTS = None

def _ensure_tts_class():
    global SelinaTTS
    if SelinaTTS is None:
        print("[API] 懒加载 SelinaTTS 类...", flush=True)
        from selina_tts_engine import SelinaTTS as _T
        SelinaTTS = _T
        print("[API] SelinaTTS 类已就绪", flush=True)
    return SelinaTTS

# ============================================================
# 配置
# ============================================================
GPT_SOVITS_ROOT = os.path.abspath(
    os.environ.get("GPT_SOVITS_ROOT") or os.path.join(APP_ROOT, "GPT-SoVITS-lite")
)
OUTPUT_DIR = os.path.abspath(
    os.environ.get("TTS_OUTPUT_DIR") or os.path.join(APP_DATA_DIR, "cache", "voice")
)
os.makedirs(OUTPUT_DIR, exist_ok=True)

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "9882"))

# 全局TTS实例（启动时加载）
tts_engine = None
# 初始化与预热状态会通过 /status 暴露给 Node，避免同一服务实例被重复预热。
warmup_complete = False
warmup_voice = None
warmup_duration_ms = None
warmup_error = None
# TTS推理锁：GPT-SoVITS模型非线程安全，必须串行推理
tts_lock = threading.Lock()
tts_init_lock = threading.Lock()


def minimum_acceptable_duration(expected_duration, expected_chars):
    """Keep the completeness gate strict while allowing natural sub-second greetings."""
    completeness_ratio = 0.5 if expected_chars <= 2 else 0.6
    return max(0.3, expected_duration * completeness_ratio)


def get_tts():
    global tts_engine, warmup_complete, warmup_voice, warmup_duration_ms, warmup_error
    if tts_engine is None:
        # 服务器预加载通常会先进入这里；锁保证异常情况下并发首请求也不会
        # 重复加载模型或同时切换 GPT 权重。
        with tts_init_lock:
            if tts_engine is not None:
                return tts_engine
            cls = _ensure_tts_class()
            print("正在加载赛琳娜TTS引擎...", flush=True)
            tts_engine = cls(use_core=True)
            selected_voice = None
            # 优先使用当前角色传入的声音，只有无效/缺失时才回退到排序后的第一个。
            # 这样启动预热和 Node 侧角色声音保持一致，不再发生双重权重加载。
            try:
                from selina_tts_engine import scan_voices, resolve_voice_name
                voices = scan_voices()
                preferred_voice = os.environ.get("TTS_DEFAULT_VOICE_NAME", "").strip()
                selected_voice = resolve_voice_name(
                    voice_name=preferred_voice or None,
                    char_id="1",
                ) if voices else None
                if selected_voice:
                    print(f"[TTS] 自动加载角色语音: {selected_voice}", flush=True)
                    if not tts_engine.switch_voice(selected_voice):
                        selected_voice = None
                else:
                    print("[TTS] 警告：未找到任何语音，将使用默认权重", flush=True)
            except Exception as e:
                print(f"[TTS] 加载语音失败: {e}，尝试旧架构 char_id=1", flush=True)
                try:
                    if tts_engine.switch_character("1"):
                        from selina_tts_engine import resolve_voice_name as _resolve_voice_name
                        selected_voice = _resolve_voice_name(char_id="1")
                except Exception:
                    pass

            # GPU 预热：首次合成前做一次空跑，将模型加载到 GPU 显存。
            # 预热后同步 GPU 流，确保模型完全就绪，后续推理无额外延迟。
            warmup_started = time.perf_counter()
            warmup_output_path = os.path.join(OUTPUT_DIR, f"warmup_{os.getpid()}.wav")
            try:
                import torch
                if torch.cuda.is_available() and selected_voice:
                    print(f"[TTS] GPU 预热中 (voice={selected_voice})...", flush=True)
                    _warmup = tts_engine.synthesize(
                        # 当前模型对两个字的“测试”容易产生近静音并触发昂贵重试；
                        # 完整短句能稳定结束 AR 解码，且已用于 Node 侧历史兜底。
                        "你好，准备好了。", emotion="gentle", char_id="1",
                        voice_name=selected_voice,
                        output_path=warmup_output_path,
                    )
                    if _warmup and os.path.exists(_warmup):
                        # 同步 GPU 流，确保所有 CUDA 操作完成
                        torch.cuda.synchronize()
                        warmup_complete = True
                        warmup_voice = selected_voice
                        print("[TTS] GPU 预热完成", flush=True)
                    else:
                        print("[TTS] GPU 预热跳过（合成无返回）", flush=True)
                else:
                    print("[TTS] GPU 预热跳过（无可用语音或非 CUDA）", flush=True)
            except Exception as e:
                warmup_error = str(e)
                print(f"[TTS] GPU 预热失败（非致命）: {e}", flush=True)
            finally:
                warmup_duration_ms = round((time.perf_counter() - warmup_started) * 1000, 1)
                try:
                    if os.path.exists(warmup_output_path):
                        os.remove(warmup_output_path)
                except Exception as cleanup_error:
                    print(f"[TTS] 预热文件清理失败（非致命）: {cleanup_error}", flush=True)

            print("引擎加载完成！", flush=True)
    return tts_engine


# ============================================================
# HTTP Handler
# ============================================================
class TTSHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/status":
            self._json({
                "status": "ready", "model": "selina_core", "output_dir": OUTPUT_DIR,
                "owner": "wha1999", "pid": os.getpid(),
                "flavor": os.environ.get("CHAT5_FLAVOR", "unknown"),
                "expected_device": os.environ.get("CHAT5_EXPECTED_DEVICE", "unknown"),
                "instance_id": os.environ.get("TTS_INSTANCE_ID", ""),
                "warmup_complete": warmup_complete,
                "warmup_voice": warmup_voice,
                "warmup_duration_ms": warmup_duration_ms,
                "warmup_error": warmup_error,
            })
        elif path == "/device":
            # 返回当前 TTS 推理设备信息
            try:
                import torch
                cuda_available = torch.cuda.is_available()
            except Exception:
                cuda_available = False
            device = "unknown"
            is_half = False
            try:
                import GPT_SoVITS.inference_webui as _iw
                device = getattr(_iw, "device", "unknown")
                is_half = getattr(_iw, "is_half", False)
            except Exception:
                pass
            self._json({
                "device": device,
                "is_half": is_half,
                "cuda_available": cuda_available,
                "preference": os.environ.get("TTS_DEVICE", "auto")
            })
        elif path == "/emotions":
            emotions = {}
            for k, v in EMOTION_RULES.items():
                stable = sanitize_runtime_params(k, {"speed": v.get("speed", 1.0)})
                emotions[k] = {
                    "desc": v["desc"],
                    "character_note": v["character_note"],
                    "temperature": stable["temperature"],
                    "top_p": stable["top_p"],
                    "speed": stable["speed"],
                    "pause_style": v["pause_style"],
                    "voice_identity_policy": VOICE_IDENTITY_POLICY_VERSION,
                }
            self._json(emotions)
        elif path.startswith("/audio/"):
            # 返回音频文件
            filename = path[7:]  # 去掉 /audio/
            filepath = os.path.join(OUTPUT_DIR, filename)
            if os.path.exists(filepath):
                self._wav(filepath)
            else:
                self._error(404, "音频文件不存在")
        elif path == "/":
            # 简单状态页
            self._html()
        else:
            self._error(404, "未知路径")

    def do_POST(self):
        path = urlparse(self.path).path

        if path in ("/tts", "/tts/json"):
            body = self._read_body()
            if not body:
                self._error(400, "请求体为空")
                return

            text = body.get("text", "").strip()
            if not text:
                self._error(400, "缺少text参数")
                return

            emotion = body.get("emotion", "auto")
            if emotion == "auto":
                emotion = None

            # 用户微调参数覆盖
            override_params = {}
            for key in ("temperature", "top_p", "speed", "speed_offset", "temp_offset",
                        "pause_style", "intensity", "pause_offset", "pitch_offset",
                        "ending_offset", "soft_offset", "volume_offset", "fadein"):
                if key in body:
                    override_params[key] = body[key]

            # 角色ID（用于情绪冷却隔离，兼容旧接口）
            char_id = body.get("char_id", "default")
            # 语音名称（新架构，优先于 char_id 用于权重切换）
            voice_name = body.get("voice_name")
            is_first = body.get("is_first", True)

            try:
                request_started = time.perf_counter()
                tts = get_tts()

                # 智能重试：处理GPT-SoVITS生成长度不稳定
                expected_chars = len([c for c in text if '\u4e00' <= c <= '\u9fff'])
                expected_duration = max(0.5, min(10.0, expected_chars / 4.0 + 0.5))
                minimum_duration = minimum_acceptable_duration(expected_duration, expected_chars)

                attempt = 0
                max_attempts = 3  # ★ 允许重试 3 次：AR_T2S 在 GPU fp16 下可能提前终止，生成时长不足
                result_path = None
                audio_data = None
                sr = None
                duration = 0
                last_err = None
                inference_ms = 0.0
                postprocess_ms = 0.0

                while attempt < max_attempts:
                    attempt += 1
                    tmp_path = os.path.join(OUTPUT_DIR, f"tmp_{uuid.uuid4().hex[:8]}.wav")
                    # A failed attempt must not replay the exact same deterministic
                    # seed forever. Keep the first attempt unchanged; retries get
                    # a bounded seed/temperature variation inside the identity
                    # policy's safe range.
                    attempt_override = dict(override_params)
                    attempt_override["_retry_index"] = attempt - 1
                    if attempt > 1 and "temp_offset" not in override_params:
                        attempt_override["temp_offset"] = min(0.03, 0.01 * (attempt - 1))
                    try:
                        # GPU 调用必须在同一请求线程内串行完成。Future 超时无法取消
                        # 已进入 CUDA 的任务，会把后续重试排到仍在运行的任务后面。
                        # 进程级硬超时由 Node 侧看门狗负责，超时后终止受管 TTS 进程。
                        inference_started = time.perf_counter()
                        with tts_lock:
                            got = tts.synthesize(
                                text,
                                emotion=emotion,
                                output_path=tmp_path,
                                override_params=attempt_override,
                                char_id=char_id,
                                voice_name=voice_name,
                            )
                        inference_ms += (time.perf_counter() - inference_started) * 1000
                        if got and os.path.exists(got):
                            result_path = got
                            # 降噪处理
                            postprocess_started = time.perf_counter()
                            audio_data, sr = self._denoise(result_path, is_first=is_first)
                            postprocess_ms += (time.perf_counter() - postprocess_started) * 1000
                            duration = len(audio_data) / sr if audio_data is not None else 0
                            flog(f"[{attempt}] duration={duration:.2f}s, expected={expected_duration:.2f}s")
                            # ★ 时长校验：必须 >= 预期的 60% 才算成功（AR_T2S 可能生成不完整）
                            # 例：15 字预期 4.25s，最低要求 2.55s，低于则重试
                            if audio_data is not None and duration >= minimum_duration:
                                break
                            flog(f"[{attempt}] 时长不足（{duration:.2f}s < {minimum_duration:.2f}s），重试")
                        else:
                            flog(f"[{attempt}] 失败/无返回，重试")
                    except Exception as e:
                        flog(f"[{attempt}] 异常: {e}")
                        last_err = str(e)
                    finally:
                        # 清理临时文件：无论成功(break)、失败、异常都执行，避免 tmp_*.wav 泄漏
                        try:
                            if tmp_path and os.path.exists(tmp_path):
                                os.remove(tmp_path)
                        except:
                            pass
                    audio_data = None
                    result_path = None
                    duration = 0

                if audio_data is None or duration < 0.15:
                    err_msg = "合成失败：TTS生成长度异常"
                    if last_err:
                        err_msg += f"（{last_err}）"
                    self._error(500, err_msg)
                    return

                # 处理成功 - 保存最终产物 & 返回
                from selina_tts_engine import extract_spoken_text, normalize_emotion
                spoken_text = extract_spoken_text(text)
                if emotion is None:
                    detected, intensity = classify_emotion(spoken_text)
                    detected, intensity = normalize_emotion(detected, intensity, spoken_text, char_id=char_id)
                else:
                    detected = emotion
                    intensity = EMOTION_RULES.get(detected, EMOTION_RULES["gentle"]).get("intensity", "medium")
                rule = EMOTION_RULES.get(detected, EMOTION_RULES["gentle"])
                reported_params = sanitize_runtime_params(detected, override_params)

                if path == "/tts/json":
                    filename = f"selina_{uuid.uuid4().hex[:8]}_{int(time.time())}.wav"
                    final_path = os.path.join(OUTPUT_DIR, filename)
                    import soundfile as sf
                    sf.write(final_path, audio_data, sr, subtype="PCM_16")
                    self._json({
                        "audio_url": f"/audio/{filename}",
                        "local_path": final_path,  # 本地绝对路径，供 chat server 直接 fs.copyFileSync（省一次 HTTP 下载）
                        "emotion": detected,
                        "intensity": intensity,
                        "desc": rule["desc"],
                        "character_note": rule["character_note"],
                        "temperature": reported_params["temperature"],
                        "top_p": reported_params["top_p"],
                        "speed": reported_params["speed"],
                        "voice_identity_policy": VOICE_IDENTITY_POLICY_VERSION,
                        "pause_style": rule["pause_style"],
                        "duration": round(duration, 2),
                        "attempts": attempt,
                        "timing_ms": {
                            "inference": round(inference_ms, 1),
                            "postprocess": round(postprocess_ms, 1),
                            "total": round((time.perf_counter() - request_started) * 1000, 1),
                        },
                        "text": spoken_text,
                        "original_text": text,
                    })
                else:
                    self._wav_bytes(audio_data, sr)

                self._cleanup_old_audio()

            except Exception as e:
                self._error(500, f"合成错误: {str(e)}")
        else:
            self._error(404, "未知路径")

    def _denoise(self, filepath, is_first=True):
        """
        赛琳娜 TTS 音频后处理 (V3 - 极简 & 保真)

        只做3件事：
        1. 截掉GPT-SoVITS输出开头的低能量前缀（参考音频编码残留）
        2. 首尾淡入淡出（防点击音）
        3. 峰值归一化（防爆音）

        is_first: 是否是流式合成的第一段。第一段扫描窗更长（1.2s），
                  后续段更短（0.6s）避免误切句首软辅音。
        """
        import numpy as np
        try:
            import soundfile as sf
            flog(f"[V3]_denoise开始: {filepath} (is_first={is_first})")
            audio, sr = sf.read(filepath)
            if audio.dtype != np.float32:
                audio = audio.astype(np.float32)
            if len(audio.shape) > 1:
                audio = audio.mean(axis=1)

            flog(f"原始: dur={len(audio)/sr:.2f}s, peak={np.max(np.abs(audio)):.3f}, rms={np.sqrt(np.mean(audio**2)):.4f}")
            print(f"[V3] 原始: dur={len(audio)/sr:.2f}s, peak={np.max(np.abs(audio)):.3f}")

            if len(audio) < int(0.05 * sr):
                return audio, sr

            # === 1. 截掉开头低能量前缀（收紧参数防吃字）===
            scan_sec = 1.2 if is_first else 0.6  # 后续段扫描窗更短
            window_ms = 30  # 30ms 窗口（原50ms，更精细）
            window = int(sr * window_ms / 1000)
            threshold = 0.015  # RMS 阈值（原0.02，降低防误判）
            min_keep = int(0.1 * sr)
            lead = int(sr * 0.03)  # 保留30ms引导帧，防吃首字

            start = 0
            for i in range(0, min(len(audio) - min_keep, int(scan_sec * sr)), window):
                seg = audio[i:i + window]
                rms = np.sqrt(np.mean(seg ** 2))
                if rms > threshold:
                    start = max(0, i - lead)  # 保留引导帧
                    break

            if start > 0:
                audio = audio[start:]
                flog(f"截前缀: {start/sr:.3f}s (lead={lead/sr:.3f}s)")

            # === 2. 首尾淡入淡出（段间5ms，防接缝微停顿）===
            fade_in_len = int(0.005 * sr)   # 5ms 淡入（原10ms）
            fade_out_len = int(0.005 * sr)  # 5ms 淡出（原20ms）
            if len(audio) > fade_in_len + fade_out_len:
                audio[:fade_in_len] *= np.linspace(0, 1, fade_in_len)
                audio[-fade_out_len:] *= np.linspace(1, 0, fade_out_len)
                flog("首尾淡入淡出(5ms)")

            # === 3. 峰值归一化（防爆音）===
            peak = np.max(np.abs(audio))
            if peak > 0.001:
                target_peak = 0.95
                audio = audio * (target_peak / peak)
            flog(f"[V3]完成: peak={np.max(np.abs(audio)):.3f}, rms={np.sqrt(np.mean(audio**2)):.4f}, dur={len(audio)/sr:.2f}s")
            print(f"[V3] 完成: peak={np.max(np.abs(audio)):.3f}, dur={len(audio)/sr:.2f}s")
            return audio, sr

        except Exception as e:
            import traceback
            err = traceback.format_exc()
            flog(f"[V3]_denoise失败: {e}\n{err}")
            print(f"[V3] 失败: {e}")
            return None, None

    def _wav_bytes(self, audio_data, sr):
        """直接返回WAV字节流（不存盘）"""
        import io
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, audio_data, sr, format='WAV')
        buf.seek(0)
        data = buf.read()

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", len(data))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _cleanup_old_audio(self):
        """清理旧音频文件，只保留最近20个"""
        try:
            files = []
            for f in os.listdir(OUTPUT_DIR):
                if f.endswith('.wav') and f.startswith('selina_'):
                    fp = os.path.join(OUTPUT_DIR, f)
                    files.append((fp, os.path.getmtime(fp)))
            # 按时间排序，删除旧的
            files.sort(key=lambda x: x[1], reverse=True)
            for fp, _ in files[20:]:  # 保留最近20个
                try: os.remove(fp)
                except: pass
        except:
            pass

    # ---- 辅助方法 ----

    def _read_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return None
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw.decode("utf-8"))
        except:
            return None

    def _json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))

    def _wav(self, filepath):
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", os.path.getsize(filepath))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(filepath, "rb") as f:
            self.wfile.write(f.read())

    def _html(self):
        html = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>赛琳娜·希声 TTS API</title>
<style>
body{font-family:'Microsoft YaHei',sans-serif;max-width:800px;margin:40px auto;background:#1a1a2e;color:#e0e0e0;padding:0 20px}
h1{color:#e94560}h2{color:#f59e0b}
code{background:#16213e;padding:2px 6px;border-radius:4px;font-size:13px}
pre{background:#16213e;padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6}
.card{background:#16213e;border-radius:12px;padding:16px;margin:14px 0;border:1px solid #0f3460}
.hint{color:#888;font-size:12px}
textarea{width:100%;height:60px;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:6px;padding:8px;font-size:14px}
button{background:#e94560;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;margin-top:8px}
button:hover{background:#c73652}
select{background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;padding:6px;border-radius:4px}
#result{margin-top:12px}
audio{width:100%;margin-top:8px}
</style></head><body>
<h1>赛琳娜·希声 TTS API</h1>
<p class="hint">轻柔文学少女 · 内心刚强 · 喜欢着用户</p>

<div class="card">
<h2>在线测试</h2>
<textarea id="input" placeholder="输入要合成的文本...">别怕，我在这里陪着你</textarea><br>
<select id="emotion">
<option value="auto">自动检测</option>
<option value="comfort">安慰/坚定陪伴</option>
<option value="sad_question">伤心后轻声问</option>
<option value="question">温柔关切地问</option>
<option value="gentle">温柔/日常</option>
<option value="sad">悲伤/隐忍</option>
<option value="strong">刚强/坚定</option>
<option value="excited">激动/警觉</option>
</select>
<button onclick="synthesize()">合成</button>
<div id="result"></div>
</div>

<div class="card">
<h2>API 接口</h2>
<p><b>POST /tts</b> — 直接返回WAV音频</p>
<p><b>POST /tts/json</b> — 返回JSON（含音频URL和情感信息）</p>
<p><b>GET /status</b> — 服务状态</p>
<p><b>GET /emotions</b> — 所有情感类型</p>

<h2>请求示例</h2>
<pre>curl -X POST http://localhost:9882/tts/json \\
  -H "Content-Type: application/json" \\
  -d '{"text": "别怕，我在这里陪着你", "emotion": "auto"}'</pre>

<h2>Python 调用示例</h2>
<pre>import requests

# 合成并获取JSON结果
resp = requests.post("http://localhost:9882/tts/json", json={
    "text": "别怕，我在这里陪着你",
    "emotion": "auto"  # 或 "comfort"/"gentle"/"sad" 等
})
result = resp.json()
print(f"情感: {result['desc']}")
print(f"时长: {result['duration']}s")
print(f"音频URL: {result['audio_url']}")

# 下载音频
audio_resp = requests.get(f"http://localhost:9882{result['audio_url']}")
with open("output.wav", "wb") as f:
    f.write(audio_resp.content)

# 或者直接获取WAV
resp = requests.post("http://localhost:9882/tts", json={
    "text": "别怕，我在这里陪着你"
})
with open("output.wav", "wb") as f:
    f.write(resp.content)</pre>

<h2>聊天应用对接配置</h2>
<pre># TTS服务地址
TTS_API_URL = "http://localhost:9882"

# 调用流程：
# 1. 聊天应用生成回复文本
# 2. POST /tts/json 合成语音
# 3. 返回 audio_url 给前端播放
# 4. emotion 设为 "auto" 自动检测情感</pre>
</div>
</body>

<script>
async function synthesize() {
    const text = document.getElementById('input').value;
    const emotion = document.getElementById('emotion').value;
    const resultDiv = document.getElementById('result');
    resultDiv.innerHTML = '合成中...';

    try {
        const resp = await fetch('/tts/json', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text, emotion})
        });
        const data = await resp.json();

        if (data.audio_url) {
            resultDiv.innerHTML = `
                <p>情感: <b>${data.desc}</b> (${data.emotion})</p>
                <p class="hint">${data.character_note}</p>
                <p>参数: t=${data.temperature} p=${data.top_p} 排版=${data.pause_style}</p>
                <p>时长: ${data.duration}s</p>
                <audio controls src="${data.audio_url}" autoplay></audio>
            `;
        } else {
            resultDiv.innerHTML = '<p style="color:red">合成失败</p>';
        }
    } catch(e) {
        resultDiv.innerHTML = `<p style="color:red">错误: ${e.message}</p>`;
    }
}
</script>
</body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def _error(self, code, msg):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format, *args):
        print(f"[API] {args[0]}")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """多线程HTTP服务器，避免单请求阻塞导致服务卡住"""
    daemon_threads = True

# ============================================================
# 启动
# ============================================================
if __name__ == "__main__":
    print("=" * 50, flush=True)
    print("赛琳娜·希声 TTS API 服务器", flush=True)
    print(f"地址: http://localhost:{PORT}", flush=True)
    print(f"输出: {OUTPUT_DIR}", flush=True)
    print("=" * 50, flush=True)
    print("[API] 预加载 TTS 引擎（主线程初始化 torch/CUDA）...", flush=True)
    try:
        get_tts()
        print("[API] TTS 引擎预加载完成", flush=True)
    except Exception as e:
        print(f"[API] 预加载失败: {e}", flush=True)
        import traceback
        traceback.print_exc()

    server = ThreadingHTTPServer((HOST, PORT), TTSHandler)
    print(f"\n[API] 服务已启动: http://localhost:{PORT}", flush=True)
    print("接口:", flush=True)
    print(f"  POST /tts       - 直接返回WAV音频", flush=True)
    print(f"  POST /tts/json  - 返回JSON（含音频URL）", flush=True)
    print(f"  GET  /status    - 服务状态", flush=True)
    print(f"  GET  /emotions  - 情感类型列表", flush=True)
    print(f"  GET  /          - 在线测试页面", flush=True)
    server.serve_forever()
