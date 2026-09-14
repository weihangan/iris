// owner-trace: wha1999/core/runtime-universal
// provenance: wha9917/private-optimizations (inert; no runtime decision)
const path = require('path');
const fs = require('fs');
const { resolveIrisPaths } = require('./irisRuntimePaths');

const APP_ROOT = path.resolve(__dirname, '..');
const IRIS_PATHS = resolveIrisPaths(__dirname);

function normalizeDevice(value) {
  return String(value || '').toLowerCase() === 'gpu' ? 'gpu' : 'cpu';
}

/**
 * 读取 release.json 获取发布配置（flavor + devices）。
 * 发布包：release.json 在 resources/ 目录下（APP_ROOT 的上级的上级）
 * 开发环境：release.json 在 chatX2 根目录下
 * 都不存在时返回 null（不限制设备）
 */
function readReleaseConfig() {
  const candidates = [
    path.join(IRIS_PATHS.projectRoot, 'data', 'release.json'),
    path.join(APP_ROOT, '..', 'data', 'release.json'), // 发布包：resources/app/data/release.json
    path.join(APP_ROOT, '..', '..', 'release.json'),  // 发布包：resources/release.json
    path.join(APP_ROOT, '..', 'release.json'),        // 开发环境：chatX2/release.json
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      } catch (_) { /* ignore */ }
    }
  }
  return null;
}

/**
 * 多级回退查找 Python 可执行文件。
 * 发布包结构：resources/app/chat5-compat/ → resources/python_env_xxx/python.exe（向上两级）
 * 开发环境结构：chatX2/chat5-compat/ → chatX2/python_env_xxx/python.exe（向上一级）
 * 优先尝试发布包路径，失败则回退到开发环境路径。
 */
function resolvePythonExe(pythonDirName) {
  const device = pythonDirName.includes('gpu') ? 'gpu' : 'cpu';
  const preferred = device === 'gpu' ? IRIS_PATHS.gpuPythonExe : IRIS_PATHS.cpuPythonExe;
  if (fs.existsSync(preferred)) return preferred;
  const candidates = [
    path.join(APP_ROOT, '..', '..', pythonDirName, 'python.exe'),  // 发布包：resources/
    path.join(APP_ROOT, '..', pythonDirName, 'python.exe'),         // 开发环境：chatX2/
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // 都不存在时返回发布包路径（保持向后兼容，由调用方检查 existsSync）
  return candidates[0];
}

function getRuntimeFlavor() {
  // 读取 release.json 获取发布配置
  const releaseConfig = readReleaseConfig();

  // 优先读取 CHATX2_RUNTIME_DEVICE（Electron 主进程设置），
  // 回退到 CHAT5_RUNTIME_DEVICE（兼容旧版启动脚本）
  let expectedDevice = normalizeDevice(
    process.env.CHATX2_RUNTIME_DEVICE || process.env.CHAT5_RUNTIME_DEVICE
  );

  // 确定可用设备列表
  let availableDevices = ['cpu', 'gpu'];
  let allowDeviceSwitch = false;

  if (releaseConfig) {
    // release.json 有明确配置：按配置限制可用设备
    const configDevices = Array.isArray(releaseConfig.devices) ? releaseConfig.devices : [];
    if (configDevices.length > 0) {
      // 过滤出实际存在的设备（python_env 目录存在）
      availableDevices = configDevices.filter(d => {
      const dir = d === 'gpu' ? 'python_env_gpu' : 'python_env_cpu';
        const exe = resolvePythonExe(dir);
        return fs.existsSync(exe);
      });
      // 如果配置的设备都不存在，回退到 CPU
      if (availableDevices.length === 0) {
        availableDevices = ['cpu'];
      }
    }
    // 单设备发布包（如纯 CPU 版）：强制锁定设备，不允许切换
    if (availableDevices.length === 1) {
      expectedDevice = availableDevices[0];
      allowDeviceSwitch = false;
      // 环境变量与 release.json 冲突时，以 release.json 为准
      if (expectedDevice !== normalizeDevice(process.env.CHATX2_RUNTIME_DEVICE || process.env.CHAT5_RUNTIME_DEVICE || expectedDevice)) {
        expectedDevice = availableDevices[0];
      }
    } else {
      allowDeviceSwitch = true; // 多设备可用时允许运行时切换
    }
    // 不允许切换时，availableDevices 只包含当前设备（避免前端显示可切换按钮但点击报错）
    if (!allowDeviceSwitch) {
      availableDevices = [expectedDevice];
    }
  } else {
    // 无 release.json：开发环境，检测实际存在的 Python 环境
    const hasGpu = fs.existsSync(IRIS_PATHS.gpuPythonExe) || fs.existsSync(resolvePythonExe('python_env_gpu'));
    const hasCpu = fs.existsSync(IRIS_PATHS.cpuPythonExe) || fs.existsSync(resolvePythonExe('python_env_cpu'));
    availableDevices = [];
    if (hasGpu) availableDevices.push('gpu');
    if (hasCpu) availableDevices.push('cpu');
    if (availableDevices.length === 0) availableDevices = ['cpu'];
    // 开发环境：如果设置了 GPU 但实际没有 GPU 环境，回退到 CPU
    if (expectedDevice === 'gpu' && !hasGpu) {
      expectedDevice = 'cpu';
    }
    // 开发环境同时有 GPU 和 CPU 时允许切换
    allowDeviceSwitch = hasGpu && hasCpu;
    // 不允许切换时，availableDevices 只包含当前设备（避免前端显示可切换按钮但点击报错）
    if (!allowDeviceSwitch) {
      availableDevices = [expectedDevice];
    }
  }

  const pythonDir = expectedDevice === 'gpu' ? 'python_env_gpu' : 'python_env_cpu';
  return {
    flavor: releaseConfig ? releaseConfig.flavor || 'universal' : 'universal',
    expectedDevice,
    selectedBy: process.env.CHAT5_RUNTIME_SELECTED_BY || 'safe-default',
    allowDeviceSwitch,
    availableDevices,
    pythonExe: resolvePythonExe(pythonDir),
    cpuPythonExe: resolvePythonExe('python_env_cpu'),
    gpuPythonExe: resolvePythonExe('python_env_gpu'),
    projectRoot: IRIS_PATHS.projectRoot,
    runtimeRoot: IRIS_PATHS.runtimeRoot,
    ttsEngineDir: IRIS_PATHS.ttsEngineDir,
    ttsScript: IRIS_PATHS.ttsScript,
    runPatchedScript: IRIS_PATHS.runPatchedScript,
    voicesDir: IRIS_PATHS.voicesDir,
    gptSoVitsRoot: IRIS_PATHS.gptSoVitsRoot,
    ffmpegPath: IRIS_PATHS.ffmpegPath,
    outputDir: path.join(APP_ROOT, 'voice_engine', 'output'),
    modelVersion: `chat5-universal-${expectedDevice}-v1`,
    isHalf: expectedDevice === 'gpu',
  };
}

module.exports = { getRuntimeFlavor };
