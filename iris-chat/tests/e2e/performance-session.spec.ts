// Phase 5.2 Task 5.2.7: AvatarPerformanceSession E2E（真实 PMX）
//
// 在真实 PMX 模型下验证 AvatarPerformanceSession 正确接入：
// 1. __chatx2Runtime.performanceSession 在 Avatar renderer 初始化后可用
// 2. 提交消息触发 avatar:play 后 session.getState() === 'performing'
// 3. session.getCurrentTaskId() 返回当前 taskId
// 4. session.getClock().getAudioStartTime() 在播放开始后非 undefined
// 5. session.getClock().getCurrentTaskId() 与 session.getCurrentTaskId() 一致
// 6. 播放结束后 session.getState() === 'idle' + getCurrentTaskId() === null
// 7. 切回 Chat 模式后 session 状态恢复 'idle'（stopPerformance 调用 endPerformance）
// 8. 真实 A/I/U/E/O 时间轴在播放期间逐帧写入 PMX Mesh
// 9. PerformancePlanner.plan() 可用（idle 状态返回 motionPackId）
//
// 不破坏 Phase 5.1 硬门：
// - 解码完成前 session 仍为 'idle'（beginPerformance 在 sourceNode.start() 后调用）
// - 播放结束后 viseme 时间轴清空（endPerformance 内部清空）
// - 切回 Chat 时 session.endPerformance 被调用（stopPerformance 内部调用）

import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launchApp(envExtra: Record<string, string> = {}): Promise<{ app: ElectronApplication; chatPage: Page; userDataDir: string }> {
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'test', ...envExtra }
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
    throw new Error('Chat window not found within 10s');
  }
  await chatPage.waitForLoadState('domcontentloaded');
  const identity = await chatPage.evaluate(() => (window as any).chatx2.getIdentity());
  return { app, chatPage, userDataDir: identity.userDataDir };
}

async function closeAppAndCleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => {});
  if (userDataDir && userDataDir.includes('chat6-test-')) {
    await new Promise(r => setTimeout(r, 1000));
    for (let i = 0; i < 15; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch { /* ignore */ }
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

async function findComposerWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const title = await w.title().catch(() => '');
    if (title.includes('Composer')) return w;
  }
  return null;
}

async function findAvatarWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const title = await w.title().catch(() => '');
    if (title.includes('Avatar')) return w;
  }
  return null;
}

async function waitForMessageCount(page: Page, count: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const history = await page.evaluate(() => (window as any).chatx2.conversationHistory());
    if (history.messages.length >= count) return true;
    await page.waitForTimeout(100);
  }
  return false;
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

async function waitForMode(page: Page, mode: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentMode = await page.evaluate(() => (window as any).chatx2.getMode());
    if (currentMode === mode) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

function quaternionDistance(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2 + (a[3] - b[3]) ** 2
  );
}

test.describe('Phase 5.2 Task 5.2.7: AvatarPerformanceSession E2E（真实 PMX）', () => {
  test.afterAll(async () => {
    const tmp = tmpdir();
    let entries: string[] = [];
    try {
      entries = readdirSync(tmp).filter(name => name.startsWith('chat6-test-'));
    } catch { return; }
    for (const name of entries) {
      const dir = join(tmp, name);
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!existsSync(dir)) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
  });

  test('真实 PMX 加载后 performanceSession 可用，初始状态为 idle', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // performanceSession 必须可用
      const hasSession = await avatarPage!.evaluate(() =>
        !!((window as any).__chatx2Runtime?.performanceSession));
      expect(hasSession).toBe(true);

      // 初始状态为 idle
      const state = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getState());
      expect(state).toBe('idle');

      // taskId 为 null
      const taskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getCurrentTaskId());
      expect(taskId).toBeNull();

      // clock 未对齐
      const clockTaskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getCurrentTaskId());
      expect(clockTaskId).toBeUndefined();

      const audioStartTime = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getAudioStartTime());
      expect(audioStartTime).toBeUndefined();
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('提交消息后 session 切换到 performing + clock 对齐', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 提交消息
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , 'PerformanceSession E2E 测试');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 等待 Avatar 收到 performance:started（state 切换到 performing）
      let performingStarted = false;
      const startWait = Date.now();
      while (Date.now() - startWait < 5000) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'performing') {
          performingStarted = true;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      expect(performingStarted).toBe(true);

      // session.getCurrentTaskId() 非空
      const sessionTaskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getCurrentTaskId());
      expect(typeof sessionTaskId).toBe('string');
      expect(sessionTaskId).not.toBeNull();
      expect(sessionTaskId!.length).toBeGreaterThan(0);

      // session.getClock().getCurrentTaskId() 与 session.getCurrentTaskId() 一致
      const clockTaskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getCurrentTaskId());
      expect(clockTaskId).toBe(sessionTaskId);

      // session.getClock().getAudioStartTime() 已定义
      const audioStartTime = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getAudioStartTime());
      expect(typeof audioStartTime).toBe('number');
      expect(audioStartTime).toBeGreaterThanOrEqual(0);

      // viseme 时间轴非空（25ms PCM/RMS + 文本发音提示）
      const visemeCount = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getVisemeTimeline()?.length ?? 0);
      expect(visemeCount).toBeGreaterThan(0);

      // duration > 0
      const duration = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getDurationSeconds());
      expect(duration).toBeGreaterThan(0);

      // 真实 Mesh 证据：播放期间应出现至少两个不同口型通道，且总权重 <= 1。
      const observed = new Set<string>();
      for (let sample = 0; sample < 16; sample++) {
        const weights = await avatarPage!.evaluate(() => {
          const control = (window as any).__chatx2Runtime?.morphControl;
          return ['あ', 'い', 'う', 'え', 'お'].map(name =>
            Number(control?.getRenderedWeight(name) ?? 0));
        });
        expect(weights.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1.001);
        weights.forEach((weight, index) => {
          if (weight > 0.01) observed.add(['A', 'I', 'U', 'E', 'O'][index]);
        });
        await avatarPage!.waitForTimeout(50);
      }
      expect(observed.size).toBeGreaterThanOrEqual(2);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('播放结束后 session 状态恢复 idle + viseme 时间轴清空', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 提交消息
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '播放结束 session 恢复测试');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 等待 session 切换到 performing
      let performingStarted = false;
      const startWait = Date.now();
      while (Date.now() - startWait < 5000) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'performing') {
          performingStarted = true;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      expect(performingStarted).toBe(true);

      // 等待播放结束（session 切回 idle）
      let performingEnded = false;
      const endWait = Date.now();
      while (Date.now() - endWait < 15000) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'idle') {
          performingEnded = true;
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      expect(performingEnded).toBe(true);

      // session.getCurrentTaskId() 为 null
      const taskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getCurrentTaskId());
      expect(taskId).toBeNull();

      // viseme 时间轴清空
      const visemeCount = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getVisemeTimeline()?.length ?? 0);
      expect(visemeCount).toBe(0);

      // clock 已清除对齐
      const clockTaskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getCurrentTaskId());
      expect(clockTaskId).toBeUndefined();

      const audioStartTime = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getClock()?.getAudioStartTime());
      expect(audioStartTime).toBeUndefined();
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('播放中切回 Chat 模式 → session 立即恢复 idle（stopPerformance 调用 endPerformance）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 提交消息（Mock chat adapter 用 80ms/字符，长文本 → 长音频便于测试切回 Chat）
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '切回 Chat 模式测试，需要较长的文本以确保播放期间切换');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 等待 session 切换到 performing
      let performingStarted = false;
      const startWait = Date.now();
      while (Date.now() - startWait < 5000) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'performing') {
          performingStarted = true;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      expect(performingStarted).toBe(true);

      // 切回 Chat 模式（应触发 stopPerformance → endPerformance）
      await chatPage.evaluate(() => (window as any).chatx2.transition('chat'));
      await waitForMode(chatPage, 'chat', 5000);
      await new Promise(r => setTimeout(r, 1000));

      // session 必须恢复 idle
      const state = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getState());
      expect(state).toBe('idle');

      // taskId 必须为 null
      const taskId = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getCurrentTaskId());
      expect(taskId).toBeNull();

      // viseme 时间轴必须清空
      const visemeCount = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getVisemeTimeline()?.length ?? 0);
      expect(visemeCount).toBe(0);

      // __avatarSpeaking 必须为 false（Phase 5.1 P1-E 硬门不回归）
      const avatarSpeaking = await avatarPage!.evaluate(() => (window as any).__avatarSpeaking);
      expect(avatarSpeaking).toBe(false);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('PerformancePlanner.plan() 通过 session 可用', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // idle 状态 plan
      const idlePlan = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.plan({
          emotion: 'neutral',
          speaking: false
        }));
      expect(idlePlan).not.toBeNull();
      expect(idlePlan.state).toBe('idle');
      expect(idlePlan.emotion).toBe('neutral');
      expect(idlePlan.gestureFamily).toBe('neutral');
      expect(idlePlan.speakingVmdPath).toBeUndefined();

      // speaking 状态 plan
      const speakingPlan = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.plan({
          emotion: 'happy',
          speaking: true
        }));
      expect(speakingPlan.state).toBe('speaking');
      expect(speakingPlan.intensity).toBeGreaterThan(0);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('解码完成前 session 保持 idle（Phase 5.1 硬门不回归）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);
      await new Promise(r => setTimeout(r, 2000));

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 注入 decodeAudioData 延迟（500ms）
      await avatarPage!.evaluate((delayMs) => {
        const origDecode = AudioContext.prototype.decodeAudioData;
        (window as any).__decodeDelayMs = delayMs;
        AudioContext.prototype.decodeAudioData = function (buffer: ArrayBuffer): Promise<AudioBuffer> {
          const d = (window as any).__decodeDelayMs ?? 0;
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              origDecode.call(this, buffer).then(resolve).catch(reject);
            }, d);
          });
        };
      }, 500);

      // 提交消息
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '解码完成前 session idle 测试');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 关键断言：解码期间（500ms 延迟）session 必须保持 idle
      // beginPerformance 在 sourceNode.start() 后调用，解码完成前不会调用
      let decodeViolation = false;
      const decodeWindowBegin = Date.now();
      while (Date.now() - decodeWindowBegin < 350) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'performing') {
          decodeViolation = true;
          break;
        }
        await new Promise(r => setTimeout(r, 20));
      }
      expect(decodeViolation).toBe(false);

      // 解码完成后 session 应切换到 performing
      let performingStarted = false;
      const performStart = Date.now();
      while (Date.now() - performStart < 5000) {
        const state = await avatarPage!.evaluate(() =>
          (window as any).__chatx2Runtime?.performanceSession?.getState());
        if (state === 'performing') {
          performingStarted = true;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      expect(performingStarted).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('真实 PMX 表情、FaceRed 与视线随语义切换并在停止后清理', async () => {
    test.setTimeout(120_000);
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      expect(await waitForPmxFirstFrame(chatPage, 30000)).toBe(true);
      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(await waitForMode(chatPage, 'desktop', 5000)).toBe(true);
      await chatPage.waitForTimeout(1500);

      const composerPage = await findComposerWindow(app);
      const avatarPage = await findAvatarWindow(app);
      expect(composerPage).not.toBeNull();
      expect(avatarPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      await avatarPage!.waitForLoadState('domcontentloaded');
      const evidenceDir = resolve('temp', 'performance-face-gaze');
      mkdirSync(evidenceDir, { recursive: true });
      await avatarPage!.evaluate(() => {
        const panel = document.getElementById('morph-panel');
        if (panel) panel.style.display = 'none';
        (window as any).__chatx2Runtime.cameraControl?.setAngle('face');
      });
      await avatarPage!.screenshot({ path: join(evidenceDir, '00-neutral.png') });

      const neutralEyes = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime.__getBoneState('両目')
      );
      expect(neutralEyes).not.toBeNull();

      const cases = [
        {
          text: '你好呀今天见到你很开心', emotion: 'happy',
          morphs: ['目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'], gaze: false
        },
        {
          text: '我有点害羞不好意思请别笑我', emotion: 'shy',
          morphs: ['困る左', '困る右', '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'], gaze: true
        },
        {
          text: '我有点担心这件事请你先休息一下', emotion: 'concerned',
          morphs: ['困る左', '困る右', '口角下げ左', '口角下げ右'], gaze: true
        },
        {
          text: '这件事很重要请认真听我说明', emotion: 'gentle',
          morphs: ['困る左', '困る右', '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'], gaze: false
        }
      ] as const;

      for (let index = 0; index < cases.length; index++) {
        const entry = cases[index];
        const result = await composerPage!.evaluate((text) =>
          (window as any).chatx2.conversationSubmit(text), entry.text);
        expect(result.accepted).toBe(true);
        expect(await waitForMessageCount(composerPage!, (index + 1) * 2, 5000)).toBe(true);

        const performingStart = Date.now();
        while (Date.now() - performingStart < 5000) {
          const state = await avatarPage!.evaluate(() =>
            (window as any).__chatx2Runtime.performanceSession.getState());
          if (state === 'performing') break;
          await avatarPage!.waitForTimeout(50);
        }
        await expect.poll(() => avatarPage!.evaluate((morphNames) => {
          const control = (window as any).__chatx2Runtime.morphControl;
          return Math.max(...morphNames.map((name: string) => control.getRenderedWeight(name)));
        }, entry.morphs),
        { timeout: 1500 }).toBeGreaterThan(0.02);

        const sample = await avatarPage!.evaluate((morphNames) => {
          const rt = (window as any).__chatx2Runtime;
          const expression = rt.performanceSession.getCurrentExpression();
          return {
            emotion: expression.emotion,
            currentTime: rt.performanceSession.getCurrentTime(),
            duration: rt.performanceSession.getDurationSeconds(),
            timelineWeight: expression.weight,
            expressionWeights: morphNames.map((name: string) => rt.morphControl.getRenderedWeight(name)),
            logicalWeights: morphNames.map((name: string) => rt.morphControl.getWeight(name)),
            faceRed: rt.morphControl.getRenderedWeight('FaceRed'),
            eye: rt.__getBoneState('両目'),
            mouth: ['あ', 'い', 'う', 'え', 'お'].map((name: string) =>
              rt.morphControl.getRenderedWeight(name)
            )
          };
        }, entry.morphs);

        expect(sample.emotion).toBe(entry.emotion);
        expect(Math.max(...sample.expressionWeights), JSON.stringify(sample)).toBeGreaterThan(0.02);
        expect(sample.faceRed).toBeLessThanOrEqual(0.35 + 1e-6);
        expect(sample.mouth.reduce((sum: number, value: number) => sum + value, 0)).toBeLessThanOrEqual(1.001);
        if (entry.emotion === 'shy') expect(sample.faceRed).toBeGreaterThan(0.01);
        if (entry.gaze) {
          expect(quaternionDistance(sample.eye.quaternion, neutralEyes.quaternion)).toBeGreaterThan(0.0005);
        }
        await avatarPage!.screenshot({
          path: join(evidenceDir, `${String(index + 1).padStart(2, '0')}-${entry.emotion}.png`)
        });

        const ended = Date.now();
        while (Date.now() - ended < 10000) {
          const state = await avatarPage!.evaluate(() =>
            (window as any).__chatx2Runtime.performanceSession.getState());
          if (state === 'idle') break;
          await avatarPage!.waitForTimeout(100);
        }
      }

      // Speech completion returns smoothly to the persistent screen-center
      // focus. Mode changes may reset hidden-window bones to model rest, so
      // verify the user-facing return before hiding the desktop avatar.
      await avatarPage!.waitForTimeout(800);
      const returnedEyes = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime.__getBoneState('両目')
      );
      expect(quaternionDistance(returnedEyes.quaternion, neutralEyes.quaternion)).toBeLessThan(0.01);

      await avatarPage!.screenshot({ path: join(evidenceDir, '05-cleaned.png') });
      await chatPage.evaluate(() => (window as any).chatx2.transition('chat'));
      expect(await waitForMode(chatPage, 'chat', 5000)).toBe(true);
      await avatarPage!.waitForTimeout(250);
      const cleaned = await avatarPage!.evaluate(() => {
        const rt = (window as any).__chatx2Runtime;
        return {
          expression: [
            '困る左', '困る右', '怒り左', '怒り右',
            '目尻下げ左', '目尻下げ右',
            '口角上げ左', '口角上げ右', '口角下げ左', '口角下げ右',
            'FaceRed'
          ]
            .map((name: string) => rt.morphControl.getRenderedWeight(name)),
          mouth: ['あ', 'い', 'う', 'え', 'お']
            .map((name: string) => rt.morphControl.getRenderedWeight(name)),
          eye: rt.__getBoneState('両目')
        };
      });
      expect(Math.max(...cleaned.expression)).toBeLessThan(0.001);
      expect(Math.max(...cleaned.mouth)).toBeLessThan(0.001);
      expect(cleaned.eye).not.toBeNull();
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
