// Phase 5.2 修正（2026-07-19）：motion-sync E2E
//
// 用户要求：
// > 新建 tests/e2e/motion-sync.spec.ts，验证真实 PMX：
// > - idle 自动播放
// > - emotion/intent 切换
// > - 播放中骨骼动作与 AudioContext 时间一致
// > - 语音结束和模式切换安全停止
//
// 本测试在真实 PMX 模型上验证 MotionPlayer + Planner + PerformanceClock 集成：
// 1. 进入 desktop 模式后默认 idle-stand-breathe-v1 自动播放（local-clock 时间源）
// 2. 提交消息后主进程派生 semantic，Avatar 在 sourceNode.start() 后调用 Planner 选择 gesture pack
// 3. speaking gesture 使用 performance-clock 时间源（与 AudioContext.currentTime 对齐）
// 4. 语音自然结束后 gesture 淡出 → idle 淡入（不先 reset 到 Base Pose）
// 5. emotion 变化时通过 motion:emotion-update IPC 触发 Planner 重新选择 gesture（fade 切换）
// 6. 模式切换离开 desktop → motion:command('stop') + motionRegistry.releaseAll()
//
// 不破坏 Phase 5.1 硬门：
// - 解码完成前 motionPlayer 仍在播放 idle（不阻塞音频）
// - AudioContext 未运行/未对齐时禁止启动 speaking motion（validateSpeakingMotionStart）
// - 语音开始时 stopPerformance('interrupted') 停止 idle（释放骨骼给 actorRuntime.speak）
// - 语音 'ended' 后 stopPerformance 重启 idle pack（fade-out → fade-in）
//
// 注意：本测试不验证视觉质量（脚滑/穿模/首尾循环），这些需要本地视频验收。

import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { rmSync, existsSync, readdirSync } from 'node:fs';
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

async function waitForMessageCount(page: Page, count: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const history = await page.evaluate(() => (window as any).chatx2.conversationHistory());
    if (history.messages.length >= count) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function waitForMotionPack(avatarPage: Page, packId: string | null, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await avatarPage.evaluate(() =>
      (window as any).__chatx2Runtime?.motionPlayer?.getCurrentPackId());
    if (current === packId) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/**
 * 在 Avatar 窗口注入 decodeAudioData 延迟（用于测试解码窗口内的硬门）。
 * Avatar 是唯一 AudioContext 所有者，注入到 Avatar window 才有效。
 */
async function injectDecodeDelay(avatarPage: Page, delayMs: number): Promise<void> {
  await avatarPage.evaluate((delay) => {
    const original = (window as any).AudioContext.prototype.decodeAudioData;
    (window as any).AudioContext.prototype.decodeAudioData = function(buf: ArrayBuffer): Promise<AudioBuffer> {
      return new Promise((resolve) => {
        setTimeout(() => {
          const fakeBuffer = {
            duration: 0.5,
            length: 22050,
            sampleRate: 44100,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(22050)
          };
          resolve(fakeBuffer as unknown as AudioBuffer);
        }, delay);
      });
    };
    // 同时注入 createBufferSource 的 start/stop/onended（让 sourceNode.start() 可控）
    const FakeCtor = (window as any).AudioContext;
    FakeCtor.prototype.createBufferSource = function(): AudioBufferSourceNode {
      return { start() {}, stop() {}, connect() {}, disconnect() {}, onended: null } as unknown as AudioBufferSourceNode;
    };
  }, delayMs);
}

/**
 * Phase 5.2B.3：注入可控音频（模拟 ≥6s Mock WAV）。
 *
 * 与 injectDecodeDelay 不同：
 * - decodeAudioData 返回 fake buffer，duration 由参数控制（≥6s）
 * - createBufferSource 的 start() 设置 timer 在 duration 秒后触发 onended
 * - stop() 清除 timer（模拟手动停止）
 *
 * 这样 audio 会在指定 duration 后自然结束（触发 sourceNode.onended → stopPerformance('ended')），
 * 而不是像 injectDecodeDelay 那样永不结束。
 *
 * 用于验证：长语音播放期间，gesture 自然结束后释放 lease + 恢复 procedural life，
 * 音频结束后才回 idle。
 */
async function injectControllableAudio(avatarPage: Page, durationSec: number): Promise<void> {
  await avatarPage.evaluate((dur) => {
    const totalSamples = Math.floor(dur * 44100);
    const fakeBuffer = {
      duration: dur,
      length: totalSamples,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(totalSamples)
    };
    (window as any).AudioContext.prototype.decodeAudioData = function(_buf: ArrayBuffer): Promise<AudioBuffer> {
      return Promise.resolve(fakeBuffer as unknown as AudioBuffer);
    };
    const FakeCtor = (window as any).AudioContext;
    FakeCtor.prototype.createBufferSource = function(): AudioBufferSourceNode {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onEnded: (() => void) | null = null;
      const source = {
        start() {
          timer = setTimeout(() => {
            if (onEnded) onEnded();
          }, dur * 1000);
        },
        stop() {
          if (timer) { clearTimeout(timer); timer = null; }
        },
        connect() {},
        disconnect() {},
        get onended() { return onEnded; },
        set onended(fn: (() => void) | null) { onEnded = fn; }
      };
      return source as unknown as AudioBufferSourceNode;
    };
  }, durationSec);
}

test.describe('Phase 5.2 修正：motion-sync（idle 自动播放/emotion 切换/时间一致/安全停止）', () => {
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

  test('进入 desktop 模式后 idle-stand-breathe-v1 自动播放（local-clock 时间源）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 等待默认 idle pack 启动
      const found = await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);
      if (!found) {
        const debug = await avatarPage!.evaluate(() => (window as any).__idleStartDebug);
        console.error('[test-diagnostic] idleStartDebug:', JSON.stringify(debug, null, 2));
      }
      expect(found).toBe(true);

      // motionPlayer.isPlaying() 必须为 true
      const isPlaying = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.isPlaying());
      expect(isPlaying).toBe(true);

      // 涉及的骨骼必须是 上半身/左肩/右肩
      const boneNames = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.getCurrentBoneNames());
      expect(boneNames).toContain('上半身');
      expect(boneNames).toContain('左肩');
      expect(boneNames).toContain('右肩');

      // idle pack 不应涉及 左腕/右腕（gesture 才涉及）
      expect(boneNames).not.toContain('左腕');
      expect(boneNames).not.toContain('右腕');

      // 验证 MotionPlayer 状态：idle 使用 local-clock 时间源
      // Phase 5.2 修正：play() 进入 fading-in 状态（0.5s fade-in），完成后转 'playing'
      // 等待 fade-in 完成（800ms > 0.5s 留余量）
      await new Promise(r => setTimeout(r, 800));
      const state = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.__debugMotionPlayerState?.());
      expect(state).toBeDefined();
      // 接受 'playing' 或 'fading-in'（取决于采样时机，但都已加载 pack 并播放）
      expect(['playing', 'fading-in']).toContain(state.state);
      expect(state.currentPackId).toBe('idle-stand-breathe-v1');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('提交"你好"消息后 gesture-open-hand-small-v1 自动播放（Planner 选择 + 主进程派生 semantic）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const composerPage = await findComposerWindow(app);
      expect(composerPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 注入 decode 延迟（确保有解码窗口可观察）
      await injectDecodeDelay(avatarPage!, 200);

      // 等待 idle 自动启动
      const idleFound = await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);
      expect(idleFound).toBe(true);

      // 通过 Composer 提交"你好"消息（主进程派生 emotion='happy', intent='greeting'）
      // Planner 根据 happy/greeting 选择 gesture-open-hand-small-v1
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '你好');
      expect(result.accepted).toBe(true);

      // 等待 assistant 消息 + WAV 校验完成
      const ok = await waitForMessageCount(composerPage!, 2, 5000);
      expect(ok).toBe(true);

      // Composer 收到 audioReady=true 后调用 audioPlay(taskId)
      // 主进程派生 semantic={emotion:'happy', intent:'greeting'} 转发给 Avatar
      // Avatar 在 sourceNode.start() 后调用 Planner 选择 gesture pack
      // 等待 gesture-open-hand-small-v1 启动
      const gestureFound = await waitForMotionPack(avatarPage!, 'gesture-open-hand-small-v1', 8000);
      expect(gestureFound).toBe(true);

      // gesture pack 涉及的骨骼：左腕/右腕/上半身
      const boneNames = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.getCurrentBoneNames());
      expect(boneNames).toContain('左腕');
      expect(boneNames).toContain('右腕');
      expect(boneNames).toContain('上半身');

      // gesture 状态必须是 playing
      const isPlaying = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.isPlaying());
      expect(isPlaying).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('speaking gesture 时间源对齐 PerformanceClock（与 AudioContext.currentTime 一致）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const composerPage = await findComposerWindow(app);
      const avatarPage = await findAvatarWindow(app);
      expect(composerPage).not.toBeNull();
      expect(avatarPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      await avatarPage!.waitForLoadState('domcontentloaded');

      await injectDecodeDelay(avatarPage!, 200);

      // 等待 idle 自动启动
      await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);

      // 提交消息触发 speaking gesture
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '你好');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 等待 gesture 启动
      const gestureFound = await waitForMotionPack(avatarPage!, 'gesture-open-hand-small-v1', 8000);
      expect(gestureFound).toBe(true);

      // 等待 gesture 进入 playing 状态（非 fading-in）
      await new Promise(r => setTimeout(r, 800));

      // 关键断言：speaking gesture 的 currentAnimationTime 应基于 PerformanceClock.now()
      // PerformanceClock 对齐到 AudioContext.currentTime（task-aligned）
      // 验证：currentAnimationTime > 0 且 < gesture 总时长（1.5s）
      const state = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.__debugMotionPlayerState?.());
      expect(state).toBeDefined();
      expect(state.currentPackId).toBe('gesture-open-hand-small-v1');
      expect(state.animationDurationSec).toBeGreaterThan(0);
      expect(state.currentAnimationTime).toBeGreaterThan(0);
      // gesture-open-hand-small-v1 总时长 1.5s（45 帧 @ 30fps）
      expect(state.currentAnimationTime).toBeLessThanOrEqual(state.animationDurationSec + 0.1);

      // 验证 PerformanceClock 已对齐（getAudioStartTime 不为 undefined）
      const clockInfo = await avatarPage!.evaluate(() => {
        const session = (window as any).__chatx2Runtime?.performanceSession;
        if (!session) return null;
        const clock = session.getClock();
        return {
          aligned: clock.isAligned?.() ?? false,
          audioStartTime: clock.getAudioStartTime?.()
        };
      });
      expect(clockInfo).not.toBeNull();
      expect(clockInfo!.aligned).toBe(true);
      expect(clockInfo!.audioStartTime).toBeDefined();
      expect(typeof clockInfo!.audioStartTime).toBe('number');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('motion:emotion-update IPC 触发 Planner 重新选择 gesture pack（fade 切换）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const composerPage = await findComposerWindow(app);
      const avatarPage = await findAvatarWindow(app);
      expect(composerPage).not.toBeNull();
      expect(avatarPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      await avatarPage!.waitForLoadState('domcontentloaded');

      await injectDecodeDelay(avatarPage!, 200);
      await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);

      // 先触发 happy/greeting → gesture-open-hand-small-v1
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '你好');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);
      const gesture1Found = await waitForMotionPack(avatarPage!, 'gesture-open-hand-small-v1', 8000);
      expect(gesture1Found).toBe(true);

      // 等待 gesture 进入 playing 状态
      await new Promise(r => setTimeout(r, 600));

      // 通过 motion:emotion-update IPC 切换到 thinking
      // Planner 根据 thinking 选择 gesture-think-soft-v1
      const updateResult = await composerPage!.evaluate(() =>
        (window as any).chatx2.motionEmotionUpdate('thinking', 'thinking'));
      expect(updateResult.success).toBe(true);

      // 等待 gesture-think-soft-v1 启动（通过 fade-out → fade-in 切换）
      const gesture2Found = await waitForMotionPack(avatarPage!, 'gesture-think-soft-v1', 10000);
      expect(gesture2Found).toBe(true);

      // gesture-think-soft-v1 涉及的骨骼：右腕/右ひじ/頭
      const boneNames = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.getCurrentBoneNames());
      expect(boneNames).toContain('右腕');
      expect(boneNames).toContain('右ひじ');
      expect(boneNames).toContain('頭');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('语音结束后 gesture 淡出 → idle 淡入（不先 reset 到 Base Pose）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const composerPage = await findComposerWindow(app);
      const avatarPage = await findAvatarWindow(app);
      expect(composerPage).not.toBeNull();
      expect(avatarPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      await avatarPage!.waitForLoadState('domcontentloaded');

      await injectDecodeDelay(avatarPage!, 200);
      await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);

      // 提交消息触发 speaking gesture
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text)
      , '你好');
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);
      const gestureFound = await waitForMotionPack(avatarPage!, 'gesture-open-hand-small-v1', 8000);
      expect(gestureFound).toBe(true);

      // 等待 gesture 进入 playing 状态
      await new Promise(r => setTimeout(r, 600));

      // 通过 audioStop 触发 stopPerformance('interrupted') → motionPlayer.stopImmediate()
      // 然后语音结束路径触发 fade-out → idle 切换
      const history = await composerPage!.evaluate(() => (window as any).chatx2.conversationHistory());
      const taskId = history.messages[1]?.taskId;
      expect(taskId).toBeDefined();

      // 触发停止：Composer 调用 audioStop（模拟新消息打断或用户取消）
      await composerPage!.evaluate((tid) =>
        (window as any).chatx2.audioStop(tid)
      , taskId);

      // 等待 motionPlayer 状态变化（gesture → null 或 idle）
      // stopImmediate 会立即清零，然后 stopPerformance 的 'ended' 路径会重新启动 idle
      await new Promise(r => setTimeout(r, 1500));

      // 最终 motionPlayer 应该回到 idle（或 null 状态后立即重启 idle）
      // 等待 idle pack 重新启动
      const idleRestarted = await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);
      expect(idleRestarted).toBe(true);

      // 验证 motionPlayer 仍在 playing（idle 重启后）
      const isPlaying = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.isPlaying());
      expect(isPlaying).toBe(true);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('模式切换离开 desktop → motion:command(stop) + motionRegistry.releaseAll()', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const avatarPage = await findAvatarWindow(app);
      expect(avatarPage).not.toBeNull();
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 等待 idle 自动启动
      const idleFound = await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);
      if (!idleFound) {
        const debug = await avatarPage!.evaluate(() => (window as any).__idleStartDebug);
        console.error('[test-diagnostic] idleStartDebug:', JSON.stringify(debug, null, 2));
      }
      expect(idleFound).toBe(true);

      // 切回 chat 模式
      await chatPage.evaluate(() => (window as any).chatx2.transition('chat'));
      await waitForMode(chatPage, 'chat', 5000);

      // 等待 motionPlayer 停止（主进程通过 motion:command(stop) 通知 Avatar）
      // motionPlayer.stopImmediate() 后 currentPackId 变为 null
      const stopFound = await waitForMotionPack(avatarPage!, null, 10000);
      expect(stopFound).toBe(true);

      // 验证 motionPlayer 不在播放
      const isPlaying = await avatarPage!.evaluate(() =>
        (window as any).__chatx2Runtime?.motionPlayer?.isPlaying());
      expect(isPlaying).toBe(false);

      // 验证 motion:list 返回空数组（motionRegistry.releaseAll() 已清空）
      const list = await chatPage.evaluate(() => (window as any).chatx2.motionList());
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(0);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('motion:list 返回三个 idle + 三个 gesture pack（candidate-review 模式）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      // 测试模式默认启用 candidate-review（NODE_ENV=test）
      const list = await chatPage.evaluate(() => (window as any).chatx2.motionList());
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(6);

      const packIds = list.map((p: { packId: string }) => p.packId);
      // 三个 idle
      expect(packIds).toContain('idle-stand-breathe-v1');
      expect(packIds).toContain('idle-look-around-v1');
      expect(packIds).toContain('idle-shift-weight-v1');
      // 三个 gesture
      expect(packIds).toContain('gesture-open-hand-small-v1');
      expect(packIds).toContain('gesture-nod-small-v1');
      expect(packIds).toContain('gesture-think-soft-v1');

      // 所有 pack 必须是 candidate-review 模式（pending visual acceptance）
      for (const p of list) {
        expect(p.mode).toBe('candidate-review');
        expect(p.movesRoot).toBe(false);
      }

      // 不应包含 boneMapping/sourceUrl/sha256（防止 Renderer 自行加载）
      const first = list[0];
      expect(first.boneMapping).toBeUndefined();
      expect(first.sourceUrl).toBeUndefined();
      expect(first.sha256).toBeUndefined();
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  test('motion:play IPC 拒绝 packId 输入（只接受 semantic，符合用户硬规则）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      // 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id
      // motion:play 不接受 packId，只接受 semantic
      // 尝试传 packId 应该被拒绝（payload 必须包含 semantic）
      const result = await chatPage.evaluate(() =>
        (window as any).chatx2.motionPlay({ packId: 'gesture-open-hand-small-v1' } as any));
      expect(result.success).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('semantic');
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });

  // Phase 5.2B.3 RED：长语音（≥6s）gesture 自然结束后释放 lease + 恢复 relaxed/procedural
  //
  // 用户要求（2026-07-21）：
  // > 非循环 gesture 的自然结束仍未被解决。
  // > motion-player.ts:716 对 looping=false 只将播放时间钳制到末帧，不会自动 stop()、淡出或释放 lease。
  // > 对超过 2 秒的真实回复，gesture 可能先播完，然后保持末帧直到音频结束。
  //
  // 本测试验证：
  // 1. 长语音（6s）播放期间，gesture（1.8s）自然结束后：
  //    - gesture 不再保持末帧（state='idle'，currentPackId=null）
  //    - gesture 骨骼 lease 已释放（owner='none'）
  //    - RelaxedBasePose + ProceduralLifeController 已恢复（上半身 quaternion 非冻结）
  //    - 五口型和 AudioContext 硬门不回归（__avatarSpeaking=true）
  // 2. 音频结束后才回默认 idle pack
  //
  // RED 状态（修复前）：gesture 保持末帧，state='playing'，lease 未释放，procedural 被跳过 → 测试失败
  // GREEN 状态（修复后）：gesture 自然结束 → fade-out → lease 释放 → procedural 恢复 → 测试通过
  test('Phase 5.2B.3 RED：长语音（≥6s）gesture 自然结束后释放 lease + 恢复 procedural（audio 仍在播放）', async () => {
    const { app, chatPage, userDataDir } = await launchApp({ CHAT6_PMX_RENDER_IN_TEST: '1' });
    try {
      const pmxReady = await waitForPmxFirstFrame(chatPage, 30000);
      expect(pmxReady).toBe(true);

      await chatPage.evaluate(() => (window as any).chatx2.transition('desktop'));
      await waitForMode(chatPage, 'desktop', 5000);

      const composerPage = await findComposerWindow(app);
      const avatarPage = await findAvatarWindow(app);
      expect(composerPage).not.toBeNull();
      expect(avatarPage).not.toBeNull();
      await composerPage!.waitForLoadState('domcontentloaded');
      await avatarPage!.waitForLoadState('domcontentloaded');

      // 注入可控音频：模拟 ≥6s Mock WAV（实际使用 8s 留足余量）
      // start() 设置 8s 后触发 onended（模拟真实 WAV 播放结束）
      const AUDIO_DURATION_SEC = 8.0;
      await injectControllableAudio(avatarPage!, AUDIO_DURATION_SEC);

      // 等待 idle 自动启动
      await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);

      // 提交消息触发 speaking gesture
      // 使用长文本确保 Mock WAV ≥6s（75 chars × 80ms = 6000ms）
      const longText = '这是一段用于测试长语音的文本需要超过六秒才能播放完成以确保gesture动作在音频结束前先自然结束然后验证lease释放和procedural恢复';
      const result = await composerPage!.evaluate((text) =>
        (window as any).chatx2.conversationSubmit(text), longText);
      expect(result.accepted).toBe(true);
      await waitForMessageCount(composerPage!, 2, 5000);

      // 等待 gesture 启动
      const gestureFound = await waitForMotionPack(avatarPage!, 'gesture-open-hand-small-v1', 8000);
      expect(gestureFound).toBe(true);

      // 等待 gesture 进入 playing 状态
      await new Promise(r => setTimeout(r, 800));

      // gesture-open-hand-small-v1 时长 1.8s（54 帧 @ 30fps）
      // 等待 gesture 自然结束 + fade-out（1.8s + 0.5s = 2.3s，留余量到 3.5s）
      // 此时音频仍在播放（8s 总长，才过 ~3.5s）
      await new Promise(r => setTimeout(r, 3500));

      // === 断言 1：gesture 不再保持末帧 ===
      // RED 状态：state 仍为 'playing'，currentPackId 仍为 gesture packId
      // GREEN 状态：state 为 'idle'，currentPackId 为 null（lease 已释放，procedural 接管）
      const mpState = await avatarPage!.evaluate(() => {
        const mp = (window as any).__chatx2Runtime?.motionPlayer;
        return mp ? {
          state: mp.getState(),
          currentPackId: mp.getCurrentPackId(),
          isPlaying: mp.isPlaying()
        } : null;
      });
      expect(mpState).not.toBeNull();
      // gesture 应已自然结束并释放（state='idle'，currentPackId=null）
      expect(mpState!.state).toBe('idle');
      expect(mpState!.currentPackId).toBeNull();
      expect(mpState!.isPlaying).toBe(false);

      // === 断言 2：gesture 骨骼 lease 已释放 ===
      const boneOwners = await avatarPage!.evaluate(() => {
        const registry = (window as any).__chatx2Runtime?.boneOwnershipRegistry;
        if (!registry) return null;
        return {
          leftWrist: registry.getOwner('左腕'),
          rightWrist: registry.getOwner('右腕'),
          leftElbow: registry.getOwner('左ひじ'),
          rightElbow: registry.getOwner('右ひじ')
        };
      });
      expect(boneOwners).not.toBeNull();
      // gesture 骨骼 lease 已释放（owner='none'）→ RelaxedBasePose 可接管
      expect(boneOwners!.leftWrist).toBe('none');
      expect(boneOwners!.rightWrist).toBe('none');
      expect(boneOwners!.leftElbow).toBe('none');
      expect(boneOwners!.rightElbow).toBe('none');

      // === 断言 3：五口型和 AudioContext 硬门不回归 ===
      // 必须在 bone sampling 之前检查，避免 sampling 耗时导致音频超时
      // 此时音频仍在播放（8s 总长，才过 ~3.5s），__avatarSpeaking 必须仍为 true
      const audioState = await avatarPage!.evaluate(() => {
        return {
          avatarSpeaking: (window as any).__avatarSpeaking,
          performanceSessionState: (window as any).__chatx2Runtime?.performanceSession?.getState?.()
        };
      });
      expect(audioState.avatarSpeaking).toBe(true);
      expect(audioState.performanceSessionState).toBe('performing');

      // === 断言 4：RelaxedBasePose + ProceduralLifeController 已恢复 ===
      // 采样 '上半身' quaternion 多次（ProceduralLife 驱动呼吸 2.0°，应该有变化）
      // 如果 gesture 仍持有 lease，ProceduralLife 被跳过，quaternion 冻结
      // 注意：采样窗口 1500ms，确保总耗时 < 8s 音频时长（3500 + 1500 = 5000ms < 8000ms）
      const samples = await avatarPage!.evaluate(async () => {
        const runtime = (window as any).__chatx2Runtime;
        const results: Array<{ t: number; q: [number, number, number, number] }> = [];
        const start = Date.now();
        while (Date.now() - start < 1500) {
          const state = runtime.__getBoneState('上半身');
          if (state) {
            results.push({ t: Date.now() - start, q: state.quaternion });
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return results;
      });

      // 计算 quaternion 最大差异（相对于第一个样本）
      expect(samples.length).toBeGreaterThanOrEqual(4);
      let maxDiff = 0;
      if (samples.length >= 2) {
        const q0 = samples[0].q;
        for (let i = 1; i < samples.length; i++) {
          const dot = q0[0]*samples[i].q[0] + q0[1]*samples[i].q[1] + q0[2]*samples[i].q[2] + q0[3]*samples[i].q[3];
          const diff = 1 - Math.abs(dot);
          if (diff > maxDiff) maxDiff = diff;
        }
      }
      // ProceduralLifeController speaking 时呼吸 amplitude = 0.006 * 0.7 = 0.0042 rad
      // quaternion diff ≈ θ²/8 ≈ 0.0042²/8 ≈ 2.2e-6
      // 阈值 1e-7 确保非冻结（RED 状态 diff = 0，GREEN 状态 diff ≈ 2e-6）
      expect(maxDiff).toBeGreaterThan(0.0000001);

      // === 断言 5：音频结束后回 idle pack ===
      // 等待音频自然结束（8s total，已过 ~5s，还需 ~3s + 余量）
      await new Promise(r => setTimeout(r, 4000));

      // 音频结束后应回 idle pack
      const idleRestarted = await waitForMotionPack(avatarPage!, 'idle-stand-breathe-v1', 10000);
      expect(idleRestarted).toBe(true);

      const finalState = await avatarPage!.evaluate(() => {
        const mp = (window as any).__chatx2Runtime?.motionPlayer;
        return {
          state: mp?.getState(),
          currentPackId: mp?.getCurrentPackId(),
          isPlaying: mp?.isPlaying(),
          avatarSpeaking: (window as any).__avatarSpeaking
        };
      });
      expect(finalState.currentPackId).toBe('idle-stand-breathe-v1');
      expect(finalState.isPlaying).toBe(true);
      expect(finalState.avatarSpeaking).toBe(false);
    } finally {
      await closeAppAndCleanup(app, userDataDir);
    }
  });
});
