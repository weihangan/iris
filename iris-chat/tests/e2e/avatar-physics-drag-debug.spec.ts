import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

test('debug: per-frame attachment lag timeline during fast root drag', async () => {
  test.setTimeout(180_000);
  const userDataDir = join(tmpdir(), `chatx2-drag-debug-${Date.now()}`);
  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_USER_DATA: userDataDir,
      CHATX2_SHARED_DATA_DIR: userDataDir
    }
  });
  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 45_000 }).toBe(true);
    const initialMode = await chat.evaluate(() => (window as any).chatx2.getMode());
    if (initialMode !== 'desktop') {
      const transition = await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(transition.status).toBe('ok');
    }
    const switched = await chat.evaluate(() =>
      (window as any).chatx2.switchModelPack('selena-xisheng-v1'));
    expect(switched.success, switched.reason).toBe(true);
    const avatar = await findWindow(app, 'Avatar');
    await expect.poll(() => avatar.evaluate(async () => {
      const runtime = (window as any).__chatx2Runtime;
      const current = await (window as any).chatx2.getCurrentModelPack();
      return current?.packId === 'selena-xisheng-v1'
        && runtime?.__debugDynamicBoneNames?.().length > 0
        && (runtime?.__debugPhysicsContinuity?.()?.monotonicSeconds ?? 0) > 0.2;
    }), { timeout: 45_000 }).toBe(true);
    await avatar.waitForTimeout(2_000);
    await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(true));
    await avatar.waitForTimeout(1_500);

    const timeline = await avatar.evaluate(async () => {
      const runtime = (window as any).__chatx2Runtime;
      const canvas = document.querySelector('canvas')!;
      const tracked = ['Fhair_1', 'Fhair_5', 'Fhair_11', 'M_BHair_1', '右Shair_1',
        'Dress_0_11', '左Dress_0_1', '頭', '首', '上半身'];
      let hit: { x: number; y: number } | null = null;
      for (let y = 80; y < innerHeight - 80 && !hit; y += 30) {
        for (let x = 80; x < innerWidth - 80; x += 30) {
          if (runtime.__testIsPointOnModel(x, y)) {
            hit = { x, y };
            break;
          }
        }
      }
      if (!hit) throw new Error('no rendered model hit point found');
      const guardList = (runtime.__debugRootDragAttachmentBoneNames?.() ?? []) as string[];
      const guardSet = new Set(guardList);
      // eslint-disable-next-line no-console
      console.log('guard membership:', tracked.map(name =>
        `${name}:${guardSet.has(name) ? 'IN' : 'OUT'}`).join(' '),
      `guardTotal=${guardList.length}`);
      // 同名骨骼解析探针：guard 持有对象 vs 测试侧 findBone 线性命中是否同一对象。
      // eslint-disable-next-line no-console
      console.log('bone resolution:',
        JSON.stringify(runtime.__debugRootDragBoneResolution?.(tracked) ?? null));
      const beforeRootLocal = runtime.__getBoneRootLocalPositions(tracked);
      const beforeQuat = runtime.__getBoneStates(tracked);
      const beforeRootWorld = (runtime as any).__getBoneWorldPositions?.(['全ての親'])?.['全ての親'] ?? null;
      const rootWorldFrames: Array<[number, number, number] | null> = [];
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: hit.x, clientY: hit.y
      }));
      const frames: Array<Record<string, number | string | boolean | null>> = [];
      const started = performance.now();
      const releaseAt = started + 120;
      const deadline = releaseAt + 2_600;
      let released = false;
      let prevContinuity: any = null;
      while (performance.now() < deadline) {
        await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
        if (!released) {
          const progress = Math.min(1, (performance.now() - started) / 120);
          document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1,
            clientX: hit.x + 120 * progress, clientY: hit.y
          }));
        }
        if (!released && performance.now() >= releaseAt) {
          document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, button: 0, clientX: hit.x + 120, clientY: hit.y
          }));
          released = true;
        }
        const currentRootLocal = runtime.__getBoneRootLocalPositions(tracked);
        const currentQuat = runtime.__getBoneStates(tracked);
        const continuity = runtime.__debugPhysicsContinuity();
        const guardFrame = (runtime.__debugRootDragAttachmentFrame?.() ?? []) as Array<{
          boneName: string; rawPositionOffset: number; clamped: boolean;
          postClampPositionOffset: number;
        }>;
        const guardByName = new Map(guardFrame.map(entry => [entry.boneName, entry]));
        const rows: Array<{ name: string; lag: number; dx: number; dy: number; dz: number }> = [];
        for (const name of tracked) {
          const first = beforeRootLocal[name];
          const latest = currentRootLocal[name];
          if (!first || !latest) continue;
          rows.push({
            name,
            lag: Math.hypot(latest[0] - first[0], latest[1] - first[1], latest[2] - first[2]),
            dx: latest[0] - first[0],
            dy: latest[1] - first[1],
            dz: latest[2] - first[2]
          });
        }
        rows.sort((a, b) => b.lag - a.lag);
        const angleOf = (name: string): number => {
          const a = beforeQuat[name]?.quaternion;
          const b = currentQuat[name]?.quaternion;
          if (!a || !b) return -1;
          const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
          return 2 * Math.acos(dot);
        };
        frames.push({
          tMs: Math.round(performance.now() - started),
          released,
          worstBone: rows[0]?.name ?? '-',
          worstLag: rows[0]?.lag ?? 0,
          worstDx: rows[0]?.dx ?? 0,
          worstDy: rows[0]?.dy ?? 0,
          worstDz: rows[0]?.dz ?? 0,
          fhair1Lag: rows.find(r => r.name === 'Fhair_1')?.lag ?? 0,
          fhair1Dx: rows.find(r => r.name === 'Fhair_1')?.dx ?? 0,
          fhair1Dy: rows.find(r => r.name === 'Fhair_1')?.dy ?? 0,
          fhair1Dz: rows.find(r => r.name === 'Fhair_1')?.dz ?? 0,
          dress11Lag: rows.find(r => r.name === 'Dress_0_11')?.lag ?? 0,
          fhair1GuardRaw: guardByName.get('Fhair_1')?.rawPositionOffset ?? -1,
          fhair1GuardPost: guardByName.get('Fhair_1')?.postClampPositionOffset ?? -1,
          fhair1GuardClamped: guardByName.get('Fhair_1')?.clamped ?? false,
          dress11GuardRaw: guardByName.get('Dress_0_11')?.rawPositionOffset ?? -1,
          guardEntryCount: guardFrame.length,
          headAngle: angleOf('頭'),
          neckAngle: angleOf('首'),
          upperAngle: angleOf('上半身'),
          rootWorld: (runtime as any).__getBoneWorldPositions?.(['全ての親'])?.['全ての親'] ?? null,
          rootDx: (() => {
            const cur = (runtime as any).__getBoneWorldPositions?.(['全ての親'])?.['全ての親'];
            if (!beforeRootWorld || !cur) return 0;
            return cur[0] - beforeRootWorld[0];
          })(),
          inertia: Math.hypot(continuity.rootInertiaDriver[0],
            continuity.rootInertiaDriver[1], continuity.rootInertiaDriver[2]),
          monotonic: continuity.monotonicSeconds,
          resets: continuity.forwardedResetCount,
          lastResetReason: continuity.lastHardResetReason,
          resetChanged: prevContinuity
            ? (continuity.forwardedResetCount !== prevContinuity.forwardedResetCount)
            : false
        });
        prevContinuity = continuity;
      }
      if (!released) {
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, button: 0, clientX: hit.x + 120, clientY: hit.y
        }));
      }
      return frames;
    });
    await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(false));
    // eslint-disable-next-line no-console
    console.log('--- lag > 0.040 frames ---');
    // eslint-disable-next-line no-console
    console.table(timeline.filter(f => (f.worstLag as number) > 0.040)
      .map(f => ({
        tMs: f.tMs, released: f.released, worstBone: f.worstBone,
        worstLag: f.worstLag, worstDx: f.worstDx, worstDy: f.worstDy, worstDz: f.worstDz,
        fhair1Lag: f.fhair1Lag, fhair1Dx: f.fhair1Dx, fhair1Dy: f.fhair1Dy, fhair1Dz: f.fhair1Dz,
        fhair1GuardRaw: f.fhair1GuardRaw, fhair1GuardPost: f.fhair1GuardPost,
        fhair1GuardClamped: f.fhair1GuardClamped, dress11Lag: f.dress11Lag,
        dress11GuardRaw: f.dress11GuardRaw, guardEntryCount: f.guardEntryCount,
        rootDx: f.rootDx, inertia: f.inertia
      })));
    // eslint-disable-next-line no-console
    console.log('--- reset events ---');
    // eslint-disable-next-line no-console
    console.table(timeline.filter(f => f.resetChanged === true)
      .map(f => ({ tMs: f.tMs, resets: f.resets, reason: f.lastResetReason })));
    // eslint-disable-next-line no-console
    console.log('--- sampled frames (every 6th) ---');
    // eslint-disable-next-line no-console
    console.table(timeline.filter((_, i) => i % 6 === 0));
  } finally {
    await app.close().catch(() => {});
  }
});
