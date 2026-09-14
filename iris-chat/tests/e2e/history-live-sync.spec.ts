import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P1 回归测试：桌面模式 composer 提交后，Chat 窗口 DOM 必须实时同步（不切回 chat）。
// 此前仅 conversationHistory() API 有覆盖；本测试直接断言 Chat 窗口 #messages 的 DOM。

async function launchApp(): Promise<{ app: ElectronApplication; chatPage: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'test' }
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
      if (title.startsWith('伊利斯 ChatX2')) { chatPage = w; break; }
    }
    if (chatPage) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!chatPage) throw new Error('Chat window not found');
  await chatPage.waitForLoadState('domcontentloaded');
  const identity = await chatPage.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, chatPage, userDataDir: identity.userDataDir };
}

async function closeAppAndCleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    await new Promise(r => setTimeout(r, 1000));
    for (let i = 0; i < 15; i++) {
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      if (!existsSync(userDataDir)) { await new Promise(r => setTimeout(r, 200)); if (!existsSync(userDataDir)) break; }
      else await new Promise(r => setTimeout(r, 300));
    }
    expect(existsSync(userDataDir)).toBe(false);
  }
}

async function findWindowByTitle(app: ElectronApplication, include: string): Promise<Page | null> {
  for (const w of app.windows()) {
    const title = await w.title().catch(() => '');
    if (title.includes(include)) return w;
  }
  return null;
}

async function domHasText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t) => {
    const el = document.getElementById('messages');
    return !!el && el.textContent?.includes(t);
  }, text);
}

test.describe('P1: 桌面对话实时同步到 Chat 窗口 DOM', () => {
  test.afterAll(async () => {
    const tmp = tmpdir();
    let entries: string[] = [];
    try { entries = readdirSync(tmp).filter(name => name.startsWith('chat6-test-')); } catch { return; }
    for (const name of entries) {
      const dir = join(tmp, name);
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        if (!existsSync(dir)) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
  });

  test('chat 提交 → chat DOM 实时出现', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      const result = await chatPage.evaluate((text) => (window as any).chatx2.conversationSubmit(text), 'chat-live-msg');
      expect(result.accepted).toBe(true);
      const ok = await chatPage.waitForFunction(() => {
        const el = document.getElementById('messages');
        return !!el && el.textContent?.includes('chat-live-msg');
      }, undefined, { timeout: 5000 });
      expect(ok).toBeTruthy();
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('desktop composer 提交 → Chat 窗口 DOM 实时同步（不切回 chat）', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 进入 desktop 模式
      await chatPage.evaluate(() => (window as any).chatx2.testInjectReady());
      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await new Promise(r => setTimeout(r, 2000));

      // 记录 Chat 窗口 DOM 的初始消息数
      const before = await chatPage.evaluate(() => {
        const el = document.getElementById('messages');
        return el ? el.children.length : -1;
      });

      // Composer 提交（source='desktop'，模拟桌宠对话框语音转写后回车）
      const composerPage = await findWindowByTitle(app, 'Composer');
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      const result = await composerPage!.evaluate((text) => (window as any).chatx2.conversationSubmit(text), 'desktop-live-sync-msg');
      expect(result.accepted).toBe(true);

      // 关键断言：STILL in desktop mode，Chat 窗口 DOM 必须实时出现该消息
      const appeared = await chatPage.waitForFunction((prev) => {
        const el = document.getElementById('messages');
        return !!el && el.textContent?.includes('desktop-live-sync-msg');
      }, before, { timeout: 6000 }).then(() => true).catch(() => false);

      if (!appeared) {
        // 打印广播日志（main 进程 stdout）便于诊断
        const logs = await app.evaluate(async ({ }) => {
          return globalThis;
        }).catch(() => null);
        console.log('[P1-debug] chat DOM did NOT receive desktop message live');
        const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
        console.log('[P1-debug] history has messages:', history.messages.length, history.messages.map((m: any) => `${m.role}:${m.text}`));
        const chatDom = await chatPage.evaluate(() => document.getElementById('messages')?.textContent ?? '(empty)');
        console.log('[P1-debug] chat DOM text:', chatDom.slice(0, 300));
      }

      expect(appeared).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
