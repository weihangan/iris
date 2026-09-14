import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_AVATAR_COMPUTE_LEVEL,
  loadAvatarComputeLevel,
  saveAvatarComputeLevel
} from '../../electron/avatar-compute-settings';

describe('avatar compute settings', () => {
  it('defaults new installations to high model quality', () => {
    expect(DEFAULT_AVATAR_COMPUTE_LEVEL).toBe('high');
  });
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function path(): string {
    const dir = mkdtempSync(join(tmpdir(), 'chatx2-avatar-compute-'));
    dirs.push(dir);
    return join(dir, 'nested', 'avatar-compute-settings.json');
  }

  it('persists and restores the selected compute level', () => {
    const settingsPath = path();
    expect(saveAvatarComputeLevel(settingsPath, 'high')).toBe(true);
    expect(loadAvatarComputeLevel(settingsPath)).toBe('high');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ level: 'high' });
  });

  it('falls back to high for missing, malformed and unknown data', () => {
    const settingsPath = path();
    expect(loadAvatarComputeLevel(settingsPath)).toBe('high');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, '{bad', 'utf8');
    expect(loadAvatarComputeLevel(settingsPath)).toBe('high');
    writeFileSync(settingsPath, JSON.stringify({ level: 'turbo' }), 'utf8');
    expect(loadAvatarComputeLevel(settingsPath)).toBe('high');
  });

  it('rejects invalid values without replacing the previous setting', () => {
    const settingsPath = path();
    expect(saveAvatarComputeLevel(settingsPath, 'ultra')).toBe(true);
    expect(saveAvatarComputeLevel(settingsPath, 'turbo' as never)).toBe(false);
    expect(loadAvatarComputeLevel(settingsPath)).toBe('ultra');
  });
});
