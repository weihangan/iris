import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

async function waitForSettledPhysics(avatar: Page): Promise<void> {
  await avatar.evaluate(async () => {
    const runtime = (window as any).__chatx2Runtime;
    const names: string[] = runtime.__debugDynamicBoneNames()
      .filter((name: string) => /hair|髪|发|髮|dress|裙|skirt|belt|リボン|ribbon/i.test(name))
      .slice(0, 120);
    let previous = runtime.__getBoneStates(names);
    let stableSamples = 0;
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      const current = runtime.__getBoneStates(names);
      const angles: number[] = [];
      for (const name of names) {
        const first = previous[name]?.quaternion;
        const latest = current[name]?.quaternion;
        if (!first || !latest) continue;
        const dot = Math.min(1, Math.abs(
          first[0] * latest[0] + first[1] * latest[1]
            + first[2] * latest[2] + first[3] * latest[3]
        ));
        angles.push(2 * Math.acos(dot));
      }
      angles.sort((a, b) => a - b);
      const p90Step = angles[Math.max(0, Math.ceil(angles.length * 0.9) - 1)] ?? 0;
      const inertia = runtime.__debugPhysicsContinuity().rootInertiaDriver;
      stableSamples = p90Step < 0.015 && Math.hypot(inertia[0], inertia[1], inertia[2]) < 0.001
        ? stableSamples + 1
        : 0;
      if (stableSamples >= 5) return;
      previous = current;
    }
    throw new Error('physics did not settle before parity drag');
  });
}

async function dragAndMeasure(avatar: Page, dragDurationMs = 120): Promise<{
  maxP90Angle: number;
  maxInertia: number;
  maxRootDisplacement: number;
  maxAttachmentLag: number;
  maxPostReleaseFrameP90Angle: number;
  postReleaseTailFrameCount: number;
  attachmentRootCount: number;
  longHairBoneCount: number;
  longHairTipCount: number;
  maxLongHairP90Angle: number;
  maxLongHairTipP90Angle: number;
  maxPostReleaseLongHairTipP90Angle: number;
  maxPostReleaseLongHairTipP90Step: number;
  longHairTipPeakAtMs: number;
  topAttachmentLag: Array<{ name: string; lag: number }>;
}> {
  return avatar.evaluate(async ({ dragDurationMs }) => {
    const runtime = (window as any).__chatx2Runtime;
    const canvas = document.querySelector('canvas')!;
    const secondaryCandidates: string[] = runtime.__debugDynamicBoneNames()
      .filter((name: string) => /hair|髪|发|髮|dress|裙|skirt|belt|リボン|ribbon/i.test(name));
    const hairCandidates = secondaryCandidates
      .filter((name: string) => /hair|髪|发|髮/i.test(name));
    const hairPipeline: Array<{ boneName: string; boneIndex: number; parentBoneIndex: number | null }> =
      runtime.__debugBonePhysicsPipeline(hairCandidates);
    const hairByIndex = new Map(hairPipeline.map(item => [item.boneIndex, item]));
    const rootIndexByBoneIndex = new Map<number, number>();
    const resolveHairRootIndex = (boneIndex: number): number => {
      const cached = rootIndexByBoneIndex.get(boneIndex);
      if (cached !== undefined) return cached;
      let current = hairByIndex.get(boneIndex);
      const visited = new Set<number>();
      while (current?.parentBoneIndex !== null
        && current?.parentBoneIndex !== undefined
        && hairByIndex.has(current.parentBoneIndex)
        && !visited.has(current.parentBoneIndex)) {
        visited.add(current.boneIndex);
        current = hairByIndex.get(current.parentBoneIndex);
      }
      const rootIndex = current?.boneIndex ?? boneIndex;
      rootIndexByBoneIndex.set(boneIndex, rootIndex);
      return rootIndex;
    };
    const hairChainSizes = new Map<number, number>();
    for (const item of hairPipeline) {
      const rootIndex = resolveHairRootIndex(item.boneIndex);
      hairChainSizes.set(rootIndex, (hairChainSizes.get(rootIndex) ?? 0) + 1);
    }
    const longHairNames = hairPipeline
      .filter(item => (hairChainSizes.get(resolveHairRootIndex(item.boneIndex)) ?? 0) >= 4)
      .map(item => item.boneName);
    const longHairNameSet = new Set<string>(longHairNames);
    const longHairParentIndices = new Set(hairPipeline
      .filter(item => longHairNameSet.has(item.boneName) && item.parentBoneIndex !== null)
      .map(item => item.parentBoneIndex as number));
    const longHairTipNames = hairPipeline
      .filter(item => longHairNameSet.has(item.boneName) && !longHairParentIndices.has(item.boneIndex))
      .map(item => item.boneName);
    const longHairTipNameSet = new Set<string>(longHairTipNames);
    const secondary = [...new Set([...secondaryCandidates.slice(0, 240), ...longHairNames])];
    const secondaryNameSet = new Set<string>(secondaryCandidates);
    const attachmentRoots: string[] = (runtime.__debugRootDragAttachmentBoneNames?.() ?? [])
      .filter((name: string) => secondaryNameSet.has(name));
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
    const before = runtime.__getBoneStates(secondary);
    const beforeRootLocal = runtime.__getBoneRootLocalPositions(attachmentRoots);
    const beforeRoot = runtime.__getBoneWorldPositions(['全ての親'])['全ての親'];
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: hit.x,
      clientY: hit.y
    }));
    let maxP90Angle = 0;
    let maxInertia = 0;
    let maxRootDisplacement = 0;
    let maxAttachmentLag = 0;
    let maxPostReleaseFrameP90Angle = 0;
    let postReleaseTailFrameCount = 0;
    let maxLongHairP90Angle = 0;
    let maxLongHairTipP90Angle = 0;
    let maxPostReleaseLongHairTipP90Angle = 0;
    let maxPostReleaseLongHairTipP90Step = 0;
    let longHairTipPeakAtMs = 0;
    const attachmentLagByName = new Map<string, number>();
    let previous = before;
    const started = performance.now();
    const releaseAt = started + dragDurationMs;
    const deadline = releaseAt + 1_820;
    let released = false;
    while (performance.now() < deadline) {
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
      if (!released) {
        const progress = Math.min(1, (performance.now() - started) / dragDurationMs);
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: hit.x + 120 * progress,
          clientY: hit.y
        }));
      }
      if (!released && performance.now() >= releaseAt) {
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          button: 0,
          clientX: hit.x + 120,
          clientY: hit.y
        }));
        released = true;
      }
      const current = runtime.__getBoneStates(secondary);
      const angles: number[] = [];
      const frameAngles: number[] = [];
      const longHairAngles: number[] = [];
      const longHairTipAngles: number[] = [];
      const longHairTipFrameAngles: number[] = [];
      for (const name of secondary) {
        const first = before[name]?.quaternion;
        const latest = current[name]?.quaternion;
        if (!first || !latest) continue;
        const dot = Math.min(1, Math.abs(
          first[0] * latest[0] + first[1] * latest[1]
            + first[2] * latest[2] + first[3] * latest[3]
        ));
        const totalAngle = 2 * Math.acos(dot);
        angles.push(totalAngle);
        if (longHairNameSet.has(name)) longHairAngles.push(totalAngle);
        if (longHairTipNameSet.has(name)) longHairTipAngles.push(totalAngle);
        const prior = previous[name]?.quaternion;
        if (prior) {
          const frameDot = Math.min(1, Math.abs(
            prior[0] * latest[0] + prior[1] * latest[1]
              + prior[2] * latest[2] + prior[3] * latest[3]
          ));
          const frameAngle = 2 * Math.acos(frameDot);
          frameAngles.push(frameAngle);
          if (longHairTipNameSet.has(name)) longHairTipFrameAngles.push(frameAngle);
        }
      }
      angles.sort((a, b) => a - b);
      maxP90Angle = Math.max(
        maxP90Angle,
        angles[Math.max(0, Math.ceil(angles.length * 0.9) - 1)] ?? 0
      );
      frameAngles.sort((a, b) => a - b);
      longHairAngles.sort((a, b) => a - b);
      longHairTipAngles.sort((a, b) => a - b);
      longHairTipFrameAngles.sort((a, b) => a - b);
      const longHairP90 = longHairAngles[Math.max(0, Math.ceil(longHairAngles.length * 0.9) - 1)] ?? 0;
      const longHairTipP90 = longHairTipAngles[Math.max(0, Math.ceil(longHairTipAngles.length * 0.9) - 1)] ?? 0;
      const longHairTipFrameP90 = longHairTipFrameAngles[
        Math.max(0, Math.ceil(longHairTipFrameAngles.length * 0.9) - 1)
      ] ?? 0;
      maxLongHairP90Angle = Math.max(maxLongHairP90Angle, longHairP90);
      if (longHairTipP90 > maxLongHairTipP90Angle) {
        maxLongHairTipP90Angle = longHairTipP90;
        longHairTipPeakAtMs = performance.now() - started;
      }
      if (released) {
        const frameP90 = frameAngles[Math.max(0, Math.ceil(frameAngles.length * 0.9) - 1)] ?? 0;
        maxPostReleaseFrameP90Angle = Math.max(maxPostReleaseFrameP90Angle, frameP90);
        maxPostReleaseLongHairTipP90Angle = Math.max(
          maxPostReleaseLongHairTipP90Angle,
          longHairTipP90
        );
        maxPostReleaseLongHairTipP90Step = Math.max(
          maxPostReleaseLongHairTipP90Step,
          longHairTipFrameP90
        );
        if (frameP90 > 0.0005) postReleaseTailFrameCount += 1;
      }
      previous = current;
      const inertia = runtime.__debugPhysicsContinuity().rootInertiaDriver;
      maxInertia = Math.max(maxInertia, Math.hypot(inertia[0], inertia[1], inertia[2]));
      const currentRoot = runtime.__getBoneWorldPositions(['全ての親'])['全ての親'];
      const currentRootLocal = runtime.__getBoneRootLocalPositions(attachmentRoots);
      if (beforeRoot && currentRoot) {
        maxRootDisplacement = Math.max(maxRootDisplacement, Math.hypot(
          currentRoot[0] - beforeRoot[0],
          currentRoot[1] - beforeRoot[1],
          currentRoot[2] - beforeRoot[2]
        ));
        for (const name of attachmentRoots) {
          const first = beforeRootLocal[name];
          const latest = currentRootLocal[name];
          if (!first || !latest) continue;
          const lag = Math.hypot(
            latest[0] - first[0],
            latest[1] - first[1],
            latest[2] - first[2]
          );
          maxAttachmentLag = Math.max(maxAttachmentLag, lag);
          attachmentLagByName.set(name, Math.max(attachmentLagByName.get(name) ?? 0, lag));
        }
      }
    }
    if (!released) {
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: hit.x + 120,
        clientY: hit.y
      }));
    }
    return {
      maxP90Angle,
      maxInertia,
      maxRootDisplacement,
      maxAttachmentLag,
      maxPostReleaseFrameP90Angle,
      postReleaseTailFrameCount,
      attachmentRootCount: attachmentRoots.length,
      longHairBoneCount: longHairNames.length,
      longHairTipCount: longHairTipNames.length,
      maxLongHairP90Angle,
      maxLongHairTipP90Angle,
      maxPostReleaseLongHairTipP90Angle,
      maxPostReleaseLongHairTipP90Step,
      longHairTipPeakAtMs,
      topAttachmentLag: [...attachmentLagByName.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, lag]) => ({ name, lag }))
    };
  }, { dragDurationMs });
}

test('both current PMX models drive their audited dynamic bones through Bullet', async () => {
  test.setTimeout(180_000);
  const userDataDir = join(tmpdir(), `chatx2-multi-model-physics-${Date.now()}`);
  const seedUserData = process.env.CHATX2_PARITY_SEED_USERDATA;
  if (seedUserData && existsSync(seedUserData)) {
    mkdirSync(userDataDir, { recursive: true });
    for (const name of ['voice-actions.json', 'model-settings.json', 'motion-deletions.json',
      'avatar-motion-settings.json', 'avatar-compute-settings.json']) {
      const source = join(seedUserData, name);
      if (existsSync(source)) copyFileSync(source, join(userDataDir, name));
    }
  }
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
    const packs = await chat.evaluate(() => (window as any).chatx2.listModelPacks());
    const expected = new Map([
      ['selena-xisheng-v1', 397],
      ['yyxuanling-v1', 594]
    ]);

    const dragResults = new Map<string, {
      maxP90Angle: number;
      maxInertia: number;
      maxRootDisplacement: number;
      maxAttachmentLag: number;
      maxPostReleaseFrameP90Angle: number;
      postReleaseTailFrameCount: number;
      attachmentRootCount: number;
      longHairBoneCount: number;
      longHairTipCount: number;
      maxLongHairP90Angle: number;
      maxLongHairTipP90Angle: number;
      maxPostReleaseLongHairTipP90Angle: number;
      maxPostReleaseLongHairTipP90Step: number;
      longHairTipPeakAtMs: number;
      topAttachmentLag: Array<{ name: string; lag: number }>;
    }>();
    const slowDragResults = new Map<string, {
      maxP90Angle: number;
      maxInertia: number;
      maxLongHairP90Angle: number;
      maxLongHairTipP90Angle: number;
    }>();
    for (const [packId, dynamicBoneCount] of expected) {
      expect(packs.some((pack: any) => pack.packId === packId), `missing model ${packId}`).toBe(true);
      const currentPackId = await chat.evaluate(async () =>
        (await (window as any).chatx2.getCurrentModelPack()).packId);
      if (currentPackId !== packId) {
        const switched = await chat.evaluate(id => (window as any).chatx2.switchModelPack(id), packId);
        expect(switched.success, switched.reason).toBe(true);
        await chat.waitForTimeout(900);
      }

      const avatar = await findWindow(app, 'Avatar');
      await expect.poll(() => avatar.evaluate(async id => {
        const runtime = (window as any).__chatx2Runtime;
        const current = await (window as any).chatx2.getCurrentModelPack();
        return current?.packId === id
          && runtime?.__debugDynamicBoneNames?.().length > 0
          && (runtime?.__debugPhysicsContinuity?.()?.monotonicSeconds ?? 0) > 0.2;
      }, packId), { timeout: 45_000 }).toBe(true);
      await avatar.waitForTimeout(750);

      await expect.poll(() => avatar.evaluate(() =>
        (window as any).__chatx2Runtime.__debugPhysicsContinuity().transitionStabilizationActive
      ), {
        // A 3.5s authored idle loop plus the 0.8s physics tail can legitimately
        // approach five seconds on a busy Windows renderer. This gate detects a
        // stuck transition; it is not a responsiveness budget.
        timeout: 30_000,
        intervals: [100, 200, 400, 800]
      }).toBe(false);
      await expect.poll(() => avatar.evaluate(() =>
        (window as any).__chatx2Runtime.__debugPhysicsContinuity().rootDragStabilizationActive
      ), { timeout: 15_000, intervals: [100, 200, 400, 800] }).toBe(false);
      const idleClampAudit = await avatar.evaluate(async () => {
        const runtime = (window as any).__chatx2Runtime;
        const before = runtime.__debugPhysicsContinuity();
        await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
        const after = runtime.__debugPhysicsContinuity();
        return {
          before: before.clampedDynamicOutputCount,
          after: after.clampedDynamicOutputCount,
          transitionActive: after.transitionStabilizationActive,
          rootDragActive: after.rootDragStabilizationActive
        };
      });
      expect(idleClampAudit.rootDragActive).toBe(false);
      expect(idleClampAudit.after,
        `${packId} idle physics output must remain under PMX ownership`)
        .toBe(idleClampAudit.before);

      const diagnosis = await avatar.evaluate(async () => {
        const runtime = (window as any).__chatx2Runtime;
        const currentPack = await (window as any).chatx2.getCurrentModelPack();
        const names: string[] = runtime.__debugDynamicBoneNames();
        const configuredDisabledBones: string[] = currentPack.physics?.disabledDynamicBones ?? [];
        const configuredDisabledPipeline = runtime.__debugBonePhysicsPipeline(configuredDisabledBones);
        const sampledNames = names
          .filter((name, index) => name && index % Math.max(1, Math.floor(names.length / 32)) === 0)
          .slice(0, 32);
        const pipeline = runtime.__debugBonePhysicsPipeline(sampledNames);
        const first = runtime.__getBoneWorldPositions(sampledNames);
        await new Promise(resolveWait => setTimeout(resolveWait, 2500));
        const second = runtime.__getBoneWorldPositions(sampledNames);
        const secondPipeline = runtime.__debugBonePhysicsPipeline(sampledNames);
        let maxWorldDisplacement = 0;
        for (const name of sampledNames) {
          const a = first[name];
          const b = second[name];
          if (!a || !b) continue;
          maxWorldDisplacement = Math.max(
            maxWorldDisplacement,
            Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
          );
        }
        let maxRigidBodyWorldChange = 0;
        for (const sample of pipeline) {
          const later = secondPipeline.find((item: any) => item.boneName === sample.boneName);
          for (const body of sample.rigidBodies) {
            const laterBody = later?.rigidBodies.find((item: any) => item.rigidBodyIndex === body.rigidBodyIndex);
            const beforeMatrix = body.worldMatrixColumnMajor;
            const afterMatrix = laterBody?.worldMatrixColumnMajor;
            if (!beforeMatrix || !afterMatrix) continue;
            for (let index = 0; index < 16; index += 1) {
              maxRigidBodyWorldChange = Math.max(
                maxRigidBodyWorldChange,
                Math.abs(afterMatrix[index] - beforeMatrix[index])
              );
            }
          }
        }
        return {
          dynamicBoneCount: names.length,
          configuredDisabledBones,
          configuredDisabledPipeline,
          pipelineCount: pipeline.length,
          enabledPipelineCount: pipeline.filter((item: any) => item.physicsEnabled).length,
          rigidBodyCount: pipeline.reduce((sum: number, item: any) => sum + item.rigidBodies.length, 0),
          maxRigidBodyWorldChange,
          maxWorldDisplacement,
          continuity: runtime.__debugPhysicsContinuity()
        };
      });

      console.log(`[physics-model] ${packId}`, diagnosis);
      expect(diagnosis.dynamicBoneCount).toBe(dynamicBoneCount);
      expect(diagnosis.pipelineCount).toBeGreaterThan(0);
      expect(diagnosis.enabledPipelineCount).toBeGreaterThan(0);
      expect(diagnosis.rigidBodyCount).toBeGreaterThan(0);
      expect(Number.isFinite(diagnosis.maxRigidBodyWorldChange)).toBe(true);
      expect(diagnosis.maxRigidBodyWorldChange).toBeGreaterThan(1e-5);
      expect(Number.isFinite(diagnosis.maxWorldDisplacement)).toBe(true);
      expect(diagnosis.maxWorldDisplacement).toBeGreaterThan(1e-5);
      expect(diagnosis.configuredDisabledBones).toEqual([]);
      expect(diagnosis.configuredDisabledPipeline).toEqual([]);

      await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(true));
      await waitForSettledPhysics(avatar);
      const slowDrag = await dragAndMeasure(avatar, 900);
      slowDragResults.set(packId, slowDrag);
      console.log(`[physics-drag-slow] ${packId}`, slowDrag);
      await waitForSettledPhysics(avatar);
      const drag = await dragAndMeasure(avatar, 120);
      await avatar.evaluate(() => (window as any).__chatx2Runtime.motionPlayer.setPoseLocked(false));
      dragResults.set(packId, drag);
      console.log(`[physics-drag] ${packId}`, drag);
      // Full-chain rotation must remain visibly dynamic. Attachment is checked
      // separately on body-connected roots, so a rigid but non-detached chain
      // cannot pass this test.
      expect(drag.maxP90Angle).toBeGreaterThan(0.01);
      expect(drag.maxInertia).toBeGreaterThan(0.00001);
      expect(drag.maxRootDisplacement).toBeGreaterThan(0.05);
      expect(Number.isFinite(drag.maxAttachmentLag)).toBe(true);
      expect(drag.attachmentRootCount,
        `${packId} must expose the exact guarded hair/clothing chain roots`)
        .toBeGreaterThan(0);
      expect(drag.maxAttachmentLag,
        `${packId} hair/clothing must remain attached during root dragging`)
        .toBeLessThan(0.040001);
      expect(drag.maxP90Angle,
        `${packId} fast drag must create visibly more sway than slow drag`)
        .toBeGreaterThan(slowDrag.maxP90Angle * 1.2);
      expect(drag.maxInertia).toBeGreaterThan(slowDrag.maxInertia * 1.5);
      expect(drag.longHairBoneCount, `${packId} must expose topology-selected long-hair chains`)
        .toBeGreaterThanOrEqual(4);
      expect(drag.longHairTipCount, `${packId} must expose topology-selected long-hair tips`)
        .toBeGreaterThan(0);
      expect(drag.maxLongHairP90Angle,
        `${packId} fast drag must produce a visible long-hair strand flick`)
        .toBeGreaterThan(0.12);
      expect(drag.maxLongHairP90Angle,
        `${packId} long-hair strand flick must remain restrained`)
        .toBeLessThan(0.5);
      expect(drag.maxLongHairTipP90Angle,
        `${packId} fast drag must carry visible motion through the long-hair tips`)
        .toBeGreaterThan(0.045);
      expect(drag.maxLongHairTipP90Angle,
        `${packId} long-hair tip flick must remain restrained`)
        .toBeLessThan(0.6);
      expect(drag.maxLongHairTipP90Angle,
        `${packId} fast drag must move long-hair tips more than slow drag`)
        .toBeGreaterThan(slowDrag.maxLongHairTipP90Angle * 1.5);
      expect(drag.maxPostReleaseLongHairTipP90Angle,
        `${packId} long-hair tips must retain visible follow-through after release`)
        .toBeGreaterThan(0.035);
      expect(drag.maxPostReleaseLongHairTipP90Step,
        `${packId} long-hair tips must keep moving after release`)
        .toBeGreaterThan(0.005);
      expect(drag.longHairTipPeakAtMs,
        `${packId} long-hair tip peak must trail the 120ms root drag`)
        .toBeGreaterThan(120);
      expect(drag.longHairTipPeakAtMs,
        `${packId} long-hair tip follow-through must not become a delayed snap`)
        .toBeLessThan(1_000);
    }

    const selenaDrag = dragResults.get('selena-xisheng-v1')!;
    const yangyangDrag = dragResults.get('yyxuanling-v1')!;
    expect(Math.abs(selenaDrag.maxP90Angle - yangyangDrag.maxP90Angle)).toBeLessThan(0.5);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
