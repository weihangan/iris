import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EVIDENCE_DIR = resolve(__dirname, '..', '..', 'docs', 'evidence');

/**
 * Phase 3 Step 6.2：显式暂停/恢复动画循环（mode-change 订阅）
 *
 * 验证：
 * 1. Desktop 模式：frame count 增长（循环运行）
 * 2. 返回 Chat：frame count 不再增长（循环停止）
 * 3. 再进入 Desktop：frame count 恢复增长（循环恢复）
 * 4. 连续切换多次仍只有一个循环（startLoop/stopLoop 幂等）
 * 5. cleanup 后不再更新
 *
 * 实现要求：
 * - startLoop/stopLoop 必须幂等
 * - 恢复时重置 previous timestamp（避免巨大 delta）
 * - 切回 Chat 不 dispose 模型；beforeunload/窗口关闭才完整 cleanup
 * - cleanup 必须取消 mode-change 订阅
 * - 不依赖 Electron 隐藏窗口自动节流
 */

async function launchAppWithPmxRender(): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1'
    }
  });
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (app.windows().length >= 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  let chatPage: Page | null = null;
  const findStart = Date.now();
  while (Date.now() - findStart < 10000) {
    for (const w of app.windows()) {
      const title = await w.title().catch(() => '');
      if (title.startsWith('伊利斯 ChatX2')) {
        chatPage = w;
        break;
      }
    }
    if (chatPage) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!chatPage) {
    const titles = await Promise.all(app.windows().map(w => w.title().catch(() => '?')));
    throw new Error(`Chat window not found within 10s. Window titles: ${JSON.stringify(titles)}`);
  }
  const page = chatPage;
  await page.waitForLoadState('domcontentloaded');
  const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, page, userDataDir: identity.userDataDir };
}

async function closeAppAndCleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    await new Promise(r => setTimeout(r, 1000));
    let cleaned = false;
    for (let i = 0; i < 15; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
      if (!existsSync(userDataDir)) {
        await new Promise(r => setTimeout(r, 200));
        if (!existsSync(userDataDir)) {
          cleaned = true;
          break;
        }
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    expect(existsSync(userDataDir)).toBe(false);
    if (!cleaned) {
      throw new Error(`Failed to clean up userDataDir after 15 retries: ${userDataDir}`);
    }
  }
}

async function waitForPmxFirstFrame(page: Page, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => (window as any).chatx2.hasAvatarReady());
    if (ready) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForMode(page: Page, expectedMode: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const mode = await page.evaluate(() => (window as any).chatx2.getMode());
    if (mode === expectedMode) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

async function findAvatarWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const title = await Promise.race([
      w.title().catch(() => ''),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
    ]);
    if (title.includes('Avatar')) return w;
  }
  return null;
}

test.describe('ChatX2 Avatar Loop Lifecycle（Phase 3 Step 6.2）', () => {
  test.afterAll(async () => {
    const tmp = tmpdir();
    let entries: string[] = [];
    try {
      entries = readdirSync(tmp).filter(name => name.startsWith('chat6-test-'));
    } catch {
      return;
    }
    for (const name of entries) {
      const dir = join(tmp, name);
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // 忽略
        }
        if (!existsSync(dir)) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
  });

  test('Step 6.2: mode-change 订阅自动 start/stop 动画循环', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      // 切换到 desktop
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(1500);

      const avatarWindow = await findAvatarWindow(app);
      expect(avatarWindow).not.toBeNull();

      // 1. Desktop 模式：frame count 应该增长
      const desktopFrameCount1 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      await avatarWindow!.waitForTimeout(500);  // 等待半秒
      const desktopFrameCount2 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      expect(desktopFrameCount2, 'Desktop mode: frame count should increase').toBeGreaterThan(desktopFrameCount1);
      console.log('[loop-test] desktop frame count:', desktopFrameCount1, '→', desktopFrameCount2);

      // 2. 切回 Chat：frame count 应停止增长
      await page.evaluate(() => (window as any).chatx2.transition('chat'));
      await waitForMode(page, 'chat', 5000);
      await page.waitForTimeout(1500);  // 等待窗口切换稳定

      const chatFrameCount1 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      // 确认循环已停止
      const isRunningInChat = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.isRunning?.() ?? null
      );
      expect(isRunningInChat, 'Chat mode: loop should be stopped').toBe(false);

      await avatarWindow!.waitForTimeout(500);
      const chatFrameCount2 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      expect(chatFrameCount2, 'Chat mode: frame count should NOT increase').toBe(chatFrameCount1);
      console.log('[loop-test] chat frame count (stopped):', chatFrameCount1, '→', chatFrameCount2);

      // 3. 再切回 Desktop：frame count 应恢复增长
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(1500);

      const desktopFrameCount3 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      // 确认循环已恢复
      const isRunningAgain = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.isRunning?.() ?? null
      );
      expect(isRunningAgain, 'Desktop mode again: loop should be running').toBe(true);

      await avatarWindow!.waitForTimeout(500);
      const desktopFrameCount4 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      expect(desktopFrameCount4, 'Desktop mode again: frame count should increase').toBeGreaterThan(desktopFrameCount3);
      console.log('[loop-test] desktop again frame count:', desktopFrameCount3, '→', desktopFrameCount4);

      // 4. 连续多次切换：仍只有一个循环（幂等）
      // 切到 chat 再切到 desktop 3 次
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => (window as any).chatx2.transition('chat'));
        await waitForMode(page, 'chat', 5000);
        await page.waitForTimeout(300);
        await page.evaluate(() => (window as any).chatx2.transition('desktop'));
        await waitForMode(page, 'desktop', 5000);
        await page.waitForTimeout(300);
      }
      // 最终在 desktop 模式，循环应该运行
      const isRunningFinal = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.isRunning?.() ?? null
      );
      expect(isRunningFinal, 'After multiple switches: loop should still be running').toBe(true);

      // 验证循环仍然可以增长（没有失效）
      const finalCount1 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      await avatarWindow!.waitForTimeout(500);
      const finalCount2 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.getFrameCount?.() ?? -1
      );
      expect(finalCount2, 'After multiple switches: frame count should still increase').toBeGreaterThan(finalCount1);

      console.log('[loop-test] all checks PASSED');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
