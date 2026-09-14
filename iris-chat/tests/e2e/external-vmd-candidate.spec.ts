import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const candidatePath = join(
  process.env.APPDATA ?? '',
  'wha1999', 'ChatX2Selena', 'motion-packs',
  'gesture-mischief-upper-v1', 'original.vmd'
);
const evidenceDir = resolve('temp', 'external-vmd-candidate', 'gesture-mischief-upper-v1');

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

test('本地网络 VMD 候选在真实赛琳娜 PMX 上过滤后试播', async () => {
  test.skip(!existsSync(candidatePath), `candidate missing: ${candidatePath}`);
  test.setTimeout(120_000);
  mkdirSync(evidenceDir, { recursive: true });
  const testUserData = join(tmpdir(), `chat6-test-vmd-${Date.now()}`);
  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_CANDIDATE_VMD_PATH: candidatePath,
      CHAT6_TEST_USER_DATA: testUserData
    }
  });
  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    await chat.waitForLoadState('domcontentloaded');
    await expect.poll(
      () => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 45_000 }
    ).toBe(true);
    await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
    const avatar = await findWindow(app, 'Avatar');
    await avatar.waitForLoadState('domcontentloaded');
    await avatar.evaluate(() => {
      const panel = document.getElementById('morph-panel');
      if (panel) panel.style.display = 'none';
      (window as any).__chatx2Runtime?.cameraControl?.setAngle('full');
    });
    await avatar.waitForTimeout(500);
    await avatar.screenshot({ path: join(evidenceDir, '00-before.png') });

    const admission = await avatar.evaluate(async () => {
      const api = (window as any).chatx2;
      const runtime = (window as any).__chatx2Runtime;
      runtime.motionPlayer.stopImmediate();
      const bytes = await api.loadTestMotionCandidate();
      await runtime.motionPlayer.play('gesture-mischief-upper-v1', bytes, {
        amplitudeLimits: {
          head: { x: 30, y: 30, z: 30 },
          upperBody: { x: 20, y: 20, z: 20 },
          shoulder: { x: 15, y: 15, z: 15 },
          faceRedMax: 0.35
        },
        looping: false,
        timeSource: 'local-clock',
        fadeInSeconds: 0.5,
        fadeOutSeconds: 0.5,
        cooldownSeconds: 0,
        force: true,
        compositionMode: 'absolute',
        candidateTrackPolicy: 'standard-upper-body'
      });
      return {
        boneNames: runtime.motionPlayer.getCurrentBoneNames(),
        morphNames: runtime.motionPlayer.getCurrentMorphNames(),
        duration: runtime.motionPlayer.getAnimationDuration()
      };
    });

    expect(admission.duration).toBeGreaterThan(0.9);
    expect(admission.duration).toBeLessThan(1.5);
    expect(admission.boneNames).toContain('頭');
    expect(admission.boneNames).toContain('首');
    expect(admission.boneNames.length).toBeLessThan(60);
    expect(admission.morphNames.every((name: string) =>
      ['まばたき', '笑い', 'あ', 'い', 'う', 'え', 'お'].includes(name)
    )).toBe(true);

    await avatar.waitForTimeout(400);
    await avatar.screenshot({ path: join(evidenceDir, '01-enter.png') });
    await avatar.waitForTimeout(350);
    await avatar.screenshot({ path: join(evidenceDir, '02-peak.png') });
    await avatar.evaluate(() => (window as any).__chatx2Runtime?.cameraControl?.setAngle('face'));
    await avatar.screenshot({ path: join(evidenceDir, '02-peak-face.png') });
    await avatar.evaluate(() => (window as any).__chatx2Runtime?.cameraControl?.setAngle('full'));

    const peak = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return {
        head: runtime.__getBoneState?.('頭'),
        neck: runtime.__getBoneState?.('首'),
        leftArm: runtime.__getBoneState?.('左腕'),
        rightArm: runtime.__getBoneState?.('右腕'),
        blink: runtime.morphControl?.getRenderedWeight('まばたき') ?? 0,
        smile: runtime.morphControl?.getRenderedWeight('笑い') ?? 0
      };
    });
    expect(peak.head).not.toBeNull();
    expect(peak.neck).not.toBeNull();
    expect(peak.leftArm).not.toBeNull();
    expect(peak.rightArm).not.toBeNull();

    await avatar.waitForTimeout(1200);
    await avatar.screenshot({ path: join(evidenceDir, '03-end.png') });
    const cleanup = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      runtime.motionPlayer.stopImmediate();
      runtime.relaxedBasePose?.apply();
      return {
        playing: runtime.motionPlayer.isPlaying(),
        boneOwners: runtime.boneOwnershipRegistry.releaseAll(),
        morphOwners: runtime.morphOwnershipRegistry.releaseAll()
      };
    });
    expect(cleanup.playing).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(testUserData, { recursive: true, force: true });
  }
});
