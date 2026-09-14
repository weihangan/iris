import { describe, expect, it } from 'vitest';
import type {
  MmdPhysicsBackend,
  MmdPhysicsResetContext,
  MmdPhysicsStepContext
} from '@yohawing/three-mmd-loader/physics';
import { createContinuousMmdPhysicsBackend } from '../../src/physics/continuous-mmd-physics-backend';
import * as THREE from 'three';

function createDelegate() {
  const resets: MmdPhysicsResetContext[] = [];
  const steps: MmdPhysicsStepContext[] = [];
  const delegate: MmdPhysicsBackend = {
    name: 'fake-bullet',
    disabled: false,
    disposed: false,
    reset(context) {
      if (context) resets.push(context);
    },
    step(context) {
      steps.push(context);
      return { simulated: true, updatedBoneCount: 0 };
    }
  };
  return { delegate, resets, steps };
}

describe('ContinuousMmdPhysicsBackend', () => {
  it('applies head overlay rotations to Bullet input without touching body or dynamic descendants', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const identity = new THREE.Matrix4();
    const input = new Float32Array(5 * 16);
    for (let index = 0; index < 5; index += 1) identity.toArray(input, index * 16);
    const neckDelta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, THREE.MathUtils.degToRad(2.5))
    );
    const headDelta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, THREE.MathUtils.degToRad(7.5))
    );

    backend.setBoneRotationOverlays(new Map([
      ['首', neckDelta.toArray() as [number, number, number, number]],
      ['頭', headDelta.toArray() as [number, number, number, number]]
    ]));
    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [
        { index: 0, name: '全ての親', parentIndex: -1 },
        { index: 1, name: '首', parentIndex: 0 },
        { index: 2, name: '頭', parentIndex: 1 },
        { index: 3, name: '髪1', parentIndex: 2 },
        { index: 4, name: '左足', parentIndex: 0 }
      ] },
      inputWorldMatricesColumnMajor: input
    });

    const delegated = steps[0].inputWorldMatricesColumnMajor as Float32Array;
    const rotationAt = (index: number) => new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().fromArray(delegated, index * 16)
    );
    expect(THREE.MathUtils.radToDeg(new THREE.Quaternion().angleTo(rotationAt(1))))
      .toBeCloseTo(2.5, 4);
    expect(THREE.MathUtils.radToDeg(new THREE.Quaternion().angleTo(rotationAt(2))))
      .toBeCloseTo(10, 4);
    expect(new THREE.Quaternion().angleTo(rotationAt(3))).toBeLessThan(1e-8);
    expect(new THREE.Quaternion().angleTo(rotationAt(4))).toBeLessThan(1e-8);
    expect(input).toEqual(new Float32Array(Array.from({ length: 5 }, () => identity.elements).flat()));
  });

  it('does not rewrite authored secondary motion during a pose transition', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const output = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    const context = {
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'dynamic-root', parentIndex: -1 }] },
      inputWorldMatricesColumnMajor: new Float32Array(output),
      rigidBodies: [{
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
      }],
      output: {
        translations: new Float32Array([0, 0, 0]),
        rotations: new Float32Array([0, 0, 0, 1]),
        worldMatricesColumnMajor: output
      }
    };
    backend.advance(1 / 60);
    backend.step(context);

    backend.setTransitionActive(true);
    new THREE.Matrix4().makeRotationZ(Math.PI).setPosition(5, 3, 0).toArray(output);
    context.output.translations.set([5, 3, 0]);
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)
      .toArray(context.output.rotations);
    backend.advance(1 / 60);
    backend.step({ ...context, seconds: 1 / 60, frame: 0.5 });

    expect(Array.from(output).slice(12, 15)).toEqual([5, 3, 0]);
    expect(Array.from(context.output.translations)).toEqual([5, 3, 0]);
    expect(new THREE.Quaternion(...Array.from(context.output.rotations) as [number, number, number, number])
      .angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)))
      .toBeLessThan(1e-6);
    expect(backend.diagnosticsState()).toMatchObject({
      transitionStabilizationActive: true
    });
    expect(backend.diagnosticsState().clampedDynamicOutputCount).toBe(0);

    backend.setTransitionActive(false);
    expect(backend.diagnosticsState().transitionStabilizationActive).toBe(true);
    expect(backend.diagnosticsState().transitionSettleRemainingSeconds).toBeGreaterThanOrEqual(0.55);
    for (let step = 0; step < 16; step += 1) backend.advance(0.05);
    expect(backend.diagnosticsState().transitionStabilizationActive).toBe(false);
    expect(backend.diagnosticsState().transitionSettleRemainingSeconds).toBe(0);
  });

  it('leaves coarse-frame secondary output under PMX physics ownership during transitions', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const output = new Float32Array(new THREE.Matrix4().elements);
    const context = {
      seconds: 0,
      deltaSeconds: 0.05,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'dynamic-root', parentIndex: -1 }] },
      inputWorldMatricesColumnMajor: new Float32Array(output),
      rigidBodies: [{
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
      }],
      output: {
        translations: new Float32Array([0, 0, 0]),
        rotations: new Float32Array([0, 0, 0, 1]),
        worldMatricesColumnMajor: output
      }
    };

    backend.advance(0.05);
    backend.step(context);
    backend.setTransitionActive(true);
    new THREE.Matrix4().makeTranslation(0, 4, 0).toArray(output);
    context.output.translations[1] = 4;
    backend.advance(0.05);
    backend.step({ ...context, seconds: 0.05, frame: 1.5 });

    expect(output[13]).toBeCloseTo(4, 6);
    expect(context.output.translations[1]).toBeCloseTo(4, 6);
    expect(backend.diagnosticsState().clampedDynamicOutputCount).toBe(0);
  });

  it('keeps stabilization for a 550ms settle tail without resetting Bullet', () => {
    const { delegate, resets } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.setTransitionActive(true);
    backend.advance(0.1);
    backend.setTransitionActive(false);
    for (let step = 0; step < 9; step += 1) backend.advance(0.05);
    expect(backend.diagnosticsState().transitionStabilizationActive).toBe(true);
    for (let step = 0; step < 3; step += 1) backend.advance(0.05);
    expect(backend.diagnosticsState().transitionStabilizationActive).toBe(false);
    expect(resets).toHaveLength(0);
  });

  it('ends the artificial transition tail before 650ms while preserving Bullet state', () => {
    const { delegate, resets } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.setTransitionActive(true);
    backend.advance(0.1);
    backend.setTransitionActive(false);
    for (let step = 0; step < 12; step += 1) backend.advance(0.05);

    expect(backend.diagnosticsState().transitionStabilizationActive).toBe(false);
    expect(resets).toHaveLength(0);
  });

  it('steps Bullet in model-local space when loader matrices already include the dragged root', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const input = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      4, 6, 3, 1
    ]);

    backend.setModelWorldOffset(3, 4, 0);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      inputWorldMatricesColumnMajor: input
    });

    expect(Array.from(steps[0].inputWorldMatricesColumnMajor ?? []).slice(12, 15)).toEqual([1, 2, 3]);
    expect(Array.from(input).slice(12, 15)).toEqual([4, 6, 3]);
  });

  it('does not subtract the desktop root twice from pre-physics model-local matrices', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const input = new Float32Array(new THREE.Matrix4().makeTranslation(1, 2, 3).elements);
    const output = new Float32Array(input);

    backend.setModelWorldOffset(3, 4, 0);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'root', parentIndex: -1 }] },
      inputTranslations: new Float32Array([1, 2, 3]),
      inputWorldMatricesColumnMajor: input,
      output: { worldMatricesColumnMajor: output }
    });

    expect(Array.from(steps[0].inputWorldMatricesColumnMajor ?? []).slice(12, 15))
      .toEqual([1, 2, 3]);
    expect(Array.from(output).slice(12, 15)).toEqual([1, 2, 3]);
    expect(backend.diagnosticsState().lastInputMatrixSpace).toBe('model-local');
  });

  it('removes the shared model-root yaw before Bullet simulation without mutating loader matrices', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const sceneYaw = THREE.MathUtils.degToRad(-12);
    const mmdRoot = new THREE.Matrix4().makeRotationY(-sceneYaw);
    mmdRoot.setPosition(3, 4, 0);
    const local = new THREE.Matrix4().makeTranslation(1, 2, 3);
    const scene = mmdRoot.clone().multiply(local);
    const input = new Float32Array(scene.elements);

    backend.setModelWorldTransform(3, 4, 0, sceneYaw);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      inputWorldMatricesColumnMajor: input
    });

    const normalized = new THREE.Matrix4().fromArray(
      Array.from(steps[0].inputWorldMatricesColumnMajor ?? [])
    );
    const normalizedPosition = new THREE.Vector3().setFromMatrixPosition(normalized);
    const normalizedRotation = new THREE.Quaternion().setFromRotationMatrix(normalized);
    expect(normalizedPosition.x).toBeCloseTo(1, 5);
    expect(normalizedPosition.y).toBeCloseTo(2, 5);
    expect(normalizedPosition.z).toBeCloseTo(3, 5);
    expect(normalizedRotation.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    expect(Array.from(input)).toEqual(Array.from(new Float32Array(scene.elements)));
  });

  it('converts root velocity into a bounded local inertia driver instead of a scene-sized pull', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const initialInput = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);
    backend.step({ seconds: 0, deltaSeconds: 1 / 60, frame: 0, frameRate: 30, inputWorldMatricesColumnMajor: initialInput });

    const movedInput = initialInput.slice();
    movedInput[12] = 3;
    backend.setModelWorldOffset(3, 0, 0);
    backend.advance(1 / 60);
    backend.step({ seconds: 1 / 60, deltaSeconds: 1 / 60, frame: 0.5, frameRate: 30, inputWorldMatricesColumnMajor: movedInput });

    const localDriverX = steps[1].inputWorldMatricesColumnMajor?.[12] ?? 0;
    expect(localDriverX).toBeGreaterThan(0);
    expect(localDriverX).toBeLessThanOrEqual(0.11);
    expect(Array.from(movedInput).slice(12, 15)).toEqual([3, 0, 0]);
  });

  it('keeps a visible bounded inertia response during sustained root dragging', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);

    for (let frame = 1; frame <= 30; frame += 1) {
      backend.setModelWorldOffset(frame * 0.2, 0, 0);
      backend.advance(1 / 60);
    }

    const diagnostics = backend.diagnosticsState();
    expect(diagnostics.rootInertiaDriver[0]).toBeGreaterThan(0.24);
    expect(diagnostics.rootInertiaDriver[0]).toBeLessThanOrEqual(0.3);
    expect(diagnostics.modelWorldOffset[0]).toBeCloseTo(6, 6);
  });

  it('ramps the drag inertia injection at a followable slew instead of a one-frame teleport', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);

    // 单帧 3 单位的猛烈拖动：无斜率限制时惯性驱动一帧内可跳约 0.085
    // （≈一整段裙摆骨骼长度），Bullet 关节解算会以爆炸性冲量把多段裙摆
    // 链交叉折叠成 Z 形并永久卡住。斜率限制后单帧注入必须小到链段可跟随。
    backend.setModelWorldOffset(3, 0, 0);
    backend.advance(1 / 60);
    const firstFrameDriver = backend.diagnosticsState().rootInertiaDriver[0];
    expect(firstFrameDriver).toBeGreaterThan(0);
    expect(firstFrameDriver).toBeLessThanOrEqual(0.03);

    // 持续拖动约半秒仍达到可见的满摆幅：鲜活度不变，只是起摆更柔和。
    for (let frame = 2; frame <= 30; frame += 1) {
      backend.setModelWorldOffset(3 + frame * 0.2, 0, 0);
      backend.advance(1 / 60);
    }
    expect(backend.diagnosticsState().rootInertiaDriver[0]).toBeGreaterThan(0.24);

    // 松手后的泄压同样受限速：反向瞬移会让裙摆二次折叠。
    backend.setModelWorldOffset(3 + 30 * 0.2, 0, 0);
    backend.advance(1 / 60);
    const releasedDriver = backend.diagnosticsState().rootInertiaDriver[0];
    expect(releasedDriver).toBeGreaterThanOrEqual(0.21);
    expect(releasedDriver).toBeLessThan(0.3);
  });

  it('low-pass smooths the render-frame delta fed to Bullet so idle skirt chains do not stutter', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const input = new Float32Array(16);
    new THREE.Matrix4().toArray(input, 0);
    const skeleton = { bones: [{ index: 0, name: '全ての親', parentIndex: -1 }] };
    const stepAt = (seconds: number, deltaSeconds: number) => backend.step({
      seconds,
      deltaSeconds,
      frame: Math.round(seconds * 30),
      frameRate: 30,
      skeleton,
      inputWorldMatricesColumnMajor: input
    });

    // 先走一帧普通时间线，再让 idle VMD 循环回卷：此后 Bullet 的步长改用
    // advance() 传入的渲染帧 delta（continuousContext.deltaSeconds）。
    backend.advance(0.017);
    stepAt(0.017, 0.017);
    backend.advance(0.017);
    stepAt(0, 0.017);
    expect(backend.diagnosticsState().loopWrapCount).toBe(1);

    // 60fps 边缘的交替帧耗时（vsync 抖动，婚皮这类重模型的典型负载波动）：
    // 原实现把 1.4ms 的波动原样传给 Bullet，固定步长累积器因此交替执行
    // 1/0 个子步——裙摆位置隔帧更新，待机时读作持续高频抖动。平滑后
    // Bullet 看到的相邻步长波动必须远小于原始波动。
    for (let frame = 0; frame < 12; frame += 1) {
      backend.advance(frame % 2 === 0 ? 0.017 : 0.0156);
      stepAt(0.017 + frame * 0.017, 0.017);
    }
    const delegatedDeltas = steps.slice(-4).map(step => step.deltaSeconds);
    const smoothedSwing = Math.max(...delegatedDeltas) - Math.min(...delegatedDeltas);
    const rawSwing = 0.017 - 0.0156;
    expect(smoothedSwing).toBeLessThan(rawSwing * 0.35);

    // 平滑不改变长期节奏：连续多帧后步长收敛到平均帧耗时附近。
    const averageDelta = (0.017 + 0.0156) / 2;
    for (const delta of delegatedDeltas) {
      expect(Math.abs(delta - averageDelta)).toBeLessThan(0.0005);
    }
  });

  it('keeps long-run physics time close to wall-clock while smoothing frame deltas', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    let wallSeconds = 0;
    // 交替帧耗时下 EMA 的均值≈输入均值：500 帧后单调物理时间与真实流逝
    // 时间的偏差必须小于 5%，平滑不会系统性吞掉或凭空增加物理时间。
    for (let frame = 0; frame < 500; frame += 1) {
      const delta = frame % 2 === 0 ? 0.017 : 0.0156;
      backend.advance(delta);
      wallSeconds += delta;
    }
    const monotonicSeconds = backend.diagnosticsState().monotonicSeconds;
    expect(Math.abs(monotonicSeconds - wallSeconds) / wallSeconds).toBeLessThan(0.05);
  });

  it('does not rewrite Bullet-owned hair and clothing output during root dragging', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const output = new Float32Array(new THREE.Matrix4().elements);
    const context = {
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: {
        bones: [{ index: 0, name: 'Bone_Hair003_M', parentIndex: -1 }]
      },
      inputWorldMatricesColumnMajor: new Float32Array(output),
      rigidBodies: [{
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'capsule' as const, size: [0.1, 0.5, 0.1] as const }
      }],
      output: {
        translations: new Float32Array([0, 0, 0]),
        rotations: new Float32Array([0, 0, 0, 1]),
        worldMatricesColumnMajor: output
      }
    };

    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);
    backend.step(context);

    // Simulate a light, long Bullet chain attempting to remain at its old
    // scene position while the visible model root advances by three units.
    backend.setModelWorldOffset(3, 0, 0);
    backend.advance(1 / 60);
    new THREE.Matrix4().makeTranslation(-3, 0, 0).toArray(output);
    context.output.translations[0] = -3;
    backend.step({ ...context, seconds: 1 / 60, frame: 0.5 });

    expect(output[12]).toBeCloseTo(0, 6);
    expect(context.output.translations[0]).toBeCloseTo(-3, 6);
    expect(backend.diagnosticsState()).toMatchObject({
      rootDragStabilizationActive: true,
      clampedRootDragOutputCount: 0
    });
  });

  it('does not clamp ordinary secondary motion when the model root is stationary', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const output = new Float32Array(new THREE.Matrix4().elements);
    const context = {
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'coat_0_7', parentIndex: -1 }] },
      inputWorldMatricesColumnMajor: new Float32Array(output),
      rigidBodies: [{
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
      }],
      output: {
        translations: new Float32Array([0, 0, 0]),
        rotations: new Float32Array([0, 0, 0, 1]),
        worldMatricesColumnMajor: output
      }
    };

    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);
    backend.step(context);
    backend.advance(1 / 60);
    new THREE.Matrix4().makeTranslation(0.4, 0, 0).toArray(output);
    context.output.translations[0] = 0.4;
    backend.step({ ...context, seconds: 1 / 60, frame: 0.5 });

    expect(output[12]).toBeCloseTo(0.4, 6);
    expect(context.output.translations[0]).toBeCloseTo(0.4, 6);
    expect(backend.diagnosticsState().clampedRootDragOutputCount).toBe(0);
  });

  it('leaves accumulated drag response in Bullet state for the final root-only guard', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const output = new Float32Array(new THREE.Matrix4().elements);
    const context = {
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'M_BHair_5', parentIndex: -1 }] },
      inputWorldMatricesColumnMajor: new Float32Array(output),
      rigidBodies: [{
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'capsule' as const, size: [0.1, 0.5, 0.1] as const }
      }],
      output: {
        translations: new Float32Array([0, 0, 0]),
        rotations: new Float32Array([0, 0, 0, 1]),
        worldMatricesColumnMajor: output
      }
    };

    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);
    backend.step(context);
    for (let frame = 1; frame <= 30; frame += 1) {
      backend.setModelWorldOffset(frame * 0.1, 0, 0);
      backend.advance(1 / 60);
      new THREE.Matrix4()
        .makeRotationZ(0.8)
        .setPosition(-3, 0, 0)
        .toArray(output);
      context.output.translations[0] = -3;
      context.output.rotations.set([0, 0, Math.sin(0.4), Math.cos(0.4)]);
      backend.step({ ...context, seconds: frame / 60, frame: frame / 2 });
    }

    const appliedRotation = new THREE.Quaternion(
      context.output.rotations[0],
      context.output.rotations[1],
      context.output.rotations[2],
      context.output.rotations[3]
    );
    expect(context.output.translations[0]).toBeCloseTo(-3, 6);
    expect(appliedRotation.angleTo(new THREE.Quaternion())).toBeCloseTo(0.8, 5);
  });

  it('preserves authored dynamic-body damping without changing source data', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const dynamicBody = {
      index: 0,
      name: 'hair',
      boneIndex: 1,
      motionType: 'dynamic' as const,
      shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
      linearDamping: 1,
      angularDamping: 1.5
    };
    const staticBody = {
      ...dynamicBody,
      index: 1,
      name: 'body-collider',
      boneIndex: 0,
      motionType: 'static' as const
    };

    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'root' }, { index: 1, name: 'hair' }] },
      rigidBodies: [dynamicBody, staticBody]
    });

    expect(steps[0].rigidBodies?.[0].linearDamping).toBe(1);
    expect(steps[0].rigidBodies?.[0].angularDamping).toBe(1.5);
    expect(steps[0].rigidBodies?.[1].linearDamping).toBe(1);
    expect(dynamicBody.linearDamping).toBe(1);
    expect(dynamicBody.angularDamping).toBe(1.5);
  });

  it('passes the shared secondary material profile into Bullet for connected new-model chains', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const root = {
      index: 0,
      name: 'hair-root',
      boneIndex: 1,
      motionType: 'dynamic' as const,
      shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
      mass: 1,
      linearDamping: 0.95,
      angularDamping: 0.95
    };
    const tip = { ...root, index: 1, name: 'hair-tip', boneIndex: 2 };
    const leg = { ...root, index: 2, name: 'leg', boneIndex: 3 };
    const rigidBodies = [root, tip, leg];

    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [
        { index: 0, name: 'root', parentIndex: -1 },
        { index: 1, name: '髪_01', parentIndex: 0 },
        { index: 2, name: '髪_02', parentIndex: 1 },
        { index: 3, name: '左足', parentIndex: 0 }
      ] },
      rigidBodies,
      joints: [{ index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 }]
    });

    const delegated = steps[0].rigidBodies ?? [];
    expect(delegated[0]).toBe(root);
    expect(delegated[1].linearDamping).toBeLessThan(0.95);
    expect(delegated[1].angularDamping).toBeLessThan(0.95);
    expect(delegated[2]).toBe(leg);
    expect(root.linearDamping).toBe(0.95);
  });

  it('disables collisions for small decorative ribbons while preserving gravity and bone output', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const rigidBodies = [
      {
        index: 0,
        name: '上半身',
        boneIndex: 0,
        motionType: 'static' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
      },
      {
        index: 1,
        name: '裙摆_0',
        boneIndex: 1,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
      },
      {
        index: 2,
        name: '左后缎带_0_1',
        boneIndex: 2,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
        mass: 0.1
      },
      {
        index: 3,
        name: '左后缎带_1_1',
        boneIndex: 3,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
        mass: 0.1
      }
    ];

    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [
        { index: 0, name: '上半身', parentIndex: -1 },
        { index: 1, name: '裙摆_0', parentIndex: 0 },
        { index: 2, name: '左后缎带_0_1', parentIndex: 1 },
        { index: 3, name: '左后缎带_1_1', parentIndex: 2 }
      ] },
      rigidBodies,
      joints: [
        { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
        { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
        { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3 }
      ],
      bonePhysicsToggles: new Uint8Array([1, 1, 1, 1])
    });

    const toggles = steps[0].bonePhysicsToggles as Uint8Array;
    expect(toggles[1]).toBe(1);
    expect(toggles[2]).toBe(1);
    expect(toggles[3]).toBe(1);
    expect(steps[0].rigidBodies?.[1].collisionMask).not.toBe(0);
    expect(steps[0].rigidBodies?.[2].collisionMask).toBe(0);
    expect(steps[0].rigidBodies?.[3].collisionMask).toBe(0);
    expect(backend.diagnosticsState().decorativeCollisionDisabledBodyCount).toBe(2);
  });


  it('preserves authored PMX mass, damping and angular springs', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const heavyDynamicBody = {
      index: 0,
      name: 'authored-heavy-hair',
      boneIndex: 1,
      motionType: 'dynamic' as const,
      shape: { type: 'capsule' as const, size: [0.2, 0.5, 0.2] as const },
      mass: 20,
      linearDamping: 1,
      angularDamping: 1.5
    };
    const stiffJoint = {
      index: 0,
      rigidBodyIndexA: 0,
      rigidBodyIndexB: 0,
      spring: {
        linear: [4, 5, 6] as const,
        angular: [10, 220, -20] as const
      }
    };

    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [{ index: 0, name: 'root' }, { index: 1, name: 'hair' }] },
      rigidBodies: [heavyDynamicBody],
      joints: [stiffJoint]
    });

    expect(steps[0].rigidBodies?.[0]).toBe(heavyDynamicBody);
    expect(steps[0].joints?.[0].spring?.linear).toEqual([4, 5, 6]);
    expect(steps[0].joints?.[0]).toBe(stiffJoint);
    expect(heavyDynamicBody.mass).toBe(20);
    expect(stiffJoint.spring.angular).toEqual([10, 220, -20]);
  });

  it('reports different authored dynamic-body mass distributions without rewriting them', () => {
    const run = (masses: number[]) => {
      const { delegate, steps } = createDelegate();
      const backend = createContinuousMmdPhysicsBackend(delegate);
      backend.step({
        seconds: 0,
        deltaSeconds: 1 / 60,
        frame: 0,
        frameRate: 30,
        rigidBodies: masses.map((mass, index) => ({
          index,
          name: `dynamic-${index}`,
          boneIndex: index,
          motionType: 'dynamic' as const,
          shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
          mass,
          linearDamping: 0.8,
          angularDamping: 0.8
        }))
      });
      const effective = (steps[0].rigidBodies ?? []).map(body => body.mass ?? 0).sort((a, b) => a - b);
      return { median: effective[Math.floor(effective.length / 2)], diagnostics: backend.diagnosticsState() };
    };

    const heavy = run([4, 6, 8]);
    const light = run([0.2, 0.4, 0.8]);
    expect(heavy.median).toBe(6);
    expect(light.median).toBe(0.4);
    expect(heavy.diagnostics.authoredDynamicMedianMass).toBe(6);
    expect(light.diagnostics.authoredDynamicMedianMass).toBe(0.4);
    expect(heavy.diagnostics.effectiveDynamicMedianMass).toBe(6);
    expect(light.diagnostics.effectiveDynamicMedianMass).toBe(0.4);
    expect(heavy.diagnostics.dynamicMassScale).toBe(1);
    expect(light.diagnostics.dynamicMassScale).toBe(1);
  });

  it('uses the same visible but attachment-safe drag inertia ceiling for every model', () => {
    const { delegate } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    backend.setModelWorldOffset(0, 0, 0);
    backend.advance(1 / 60);
    for (let frame = 1; frame <= 30; frame += 1) {
      backend.setModelWorldOffset(frame * 0.6, 0, 0);
      backend.advance(1 / 60);
    }

    expect(backend.diagnosticsState().rootInertiaDriver[0]).toBeGreaterThan(0.2);
    expect(backend.diagnosticsState().rootInertiaDriver[0]).toBeLessThanOrEqual(0.3);
  });

  it('keeps artificial root inertia uniform for every model without rewriting PMX physics', () => {
    const run = (mass: number) => {
      const { delegate, steps } = createDelegate();
      const backend = createContinuousMmdPhysicsBackend(delegate);
      const rigidBody = {
        index: 0,
        boneIndex: 0,
        motionType: 'dynamic' as const,
        shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
        mass,
        linearDamping: 1,
        angularDamping: 1
      };
      backend.step({
        seconds: 0,
        deltaSeconds: 1 / 60,
        frame: 0,
        frameRate: 30,
        rigidBodies: [rigidBody]
      });
      return { diagnostics: backend.diagnosticsState(), rigidBody, delegated: steps[0].rigidBodies?.[0] };
    };

    const yangyangReference = run(0.4049564);
    const selenaReference = run(6.7);

    expect(yangyangReference.diagnostics.rootInertiaScale).toBeCloseTo(1, 6);
    expect(selenaReference.diagnostics.rootInertiaScale).toBeCloseTo(1, 6);
    expect(yangyangReference.delegated).toBe(yangyangReference.rigidBody);
    expect(selenaReference.delegated).toBe(selenaReference.rigidBody);
    expect(selenaReference.rigidBody.mass).toBe(6.7);
  });

  it('keeps Bullet advancing when pose lock freezes the VMD timeline', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.advance(0.016);
    backend.step({ seconds: 1, deltaSeconds: 0.016, frame: 30, frameRate: 30, seeking: false });
    backend.advance(0.018);
    backend.step({ seconds: 1, deltaSeconds: 0, frame: 30, frameRate: 30, seeking: false });

    expect(steps[1].seconds).toBeGreaterThan(steps[0].seconds);
    // 帧 delta 低通平滑后，Bullet 在 EMA 收敛期内看到的步长介于上一帧
    // 与本帧输入之间（0.016 < delta <= 0.018），方向仍是持续前进。
    expect(steps[1].deltaSeconds).toBeGreaterThan(0.016);
    expect(steps[1].deltaSeconds).toBeLessThanOrEqual(0.018);
    expect(steps[1].seeking).toBe(false);
  });

  it('keeps one Bullet model identity while parsed bridges and VMD runtimes replace equivalent arrays', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const skeleton = { bones: [{ index: 0, name: 'root' }] };
    const rigidBodies = [{
      index: 0,
      boneIndex: 0,
      motionType: 'static' as const,
      shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const }
    }];
    const joints = [{
      index: 0,
      rigidBodyIndexA: 0,
      rigidBodyIndexB: 0
    }];

    backend.step({ seconds: 1, deltaSeconds: 1 / 60, frame: 30, frameRate: 30, skeleton, rigidBodies, joints });
    backend.beginSpeechContinuity();
    backend.advance(1 / 60);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      skeleton: { bones: [...skeleton.bones] },
      rigidBodies: rigidBodies.map(body => ({ ...body })),
      joints: joints.map(joint => ({ ...joint }))
    });

    expect(steps[1].rigidBodies).toBe(steps[0].rigidBodies);
    expect(steps[1].joints).toBe(steps[0].joints);
    expect(backend.diagnosticsState().stabilizedModelIdentityCount).toBe(1);
  });

  it('adopts the first VMD runtime identity of each new speech session without resetting Bullet', () => {
    const { delegate, resets, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const idleBodies = [{ index: 0, boneIndex: 0, motionType: 'dynamic' }] as any;
    const idleJoints = [{ index: 0 }] as any;
    const firstSpeechBodies = [{ index: 0, boneIndex: 0, motionType: 'dynamic' }] as any;
    const firstSpeechJoints = [{ index: 0 }] as any;
    const secondSpeechBodies = [{ index: 0, boneIndex: 0, motionType: 'dynamic' }] as any;
    const secondSpeechJoints = [{ index: 0 }] as any;

    backend.step({
      seconds: 2,
      deltaSeconds: 1 / 60,
      frame: 60,
      frameRate: 30,
      rigidBodies: idleBodies,
      joints: idleJoints
    });

    backend.beginSpeechContinuity();
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    backend.advance(1 / 60);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      rigidBodies: firstSpeechBodies,
      joints: firstSpeechJoints,
      seeking: true
    });
    backend.endSpeechContinuity();

    backend.beginSpeechContinuity();
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    backend.advance(1 / 60);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      rigidBodies: secondSpeechBodies,
      joints: secondSpeechJoints,
      seeking: true
    });

    expect(resets).toHaveLength(0);
    expect(steps[1].rigidBodies).not.toBe(firstSpeechBodies);
    expect(steps[1].joints).not.toBe(firstSpeechJoints);
    expect(steps[2].rigidBodies).not.toBe(secondSpeechBodies);
    expect(steps[2].joints).not.toBe(secondSpeechJoints);
    expect(steps[1].rigidBodies).toBe(steps[2].rigidBodies);
    expect(steps[1].joints).toBe(steps[2].joints);
  });

  it('exposes the latest animation input, Bullet body, and physics output matrices by bone name', () => {
    const { delegate } = createDelegate();
    delegate.debugRigidBodyWorldTransformsColumnMajor = () => [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]
    ];
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const input = new Float32Array(32);
    const output = new Float32Array(32);
    input.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], 16);
    output.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4, 5, 6, 1], 16);

    backend.step({
      seconds: 1,
      deltaSeconds: 1 / 60,
      frame: 30,
      frameRate: 30,
      skeleton: {
        bones: [
          { index: 0, name: 'root' },
          { index: 1, name: 'runtime-dress-tip', parentIndex: 0 }
        ]
      },
      rigidBodies: [{
        index: 0,
        name: 'Dress_10_7',
        boneIndex: 1,
        motionType: 'dynamic',
        shape: { type: 'sphere', size: [0.1, 0.1, 0.1] }
      }],
      inputWorldMatricesColumnMajor: input,
      bonePhysicsToggles: new Uint8Array([1, 0]),
      output: { worldMatricesColumnMajor: output }
    });

    expect(backend.debugBonePhysicsPipeline(['Dress_10_7'])).toEqual([{
      boneName: 'Dress_10_7',
      boneIndex: 1,
      parentBoneIndex: 0,
      anchoredToAnimatedParent: true,
      physicsEnabled: false,
      rigidBodies: [{
        rigidBodyIndex: 0,
        rigidBodyName: 'Dress_10_7',
        motionType: 'dynamic',
        worldMatrixColumnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]
      }],
      inputWorldMatrixColumnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
      outputWorldMatrixColumnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4, 5, 6, 1],
      relativePhysicsDisplacement: [3, 3, 3]
    }]);
  });

  it('forces only configured bone physics toggles off without mutating the caller buffer', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const callerToggles = new Uint8Array([1, 1, 0, 1]);

    backend.setDisabledBoneNames(['HeadJew_1', '左Bhair_D_9', 'missing-bone']);
    backend.step({
      seconds: 0,
      deltaSeconds: 1 / 60,
      frame: 0,
      frameRate: 30,
      skeleton: {
        bones: [
          { index: 0, name: 'root' },
          { index: 1, name: 'HeadJew_1', parentIndex: 0 },
          { index: 2, name: 'stable-hair', parentIndex: 0 },
          { index: 3, name: '左Bhair_D_9', parentIndex: 0 }
        ]
      },
      bonePhysicsToggles: callerToggles
    });

    expect([...(steps[0].bonePhysicsToggles ?? [])].map(value => Number(value))).toEqual([1, 0, 0, 0]);
    expect(Array.from(callerToggles)).toEqual([1, 1, 0, 1]);
    expect(steps[0].bonePhysicsToggles).not.toBe(callerToggles);
  });

  it('suppresses resets only during speech continuity and preserves idle/preview resets', () => {
    const { delegate, resets } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });

    // Outside real-time speech the adapter is transparent. Idle and preview
    // keep the loader's existing reset behavior.
    expect(resets).toHaveLength(2);

    backend.beginSpeechContinuity();
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    expect(resets).toHaveLength(2);
    expect(backend.diagnosticsState()).toMatchObject({
      forwardedResetCount: 2,
      suppressedResetCount: 1,
      speechContinuityActive: true
    });

    backend.requestHardReset('visibility-resume');
    backend.reset?.({ seconds: 2, frame: 60, frameRate: 30 });

    expect(resets).toHaveLength(3);
    expect(backend.diagnosticsState()).toMatchObject({
      forwardedResetCount: 3,
      suppressedResetCount: 1,
      lastHardResetReason: 'visibility-resume'
    });

    backend.endSpeechContinuity();
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    expect(resets).toHaveLength(4);
  });

  it('uses a monotonic clock across a speech VMD wrap but is transparent outside speech', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.advance(0.016);
    backend.step({ seconds: 8, deltaSeconds: 0.016, frame: 240, frameRate: 30 });
    expect(steps[0]).toMatchObject({ seconds: 8, deltaSeconds: 0.016 });
    expect(steps[0]).not.toHaveProperty('seeking');

    backend.beginSpeechContinuity();
    backend.advance(0.016);
    backend.step({ seconds: 4.98, deltaSeconds: 0.016, frame: 149.4, frameRate: 30 });
    backend.advance(0.2);
    backend.step({ seconds: 0.02, deltaSeconds: 0, frame: 0.6, frameRate: 30, seeking: true });

    expect(steps).toHaveLength(3);
    expect(steps[1].seconds).toBeCloseTo(8.016, 6);
    // 帧 delta 低通平滑：大帧耗（0.05s）在 EMA 收敛期内只释放部分步长，
    // 单调时钟仍持续前进且不 seek——wrap 后的连续性契约不变。
    expect(steps[2].seconds).toBeGreaterThan(8.016);
    expect(steps[2].seconds).toBeLessThanOrEqual(8.066);
    expect(steps[2].deltaSeconds).toBeGreaterThan(0);
    expect(steps[2].frame).toBeGreaterThan(steps[1].frame);
    expect(steps[2].frame).toBeCloseTo(steps[2].seconds * steps[2].frameRate, 6);
    expect(steps[2].seeking).toBe(false);
    expect(backend.diagnosticsState().loopWrapCount).toBe(1);
  });

  it('does not rewind the Bullet clock when speech starts after an idle loop', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.advance(0.016);
    backend.step({ seconds: 4.98, deltaSeconds: 0.016, frame: 149.4, frameRate: 30 });
    backend.advance(0.018);
    backend.step({ seconds: 0.02, deltaSeconds: 0, frame: 0.6, frameRate: 30, seeking: true });
    const beforeSpeech = steps.at(-1)?.seconds ?? 0;

    backend.beginSpeechContinuity();
    backend.advance(0.016);
    backend.step({ seconds: 0, deltaSeconds: 0, frame: 0, frameRate: 30, seeking: true });

    expect(steps.at(-1)?.seconds).toBeGreaterThan(beforeSpeech);
    expect(backend.diagnosticsState().lastDelegatedSeconds).toBeGreaterThan(beforeSpeech);
  });

  it('keeps the Bullet clock monotonic after speech hands off to a local-clock idle', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.advance(0.016);
    backend.step({ seconds: 8, deltaSeconds: 0.016, frame: 240, frameRate: 30 });
    backend.beginSpeechContinuity();
    backend.advance(0.016);
    backend.step({ seconds: 0, deltaSeconds: 0, frame: 0, frameRate: 30, seeking: true });

    // The pose-aware bridge has completed and the first local-clock idle frame
    // has already been simulated on the continuous speech clock.
    backend.advance(0.016);
    backend.step({ seconds: 0.01, deltaSeconds: 0, frame: 0.3, frameRate: 30, seeking: true });
    backend.endSpeechContinuity();

    backend.advance(0.016);
    backend.step({ seconds: 0.026, deltaSeconds: 0.016, frame: 0.78, frameRate: 30 });

    expect(steps[3].seconds).toBeGreaterThan(steps[2].seconds);
    expect(steps[3].deltaSeconds).toBeCloseTo(0.016, 6);
    expect(steps[3].seeking).toBe(false);
  });

  it('keeps the same rigid-body and joint identity after speech exits until a real reset', () => {
    const { delegate, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);
    const stableBodies = [{ index: 0, boneIndex: 0, motionType: 'dynamic' }] as any;
    const stableJoints = [{ index: 0 }] as any;
    const replacementBodies = [{ index: 0, boneIndex: 0, motionType: 'dynamic' }] as any;
    const replacementJoints = [{ index: 0 }] as any;

    backend.advance(0.016);
    backend.step({
      seconds: 2,
      deltaSeconds: 0.016,
      frame: 60,
      frameRate: 30,
      rigidBodies: stableBodies,
      joints: stableJoints
    });
    backend.beginSpeechContinuity();
    backend.advance(0.016);
    backend.step({
      seconds: 0,
      deltaSeconds: 0,
      frame: 0,
      frameRate: 30,
      rigidBodies: replacementBodies,
      joints: replacementJoints,
      seeking: true
    });
    backend.endSpeechContinuity();
    backend.advance(0.016);
    backend.step({
      seconds: 0.016,
      deltaSeconds: 0.016,
      frame: 0.48,
      frameRate: 30,
      rigidBodies: replacementBodies,
      joints: replacementJoints
    });

    expect(steps[1].rigidBodies).toBe(stableBodies);
    expect(steps[1].joints).toBe(stableJoints);
    expect(steps[2].rigidBodies).toBe(stableBodies);
    expect(steps[2].joints).toBe(stableJoints);
  });

  it('suppresses the loader rewind reset at an ordinary idle clip loop', () => {
    const { delegate, resets, steps } = createDelegate();
    const backend = createContinuousMmdPhysicsBackend(delegate);

    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    backend.advance(0.016);
    backend.step({ seconds: 4.98, deltaSeconds: 0.016, frame: 149.4, frameRate: 30 });
    // The real loader resets Bullet at the loop boundary before evaluating
    // the wrapped animation time. This rewind reset caused hair and ribbons
    // to jump before the continuous clock adapter could see the wrap.
    backend.reset?.({ seconds: 0, frame: 0, frameRate: 30 });
    backend.advance(0.018);
    backend.step({ seconds: 0.02, deltaSeconds: 0, frame: 0.6, frameRate: 30, seeking: true });

    expect(resets).toHaveLength(1);
    expect(steps[0]).toMatchObject({ seconds: 4.98, deltaSeconds: 0.016 });
    expect(steps[1].seconds).toBeGreaterThan(steps[0].seconds);
    // 帧 delta 低通平滑：EMA 收敛期内步长介于上一帧（0.016）与本帧输入
    // （0.018）之间，回卷重置仍被抑制、时钟持续前进。
    expect(steps[1].deltaSeconds).toBeGreaterThan(0.016);
    expect(steps[1].deltaSeconds).toBeLessThanOrEqual(0.018);
    expect(steps[1].seeking).toBe(false);
    expect(backend.diagnosticsState()).toMatchObject({
      forwardedResetCount: 1,
      suppressedResetCount: 1,
      loopWrapCount: 1,
      speechContinuityActive: false
    });
  });
});
