import { test, expect, _electron, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

async function findWindow(app: any, titlePart: string): Promise<Page> {
  await expect.poll(async () => (await Promise.all(app.windows().map((p: Page) => p.title().catch(() => '')))).some((t: string) => t.includes(titlePart)), { timeout: 30_000 }).toBe(true);
  for (const page of app.windows()) {
    if ((await page.title().catch(() => '')).includes(titlePart)) return page;
  }
  throw new Error(`Window not found: ${titlePart}`);
}

test('diagnose current imported model speech runtime', async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), 'chatx2-imported-speech-'));
  const errors: string[] = [];
  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_USER_DATA: userData,
      CHATX2_SHARED_DATA_DIR: resolve('shared-user-data', 'ChatX2Selena')
    }
  });
  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    if (await chat.evaluate(() => (window as any).chatx2.getMode()) !== 'desktop') {
      await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
    }
    const avatar = await findWindow(app, 'Avatar');
    avatar.on('console', message => {
      const line = `${message.type()}: ${message.text()}`;
      if (/error|failed|skip|reject|speech|motion/i.test(line)) errors.push(line);
    });
    avatar.on('pageerror', error => errors.push(`pageerror: ${error.stack ?? error.message}`));
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()), { timeout: 45_000 }).toBe(true);
    const packs = await chat.evaluate(() => (window as any).chatx2.listModelPacks());
    console.log('ALL_PACKS=' + JSON.stringify(packs));
    const target = packs.find((p: any) => /婚皮/.test(p.displayName)) ?? packs.find((p: any) => /Q/.test(p.displayName));
    if (!target) throw new Error('target imported pack missing: ' + JSON.stringify(packs));
    console.log('TARGET_PACK=' + JSON.stringify(target));
    console.log('SWITCH_RESULT=' + JSON.stringify(await chat.evaluate((id) => (window as any).chatx2.switchModelPack(id), target.packId)));
    await avatar.waitForTimeout(4_000);
    console.log('MODEL_RUNTIME=' + JSON.stringify(await avatar.evaluate(() => {
      const r = (window as any).__chatx2Runtime;
      return {
        motion: r.__debugMotionPlayerState?.(),
        physics: r.__debugPhysicsContinuity?.(),
        dynamicCount: r.__debugDynamicBoneNames?.()?.length,
        attachments: r.__debugRootDragAttachmentBoneNames?.(),
        pipeline: r.__debugBonePhysicsPipeline?.(['左腕', '右腕', '左足', '右足', '头', '頭'])
      };
    }), null, 2));
    const current = await chat.evaluate(() => (window as any).chatx2.getCurrentModelPack());
    const trackedBones = ['上半身', '左腕', '右腕', '左ひじ', '右ひじ', '左足', '右足'];
    const sampleBones = () => avatar.evaluate(names =>
      (window as any).__chatx2Runtime.__getBoneStates?.(names), trackedBones);
    const baselineBones = await sampleBones();
    const quaternionDelta = (before: any, after: any, name: string): number => {
      const a = before?.[name]?.quaternion;
      const b = after?.[name]?.quaternion;
      if (!a || !b) return 0;
      const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
      return 2 * Math.acos(dot);
    };
    const previewPath = '../shared/motions/解释_右手轻摊一次后回正.vmd';
    const preview = await chat.evaluate(path => (window as any).chatx2.previewCustomVmd(path), previewPath);
    const previewDeltas: number[] = [];
    for (let i = 0; i < 14; i++) {
      const bones = await sampleBones();
      previewDeltas.push(Math.max(...trackedBones.map(name => quaternionDelta(baselineBones, bones, name))));
      await avatar.waitForTimeout(200);
    }
    await avatar.waitForTimeout(2_200);
        const before = await avatar.evaluate(() => {
      const r = (window as any).__chatx2Runtime;
      return {
        motion: r.__debugMotionPlayerState(),
        speech: r.__debugSpeechMotionSelection(),
        physics: r.__debugPhysicsContinuity?.(),
        mouse: r.__testGetAvatarMousePolicy?.(),
        poseLocked: r.motionPlayer?.isPoseLocked?.(),
        frames: r.loopController?.getStats?.()
      };
    });
    const text = '让我认真解释一下现在的情况。我会把最重要的部分逐项说明，也请你留意我接下来的动作和语气变化。';
    const taskId = `debug-imported-${Date.now()}`;
    const wav = Array.from(new Uint8Array(generateMockWav({ taskId, userText: text })));
    const sync = await chat.evaluate(async payload => (window as any).chatx2.avatarSyncVoice(payload.taskId, new Uint8Array(payload.wav).buffer, { emotion: 'explaining', intent: 'explain', intensity: 0.75 }, payload.text), { taskId, wav, text });
    const samples: any[] = [];
    for (let i = 0; i < 28; i++) {
      samples.push(await avatar.evaluate((names) => {
        const r = (window as any).__chatx2Runtime;
        return {
          at: performance.now(),
          performance: r.performanceSession?.getState?.(),
          motion: r.__debugMotionPlayerState?.(),
          speech: r.__debugSpeechMotionSelection?.(),
          physics: r.__debugPhysicsContinuity?.(),
          mouse: r.__testGetAvatarMousePolicy?.(),
          poseLocked: r.motionPlayer?.isPoseLocked?.(),
          frames: r.loopController?.getStats?.(),
          bones: r.__getBoneStates?.(names)
        };
      }, trackedBones));
      await avatar.waitForTimeout(200);
    }
    const voiceDeltas = samples.map(sample => Math.max(
      ...trackedBones.map(name => quaternionDelta(baselineBones, sample.bones, name))
    ));
    const summary = {
      current: { packId: current.packId, displayName: current.displayName },
      preview,
      sync,
      previewMaxBoneDelta: Math.max(...previewDeltas),
      voiceMaxBoneDelta: Math.max(...voiceDeltas),
      before: {
        state: before.motion?.state,
        packId: before.motion?.currentPackId,
        poseLocked: before.poseLocked
      },
      speechStates: samples.map(sample => ({
        performance: sample.performance,
        packId: sample.motion?.currentPackId,
        state: sample.motion?.state,
        animationTime: sample.motion?.currentAnimationTime,
        modelUpdateTime: sample.motion?.currentModelUpdateTime,
        animationStartedAt: sample.motion?.animationStartedAt,
        nowSeconds: sample.motion?.nowSeconds,
        speechContinuityActive: sample.physics?.speechContinuityActive,
        effectiveIgnoreMouse: sample.mouse?.effectiveIgnoreMouse,
        poseLocked: sample.poseLocked,
        selectedVmdPath: sample.speech?.lastSelection?.selectedVmdPath
      })),
      errors
    };
    console.log('IMPORTED_SPEECH_DIAG=' + JSON.stringify(summary, null, 2));
    expect(summary.speechStates.some((sample, index) =>
      index >= 10 && sample.performance === 'performing' && sample.state !== 'bridging'
    )).toBe(true);
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
});
