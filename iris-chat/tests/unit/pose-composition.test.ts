// Phase 5.2B.3 Closeout Task 2：PoseComposition RED→GREEN
//
// 用户要求（docs/plans/phase-5.2b3-closeout-and-performance-foundation-plan.md Task 2）：
// - 实现 composeBonePose(mode, rest, base, sampled)
// - absolute 模式：返回 sampled 副本（不组合）
// - additive-from-base 模式：
//   - rotation: base * inverse(rest) * sampled
//   - translation: base + sampled - rest
// - 返回的 quaternion 必须有限且归一化
// - 内部程序化 VMD pack 使用 additive-from-base
// - 外部 VMD 默认 absolute
//
// 数学契约（来自 closeout plan Task 2 Step 3）：
//   const delta = sampledQuaternion.clone().premultiply(restQuaternion.clone().invert());
//   const result = baseQuaternion.clone().multiply(delta).normalize();
//   const position = basePosition.clone().add(sampledPosition).sub(restPosition);
//
// 测试覆盖：
// - absolute 返回 sampled 不变
// - identity VMD delta 返回 calibrated base pose
// - sampled rotation = base * inverse(rest) * sampled
// - sampled translation = base + sampled - rest
// - 返回 quaternion 有限且归一化

import { describe, it, expect } from 'vitest';
import {
  composeBonePose,
  type MotionCompositionMode,
  type BonePose
} from '../../src/motion/pose-composition';

// 工具：创建 BonePose
function makePose(
  qx: number, qy: number, qz: number, qw: number,
  px: number, py: number, pz: number
): BonePose {
  return {
    quaternion: [qx, qy, qz, qw],
    position: [px, py, pz]
  };
}

// 单位姿态
const IDENTITY_POSE: BonePose = makePose(0, 0, 0, 1, 0, 0, 0);

describe('PoseComposition - additive-from-base 数学', () => {
  describe('absolute 模式', () => {
    it('返回 sampled 不变（副本，不共享引用）', () => {
      const rest = IDENTITY_POSE;
      const base = makePose(0.1, 0, 0, 0.99, 1, 2, 3);
      const sampled = makePose(0.2, 0.1, 0, 0.97, 4, 5, 6);
      const result = composeBonePose('absolute', rest, base, sampled);
      expect(result.quaternion[0]).toBeCloseTo(0.2, 10);
      expect(result.quaternion[1]).toBeCloseTo(0.1, 10);
      expect(result.quaternion[2]).toBeCloseTo(0, 10);
      expect(result.quaternion[3]).toBeCloseTo(0.97, 10);
      expect(result.position[0]).toBeCloseTo(4, 10);
      expect(result.position[1]).toBeCloseTo(5, 10);
      expect(result.position[2]).toBeCloseTo(6, 10);
      // 副本不共享引用
      expect(result.quaternion).not.toBe(sampled.quaternion);
      expect(result.position).not.toBe(sampled.position);
    });
  });

  describe('additive-from-base 模式', () => {
    it('identity VMD delta（sampled === rest）返回 base pose', () => {
      // 当 sampled === rest，delta = inverse(rest) * rest = identity
      // result = base * identity = base
      // 注意：输入 quaternion 会被归一化，所以 base = [0.5, 0, 0, 0.866] 归一化后
      // 变成 [0.500011, 0, 0, 0.865981]（因为 0.866^2 + 0.5^2 = 0.999956 ≠ 1.0）
      // 所以这里检查的是"归一化后的 base"，精度 4 位（容差 5e-5）
      const rest = makePose(0.1, 0.2, 0.3, 0.9, 1, 2, 3);
      const base = makePose(0.5, 0, 0, 0.866, 10, 20, 30);
      const sampled = rest; // sampled === rest → identity delta
      const result = composeBonePose('additive-from-base', rest, base, sampled);
      // rotation = normalize(base)
      const baseLen = Math.sqrt(0.5 * 0.5 + 0.866 * 0.866);
      expect(result.quaternion[0]).toBeCloseTo(0.5 / baseLen, 4);
      expect(result.quaternion[1]).toBeCloseTo(0, 6);
      expect(result.quaternion[2]).toBeCloseTo(0, 6);
      expect(result.quaternion[3]).toBeCloseTo(0.866 / baseLen, 4);
      // translation = base + rest - rest = base
      expect(result.position[0]).toBeCloseTo(10, 6);
      expect(result.position[1]).toBeCloseTo(20, 6);
      expect(result.position[2]).toBeCloseTo(30, 6);
    });

    it('rest = identity 时，rotation = base * sampled', () => {
      // delta = sampled * inverse(identity) = sampled
      // result = base * sampled
      const rest = IDENTITY_POSE;
      const base = makePose(0, 0, 0, 1, 0, 0, 0); // base = identity
      // 90° rotation around Y
      const sampled = makePose(0, 0.7071, 0, 0.7071, 0, 0, 0);
      const result = composeBonePose('additive-from-base', rest, base, sampled);
      // base * sampled = identity * sampled = sampled
      expect(result.quaternion[0]).toBeCloseTo(0, 5);
      expect(result.quaternion[1]).toBeCloseTo(0.7071, 4);
      expect(result.quaternion[2]).toBeCloseTo(0, 5);
      expect(result.quaternion[3]).toBeCloseTo(0.7071, 4);
    });

    it('sampled rotation = base * inverse(rest) * sampled', () => {
      // 通用公式验证
      // rest = 90° around Y
      const rest = makePose(0, 0.7071, 0, 0.7071, 0, 0, 0);
      // base = 45° around Y
      const base = makePose(0, 0.3827, 0, 0.9239, 0, 0, 0);
      // sampled = 90° around Y (same as rest)
      const sampled = makePose(0, 0.7071, 0, 0.7071, 0, 0, 0);

      const result = composeBonePose('additive-from-base', rest, base, sampled);
      // delta = sampled * inverse(rest) = identity
      // result = base * identity = base
      expect(result.quaternion[1]).toBeCloseTo(0.3827, 4);
      expect(result.quaternion[3]).toBeCloseTo(0.9239, 4);
    });

    it('sampled translation = base + sampled - rest', () => {
      const rest = makePose(0, 0, 0, 1, 1, 2, 3);
      const base = makePose(0, 0, 0, 1, 10, 20, 30);
      const sampled = makePose(0, 0, 0, 1, 4, 5, 6);
      const result = composeBonePose('additive-from-base', rest, base, sampled);
      // translation = base + sampled - rest = (10+4-1, 20+5-2, 30+6-3) = (13, 23, 33)
      expect(result.position[0]).toBeCloseTo(13, 6);
      expect(result.position[1]).toBeCloseTo(23, 6);
      expect(result.position[2]).toBeCloseTo(33, 6);
    });

    it('返回的 quaternion 必须有限', () => {
      const rest = IDENTITY_POSE;
      const base = makePose(0.5, 0, 0, 0.866, 0, 0, 0);
      const sampled = makePose(0.3, 0, 0, 0.954, 0, 0, 0);
      const result = composeBonePose('additive-from-base', rest, base, sampled);
      for (const v of result.quaternion) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const v of result.position) {
        expect(Number.isFinite(v)).toBe(true);
      }
    });

    it('返回的 quaternion 必须归一化（模长 ≈ 1）', () => {
      const rest = makePose(0.1, 0.2, 0.3, 0.9, 0, 0, 0);
      const base = makePose(0.5, 0.1, 0.2, 0.84, 0, 0, 0);
      const sampled = makePose(0.3, 0.4, 0.2, 0.8, 0, 0, 0);
      const result = composeBonePose('additive-from-base', rest, base, sampled);
      const [x, y, z, w] = result.quaternion;
      const mag = Math.sqrt(x * x + y * y + z * z + w * w);
      expect(mag).toBeCloseTo(1, 6);
    });

    it('不修改输入参数（无副作用）', () => {
      const rest = makePose(0.1, 0.2, 0.3, 0.9, 1, 2, 3);
      const base = makePose(0.5, 0.1, 0.2, 0.84, 10, 20, 30);
      const sampled = makePose(0.3, 0.4, 0.2, 0.8, 4, 5, 6);
      const restBefore = { quaternion: [...rest.quaternion], position: [...rest.position] };
      const baseBefore = { quaternion: [...base.quaternion], position: [...base.position] };
      const sampledBefore = { quaternion: [...sampled.quaternion], position: [...sampled.position] };

      composeBonePose('additive-from-base', rest, base, sampled);

      expect(rest.quaternion).toEqual(restBefore.quaternion);
      expect(rest.position).toEqual(restBefore.position);
      expect(base.quaternion).toEqual(baseBefore.quaternion);
      expect(base.position).toEqual(baseBefore.position);
      expect(sampled.quaternion).toEqual(sampledBefore.quaternion);
      expect(sampled.position).toEqual(sampledBefore.position);
    });
  });

  describe('MotionCompositionMode 类型', () => {
    it('absolute 与 additive-from-base 都是合法值', () => {
      const modes: MotionCompositionMode[] = ['absolute', 'additive-from-base'];
      for (const mode of modes) {
        const result = composeBonePose(mode, IDENTITY_POSE, IDENTITY_POSE, IDENTITY_POSE);
        expect(result).toBeDefined();
        expect(result.quaternion.length).toBe(4);
        expect(result.position.length).toBe(3);
      }
    });
  });
});
