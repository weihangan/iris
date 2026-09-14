import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');
const requireFromHere = createRequire(import.meta.url);
const preflight = requireFromHere(resolve(projectRoot, 'chat5-compat', 'services', 'voiceClonePreflight.js'));

const runtimeFlavor = {
  flavor: 'universal',
  expectedDevice: 'gpu',
  availableDevices: ['gpu', 'cpu'],
  gpuPythonExe: 'D:\\runtime\\python_env_gpu\\python.exe',
  cpuPythonExe: 'D:\\runtime\\python_env_cpu\\python.exe',
};

describe('voice clone preflight', () => {
  test('selects the Python executable for the final training device', () => {
    expect(preflight.selectTrainingRuntime('gpu', runtimeFlavor)).toMatchObject({
      device: 'gpu',
      pythonExe: runtimeFlavor.gpuPythonExe,
    });
    expect(preflight.selectTrainingRuntime('cpu', runtimeFlavor)).toMatchObject({
      device: 'cpu',
      pythonExe: runtimeFlavor.cpuPythonExe,
    });
    expect(preflight.selectTrainingRuntime('auto', runtimeFlavor)).toMatchObject({
      device: 'gpu',
      pythonExe: runtimeFlavor.gpuPythonExe,
    });
  });

  test('rejects a requested device that is not present in the release', () => {
    expect(() => preflight.selectTrainingRuntime('gpu', {
      ...runtimeFlavor,
      expectedDevice: 'cpu',
      availableDevices: ['cpu'],
      gpuPythonExe: '',
    })).toThrow(/GPU.*不可用|gpu.*unavailable/i);
  });

  test('reports missing training resources and Python capabilities', async () => {
    const existing = new Set([
      'D:\\app\\voice_engine\\train_pipeline_v2.py',
      'D:\\gpt',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\s1v3.ckpt',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\s2Gv3.pth',
    ]);
    const result = await preflight.inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: 'gpu',
      appRoot: 'D:\\app',
      gptSoVitsRoot: 'D:\\gpt',
      inputMode: 'ordinary',
      existsSync: (value: string) => existing.has(value),
      pythonProbe: () => ({
        ok: true,
        cudaAvailable: true,
        modules: { torch: true, soundfile: false, scipy: true, transformers: true, peft: true, funasr: false, whisper: false },
      }),
      ffmpegProbe: () => null,
    });

    expect(result.ready).toBe(false);
    expect(result.device).toBe('gpu');
    expect(result.pythonExe).toBe(runtimeFlavor.gpuPythonExe);
    expect(result.missingFiles.some((item: any) => item.id === 's2Dv3')).toBe(false);
    expect(result.missingModules).toContain('soundfile');
    expect(result.missingCapabilities).toContain('asr');
    expect(result.missingCapabilities).toContain('ffmpeg');
  });

  test('does not require the unused discriminator checkpoint for v3 LoRA training', async () => {
    const result = await preflight.inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: 'gpu',
      appRoot: 'D:\\app',
      gptSoVitsRoot: 'D:\\gpt',
      inputMode: 'presliced',
      existsSync: (value: string) => !value.endsWith('s2Dv3.pth'),
      pythonProbe: async () => ({
        ok: true,
        cudaAvailable: true,
        modules: { torch: true, soundfile: true, scipy: true, transformers: true, peft: true, funasr: false, whisper: true },
      }),
      ffmpegProbe: () => 'D:\\gpt\\ffmpeg.exe',
    });

    expect(result.ready).toBe(true);
    expect(result.missingFiles).toEqual([]);
    expect(result.errors).not.toContainEqual(expect.stringContaining('funasr'));
  });

  test('leaves the unused v3 LoRA discriminator checkpoint empty', () => {
    const pipeline = readFileSync(resolve(projectRoot, 'chat5-compat', 'voice_engine', 'train_pipeline_v2.py'), 'utf8');
    expect(pipeline).toContain('data["train"]["pretrained_s2D"] = ""');
    expect(pipeline).not.toContain('data["train"]["pretrained_s2D"] = "GPT_SoVITS/pretrained_models/s2Dv3.pth"');
  });

  test('releases the ChatX2 TTS port before GPU training', () => {
    const pipeline = readFileSync(resolve(projectRoot, 'chat5-compat', 'voice_engine', 'train_pipeline_v2.py'), 'utf8');
    const server = readFileSync(resolve(projectRoot, 'chat5-compat', 'server.js'), 'utf8');
    expect(pipeline).toContain('CHATX2_TTS_PORT');
    expect(pipeline).toContain('findstr :{tts_port}');
    expect(pipeline).toContain('or "9882"');
    expect(pipeline).not.toContain('findstr :9880');
    expect(pipeline).toContain('"tts_api": f"http://127.0.0.1:{tts_port}"');
    expect(server).toContain('CHATX2_TTS_PORT');
  });

  test('allows a pre-sliced input without ASR and UVR requirements', async () => {
    const result = await preflight.inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: 'gpu',
      appRoot: 'D:\\app',
      gptSoVitsRoot: 'D:\\gpt',
      inputMode: 'presliced',
      existsSync: () => true,
      pythonProbe: () => ({
        ok: true,
        cudaAvailable: true,
        modules: { torch: true, soundfile: true, scipy: true, transformers: true, peft: true, funasr: false, whisper: false },
      }),
      ffmpegProbe: () => 'D:\\gpt\\ffmpeg.exe',
    });

    expect(result.ready).toBe(true);
    expect(result.missingCapabilities).not.toContain('asr');
  });

  test('does not require ffmpeg for a valid pre-sliced input', async () => {
    const files = new Set([
      runtimeFlavor.cpuPythonExe,
      'D:\\app\\voice_engine\\train_pipeline_v2.py',
      'D:\\gpt',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\s1v3.ckpt',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\s2Gv3.pth',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\chinese-roberta-wwm-ext-large',
      'D:\\gpt\\GPT_SoVITS\\pretrained_models\\chinese-hubert-base',
      'D:\\gpt\\GPT_SoVITS\\_s2_train_direct.py',
      'D:\\gpt\\GPT_SoVITS\\s1_train.py',
    ]);
    const result = await preflight.inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: 'cpu',
      appRoot: 'D:\\app',
      gptSoVitsRoot: 'D:\\gpt',
      inputMode: 'presliced',
      existsSync: (value: string) => files.has(value),
      pythonProbe: () => ({
        ok: true,
        cudaAvailable: false,
        modules: { torch: true, soundfile: true, scipy: true, transformers: true, peft: true },
      }),
      ffmpegProbe: () => null,
    });

    expect(result.ready).toBe(true);
    expect(result.missingCapabilities).not.toContain('ffmpeg');
  });

  test('recognizes only complete pre-sliced directories', () => {
    expect(preflight.detectInputMode('D:\\clips', (value: string) => value === 'D:\\clips\\metadata.json')).toBe('ordinary');
    expect(preflight.detectInputMode('D:\\clips', (value: string) => value === 'D:\\clips' || [
      'D:\\clips\\metadata.json',
      'D:\\clips\\seg_000.wav',
    ].includes(value), () => ['metadata.json', 'seg_000.wav'])).toBe('presliced');
  });
});
