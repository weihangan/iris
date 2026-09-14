import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EVIDENCE_DIR = resolve(__dirname, '..', '..', 'docs', 'evidence');

// Phase 3 Task 3.2 E2E 测试：真实 PMX 渲染和首帧检查
// 验证：
// 1. CHAT6_PMX_RENDER_IN_TEST=1 时渲染器加载真实 PMX 模型
// 2. 首帧成功后设置 pmx-first-frame 证据
// 3. transition(desktop) 成功（pmx-first-frame 是有效证据）
// 4. Avatar Canvas 非空（截图验证）
// 5. 模型文件不被修改（SHA-256 不变）
//
// 重要约束：
// - 模型只读，不得修改/转换/上传/分发
// - 截图失败必须让测试失败（无 try/catch 吞掉）
// - 测试进程负责清理临时 userData

/**
 * 启动 Electron 应用（启用真实 PMX 渲染）并返回 Chat 窗口 page
 */
async function launchAppWithPmxRender(): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // 启用真实 PMX 渲染（覆盖测试模式默认的 placeholder 行为）
      CHAT6_PMX_RENDER_IN_TEST: '1'
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
  const page = chatPage;
  await page.waitForLoadState('domcontentloaded');
  const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, page, userDataDir: identity.userDataDir };
}

/**
 * 关闭应用并清理临时 userData
 */
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

/**
 * 等待 pmx-first-frame 证据就绪（hasAvatarReady 返回 true）
 * 渲染器加载 PMX 并通过首帧检查后，主进程会设置 pmx-first-frame 证据
 */
async function waitForPmxFirstFrame(page: Page, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => (window as any).chatx2.hasAvatarReady());
    if (ready) return true;
    await page.waitForTimeout(200);
  }
  return false;
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
 * 获取所有窗口的可见性
 */
async function getWindowVisibilities(page: Page): Promise<Array<{ title: string; visible: boolean; type: string }>> {
  return page.evaluate(() => (window as any).chatx2.getWindowsVisibility());
}

/**
 * Phase 3 Integration Closure：鼻部 ROI 像素统计
 * 检查鼻部中央区域是否有黑色矩形（nearBlack）或白色贴片（brightNeutral）
 * - nearBlack：alpha > 200 且 R+G+B < 75（鼻部黑色模块）
 * - brightNeutral：alpha > 200 且 R+G+B > 500 且 RGB 极差 < 8（白色楔形）
 * - ROI：X 42%-58%，Y 38%-51%（face 镜头下鼻部中央）
 * - readPixels y 轴翻转：屏幕 yTop 对应 glY = height - 1 - yTop
 */
interface NoseRoiStats {
  width: number;
  height: number;
  nearBlack: number;
  brightNeutral: number;
  opaque: number;
  ratio: number;
  brightNeutralRatio: number;
}

async function readNoseRoi(page: Page): Promise<NoseRoiStats | null> {
  return page.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;

    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const xStart = Math.floor(width * 0.42);
    const xEnd = Math.ceil(width * 0.58);
    const yTopStart = Math.floor(height * 0.38);
    const yTopEnd = Math.ceil(height * 0.51);
    let opaque = 0;
    let nearBlack = 0;
    let brightNeutral = 0;

    for (let yTop = yTopStart; yTop < yTopEnd; yTop++) {
      const glY = height - 1 - yTop;
      for (let x = xStart; x < xEnd; x++) {
        const offset = (glY * width + x) * 4;
        const alpha = pixels[offset + 3];
        if (alpha <= 200) continue;
        opaque++;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const rgbSum = red + green + blue;
        if (rgbSum < 75) {
          nearBlack++;
        }
        if (rgbSum > 500 && Math.max(red, green, blue) - Math.min(red, green, blue) < 8) {
          brightNeutral++;
        }
      }
    }

    return {
      width,
      height,
      nearBlack,
      brightNeutral,
      opaque,
      ratio: opaque > 0 ? nearBlack / opaque : 1,
      brightNeutralRatio: opaque > 0 ? brightNeutral / opaque : 1
    };
  });
}

test.describe('ChatX2 PMX 真实渲染（Phase 3 Task 3.2）', () => {
  // afterAll 兜底清理
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

  test('真实 PMX 加载并渲染首帧，设置 pmx-first-frame 证据', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      // 验证测试模式启用了 PMX 渲染
      const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
      expect(identity.isTest).toBe(true);
      expect(identity.pmxRenderInTest).toBe(true);

      // 等待 PMX 加载并渲染首帧（设置 pmx-first-frame 证据）
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      // 证据应该是 pmx-first-frame（不是 placeholder-canvas）
      // 通过 transition(desktop) 验证证据有效（placeholder-canvas 无法授权）
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

      // 安全门禁：Avatar/Composer 可见后才隐藏 Chat
      expect(avatarWin?.visible).toBe(true);
      expect(composerWin?.visible).toBe(true);
      expect(chatWin?.visible).toBe(false);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Avatar Canvas 非空截图（PMX 真实渲染证据）', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      // 等待 PMX 首帧
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      // 切换到 desktop
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(1000);

      // 找到 Avatar 窗口并截图
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      let screenshotTaken = false;
      const windows = app.windows();
      for (const w of windows) {
        const title = await Promise.race([
          w.title().catch(() => ''),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
        ]);
        if (title.includes('Avatar')) {
          await w.screenshot({ path: join(EVIDENCE_DIR, 'phase-3-pmx-first-frame.png') });
          screenshotTaken = true;
          break;
        }
      }
      // 截图失败必须让测试失败（不吞掉）
      expect(screenshotTaken).toBe(true);

      // 验证截图文件存在且非空
      const screenshotPath = join(EVIDENCE_DIR, 'phase-3-pmx-first-frame.png');
      expect(existsSync(screenshotPath)).toBe(true);
      const { statSync } = await import('node:fs');
      const stats = statSync(screenshotPath);
      // 截图文件应大于 1KB（非空占位）
      expect(stats.size).toBeGreaterThan(1024);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('Task 3.3 Step 9: 固定视角截图（正面/侧面/全身/面部）', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      // 等待 PMX 首帧
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      // 切换到 desktop
      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(1500);  // 等待窗口编排和纹理加载完成

      // 找到 Avatar 窗口
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      let avatarWindow: Page | null = null;
      const windows = app.windows();
      for (const w of windows) {
        const title = await Promise.race([
          w.title().catch(() => ''),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
        ]);
        if (title.includes('Avatar')) {
          avatarWindow = w;
          break;
        }
      }
      expect(avatarWindow).not.toBeNull();

      // Phase 3 收口修复：截图前隐藏 Morph 面板，避免遮挡模型
      await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
      });

      // 验证 morph 面板确实被隐藏
      const panelHidden = await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        return panel ? panel.hidden : true;
      });
      expect(panelHidden).toBe(true);

      // 验证 cameraControl API 可用（通过 window.__chatx2Runtime，contextBridge 代理只读）
      const hasCameraControl = await avatarWindow!.evaluate(() =>
        !!((window as any).__chatx2Runtime?.cameraControl));
      expect(hasCameraControl).toBe(true);

      // 4 个固定视角截图
      const angles: Array<{ angle: string; file: string }> = [
        { angle: 'front', file: 'phase-3-avatar-front.png' },
        { angle: 'side',  file: 'phase-3-avatar-side.png' },
        { angle: 'full',  file: 'phase-3-avatar-full.png' },
        { angle: 'face',  file: 'phase-3-avatar-face.png' },
      ];

      for (const { angle, file } of angles) {
        // 设置相机视角
        const ok = await avatarWindow!.evaluate(
          (a) => (window as any).__chatx2Runtime.cameraControl.setAngle(a),
          angle
        );
        expect(ok).toBe(true);
        // 等待渲染完成
        await avatarWindow!.waitForTimeout(300);
        // 截图
        const screenshotPath = join(EVIDENCE_DIR, file);
        await avatarWindow!.screenshot({ path: screenshotPath });
        // 验证文件存在且非空（> 1KB）
        expect(existsSync(screenshotPath)).toBe(true);
        const { statSync } = await import('node:fs');
        const stats = statSync(screenshotPath);
        expect(stats.size).toBeGreaterThan(1024);
      }

      // Phase 3 收口修复：full 镜头边界断言
      // 重新切到 full 镜头（循环结束后相机停在 face，需要重置）
      const fullOk = await avatarWindow!.evaluate(
        () => (window as any).__chatx2Runtime.cameraControl.setAngle('full')
      );
      expect(fullOk).toBe(true);
      await avatarWindow!.waitForTimeout(300);

      // 验证 full 镜头下模型头顶、脚底、左右边界都在画面内
      const fullBounds = await avatarWindow!.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        const camera = runtime?.cameraControl;
        if (!camera) return null;
        // 通过 canvas 像素分析验证模型边界
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        if (!canvas) return null;
        const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!ctx) return null;
        const w = canvas.width;
        const h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
        // 找到非透明像素的边界（alpha > 10，过滤抗锯齿噪声）
        let minX = w, maxX = 0, minY = h, maxY = 0;
        let foundPixel = false;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4 + 3; // alpha
            if (pixels[idx] > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              foundPixel = true;
            }
          }
        }
        return foundPixel ? {
          minX, maxX, minY, maxY,
          canvasW: w, canvasH: h,
          marginX: { left: minX, right: w - 1 - maxX },
          marginY: { top: minY, bottom: h - 1 - maxY }
        } : null;
      });
      expect(fullBounds).not.toBeNull();
      console.log('[full-bounds]', JSON.stringify(fullBounds));
      // full 镜头应有四周边距（模型不贴边）
      expect(fullBounds!.marginX.left).toBeGreaterThan(0);
      expect(fullBounds!.marginX.right).toBeGreaterThan(0);
      expect(fullBounds!.marginY.top).toBeGreaterThan(0);
      expect(fullBounds!.marginY.bottom).toBeGreaterThan(0);

      // 截图后恢复 morph 面板显示（便于后续调试）
      await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = false;
      });
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('PMX 加载失败时回退到 placeholder-canvas（无 CHAT6_PMX_RENDER_IN_TEST）', async () => {
    // 不设置 CHAT6_PMX_RENDER_IN_TEST，渲染器应发送 placeholder-canvas（非 pmx-first-frame）
    const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
    const app = await _electron.launch({
      args: [mainPath],
      env: {
        ...process.env,
        NODE_ENV: 'test'
        // 不设置 CHAT6_PMX_RENDER_IN_TEST
      }
    });
    let userDataDir = '';
    try {
      // 等待窗口创建
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (app.windows().length >= 3) break;
        await new Promise(r => setTimeout(r, 100));
      }
      let chatPage: Page | null = null;
      while (Date.now() - start < 10000) {
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
      expect(chatPage).not.toBeNull();
      const page = chatPage!;
      await page.waitForLoadState('domcontentloaded');

      const identity = await page.evaluate(() => (window as any).chatx2.getIdentity());
      userDataDir = identity.userDataDir;
      expect(identity.isTest).toBe(true);
      expect(identity.pmxRenderInTest).toBe(false);

      // 等待 placeholder-canvas 证据（渲染器在测试模式发送 placeholder-canvas）
      await page.waitForTimeout(2000);

      // placeholder-canvas 证据存在，但 transition(desktop) 应失败（硬门）
      const result = await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('failure');
      expect(result.reason).toBe('no-avatar-ready');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  /**
   * TDD RED → GREEN: "A 口型后模型消失" 复现测试
   * Bug 根因：geometry.morphTargetsRelative 未设置为 true，导致 morph 偏移被当作绝对位置，
   * 设置 morph 权重后所有顶点塌缩到原点附近。
   * 验证方式：设置 A 口型 morph 后，读取 WebGL canvas 像素，计算非透明像素包围盒，
   * 断言包围盒面积不低于基线的 50%（模型不应塌缩到不可见）。
   */
  test('A 口型 morph 不导致模型塌缩（morphTargetsRelative 正确）', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    const avatarConsoleLogs: string[] = [];
    try {
      // 捕获 avatar 窗口的 console 消息（失败时输出，便于诊断）
      app.windows().forEach(w => {
        w.on('console', msg => {
          avatarConsoleLogs.push(`[${w.url().split('/').pop() || '?'}] ${msg.type()}: ${msg.text()}`);
        });
      });

      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(2000);  // 等待纹理加载完成

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

      // 验证 morphControl API 可用
      const hasMorphControl = await avatarWindow!.evaluate(() =>
        !!((window as any).__chatx2Runtime?.morphControl));
      expect(hasMorphControl).toBe(true);

      // 基线：读取 canvas 像素，计算非透明像素包围盒
      const baselineBBox = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (!gl) return null;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        (gl as WebGLRenderingContext).readPixels(0, 0, w, h, (gl as WebGLRenderingContext).RGBA, (gl as WebGLRenderingContext).UNSIGNED_BYTE, pixels);
        let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const alpha = pixels[(y * w + x) * 4 + 3];
            if (alpha > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              count++;
            }
          }
        }
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, count, canvasW: w, canvasH: h };
      });
      expect(baselineBBox).not.toBeNull();
      expect(baselineBBox!.count).toBeGreaterThan(100);  // 基线有可见内容

      // 设置 A 口型 morph 到 1.0（触发 bug 时模型会塌缩）
      const setOk = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime.morphControl.setWeight('あ', 1.0)
      );
      expect(setOk).toBe(true);
      await avatarWindow!.waitForTimeout(300);  // 等待重绘

      // 设置 morph 后：读取像素，计算包围盒
      const postMorphBBox = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (!gl) return null;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        (gl as WebGLRenderingContext).readPixels(0, 0, w, h, (gl as WebGLRenderingContext).RGBA, (gl as WebGLRenderingContext).UNSIGNED_BYTE, pixels);
        let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const alpha = pixels[(y * w + x) * 4 + 3];
            if (alpha > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              count++;
            }
          }
        }
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, count, canvasW: w, canvasH: h };
      });
      expect(postMorphBBox).not.toBeNull();

      // 核心断言：模型不应塌缩
      // 塌缩时非透明像素数会大幅下降（< 50% 基线）
      const ratio = postMorphBBox!.count / baselineBBox!.count;
      expect(ratio).toBeGreaterThanOrEqual(0.5);

      // 保存证据截图
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await avatarWindow!.screenshot({ path: join(EVIDENCE_DIR, 'phase-3-morph-a-viseme.png') });
    } finally {
      // 失败时打印 avatar 窗口的所有 console 日志（诊断用）
      if (avatarConsoleLogs.length > 0) {
        console.log('[TEST] === Avatar window console logs ===');
        for (const log of avatarConsoleLogs) {
          console.log(log);
        }
        console.log('[TEST] === End avatar console logs ===');
      } else {
        console.log('[TEST] No avatar console logs captured');
      }
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  /**
   * Bug 4 修复验证：ActorRuntime 通过 bindMorphSink 驱动屏幕 mesh
   * 验证：
   * 1. window.__chatx2Runtime.actorRuntime 存在（exposeActorRuntime 成功）
   * 2. actorRuntime.setEmotion('angry') 不抛错
   * 3. 调用后 actorRuntime.getState().emotion === 'angry'
   * 4. 调用后 mesh 的 morphTargetInfluences 有变化（怒り morph 权重 > 0）
   * 5. 模型不塌缩（像素包围盒 ratio >= 0.5）
   */
  test('Bug 4 修复：ActorRuntime.setEmotion 通过 MorphSink 驱动屏幕 mesh', async () => {
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

      // 1. 验证 actorRuntime API 存在
      const hasActorRuntime = await avatarWindow!.evaluate(() =>
        !!((window as any).__chatx2Runtime?.actorRuntime));
      expect(hasActorRuntime).toBe(true);

      // 1.5 隐藏 morph 面板，避免遮挡截图（Task 3）
      await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
      });

      // 2. 基线像素包围盒（默认镜头，用于塌缩检查）
      const baselineBBox = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (!gl) return null;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        (gl as WebGLRenderingContext).readPixels(0, 0, w, h, (gl as WebGLRenderingContext).RGBA, (gl as WebGLRenderingContext).UNSIGNED_BYTE, pixels);
        let count = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] > 10) count++;
        }
        return { count };
      });
      expect(baselineBBox).not.toBeNull();
      expect(baselineBBox!.count).toBeGreaterThan(100);

      // 3. 通过 ActorRuntime 设置情绪（驱动 mesh）
      const emotionResult = await avatarWindow!.evaluate(() => {
        const rt = (window as any).__chatx2Runtime?.actorRuntime;
        if (!rt) return { ok: false, error: 'no actorRuntime' };
        try {
          rt.setEmotion('angry');
          return { ok: true, state: rt.getState() };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      });
      expect(emotionResult.ok).toBe(true);
      expect(emotionResult.state?.emotion).toBe('angry');

      await avatarWindow!.waitForTimeout(300);  // 等待重绘

      // 4. Task 3：验证真实 mesh 的 morphTargetInfluences（不是 MorphController 内部状态）
      // 删除 MorphSink 后此断言必须失败，证明读的是真实 mesh
      const morphDriven = await avatarWindow!.evaluate(() => {
        const control = (window as any).__chatx2Runtime?.morphControl;
        if (!control) return { ok: false };
        return {
          ok: true,
          angryRendered: control.getRenderedWeight('怒り'),
          happyRendered: control.getRenderedWeight('笑い')
        };
      });
      expect(morphDriven.ok).toBe(true);
      expect(morphDriven.angryRendered).toBeGreaterThan(0);
      expect(morphDriven.happyRendered).toBe(0);

      // 5. 模型不塌缩（默认镜头，ratio ≥ 0.5）
      const postEmotionBBox = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (!gl) return null;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        (gl as WebGLRenderingContext).readPixels(0, 0, w, h, (gl as WebGLRenderingContext).RGBA, (gl as WebGLRenderingContext).UNSIGNED_BYTE, pixels);
        let count = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] > 10) count++;
        }
        return { count };
      });
      expect(postEmotionBBox).not.toBeNull();
      const ratio = postEmotionBBox!.count / baselineBBox!.count;
      expect(ratio).toBeGreaterThanOrEqual(0.5);

      // 6. Task 3：shy → angry 真实 Mesh 残留检查
      const shyAngryResult = await avatarWindow!.evaluate(() => {
        const rt = (window as any).__chatx2Runtime?.actorRuntime;
        const control = (window as any).__chatx2Runtime?.morphControl;
        if (!rt || !control) return { ok: false };
        rt.setEmotion('shy');
        const shyWeights = {
          shy: control.getRenderedWeight('照れ'),
          blush: control.getRenderedWeight('FaceRed')
        };
        rt.setEmotion('angry');
        const angryWeights = {
          shy: control.getRenderedWeight('照れ'),
          blush: control.getRenderedWeight('FaceRed'),
          angry: control.getRenderedWeight('怒り')
        };
        return { ok: true, shyWeights, angryWeights };
      });
      expect(shyAngryResult.ok).toBe(true);
      expect(shyAngryResult.shyWeights!.shy).toBe(1);
      expect(shyAngryResult.shyWeights!.blush).toBeCloseTo(0.15, 6);
      // Task 2 关键断言：切换到 angry 后照れ和 FaceRed 必须清零
      expect(shyAngryResult.angryWeights!.shy).toBe(0);
      expect(shyAngryResult.angryWeights!.blush).toBe(0);
      expect(shyAngryResult.angryWeights!.angry).toBe(1);

      // 7. 切换到面部视角，保存成对面部截图（Neutral + angry）
      mkdirSync(EVIDENCE_DIR, { recursive: true });

      // 先 reset 到 neutral
      await avatarWindow!.evaluate(() => {
        (window as any).__chatx2Runtime?.actorRuntime?.reset();
      });
      const faceOk1 = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.cameraControl?.setAngle('face') ?? false);
      expect(faceOk1).toBe(true);
      await avatarWindow!.waitForTimeout(300);
      await avatarWindow!.locator('#canvas').screenshot({
        path: join(EVIDENCE_DIR, 'phase-3-emotion-neutral-face.png')
      });

      // 再 setEmotion('angry') 保存 angry 面部截图
      await avatarWindow!.evaluate(() => {
        (window as any).__chatx2Runtime?.actorRuntime?.setEmotion('angry');
      });
      await avatarWindow!.waitForTimeout(300);
      await avatarWindow!.locator('#canvas').screenshot({
        path: join(EVIDENCE_DIR, 'phase-3-emotion-angry-face.png')
      });
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  /**
   * Phase 3 Integration Closure：鼻部中央无黑色矩形或白色贴片
   *
   * 验证鼻子修复（geometryAwareAlpha + applyMmdMaterialCompatibility）已整合进主线：
   * - nearBlack ratio < 0.05（鼻部中央无黑色模块，alpha 透明贴花正确识别）
   * - brightNeutral ratio < 0.02（鼻部中央无白色楔形，Face_2+ colorWrite=false 生效）
   * - 截图证据保存到 docs/evidence/nose-after-face.png
   */
  test('Integration Closure: 鼻部中央没有黑色矩形或白色贴片（face 镜头 WebGL ROI）', async () => {
    const { app, page, userDataDir } = await launchAppWithPmxRender();
    try {
      const pmxReady = await waitForPmxFirstFrame(page, 30000);
      expect(pmxReady).toBe(true);

      await page.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(page, 'desktop', 5000);
      await page.waitForTimeout(1500);

      let avatarWindow: Page | null = null;
      for (const w of app.windows()) {
        const title = await Promise.race([
          w.title().catch(() => ''),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 2000))
        ]);
        if (title.includes('Avatar')) {
          avatarWindow = w;
          break;
        }
      }
      expect(avatarWindow).not.toBeNull();

      await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
        (window as any).__chatx2Runtime?.actorRuntime?.reset();
      });
      const faceOk = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.cameraControl?.setAngle('face') ?? false);
      expect(faceOk).toBe(true);
      await avatarWindow!.waitForTimeout(500);

      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await avatarWindow!.locator('#canvas').screenshot({
        path: join(EVIDENCE_DIR, 'nose-after-face.png')
      });

      const noseRoi = await readNoseRoi(avatarWindow!);

      expect(noseRoi).not.toBeNull();
      expect(noseRoi!.opaque).toBeGreaterThan(0);
      console.log('[nose-roi]', JSON.stringify(noseRoi));
      expect(noseRoi!.ratio).toBeLessThan(0.05);
      expect(noseRoi!.brightNeutralRatio).toBeLessThan(0.02);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  /**
   * Phase 3 收口修复 Step 4.2：参数化验证全部 Morph
   *
   * 对每个 Morph 验证：
   * 1. reset 先清零所有语义 morph
   * 2. 设置目标 Morph（通过 morphControl.setWeight 或 actorRuntime.setEmotion）
   * 3. 用 getRenderedWeight() 读真实 mesh.morphTargetInfluences
   * 4. 验证其他互斥 Morph 没有残留
   * 5. 采集 neutral 噪声基线（两张连续帧）
   * 6. 目标 Morph 像素差必须显著高于 neutral 噪声
   * 7. 使用 ROI（眼部/嘴部/全脸）避免全身动作污染
   * 8. 失败时输出名称、真实权重、像素差和噪声基线
   */
  test.describe.configure({ mode: 'serial' });
  test('Step 4.2: 参数化验证全部 Morph（真实 Mesh 权重 + 像素差）', async () => {
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

      // 隐藏 morph 面板
      await avatarWindow!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
      });

      // 切到 face 镜头（面部 ROI 更敏感）
      const faceOk = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.cameraControl?.setAngle('face') ?? false);
      expect(faceOk).toBe(true);
      await avatarWindow!.waitForTimeout(500);

      // Phase 3 Step 6.1：暂停动画循环，避免生命层（眨眼/呼吸/头肩小动作）
      // 造成帧间像素差，导致噪声基线过高、Morph 像素差无法显著超过阈值。
      // 暂停后 canvas 保持静态，setWeight 仍通过 MorphSink 触发 render() 更新画面。
      const hasLoop = await avatarWindow!.evaluate(() =>
        !!((window as any).__chatx2Runtime?.avatarLoop));
      expect(hasLoop, 'avatarLoop API should be exposed').toBe(true);

      await avatarWindow!.evaluate(() => {
        (window as any).__chatx2Runtime?.avatarLoop?.stop();
      });
      await avatarWindow!.waitForTimeout(200);
      const loopStopped = await avatarWindow!.evaluate(() =>
        (window as any).__chatx2Runtime?.avatarLoop?.isRunning() === false);
      expect(loopStopped, 'animation loop must be stopped before pixel capture').toBe(true);

      // 定义所有目标 Morph
      const morphCases: Array<{
        name: string;
        morphName: string;
        weight: number;
        mutexGroup: string[];  // 互斥 morph 列表（应保持 0）
        roi: 'eyes' | 'mouth' | 'full';
        screenshotFile?: string;
      }> = [
        // 五口型
        { name: 'A (あ)', morphName: 'あ', weight: 1, mutexGroup: ['い', 'う', 'え', 'お'], roi: 'mouth', screenshotFile: 'phase-3-morph-a.png' },
        { name: 'I (い)', morphName: 'い', weight: 1, mutexGroup: ['あ', 'う', 'え', 'お'], roi: 'mouth', screenshotFile: 'phase-3-morph-i.png' },
        { name: 'U (う)', morphName: 'う', weight: 1, mutexGroup: ['あ', 'い', 'え', 'お'], roi: 'mouth', screenshotFile: 'phase-3-morph-u.png' },
        { name: 'E (え)', morphName: 'え', weight: 1, mutexGroup: ['あ', 'い', 'う', 'お'], roi: 'mouth', screenshotFile: 'phase-3-morph-e.png' },
        { name: 'O (お)', morphName: 'お', weight: 1, mutexGroup: ['あ', 'い', 'う', 'え'], roi: 'mouth', screenshotFile: 'phase-3-morph-o.png' },
        // 眨眼
        { name: 'blink (まばたき)', morphName: 'まばたき', weight: 1, mutexGroup: ['あ', 'い', 'う', 'え', 'お', '笑い', '怒り'], roi: 'eyes', screenshotFile: 'phase-3-morph-blink.png' },
        // 情绪
        { name: 'happy (笑い)', morphName: '笑い', weight: 1, mutexGroup: ['真面目', 'にこり', 'びっくり', '怒り', '困る', '照れ'], roi: 'full', screenshotFile: 'phase-3-morph-happy.png' },
        { name: 'concerned (困る)', morphName: '困る', weight: 1, mutexGroup: ['真面目', '笑い', 'にこり', 'びっくり', '怒り', '照れ'], roi: 'full', screenshotFile: 'phase-3-morph-concerned.png' },
        { name: 'serious (真面目)', morphName: '真面目', weight: 1, mutexGroup: ['笑い', 'にこり', 'びっくり', '怒り', '困る', '照れ'], roi: 'full', screenshotFile: 'phase-3-morph-serious.png' },
        { name: 'surprised (びっくり)', morphName: 'びっくり', weight: 1, mutexGroup: ['真面目', '笑い', 'にこり', '怒り', '困る', '照れ'], roi: 'full', screenshotFile: 'phase-3-morph-surprised.png' },
        // FaceRed（单独，不与其他互斥）
        { name: 'FaceRed', morphName: 'FaceRed', weight: 0.35, mutexGroup: [], roi: 'full', screenshotFile: 'phase-3-morph-facered.png' },
        // shy = 照れ + FaceRed 0.15
        { name: 'shy (照れ)', morphName: '照れ', weight: 1, mutexGroup: ['真面目', '笑い', 'にこり', 'びっくり', '怒り', '困る'], roi: 'full', screenshotFile: 'phase-3-morph-shy.png' },
      ];

      // 1. 采集 neutral 噪声基线：reset 后连续采集两帧，计算像素差
      // 暂停循环后 noise 应为 0（无生命层帧间变化）
      await avatarWindow!.evaluate(() => {
        (window as any).__chatx2Runtime?.actorRuntime?.reset();
        (window as any).__chatx2Runtime?.avatarLoop?.renderOneFrame();
      });
      await avatarWindow!.waitForTimeout(50);
      const noiseBaseline = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext;
        if (!gl) return null;
        const w = canvas.width, h = canvas.height;
        const readFrame = (): Uint8Array => {
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        const frame1 = readFrame();
        // 等待下一帧（生命层会更新）
        return new Promise<number | null>((resolve) => {
          setTimeout(() => {
            const frame2 = readFrame();
            let diff = 0;
            for (let i = 0; i < frame1.length; i += 4) {
              const dr = Math.abs(frame1[i] - frame2[i]);
              const dg = Math.abs(frame1[i + 1] - frame2[i + 1]);
              const db = Math.abs(frame1[i + 2] - frame2[i + 2]);
              if (dr + dg + db > 1) diff++;
            }
            resolve(diff);
          }, 100);  // 100ms 后采集第二帧
        });
      });
      expect(noiseBaseline).not.toBeNull();
      const noisePixels = noiseBaseline as number;
      console.log('[morph-test] neutral noise baseline (pixels changed between 2 frames):', noisePixels);

      // 2. 为每个 ROI 定义区域（face 镜头下，面部约占画面中间）
      // 重要：readPixels 的 y=0 在画布底部（OpenGL 坐标系），不是屏幕顶部。
      // 因此 "下 1/3"（嘴部）在 readPixels 中是 y 0.2-0.5，"上 1/3"（眼部）是 y 0.5-0.8。
      // 诊断数据证实：あ morph 变化集中在 readPixels y 0.4-0.5（即屏幕 50-60% 处，嘴部区域）。
      const roiRanges = {
        eyes: { yStart: 0.5, yEnd: 0.85 },   // readPixels 上半 = 屏幕上半 = 眼部
        mouth: { yStart: 0.2, yEnd: 0.55 },  // readPixels 下半 = 屏幕下半 = 嘴部
        full: { yStart: 0.0, yEnd: 1.0 }
      };

      // 3. 在浏览器内存储 neutral 基线帧（避免传输 3M 元素数组）
      // 后续每个 morph 的像素差都在浏览器内计算，只返回 diff 计数
      const baselineReady = await avatarWindow!.evaluate(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext;
        if (!gl) return false;
        const w = canvas.width, h = canvas.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        (window as any).__chat6NeutralBaseline = px;
        (window as any).__chat6CanvasSize = { w, h };
        return true;
      });
      expect(baselineReady, 'failed to capture neutral baseline').toBe(true);

      // 4. 参数化测试每个 Morph
      for (const tc of morphCases) {
        // 先 reset + 渲染一帧（恢复 neutral 基线画面）
        await avatarWindow!.evaluate(() => {
          (window as any).__chatx2Runtime?.actorRuntime?.reset();
          (window as any).__chatx2Runtime?.avatarLoop?.renderOneFrame();
        });
        await avatarWindow!.waitForTimeout(50);

        // Phase 3 Integration Closure 调查发现：canvas 可能因 Windows DPI 切换或
        // 窗口移动而在 morph 循环中被 resize（如 724x1080 → 483x720，DPI 1.5x 变化）。
        // 用旧尺寸 readPixels 会让超出当前 canvas 的区域返回透明像素，被误判为"模型消失"。
        // 修复：每次 morph 前检查 canvas 尺寸，如果与 baseline 不同则重新采集 baseline。
        const rebaselineResult = await avatarWindow!.evaluate(() => {
          const canvas = document.getElementById('canvas') as HTMLCanvasElement;
          const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext;
          if (!gl || !canvas) return { ok: false, error: 'no canvas/gl' };
          const storedSize = (window as any).__chat6CanvasSize as { w: number; h: number } | undefined;
          const currentW = canvas.width;
          const currentH = canvas.height;
          if (!storedSize || storedSize.w !== currentW || storedSize.h !== currentH) {
            // 尺寸变化（或首次）：重新采集 baseline
            // 重要：reset + renderOneFrame 已在前面完成，此时 canvas 是 neutral 帧
            const px = new Uint8Array(currentW * currentH * 4);
            gl.readPixels(0, 0, currentW, currentH, gl.RGBA, gl.UNSIGNED_BYTE, px);
            (window as any).__chat6NeutralBaseline = px;
            (window as any).__chat6CanvasSize = { w: currentW, h: currentH };
            return { ok: true, rebaselined: true, w: currentW, h: currentH,
              prevW: storedSize?.w, prevH: storedSize?.h };
          }
          return { ok: true, rebaselined: false, w: currentW, h: currentH };
        });
        if (rebaselineResult.rebaselined) {
          console.log(`[morph-test] ${tc.name}: canvas resized ${rebaselineResult.prevW}x${rebaselineResult.prevH} → ${rebaselineResult.w}x${rebaselineResult.h}, re-captured baseline`);
        }

        // 设置目标 Morph + 立即渲染（将 morph 权重应用到画布）
        const setResult = await avatarWindow!.evaluate((cfg) => {
          const control = (window as any).__chatx2Runtime?.morphControl;
          if (!control) return { ok: false, error: 'no morphControl' };
          try {
            const ok = control.setWeight(cfg.morphName, cfg.weight);
            // setWeight 后立即渲染，将新权重应用到画布
            (window as any).__chatx2Runtime?.avatarLoop?.renderOneFrame();
            return { ok, error: ok ? null : 'setWeight returned false' };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        }, { morphName: tc.morphName, weight: tc.weight });
        expect(setResult.ok, `setWeight(${tc.morphName}) failed: ${setResult.error}`).toBe(true);

        await avatarWindow!.waitForTimeout(50);

        // 验证真实 mesh 权重
        const weights = await avatarWindow!.evaluate((cfg) => {
          const control = (window as any).__chatx2Runtime?.morphControl;
          if (!control) return null;
          const target = control.getRenderedWeight(cfg.morphName);
          const mutex: Record<string, number> = {};
          for (const m of cfg.mutexGroup) {
            mutex[m] = control.getRenderedWeight(m);
          }
          return { target, mutex };
        }, { morphName: tc.morphName, mutexGroup: tc.mutexGroup });

        expect(weights, `[${tc.name}] failed to read weights`).not.toBeNull();
        // 真实 mesh 权重必须 > 0
        expect(
          weights!.target,
          `[${tc.name}] getRenderedWeight(${tc.morphName}) = ${weights!.target}, expected > 0`
        ).toBeGreaterThan(0);
        // 互斥 morph 必须为 0
        for (const [mutexName, mutexWeight] of Object.entries(weights!.mutex)) {
          expect(
            mutexWeight,
            `[${tc.name}] mutex morph ${mutexName} = ${mutexWeight}, expected 0 (residue!)`
          ).toBe(0);
        }

        // 在浏览器内计算 ROI 像素差（避免传输 3M 元素数组）
        // Phase 3 Integration Closure：同时统计 opaque 像素保留率，防止"大块画面消失"
        // 被误判为 morph 成功（fullDiff≈总像素数 时可疑）
        // Phase 3 Integration Closure 调查：发现 canvas 在 morph 循环中可能被 Windows DPI 变化
        // 或窗口移动 resize。baseline 用旧尺寸 readPixels 会导致 current 中超出的区域返回透明像素，
        // 被误判为"模型消失"。修复：检测 canvas 尺寸变化，如尺寸不同则重新采集 baseline。
        const roi = roiRanges[tc.roi];
        const diffResult = await avatarWindow!.evaluate((roiCfg) => {
          const canvas = document.getElementById('canvas') as HTMLCanvasElement;
          const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext;
          if (!gl) return null;
          const baseline = (window as any).__chat6NeutralBaseline as Uint8Array;
          const size = (window as any).__chat6CanvasSize as { w: number; h: number };
          if (!baseline || !size) return null;
          // 检测 canvas 尺寸是否变化（DPI 切换/窗口移动可能导致）
          const currentW = canvas.width;
          const currentH = canvas.height;
          const sizeChanged = currentW !== size.w || currentH !== size.h;
          // 始终用 baseline 尺寸读取（保证 current 和 baseline 可比）
          const w = size.w, h = size.h;
          const current = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, current);
          const yStart = Math.floor(h * roiCfg.yStart);
          const yEnd = Math.floor(h * roiCfg.yEnd);
          let roiDiff = 0;
          let fullDiff = 0;
          let baselineOpaque = 0;
          let currentOpaque = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = (y * w + x) * 4;
              // opaque 判定：alpha > 200（可见像素）
              if (baseline[idx + 3] > 200) baselineOpaque++;
              if (current[idx + 3] > 200) currentOpaque++;
              const dr = Math.abs(baseline[idx] - current[idx]);
              const dg = Math.abs(baseline[idx + 1] - current[idx + 1]);
              const db = Math.abs(baseline[idx + 2] - current[idx + 2]);
              // Phase 3 Integration Closure：阈值从 >3 降到 >1
              // 原因：FaceRed 等颜色 morph 在 0.35 权重下 RGB 变化可能只有 1-2/像素
              // 噪声基线为 0（暂停循环后无帧间变化），>1 仍能区分真实变化和噪声
              if (dr + dg + db > 1) {
                fullDiff++;
                if (y >= yStart && y < yEnd) roiDiff++;
              }
            }
          }
          return {
            roiDiff, fullDiff, w, h,
            baselineOpaque, currentOpaque,
            retentionRatio: baselineOpaque > 0 ? currentOpaque / baselineOpaque : 0,
            currentCanvasW: currentW,
            currentCanvasH: currentH,
            sizeChanged
          };
        }, roi);

        expect(diffResult, `[${tc.name}] failed to compute pixel diff`).not.toBeNull();

        // Phase 3 Integration Closure：先保存截图再断言，失败时也有视觉证据
        // 调查 I (い) morph retention=0.443 异常：到底是真实渲染问题还是 readPixels 时序问题
        if (tc.screenshotFile) {
          mkdirSync(EVIDENCE_DIR, { recursive: true });
          await avatarWindow!.locator('#canvas').screenshot({
            path: join(EVIDENCE_DIR, tc.screenshotFile)
          });
        }

        // 诊断日志：fullDiff 接近总像素数说明大块画面变化（可能是模型消失或背景重绘）
        const totalPixels = diffResult!.w * diffResult!.h;
        const fullDiffRatio = totalPixels > 0 ? diffResult!.fullDiff / totalPixels : 0;
        const sizeInfo = diffResult!.sizeChanged
          ? `CURRENT=${diffResult!.currentCanvasW}x${diffResult!.currentCanvasH} CHANGED from baseline=${diffResult!.w}x${diffResult!.h}!`
          : `canvas=${diffResult!.w}x${diffResult!.h}(${totalPixels})`;
        console.log(`[morph-test] ${tc.name}: weight=${weights!.target}, ${sizeInfo}, roiDiff(${tc.roi})=${diffResult!.roiDiff}, fullDiff=${diffResult!.fullDiff}(${(fullDiffRatio * 100).toFixed(1)}%), threshold=${Math.max(noisePixels * 5, 10)}, retention=${diffResult!.retentionRatio.toFixed(3)}(${diffResult!.currentOpaque}/${diffResult!.baselineOpaque})`);

        // 像素差必须显著高于 neutral 噪声基线（至少 5 倍）
        // 噪声基线是全画面，ROI 只是部分画面，所以用 5 倍阈值
        // Phase 3 Integration Closure：最低阈值从 50 降到 10
        // 原因：FaceRed 等颜色 morph 在 0.35 权重下变化像素数较少（~几十到几百）
        // 噪声基线为 0 时，10 像素变化仍能可靠区分真实 morph 和噪声
        const threshold = Math.max(noisePixels * 5, 10);  // 至少 10 像素变化
        expect(
          diffResult!.roiDiff,
          `[${tc.name}] ROI(${tc.roi}) pixel diff = ${diffResult!.roiDiff}, fullDiff = ${diffResult!.fullDiff}, threshold = ${threshold} (noise baseline = ${noisePixels}); real weight = ${weights!.target}`
        ).toBeGreaterThan(threshold);

        // Phase 3 Integration Closure：可见像素保留率检查（防止"大块画面消失"假绿）
        // morph 不应导致模型主体消失。opaque 像素保留率必须 ≥ 85%
        // 如果 currentOpaque 远低于 baselineOpaque，说明模型部分区域消失（渲染异常）
        expect(
          diffResult!.retentionRatio,
          `[${tc.name}] opaque pixel retention = ${diffResult!.retentionRatio} (baseline=${diffResult!.baselineOpaque}, current=${diffResult!.currentOpaque}), expected ≥ 0.85 — model body may have disappeared!`
        ).toBeGreaterThanOrEqual(0.85);

      }

      // 5. neutral/reset 测试：reset 后所有语义 Morph 权重为 0
      await avatarWindow!.evaluate(() => {
        (window as any).__chatx2Runtime?.actorRuntime?.reset();
      });
      await avatarWindow!.waitForTimeout(300);
      const resetWeights = await avatarWindow!.evaluate(() => {
        const control = (window as any).__chatx2Runtime?.morphControl;
        if (!control) return null;
        const all = ['あ', 'い', 'う', 'え', 'お', 'まばたき', '笑い', 'にこり', 'びっくり', '怒り', '困る', '真面目', '照れ', '涙', 'FaceRed'];
        const result: Record<string, number> = {};
        for (const m of all) {
          result[m] = control.getRenderedWeight(m);
        }
        return result;
      });
      expect(resetWeights).not.toBeNull();
      for (const [name, w] of Object.entries(resetWeights!)) {
        expect(
          w,
          `[reset] morph ${name} = ${w}, expected 0`
        ).toBe(0);
      }
      console.log('[morph-test] reset: all semantic morphs = 0 PASS');

    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

});
