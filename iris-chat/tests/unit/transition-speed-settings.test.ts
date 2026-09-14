import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  loadTransitionSpeed,
  saveTransitionSpeed
} from '../../electron/transition-speed-settings';

describe('transition speed settings', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function settingsPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'chatx2-transition-speed-'));
    tempDirs.push(dir);
    return join(dir, 'nested', 'avatar-motion-settings.json');
  }

  test('persists a valid speed and restores it after restart', () => {
    const path = settingsPath();

    expect(saveTransitionSpeed(path, 0.55)).toBe(true);
    expect(loadTransitionSpeed(path)).toBe(0.55);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ transitionSpeed: 0.55 });
  });

  test('falls back to the safe default for missing, malformed or out-of-range data', () => {
    const path = settingsPath();
    expect(loadTransitionSpeed(path)).toBe(0.7);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{invalid', 'utf8');
    expect(loadTransitionSpeed(path)).toBe(0.7);

    writeFileSync(path, JSON.stringify({ transitionSpeed: 9 }), 'utf8');
    expect(loadTransitionSpeed(path)).toBe(0.7);
  });

  test('rejects invalid values instead of corrupting the saved preference', () => {
    const path = settingsPath();
    expect(saveTransitionSpeed(path, 0.6)).toBe(true);
    expect(saveTransitionSpeed(path, Number.NaN)).toBe(false);
    expect(saveTransitionSpeed(path, 0.49)).toBe(false);
    expect(saveTransitionSpeed(path, 1.81)).toBe(false);
    expect(loadTransitionSpeed(path)).toBe(0.6);
  });
});
