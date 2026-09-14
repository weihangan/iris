// Task 6 Step 1: avatar-frame-loop 单元测试
// 验证：
// 1. 调用顺序为 model → actor → life → render
// 2. delta 钳制到最大 0.05，避免窗口卡顿后物理爆炸
// 3. physicsEnabled 透传给 updateModel

import { describe, it, expect, vi } from 'vitest';
import { stepAvatarFrame, type AvatarFramePorts } from '../../src/actor/avatar-frame-loop';

describe('avatar-frame-loop (Task 6 Step 1)', () => {
  it('按顺序调用 updateModel → updateActor → updateLife → render', () => {
    const calls: string[] = [];
    const ports: AvatarFramePorts = {
      updateModel: () => calls.push('model'),
      updateActor: () => calls.push('actor'),
      updateLife: () => calls.push('life'),
      render: () => calls.push('render')
    };
    stepAvatarFrame(ports, 1.0, 0.016, false);
    expect(calls).toEqual(['model', 'actor', 'life', 'render']);
  });

  it('finalizePoseBeforeRender 在 updateLife 之后、render 之前调用', () => {
    const calls: string[] = [];
    const ports: AvatarFramePorts = {
      updateModel: () => calls.push('model'),
      updateActor: () => calls.push('actor'),
      updateLife: () => calls.push('life'),
      finalizePoseBeforeRender: () => calls.push('finalize'),
      render: () => calls.push('render')
    };
    stepAvatarFrame(ports, 1.0, 0.016, false);
    expect(calls).toEqual(['model', 'actor', 'life', 'finalize', 'render']);
  });

  it('未提供 finalizePoseBeforeRender 时帧仍正常完成', () => {
    const renderFn = vi.fn();
    const ports: AvatarFramePorts = {
      updateModel: () => {},
      updateActor: () => {},
      updateLife: () => {},
      render: renderFn
    };
    stepAvatarFrame(ports, 1.0, 0.016, false);
    expect(renderFn).toHaveBeenCalledTimes(1);
  });

  it('delta 超过 0.05 时钳制为 0.05（避免卡顿后物理爆炸）', () => {
    const receivedDelta: number[] = [];
    const ports: AvatarFramePorts = {
      updateModel: () => {},
      updateActor: (dt) => receivedDelta.push(dt),
      updateLife: (_elapsed, dt) => receivedDelta.push(dt),
      render: () => {}
    };
    // 模拟窗口卡顿：delta = 0.5（500ms）
    stepAvatarFrame(ports, 10.0, 0.5, false);
    expect(receivedDelta[0]).toBe(0.05);
    expect(receivedDelta[1]).toBe(0.05);
  });

  it('delta 负数时钳制为 0（避免时钟回退导致负向物理）', () => {
    const receivedDelta: number[] = [];
    const ports: AvatarFramePorts = {
      updateModel: () => {},
      updateActor: (dt) => receivedDelta.push(dt),
      updateLife: (_elapsed, dt) => receivedDelta.push(dt),
      render: () => {}
    };
    stepAvatarFrame(ports, 5.0, -0.1, false);
    expect(receivedDelta[0]).toBe(0);
    expect(receivedDelta[1]).toBe(0);
  });

  it('physicsEnabled 透传给 updateModel', () => {
    const modelCalls: Array<{ physics: boolean; ik: boolean }> = [];
    const ports: AvatarFramePorts = {
      updateModel: (_seconds, opts) => modelCalls.push(opts),
      updateActor: () => {},
      updateLife: () => {},
      render: () => {}
    };
    stepAvatarFrame(ports, 1.0, 0.016, true);
    stepAvatarFrame(ports, 2.0, 0.016, false);
    expect(modelCalls).toEqual([
      { physics: true, ik: true },
      { physics: false, ik: true }
    ]);
  });

  it('启用物理时先推进连续物理时钟，再更新模型', () => {
    const calls: string[] = [];
    const deltas: number[] = [];
    const ports: AvatarFramePorts = {
      advancePhysics: (dt) => {
        calls.push('physics-clock');
        deltas.push(dt);
      },
      updateModel: () => calls.push('model'),
      updateActor: () => calls.push('actor'),
      updateLife: () => calls.push('life'),
      render: () => calls.push('render')
    };

    stepAvatarFrame(ports, 1, 0.2, true);

    expect(calls).toEqual(['physics-clock', 'model', 'actor', 'life', 'render']);
    expect(deltas).toEqual([0.05]);
  });

  it('在模型采样和 Bullet step 前更新整体朝向', () => {
    const calls: string[] = [];
    const ports: AvatarFramePorts = {
      advancePhysics: () => calls.push('physics-clock'),
      updateOrientation: () => calls.push('orientation'),
      updateModel: () => calls.push('model'),
      updateActor: () => calls.push('actor'),
      updateLife: () => calls.push('life'),
      render: () => calls.push('render')
    };

    stepAvatarFrame(ports, 1, 0.016, true);

    expect(calls).toEqual(['orientation', 'physics-clock', 'model', 'actor', 'life', 'render']);
  });

  it('禁用物理时不推进连续物理时钟', () => {
    const advancePhysics = vi.fn();
    const ports: AvatarFramePorts = {
      advancePhysics,
      updateModel: () => {},
      updateActor: () => {},
      updateLife: () => {},
      render: () => {}
    };

    stepAvatarFrame(ports, 1, 0.016, false);

    expect(advancePhysics).not.toHaveBeenCalled();
  });

  it('elapsedSeconds 透传给 updateModel 和 updateLife', () => {
    const modelElapsed: number[] = [];
    const lifeElapsed: number[] = [];
    const ports: AvatarFramePorts = {
      updateModel: (seconds) => modelElapsed.push(seconds),
      updateActor: () => {},
      updateLife: (seconds) => lifeElapsed.push(seconds),
      render: () => {}
    };
    stepAvatarFrame(ports, 12.34, 0.016, false);
    expect(modelElapsed).toEqual([12.34]);
    expect(lifeElapsed).toEqual([12.34]);
  });

  it('正常 delta 0.016 不被钳制', () => {
    const receivedDelta: number[] = [];
    const ports: AvatarFramePorts = {
      updateModel: () => {},
      updateActor: (dt) => receivedDelta.push(dt),
      updateLife: (_elapsed, dt) => receivedDelta.push(dt),
      render: () => {}
    };
    stepAvatarFrame(ports, 1.0, 0.016, false);
    expect(receivedDelta[0]).toBe(0.016);
    expect(receivedDelta[1]).toBe(0.016);
  });

  it('每个端口都被调用恰好一次', () => {
    const modelFn = vi.fn();
    const actorFn = vi.fn();
    const lifeFn = vi.fn();
    const renderFn = vi.fn();
    const ports: AvatarFramePorts = {
      updateModel: modelFn,
      updateActor: actorFn,
      updateLife: lifeFn,
      render: renderFn
    };
    stepAvatarFrame(ports, 1.0, 0.016, false);
    expect(modelFn).toHaveBeenCalledTimes(1);
    expect(actorFn).toHaveBeenCalledTimes(1);
    expect(lifeFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledTimes(1);
  });
});
