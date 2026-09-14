import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EVIDENCE_DIR = resolve(__dirname, '..', '..', 'docs', 'evidence');

/**
 * Phase 3 Step 5：Physics unavailable UI + E2E
 *
 * 验证产品状态正确：
 * 1. Avatar UI 中显示"物理：不可用"文本（用户可见）
 * 2. 物理开关禁用，点击后保持关闭
 * 3. API setPhysicsEnabled(true) 返回 false
 * 4. isPhysicsAvailable() 返回 false
 * 5. 尝试开启后模型仍然显示，Canvas 健康检查继续通过
 * 6. 文档保持 real physics = untested/unavailable，不得写成真实物理完成
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

test.describe('ChatX2 Physics Unavailable UI（Phase 3 Step 5）', () => {
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

  test('Step 5: Physics unavailable UI 显示且 API 返回 false', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(2000);

      // 找到 Avatar 窗口
      let avatarWindow: Page | null = null;
      for (const w of app.windows()) {
        const title = await Promise.race([
          w.title().catch(() => ''),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
        ]);
        if (title.includes('Avatar')) { avatarWindow = w; break; }
      }
      expect(avatarWindow).not.toBeNull();

      // 1. 验证 isPhysicsAvailable() 返回 false
      const isAvailable = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.cameraControl?.isPhysicsAvailable?.() ?? null
      );
      expect(isAvailable, 'isPhysicsAvailable() should return false').toBe(false);

      // 2. 验证 setPhysicsEnabled(true) 返回 false（拒绝开启）
      const setEnabledResult = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.cameraControl?.setPhysicsEnabled?.(true) ?? null
      );
      expect(setEnabledResult, 'setPhysicsEnabled(true) should return false').toBe(false);

      // 3. 验证 UI 中显示"物理：不可用"或"Physics: Unavailable"文本
      //    检查多个可能的文本（中英文都接受）
      const physicsUiText = await avatarWindow!.evaluate(() => {
        // 查找所有可能包含物理状态文本的元素
        const candidates = [
          document.getElementById('physics-status'),
          document.getElementById('physics-label'),
          document.querySelector('[data-physics-status]'),
          document.querySelector('.physics-status'),
          document.querySelector('.mp-physics-status'),
        ].filter(Boolean);

        const texts: string[] = [];
        for (const el of candidates) {
          if (el && el.textContent) texts.push(el.textContent.trim());
        }

        // 也扫描 morph-panel 内所有文本
        const panel = document.getElementById('morph-panel');
        if (panel) {
          const allText = panel.textContent ?? '';
          if (allText.includes('物理') || allText.includes('Physics') || allText.includes('不可用') || allText.includes('Unavailable')) {
            texts.push(allText);
          }
        }

        // 也扫描 status-label
        const statusLabel = document.getElementById('status-label');
        if (statusLabel && statusLabel.textContent) {
          texts.push(`status-label: ${statusLabel.textContent}`);
        }

        return {
          found: texts.length > 0,
          texts,
          hasPhysicsUnavailable:
            texts.some(t => t.includes('物理') && (t.includes('不可用') || t.includes('未启用') || t.includes('未接入'))) ||
            texts.some(t => t.includes('Physics') && (t.includes('Unavailable') || t.includes('Disabled') || t.includes('Off')))
        };
      });

      expect(
        physicsUiText.hasPhysicsUnavailable,
        `UI must show "物理：不可用" or "Physics: Unavailable" text. Found texts: ${JSON.stringify(physicsUiText.texts)}`
      ).toBe(true);

      // 4. 验证物理开关按钮存在且禁用
      const physicsButtonState = await avatarWindow!.evaluate(() => {
        // 查找物理开关按钮
        const btn = document.getElementById('physics-toggle') as HTMLButtonElement | null;
        if (!btn) {
          // 也查找 morph-panel 内的可能按钮
          const panel = document.getElementById('morph-panel');
          const panelBtn = panel?.querySelector('button[data-physics]') as HTMLButtonElement | null;
          if (panelBtn) {
            return { found: true, disabled: panelBtn.disabled, text: panelBtn.textContent };
          }
          return { found: false, disabled: null, text: null };
        }
        return { found: true, disabled: btn.disabled, text: btn.textContent };
      });

      // 开关按钮必须存在
      expect(physicsButtonState.found, 'Physics toggle button must exist in UI').toBe(true);
      // 开关必须禁用（不可点击开启）
      expect(physicsButtonState.disabled, 'Physics toggle button must be disabled').toBe(true);

      // 5. 验证尝试开启后模型仍然显示（Canvas 健康检查继续通过）
      const canvasHealth = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        if (!canvas) return { ok: false, reason: 'no canvas' };
        const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext;
        if (!gl) return { ok: false, reason: 'no gl context' };
        const w = canvas.width, h = canvas.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // 健康检查：非全透明、非全黑
        let nonZero = 0;
        let nonOpaque = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] > 0) nonZero++;
          if (px[i + 3] < 255) nonOpaque++;
        }
        return {
          ok: nonZero > 100 && nonOpaque > 100,
          nonZeroPixels: nonZero,
          nonOpaquePixels: nonOpaque,
          canvasW: w,
          canvasH: h
        };
      });
      expect(canvasHealth.ok, `Canvas health check failed after attempting to enable physics: ${JSON.stringify(canvasHealth)}`).toBe(true);

      // 保存证据截图
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await avatarWindow!.screenshot({ path: join(EVIDENCE_DIR, 'phase-3-physics-unavailable-ui.png') });

      console.log('[physics-test] isAvailable:', isAvailable, 'setEnabled:', setEnabledResult, 'uiTexts:', physicsUiText.texts, 'canvasHealth:', canvasHealth);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
