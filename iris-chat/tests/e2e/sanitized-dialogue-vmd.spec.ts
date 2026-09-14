import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// This is intentionally a candidate-review test: it exercises a sanitized
// external VMD on both real PMX models without putting it in a manifest,
// whitelist or normal speech-selection pool.
const sourceVmd = resolve(
  'models', 'shared', 'conversation-vmd-cn-sanitized', '10_解释_右手轻摊一次后回正_3.6秒.vmd'
);
const stagedVmd = resolve('temp', 'motion-packs', 'sanitized-dialogue-explain-review', 'original.vmd');
const evidenceRoot = resolve('temp', 'sanitized-dialogue-vmd-preview');

type BoneState = { position: number[]; quaternion: number[] } | null;

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

async function findChatWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const isChat = await page.evaluate(() => typeof (window as any).chatx2?.transition === 'function').catch(() => false);
      if (isChat) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('chat window API not found');
}

function componentDelta(before: BoneState, after: BoneState): number {
  if (!before || !after) return 0;
  return Math.max(
    ...before.position.map((value, index) => Math.abs(value - (after.position[index] ?? value))),
    ...before.quaternion.map((value, index) => Math.abs(value - (after.quaternion[index] ?? value)))
  );
}

async function playOnModel(model: { id: string; evidenceName: string }): Promise<void> {
  const testUserData = join(tmpdir(), `chatx2-sanitized-vmd-${model.id}-${Date.now()}`);
  const evidenceDir = join(evidenceRoot, model.evidenceName);
  mkdirSync(evidenceDir, { recursive: true });

  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_CANDIDATE_VMD_PATH: stagedVmd,
      CHAT6_TEST_USER_DATA: testUserData
    }
  });
  try {
    const chat = await findChatWindow(app);
    await chat.waitForLoadState('domcontentloaded');
    const changed = await chat.evaluate(async packId => (window as any).chatx2.switchModelPack(packId), model.id);
    expect(changed.success).toBe(true);
    // switchModelPack tells the already-created hidden avatar window to reload
    // after 500ms. Wait for that reload before taking its runtime reference.
    await chat.waitForTimeout(1_200);
    await chat.evaluate(() => (window as any).chatx2.transition('desktop'));

    const avatar = await findWindow(app, 'Avatar');
    await avatar.waitForLoadState('domcontentloaded');
    await expect.poll(
      () => avatar.evaluate(() => Boolean((window as any).__chatx2Runtime?.motionPlayer)),
      { timeout: 45_000 }
    ).toBe(true);
    await expect.poll(
      () => avatar.evaluate(async () => (await (window as any).chatx2.getCurrentModelPack()).packId),
      { timeout: 15_000 }
    ).toBe(model.id);
    await avatar.evaluate(() => {
      const panel = document.getElementById('morph-panel');
      if (panel) panel.style.display = 'none';
      (window as any).__chatx2Runtime?.cameraControl?.setAngle('full');
    });
    const before = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      runtime.motionPlayer.stopImmediate();
      runtime.relaxedBasePose?.apply();
      return {
        upper: runtime.__getBoneState?.('上半身'),
        rightArm: runtime.__getBoneState?.('右腕'),
        rightWrist: runtime.__getBoneState?.('右手首'),
        leftFoot: runtime.__getBoneState?.('左足'),
        rightFoot: runtime.__getBoneState?.('右足')
      };
    });
    await avatar.waitForTimeout(200);
    await avatar.screenshot({ path: join(evidenceDir, '00-relaxed-base.png') });

    const admission = await avatar.evaluate(async () => {
      const runtime = (window as any).__chatx2Runtime;
      const bytes = await (window as any).chatx2.loadTestMotionCandidate();
      await runtime.motionPlayer.play('sanitized-dialogue-explain-review', bytes, {
        looping: false,
        timeSource: 'local-clock',
        fadeInSeconds: 0.35,
        fadeOutSeconds: 0.6,
        cooldownSeconds: 0,
        force: true,
        // Sanitizer rebases source rotations to a zero delta; this mode keeps
        // ChatX2's relaxed pose at the first/last VMD samples.
        compositionMode: 'additive-from-base',
        candidateTrackPolicy: 'dialogue-body-only'
      });
      return {
        duration: runtime.motionPlayer.getAnimationDuration(),
        bones: runtime.motionPlayer.getCurrentBoneNames(),
        morphs: runtime.motionPlayer.getCurrentMorphNames()
      };
    });

    expect(admission.duration).toBeGreaterThan(3.5);
    expect(admission.duration).toBeLessThan(4.3);
    expect(admission.morphs).toEqual([]);
    expect(admission.bones).toContain('右腕');
    expect(admission.bones).toContain('右手首');
    expect(admission.bones).not.toContain('センター');
    expect(admission.bones).not.toContain('下半身');
    expect(admission.bones).not.toContain('左足ＩＫ');
    expect(admission.bones).not.toContain('右足ＩＫ');

    let maximumRightArmDelta = 0;
    for (let index = 0; index < 8; index += 1) {
      await avatar.waitForTimeout(300);
      const sampled = await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        return {
          upper: runtime.__getBoneState?.('上半身'),
          rightArm: runtime.__getBoneState?.('右腕'),
          rightWrist: runtime.__getBoneState?.('右手首'),
          leftFoot: runtime.__getBoneState?.('左足'),
          rightFoot: runtime.__getBoneState?.('右足')
        };
      });
      maximumRightArmDelta = Math.max(
        maximumRightArmDelta,
        componentDelta(before.rightArm, sampled.rightArm),
        componentDelta(before.rightWrist, sampled.rightWrist)
      );
      expect(componentDelta(before.leftFoot, sampled.leftFoot)).toBeLessThan(0.001);
      expect(componentDelta(before.rightFoot, sampled.rightFoot)).toBeLessThan(0.001);
      if (index === 3) await avatar.screenshot({ path: join(evidenceDir, '01-peak-full.png') });
    }
    expect(maximumRightArmDelta).toBeGreaterThan(0.02);

    await avatar.evaluate(() => (window as any).__chatx2Runtime?.cameraControl?.setAngle('face'));
    await avatar.screenshot({ path: join(evidenceDir, '01-peak-face.png') });
    await avatar.waitForTimeout(1_800);
    await avatar.screenshot({ path: join(evidenceDir, '02-after.png') });
    const cleanup = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      runtime.motionPlayer.stopImmediate();
      runtime.relaxedBasePose?.apply();
      return {
        playing: runtime.motionPlayer.isPlaying(),
        morphs: runtime.motionPlayer.getCurrentMorphNames(),
        boneOwners: runtime.boneOwnershipRegistry.releaseAll()
      };
    });
    expect(cleanup.playing).toBe(false);
    expect(cleanup.morphs).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(testUserData, { recursive: true, force: true });
  }
}

test.describe('sanitized dialogue VMD candidate on real PMX models', () => {
  test.skip(!existsSync(sourceVmd), `sanitized VMD missing: ${sourceVmd}`);
  test.setTimeout(180_000);

  test.beforeAll(() => {
    mkdirSync(resolve('temp', 'motion-packs', 'sanitized-dialogue-explain-review'), { recursive: true });
    copyFileSync(sourceVmd, stagedVmd);
  });

  test.afterAll(() => {
    rmSync(resolve('temp', 'motion-packs', 'sanitized-dialogue-explain-review'), { recursive: true, force: true });
  });

  test('replays a body-only explanatory gesture on Selena and Yangyang', async () => {
    await playOnModel({ id: 'selena-xisheng-v1', evidenceName: 'selena' });
    await playOnModel({ id: 'yyxuanling-v1', evidenceName: 'yangyang' });
  });
});
