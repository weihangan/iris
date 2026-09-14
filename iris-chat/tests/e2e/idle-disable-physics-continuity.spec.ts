import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
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

test('desktop idle stays disabled until explicitly enabled and disabling it cancels the timer', async () => {
  test.setTimeout(120_000);
  const root = join(tmpdir(), `chatx2-idle-disable-${Date.now()}`);
  const userDataDir = join(root, 'profile');
  const sharedRoot = join(root, 'shared', 'ChatX2Selena');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(sharedRoot, { recursive: true });
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
    const avatar = await findWindow(app, 'Avatar');
    const composer = await findWindow(app, 'Composer');
    await expect.poll(() => avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return {
        playing: runtime?.motionPlayer?.isPlaying(),
        lifecycle: runtime?.__debugIdleLifecycle?.() ?? null
      };
    }), { timeout: 10_000 }).toEqual({
      playing: true,
      lifecycle: expect.objectContaining({
        currentKind: 'default-loop',
        paused: true,
        timerArmed: false
      })
    });

    const before = await avatar.evaluate(() => ({
      lifecycle: (window as any).__chatx2Runtime.__debugIdleLifecycle?.() ?? null,
      physics: (window as any).__chatx2Runtime.__debugPhysicsContinuity()
    }));
    const toggled = await composer.evaluate(() => (window as any).chatx2.toggleIdlePaused());
    expect(toggled).toEqual({ success: true, paused: false });

    await expect.poll(() => avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return {
        lifecycle: runtime.__debugIdleLifecycle?.() ?? null,
        playing: runtime.motionPlayer.isPlaying()
      };
    }), { timeout: 10_000 }).toEqual({
      lifecycle: expect.objectContaining({
        paused: false,
        currentKind: 'default-loop',
        timerArmed: true
      }),
      playing: true
    });

    await composer.evaluate(() => (window as any).chatx2.toggleIdlePaused());
    await expect.poll(() => avatar.evaluate(() => ({
      lifecycle: (window as any).__chatx2Runtime.__debugIdleLifecycle(),
      playing: (window as any).__chatx2Runtime.motionPlayer.isPlaying()
    })), { timeout: 10_000 }).toMatchObject({
      lifecycle: expect.objectContaining({ paused: true, currentKind: 'default-loop', timerArmed: false }),
      playing: true
    });
    await avatar.waitForTimeout(2_500);
    const after = await avatar.evaluate(() => ({
      lifecycle: (window as any).__chatx2Runtime.__debugIdleLifecycle(),
      playing: (window as any).__chatx2Runtime.motionPlayer.isPlaying(),
      physics: (window as any).__chatx2Runtime.__debugPhysicsContinuity()
    }));
    expect(after.lifecycle).toMatchObject({
      phase: 'disabled',
      currentKind: 'default-loop',
      timerArmed: false
    });
    expect(after.playing).toBe(true);
    expect(after.physics.forwardedResetCount).toBe(before.physics.forwardedResetCount);
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
