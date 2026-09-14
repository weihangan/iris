import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Phase 4 Task 7: 真实 Electron E2E 测试
// 验证唯一 ConversationController：
// 1. Chat 提交后 Desktop Composer 读取相同历史
// 2. Desktop Composer 提交后返回 Chat 可看到完整记录
// 3. 历史顺序：user1 / mock1 / user2 / mock2
// 4. Mock 标注清楚（conversationIsMock=true，消息 isMock=true）
// 5. 取消后迟到的 AI 回复不得写入历史
// 6. Scene 仍不可进入
// 7. 未启动 Chat5/TTS（isChat5=false）

/**
 * 启动 Electron 应用并返回 Chat 窗口 page
 */
async function launchApp(): Promise<{ app: ElectronApplication; chatPage: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });
  // 等待所有 3 个窗口都创建完成
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (app.windows().length >= 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  // 通过标题找到 Chat 窗口
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
  await chatPage.waitForLoadState('domcontentloaded');
  const identity = await chatPage.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, chatPage, userDataDir: identity.userDataDir };
}

/**
 * 关闭应用并清理临时 userData
 */
async function closeAppAndCleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    await new Promise(r => setTimeout(r, 1000));
    for (let i = 0; i < 15; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
      if (!existsSync(userDataDir)) {
        await new Promise(r => setTimeout(r, 200));
        if (!existsSync(userDataDir)) break;
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    expect(existsSync(userDataDir)).toBe(false);
  }
}

/**
 * 找到 Composer 窗口
 */
async function findComposerWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const title = await w.title().catch(() => '');
    if (title.includes('Composer')) {
      return w;
    }
  }
  return null;
}

async function findAvatarWindow(app: ElectronApplication): Promise<Page | null> {
  for (const window of app.windows()) {
    const title = await window.title().catch(() => '');
    if (title.includes('Avatar')) {
      return window;
    }
  }
  return null;
}

/**
 * 等待历史中出现指定数量的消息
 */
async function waitForMessageCount(page: Page, count: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const history = await page.evaluate(() => (window as any).chatx2.conversationHistory());
    if (history.messages.length >= count) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

test.describe('Phase 4: 唯一 ConversationController（Chat/Desktop 共享历史）', () => {
  test.afterAll(async () => {
    // 兜底清理
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

  test('身份信息标识 Mock 对话后端，未启动 Chat5/TTS', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      const identity = await chatPage.evaluate(() => (window as any).chatx2.getIdentity());
      // Phase 4 门禁：Mock 标注清楚
      expect(identity.conversationIsMock).toBe(true);
      // 未启动 Chat5/TTS
      expect(identity.isChat5).toBe(false);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Chat 提交后历史出现 user + mock assistant 消息', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // Chat 提交
      const result = await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第一条');
      expect(result.accepted).toBe(true);

      // 等待 Mock 回复（300ms 延迟）
      const ok = await waitForMessageCount(chatPage, 2, 5000);
      expect(ok).toBe(true);

      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      expect(history.messages.length).toBe(2);
      expect(history.messages[0].role).toBe('user');
      expect(history.messages[0].text).toBe('第一条');
      expect(history.messages[0].source).toBe('chat');
      expect(history.messages[1].role).toBe('assistant');
      // Phase 4 门禁：Mock 标注清楚
      expect(history.messages[1].isMock).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Chat→Desktop→Composer→Chat 历史顺序为 user1/mock1/user2/mock2', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 1. Chat 提交"第一条"
      await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第一条');
      await waitForMessageCount(chatPage, 2, 5000);

      // 2. 切到 Desktop（需要 test-only-ready 证据）
      await chatPage.evaluate(() => (window as any).chatx2.testInjectReady());
      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      // 等待 Composer 窗口可见
      await new Promise(r => setTimeout(r, 2000));

      // 3. Composer 提交"第二条"
      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const result2 = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第二条');
      expect(result2.accepted).toBe(true);

      // 等待 Mock 回复
      await waitForMessageCount(composerPage!, 4, 5000);

      // 4. 返回 Chat（Composer 也能触发返回？不，只有 Chat 能 transition）
      // 通过 Chat 窗口切回 chat 模式
      await chatPage.evaluate(() => (window as any).chatx2.transition('chat'));
      await new Promise(r => setTimeout(r, 1500));

      // 5. Chat 读取历史，顺序应为 user1/mock1/user2/mock2
      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      expect(history.messages.length).toBe(4);

      // 验证顺序
      expect(history.messages[0].role).toBe('user');
      expect(history.messages[0].text).toBe('第一条');
      expect(history.messages[0].source).toBe('chat');

      expect(history.messages[1].role).toBe('assistant');
      expect(history.messages[1].isMock).toBe(true);

      expect(history.messages[2].role).toBe('user');
      expect(history.messages[2].text).toBe('第二条');
      expect(history.messages[2].source).toBe('desktop');

      expect(history.messages[3].role).toBe('assistant');
      expect(history.messages[3].isMock).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('单活动任务：pending 时新提交被拒绝', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 第一次提交（pending，Mock 300ms 延迟）
      const r1 = await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第一条');
      expect(r1.accepted).toBe(true);

      // 立即第二次提交应被拒绝
      const r2 = await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第二条');
      expect(r2.accepted).toBe(false);
      expect(r2.reason).toBe('busy');

      // 等待第一次完成
      await waitForMessageCount(chatPage, 2, 5000);

      // 完成后可以再次提交
      const r3 = await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第三条');
      expect(r3.accepted).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('取消后迟到的 AI 回复不得写入历史', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 提交任务（Mock 300ms 延迟）
      await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '将被取消');

      // 立即取消
      const cancelResult = await chatPage.evaluate(() =>
        (window as any).chatx2.conversationCancel()
      );
      expect(cancelResult.cancelled).toBe(true);

      // 等待 Mock 延迟结束（即使迟到也不应写入 assistant）
      await new Promise(r => setTimeout(r, 600));

      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      // 期望：只有 user 消息 + system 取消消息，无 assistant 消息
      expect(history.messages.length).toBe(2);
      expect(history.messages[0].role).toBe('user');
      expect(history.messages[0].text).toBe('将被取消');
      expect(history.messages[1].role).toBe('system');
      expect(history.messages[1].text).toBe('已取消');

      // 关键：无 assistant 消息
      const assistantMsgs = history.messages.filter((m: any) => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(0);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('不产生重复消息（ID 全局唯一）', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 两次提交
      await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第一条');
      await waitForMessageCount(chatPage, 2, 5000);

      await chatPage.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '第二条');
      await waitForMessageCount(chatPage, 4, 5000);

      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      const ids = history.messages.map((m: any) => m.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size); // 无重复
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Scene 仍不可进入', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      const result = await chatPage.evaluate(() =>
        (window as any).chatx2.transition('scene')
      );
      // Phase 4 门禁：Scene 仍不可进入
      expect(result.status).toBe('unavailable');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('拒绝 renderer 伪造 source 或提交对象载荷', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      await expect(chatPage.evaluate(() =>
        (window as any).chatx2.conversationSubmit({ text: '伪造桌面来源', source: 'desktop' })
      )).rejects.toThrow();

      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      expect(history.messages).toHaveLength(0);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Avatar 崩溃回退 Chat 后保留 Chat/Desktop 完整历史', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      await chatPage.evaluate((text) => (window as any).chatx2.conversationSubmit(text), '崩溃前聊天');
      expect(await waitForMessageCount(chatPage, 2)).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.testInjectReady());
      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await chatPage.waitForTimeout(1000);

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.evaluate((text) => (window as any).chatx2.conversationSubmit(text), '桌面期间聊天');
      expect(await waitForMessageCount(composerPage!, 4)).toBe(true);

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.close();

      await expect.poll(async () => {
        const windows = await chatPage.evaluate(() => (window as any).chatx2.getWindowsVisibility());
        return windows.find((entry: { type: string }) => entry.type === 'chat')?.visible ?? false;
      }).toBe(true);

      const history = await chatPage.evaluate(() => (window as any).chatx2.conversationHistory());
      expect(history.messages.map((message: { text: string }) => message.text)).toEqual([
        '崩溃前聊天',
        '收到：崩溃前聊天',
        '桌面期间聊天',
        '收到：桌面期间聊天'
      ]);
      expect(history.messages[0].source).toBe('chat');
      expect(history.messages[2].source).toBe('desktop');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Chat renderer 重载后从唯一快照恢复且不重复消息', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      await chatPage.fill('#input', '重载前消息');
      await chatPage.click('#send');
      expect(await waitForMessageCount(chatPage, 2)).toBe(true);

      await chatPage.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(async () => chatPage.locator('#messages [data-msg-id]').count()).toBe(2);

      const renderedIds = await chatPage.locator('#messages [data-msg-id]').evaluateAll(elements =>
        elements.map(element => element.getAttribute('data-msg-id'))
      );
      expect(new Set(renderedIds).size).toBe(2);
      expect(await chatPage.locator('#messages').textContent()).toContain('重载前消息');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Chat 窗口 UI 显示 MOCK 徽章', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 等待 renderer 初始化
      await new Promise(r => setTimeout(r, 500));

      // 检查 MOCK 徽章可见
      const mockBadgeVisible = await chatPage.evaluate(() => {
        const badge = document.getElementById('mock-badge');
        if (!badge) return false;
        return badge.style.display !== 'none' && badge.textContent !== '';
      });
      expect(mockBadgeVisible).toBe(true);

      // 检查徽章文本包含 MOCK
      const badgeText = await chatPage.evaluate(() => {
        const badge = document.getElementById('mock-badge');
        return badge?.textContent ?? '';
      });
      expect(badgeText).toContain('MOCK');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Chat 提交后 UI 显示 [MOCK] 前缀的 assistant 消息', async () => {
    const { app, chatPage, userDataDir } = await launchApp();
    try {
      // 等待 renderer 初始化
      await new Promise(r => setTimeout(r, 500));

      // 通过 UI 输入提交（模拟真实用户操作）
      await chatPage.fill('#input', '测试消息');
      await chatPage.click('#send');

      // 等待 Mock 回复渲染
      await new Promise(r => setTimeout(r, 600));

      // 检查 messages 区域有 [MOCK] 前缀的 assistant 消息
      const mockMessageText = await chatPage.locator('.msg.mock').textContent();
      expect(mockMessageText).toBe('[MOCK] 收到：测试消息');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
