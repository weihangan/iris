import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');
const requireFromHere = createRequire(import.meta.url);

function optionalRequire(relativePath: string): any | null {
  const absolutePath = join(projectRoot, relativePath);
  if (!existsSync(absolutePath)) return null;
  return requireFromHere(absolutePath);
}

describe('TTS runtime recovery', () => {
  test('reports the actual CPU service instead of the desired GPU device', () => {
    const runtimeState = optionalRequire('chat5-compat/services/ttsRuntimeState.js');
    expect(runtimeState, 'ttsRuntimeState.js must exist').not.toBeNull();
    if (!runtimeState) return;

    const result = runtimeState.classifyTtsService({
      status: {
        status: 'ready',
        owner: 'wha1999',
        flavor: 'universal',
        expected_device: 'cpu',
        pid: 4032,
      },
      expectedDevice: 'gpu',
      flavor: 'universal',
      ownership: null,
    });

    expect(result).toMatchObject({
      serviceReachable: true,
      actualDevice: 'cpu',
      deviceMismatch: true,
      ttsAvailable: false,
      owned: false,
      reusable: false,
    });
  });

  test('recognizes an owned service after Express restarts', () => {
    const runtimeState = optionalRequire('chat5-compat/services/ttsRuntimeState.js');
    expect(runtimeState, 'ttsRuntimeState.js must exist').not.toBeNull();
    if (!runtimeState) return;

    const ownership = {
      schemaVersion: 1,
      instanceId: 'test-instance-123',
      pid: 777,
      expectedDevice: 'gpu',
      flavor: 'universal',
      executablePath: 'D:\\app\\resources\\python_env_gpu\\python.exe',
      scriptPath: 'D:\\app\\resources\\app\\chat5-compat\\tts_engine\\selina_tts_api.py',
      startedAt: '2026-08-01T00:00:00.000Z',
    };

    expect(runtimeState.matchesOwnedService(ownership, {
      instance_id: 'test-instance-123',
      pid: 777,
      expected_device: 'gpu',
      flavor: 'universal',
    })).toBe(true);
    expect(runtimeState.matchesOwnedService(ownership, {
      instance_id: 'different-instance',
      pid: 777,
      expected_device: 'gpu',
      flavor: 'universal',
    })).toBe(false);
  });

  test('prefers the probed Torch device over the requested environment device', () => {
    const runtimeState = optionalRequire('chat5-compat/services/ttsRuntimeState.js');
    expect(runtimeState, 'ttsRuntimeState.js must exist').not.toBeNull();
    if (!runtimeState) return;

    const result = runtimeState.classifyTtsService({
      status: {
        status: 'ready',
        expected_device: 'gpu',
        device: 'cpu',
        flavor: 'universal',
      },
      expectedDevice: 'gpu',
      flavor: 'universal',
      ownership: null,
    });

    expect(result.actualDevice).toBe('cpu');
    expect(result.deviceMismatch).toBe(true);
    expect(result.ttsAvailable).toBe(false);
    expect(result.reusable).toBe(false);
  });

  test('does not reuse a healthy service unless its persisted instance identity matches', () => {
    const runtimeState = optionalRequire('chat5-compat/services/ttsRuntimeState.js');
    expect(runtimeState, 'ttsRuntimeState.js must exist').not.toBeNull();
    if (!runtimeState) return;

    const status = {
      status: 'ready',
      device: 'gpu',
      expected_device: 'gpu',
      flavor: 'universal',
      instance_id: 'foreign-instance',
      pid: 9123,
    };
    const result = runtimeState.classifyTtsService({
      status,
      expectedDevice: 'gpu',
      flavor: 'universal',
      ownership: {
        schemaVersion: 1,
        instanceId: 'chatx2-instance',
        pid: 9123,
        expectedDevice: 'gpu',
        flavor: 'universal',
      },
    });

    expect(result.ttsAvailable).toBe(true);
    expect(result.owned).toBe(false);
    expect(result.reusable).toBe(false);
  });

  test('offers old CPU and legacy keys only for history recovery', () => {
    const cacheIdentity = optionalRequire('chat5-compat/services/voiceCacheIdentity.js');
    expect(cacheIdentity, 'voiceCacheIdentity.js must exist').not.toBeNull();
    if (!cacheIdentity) return;

    const input = {
      text: '测试旧语音恢复',
      voiceName: '伊利斯1.0',
      variant: 'gentle:test',
      flavor: 'universal',
      modelVersion: 'chatx2-universal-gpu-v1',
    };
    const strict = cacheIdentity.buildVoiceCacheKeys(input, false);
    const compatible = cacheIdentity.buildVoiceCacheKeys(input, true);
    const suffix = `_${input.voiceName}`;
    const cpuPayload = `${input.text}|${input.voiceName}|${input.variant}|universal|chatx2-universal-cpu-v1`;
    const cpuKey = createHash('sha256').update(cpuPayload).digest('hex').slice(0, 16) + suffix;
    const legacyTextKey = createHash('sha256').update(input.text).digest('hex').slice(0, 16) + suffix;

    expect(strict).toHaveLength(1);
    expect(compatible).toContain(cpuKey);
    expect(compatible).toContain(legacyTextKey);
  });

  test('production server and UI use the recovery services', () => {
    const server = readFileSync(join(projectRoot, 'chat5-compat', 'server.js'), 'utf8');
    const app = readFileSync(join(projectRoot, 'chat5-compat', 'public', 'app.js'), 'utf8');
    const pythonApi = readFileSync(join(projectRoot, 'chat5-compat', 'tts_engine', 'selina_tts_api.py'), 'utf8');
    const pythonEngine = readFileSync(join(projectRoot, 'chat5-compat', 'tts_engine', 'selina_tts_engine.py'), 'utf8');
    const asrService = readFileSync(join(projectRoot, 'chat5-compat', 'services', 'localAsrService.js'), 'utf8');
    const asrWorker = readFileSync(join(projectRoot, 'chat5-compat', 'voice_engine', 'local_asr_worker.py'), 'utf8');

    expect(server).toContain("require('./services/ttsRuntimeState')");
    expect(server).toContain("require('./services/voiceCacheIdentity')");
    expect(server).toContain('TTS_INSTANCE_ID');
    expect(server).toContain('detached: false');
    expect(server).toContain('allowCompatibleVersions: true');
    expect(app).toContain('serviceReachable');
    expect(pythonApi).toContain('instance_id');
    expect(server).toContain('TTS_DEFAULT_VOICE_NAME');
    expect(pythonApi).toContain('warmup_complete');
    expect(pythonApi).toContain('"你好，准备好了。"');
    expect(pythonApi).toContain('warmup_output_path');
    expect(pythonApi).toContain('"_retry_index"');
    expect(pythonEngine).toContain('request_retry_index');
    expect(pythonEngine).toContain('_configure_ar_early_stop');
    expect(pythonEngine).toContain('CHATX2_AR_MAX_SEC');
    expect(pythonEngine).toContain('if os.environ.get("TTS_ENABLE_PROFILING", "0") == "1":');
    expect(asrService).not.toContain('D:\\trae\\GPT-SoVITS');
    expect(asrService).not.toContain("'python',");
    expect(asrWorker).toContain('发布包必须只依赖');
    expect(server).not.toContain("execFileSync('ffmpeg'");
    expect(server).not.toContain("execFileSync('python'");
    expect(server).toContain("path.join(runtimeFlavor.gptSoVitsRoot, 'ffmpeg.exe')");
  });

  test('voice startup does not block on RAM or nvidia-smi diagnostics', () => {
    const server = readFileSync(join(projectRoot, 'chat5-compat', 'server.js'), 'utf8');
    const startBlock = server.slice(server.indexOf("app.post('/api/voice/start'"), server.indexOf("app.post('/api/voice/stop'"));
    expect(startBlock).toContain('仍尝试启动');
    expect(startBlock).toContain('Resource probes are diagnostics only');
    expect(startBlock).not.toContain("errorCode: 'LOW_MEMORY'");
    expect(startBlock).not.toContain("errorCode: 'GPU_UNAVAILABLE'");
  });

  test('does not import Torch twice during GPU startup', () => {
    const server = readFileSync(join(projectRoot, 'chat5-compat', 'server.js'), 'utf8');
    expect(server).not.toContain('probeTorchCuda(effectivePythonExe)');
    expect(server).toContain("axios.get(`${TTS_API_URL}/device`");
    expect(server).toContain('realDevice !== effectiveDevice');
  });

  test('does not queue uncancellable GPU work after an inference timeout', () => {
    const pythonApi = readFileSync(
      join(projectRoot, 'chat5-compat', 'tts_engine', 'selina_tts_api.py'),
      'utf8',
    );

    expect(pythonApi).not.toContain('ThreadPoolExecutor');
    expect(pythonApi).not.toContain('.result(timeout=');
    expect(pythonApi).toMatch(/with tts_lock:\s*\n\s*got = tts\.synthesize\(/);
  });

  test('warms each GPU service instance once, skips CPU, and cleans generated audio', async () => {
    const warmup = optionalRequire('chat5-compat/services/ttsWarmup.js');
    expect(warmup, 'ttsWarmup.js must exist').not.toBeNull();
    if (!warmup) return;
    const synthesize = vi.fn(async () => ({ local_path: 'D:\\temp\\warmup.wav' }));
    const cleanup = vi.fn(async () => undefined);
    const controller = warmup.createTtsWarmupController({ synthesize, cleanup });

    expect(await controller.warm({ device: 'cpu', instanceId: 'cpu-1' })).toMatchObject({ skipped: true });
    expect(await controller.warm({ device: 'gpu', instanceId: 'gpu-1', voiceName: '伊利斯1.0' })).toMatchObject({ success: true });
    expect(await controller.warm({ device: 'gpu', instanceId: 'gpu-1', voiceName: '伊利斯1.0' })).toMatchObject({ skipped: true });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('D:\\temp\\warmup.wav');
  });

  test('skips duplicate warmup when the TTS service already warmed the same voice', async () => {
    const warmup = optionalRequire('chat5-compat/services/ttsWarmup.js');
    expect(warmup, 'ttsWarmup.js must exist').not.toBeNull();
    if (!warmup) return;
    const synthesize = vi.fn(async () => ({ local_path: 'D:\\temp\\warmup.wav' }));
    const cleanup = vi.fn(async () => undefined);
    const controller = warmup.createTtsWarmupController({ synthesize, cleanup });

    await expect(controller.warm({
      device: 'gpu',
      instanceId: 'gpu-prewarmed',
      voiceName: '伊利斯1.0',
      serviceStatus: { warmup_complete: true, warmup_voice: '伊利斯1.0' },
    })).resolves.toMatchObject({ skipped: true, reason: 'already-warm' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('voice cloning and release sync include the required files', () => {
    const trainPipeline = join(projectRoot, 'chat5-compat', 'voice_engine', 'train_pipeline_v2.py');
    const syncScript = readFileSync(join(projectRoot, 'sync-to-release.ps1'), 'utf8');

    expect(existsSync(trainPipeline)).toBe(true);
    expect(syncScript).toContain('chat5-compat\\server.js');
    expect(syncScript).toContain("foreach ($runtimeDir in @('services', 'public', 'prompts', 'character'))");
    expect(syncScript).toContain("foreach ($pythonDir in @('tts_engine', 'voice_engine'))");
  });
});
