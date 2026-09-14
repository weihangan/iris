import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');

describe('release Python runtime contract', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CHATX2_RUNTIME_DEVICE;
    delete process.env.CHAT5_RUNTIME_DEVICE;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    'scripts/prepare-release.mjs',
    'scripts/prepare-release-offline.mjs'
  ])('%s includes both CPU and GPU Python runtimes', (relativePath) => {
    const source = readFileSync(join(projectRoot, relativePath), 'utf8');

    expect(source).toContain("'python_env_cpu'");
    expect(source).toContain("'python_env_gpu'");
  });

  test('release metadata declares a universal CPU/GPU package', () => {
    const metadata = JSON.parse(
      readFileSync(join(projectRoot, 'scripts', 'release-templates', 'release.json'), 'utf8')
    );

    expect(metadata.flavor).toBe('universal');
    expect(metadata.devices).toEqual(['gpu', 'cpu']);
  });

  test('electron-builder declares both bundled Python runtimes', () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8')
    );
    const extraResources = packageJson.build?.extraResources ?? [];
    const destinations = extraResources.map((item: { to?: string }) => item.to);
    expect(destinations).toEqual(expect.arrayContaining(['python_env_cpu', 'python_env_gpu']));
  });

  test('GPU clone dependency lock is reproducible without replacing CUDA Torch', () => {
    const requirements = readFileSync(
      join(projectRoot, 'build-resources', 'python-gpu-clone-requirements.txt'),
      'utf8'
    );
    const installer = readFileSync(
      join(projectRoot, 'scripts', 'install-release-gpu-clone-deps.ps1'),
      'utf8'
    );

    expect(requirements).toContain('openai-whisper==20240930');
    expect(requirements).toContain('soundfile==');
    expect(requirements).toContain('scipy==');
    expect(requirements).toContain('regex==');
    expect(requirements).toContain('tiktoken==');
    expect(requirements).toContain('numba==0.66.0');
    expect(requirements).not.toMatch(/^torch(?:==|\s*$)/m);
    expect(installer).toContain('--no-deps');
    expect(installer).toContain('--no-build-isolation');
    expect(installer).toContain('python_env_gpu');
  });

  test.each([
    'chat5-compat/services/runtimeFlavor.js',
    'scripts/release-templates/runtimeFlavor-chatx2.js'
  ])('%s reads release metadata from resources/app/data', (relativeModulePath) => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-runtime-contract-'));
    tempDirs.push(root);

    const resourcesDir = join(root, 'resources');
    const modulePath = join(resourcesDir, 'app', 'chat5-compat', 'services', 'runtimeFlavor.js');
    const releasePath = join(resourcesDir, 'app', 'data', 'release.json');
    const cpuPython = join(resourcesDir, 'python_env_cpu', 'python.exe');
    const gpuPython = join(resourcesDir, 'python_env_gpu', 'python.exe');

    for (const path of [modulePath, releasePath, cpuPython, gpuPython]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    copyFileSync(join(projectRoot, relativeModulePath), modulePath);
    writeFileSync(releasePath, JSON.stringify({
      flavor: 'chatx2-universal-test',
      devices: ['gpu', 'cpu']
    }));
    writeFileSync(cpuPython, '');
    writeFileSync(gpuPython, '');

    process.env.CHATX2_RUNTIME_DEVICE = 'gpu';
    const requireFromFixture = createRequire(modulePath);
    const runtime = requireFromFixture(modulePath).getRuntimeFlavor();

    expect(runtime.flavor).toBe('chatx2-universal-test');
    expect(runtime.expectedDevice).toBe('gpu');
    expect(runtime.allowDeviceSwitch).toBe(true);
    expect(runtime.availableDevices).toEqual(['gpu', 'cpu']);
  });
});
