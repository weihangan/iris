import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

let electronApp: ElectronApplication;
let page: Page;

test.describe('ChatX2 Electron 启动和身份', () => {
  test.beforeAll(async () => {
    const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
    electronApp = await _electron.launch({
      args: [mainPath],
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await electronApp?.close();
  });

  test('窗口标题包含 ChatX2', async () => {
    const title = await page.title();
    expect(title).toContain('ChatX2');
  });

  test('appId 为 com.wha1999.chatx2.selena（非 Chat5/Chat6）', async () => {
    const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
    expect(identity.appId).toBe('com.wha1999.chatx2.selena');
    expect(identity.appId).not.toBe('com.wha1999.chat5.universal');
    expect(identity.appId).not.toBe('com.wha1999.chat6.selena');
    expect(identity.isChat5).toBe(false);
  });

  test('测试模式使用临时 userData，不污染真实 ChatX2Selena 目录', async () => {
    const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
    // 测试模式必须为 true
    expect(identity.isTest).toBe(true);
    // 临时目录必须位于 os.tmpdir() 下，且带 chatx2-test- 前缀
    expect(identity.userDataDir).toContain('chatx2-test-');
    expect(identity.userDataDir.startsWith(tmpdir())).toBe(true);
    // 不得指向真实生产路径 %APPDATA%\wha1999\ChatX2Selena
    expect(identity.userDataDir).not.toContain(join('wha1999', 'ChatX2Selena'));
  });

  test('Express 端口为 3003（非 3002/3001）', async () => {
    const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
    expect(identity.expressPort).toBe(3003);
    expect(identity.expressPort).not.toBe(3002);
    expect(identity.expressPort).not.toBe(3001);
  });

  test('TTS 端口为 9882（非 9880/9881）', async () => {
    const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
    expect(identity.ttsPort).toBe(9882);
    expect(identity.ttsPort).not.toBe(9880);
    expect(identity.ttsPort).not.toBe(9881);
  });

  test('version 为 2.0.0', async () => {
    const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
    expect(identity.version).toBe('2.0.0');
  });
});
