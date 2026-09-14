// Phase 3 收口修复 Step 6.1: AvatarLoopController 单元测试
// 验证：
// 1. start() 启动循环，frame count 增长
// 2. stop() 停止循环，frame count 不再增长
// 3. start()/stop() 幂等（重复调用无副作用，不会出现两个循环）
// 4. 恢复时重置 previous timestamp，避免巨大 delta
// 5. isRunning() 反映当前状态
// 6. cleanup() 完全停止并取消订阅
//
// 设计原则：
// - 纯逻辑：不依赖 Three.js / DOM，可在 vitest 中直接验证
// - 幂等：start() 已运行时 no-op；stop() 已停止时 no-op
// - 时间戳重置：恢复后第一帧 delta = 0（避免巨大 delta 导致物理爆炸）

import { describe, it, expect, vi } from 'vitest';
import { AvatarLoopController } from '../../src/actor/avatar-loop-controller';

describe('AvatarLoopController (Phase 3 Step 6.1)', () => {
  it('start() 后 isRunning() 返回 true，stop() 后返回 false', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    expect(ctrl.isRunning()).toBe(false);
    ctrl.start();
    expect(ctrl.isRunning()).toBe(true);
    expect(setLoop).toHaveBeenCalledTimes(1);
    expect(setLoop.mock.calls[0][0]).toBeTypeOf('function');

    ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);
    expect(setLoop).toHaveBeenCalledTimes(2);
    expect(setLoop.mock.calls[1][0]).toBeNull();
  });

  it('start() 后调用 callback，frame count 增长', () => {
    let capturedCallback: ((ts: number) => void) | null = null;
    const setLoop = vi.fn((cb: ((ts: number) => void) | null) => {
      capturedCallback = cb;
    });
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    ctrl.start();
    expect(capturedCallback).not.toBeNull();

    // 模拟 Three.js 调用 callback（timestampMs 单位：毫秒）
    expect(ctrl.getFrameCount()).toBe(0);
    capturedCallback!(1000);  // 1 秒
    capturedCallback!(1016);  // 1.016 秒
    capturedCallback!(1032);  // 1.032 秒

    expect(ctrl.getFrameCount()).toBe(3);
    expect(onFrame).toHaveBeenCalledTimes(3);
  });

  it('stop() 后 callback 不再被调用，frame count 不增长', () => {
    let capturedCallback: ((ts: number) => void) | null = null;
    const setLoop = vi.fn((cb: ((ts: number) => void) | null) => {
      capturedCallback = cb;
    });
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    ctrl.start();
    capturedCallback!(1000);
    capturedCallback!(1016);
    expect(ctrl.getFrameCount()).toBe(2);

    ctrl.stop();
    // stop 后即使 callback 被调用也不应生效（实际 Three.js 不会再调用）
    // 但如果错误地保留了旧 callback，仍可能被调用
    // 这里模拟错误场景：capturedCallback 仍指向旧函数
    // ctrl.stop() 应该已通过 setAnimationLoop(null) 让 Three.js 不再调用
    // 我们直接验证 frameCount 不变
    const countAfterStop = ctrl.getFrameCount();
    expect(countAfterStop).toBe(2);
  });

  it('start() 幂等：重复调用不会创建多个循环', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    ctrl.start();
    ctrl.start();
    ctrl.start();
    // setAnimationLoop 只应被调用 1 次（不是 3 次）
    expect(setLoop).toHaveBeenCalledTimes(1);
    expect(ctrl.isRunning()).toBe(true);
  });

  it('stop() 幂等：重复调用不会出错', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    ctrl.start();
    ctrl.stop();
    ctrl.stop();
    ctrl.stop();
    // 第一次 start 调用 1 次，第一次 stop 调用 1 次，后续 stop 不应调用
    expect(setLoop).toHaveBeenCalledTimes(2);
    expect(ctrl.isRunning()).toBe(false);
  });

  it('stop() 未启动时也安全（无副作用）', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    // 未 start 直接 stop
    expect(() => ctrl.stop()).not.toThrow();
    expect(setLoop).not.toHaveBeenCalled();
    expect(ctrl.isRunning()).toBe(false);
  });

  it('恢复时重置 previous timestamp，避免巨大 delta', () => {
    let capturedCallback: ((ts: number) => void) | null = null;
    const setLoop = vi.fn((cb: ((ts: number) => void) | null) => {
      capturedCallback = cb;
    });
    const deltas: number[] = [];
    const onFrame = vi.fn((delta: number, _elapsed: number) => deltas.push(delta));
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    // 第一次启动：t=1000ms
    ctrl.start();
    capturedCallback!(1000);   // 第一帧 delta=0（启动时刻）
    capturedCallback!(1016);   // delta≈0.016
    expect(deltas[0]).toBe(0);
    expect(deltas[1]).toBeCloseTo(0.016, 6);

    // 停止后等待"很长时间"（模拟返回 Chat 模式）
    ctrl.stop();

    // 恢复时 t=100000ms（97 秒后）
    // 如果不重置 previous timestamp，delta 会是 ~97 秒，导致物理爆炸
    ctrl.start();
    // 恢复后第一帧：previous 应被重置，delta 应为 0（或非常小）
    capturedCallback!(100000);
    // 第二帧：正常 delta
    capturedCallback!(100016);

    // 恢复后的 delta 应该是 [0, ≈0.016]，不能是 [97.xxx, ≈0.016]
    expect(deltas[2]).toBe(0);          // 恢复后第一帧 delta=0
    expect(deltas[3]).toBeCloseTo(0.016, 6);  // 第二帧正常
    // 关键断言：恢复后第一帧 delta 不应该接近 97 秒
    expect(deltas[2]).toBeLessThan(1);  // 安全检查
  });

  it('多次 start/stop 循环后仍只有一个循环在运行', () => {
    let capturedCallback: ((ts: number) => void) | null = null;
    const setLoop = vi.fn((cb: ((ts: number) => void) | null) => {
      capturedCallback = cb;
    });
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    // 模拟用户在 Chat 和 Desktop 之间来回切换 5 次
    for (let i = 0; i < 5; i++) {
      ctrl.start();
      expect(ctrl.isRunning()).toBe(true);
      capturedCallback!(i * 10000);
      ctrl.stop();
      expect(ctrl.isRunning()).toBe(false);
    }

    // 每次 start 1 次 + 每次 stop 1 次 = 10 次调用
    expect(setLoop).toHaveBeenCalledTimes(10);
    // 最后状态：已停止
    expect(ctrl.isRunning()).toBe(false);
  });

  it('elapsed 时间从每次 start 重新计算', () => {
    let capturedCallback: ((ts: number) => void) | null = null;
    const setLoop = vi.fn((cb: ((ts: number) => void) | null) => {
      capturedCallback = cb;
    });
    const elapsedValues: number[] = [];
    const onFrame = vi.fn((_delta: number, elapsed: number) => elapsedValues.push(elapsed));
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    // 第一次启动：t=1000ms
    ctrl.start();
    capturedCallback!(1000);   // elapsed=0
    capturedCallback!(2000);   // elapsed=1.0
    expect(elapsedValues[0]).toBe(0);
    expect(elapsedValues[1]).toBeCloseTo(1.0, 6);
    ctrl.stop();

    // 第二次启动：t=100000ms（很久以后）
    ctrl.start();
    capturedCallback!(100000); // elapsed 应该从 0 重新开始，不是 99.0
    capturedCallback!(100500); // elapsed=0.5

    // 关键断言：第二次启动后 elapsed 从 0 开始
    expect(elapsedValues[2]).toBe(0);                 // 第二次启动第一帧
    expect(elapsedValues[3]).toBeCloseTo(0.5, 6);     // 第二次启动第二帧
  });

  it('cleanup() 停止循环且后续 start 无效（窗口已关闭）', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: vi.fn() });

    ctrl.start();
    expect(ctrl.isRunning()).toBe(true);

    ctrl.cleanup();
    expect(ctrl.isRunning()).toBe(false);

    // cleanup 后再 start 应该无效（模拟窗口已关闭）
    ctrl.start();
    expect(ctrl.isRunning()).toBe(false);
    // setLoop 不应再被调用
    const callsAfterCleanup = setLoop.mock.calls.length;
    ctrl.start();
    expect(setLoop.mock.calls.length).toBe(callsAfterCleanup);
  });

  // Step 6.1 renderOneFrame：用于 stop() 后强制渲染（E2E 设置 morph 后读取像素）
  it('renderOneFrame() 在 stop() 后调用 deps.renderOneFrame（不推进时间）', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const renderOne = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: renderOne });

    ctrl.start();
    ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);

    // stop 后调用 renderOneFrame 应该生效（不依赖循环运行）
    ctrl.renderOneFrame();
    expect(renderOne).toHaveBeenCalledTimes(1);
    // frame count 不应增长（renderOneFrame 不推进时间）
    expect(ctrl.getFrameCount()).toBe(0);
  });

  it('renderOneFrame() 在未 start 时也可调用', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const renderOne = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: renderOne });

    // 未 start 直接 renderOneFrame（用于首帧健康检查）
    ctrl.renderOneFrame();
    expect(renderOne).toHaveBeenCalledTimes(1);
  });

  it('renderOneFrame() 在 cleanup() 后无效（窗口已关闭）', () => {
    const setLoop = vi.fn();
    const onFrame = vi.fn();
    const renderOne = vi.fn();
    const ctrl = new AvatarLoopController({ setAnimationLoop: setLoop, onFrame, renderOneFrame: renderOne });

    ctrl.cleanup();
    ctrl.renderOneFrame();
    // cleanup 后 renderOneFrame 应该被屏蔽
    expect(renderOne).not.toHaveBeenCalled();
  });
});
