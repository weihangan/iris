"""
TTS 单段耗时 profiling 探针
打点 AR (T2S) / CFM 扩散 / BigVGAN 声码三段耗时
通过 monkey-patch inference_webui 内部函数，不修改 GPT-SoVITS 源码

用法：
  from profiling_probe import install_probe
  install_probe()  # 在 TTS 引擎加载后调用一次

注意：探针输出同时写 stdout 和 probe.log 文件，方便无法看到 TTS 服务 stdout 时排查
"""
import time
import functools
import os
import json

_probe_installed = False
_timings = []

# 探针日志文件（同时写 stdout 和文件，确保能拿到数据）
_PROBE_LOG_DIR = os.path.abspath(
    os.environ.get("TTS_LOG_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
)
os.makedirs(_PROBE_LOG_DIR, exist_ok=True)
_PROBE_LOG = os.path.join(_PROBE_LOG_DIR, "probe.log")

def _plog(msg):
    """同时写 stdout 和 probe.log 文件"""
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(_PROBE_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def install_probe():
    """安装探针，monkey-patch 三个关键函数。
    注意：vq_model/t2s_model/bigvgan_model 在 switch_voice 后会被重建，
    所以所有探针都需要在每次 switch_voice 后重新安装。
    """
    global _probe_installed
    try:
        import GPT_SoVITS.inference_webui as inf
    except ImportError:
        _plog("[Probe] 无法导入 inference_webui，探针未安装")
        return

    # 记录当前模型版本信息（关键：确认 v1 vs v3）
    try:
        _plog(f"[Probe] === 模型版本信息 ===")
        _plog(f"[Probe] inf.version = {getattr(inf, 'version', 'N/A')}")
        _plog(f"[Probe] inf.model_version = {getattr(inf, 'model_version', 'N/A')}")
        _plog(f"[Probe] inf.if_lora_v3 = {getattr(inf, 'if_lora_v3', 'N/A')}")
        _plog(f"[Probe] vq_model 类型 = {type(inf.vq_model).__name__}")
        _plog(f"[Probe] vq_model 有 cfm = {hasattr(inf.vq_model, 'cfm')}")
        _plog(f"[Probe] bigvgan_model = {inf.bigvgan_model}")
        _plog(f"[Probe] t2s_model 类型 = {type(inf.t2s_model).__name__}")
        _plog(f"[Probe] ========================")
    except Exception as e:
        _plog(f"[Probe] 获取模型信息失败: {e}")

    # 1. AR T2S: patch t2s_model.model.infer_panel（每次重新安装，t2s_model 会重建）
    try:
        if hasattr(inf.t2s_model, 'model') and hasattr(inf.t2s_model.model, 'infer_panel'):
            if not getattr(inf.t2s_model.model, '_probe_patched', False):
                orig_infer_panel = inf.t2s_model.model.infer_panel
                @functools.wraps(orig_infer_panel)
                def patched_infer_panel(*args, **kwargs):
                    t0 = time.time()
                    result = orig_infer_panel(*args, **kwargs)
                    dt = time.time() - t0
                    _timings.append({"stage": "AR_T2S", "time_s": round(dt, 3)})
                    _plog(f"[Probe] AR_T2S: {dt:.3f}s")
                    return result
                inf.t2s_model.model.infer_panel = patched_infer_panel
                inf.t2s_model.model._probe_patched = True
                _plog("[Probe] AR T2S 探针已安装")
            else:
                _plog("[Probe] AR T2S 探针已存在，跳过")
    except Exception as e:
        _plog(f"[Probe] AR T2S patch 失败: {e}")

    # 2. CFM 扩散: patch vq_model.cfm.inference（仅 v3 模型有 cfm）
    try:
        if hasattr(inf.vq_model, 'cfm'):
            if not getattr(inf.vq_model.cfm, '_probe_patched', False):
                orig_cfm_inference = inf.vq_model.cfm.inference
                @functools.wraps(orig_cfm_inference)
                def patched_cfm_inference(*args, **kwargs):
                    t0 = time.time()
                    result = orig_cfm_inference(*args, **kwargs)
                    dt = time.time() - t0
                    _timings.append({"stage": "CFM_diffusion", "time_s": round(dt, 3)})
                    _plog(f"[Probe] CFM_diffusion: {dt:.3f}s")
                    return result
                inf.vq_model.cfm.inference = patched_cfm_inference
                inf.vq_model.cfm._probe_patched = True
                _plog("[Probe] CFM 探针已安装")
        else:
            _plog(f"[Probe] vq_model 无 cfm 属性 (model_version={getattr(inf,'model_version','?')})，跳过 CFM")
    except Exception as e:
        _plog(f"[Probe] CFM patch 失败: {e}")

    # 3. BigVGAN 声码: patch bigvgan_model.__call__（仅 v3 模型有 bigvgan）
    try:
        if inf.bigvgan_model is not None:
            if not getattr(inf.bigvgan_model, '_probe_patched', False):
                orig_bigvgan_call = inf.bigvgan_model.__call__
                @functools.wraps(orig_bigvgan_call)
                def patched_bigvgan_call(*args, **kwargs):
                    t0 = time.time()
                    result = orig_bigvgan_call(*args, **kwargs)
                    dt = time.time() - t0
                    _timings.append({"stage": "BigVGAN", "time_s": round(dt, 3)})
                    _plog(f"[Probe] BigVGAN: {dt:.3f}s")
                    return result
                inf.bigvgan_model.__call__ = patched_bigvgan_call
                inf.bigvgan_model._probe_patched = True
                _plog("[Probe] BigVGAN 探针已安装")
        else:
            _plog("[Probe] bigvgan_model is None, 跳过")
    except Exception as e:
        _plog(f"[Probe] BigVGAN patch 失败: {e}")

    # 4. v1/v2 声码: patch vq_model.decode（v1/v2 模型走这个路径）
    try:
        if not getattr(inf.vq_model, '_decode_probe_patched', False):
            orig_decode = inf.vq_model.decode
            @functools.wraps(orig_decode)
            def patched_decode(*args, **kwargs):
                t0 = time.time()
                result = orig_decode(*args, **kwargs)
                dt = time.time() - t0
                _timings.append({"stage": "Vocoder_decode", "time_s": round(dt, 3)})
                _plog(f"[Probe] Vocoder_decode: {dt:.3f}s")
                return result
            inf.vq_model.decode = patched_decode
            inf.vq_model._decode_probe_patched = True
            _plog("[Probe] Vocoder_decode 探针已安装 (v1/v2 路径)")
    except Exception as e:
        _plog(f"[Probe] Vocoder_decode patch 失败: {e}")

    _probe_installed = True
    _plog("[Probe] 探针安装完成")


def get_timings():
    """获取累计的计时记录"""
    return list(_timings)


def reset_timings():
    """清空计时记录"""
    global _timings
    _timings = []


def print_summary():
    """打印汇总统计"""
    if not _timings:
        _plog("[Probe] 无计时数据")
        return
    _plog("=" * 50)
    _plog("[Probe] 耗时汇总")
    _plog("=" * 50)
    stages = {}
    for t in _timings:
        s = t["stage"]
        if s not in stages:
            stages[s] = []
        stages[s].append(t["time_s"])
    total = 0
    for stage, times in stages.items():
        count = len(times)
        avg = sum(times) / count
        stage_total = sum(times)
        total += stage_total
        _plog(f"  {stage:15s}: {count}次, 平均{avg:.3f}s, 小计{stage_total:.3f}s")
    _plog(f"  {'TOTAL':15s}: {total:.3f}s")
    _plog("=" * 50)
