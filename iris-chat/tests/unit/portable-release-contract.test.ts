import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf8');
}

describe('portable release hygiene contract', () => {
  test('forked Chat service writes mutable data to the D: shared data root', () => {
    const main = read('electron/main.ts');

    expect(main).toContain('APP_DATA_DIR: sharedDataDir');
    expect(main).toContain('CHATX2_SHARED_DATA_DIR');
  });

  test('production path defaults are relocatable and do not embed developer drives', () => {
    const main = read('electron/main.ts');

    expect(main).not.toMatch(/D:\\\\trae|D:\/trae|D:\\\\Python|D:\/Python/i);
    expect(main).toContain("process.env.CHATX2_VMD_CANDIDATE_ROOT?.trim()");
    expect(main).toContain("'models', 'shared', 'conversation-motion-candidates'");
  });

  test('portable build keeps the private provenance marker in runtime metadata', () => {
    const packageJson = JSON.parse(read('package.json'));
    expect(packageJson['x-provenance']).toMatchObject({
      ownerCode: 'wha9917',
      runtimeEffect: 'none'
    });

    expect(read('scripts/prepare-release.mjs')).toContain('electron-builder');
    expect(read('scripts/prepare-release-offline.mjs')).toContain("'x-provenance': pkg['x-provenance']");
  });

  test.each([
    'scripts/prepare-release.mjs',
    'scripts/prepare-release-offline.mjs',
  ])('%s excludes bundled user state and audits the completed release', (relativePath) => {
    const source = read(relativePath);

    expect(source).toContain("name === 'data'");
    expect(source).toContain("name === 'cache'");
    expect(source).toContain("name === 'logs'");
    expect(source).toContain('audit-portable-release.ps1');
  });

  test('release sync stages, audits and atomically commits instead of overlaying the formal tree', () => {
    const sync = read('sync-to-release.ps1');
    const main = read('electron/main.ts');
    const check = read('check-sync.ps1');

    expect(sync).toContain('clean-portable-release.ps1');
    expect(sync).toContain('audit-portable-release.ps1');
    expect(sync).toContain('release-templates\\start.bat');
    expect(sync).toContain("@('services', 'public', 'prompts', 'character')");
    expect(sync).toContain("'.staging-'");
    expect(sync).toContain("'.previous-'");
    expect(sync).toContain("'.retry-'");
    expect(sync).toContain('[ChatX2ReleaseNative]::MoveDirectory($formal, $backup)');
    expect(sync).toContain('[ChatX2ReleaseNative]::MoveDirectory($backup, $formal)');
    expect(sync).toContain('release-manifest.json');
    expect(sync).toContain('materialize-shared-motion-baseline.mjs');
    expect(sync).toContain("@('scripts\\materialize-shared-motion-baseline.mjs','resources\\app\\release-tools\\materialize-shared-motion-baseline.mjs')");
    expect(sync).toContain("models\\shared\\motions");
    expect(sync).toContain('Get-UserConfigSnapshot');
    expect(sync).toContain('KeepPreviousReleases');
    expect(sync).toContain('Prune-PreviousReleases');
    expect(sync).toContain('Write-Utf8NoBomAtomic');
    expect(sync).toContain('UTF-8 BOM');
    expect(sync).toContain("SetEnvironmentVariable('CHATX2_USER_DATA_DIR', $isolatedUserData, 'Process')");
    expect(sync).toContain("SetEnvironmentVariable('CHATX2_RELEASE_AUDIT', '1', 'Process')");
    expect(main).toContain('process.env.CHATX2_USER_DATA_DIR?.trim()');
    expect(main).toContain("process.env.CHATX2_RELEASE_AUDIT === '1'");
    expect(check).toContain('release-manifest.json');
    expect(check).toContain('Get-FileHash');
    expect(check).toContain('audit-portable-release.ps1');

    const materialize = read('scripts/materialize-shared-motion-baseline.mjs');
    expect(materialize).toContain('safeMotionRelativePath');
    expect(materialize).toContain('manifest.motions.vmdEmotionMapCandidates');
    expect(materialize).not.toContain('deletedNames.has');
  });

  test('one-click launcher delegates to the self-contained Electron executable', () => {
    const launcher = read('scripts/release-templates/start.bat');

    expect(launcher).toContain('伊利斯ChatX2.exe');
    expect(launcher).not.toContain('where node');
    expect(launcher).not.toContain('python.exe');
  });

  test('release audit rejects duplicate roots, histories, logs, caches, and API keys', () => {
    const audit = read('scripts/audit-portable-release.ps1');

    for (const marker of [
      'resources\\app\\dist\\electron\\electron',
      'resources\\app\\dist\\renderer\\renderer',
      'resources\\app\\chat5-compat\\data',
      'resources\\app\\chat5-compat\\cache',
      'resources\\app\\chat5-compat\\logs',
      'chat_history',
      'compressed_history',
      'apiKey',
      'sk-[A-Za-z0-9_-]',
    ]) {
      expect(audit).toContain(marker);
    }
  });

  test('release cleanup removes stale nested Electron and renderer build roots', () => {
    const clean = read('scripts/clean-portable-release.ps1');

    expect(clean).toContain('resources\\app\\dist\\electron\\electron');
    expect(clean).toContain('resources\\app\\dist\\renderer\\renderer');
  });
});
