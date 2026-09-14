import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('real PMX remains draggable while transparent space passes through', async () => {
  test.setTimeout(120_000);
  const userDataDir = join(tmpdir(), `chatx2-avatar-drag-${Date.now()}`);
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      args: [resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CHAT6_PMX_RENDER_IN_TEST: '1',
        CHAT6_TEST_USER_DATA: userDataDir
      }
    });

    let chat: Page | undefined;
    await expect.poll(async () => {
      for (const page of app!.windows()) {
        if ((await page.title().catch(() => '')).includes('伊利斯 ChatX2')) chat = page;
      }
      return Boolean(chat);
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => chat!.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 45_000 }).toBe(true);
    const initialMode = await chat!.evaluate(() => (window as any).chatx2.getMode());
    if (initialMode !== 'desktop') {
      const transition = await chat!.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(transition.status).toBe('ok');
    }

    let avatar: Page | undefined;
    await expect.poll(async () => {
      for (const page of app!.windows()) {
        if ((await page.title().catch(() => '')).includes('Avatar')) avatar = page;
      }
      return Boolean(avatar);
    }, { timeout: 15_000 }).toBe(true);

    await expect.poll(() => avatar!.evaluate(() =>
      typeof (window as any).__chatx2Runtime?.__testIsPointOnModel === 'function'
        && ((window as any).__chatx2Runtime?.__debugDynamicBoneNames?.().length ?? 0) > 0
        && ((window as any).__chatx2Runtime?.__debugPhysicsContinuity?.()?.monotonicSeconds ?? 0) > 0.2
    ), { timeout: 45_000 }).toBe(true);

    const hit = await avatar!.evaluate(() => {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      const hitTest = (window as any).__chatx2Runtime.__testIsPointOnModel as (x: number, y: number) => boolean;
      for (let y = 20; y < canvas.clientHeight; y += 20) {
        for (let x = 20; x < canvas.clientWidth; x += 20) {
          if (hitTest(x, y)) return { x, y, width: canvas.clientWidth, height: canvas.clientHeight };
        }
      }
      return null;
    });
    expect(hit, 'raycaster must find at least one visible model point').not.toBeNull();

    await avatar!.evaluate(() => (window as any).chatx2.setPoseLock(true));
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).chatx2.getPoseLock()
    )).toMatchObject({ locked: true });
    // Let the native PMX chains settle after the idle pose is frozen so the
    // following displacement measures drag-induced motion, not idle carryover.
    await avatar!.waitForTimeout(1_500);
    const beforeDrag = await avatar!.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      const names: string[] = runtime.__debugDynamicBoneNames();
      const sampledNames = names
        .filter((name, index) => name && index % Math.max(1, Math.floor(names.length / 32)) === 0)
        .slice(0, 32);
      const pipeline = runtime.__debugBonePhysicsPipeline(sampledNames);
      const rigidBodies = pipeline
        .flatMap((sample: any) => sample.rigidBodies)
        .filter((body: any) => body.motionType !== 'static' && body.worldMatrixColumnMajor)
        .map((body: any) => ({
          index: body.rigidBodyIndex,
          translation: body.worldMatrixColumnMajor.slice(12, 15)
        }));
      return {
        rootBone: runtime.__getBoneWorldPositions(['全ての親'])['全ての親'],
        pan: runtime.cameraControl.getPanOffset(),
        rigidBodies,
        continuity: runtime.__debugPhysicsContinuity()
      };
    });
    expect(beforeDrag.rigidBodies.length, 'the real PMX must expose sampled dynamic rigid bodies').toBeGreaterThan(0);

    await avatar!.mouse.move(hit!.x, hit!.y);
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ pointerOnModel: true, effectiveIgnoreMouse: false });

    await avatar!.mouse.down();
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ draggingModel: true, effectiveIgnoreMouse: false });
    await avatar!.mouse.move(hit!.x + 30, hit!.y + 15);
    await avatar!.mouse.up();

    const transientPhysics = await avatar!.evaluate(async (baselineBodies) => {
      const runtime = (window as any).__chatx2Runtime;
      const baseline = new Map(baselineBodies.map((body: any) => [body.index, body.translation]));
      const names: string[] = runtime.__debugDynamicBoneNames();
      const sampledNames = names
        .filter((name, index) => name && index % Math.max(1, Math.floor(names.length / 32)) === 0)
        .slice(0, 32);
      let maxLocalDisplacement = 0;
      for (let frame = 0; frame < 20; frame += 1) {
        const bodies = runtime.__debugBonePhysicsPipeline(sampledNames)
          .flatMap((sample: any) => sample.rigidBodies)
          .filter((body: any) => body.motionType !== 'static' && body.worldMatrixColumnMajor);
        for (const body of bodies) {
          const before = baseline.get(body.rigidBodyIndex) as number[] | undefined;
          if (!before) continue;
          const after = body.worldMatrixColumnMajor;
          maxLocalDisplacement = Math.max(maxLocalDisplacement, Math.hypot(
            after[12] - before[0],
            after[13] - before[1],
            after[14] - before[2]
          ));
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 16));
      }
      return { maxLocalDisplacement };
    }, beforeDrag.rigidBodies);
    expect(transientPhysics.maxLocalDisplacement,
      'dragging must retain a small model-local hair/clothing inertia response').toBeGreaterThan(1e-4);
    expect(transientPhysics.maxLocalDisplacement,
      'the transient secondary-motion response must remain bounded').toBeLessThan(0.5);

    await expect.poll(() => avatar!.evaluate((before) => {
      const current = (window as any).__chatx2Runtime
        .__getBoneWorldPositions(['全ての親'])['全ての親'];
      if (!current || !before) return 0;
      return Math.hypot(current[0] - before[0], current[1] - before[1], current[2] - before[2]);
    }, beforeDrag.rootBone), { timeout: 5_000 }).toBeGreaterThan(0.05);
    await avatar!.waitForTimeout(500);

    const afterDrag = await avatar!.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      const names: string[] = runtime.__debugDynamicBoneNames();
      const sampledNames = names
        .filter((name, index) => name && index % Math.max(1, Math.floor(names.length / 32)) === 0)
        .slice(0, 32);
      const pipeline = runtime.__debugBonePhysicsPipeline(sampledNames);
      const rigidBodies = pipeline
        .flatMap((sample: any) => sample.rigidBodies)
        .filter((body: any) => body.motionType !== 'static' && body.worldMatrixColumnMajor)
        .map((body: any) => ({
          index: body.rigidBodyIndex,
          translation: body.worldMatrixColumnMajor.slice(12, 15)
        }));
      return {
        rootBone: runtime.__getBoneWorldPositions(['全ての親'])['全ての親'],
        pan: runtime.cameraControl.getPanOffset(),
        rigidBodies,
        continuity: runtime.__debugPhysicsContinuity()
      };
    });
    expect(beforeDrag.rootBone).not.toBeNull();
    expect(afterDrag.rootBone).not.toBeNull();
    expect(Math.hypot(
      afterDrag.rootBone![0] - beforeDrag.rootBone![0],
      afterDrag.rootBone![1] - beforeDrag.rootBone![1],
      afterDrag.rootBone![2] - beforeDrag.rootBone![2]
    ), 'dragging must translate the model instead of faking movement with the camera').toBeGreaterThan(0.05);
    expect(Math.hypot(
      afterDrag.pan.x - beforeDrag.pan.x,
      afterDrag.pan.y - beforeDrag.pan.y
    ), 'dragging must preserve the camera pan').toBeLessThan(1e-5);
    expect(afterDrag.continuity.forwardedResetCount,
      'dragging must not reset or rebuild the Bullet world').toBe(beforeDrag.continuity.forwardedResetCount);

    const rootDelta = [
      afterDrag.rootBone![0] - beforeDrag.rootBone![0],
      afterDrag.rootBone![1] - beforeDrag.rootBone![1],
      afterDrag.rootBone![2] - beforeDrag.rootBone![2]
    ];
    const rootDisplacement = Math.hypot(rootDelta[0], rootDelta[1], rootDelta[2]);
    const afterBodies = new Map(afterDrag.rigidBodies.map((body: any) => [body.index, body.translation]));
    const rigidBodyDeltas = beforeDrag.rigidBodies.flatMap((body: any) => {
      const after = afterBodies.get(body.index) as number[] | undefined;
      if (!after) return [];
      return [[
        after[0] - body.translation[0],
        after[1] - body.translation[1],
        after[2] - body.translation[2]
      ]];
    });
    expect(rigidBodyDeltas.length).toBeGreaterThan(0);
    expect(rigidBodyDeltas.flat().every(Number.isFinite), 'dynamic rigid-body transforms must stay finite').toBe(true);
    const localRigidBodyDisplacements = rigidBodyDeltas.map((delta: number[]) =>
      Math.hypot(delta[0], delta[1], delta[2]));
    const composedWorldDisplacements = rigidBodyDeltas.map((delta: number[]) =>
      Math.hypot(
        delta[0] + rootDelta[0],
        delta[1] + rootDelta[1],
        delta[2] - rootDelta[2]
      ));
    const maxLocalRigidBodyDisplacement = Math.max(...localRigidBodyDisplacements);
    const maxComposedWorldDisplacement = Math.max(...composedWorldDisplacements);
    console.log('[avatar-drag-physics]', {
      rootDisplacement,
      maxLocalRigidBodyDisplacement,
      maxComposedWorldDisplacement,
      beforeContinuity: beforeDrag.continuity,
      afterContinuity: afterDrag.continuity
    });
    expect(maxComposedWorldDisplacement,
      'hair and clothing rigid bodies must follow the translated model in composed scene space').toBeGreaterThan(0.05);
    expect(maxLocalRigidBodyDisplacement,
      'a small drag must not launch any model-local rigid body away from its character')
      .toBeLessThan(Math.max(1, rootDisplacement * 2));

    await avatar!.mouse.move(2, 2);
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ pointerOnModel: false, draggingModel: false, effectiveIgnoreMouse: true });

    await avatar!.evaluate(() => (window as any).chatx2.setModelPassThrough(true));
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ manualModelPassThrough: true, effectiveIgnoreMouse: true });
    await avatar!.mouse.move(hit!.x, hit!.y);
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ manualModelPassThrough: true, effectiveIgnoreMouse: true });

    await avatar!.evaluate(() => (window as any).chatx2.setModelPassThrough(false));
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ manualModelPassThrough: false });
    const movedHit = await avatar!.evaluate(() => {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      const hitTest = (window as any).__chatx2Runtime.__testIsPointOnModel as (x: number, y: number) => boolean;
      for (let y = 20; y < canvas.clientHeight; y += 20) {
        for (let x = 20; x < canvas.clientWidth; x += 20) {
          if (hitTest(x, y)) return { x, y };
        }
      }
      return null;
    });
    expect(movedHit, 'raycaster must find the model at its new translated position').not.toBeNull();
    await avatar!.mouse.move(movedHit!.x, movedHit!.y);
    await expect.poll(() => avatar!.evaluate(() =>
      (window as any).__chatx2Runtime.__testGetAvatarMousePolicy()
    )).toMatchObject({ pointerOnModel: true, effectiveIgnoreMouse: false });
  } finally {
    await app?.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
