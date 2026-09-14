import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('voice-action metadata remains editable across save, refresh and the next action', async ({ page }) => {
  const sourceHtml = readFileSync(resolve('chat5-compat/public/index.html'), 'utf8');
  const sourceApp = readFileSync(resolve('chat5-compat/public/app.js'), 'utf8');
  await page.route('http://127.0.0.1:3013/', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: sourceHtml
  }));
  await page.route('http://127.0.0.1:3013/app.js', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body: sourceApp
  }));
  await page.addInitScript(() => {
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    (globalThis as any).__releaseHistory = releaseHistory;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/history')) {
        await historyGate;
        return new Response(JSON.stringify({ success: true, history: [] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      return nativeFetch(input, init);
    };
    const api = {
      transition: async () => ({ status: 'ok' }),
      onModeChange: () => () => {},
      onModelPackChanged: () => () => {},
      onMotionConfigChanged: () => () => {},
      listVoiceActions: async () => ({ success: true, entries: [], grouped: {} }),
      addVoiceAction: async () => ({ success: true }),
      updateVoiceAction: async () => ({ success: true }),
      listVmdWithInfo: async () => ({
        success: true,
        items: [{
          path: '../shared/motions/editor-focus.vmd', displayName: '编辑器焦点测试',
          duration: 2, category: 'short', available: true
        }, {
          path: '../shared/motions/editor-focus-next.vmd', displayName: '第二个编辑器焦点测试',
          duration: 2.2, category: 'short', available: true
        }],
        idleVmdPool: [],
        defaultIdle: ''
      }),
      listModelPacks: async () => ({
        success: true,
        packs: [{ packId: 'selena-xisheng-v1', displayName: '赛琳娜', isBuiltIn: true }]
      }),
      getCurrentModelPack: async () => ({
        success: true,
        packId: 'selena-xisheng-v1',
        displayName: '赛琳娜',
        capabilities: []
      })
    };
    (globalThis as any).chatx2 = new Proxy(api, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return async () => ({ success: true, entries: [], presets: [], packs: [], items: [] });
      }
    });
  });

  await page.goto('http://127.0.0.1:3013/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-chatx2-model').click();
  await page.locator('.chatx2-vmd-voice').first().click();

  const gesture = page.locator('#chatx2-voice-gesture');
  const intent = page.locator('#chatx2-voice-intent');
  const description = page.locator('#chatx2-voice-desc');
  await expect(gesture).toBeEditable();
  await expect(gesture).toBeFocused();
  await gesture.pressSequentially('wave测试');
  await intent.fill('greeting问候');
  await description.fill('动作描述可以输入');

  await page.evaluate(() => (globalThis as any).__releaseHistory());
  await page.waitForTimeout(500);

  await expect(description).toBeFocused();
  await expect(gesture).toHaveValue('wave测试');
  await expect(intent).toHaveValue('greeting问候');
  await expect(description).toHaveValue('动作描述可以输入');

  await page.locator('#chatx2-voice-save').click();
  await expect(page.locator('#chatx2-voice-editor-overlay')).toHaveCount(0);
  await expect(page.locator('.chatx2-vmd-voice')).toHaveCount(2);
  await page.locator('.chatx2-vmd-voice').nth(1).click();
  const nextGesture = page.locator('#chatx2-voice-gesture');
  await expect(nextGesture).toBeFocused();
  await nextGesture.pressSequentially('second第二次输入');
  await page.waitForTimeout(500);
  await expect(nextGesture).toBeFocused();
  await expect(nextGesture).toHaveValue('second第二次输入');
});
