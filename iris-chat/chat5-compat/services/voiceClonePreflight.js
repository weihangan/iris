const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REQUIRED_MODULES = ['torch', 'soundfile', 'scipy', 'transformers', 'peft'];
const PROBE_MODULES = [...REQUIRED_MODULES, 'funasr', 'whisper'];
const pythonProbeCache = new Map();

function normalizeRequestedDevice(value) {
  const device = String(value || 'auto').toLowerCase();
  return ['auto', 'gpu', 'cpu'].includes(device) ? device : 'auto';
}

function selectTrainingRuntime(requestedDevice, runtimeFlavor) {
  const requested = normalizeRequestedDevice(requestedDevice);
  const available = Array.isArray(runtimeFlavor.availableDevices)
    ? runtimeFlavor.availableDevices.map((item) => String(item).toLowerCase())
    : [];
  const device = requested === 'auto'
    ? (available.includes(runtimeFlavor.expectedDevice) ? runtimeFlavor.expectedDevice : (available[0] || 'cpu'))
    : requested;
  if (!available.includes(device)) {
    throw new Error(`${device.toUpperCase()} 训练环境不可用`);
  }
  const pythonExe = device === 'gpu' ? runtimeFlavor.gpuPythonExe : runtimeFlavor.cpuPythonExe;
  if (!pythonExe) throw new Error(`${device.toUpperCase()} Python 路径未配置`);
  return { device, pythonExe };
}

function probePythonRuntime(pythonExe, timeoutMs = 60000) {
  const source = [
    'import importlib,json,sys',
    `names=${JSON.stringify(PROBE_MODULES)}`,
    'result={}',
    'errors={}',
    'for_name=None',
    'for name in names:',
    '  try:',
    '    importlib.import_module(name)',
    '    result[name]=True',
    '  except Exception as exc:',
    '    result[name]=False',
    '    errors[name]=type(exc).__name__+": "+str(exc)',
    'cuda=False',
    'gpu_name=None',
    'if result.get("torch"):',
    '  import torch',
    '  cuda=bool(torch.cuda.is_available())',
    '  gpu_name=torch.cuda.get_device_name(0) if cuda else None',
    'print(json.dumps({"ok":True,"python":sys.executable,"modules":result,"moduleErrors":errors,"cudaAvailable":cuda,"gpuName":gpu_name},ensure_ascii=False))',
  ].join('\n');
  const cached = pythonProbeCache.get(pythonExe);
  const now = Date.now();
  if (cached?.promise) return cached.promise;
  if (cached?.result) {
    const ttl = cached.result.ok ? 5 * 60 * 1000 : 15 * 1000;
    if (now - cached.timestamp < ttl) return Promise.resolve(cached.result);
  }

  const promise = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(pythonExe, ['-c', source], {
      windowsHide: true,
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pythonProbeCache.set(pythonExe, { result, timestamp: Date.now() });
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, modules: {}, cudaAvailable: false, error: `Python 探针超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
    child.once('error', (error) => finish({
      ok: false,
      modules: {},
      cudaAvailable: false,
      error: error.message,
    }));
    child.once('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, modules: {}, cudaAvailable: false, error: stderr.trim() || `Python probe exited ${code}` });
        return;
      }
      try {
        finish(JSON.parse(stdout.trim().split(/\r?\n/).pop()));
      } catch (error) {
        finish({ ok: false, modules: {}, cudaAvailable: false, error: `Python 探针输出无效: ${error.message}` });
      }
    });
  });
  pythonProbeCache.set(pythonExe, { promise, timestamp: now });
  return promise;
}

function findFfmpeg(gptSoVitsRoot, existsSync = fs.existsSync) {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(gptSoVitsRoot || '', 'ffmpeg.exe'),
    path.join(gptSoVitsRoot || '', 'tools', 'ffmpeg.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function buildRequiredFiles(appRoot, gptSoVitsRoot, inputMode) {
  const pretrained = path.join(gptSoVitsRoot, 'GPT_SoVITS', 'pretrained_models');
  const files = [
    { id: 'trainPipeline', path: path.join(appRoot, 'voice_engine', 'train_pipeline_v2.py') },
    { id: 'gptSoVitsRoot', path: gptSoVitsRoot },
    { id: 's1v3', path: path.join(pretrained, 's1v3.ckpt') },
    { id: 's2Gv3', path: path.join(pretrained, 's2Gv3.pth') },
    { id: 'bert', path: path.join(pretrained, 'chinese-roberta-wwm-ext-large') },
    { id: 'hubert', path: path.join(pretrained, 'chinese-hubert-base') },
    { id: 'sovitsTrainer', path: path.join(gptSoVitsRoot, 'GPT_SoVITS', '_s2_train_direct.py') },
    { id: 'gptTrainer', path: path.join(gptSoVitsRoot, 'GPT_SoVITS', 's1_train.py') },
  ];
  if (inputMode !== 'presliced') {
    files.push({
      id: 'uvrModel',
      path: path.join(gptSoVitsRoot, 'tools', 'uvr5', 'uvr5_weights', 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'),
    });
  }
  return files;
}

async function inspectVoiceClonePreflight(options) {
  const existsSync = options.existsSync || fs.existsSync;
  const pythonProbe = options.pythonProbe || probePythonRuntime;
  const ffmpegProbe = options.ffmpegProbe || ((root) => findFfmpeg(root, existsSync));
  const inputMode = options.inputMode === 'presliced' ? 'presliced' : 'ordinary';
  let runtime;
  try {
    runtime = selectTrainingRuntime(options.requestedDevice, options.runtimeFlavor);
  } catch (error) {
    return {
      ready: false,
      device: normalizeRequestedDevice(options.requestedDevice),
      pythonExe: '',
      inputMode,
      missingFiles: [],
      missingModules: [],
      missingCapabilities: ['training-device'],
      errors: [error.message],
    };
  }

  const requiredFiles = buildRequiredFiles(options.appRoot, options.gptSoVitsRoot, inputMode);
  const missingFiles = requiredFiles.filter((item) => !existsSync(item.path));
  const probe = existsSync(runtime.pythonExe)
    ? await pythonProbe(runtime.pythonExe)
    : { ok: false, modules: {}, cudaAvailable: false, error: `Python 不存在: ${runtime.pythonExe}` };
  const missingModules = REQUIRED_MODULES.filter((name) => probe.modules?.[name] !== true);
  const missingCapabilities = [];
  const ffmpegPath = ffmpegProbe(options.gptSoVitsRoot);
  // 已切片输入只需要读取现成的 seg_*.wav 和 metadata.json，整个流水线
  // 不会调用 ffmpeg/UVR/ASR；不要因为包内没有 ffmpeg 而误阻塞这种输入。
  if (inputMode !== 'presliced' && !ffmpegPath) missingCapabilities.push('ffmpeg');
  if (inputMode !== 'presliced' && !probe.modules?.funasr && !probe.modules?.whisper) {
    missingCapabilities.push('asr');
  }
  if (runtime.device === 'gpu' && probe.cudaAvailable !== true) missingCapabilities.push('cuda');
  const errors = [];
  if (!probe.ok && probe.error) errors.push(probe.error);
  const hasAsr = probe.modules?.funasr === true || probe.modules?.whisper === true;
  for (const [name, detail] of Object.entries(probe.moduleErrors || {})) {
    if (REQUIRED_MODULES.includes(name)
      || (inputMode !== 'presliced' && !hasAsr && ['funasr', 'whisper'].includes(name))) {
      errors.push(`${name}: ${detail}`);
    }
  }
  return {
    ready: missingFiles.length === 0 && missingModules.length === 0 && missingCapabilities.length === 0 && probe.ok === true,
    device: runtime.device,
    pythonExe: runtime.pythonExe,
    inputMode,
    gptSoVitsRoot: options.gptSoVitsRoot,
    voiceCloningDir: path.join(options.appRoot, 'voice_engine'),
    ffmpegPath,
    missingFiles,
    missingModules,
    missingCapabilities,
    errors,
    python: probe,
  };
}

function detectInputMode(inputPath, existsSync = fs.existsSync, readDirSync = fs.readdirSync) {
  if (!inputPath) return 'ordinary';
  // 仅有 metadata.json 不是可训练的切片目录；必须至少有一个 seg_*.wav，
  // 与 train_pipeline_v2.step0_detect_input 的判断保持一致，避免预检放行
  // 后在训练阶段才发现没有任何音频片段。
  if (!existsSync(path.join(inputPath, 'metadata.json'))) return 'ordinary';
  let entries;
  try {
    if (!existsSync(inputPath)) return 'ordinary';
    entries = readDirSync(inputPath);
  } catch (_) {
    return 'ordinary';
  }
  const hasSegments = Array.isArray(entries)
    && entries.some((name) => /^seg_.*\.wav$/i.test(String(name)));
  return hasSegments ? 'presliced' : 'ordinary';
}

module.exports = {
  selectTrainingRuntime,
  probePythonRuntime,
  inspectVoiceClonePreflight,
  detectInputMode,
  findFfmpeg,
};
