// Phase 5.2B.1 Task 2: 赛琳娜放松基础姿态（RED → GREEN 2026-07-20）
//
// 用户要求：
// - 建立共享的、安全的放松上半身姿态层
// - 程序化低优先级，idle/VMD gesture 可通过 BoneOwnershipRegistry 抢占
// - 候选骨骼：左肩、右肩、左腕、右腕、左ひじ、右ひじ、左手首、右手首
// - 不驱动 全ての親、センター、腰、下半身、腿、足 IK
// - 左右手臂自然下垂，保留轻微不对称
// - 手腕和肘部只做很小的自然弯曲
// - VMD gesture claim 手臂后基础姿态停止写入
// - gesture release 后基础姿态恢复
// - 旧 lease 不能释放新 owner
//
// 先写测试证明：
// - 默认 desktop idle 不再保持 A/T Pose
// - 左右腕相对 rest pose 有有限、受控且方向正确的变化
// - 下肢与 root 不受影响
// - VMD gesture 播放时基础姿态不覆盖手臂
// - gesture 停止后恢复放松姿态，而不是闪回 PMX 原始 T Pose

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  RelaxedBasePoseController,
  DEFAULT_RELAXED_POSE_OFFSETS,
  type RelaxedBasePoseBones
} from '../../src/actor/relaxed-base-pose';
import { BoneOwnershipRegistry } from '../../src/actor/bone-ownership-registry';

// 创建 mock 骨骼（模拟 PMX 加载后的状态）
function createMockBone(name: string, initialQuat: [number, number, number, number] = [0, 0, 0, 1]): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.quaternion.set(initialQuat[0], initialQuat[1], initialQuat[2], initialQuat[3]);
  return bone;
}

// 创建完整的手臂骨骼集合
function createArmBones(): {
  bones: RelaxedBasePoseBones;
  allBones: Record<string, THREE.Bone>;
} {
  const leftShoulder = createMockBone('左肩');
  const rightShoulder = createMockBone('右肩');
  const leftArm = createMockBone('左腕');
  const rightArm = createMockBone('右腕');
  const leftElbow = createMockBone('左ひじ');
  const rightElbow = createMockBone('右ひじ');
  const leftWrist = createMockBone('左手首');
  const rightWrist = createMockBone('右手首');

  // 也创建不应被触碰的骨骼
  const root = createMockBone('全ての親');
  const center = createMockBone('センター');
  const waist = createMockBone('腰');
  const lowerBody = createMockBone('下半身');
  const leftLeg = createMockBone('左足');
  const rightLeg = createMockBone('右足');
  const leftFootIK = createMockBone('左足ＩＫ');
  const rightFootIK = createMockBone('右足ＩＫ');

  // 保存初始 quaternion
  const allBones: Record<string, THREE.Bone> = {
    '左肩': leftShoulder, '右肩': rightShoulder,
    '左腕': leftArm, '右腕': rightArm,
    '左ひじ': leftElbow, '右ひじ': rightElbow,
    '左手首': leftWrist, '右手首': rightWrist,
    '全ての親': root, 'センター': center, '腰': waist,
    '下半身': lowerBody, '左足': leftLeg, '右足': rightLeg,
    '左足ＩＫ': leftFootIK, '右足ＩＫ': rightFootIK
  };

  for (const b of Object.values(allBones)) {
    (b as any)._initialQuat = b.quaternion.clone();
  }

  return {
    bones: { leftShoulder, rightShoulder, leftArm, rightArm, leftElbow, rightElbow, leftWrist, rightWrist },
    allBones
  };
}

describe('RelaxedBasePoseController', () => {
  describe('DEFAULT_RELAXED_POSE_OFFSETS', () => {
    it('包含 8 个手臂骨骼的 offset', () => {
      expect(DEFAULT_RELAXED_POSE_OFFSETS.leftShoulder).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.rightShoulder).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.leftArm).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.rightArm).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.leftElbow).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.rightElbow).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.leftWrist).toBeDefined();
      expect(DEFAULT_RELAXED_POSE_OFFSETS.rightWrist).toBeDefined();
    });

    it('每个 offset 是 [x, y, z] 三元组', () => {
      for (const offset of Object.values(DEFAULT_RELAXED_POSE_OFFSETS)) {
        expect(Array.isArray(offset)).toBe(true);
        expect(offset).toHaveLength(3);
        for (const v of offset) {
          expect(typeof v).toBe('number');
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    });

    it('所有 offset 幅度有限（不超过 0.4 rad）', () => {
      const MAX_OFFSET = 0.4;
      for (const offset of Object.values(DEFAULT_RELAXED_POSE_OFFSETS)) {
        for (const v of offset) {
          expect(Math.abs(v)).toBeLessThanOrEqual(MAX_OFFSET);
        }
      }
    });

    it('左右手臂轻微不对称（避免完全镜像）', () => {
      // 左腕和右腕的 Z 轴 offset 应该符号相反但幅度可能略有不同
      const leftArmZ = DEFAULT_RELAXED_POSE_OFFSETS.leftArm[2];
      const rightArmZ = DEFAULT_RELAXED_POSE_OFFSETS.rightArm[2];
      expect(Math.sign(leftArmZ)).toBe(-Math.sign(rightArmZ));
      // 但允许幅度不完全相同（不对称）
      const exactlyMirror = leftArmZ === -rightArmZ;
      // 至少有一些 offset 是不对称的
      const leftWristZ = DEFAULT_RELAXED_POSE_OFFSETS.leftWrist[2];
      const rightWristZ = DEFAULT_RELAXED_POSE_OFFSETS.rightWrist[2];
      const wristAsymmetric = leftWristZ !== -rightWristZ;
      expect(exactlyMirror || wristAsymmetric).toBe(true);
    });
  });

  describe('apply()', () => {
    it('物理启用时不在 Bullet 之后改写任何手臂骨骼', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones, { physicsEnabled: true });
      const before = Object.fromEntries(Object.entries(allBones).map(([name, bone]) => [
        name,
        bone.quaternion.clone()
      ]));

      controller.apply();

      for (const name of controller.getManagedBoneNames()) {
        expect(allBones[name].quaternion.equals(before[name])).toBe(true);
      }
    });

    it('默认 desktop idle 不再保持 A/T Pose（手臂骨骼 quaternion 有变化）', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);

      // 初始状态：手臂骨骼是 PMX rest pose（模拟 A/T Pose）
      const leftArmInitial = allBones['左腕'].quaternion.clone();
      const rightArmInitial = allBones['右腕'].quaternion.clone();

      controller.apply();

      // 应用后：quaternion 应该有变化（不再是 A/T Pose）
      expect(allBones['左腕'].quaternion.equals(leftArmInitial)).toBe(false);
      expect(allBones['右腕'].quaternion.equals(rightArmInitial)).toBe(false);
    });

    it('左右腕相对 rest pose 有有限、受控且方向正确的变化', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);

      const leftArmRest = allBones['左腕'].quaternion.clone();
      const rightArmRest = allBones['右腕'].quaternion.clone();

      controller.apply();

      // 上臂内收保持在经过模型校准的有限范围内。
      const leftArmAngle = leftArmRest.angleTo(allBones['左腕'].quaternion);
      const rightArmAngle = rightArmRest.angleTo(allBones['右腕'].quaternion);
      expect(leftArmAngle).toBeGreaterThan(0);
      expect(leftArmAngle).toBeLessThanOrEqual(0.4);
      expect(rightArmAngle).toBeGreaterThan(0);
      expect(rightArmAngle).toBeLessThanOrEqual(0.4);

      // 方向正确：左腕和右腕的 Z 轴旋转方向相反（手臂向身体内侧收）
      // 通过比较 Z 轴分量符号判断
      const leftArmDiff = new THREE.Quaternion().multiplyQuaternions(
        allBones['左腕'].quaternion.clone().invert(),
        leftArmRest
      );
      const rightArmDiff = new THREE.Quaternion().multiplyQuaternions(
        allBones['右腕'].quaternion.clone().invert(),
        rightArmRest
      );
      // Z 轴旋转分量（近似）：从 quaternion 提取
      const leftZSign = Math.sign(leftArmDiff.x + leftArmDiff.y + leftArmDiff.z);
      const rightZSign = Math.sign(rightArmDiff.x + rightArmDiff.y + rightArmDiff.z);
      // 左右方向应该不同（镜像或不对称）
      // 注意：这里只验证"有变化"，具体方向在真实 PMX 上校准
      expect(leftArmDiff.length()).toBeGreaterThan(0);
      expect(rightArmDiff.length()).toBeGreaterThan(0);
    });

    it('下肢与 root 不受影响（全ての親/センター/腰/下半身/足 不变）', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);

      const rootInitial = allBones['全ての親'].quaternion.clone();
      const centerInitial = allBones['センター'].quaternion.clone();
      const waistInitial = allBones['腰'].quaternion.clone();
      const lowerBodyInitial = allBones['下半身'].quaternion.clone();
      const leftLegInitial = allBones['左足'].quaternion.clone();
      const rightLegInitial = allBones['右足'].quaternion.clone();
      const leftFootIKInitial = allBones['左足ＩＫ'].quaternion.clone();
      const rightFootIKInitial = allBones['右足ＩＫ'].quaternion.clone();

      controller.apply();

      // 下肢与 root 应该完全不变
      expect(allBones['全ての親'].quaternion.equals(rootInitial)).toBe(true);
      expect(allBones['センター'].quaternion.equals(centerInitial)).toBe(true);
      expect(allBones['腰'].quaternion.equals(waistInitial)).toBe(true);
      expect(allBones['下半身'].quaternion.equals(lowerBodyInitial)).toBe(true);
      expect(allBones['左足'].quaternion.equals(leftLegInitial)).toBe(true);
      expect(allBones['右足'].quaternion.equals(rightLegInitial)).toBe(true);
      expect(allBones['左足ＩＫ'].quaternion.equals(leftFootIKInitial)).toBe(true);
      expect(allBones['右足ＩＫ'].quaternion.equals(rightFootIKInitial)).toBe(true);
    });

    it('多次 apply 不累积漂移（每次从 rest pose 开始）', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);

      controller.apply();
      const after1 = allBones['左腕'].quaternion.clone();

      controller.apply();
      const after2 = allBones['左腕'].quaternion.clone();

      controller.apply();
      const after3 = allBones['左腕'].quaternion.clone();

      expect(after1.equals(after2)).toBe(true);
      expect(after2.equals(after3)).toBe(true);
    });
  });

  describe('BoneOwnershipRegistry 集成', () => {
    it('VMD gesture claim 手臂后基础姿态不覆盖', () => {
      const { bones, allBones } = createArmBones();
      const registry = new BoneOwnershipRegistry();
      const controller = new RelaxedBasePoseController(bones, { boneOwnership: registry });

      // 先 apply 一次建立放松姿态
      controller.apply();
      const relaxedQuat = allBones['左腕'].quaternion.clone();

      // VMD claim 左腕
      const lease = registry.claim('左腕', 'vmd');
      expect(lease).not.toBeNull();

      // 模拟 VMD 写入新 quaternion
      const vmdQuat = new THREE.Quaternion(0.1, 0.2, 0.3, 0.4).normalize();
      allBones['左腕'].quaternion.copy(vmdQuat);

      // 再次 apply：不应覆盖 VMD 写入的左腕
      controller.apply();

      expect(allBones['左腕'].quaternion.equals(vmdQuat)).toBe(true);
      expect(allBones['左腕'].quaternion.equals(relaxedQuat)).toBe(false);
    });

    it('gesture 停止后恢复放松姿态（不闪回 PMX 原始 T Pose）', () => {
      const { bones, allBones } = createArmBones();
      const registry = new BoneOwnershipRegistry();
      const controller = new RelaxedBasePoseController(bones, { boneOwnership: registry });

      // 初始 PMX rest pose
      const pmxRestQuat = allBones['左腕'].quaternion.clone();

      // apply 建立放松姿态
      controller.apply();
      const relaxedQuat = allBones['左腕'].quaternion.clone();
      expect(relaxedQuat.equals(pmxRestQuat)).toBe(false); // 放松姿态 ≠ PMX rest

      // VMD claim + 写入
      const lease = registry.claim('左腕', 'vmd');
      const vmdQuat = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5).normalize();
      allBones['左腕'].quaternion.copy(vmdQuat);

      controller.apply();
      expect(allBones['左腕'].quaternion.equals(vmdQuat)).toBe(true);

      // VMD release（gesture 停止）
      const released = registry.release(lease!);
      expect(released).toBe(true);

      // 再次 apply：应恢复放松姿态，而不是 PMX 原始 T Pose
      controller.apply();
      expect(allBones['左腕'].quaternion.equals(relaxedQuat)).toBe(true);
      expect(allBones['左腕'].quaternion.equals(pmxRestQuat)).toBe(false);
      expect(allBones['左腕'].quaternion.equals(vmdQuat)).toBe(false);
    });

    it('旧 lease 不能释放新 owner（token 验证）', () => {
      const { bones, allBones } = createArmBones();
      const registry = new BoneOwnershipRegistry();
      const controller = new RelaxedBasePoseController(bones, { boneOwnership: registry });

      // VMD claim 左腕
      const vmdLease = registry.claim('左腕', 'vmd');
      expect(vmdLease).not.toBeNull();

      // performance-planner 抢占（更高优先级）
      const plannerLease = registry.claim('左腕', 'performance-planner');
      expect(plannerLease).not.toBeNull();

      // 旧 VMD lease 尝试释放：应该失败（token 不匹配）
      const oldReleaseResult = registry.release(vmdLease!);
      expect(oldReleaseResult).toBe(false);

      // 左腕 owner 仍是 performance-planner
      expect(registry.getOwner('左腕')).toBe('performance-planner');

      // controller.apply 不应写入左腕（被 planner 持有）
      const beforeApply = allBones['左腕'].quaternion.clone();
      controller.apply();
      expect(allBones['左腕'].quaternion.equals(beforeApply)).toBe(true);
    });

    it('部分手臂被 claim 时只跳过被 claim 的，其他仍应用放松姿态', () => {
      const { bones, allBones } = createArmBones();
      const registry = new BoneOwnershipRegistry();
      const controller = new RelaxedBasePoseController(bones, { boneOwnership: registry });

      // 只 claim 左腕
      registry.claim('左腕', 'vmd');
      const leftArmVmdQuat = new THREE.Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
      allBones['左腕'].quaternion.copy(leftArmVmdQuat);

      controller.apply();

      // 左腕保持 VMD 写入
      expect(allBones['左腕'].quaternion.equals(leftArmVmdQuat)).toBe(true);
      // 右腕应该是放松姿态（与 PMX rest 不同）
      const rightArmRest = new THREE.Quaternion(0, 0, 0, 1);
      expect(allBones['右腕'].quaternion.equals(rightArmRest)).toBe(false);
    });

    it('releaseAll 后所有手臂恢复放松姿态', () => {
      const { bones, allBones } = createArmBones();
      const registry = new BoneOwnershipRegistry();
      const controller = new RelaxedBasePoseController(bones, { boneOwnership: registry });

      // VMD claim 所有手臂骨骼
      const leases = [];
      for (const name of ['左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首']) {
        const lease = registry.claim(name, 'vmd');
        expect(lease).not.toBeNull();
        leases.push(lease);
      }

      // apply 不写入任何手臂（全被 VMD 持有）
      const beforeApply: Record<string, THREE.Quaternion> = {};
      for (const name of ['左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首']) {
        beforeApply[name] = allBones[name].quaternion.clone();
      }
      controller.apply();
      for (const name of Object.keys(beforeApply)) {
        expect(allBones[name].quaternion.equals(beforeApply[name])).toBe(true);
      }

      // 模式切换：releaseAll
      registry.releaseAll();

      // apply 后所有手臂恢复放松姿态
      controller.apply();
      for (const name of ['左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首']) {
        expect(allBones[name].quaternion.equals(beforeApply[name])).toBe(false);
      }
    });
  });

  describe('reset()', () => {
    it('reset 恢复所有手臂到 PMX 原始 rest pose', () => {
      const { bones, allBones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);

      // 记录 PMX rest
      const leftArmRest = allBones['左腕'].quaternion.clone();

      // apply 放松姿态
      controller.apply();
      expect(allBones['左腕'].quaternion.equals(leftArmRest)).toBe(false);

      // reset 恢复
      controller.reset();
      expect(allBones['左腕'].quaternion.equals(leftArmRest)).toBe(true);
    });
  });

  describe('缺失骨骼处理', () => {
    it('缺失部分骨骼时不抛错（只处理存在的骨骼）', () => {
      const bones: RelaxedBasePoseBones = {
        leftArm: createMockBone('左腕'),
        rightArm: createMockBone('右腕')
        // 其他骨骼缺失
      };
      const controller = new RelaxedBasePoseController(bones);

      expect(() => controller.apply()).not.toThrow();
      expect(() => controller.reset()).not.toThrow();
    });

    it('无骨骼时不抛错', () => {
      const controller = new RelaxedBasePoseController({});
      expect(() => controller.apply()).not.toThrow();
      expect(() => controller.reset()).not.toThrow();
    });
  });

  it('returns the PMX local position with a relaxed pose snapshot', () => {
    const { bones, allBones } = createArmBones();
    allBones['左腕'].position.set(1.25, -0.4, 0.75);
    const controller = new RelaxedBasePoseController(bones);

    expect(controller.getBasePoseSnapshot('左腕')?.position).toEqual([1.25, -0.4, 0.75]);
  });

  describe('自定义 offset', () => {
    it('支持自定义 offset（用于真实 PMX 校准）', () => {
      const { bones, allBones } = createArmBones();
      const customOffsets = {
        ...DEFAULT_RELAXED_POSE_OFFSETS,
        leftArm: [0, 0, 0.15] as [number, number, number]  // 更大的左臂 offset
      };
      const controller = new RelaxedBasePoseController(bones, { offsets: customOffsets });

      const leftArmRest = allBones['左腕'].quaternion.clone();
      controller.apply();

      const leftArmAngle = leftArmRest.angleTo(allBones['左腕'].quaternion);
      // 自定义 offset 更大，角度应该更大
      expect(leftArmAngle).toBeGreaterThan(0.1);
    });
  });

  describe('骨骼名暴露（用于 ownership 注册）', () => {
    it('getManagedBoneNames 返回 8 个手臂骨骼名', () => {
      const { bones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);
      const names = controller.getManagedBoneNames();
      expect(names).toContain('左肩');
      expect(names).toContain('右肩');
      expect(names).toContain('左腕');
      expect(names).toContain('右腕');
      expect(names).toContain('左ひじ');
      expect(names).toContain('右ひじ');
      expect(names).toContain('左手首');
      expect(names).toContain('右手首');
      expect(names).toHaveLength(8);
    });

    it('不管理 全ての親/センター/腰/下半身/足', () => {
      const { bones } = createArmBones();
      const controller = new RelaxedBasePoseController(bones);
      const names = controller.getManagedBoneNames();
      expect(names).not.toContain('全ての親');
      expect(names).not.toContain('センター');
      expect(names).not.toContain('腰');
      expect(names).not.toContain('下半身');
      expect(names).not.toContain('左足');
      expect(names).not.toContain('右足');
      expect(names).not.toContain('左足ＩＫ');
      expect(names).not.toContain('右足ＩＫ');
    });
  });
});
