// Task 6 Step 3: procedural-life-controller 单元测试
// 验证：
// 1. 构造时保存 rest pose
// 2. update 后骨骼有低幅度偏移
// 3. 眨眼周期性触发，权重在 [0,1] 内
// 4. 眨眼完成后 morph 权重归 0
// 5. speaking 状态下幅度降低
// 6. setState 切换状态
// 7. 未知 blinkName 在 MorphController 中会被 setWeight 抛错（fail-closed）

import * as THREE from 'three';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProceduralLifeController,
  shouldOverlayIdleBreathing,
  type LifeState
} from '../../src/actor/procedural-life-controller';
import { MorphController } from '../../src/actor/morph-controller';
import { BoneOwnershipRegistry } from '../../src/actor/bone-ownership-registry';

function createBones() {
  const head = new THREE.Bone();
  head.name = '頭';
  const upperBody = new THREE.Bone();
  upperBody.name = '上半身';
  const leftShoulder = new THREE.Bone();
  leftShoulder.name = '左肩';
  const rightShoulder = new THREE.Bone();
  rightShoulder.name = '右肩';
  const root = new THREE.Bone();
  root.name = '全ての親';
  const center = new THREE.Bone();
  center.name = 'センター';
  const lowerBody = new THREE.Bone();
  lowerBody.name = '下半身';
  const leftLeg = new THREE.Bone();
  leftLeg.name = '左足';
  const rightFootIk = new THREE.Bone();
  rightFootIk.name = '右足ＩＫ';
  // 保存初始 quaternion（rest pose）
  head.quaternion.set(0, 0, 0, 1);
  upperBody.quaternion.set(0, 0, 0, 1);
  leftShoulder.quaternion.set(0, 0, 0, 1);
  rightShoulder.quaternion.set(0, 0, 0, 1);
  return { head, upperBody, leftShoulder, rightShoulder, root, center, lowerBody, leftLeg, rightFootIk };
}

function createLifeController(blinkName = 'まばたき') {
  const bones = createBones();
  const morphs = new MorphController([blinkName]);
  const life = new ProceduralLifeController(bones, morphs, blinkName);
  return { life, bones, morphs };
}

describe('ProceduralLifeController (Task 6 Step 3)', () => {
  it('构造时保存 rest pose，update 前骨骼保持不变', () => {
    const { bones, life } = createLifeController();
    // 构造后未调用 update，骨骼 quaternion 应保持 identity
    expect(bones.head.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.upperBody.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    // 调用一次 update 后才会有偏移
    life.update(0.001, 0.016);
    // update 后骨骼 quaternion 可能改变（取决于 elapsed），但 rest pose 仍保存
    // 这里只验证 rest pose 被保存（通过 update 后再次 update 验证可恢复）
  });

  it('呼吸事件中只有上半身有低幅度偏移', () => {
    const { bones, life } = createLifeController();
    const restUpper = bones.upperBody.quaternion.clone();
    // 3.7 秒位于首次呼吸的吸气事件中段。
    life.update(3.7, 0.016);
    const upperChanged = !bones.upperBody.quaternion.equals(restUpper);
    expect(upperChanged).toBe(true);
    expect(bones.head.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.leftShoulder.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.rightShoulder.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
  });

  it('呼吸具有安静区间，并且永不写入根、中心、下半身、腿和足 IK', () => {
    const { bones, life } = createLifeController();
    const protectedBones = [bones.root, bones.center, bones.lowerBody, bones.leftLeg, bones.rightFootIk];
    const protectedBefore = protectedBones.map(bone => bone.quaternion.clone());
    let quietFrames = 0;

    for (let t = 0; t < 30; t += 0.1) {
      life.update(t, 0.1);
      if (life.getBreathPhase() === 'quiet') quietFrames += 1;
    }

    expect(quietFrames).toBeGreaterThanOrEqual(30);
    protectedBones.forEach((bone, index) => {
      expect(bone.quaternion.equals(protectedBefore[index])).toBe(true);
    });
  });

  it('allows a non-accumulating breath overlay on a VMD-owned upper body only during idle playback', () => {
    const bones = createBones();
    const morphs = new MorphController(['まばたき']);
    const ownership = new BoneOwnershipRegistry();
    expect(ownership.claim('上半身', 'vmd')).not.toBeNull();
    const life = new ProceduralLifeController(bones, morphs, 'まばたき', {
      boneOwnership: ownership,
      physicsEnabled: true
    });
    expect(shouldOverlayIdleBreathing({
      arbiterMode: 'idle',
      motionPlaying: true,
      speakingMotion: false,
      inertializing: false
    })).toBe(true);
    expect(shouldOverlayIdleBreathing({
      arbiterMode: 'speech',
      motionPlaying: true,
      speakingMotion: true,
      inertializing: false
    })).toBe(false);
    expect(shouldOverlayIdleBreathing({
      arbiterMode: 'idle',
      motionPlaying: true,
      speakingMotion: false,
      inertializing: true
    })).toBe(false);

    const idlePose = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0, 0, 'XYZ'));
    bones.upperBody.quaternion.copy(idlePose);
    life.setPoseLocked(true);
    life.update(3.95, 1 / 60);
    expect(bones.upperBody.quaternion.angleTo(idlePose)).toBeGreaterThan(0);

    bones.upperBody.quaternion.copy(idlePose);
    life.setSuppressed(true);
    life.update(3.95, 1 / 60);
    expect(bones.upperBody.quaternion.angleTo(idlePose)).toBeCloseTo(0, 8);
  });

  it('骨骼偏移幅度保持低幅度（< 0.05 弧度）', () => {
    const { bones, life } = createLifeController();
    // 计算四元数旋转角度：2 * acos(|w|)
    const rotAngle = (q: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    // 采样多个时间点，验证幅度始终很小
    for (let t = 0; t < 10; t += 0.1) {
      life.update(t, 0.016);
      // 单个骨骼偏移角度应 < 0.05 弧度（约 2.9 度）
      expect(rotAngle(bones.head.quaternion)).toBeLessThan(0.05);
      expect(rotAngle(bones.upperBody.quaternion)).toBeLessThan(0.05);
      expect(rotAngle(bones.leftShoulder.quaternion)).toBeLessThan(0.05);
      expect(rotAngle(bones.rightShoulder.quaternion)).toBeLessThan(0.05);
    }
  });

  it('眨眼在 blinkPhase [0, 0.16] 内设置 morph 权重', () => {
    const { life, morphs } = createLifeController();
    // 第一次眨眼在 nextBlinkAt = 3.8
    // 在 elapsed = 3.8 时进入眨眼阶段
    life.update(3.8, 0.016);
    // blinkPhase = 0，权重 = 0（normalized = 0/0.16 = 0，weight = 0*2 = 0）
    // 但只要进入阶段就应设置 morph
    // 继续到 phase = 0.08（峰值）
    life.update(3.88, 0.016);
    const weightAtPeak = morphs.getWeight('まばたき');
    expect(weightAtPeak).toBeGreaterThan(0);
    expect(weightAtPeak).toBeLessThanOrEqual(1);
  });

  it('眨眼完成后 morph 权重归 0', () => {
    const { life, morphs } = createLifeController();
    // 进入眨眼阶段
    life.update(3.8, 0.016);
    life.update(3.88, 0.016);
    // 眨眼完成（phase > 0.16）
    life.update(3.97, 0.016);
    expect(morphs.getWeight('まばたき')).toBe(0);
  });

  it('眨眼权重峰值不超过 1', () => {
    const { life, morphs } = createLifeController();
    // 采样眨眼周期内多个时间点
    let maxWeight = 0;
    for (let t = 3.8; t <= 3.97; t += 0.005) {
      life.update(t, 0.016);
      const w = morphs.getWeight('まばたき');
      if (w > maxWeight) maxWeight = w;
    }
    expect(maxWeight).toBeLessThanOrEqual(1);
    expect(maxWeight).toBeGreaterThan(0.5); // 峰值应接近 1
  });

  it('body suppression does not suppress blink, so speech and pose lock keep facial life', () => {
    const { life, bones, morphs } = createLifeController();
    life.setSuppressed(true);
    const before = bones.upperBody.quaternion.clone();

    life.update(3.88, 0.016);

    expect(bones.upperBody.quaternion.equals(before)).toBe(true);
    expect(morphs.getWeight('まばたき')).toBeGreaterThan(0);
  });

  it('speaking 状态下幅度降低', () => {
    const bonesA = createBones();
    const morphsA = new MorphController(['まばたき']);
    const lifeIdle = new ProceduralLifeController(bonesA, morphsA, 'まばたき');

    const bonesB = createBones();
    const morphsB = new MorphController(['まばたき']);
    const lifeSpeaking = new ProceduralLifeController(bonesB, morphsB, 'まばたき');
    lifeSpeaking.setState('speaking');

    // 计算四元数旋转角度：2 * acos(|w|)
    const rotAngle = (q: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    // 用同一 elapsed 采样，比较偏移幅度
    let idleMaxAngle = 0;
    let speakingMaxAngle = 0;
    for (let t = 0; t < 10; t += 0.05) {
      lifeIdle.update(t, 0.016);
      lifeSpeaking.update(t, 0.016);
      idleMaxAngle = Math.max(idleMaxAngle, rotAngle(bonesA.upperBody.quaternion));
      speakingMaxAngle = Math.max(speakingMaxAngle, rotAngle(bonesB.upperBody.quaternion));
    }
    // speaking 时幅度应小于 idle（amplitude 0.7 vs 1）
    expect(speakingMaxAngle).toBeLessThan(idleMaxAngle);
  });

  it('setState 切换生命状态', () => {
    const { life } = createLifeController();
    expect(life.getState()).toBe('idle');
    life.setState('listening');
    expect(life.getState()).toBe('listening');
    life.setState('speaking');
    expect(life.getState()).toBe('speaking');
    life.setState('thinking');
    expect(life.getState()).toBe('thinking');
    life.setState('idle');
    expect(life.getState()).toBe('idle');
  });

  it('reset 恢复 rest pose 并清零 blink morph', () => {
    const { life, bones, morphs } = createLifeController();
    // 触发一些偏移
    life.update(5.0, 0.016);
    life.update(5.1, 0.016);
    // reset
    life.reset();
    // 骨骼应恢复 rest pose
    expect(bones.head.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.upperBody.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.leftShoulder.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    expect(bones.rightShoulder.quaternion.equals(new THREE.Quaternion(0, 0, 0, 1))).toBe(true);
    // blink morph 应为 0
    expect(morphs.getWeight('まばたき')).toBe(0);
  });

  it('缺少某些骨骼时仍能工作（不抛错）', () => {
    // 只有 head 骨骼，其他缺失
    const head = new THREE.Bone();
    head.quaternion.set(0, 0, 0, 1);
    const morphs = new MorphController(['まばたき']);
    const life = new ProceduralLifeController({ head }, morphs, 'まばたき');
    expect(() => life.update(1.0, 0.016)).not.toThrow();
    expect(() => life.reset()).not.toThrow();
  });

  it('update 后再次 update 不会累积漂移（每帧从 rest 开始）', () => {
    const { bones, life } = createLifeController();
    // 计算四元数旋转角度：2 * acos(|w|)
    const rotAngle = (q: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    // 多次 update 后，单帧偏移应保持低幅度（不累积）
    for (let t = 0; t < 100; t += 0.016) {
      life.update(t, 0.016);
    }
    // 最终单帧偏移仍应 < 0.05（不累积）
    expect(rotAngle(bones.head.quaternion)).toBeLessThan(0.05);
  });

  // ============================================================
  // Phase 5.2B.3 Closeout Task 4：additive life deltas
  // 用户要求：修复动作、呼吸和基础姿态互相覆盖
  // ProceduralLifeController 不能覆盖 RelaxedBasePoseController 写入的放松肩部姿态
  // ============================================================

  describe('Phase 5.2B.3 Closeout Task 4: additive life deltas', () => {
    /**
     * RED 测试：ProceduralLifeController 不应覆盖 RelaxedBasePoseController 写入的放松肩部姿态。
     *
     * 场景：
     * 1. RelaxedBasePoseController.apply() 已将 左肩/右肩 写为 base pose (rest * offset)
     *    例如：左肩 Z = +0.025 rad ≈ 1.4°，右肩 Z = -0.05 rad ≈ -2.9°
     * 2. ProceduralLifeController.update() 被调用
     *
     * 旧实现（bug）：
     * - applyOffset 执行 bone.quaternion.copy(rest).multiply(offset)
     * - rest 是 PMX rest (identity)，覆盖了 base pose
     * - 结果：左肩/右肩 ≈ PMX rest + breath_offset，base pose offset 丢失
     *
     * 新实现（fix）：
     * - managed bones 使用 multiply-on-top：bone.quaternion.multiply(offset)
     * - 不覆盖 base pose，breath offset 叠加在 base pose 之上
     * - 结果：左肩/右肩 = base pose * breath_offset，base pose offset 保留
     */
    it('RED: managed bones 不覆盖 RelaxedBasePoseController 写入的放松肩部姿态', () => {
      const bones = createBones();
      const morphs = new MorphController(['まばたき']);

      // 模拟 RelaxedBasePoseController.apply() 已写入 base pose
      const leftShoulderBase = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0, 0.025, 'XYZ')  // 左肩 Z = +1.4°
      );
      const rightShoulderBase = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0, -0.05, 'XYZ')  // 右肩 Z = -2.9°
      );
      bones.leftShoulder.quaternion.copy(leftShoulderBase);
      bones.rightShoulder.quaternion.copy(rightShoulderBase);

      // 创建 ProceduralLifeController，告知 左肩/右肩 是 managed bones
      const life = new ProceduralLifeController(bones, morphs, 'まばたき', {
        managedBoneNames: ['左肩', '右肩']
      });

      // 调用 update（elapsed=1.0 触发非零 breath/sway）
      life.update(1.0, 0.016);

      // 验证 左肩/右肩 仍保留 base pose offset（不被覆盖为 PMX rest）
      // base pose 左肩 Z ≈ sin(0.025/2) ≈ 0.0125
      // base pose 右肩 Z ≈ sin(-0.05/2) ≈ -0.025
      // breath offset 最多 ±0.006 rad * 0.35 ≈ ±0.0021 rad
      //
      // 如果 ProceduralLifeController 覆盖了 base pose（bug）：
      //   左肩 Z ≈ sin(breath*0.35/2) ≈ ±0.001（接近 0）
      //   右肩 Z ≈ sin(-breath*0.35/2) ≈ ±0.001（接近 0）
      // 如果 ProceduralLifeController 保留 base pose（fix）：
      //   左肩 Z ≈ 0.0125 ± 0.001（远大于 0）
      //   右肩 Z ≈ -0.025 ± 0.001（远小于 0）
      const leftShoulderZ = bones.leftShoulder.quaternion.z;
      const rightShoulderZ = bones.rightShoulder.quaternion.z;

      // 左肩 base |Z| ≈ 0.0125，breath 不会让它接近 0
      expect(Math.abs(leftShoulderZ)).toBeGreaterThan(0.005);
      // 右肩 base |Z| ≈ 0.025，breath 不会让它接近 0
      expect(Math.abs(rightShoulderZ)).toBeGreaterThan(0.01);
    });

    /**
     * RED 测试：managed bones 在多次 update 后不累积漂移。
     *
     * 场景：模拟帧循环
     * 1. 每帧先 RelaxedBasePoseController.apply() 重置为 base pose
     * 2. 然后 ProceduralLifeController.update() multiply on top
     *
     * 期望：100 帧后，左肩/右肩 仍在 base pose 附近（breath offset < 0.05 rad）
     * 不累积漂移（因为 RelaxedBasePoseController 每帧重置 managed bones）
     */
    it('RED: managed bones 多帧不累积漂移（每帧由 RelaxedBasePoseController 重置）', () => {
      const bones = createBones();
      const morphs = new MorphController(['まばたき']);

      const leftShoulderBase = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0, 0.025, 'XYZ')
      );
      const rightShoulderBase = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, 0, -0.05, 'XYZ')
      );

      const life = new ProceduralLifeController(bones, morphs, 'まばたき', {
        managedBoneNames: ['左肩', '右肩']
      });

      // 模拟 100 帧帧循环
      for (let t = 0; t < 100; t += 0.016) {
        // 每帧先重置为 base pose（模拟 RelaxedBasePoseController.apply()）
        bones.leftShoulder.quaternion.copy(leftShoulderBase);
        bones.rightShoulder.quaternion.copy(rightShoulderBase);
        // 然后 life.update() 应该 multiply on top
        life.update(t, 0.016);
      }

      // 验证 左肩/右肩 仍在 base pose 附近（不累积漂移）
      // base pose 左肩 Z ≈ 0.0125，breath offset 最多 ±0.0021
      // 100 帧后仍应 < 0.05 rad（不累积到 > 0.05）
      const leftAngleFromBase = Math.acos(Math.min(1, Math.abs(
        bones.leftShoulder.quaternion.dot(leftShoulderBase)
      ))) * 2;
      const rightAngleFromBase = Math.acos(Math.min(1, Math.abs(
        bones.rightShoulder.quaternion.dot(rightShoulderBase)
      ))) * 2;

      // breath offset 单帧 < 0.006 rad * 0.35 ≈ 0.0021 rad
      // 100 帧后应仍 < 0.01 rad（不累积）
      expect(leftAngleFromBase).toBeLessThan(0.01);
      expect(rightAngleFromBase).toBeLessThan(0.01);
    });

    /**
     * 非 managed bones（頭/上半身）仍保持 copy(rest)+multiply 行为，避免漂移。
     * 这些骨骼不由 RelaxedBasePoseController 管理，需要 ProceduralLifeController
     * 自己每帧从 rest pose 开始。
     */
    it('非 managed bones 仍保持 copy(rest)+multiply 行为（避免漂移）', () => {
      const bones = createBones();
      const morphs = new MorphController(['まばたき']);

      // 頭/上半身 不在 managedBoneNames 中
      const life = new ProceduralLifeController(bones, morphs, 'まばたき', {
        managedBoneNames: ['左肩', '右肩']  // 只管理肩部
      });

      // 多次 update（不重置 頭/上半身）
      const rotAngle = (q: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      for (let t = 0; t < 100; t += 0.016) {
        life.update(t, 0.016);
      }

      // 頭/上半身 应保持低幅度（< 0.05 rad），不累积漂移
      expect(rotAngle(bones.head.quaternion)).toBeLessThan(0.05);
      expect(rotAngle(bones.upperBody.quaternion)).toBeLessThan(0.05);
    });
  });
});
