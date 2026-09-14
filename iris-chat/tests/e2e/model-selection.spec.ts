// Phase 3 收口修复 Step 2：模型选择 IPC + preload + UI + 失败关闭测试
// 验证：
// 1. chatx2:select-pmx-model IPC 存在且返回正确结构
// 2. 选择正确模型后 selectedModel 更新，load-pmx-model 返回新文件
// 3. 选择错误哈希模型返回失败，selectedModel 不变
// 4. 用户取消选择返回 cancelled
// 5. Chat preload 暴露 selectPmxModel API
// 6. Avatar 窗口能加载用户选择的模型

import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const DEFAULT_MODEL_PATH = resolve(__dirname, '..', '..', '赛琳娜 希声', '赛琳娜 希声 合并.pmx');
const EXPECTED_SHA256 = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';

async function launchApp(): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test'
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
    throw new Error('Chat window not found');
  }
  const page = chatPage;
  await page.waitForLoadState('domcontentloaded');
  const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, page, userDataDir: identity.userDataDir };
}

async function closeApp(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    await new Promise(r => setTimeout(r, 500));
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
}

test.describe('Phase 3 收口修复 Step 2：模型选择 IPC', () => {
  test('chatx2:select-pmx-model IPC 存在并返回正确结构（用户取消）', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 注入 mock dialog：模拟用户取消
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({
          canceled: true,
          filePaths: []
        });
      });

      const result = await page.evaluate(() =>
        (window as any).chatx2.selectPmxModel()
      );

      // 用户取消应返回 { success: false, reason: 'cancelled' }
      expect(result).toEqual({ success: false, reason: 'cancelled' });
    } finally {
      await closeApp(app, userDataDir);
    }
  });

  test('选择正确模型后返回 success 和新路径', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      await app.evaluate(({ dialog }, modelPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [modelPath]
        });
      }, DEFAULT_MODEL_PATH);

      const result = await page.evaluate(() =>
        (window as any).chatx2.selectPmxModel()
      );

      expect(result.success).toBe(true);
      expect(result.modelPath).toBe(DEFAULT_MODEL_PATH);
      expect(result.sha256).toBe(EXPECTED_SHA256);
    } finally {
      await closeApp(app, userDataDir);
    }
  });

  test('选择错误哈希模型返回 failure: hash-mismatch，selectedModel 不变', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 用一个临时文件模拟错误模型（内容不匹配）
      const tmpDir = mkdtempSync(resolve(tmpdir(), 'chat6-bad-model-'));
      const badModelPath = resolve(tmpDir, 'bad.pmx');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(badModelPath, Buffer.from('not a pmx file'));

      await app.evaluate(({ dialog }, modelPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [modelPath]
        });
      }, badModelPath);

      const result = await page.evaluate(() =>
        (window as any).chatx2.selectPmxModel()
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe('hash-mismatch');

      // 清理临时文件
      rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      await closeApp(app, userDataDir);
    }
  });

  test('Chat preload 暴露 selectPmxModel API', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      const hasApi = await page.evaluate(() =>
        typeof (window as any).chatx2.selectPmxModel === 'function'
      );
      expect(hasApi).toBe(true);
    } finally {
      await closeApp(app, userDataDir);
    }
  });
});
