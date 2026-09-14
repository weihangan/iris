import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EVIDENCE_DIR = resolve(__dirname, '..', '..', 'docs', 'evidence');

// Phase 2 Task 2.2（修复后）: 窗口显隐顺序、失败恢复、Scene unavailable E2E 测试
// 修复要点：
// - 每个测试使用独立应用状态（单独 launch + close），无 beforeAll 共享状态
// - placeholder-canvas 不能授权 Desktop 切换；测试通过 test-only-ready IPC 注入
// - 真实 render-process-gone crash 测试（forcefullyCrashRenderer）
// - 真实关闭 Avatar 窗口测试（win.close()）
// - 截图失败必须让测试失败（无 try/catch 吞掉）
// - 测试进程负责清理临时 userData，断言目录不存在

/**
 * 启动 Electron 应用并返回引用和 page（Chat 窗口，非 firstWindow）
 * 注意：firstWindow 可能返回 Avatar/Composer 窗口（它们都不暴露 transition 等方法），
 * 必须通过标题 '伊利斯 ChatX2' 过滤找到 Chat 窗口。
 * 等待所有 3 个窗口都出现，避免 Avatar/Composer 还在创建中导致 firstWindow 拿到错误的窗口。
 */
async function launchApp(): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });
  // 等待所有 3 个窗口都创建完成（Chat/Avatar/Composer）
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (app.windows().length >= 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  // 通过标题找到 Chat 窗口（避免拿到 Avatar/Composer）
  // Chat 窗口标题被 renderer.ts 改为 "伊利斯 ChatX2 v{version}"，用 startsWith 匹配
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
  // 获取临时 userData 路径用于清理
  const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, page, userDataDir: identity.userDataDir };
}

/**
 * 关闭应用并清理临时 userData（测试进程负责，断言目录不存在）
 * Windows 上 Electron 退出后 GPU/cache 子进程可能仍短暂持有文件锁并异步写入，
 * 需要先等待进程完全退出，再重试删除。
 * 关键：必须真实清理（不只是 existsSync 返回 false），避免 %TEMP% 残留累积。
 */
async function closeAppAndCleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    // 先等 1 秒让 Electron 子进程（GPU/cache）完全退出，避免异步写入与 rmSync 竞争
    await new Promise(r => setTimeout(r, 1000));
    // 重试删除（最多 15 次，每次 300ms，总计约 4.5 秒）
    let cleaned = false;
    for (let i = 0; i < 15; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // 忽略，下次重试
      }
      if (!existsSync(userDataDir)) {
        // 再等 200ms 确认没有子进程重新创建
        await new Promise(r => setTimeout(r, 200));
        if (!existsSync(userDataDir)) {
          cleaned = true;
          break;
        }
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    // 断言目录不存在（清理必须真实生效）
    expect(existsSync(userDataDir)).toBe(false);
    if (!cleaned) {
      throw new Error(`Failed to clean up userDataDir after 15 retries: ${userDataDir}`);
    }
  }
}

/**
 * 通过 IPC 获取所有窗口的可见性
 */
async function getWindowVisibilities(page: Page): Promise<Array<{ title: string; visible: boolean; type: string }>> {
  return page.evaluate(() => (window as any).chatx2.getWindowsVisibility());
}

/**
 * 等待模式稳定到预期值
 */
async function waitForMode(page: Page, expectedMode: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const mode = await page.evaluate(() => (window as any).chatx2.getMode());
    if (mode === expectedMode) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

/**
 * 在主进程找到 Avatar 窗口并执行回调
 */
async function withAvatarWindow(app: ElectronApplication, action: 'crash' | 'close'): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, extra) => {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (win.getTitle().includes('Avatar')) {
        if (extra === 'crash') {
          win.webContents.forcefullyCrashRenderer();
        } else {
          win.close();
        }
        return;
      }
    }
  }, action);
}

test.describe('ChatX2 窗口切换（独立状态，修复后）', () => {
  // afterAll 兜底清理：测试结束后扫描 %TEMP%/chat6-test-* 并删除
  // 这是对每个测试 closeAppAndCleanup 的补充，防止 Electron 子进程异步写入导致的残留累积
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

  test('启动后初始 mode 为 chat，Chat 可见，Avatar/Composer 隐藏', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      const mode = await page.evaluate(() => (window as any).chatx2.getMode());
      expect(mode).toBe('chat');

      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      const avatarWin = visibilities.find(v => v.type === 'avatar');
      const composerWin = visibilities.find(v => v.type === 'composer');

      expect(chatWin?.visible).toBe(true);
      expect(avatarWin?.visible).toBe(false);
      expect(composerWin?.visible).toBe(false);

      // 捕获 Chat 窗口截图作为 Phase 2 证据（截图失败必须让测试失败）
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(EVIDENCE_DIR, 'phase-2-chat-mode.png') });
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('placeholder-canvas 证据不能授权 Desktop 切换（Chat 仍可见）', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 等待 avatar renderer 发送 placeholder-canvas（自动）
      await page.waitForTimeout(1500);

      // 即使 placeholder-canvas 证据存在，transition(desktop) 仍应失败（硬门）
      const result = await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('failure');
      expect(result.reason).toBe('no-avatar-ready');

      const mode = await page.evaluate(() => (window as any).chatx2.getMode());
      expect(mode).toBe('chat');

      // Chat 仍可见（没有授权切换）
      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      expect(chatWin?.visible).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('transition(scene) 返回 unavailable，mode 不变', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      const result = await page.evaluate(() => (window as any).chatx2.transition('scene'));
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('scene-not-implemented');
      const mode = await page.evaluate(() => (window as any).chatx2.getMode());
      expect(mode).toBe('chat');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('test-only-ready 注入后 transition(desktop) 成功，Avatar/Composer 与 Chat 共存', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 验证测试模式
      const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
      expect(identity.isTest).toBe(true);

      // 通过 chat-preload 暴露的 testInjectReady（仅测试模式）注入证据
      const injectResult = await page.evaluate(() => (window as any).chatx2.testInjectReady());
      expect(injectResult?.success).toBe(true);

      // transition 应返回 ok 且 mode 为 loading（事务开始）
      const result = await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('ok');
      expect(result.mode).toBe('loading');

      // 等待事务完成（loading → desktop）
      const committed = await waitForMode(page, 'desktop', 5000);
      expect(committed).toBe(true);

      // 等待窗口编排完成
      await page.waitForTimeout(1000);

      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      const avatarWin = visibilities.find(v => v.type === 'avatar');
      const composerWin = visibilities.find(v => v.type === 'composer');

      // 当前产品行为：桌宠和聊天窗口共存，便于语音、模型和历史对话同时使用。
      expect(avatarWin?.visible).toBe(true);
      expect(composerWin?.visible).toBe(true);
      expect(chatWin?.visible).toBe(true);

      // 捕获 Avatar 窗口截图作为 Phase 2 证据（截图失败必须让测试失败）
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const windows = app.windows();
      for (const w of windows) {
        const title = await Promise.race([
          w.title().catch(() => ''),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
        ]);
        if (title.includes('Avatar')) {
          await w.screenshot({ path: join(EVIDENCE_DIR, 'phase-2-desktop-avatar.png') });
          break;
        }
      }
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('transition(chat) 从 desktop 切回，Chat 可见，Avatar/Composer 隐藏', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入证据并切到 desktop
      await page.evaluate(() => (window as any).chatx2.testInjectReady());
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(800);

      // 切回 chat
      const result = await page.evaluate(() => (window as any).chatx2.transition('chat'));
      expect(result.status).toBe('ok');

      // 等待窗口编排完成
      await page.waitForTimeout(1000);

      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      const avatarWin = visibilities.find(v => v.type === 'avatar');
      const composerWin = visibilities.find(v => v.type === 'composer');

      expect(chatWin?.visible).toBe(true);
      expect(avatarWin?.visible).toBe(false);
      expect(composerWin?.visible).toBe(false);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('真实 Avatar renderer crash 后恢复 Chat（render-process-gone）', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入证据并切到 desktop
      await page.evaluate(() => (window as any).chatx2.testInjectReady());
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(800);

      // 真实 crash Avatar renderer（触发 render-process-gone）
      await withAvatarWindow(app, 'crash');

      // 等待 render-process-gone 事件触发 reportAvatarCrash
      const recovered = await waitForMode(page, 'chat', 5000);
      expect(recovered).toBe(true);

      // Chat 必须恢复可见
      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      expect(chatWin?.visible).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('关闭 Avatar 窗口后恢复 Chat', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入证据并切到 desktop
      await page.evaluate(() => (window as any).chatx2.testInjectReady());
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(800);

      // 真实关闭 Avatar 窗口（触发 closed 事件）
      await withAvatarWindow(app, 'close');

      // 等待 closed 事件触发 reportAvatarCrash
      const recovered = await waitForMode(page, 'chat', 5000);
      expect(recovered).toBe(true);

      // Chat 必须可见
      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      expect(chatWin?.visible).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('avatar 崩溃后证据清除，再次 transition(desktop) 失败', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入证据并切到 desktop
      await page.evaluate(() => (window as any).chatx2.testInjectReady());
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);

      // 真实 crash Avatar
      await withAvatarWindow(app, 'crash');
      await waitForMode(page, 'chat', 5000);

      // 证据应已清除
      const ready = await page.evaluate(() => (window as any).chatx2.hasAvatarReady());
      expect(ready).toBe(false);

      // 再次 transition 失败
      const result = await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('failure');
      expect(result.reason).toBe('no-avatar-ready');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('窗口显示失败时事务回滚（仅 Chat 可见）', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入证据
      await page.evaluate(() => (window as any).chatx2.testInjectReady());

      // 关闭 Composer 窗口（Composer closed 只置 null，不触发 reportAvatarCrash）
      // 这样 showDesktopWindowsAndCommit 会检测到 composerWindow=null 并回滚
      await app.evaluate(async ({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        for (const win of wins) {
          if (win.getTitle().includes('Composer')) {
            win.destroy();
            return;
          }
        }
      }, null);

      // transition 进入 loading，然后 showDesktopWindowsAndCommit 失败回滚到 chat
      const result = await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('ok');
      expect(result.mode).toBe('loading');

      // 等待回滚完成（loading → chat）
      const rolled = await waitForMode(page, 'chat', 5000);
      expect(rolled).toBe(true);

      // Chat 仍可见（事务失败回滚）
      const visibilities = await getWindowVisibilities(page);
      const chatWin = visibilities.find(v => v.type === 'chat');
      expect(chatWin?.visible).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
