const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROBE_SOURCE = 'import funasr, soundfile; print("chatx2-local-asr-ok")';

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value)))];
}

function findExternalGptSoVitsRoot(configuredRoot) {
  const candidates = unique([
    process.env.CHATX2_GPT_SOVITS_ROOT,
    configuredRoot,
  ]);
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'tools', 'asr'))) || '';
}

function findFfmpeg(configuredRoot, externalRoot) {
  return unique([
    process.env.CHATX2_FFMPEG_PATH,
    configuredRoot && path.join(configuredRoot, 'ffmpeg.exe'),
    externalRoot && path.join(externalRoot, 'ffmpeg.exe'),
  ]).find(candidate => fs.existsSync(candidate)) || '';
}

function findSystemPythonCandidates() {
  return unique([
    process.env.CHATX2_ASR_PYTHON,
    process.env.PYTHON_EXECUTABLE,
  ]);
}

function probePython(command, argsPrefix = []) {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(command, [...argsPrefix, '-c', PROBE_SOURCE], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PYTHONNOUSERSITE: '' },
    });
    const timer = setTimeout(() => {
      if (!settled) child.kill();
      finish(false);
    }, 25_000);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
  });
}

class LocalAsrService {
  constructor(options) {
    this.appRoot = options.appRoot;
    this.runtimeFlavor = options.runtimeFlavor;
    this.worker = null;
    this.workerStartPromise = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextId = 0;
  }

  async selectPython() {
    const externalRoot = findExternalGptSoVitsRoot(this.runtimeFlavor.gptSoVitsRoot);
    const externalPython = externalRoot && path.join(externalRoot, 'runtime', 'python.exe');
    const candidates = unique([
    // 包内运行时优先：python_env_cpu 已补装 funasr，自足且不依赖开发机路径。
    // 仅在用户显式配置时才允许外部运行时，保证发布包可搬到其他电脑。
    this.runtimeFlavor.cpuPythonExe,
    this.runtimeFlavor.pythonExe,
    ...findSystemPythonCandidates(),
    externalPython && fs.existsSync(externalPython) ? externalPython : '',
    ]);
    for (const command of candidates) {
      if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
      if (await probePython(command)) return { command, externalRoot };
    }
    throw new Error('当前 ChatX2 发布包没有可用的本地 FunASR 运行时/模型；请在 ChatX2 设置中配置本地 ASR 资源后重试。');
  }

  async startWorker() {
    if (this.worker && !this.worker.killed) return this.worker;
    if (this.workerStartPromise) return this.workerStartPromise;
    this.workerStartPromise = (async () => {
      const { command, externalRoot } = await this.selectPython();
      const script = path.join(this.appRoot, 'voice_engine', 'local_asr_worker.py');
      if (!fs.existsSync(script)) throw new Error(`本地 ASR 脚本不存在：${script}`);
      const worker = spawn(command, ['-u', script], {
        cwd: this.appRoot,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          CHATX2_GPT_SOVITS_ROOT: externalRoot || this.runtimeFlavor.gptSoVitsRoot,
          CHATX2_FFMPEG_PATH: findFfmpeg(this.runtimeFlavor.gptSoVitsRoot, externalRoot),
          CHATX2_ASR_DEVICE: process.env.CHATX2_ASR_DEVICE || 'cpu',
        },
      });
      this.worker = worker;
      this.stdoutBuffer = '';
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data', chunk => this.handleStdout(chunk));
      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', chunk => process.stderr.write(`[LocalASR] ${chunk}`));
      worker.once('error', error => this.handleWorkerExit(error));
      worker.once('exit', code => this.handleWorkerExit(new Error(`本地 ASR 进程已退出（code=${code}）`)));
      console.log(`[LocalASR] worker started with ${command}`);
      return worker;
    })();
    try {
      return await this.workerStartPromise;
    } finally {
      this.workerStartPromise = null;
    }
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type !== 'result') continue;
        const entry = this.pending.get(String(message.id));
        if (!entry) continue;
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.success === true && typeof message.text === 'string' && message.text.trim()) {
          entry.resolve(message.text.trim());
        } else {
          entry.reject(new Error(message.error || '没有识别到清晰的语音，请重试。'));
        }
      } catch (error) {
        console.warn('[LocalASR] ignored non-protocol output:', line.slice(0, 300), error.message);
      }
    }
  }

  handleWorkerExit(error) {
    if (!this.worker) return;
    this.worker = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async transcribe(audio, mimeType) {
    const worker = await this.startWorker();
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地语音识别超时，请缩短录音后重试。'));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      worker.stdin.write(`${JSON.stringify({
        id,
        mimeType,
        audioBase64: audio.toString('base64'),
      })}\n`, 'utf8', error => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  dispose() {
    if (this.worker && !this.worker.killed) this.worker.kill();
    this.worker = null;
  }
}

function createLocalAsrService(options) {
  return new LocalAsrService(options);
}

module.exports = {
  createLocalAsrService,
  findExternalGptSoVitsRoot,
  findFfmpeg,
};
