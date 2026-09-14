import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

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

function seedIsolatedHeadPool(sharedRoot: string): void {
  const sourcePool = JSON.parse(readFileSync(resolve(
    'shared-user-data', 'ChatX2Selena', 'voice-actions.json'
  ), 'utf8'));
  const entries = sourcePool.entries.filter((entry: any) => entry.motionScope === 'head-overlay');
  expect(entries).toHaveLength(3);
  mkdirSync(join(sharedRoot, 'motions'), { recursive: true });
  writeFileSync(join(sharedRoot, 'voice-actions.json'), `${JSON.stringify({
    ...sourcePool,
    entries
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(sharedRoot, 'motion-deletions.json'), '{\n  "schemaVersion": 1,\n  "paths": []\n}\n', 'utf8');
  for (const entry of entries) {
    const fileName = basename(entry.vmdPath);
    cpSync(
      resolve('shared-user-data', 'ChatX2Selena', 'motions', fileName),
      join(sharedRoot, 'motions', fileName)
    );
  }
}

test('head-only speech temporarily uses the selected default body without starting permanent desktop idle', async () => {
  test.setTimeout(180_000);
  const root = join(tmpdir(), `chatx2-head-overlay-${Date.now()}`);
  const userDataDir = join(root, 'profile');
  const sharedRoot = join(root, 'shared', 'ChatX2Selena');
  mkdirSync(userDataDir, { recursive: true });
  seedIsolatedHeadPool(sharedRoot);
  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_USER_DATA: userDataDir,
      CHATX2_SHARED_DATA_DIR: sharedRoot
    }
  });

  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()), {
      timeout: 45_000
    }).toBe(true);
    if (await chat.evaluate(() => (window as any).chatx2.getMode()) !== 'desktop') {
      expect((await chat.evaluate(() => (window as any).chatx2.transition('desktop'))).status).toBe('ok');
    }

    for (const packId of ['selena-xisheng-v1', 'yyxuanling-v1']) {
      const current = await chat.evaluate(() => (window as any).chatx2.getCurrentModelPack());
      if (current.packId !== packId) {
        const switched = await chat.evaluate(id => (window as any).chatx2.switchModelPack(id), packId);
        expect(switched.success, switched.reason).toBe(true);
      }
      const avatar = await findWindow(app, 'Avatar');
      let consecutiveReadySamples = 0;
      await expect.poll(async () => {
        const ready = await avatar.evaluate(async id => {
        const runtime = (window as any).__chatx2Runtime;
        const selected = await (window as any).chatx2.getCurrentModelPack();
        return selected.packId === id
          && runtime?.motionPlayer
          && typeof runtime?.__getBoneStates === 'function'
          && runtime?.__debugDynamicBoneNames?.().length > 0;
        }, packId);
        consecutiveReadySamples = ready ? consecutiveReadySamples + 1 : 0;
        return consecutiveReadySamples >= 5;
      }, { timeout: 45_000 }).toBe(true);
      const pack = await avatar.evaluate(() => (window as any).chatx2.getCurrentModelPack());
      const defaultIdle = pack.motions.defaultIdle;
      await expect.poll(() => avatar.evaluate(() => ({
        playing: (window as any).__chatx2Runtime?.motionPlayer?.isPlaying(),
        timerArmed: (window as any).__chatx2Runtime?.__debugIdleLifecycle?.().timerArmed
      })), { timeout: 10_000 }).toEqual({ playing: true, timerArmed: false });
      await expect.poll(() => avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        return runtime?.__debugPhysicsContinuity?.()?.transitionStabilizationActive ?? true;
      }), { timeout: 20_000 }).toBe(false);
      // Model switching can briefly tear down and recreate the renderer
      // diagnostics after stabilization reports false. Let that handoff settle
      // before sampling the bone graph.
      await avatar.waitForTimeout(1_500);

      const speechCases = [
        {
          label: 'curious',
          semantic: { emotion: 'curious', intent: 'think' },
          text: '真的吗？我有一点疑惑，想再认真确认一下这件事情究竟为什么会这样，也想听你慢慢解释其中的原因和过程，然后再一起确认最后的结论是否可靠。',
          overlayId: 'curious-left-tilt',
          vmdFile: '疑惑_人物左侧歪头10度_仅头部.vmd',
          maxHeadAngle: TWELVE_DEGREES
        },
        {
          label: 'concerned',
          semantic: { emotion: 'concerned', intent: 'concern' },
          text: '我确实有一点担心，也有一点失落，所以想先安静地低下头认真想一想，再慢慢告诉你我在意的地方。你不用急着回答，等我把这些担忧完整说出来以后，我们再一起寻找更稳妥、更温柔的办法。',
          overlayId: 'concerned-down',
          vmdFile: '失落担心_低头30度_仅头部.vmd',
          maxHeadAngle: TWENTY_TWO_DEGREES
        },
        {
          label: 'remember',
          semantic: { emotion: 'thinking', intent: 'remember' },
          text: '说起那段回忆，我好像又想起了很久以前一起看过的风景，也想起当时没有来得及说完的话。我想稍微望向远一点的地方慢慢回想，不急着换动作，就让这份想念自然地停留一会儿。',
          overlayId: 'remember-inward-up',
          vmdFile: '回忆想念_朝屏幕中间上方侧脸_仅头部.vmd',
          maxHeadAngle: TWENTY_FIVE_DEGREES
        }
      ] as const;

      for (const speechCase of speechCases) {
        const before = await avatar.evaluate(() => ({
          physics: (window as any).__chatx2Runtime.__debugPhysicsContinuity(),
          head: (window as any).__chatx2Runtime.__getBoneStates(['頭'])['頭']
        }));
        const taskId = `head-overlay-${packId}-${speechCase.label}-${Date.now()}`;
        const wav = Array.from(new Uint8Array(generateMockWav({
          taskId,
          userText: speechCase.text
        })));
        const sync = await chat.evaluate(({ taskId: id, bytes, semantic, text }) =>
          (window as any).chatx2.avatarSyncVoice(
            id,
            new Uint8Array(bytes).buffer,
            semantic,
            text
          ), { taskId, bytes: wav, semantic: speechCase.semantic, text: speechCase.text });
        expect(sync.success).toBe(true);
        await expect.poll(() => avatar.evaluate(() =>
          (window as any).__chatx2Runtime.__debugHeadOverlay?.().activeId
        ), { timeout: 20_000 }).toBe(speechCase.overlayId);

        const metrics = await avatar.evaluate(async ({ idle, initialHead }) => {
        const runtime = (window as any).__chatx2Runtime;
        const dynamicNames: string[] = runtime.__debugDynamicBoneNames()
          .filter((name: string) => /hair|髪|发|髮|dress|裙|skirt|belt|リボン|ribbon/i.test(name))
          .slice(0, 120);
        const lowerNames = ['下半身', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ'];
        let previousDynamic = runtime.__getBoneStates(dynamicNames);
        let previousLower = runtime.__getBoneStates(lowerNames);
        let maxDynamicP90Step = 0;
        let maxDynamicP90ShortFrameStep = 0;
        let maxDynamicP90AngularSpeed = 0;
        const maxDynamicStepByName: Record<string, number> = {};
        let maxSampleDeltaMs = 0;
        let mergedSampleCount = 0;
        let maxDynamicTotalAngle = 0;
        let maxLowerStep = 0;
        const maxLowerSteps: Record<string, number> = {};
        let maxHeadAngle = 0;
        let maxOverlayAngle = 0;
        let bodyPackChanged = false;
        let previousSampleAt = performance.now();
        const deadline = performance.now() + 5_200;
        while (performance.now() < deadline) {
          await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
          const sampledAt = performance.now();
          const sampleDeltaMs = Math.max(0.01, sampledAt - previousSampleAt);
          previousSampleAt = sampledAt;
          maxSampleDeltaMs = Math.max(maxSampleDeltaMs, sampleDeltaMs);
          if (sampleDeltaMs > 50) mergedSampleCount += 1;
          const dynamic = runtime.__getBoneStates(dynamicNames);
          const lower = runtime.__getBoneStates(lowerNames);
          const frameAngles: number[] = [];
          const totalAngles: number[] = [];
          for (const name of dynamicNames) {
            const prior = previousDynamic[name]?.quaternion;
            const latest = dynamic[name]?.quaternion;
            if (!prior || !latest) continue;
            const dot = Math.min(1, Math.abs(prior.reduce(
              (sum: number, value: number, index: number) => sum + value * latest[index], 0
            )));
            frameAngles.push(2 * Math.acos(dot));
            maxDynamicStepByName[name] = Math.max(maxDynamicStepByName[name] ?? 0, 2 * Math.acos(dot));
            const origin = previousDynamic[name]?.quaternion;
            if (origin) totalAngles.push(2 * Math.acos(dot));
          }
          frameAngles.sort((a, b) => a - b);
          totalAngles.sort((a, b) => a - b);
          const frameP90 = frameAngles[Math.max(0, Math.ceil(frameAngles.length * 0.9) - 1)] ?? 0;
          maxDynamicP90Step = Math.max(maxDynamicP90Step, frameP90);
          maxDynamicP90AngularSpeed = Math.max(
            maxDynamicP90AngularSpeed,
            frameP90 / (sampleDeltaMs / 1000)
          );
          if (sampleDeltaMs <= 50) {
            maxDynamicP90ShortFrameStep = Math.max(maxDynamicP90ShortFrameStep, frameP90);
          }
          maxDynamicTotalAngle = Math.max(
            maxDynamicTotalAngle,
            totalAngles[Math.max(0, Math.ceil(totalAngles.length * 0.9) - 1)] ?? 0
          );
          for (const name of lowerNames) {
            const prior = previousLower[name]?.quaternion;
            const latest = lower[name]?.quaternion;
            if (!prior || !latest) continue;
            const dot = Math.min(1, Math.abs(prior.reduce(
              (sum: number, value: number, index: number) => sum + value * latest[index], 0
            )));
            maxLowerStep = Math.max(maxLowerStep, 2 * Math.acos(dot));
            maxLowerSteps[name] = Math.max(maxLowerSteps[name] ?? 0, 2 * Math.acos(dot));
          }
          const head = runtime.__getBoneStates(['頭'])['頭']?.quaternion;
          if (head && initialHead?.quaternion) {
            const dot = Math.min(1, Math.abs(initialHead.quaternion.reduce(
              (sum: number, value: number, index: number) => sum + value * head[index], 0
            )));
            maxHeadAngle = Math.max(maxHeadAngle, 2 * Math.acos(dot));
          }
          const overlay = runtime.__debugHeadOverlay();
          maxOverlayAngle = Math.max(
            maxOverlayAngle,
            (overlay.headAngle ?? 0) + (overlay.neckAngle ?? 0)
          );
          bodyPackChanged ||= runtime.motionPlayer.getCurrentPackId() !== idle;
          previousDynamic = dynamic;
          previousLower = lower;
          if (!runtime.__debugHeadOverlay().activeId && performance.now() + 200 < deadline) break;
        }
        return {
          maxDynamicP90Step,
          maxDynamicP90ShortFrameStep,
          maxDynamicP90AngularSpeed,
          maxDynamicStepByName,
          maxSampleDeltaMs,
          mergedSampleCount,
          maxDynamicTotalAngle,
          maxLowerStep,
          maxLowerSteps,
          maxHeadAngle,
          maxOverlayAngle,
          bodyPackChanged,
          finalBodyPackId: runtime.motionPlayer.getCurrentPackId(),
          headOverlay: runtime.__debugHeadOverlay(),
          physics: runtime.__debugPhysicsContinuity(),
          selection: runtime.__debugSpeechMotionSelection().lastSelection
        };
        }, { idle: defaultIdle, initialHead: before.head });

        const worstDynamicBones = Object.entries(metrics.maxDynamicStepByName)
          .sort(([, left], [, right]) => right - left)
          .slice(0, 5);
        console.log(`[head-overlay-physics] ${packId}/${speechCase.label}`, {
          p90Step: metrics.maxDynamicP90ShortFrameStep,
          lowerStep: metrics.maxLowerStep,
          rawStep: metrics.physics.maxRawDynamicOutputStep,
          worstDynamicBones
        });
        expect(metrics.selection.selectedVmdPath).toContain(speechCase.vmdFile);
        expect(metrics.selection.selectedEntry.motionScope).toBe('head-overlay');
        expect(metrics.bodyPackChanged).toBe(false);
        expect(metrics.finalBodyPackId).toBe(defaultIdle);
        expect(metrics.maxOverlayAngle).toBeGreaterThan(THREE_DEGREES);
        expect(metrics.maxOverlayAngle).toBeLessThan(speechCase.maxHeadAngle);
        expect(metrics.maxLowerStep).toBeLessThan(0.08);
        expect(metrics.maxDynamicP90Step).toBeGreaterThan(1e-5);
        expect(metrics.maxDynamicP90ShortFrameStep).toBeLessThan(0.2);
        expect(metrics.physics.forwardedResetCount).toBe(before.physics.forwardedResetCount);
        expect(metrics.physics.maxRawDynamicOutputStep).toBeLessThan(2);

        await chat.evaluate(id => (window as any).chatx2.avatarSyncStop(id, 'cancel'), taskId);
        await expect.poll(() => avatar.evaluate((idle) => {
        const runtime = (window as any).__chatx2Runtime;
        const player = runtime?.motionPlayer;
          return player?.isPlaying() === true
            && player?.getCurrentPackId() === idle
            && runtime?.__debugHeadOverlay?.().activeId === null;
        }, defaultIdle), { timeout: 20_000 }).toBe(true);
      }
    }
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

const THREE_DEGREES = 3 * Math.PI / 180;
const TWELVE_DEGREES = 12 * Math.PI / 180;
const TWENTY_TWO_DEGREES = 22 * Math.PI / 180;
const TWENTY_FIVE_DEGREES = 25 * Math.PI / 180;
