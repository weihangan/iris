import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('avatar startup loading policy', () => {
  it('overlaps read-only startup IPC and preloads the selected default VMD', () => {
    const renderer = readFileSync(resolve('src/desktop-avatar-renderer.ts'), 'utf8');

    expect(renderer).toContain('const startupIdentityPromise = api.getIdentity()');
    expect(renderer).toContain('const startupComputeLevelPromise = api.getRenderQuality()');
    expect(renderer).toContain('const startupModelPackPromise = api.getCurrentModelPack()');
    expect(renderer).toContain('const startupDefaultIdlePreloadPromise = startupModelPackPromise.then');
    expect(renderer).toContain('await Promise.all([startupComputeLevelPromise, api.loadPmxModel()])');
    expect(renderer).toContain('await startupDefaultIdlePreloadPromise');
  });

  it('does not fade the first default idle in from the PMX rest pose', () => {
    const renderer = readFileSync(resolve('src/desktop-avatar-renderer.ts'), 'utf8');

    expect(renderer).toContain('const isInitialIdleBind = !motionPlayer.isPlaying() && transitionProfile === undefined;');
    expect(renderer).toContain('fadeInSeconds: isInitialIdleBind ? 0 : Math.max(1.0, manifest.fadeInSeconds ?? 1.0)');
  });
});
