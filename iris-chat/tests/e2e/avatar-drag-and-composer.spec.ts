import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const evidenceDir = resolve('docs', 'evidence', 'avatar-drag-composer-2026-08-05');

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  await expect.poll(async () => {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return true;
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  for (const page of app.windows()) {
    if ((await page.title().catch(() => '')).includes(titlePart)) return page;
  }
  throw new Error(`window not found: ${titlePart}`);
}

interface DragMeasurement {
  maxAngle: number;
  maxP90Angle: number;
  maxInertia: number;
  currentYaw: number;
  targetYaw: number;
  gazeYaw: number;
  gazePitch: number;
  maxRelativeDetach: number;
  p90RelativeDetach: number;
  maxRelativeDetachBone: string | null;
  anchoredSampleCount: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function waitForSettledPhysics(avatar: Page): Promise<{ p90Step: number; stableSamples: number }> {
  return avatar.evaluate(async () => {
    const runtime = (window as any).__chatx2Runtime;
    const names: string[] = runtime.__debugDynamicBoneNames()
      .filter((name: string) => /hair|髪|发|髮|dress|裙|skirt|belt|リボン|ribbon/i.test(name))
      .slice(0, 120);
    let previous = runtime.__getBoneStates(names);
    let stableSamples = 0;
    let p90Step = Number.POSITIVE_INFINITY;
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      const current = runtime.__getBoneStates(names);
      const angles: number[] = [];
      for (const name of names) {
        const a = previous[name]?.quaternion;
        const b = current[name]?.quaternion;
        if (!a || !b) continue;
        const dot = Math.min(1, Math.abs(
          a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
        ));
        angles.push(2 * Math.acos(dot));
      }
      angles.sort((a, b) => a - b);
      p90Step = angles[Math.max(0, Math.ceil(angles.length * 0.9) - 1)] ?? 0;
      const inertia = runtime.__debugPhysicsContinuity().rootInertiaDriver;
      const inertiaMagnitude = Math.hypot(inertia[0], inertia[1], inertia[2]);
      // Allow sub-degree natural secondary sway while rejecting visible
      // loading/launch motion before the common drag trajectory begins.
      stableSamples = p90Step < 0.015 && inertiaMagnitude < 0.001
        ? stableSamples + 1
        : 0;
      if (stableSamples >= 5) return { p90Step, stableSamples };
      previous = current;
    }
    throw new Error(`physics did not settle: p90Step=${p90Step}, stableSamples=${stableSamples}`);
  });
}

async function dragAndMeasure(avatar: Page, duringDragScreenshotPath?: string): Promise<DragMeasurement> {
  const setup = await avatar.evaluate(() => {
    const runtime = (window as any).__chatx2Runtime;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const names: string[] = runtime.__debugDynamicBoneNames();
    const candidates = names.filter(name => /hair|髪|发|髮|dress|裙|skirt|belt|リボン|ribbon/i.test(name));
    const secondary = runtime.__debugBonePhysicsPipeline(candidates)
      .filter((entry: any) => entry.anchoredToAnimatedParent)
      .map((entry: any) => entry.boneName)
      .slice(0, 120);
    let hit: { x: number; y: number } | null = null;
    for (let y = 80; y < innerHeight - 80 && !hit; y += 30) {
      for (let x = 80; x < innerWidth - 80; x += 30) {
        if (runtime.__testIsPointOnModel(x, y)) { hit = { x, y }; break; }
      }
    }
    if (!hit) throw new Error('no rendered model hit point found');
    const before = runtime.__getBoneStates(secondary);
    const baselineRelative = Object.fromEntries(
      runtime.__debugBonePhysicsPipeline(secondary).map((entry: any) => [
        entry.boneName,
        entry.relativePhysicsDisplacement
      ])
    );
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: hit.x, clientY: hit.y }));
    return { hit, secondary, before, baselineRelative };
  });

  let maxAngle = 0;
  let maxP90Angle = 0;
  let maxInertia = 0;
  let maxRelativeDetach = 0;
  let p90RelativeDetach = 0;
  let maxRelativeDetachBone: string | null = null;
  let anchoredSampleCount = 0;
  for (let step = 1; step <= 12; step += 1) {
    const sample = await avatar.evaluate(async ({ hit, secondary, before, baselineRelative, step }) => {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: hit.x + step * 10,
        clientY: hit.y + Math.sin(step / 2) * 12
      }));
      // The event only updates the model-root target. Wait until the real
      // renderer/physics frame consumes it before sampling dynamic bones.
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
      const current = (window as any).__chatx2Runtime.__getBoneStates(secondary);
      let angle = 0;
      const angles: number[] = [];
      for (const name of secondary) {
        const a = before[name]?.quaternion;
        const b = current[name]?.quaternion;
        if (!a || !b) continue;
        const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
        const boneAngle = 2 * Math.acos(dot);
        angle = Math.max(angle, boneAngle);
        angles.push(boneAngle);
      }
      angles.sort((a, b) => a - b);
      const p90Angle = angles[Math.max(0, Math.ceil(angles.length * 0.9) - 1)] ?? 0;
      const inertia = (window as any).__chatx2Runtime.__debugPhysicsContinuity().rootInertiaDriver;
      const relativeSteps: Array<{ boneName: string; distance: number }> = [];
      for (const entry of (window as any).__chatx2Runtime.__debugBonePhysicsPipeline(secondary)) {
        if (!entry.anchoredToAnimatedParent) continue;
        const baseline = baselineRelative[entry.boneName];
        const currentRelative = entry.relativePhysicsDisplacement;
        if (!baseline || !currentRelative) continue;
        relativeSteps.push({
          boneName: entry.boneName,
          distance: Math.hypot(
            currentRelative[0] - baseline[0],
            currentRelative[1] - baseline[1],
            currentRelative[2] - baseline[2]
          )
        });
      }
      relativeSteps.sort((a, b) => a.distance - b.distance);
      const largestRelative = relativeSteps.at(-1);
      return {
        angle,
        p90Angle,
        inertia: Math.hypot(inertia[0], inertia[1], inertia[2]),
        maxRelativeDetach: largestRelative?.distance ?? 0,
        p90RelativeDetach: relativeSteps[Math.max(0, Math.ceil(relativeSteps.length * 0.9) - 1)]?.distance ?? 0,
        maxRelativeDetachBone: largestRelative?.boneName ?? null,
        anchoredSampleCount: relativeSteps.length
      };
    }, { ...setup, step });
    maxAngle = Math.max(maxAngle, sample.angle);
    maxP90Angle = Math.max(maxP90Angle, sample.p90Angle);
    maxInertia = Math.max(maxInertia, sample.inertia);
    if (sample.maxRelativeDetach > maxRelativeDetach) {
      maxRelativeDetach = sample.maxRelativeDetach;
      maxRelativeDetachBone = sample.maxRelativeDetachBone;
    }
    p90RelativeDetach = Math.max(p90RelativeDetach, sample.p90RelativeDetach);
    anchoredSampleCount = Math.max(anchoredSampleCount, sample.anchoredSampleCount);
    await avatar.waitForTimeout(30);
  }
  if (duringDragScreenshotPath) {
    await avatar.screenshot({ path: duringDragScreenshotPath });
  }
  await avatar.evaluate(({ hit }) => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: hit.x + 120, clientY: hit.y }));
  }, setup);
  // Let the previous release oscillation settle so each trial measures one
  // independent drag, not Yangyang's intentionally longer residual swing.
  await avatar.waitForTimeout(1_500);
  const facing = await avatar.evaluate(() => (window as any).__chatx2Runtime.__debugUserFacing());
  return {
    maxAngle,
    maxP90Angle,
    maxInertia,
    maxRelativeDetach,
    p90RelativeDetach,
    maxRelativeDetachBone,
    anchoredSampleCount,
    ...facing
  };
}

test('composer fits every control and both models retain visible drag physics', async () => {
  test.setTimeout(180_000);
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = join(tmpdir(), `chatx2-drag-composer-${Date.now()}`);
  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: { ...process.env, NODE_ENV: 'test', CHAT6_PMX_RENDER_IN_TEST: '1', CHAT6_TEST_USER_DATA: userDataDir }
  });
  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()), { timeout: 45_000 }).toBe(true);
    if (await chat.evaluate(() => (window as any).chatx2.getMode()) !== 'desktop') {
      expect((await chat.evaluate(() => (window as any).chatx2.transition('desktop'))).status).toBe('ok');
    }
    const composer = await findWindow(app, 'Composer');
    const layout = await composer.evaluate(() => {
      const controls = [...document.querySelectorAll('#input-row, #compute-row, #avatar-ctrl-bar, #avatar-ctrl-bar button')];
      return {
        width: innerWidth,
        height: innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        controlsInside: controls.every(element => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
        })
      };
    });
    expect(layout.width).toBeGreaterThanOrEqual(650);
    expect(layout.height).toBeLessThanOrEqual(120);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height);
    expect(layout.controlsInside).toBe(true);
    await composer.screenshot({ path: join(evidenceDir, 'composer-all-controls.png') });

    const results: Record<string, { trials: DragMeasurement[]; medianAngle: number; medianP90Angle: number; medianInertia: number }> = {};
    for (const packId of ['selena-xisheng-v1', 'yyxuanling-v1']) {
      expect((await chat.evaluate(id => (window as any).chatx2.switchModelPack(id), packId)).success).toBe(true);
      // Model switching schedules an Avatar reload after the IPC result. Wait
      // past that scheduling edge before observing the new renderer runtime.
      await chat.waitForTimeout(900);
      const avatar = await findWindow(app, 'Avatar');
      await expect.poll(() => avatar.evaluate(async id => {
        const pack = await (window as any).chatx2.getCurrentModelPack();
        return pack?.packId === id && (window as any).__chatx2Runtime?.__debugDynamicBoneNames?.().length > 0;
      }, packId), { timeout: 45_000 }).toBe(true);
      await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(true));
      await waitForSettledPhysics(avatar);
      // Compare one identical drag from each freshly loaded, settled Bullet
      // world. Reusing a world for repeated trials measures the previous
      // model-specific residual swing, not the response to the same input.
      const trials: DragMeasurement[] = [await dragAndMeasure(
        avatar,
        join(evidenceDir, `${packId}-during-fast-drag.png`)
      )];
      results[packId] = {
        trials,
        medianAngle: median(trials.map(result => result.maxAngle)),
        medianP90Angle: median(trials.map(result => result.maxP90Angle)),
        medianInertia: median(trials.map(result => result.maxInertia))
      };
      await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(false));
      await avatar.screenshot({ path: join(evidenceDir, `${packId}-after-drag.png`) });
      expect(results[packId].medianP90Angle).toBeGreaterThan(0.001);
      expect(results[packId].medianInertia).toBeGreaterThan(0.00001);
      const latest = trials.at(-1)!;
      expect(Math.abs(latest.targetYaw)).toBeGreaterThan(0.01);
      expect(Math.abs(latest.currentYaw)).toBeGreaterThan(0.005);
      expect(Math.abs(latest.currentYaw)).toBeLessThanOrEqual(14 * Math.PI / 180 + 1e-4);
      expect(Number.isFinite(latest.gazeYaw)).toBe(true);
      expect(Number.isFinite(latest.gazePitch)).toBe(true);
      expect(Math.abs(latest.gazeYaw)).toBeLessThanOrEqual(0.28);
      expect(Math.abs(latest.gazePitch)).toBeLessThanOrEqual(0.18);
    }
    const selena = results['selena-xisheng-v1'];
    const yangyang = results['yyxuanling-v1'];
    console.log('[avatar-drag-response]', JSON.stringify(results, null, 2));
    for (const result of Object.values(results)) {
      const latest = result.trials.at(-1)!;
      expect(latest.anchoredSampleCount).toBeGreaterThan(0);
      expect(latest.maxRelativeDetach).toBeLessThan(0.08);
      expect(latest.p90RelativeDetach).toBeLessThan(0.05);
    }
    expect(Math.abs(selena.medianP90Angle - yangyang.medianP90Angle))
      .toBeLessThan(0.035);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
