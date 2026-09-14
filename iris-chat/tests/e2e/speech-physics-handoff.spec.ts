import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  await expect.poll(async () => {
    const titles = await Promise.all(app.windows().map(page => page.title().catch(() => '')));
    return titles.some(title => title.includes(titlePart));
  }, { timeout: 30_000 }).toBe(true);
  for (const page of app.windows()) {
    if ((await page.title().catch(() => '')).includes(titlePart)) return page;
  }
  throw new Error(`window not found: ${titlePart}`);
}

test('speech to idle keeps Bullet time and secondary motion continuous', async () => {
  // Real PMX + Bullet startup can consume most of 120 seconds on a cold
  // Windows cache. Keep the assertions bounded, but leave enough total time
  // for startup, one mock reply and the post-handoff observation window.
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'chatx2-test-speech-pool-'));
  writeFileSync(join(userDataDir, 'voice-actions.json'), JSON.stringify({
    schemaVersion: 1,
    description: 'E2E isolated enabled voice pool',
    entries: [{
      vmdPath: '../shared/motions/害羞_低头看左下后回正.vmd',
      displayName: 'E2E 大横移语音动作',
      type: 'voice',
      gestureFamily: 'explaining',
      intent: 'explaining',
      emotions: ['neutral', 'serious', 'gentle', 'shy'],
      description: 'E2E only',
      dialogueSafe: true
    }]
  }, null, 2), 'utf8');
  writeFileSync(join(userDataDir, 'model-settings.json'), JSON.stringify({
    schemaVersion: 1,
    lastPackId: 'selena-xisheng-v1',
    motionSettingsByPack: {
      'selena-xisheng-v1': {
        defaultIdle: '../shared/motions/待机 双手后背.vmd'
      }
    }
  }, null, 2), 'utf8');
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
    console.log('[speech-physics-handoff] chat window ready');
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 45_000 }).toBe(true);
    if (await chat.evaluate(() => (window as any).chatx2.getMode()) !== 'desktop') {
      const result = await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('ok');
    }

    const avatar = await findWindow(app, 'Avatar');
    const composer = await findWindow(app, 'Composer');
    console.log('[speech-physics-handoff] desktop windows ready');
    const currentPack = await avatar.evaluate(() => (window as any).chatx2.getCurrentModelPack());
    const defaultIdle = currentPack.motions.defaultIdle;
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime?.motionPlayer?.getCurrentPackId()
    ), { timeout: 20_000 }).toBe(defaultIdle);
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime?.motionPlayer?.getState()
    ), { timeout: 20_000 }).toBe('playing');
    // Let the freshly-created Bullet chains settle before measuring a speech
    // handoff. Their first free-fall samples are startup behavior, not a
    // motion transition, and otherwise make the 50 ms upward-step gate flaky.
    await avatar.waitForTimeout(1_500);
    console.log('[speech-physics-handoff] default idle ready');

    await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      const allNames: string[] = runtime.__debugDynamicBoneNames?.() ?? [];
      const names = allNames.filter(name => /(?:Bhair|Dress|HeadJew)/u.test(name)).slice(0, 24);
      const monitor = {
        names,
        armNames: ['左腕', '右腕'],
        lowerBodyNames: ['下半身', '左足', '右足', '左ひざ', '右ひざ'],
        controllerNames: ['センター', '左足ＩＫ', '右足ＩＫ'],
        motionParentNames: [
          '全ての親', 'センター', 'グルーブ', '腰',
          '上半身', '上半身2', '首', '頭', '下半身',
          '左足', '右足', '左足ＩＫ', '右足ＩＫ'
        ],
        startedAt: performance.now(),
        initialForwardedResetCount: runtime.__debugPhysicsContinuity?.().forwardedResetCount ?? 0,
        previousWorld: null as Record<string, [number, number, number] | null> | null,
        previousSampleAt: performance.now(),
        maxSampleDeltaMs: 0,
        previousDelegatedSeconds: null as number | null,
        maxWorldStep: 0,
        maxUpwardStep: 0,
        maxPhysicsOutputDivergence: 0,
        worstPhysicsOutputDivergence: null as null | Record<string, unknown>,
        delegatedClockBacksteps: 0,
        sawSpeechContinuity: false,
        worstWorldStep: null as null | Record<string, unknown>,
        worstUpwardStep: null as null | Record<string, unknown>,
        initialPose: null as Record<string, any> | null,
        initialControllerPose: null as Record<string, any> | null,
        maxControllerOffsetByName: {} as Record<string, number>,
        maxArmPoseDelta: 0,
        maxLowerBodyPoseDelta: 0,
        maxMotionParentWorldStep: 0,
        maxMotionParentWorldStepByName: {} as Record<string, number>,
        worstMotionParentWorldStep: null as null | Record<string, unknown>,
        previousMotionParentWorld: null as Record<string, [number, number, number] | null> | null,
        consecutiveArmRestFrames: 0,
        maxConsecutiveArmRestFrames: 0,
        worstArmRestContext: null as null | Record<string, unknown>,
        packHistory: [] as string[],
        boundarySamples: [] as any[],
        samples: 0,
        timer: 0 as unknown as ReturnType<typeof setInterval>
      };
      monitor.timer = setInterval(() => {
        const sampleAt = performance.now();
        const sampleDeltaMs = sampleAt - monitor.previousSampleAt;
        monitor.previousSampleAt = sampleAt;
        monitor.maxSampleDeltaMs = Math.max(monitor.maxSampleDeltaMs, sampleDeltaMs);
        const world = runtime.__getBoneWorldPositions(names);
        const physicsPipeline = runtime.__debugBonePhysicsPipeline?.(names) ?? [];
        const physicsPipelineByName = new Map(
          physicsPipeline.map((entry: any) => [entry.boneName, entry])
        );
        const motionParentWorld = runtime.__getBoneWorldPositions(monitor.motionParentNames);
        const poseNames = [...monitor.armNames, ...monitor.lowerBodyNames];
        const pose = runtime.__getBoneStates(poseNames);
        const controllerPose = runtime.__getBoneStates(monitor.controllerNames);
        if (!monitor.initialPose) monitor.initialPose = pose;
        if (!monitor.initialControllerPose) monitor.initialControllerPose = controllerPose;
        const quaternionDelta = (a: number[] | undefined, b: number[] | undefined) => {
          if (!a || !b) return 0;
          const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
          return 2 * Math.acos(dot);
        };
        for (const name of monitor.armNames) {
          monitor.maxArmPoseDelta = Math.max(
            monitor.maxArmPoseDelta,
            quaternionDelta(monitor.initialPose?.[name]?.quaternion, pose[name]?.quaternion)
          );
        }
        for (const name of monitor.lowerBodyNames) {
          monitor.maxLowerBodyPoseDelta = Math.max(
            monitor.maxLowerBodyPoseDelta,
            quaternionDelta(monitor.initialPose?.[name]?.quaternion, pose[name]?.quaternion)
          );
        }
        for (const name of monitor.controllerNames) {
          const initial = monitor.initialControllerPose?.[name]?.position;
          const current = controllerPose[name]?.position;
          if (!initial || !current) continue;
          const offset = Math.hypot(
            current[0] - initial[0],
            current[1] - initial[1],
            current[2] - initial[2]
          );
          monitor.maxControllerOffsetByName[name] = Math.max(
            monitor.maxControllerOffsetByName[name] ?? 0,
            offset
          );
        }
        const bothArmsAtRest = monitor.armNames.every(name => {
          const q = pose[name]?.quaternion;
          return q && 2 * Math.acos(Math.min(1, Math.abs(q[3]))) < 0.08;
        });
        monitor.consecutiveArmRestFrames = bothArmsAtRest
          ? monitor.consecutiveArmRestFrames + 1
          : 0;
        if (monitor.consecutiveArmRestFrames > monitor.maxConsecutiveArmRestFrames) {
          monitor.maxConsecutiveArmRestFrames = monitor.consecutiveArmRestFrames;
          monitor.worstArmRestContext = {
            elapsedMs: performance.now() - monitor.startedAt,
            pose,
            packId: runtime.motionPlayer?.getCurrentPackId?.(),
            playerState: runtime.motionPlayer?.getState?.(),
            speech: runtime.__debugSpeechMotionSelection?.()
          };
        }
        const packId = String(runtime.motionPlayer?.getCurrentPackId?.() ?? '');
        if (packId && monitor.packHistory.at(-1) !== packId) monitor.packHistory.push(packId);
        if (monitor.boundarySamples.length < 40
          && packId.includes('待机 双手后背.vmd')
          && runtime.__debugSpeechMotionSelection?.().performanceState === 'idle') {
          monitor.boundarySamples.push({
            elapsedMs: performance.now() - monitor.startedAt,
            packId,
            state: runtime.motionPlayer?.getState?.(),
            lowerBody: pose,
            physics: runtime.__debugPhysicsContinuity?.()
          });
        }
        const physics = runtime.__debugPhysicsContinuity?.();
        const delegatedSeconds = physics?.lastDelegatedSeconds;
        if (physics?.speechContinuityActive) monitor.sawSpeechContinuity = true;
        if (typeof delegatedSeconds === 'number') {
          if (monitor.previousDelegatedSeconds !== null
            && delegatedSeconds + 1e-6 < monitor.previousDelegatedSeconds) {
            monitor.delegatedClockBacksteps += 1;
          }
          monitor.previousDelegatedSeconds = delegatedSeconds;
        }
        if (monitor.previousWorld) {
          for (const name of names) {
            const before = monitor.previousWorld[name];
            const after = world[name];
            if (!before || !after) continue;
            const worldStep = Math.hypot(
              after[0] - before[0],
              after[1] - before[1],
              after[2] - before[2]
            );
            const upwardStep = after[1] - before[1];
            const outputMatrix = (physicsPipelineByName.get(name) as any)?.outputWorldMatrixColumnMajor;
            const physicsWorld = outputMatrix
              ? [outputMatrix[12], outputMatrix[13], -outputMatrix[14]]
              : null;
            const outputDivergence = physicsWorld
              ? Math.hypot(
                after[0] - physicsWorld[0],
                after[1] - physicsWorld[1],
                after[2] - physicsWorld[2]
              )
              : 0;
            const context = () => ({
              name,
              sampleDeltaMs,
              elapsedMs: performance.now() - monitor.startedAt,
              before,
              after,
              packId: runtime.motionPlayer?.getCurrentPackId?.(),
              playerState: runtime.motionPlayer?.getState?.(),
              speech: runtime.__debugSpeechMotionSelection?.(),
              physics
            });
            if (worldStep > monitor.maxWorldStep) {
              monitor.maxWorldStep = worldStep;
              monitor.worstWorldStep = { ...context(), worldStep, upwardStep };
            }
            if (upwardStep > monitor.maxUpwardStep) {
              monitor.maxUpwardStep = upwardStep;
              monitor.worstUpwardStep = { ...context(), worldStep, upwardStep };
            }
            if (outputDivergence > monitor.maxPhysicsOutputDivergence) {
              monitor.maxPhysicsOutputDivergence = outputDivergence;
              monitor.worstPhysicsOutputDivergence = {
                ...context(),
                physicsWorld,
                outputDivergence,
                worldStep,
                upwardStep
              };
            }
          }
        }
        monitor.previousWorld = world;
        if (monitor.previousMotionParentWorld) {
          for (const name of monitor.motionParentNames) {
            const before = monitor.previousMotionParentWorld[name];
            const after = motionParentWorld[name];
            if (!before || !after) continue;
            const worldStep = Math.hypot(
              after[0] - before[0],
              after[1] - before[1],
              after[2] - before[2]
            );
            monitor.maxMotionParentWorldStepByName[name] = Math.max(
              monitor.maxMotionParentWorldStepByName[name] ?? 0,
              worldStep
            );
            if (worldStep > monitor.maxMotionParentWorldStep) {
              monitor.maxMotionParentWorldStep = worldStep;
              monitor.worstMotionParentWorldStep = {
                name,
                worldStep,
                sampleDeltaMs,
                before,
                after,
                elapsedMs: performance.now() - monitor.startedAt,
                packId: runtime.motionPlayer?.getCurrentPackId?.(),
                playerState: runtime.motionPlayer?.getState?.(),
                speech: runtime.__debugSpeechMotionSelection?.()
              };
            }
          }
        }
        monitor.previousMotionParentWorld = motionParentWorld;
        monitor.samples += 1;
      }, 50);
      (window as any).__speechPhysicsMonitor = monitor;
    });

    const submit = await composer.evaluate(text =>
      (window as any).chatx2.conversationSubmit(text),
    '请先自然说明动作衔接必须保持连续。然后认真解释手臂不能回到模型原始姿态，腿部也应随整体动作协调变化。最后平稳回到用户选择的默认待机。');
    expect(submit.accepted).toBe(true);
    console.log('[speech-physics-handoff] mock reply submitted');
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime?.performanceSession?.getState()
    ), { timeout: 15_000 }).toBe('performing');
    console.log('[speech-physics-handoff] performance started');
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime?.performanceSession?.getState()
    ), { timeout: 30_000 }).toBe('idle');
    console.log('[speech-physics-handoff] performance ended');
    await expect.poll(() => avatar.evaluate(idle => {
      const runtime = (window as any).__chatx2Runtime;
      return runtime?.motionPlayer?.getCurrentPackId() === idle
        && runtime?.motionPlayer?.getState() === 'playing'
        && runtime?.__debugPhysicsContinuity?.().speechContinuityActive === false;
    }, defaultIdle), { timeout: 20_000 }).toBe(true);

    // Keep sampling briefly after continuity hands off; the old bug occurred
    // on the frame immediately after this boundary.
    await avatar.waitForTimeout(1_500);
    const metrics = await avatar.evaluate(() => {
      const monitor = (window as any).__speechPhysicsMonitor;
      clearInterval(monitor.timer);
      return {
        names: monitor.names,
        initialForwardedResetCount: monitor.initialForwardedResetCount,
        maxSampleDeltaMs: monitor.maxSampleDeltaMs,
        maxWorldStep: monitor.maxWorldStep,
        maxUpwardStep: monitor.maxUpwardStep,
        maxPhysicsOutputDivergence: monitor.maxPhysicsOutputDivergence,
        worstPhysicsOutputDivergence: monitor.worstPhysicsOutputDivergence,
        worstWorldStep: monitor.worstWorldStep,
        worstUpwardStep: monitor.worstUpwardStep,
        delegatedClockBacksteps: monitor.delegatedClockBacksteps,
        sawSpeechContinuity: monitor.sawSpeechContinuity,
        samples: monitor.samples,
        maxArmPoseDelta: monitor.maxArmPoseDelta,
        maxLowerBodyPoseDelta: monitor.maxLowerBodyPoseDelta,
        maxControllerOffsetByName: monitor.maxControllerOffsetByName,
        maxMotionParentWorldStep: monitor.maxMotionParentWorldStep,
        maxMotionParentWorldStepByName: monitor.maxMotionParentWorldStepByName,
        worstMotionParentWorldStep: monitor.worstMotionParentWorldStep,
        maxConsecutiveArmRestFrames: monitor.maxConsecutiveArmRestFrames,
        worstArmRestContext: monitor.worstArmRestContext,
        packHistory: monitor.packHistory,
        boundarySamples: monitor.boundarySamples,
        physics: (window as any).__chatx2Runtime.__debugPhysicsContinuity()
      };
    });

    console.log('[speech-physics-handoff]', metrics);
    console.log('[speech-physics-handoff-boundary]', JSON.stringify(metrics.boundarySamples.slice(-10)));
    expect(metrics.names.length).toBeGreaterThan(0);
    expect(metrics.samples).toBeGreaterThan(20);
    expect(metrics.sawSpeechContinuity).toBe(true);
    expect(metrics.delegatedClockBacksteps).toBe(0);
    // Long authored dress-chain tips legitimately travel farther than their
    // animated parent during a 50 ms sample. These broad gates reject actual
    // launches and scene-vs-Bullet chain separation; the stricter assertions
    // below target the lower-body bridge boundary that caused this regression.
    expect(metrics.maxWorldStep).toBeLessThan(1);
    expect(metrics.maxUpwardStep).toBeLessThan(0.4);
    expect(metrics.maxPhysicsOutputDivergence).toBeLessThan(0.35);
    expect(metrics.maxMotionParentWorldStep).toBeLessThan(0.25);
    expect(metrics.maxMotionParentWorldStepByName['下半身']).toBeLessThan(0.12);
    expect(metrics.maxMotionParentWorldStepByName['左足']).toBeLessThan(0.12);
    expect(metrics.maxMotionParentWorldStepByName['右足']).toBeLessThan(0.12);
    expect(metrics.maxControllerOffsetByName['センター']).toBeLessThan(0.5);
    expect(metrics.maxControllerOffsetByName['左足ＩＫ']).toBeLessThan(0.3);
    expect(metrics.maxControllerOffsetByName['右足ＩＫ']).toBeLessThan(0.3);
    expect(metrics.maxConsecutiveArmRestFrames).toBeLessThan(4);
    expect(metrics.maxArmPoseDelta).toBeGreaterThan(0.01);
    expect(metrics.maxLowerBodyPoseDelta).toBeGreaterThan(0.003);
    expect(metrics.physics.forwardedResetCount).toBe(metrics.initialForwardedResetCount);
    const returnedIdleSamples = metrics.boundarySamples.filter((sample: any) =>
      sample.packId === defaultIdle && sample.elapsedMs > 1_000
    );
    const takeoverIndex = returnedIdleSamples.findIndex((sample: any, index: number) =>
      index > 0
        && sample.state === 'playing'
        && returnedIdleSamples[index - 1]?.state === 'bridging'
    );
    expect(takeoverIndex).toBeGreaterThan(0);
    const beforeTakeover = returnedIdleSamples[takeoverIndex - 1].lowerBody;
    const afterTakeover = returnedIdleSamples[takeoverIndex].lowerBody;
    const takeoverQuaternionDelta = (name: string) => {
      const before = beforeTakeover[name]?.quaternion;
      const after = afterTakeover[name]?.quaternion;
      if (!before || !after) return Number.POSITIVE_INFINITY;
      const dot = Math.min(1, Math.abs(
        before[0] * after[0]
          + before[1] * after[1]
          + before[2] * after[2]
          + before[3] * after[3]
      ));
      return 2 * Math.acos(dot);
    };
    for (const name of ['下半身', '左足', '右足', '左ひざ', '右ひざ']) {
      expect(takeoverQuaternionDelta(name), `${name} bridge-to-playing takeover`).toBeLessThan(0.035);
    }
    const cueIndex = metrics.packHistory.findIndex((packId: string) => packId.startsWith('speech-cue:'));
    expect(cueIndex).toBeGreaterThanOrEqual(0);
    expect(metrics.packHistory.slice(cueIndex + 1).some((packId: string) => packId === defaultIdle)).toBe(true);

    const idleStartsBeforeCancel = await avatar.evaluate(() =>
      (window as any).__idleStartDebug.startCalledCount);
    const pauseWav = Array.from(new Uint8Array(generateMockWav({
      taskId: 'pause-recovery-e2e',
      userText: '这段语音用于验证暂停后平稳回到用户选择的默认待机。'
    })));
    const syncResult = await chat.evaluate(async ({ bytes }) =>
      (window as any).chatx2.avatarSyncVoice(
        'pause-recovery-e2e',
        new Uint8Array(bytes).buffer,
        { emotion: 'gentle', intent: 'explaining' },
        '这段语音用于验证暂停后平稳回到用户选择的默认待机。'
      ), { bytes: pauseWav });
    expect(syncResult.success).toBe(true);
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime?.performanceSession?.getState()
    ), { timeout: 15_000 }).toBe('performing');
    await avatar.waitForTimeout(800);

    const cancelResult = await chat.evaluate(() =>
      (window as any).chatx2.avatarSyncStop('pause-recovery-e2e', 'cancel'));
    expect(cancelResult.success).toBe(true);
    await expect.poll(() => avatar.evaluate(idle => {
      const runtime = (window as any).__chatx2Runtime;
      const speech = runtime.__debugSpeechMotionSelection?.();
      return runtime?.motionPlayer?.getCurrentPackId() === idle
        && runtime?.motionPlayer?.getState() === 'playing'
        && speech?.speechMotionPhase === 'idle'
        && runtime?.__debugPhysicsContinuity?.().speechContinuityActive === false;
    }, defaultIdle), { timeout: 20_000 }).toBe(true);
    const idleStartsAfterCancel = await avatar.evaluate(() =>
      (window as any).__idleStartDebug.startCalledCount);
    // If the selected default body already remained visible, cancellation
    // must not rebind it just to satisfy a counter; otherwise recover once.
    expect(idleStartsAfterCancel - idleStartsBeforeCancel).toBeLessThanOrEqual(1);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
