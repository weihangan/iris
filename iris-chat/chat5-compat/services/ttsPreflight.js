const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MEMORY_POLICIES_MB = Object.freeze({
  // Windows os.freemem() 不含可回收缓存，Electron+Express 启动后该值会暂时偏低
  // 但实际可用内存（含可回收缓存）通常足够。降低硬门限避免误判。
  gpu: Object.freeze({ hardMinimumMB: 512, recommendedMB: 2048 }),
  cpu: Object.freeze({ hardMinimumMB: 512, recommendedMB: 2048 }),
});

function toMB(bytes) {
  return Math.round(Number(bytes || 0) / 1024 / 1024);
}

function getSystemMemoryStatus(device) {
  const normalizedDevice = device === 'gpu' ? 'gpu' : 'cpu';
  const policy = MEMORY_POLICIES_MB[normalizedDevice];
  return {
    device: normalizedDevice,
    freeMB: toMB(os.freemem()),
    totalMB: toMB(os.totalmem()),
    hardMinimumMB: policy.hardMinimumMB,
    recommendedMB: policy.recommendedMB,
  };
}

function probeNvidiaGpu() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [...new Set(['nvidia-smi.exe', path.join(windir, 'System32', 'nvidia-smi.exe')])];
  let result = null;
  for (const executable of candidates) {
    const current = spawnSync(executable, [
      '--query-gpu=name,driver_version,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (current.error && current.error.code === 'ENOENT') continue;
    result = current;
    break;
  }
  if (!result || result.error || result.status !== 0) {
    return { ok: false, errorCode: 'GPU_DRIVER_UNAVAILABLE', error: '无法读取NVIDIA显卡或驱动状态。', gpu: null };
  }
  const line = String(result.stdout || '').trim().split(/\r?\n/)[0];
  const parts = line.split(',').map(value => value.trim());
  if (parts.length < 4) {
    return { ok: false, errorCode: 'GPU_DRIVER_UNAVAILABLE', error: 'NVIDIA驱动已响应，但返回的显卡信息无法识别。', gpu: null };
  }
  const driverVersion = parts[parts.length - 3];
  const vramTotalMB = Number.parseInt(parts[parts.length - 2], 10);
  const vramFreeMB = Number.parseInt(parts[parts.length - 1], 10);
  return {
    ok: true,
    gpu: {
      name: parts.slice(0, -3).join(', '),
      driverVersion,
      vramTotalMB: Number.isFinite(vramTotalMB) ? vramTotalMB : null,
      vramFreeMB: Number.isFinite(vramFreeMB) ? vramFreeMB : null,
    },
  };
}

function probeTorchCuda(pythonExe) {
  const script = 'import json, torch; print(json.dumps({"torchVersion": torch.__version__, "torchCudaVersion": torch.version.cuda, "cudaAvailable": torch.cuda.is_available(), "deviceCount": torch.cuda.device_count()}))';
  const result = spawnSync(pythonExe, ['-I', '-c', script], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error && result.error.code === 'ETIMEDOUT') return { ok: false, errorCode: 'TORCH_IMPORT_TIMEOUT', error: '包内PyTorch GPU环境检查超过20秒。' };
  if (result.error && result.error.code === 'ENOENT') return { ok: false, errorCode: 'PYTHON_MISSING', error: '语音服务使用的Python运行时不存在。' };
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ok: false, errorCode: 'TORCH_IMPORT_FAILED', error: 'PyTorch导入失败，GPU语音环境不完整。', detail };
  }
  let runtime;
  try {
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    runtime = JSON.parse(line);
  } catch (error) {
    return { ok: false, errorCode: 'TORCH_IMPORT_FAILED', error: 'PyTorch已运行，但GPU检查结果无法识别。' };
  }
  if (!runtime.torchCudaVersion) return { ok: false, errorCode: 'CUDA_PYTORCH_MISMATCH', error: '当前PyTorch不是CUDA版本，不能启动GPU语音。', torch: runtime };
  if (!runtime.cudaAvailable || Number(runtime.deviceCount || 0) < 1) return { ok: false, errorCode: 'CUDA_UNAVAILABLE', error: 'NVIDIA驱动可见，但PyTorch当前无法使用CUDA。', torch: runtime };
  return { ok: true, torch: runtime };
}

function buildResourceStatus(memory, gpu = null, torch = null) {
  return { systemRam: memory, gpu: gpu ? { ...gpu, ...(torch || {}) } : null };
}

function formatResourceSummary(status) {
  const ram = status.systemRam;
  const parts = [`系统内存(RAM)：可用 ${ram.freeMB} MB / 总计 ${ram.totalMB} MB`];
  if (ram.device === 'gpu') {
    const gpu = status.gpu;
    if (gpu) {
      parts.push(`GPU：${gpu.name || 'NVIDIA GPU'}${gpu.driverVersion ? `（驱动 ${gpu.driverVersion}）` : ''}`);
      parts.push(gpu.vramFreeMB !== null && gpu.vramFreeMB !== undefined
        ? `显存(VRAM)：可用 ${gpu.vramFreeMB} MB / 总计 ${gpu.vramTotalMB} MB`
        : '显存(VRAM)：无法读取');
    } else {
      parts.push('GPU/显存(VRAM)：无法读取');
    }
  } else {
    parts.push('当前模式：CPU（不使用GPU显存）');
  }
  return parts.join('\n');
}

module.exports = { MEMORY_POLICIES_MB, getSystemMemoryStatus, probeNvidiaGpu, probeTorchCuda, buildResourceStatus, formatResourceSummary };
