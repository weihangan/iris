import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUTPUT_DIR = resolve(__dirname, '..', '..', 'temp', 'selena-thigh-render-stability');
const BONE_NAMES = ['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'] as const;

type BoneState = {
  quaternion: number[];
  position: number[];
} | null;

type FrameSample = {
  elapsedMs: number;
  bones: Record<string, BoneState>;
  roi: {
    opaque: number;
    hash: number;
    rgbSum: number;
    bbox: { minX: number; maxX: number; minY: number; maxY: number } | null;
    region: { x0: number; x1: number; y0: number; y1: number } | null;
  };
};

async function findWindow(
  app: ElectronApplication,
  predicate: (page: Page) => Promise<boolean>,
  timeoutMs = 15_000
): Promise<Page> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const page of app.windows()) {
      if (await predicate(page).catch(() => false)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const titles = await Promise.all(app.windows().map(page => page.title().catch(() => '?')));
  throw new Error(`window not found; titles=${JSON.stringify(titles)}`);
}

async function launchRealPmx(): Promise<{
  app: ElectronApplication;
  chat: Page;
  avatar: Page;
  userDataDir: string;
}> {
  const app = await _electron.launch({
    args: [resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1'
    }
  });
  const chat = await findWindow(app, page => page.evaluate(
    () => typeof (window as any).chatx2?.transition === 'function'
  ));
  const identity = await chat.evaluate(() => (window as any).chatx2.getIdentity());
  await expect.poll(
    () => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
    { timeout: 30_000 }
  ).toBe(true);
  await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
  await expect.poll(
    () => chat.evaluate(() => (window as any).chatx2.getMode()),
    { timeout: 10_000 }
  ).toBe('desktop');
  const avatar = await findWindow(app, page => page.evaluate(
    () => Boolean((window as any).__chatx2Runtime?.avatarLoop)
  ));
  return { app, chat, avatar, userDataDir: identity.userDataDir };
}

async function cleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => undefined);
  if (userDataDir.includes('chat6-test-')) {
    for (let attempt = 0; attempt < 10 && existsSync(userDataDir); attempt += 1) {
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* retry */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
  }
}

async function sampleFrame(avatar: Page, elapsedMs: number): Promise<FrameSample> {
  return avatar.evaluate(({ boneNames, elapsed }) => {
    const runtime = (window as any).__chatx2Runtime;
    const bones: Record<string, BoneState> = {};
    for (const name of boneNames) bones[name] = runtime?.__getBoneState?.(name) ?? null;

    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    if (!canvas || !gl) {
      return {
        elapsedMs: elapsed,
        bones,
        roi: { opaque: 0, hash: 0, rgbSum: 0, bbox: null, region: null }
      };
    }

    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] <= 16) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) {
      return {
        elapsedMs: elapsed,
        bones,
        roi: { opaque: 0, hash: 0, rgbSum: 0, bbox: null, region: null }
      };
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    // WebGL y=0 is the bottom. Selena's upper thighs occupy the central 36%
    // horizontally and roughly 32%-54% up from the bottom of the full-body box.
    const x0 = Math.floor(minX + boxWidth * 0.32);
    const x1 = Math.ceil(minX + boxWidth * 0.68);
    const y0 = Math.floor(minY + boxHeight * 0.32);
    const y1 = Math.ceil(minY + boxHeight * 0.54);
    let opaque = 0;
    let rgbSum = 0;
    let hash = 2166136261 >>> 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = pixels[offset + 3];
        if (alpha <= 16) continue;
        opaque += 1;
        for (let channel = 0; channel < 4; channel += 1) {
          const value = pixels[offset + channel];
          rgbSum += channel < 3 ? value : 0;
          hash ^= value;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
      }
    }
    return {
      elapsedMs: elapsed,
      bones,
      roi: {
        opaque,
        hash,
        rgbSum,
        bbox: { minX, maxX, minY, maxY },
        region: { x0, x1, y0, y1 }
      }
    };
  }, { boneNames: [...BONE_NAMES], elapsed: elapsedMs });
}

function maxComponentDrift(samples: FrameSample[], boneName: string): number {
  const states = samples.map(sample => sample.bones[boneName]).filter(Boolean) as Exclude<BoneState, null>[];
  if (states.length < 2) return Number.NaN;
  const base = [...states[0].position, ...states[0].quaternion];
  return Math.max(...states.map(state => {
    const values = [...state.position, ...state.quaternion];
    return Math.max(...values.map((value, index) => Math.abs(value - base[index])));
  }));
}

test.describe('Selena thigh render stability diagnostic', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('captures real-PMX leg transforms and thigh pixels across moving and static frames', async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const { app, avatar, userDataDir } = await launchRealPmx();
    try {
      await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        runtime?.cameraControl?.setAngle('full');
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
      });
      await expect.poll(
        () => avatar.evaluate(() => (window as any).__chatx2Runtime?.motionPlayer?.getState?.()),
        { timeout: 10_000 }
      ).toBe('playing');
      // Exclude the admitted one-second fade/IK settling interval. The gate is
      // aimed at continuing idle jitter, not the intentional transition in.
      await avatar.waitForTimeout(1_200);
      await avatar.locator('#canvas').screenshot({ path: resolve(OUTPUT_DIR, 'before-running.png') });

      const running: FrameSample[] = [];
      const runningStarted = Date.now();
      for (let index = 0; index < 80; index += 1) {
        running.push(await sampleFrame(avatar, Date.now() - runningStarted));
        await avatar.waitForTimeout(50);
      }
      await avatar.locator('#canvas').screenshot({ path: resolve(OUTPUT_DIR, 'after-running.png') });

      const activeMotion = await avatar.evaluate(() => {
        const player = (window as any).__chatx2Runtime?.motionPlayer;
        return {
          packId: player?.getCurrentPackId?.() ?? null,
          state: player?.getState?.() ?? null,
          boneNames: player?.getCurrentBoneNames?.() ?? []
        };
      });

      await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        runtime?.motionPlayer?.stop();
        runtime?.avatarLoop?.stop();
        runtime?.avatarLoop?.renderOneFrame();
      });
      await avatar.waitForTimeout(200);
      const staticSamples: FrameSample[] = [];
      for (let index = 0; index < 20; index += 1) {
        await avatar.evaluate(() => (window as any).__chatx2Runtime?.avatarLoop?.renderOneFrame());
        staticSamples.push(await sampleFrame(avatar, index * 50));
        await avatar.waitForTimeout(50);
      }
      await avatar.locator('#canvas').screenshot({ path: resolve(OUTPUT_DIR, 'static.png') });

      const report = {
        activeMotion,
        materialState: await avatar.evaluate(() => (window as any).__chatx2Runtime?.__debugGetMorphSplitState?.()),
        running: {
          samples: running.length,
          uniqueRoiHashes: new Set(running.map(sample => sample.roi.hash)).size,
          opaqueRange: [
            Math.min(...running.map(sample => sample.roi.opaque)),
            Math.max(...running.map(sample => sample.roi.opaque))
          ],
          boneMaxComponentDrift: Object.fromEntries(BONE_NAMES.map(name => [name, maxComponentDrift(running, name)]))
        },
        static: {
          samples: staticSamples.length,
          uniqueRoiHashes: new Set(staticSamples.map(sample => sample.roi.hash)).size,
          opaqueRange: [
            Math.min(...staticSamples.map(sample => sample.roi.opaque)),
            Math.max(...staticSamples.map(sample => sample.roi.opaque))
          ],
          boneMaxComponentDrift: Object.fromEntries(BONE_NAMES.map(name => [name, maxComponentDrift(staticSamples, name)]))
        }
      };
      writeFileSync(resolve(OUTPUT_DIR, 'diagnostic.json'), JSON.stringify({ report, running, staticSamples }, null, 2));
      console.log('[selena-thigh-stability]', JSON.stringify(report));

      expect(running[0].roi.opaque).toBeGreaterThan(100);
      expect(staticSamples[0].roi.opaque).toBeGreaterThan(100);
      expect(activeMotion.packId).toBe('../shared/motions/待机 女性的.vmd');
      expect(activeMotion.boneNames).not.toEqual(expect.arrayContaining([
        'センター', '下半身', '左足', '右足', '左足ＩＫ', '右足ＩＫ'
      ]));
      for (const boneName of BONE_NAMES) {
        expect(
          maxComponentDrift(running, boneName),
          `${boneName} must remain stable during automatic idle playback`
        ).toBeLessThan(1e-4);
      }
    } finally {
      await cleanup(app, userDataDir);
    }
  });
});
