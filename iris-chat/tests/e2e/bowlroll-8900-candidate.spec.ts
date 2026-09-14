import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const candidateFile = process.env.CHAT6_BOWLROLL_FILE ?? 'ten_stand.vmd';
const candidateId = candidateFile.replace(/\.vmd$/i, '').replace(/[^a-z0-9_-]/gi, '-');
const candidatePath = join(
  process.env.APPDATA ?? '', 'wha1999', 'ChatX2Selena', 'motion-packs',
  `bowlroll-8900-${candidateId}`, 'original.vmd'
);
const sourceCandidatePath = resolve('temp', 'motion-candidates', 'bowlroll-8900', 'extracted', candidateFile);
const evidenceDir = resolve('temp', 'motion-candidates', 'bowlroll-8900', `playback-${candidateId}`);

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

test(`BowlRoll 8900 ${candidateFile} upper-body filter plays on real Selena PMX`, async () => {
  test.skip(!existsSync(sourceCandidatePath) || !existsSync(candidatePath), `candidate missing: ${candidatePath}`);
  test.setTimeout(120_000);
  mkdirSync(evidenceDir, { recursive: true });
  const testUserData = join(tmpdir(), `chat6-test-bowlroll-8900-${Date.now()}`);
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
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()), { timeout: 45_000 }).toBe(true);
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

    const initialFeet = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return {
        left: runtime.__getBoneState?.('左足'),
        right: runtime.__getBoneState?.('右足')
      };
    });

    const admission = await avatar.evaluate(async () => {
      const runtime = (window as any).__chatx2Runtime;
      runtime.motionPlayer.stopImmediate();
      const bytes = await (window as any).chatx2.loadTestMotionCandidate();
      await runtime.motionPlayer.play('bowlroll-8900-ten-stand-review', bytes, {
        looping: true,
        timeSource: 'local-clock',
        fadeInSeconds: 0.5,
        fadeOutSeconds: 0.5,
        force: true,
        compositionMode: 'absolute',
        candidateTrackPolicy: 'standard-upper-body'
      });
      return {
        bones: runtime.motionPlayer.getCurrentBoneNames(),
        morphs: runtime.motionPlayer.getCurrentMorphNames(),
        duration: runtime.motionPlayer.getAnimationDuration()
      };
    });

    expect(admission.duration).toBeGreaterThan(10);
    expect(admission.duration).toBeLessThan(25);
    expect(admission.bones).toContain('頭');
    expect(admission.bones).toContain('上半身');
    expect(admission.bones).not.toContain('センター');
    expect(admission.bones).not.toContain('下半身');
    expect(admission.bones).not.toContain('左足ＩＫ');
    expect(admission.bones).not.toContain('右足ＩＫ');

    await avatar.waitForTimeout(2_500);
    await avatar.screenshot({ path: join(evidenceDir, '01-playing-full.png') });
    await avatar.evaluate(() => (window as any).__chatx2Runtime?.cameraControl?.setAngle('face'));
    await avatar.screenshot({ path: join(evidenceDir, '02-playing-face.png') });

    const sampled = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return {
        head: runtime.__getBoneState?.('頭'),
        upperBody: runtime.__getBoneState?.('上半身'),
        leftShoulder: runtime.__getBoneState?.('左肩'),
        rightShoulder: runtime.__getBoneState?.('右肩'),
        leftWrist: runtime.__getBoneState?.('左手首'),
        rightWrist: runtime.__getBoneState?.('右手首'),
        leftFoot: runtime.__getBoneState?.('左足'),
        rightFoot: runtime.__getBoneState?.('右足')
      };
    });
    expect(sampled.head).not.toBeNull();
    expect(sampled.upperBody).not.toBeNull();
    expect(sampled.leftShoulder).not.toBeNull();
    expect(sampled.rightShoulder).not.toBeNull();
    expect(sampled.leftWrist).not.toBeNull();
    expect(sampled.rightWrist).not.toBeNull();
    const distance = (a: any, b: any) => Math.hypot(
      a.position[0] - b.position[0],
      a.position[1] - b.position[1],
      a.position[2] - b.position[2]
    );
    expect(distance(sampled.leftFoot, initialFeet.left)).toBeLessThan(0.001);
    expect(distance(sampled.rightFoot, initialFeet.right)).toBeLessThan(0.001);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(testUserData, { recursive: true, force: true });
  }
});
