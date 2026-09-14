// Phase 5.2B.3 Closeout Task 2：PoseComposition 纯函数
//
// 用户要求（docs/plans/phase-5.2b3-closeout-and-performance-foundation-plan.md Task 2）：
// - composeBonePose(mode, rest, base, sampled)
// - absolute 模式：返回 sampled 副本（不组合）
// - additive-from-base 模式：
//   - rotation: base * inverse(rest) * sampled
//   - translation: base + sampled - rest
// - 返回的 quaternion 必须有限且归一化
//
// 数学契约（closeout plan Task 2 Step 3）：
//   const delta = sampledQuaternion.clone().premultiply(restQuaternion.clone().invert());
//   const result = baseQuaternion.clone().multiply(delta).normalize();
//   const position = basePosition.clone().add(sampledPosition).sub(restPosition);
//
// 边界：
// - 纯函数，无副作用，不修改输入
// - 不依赖 Three.js 类型（只用数字元组）
// - 内部程序化 VMD pack 使用 additive-from-base
// - 外部 VMD 默认 absolute

import * as THREE from 'three';

/**
 * 动作组合模式。
 * - absolute：sampled 直接覆盖（外部 VMD 默认）
 * - additive-from-base：sampled 作为 delta 叠加到 base pose（内部程序化 VMD）
 */
export type MotionCompositionMode = 'absolute' | 'additive-from-base';

/**
 * 骨骼姿态（quaternion + position）。
 * quaternion: [x, y, z, w]
 * position: [x, y, z]
 */
export interface BonePose {
  readonly quaternion: readonly [number, number, number, number];
  readonly position: readonly [number, number, number];
}

/**
 * 组合骨骼姿态。
 *
 * @param mode 组合模式
 * @param rest PMX rest pose（additive 模式下作为 delta 参考基准）
 * @param base 校准后的放松基础姿态（additive 模式下的叠加基础）
 * @param sampled VMD 采样的姿态
 * @returns 组合后的姿态（副本，不共享输入引用）
 */
export function composeBonePose(
  mode: MotionCompositionMode,
  rest: BonePose,
  base: BonePose,
  sampled: BonePose
): BonePose {
  if (mode === 'absolute') {
    return {
      quaternion: [sampled.quaternion[0], sampled.quaternion[1], sampled.quaternion[2], sampled.quaternion[3]],
      position: [sampled.position[0], sampled.position[1], sampled.position[2]]
    };
  }

  // additive-from-base
  // 输入 quaternion 归一化（防止非单位四元数导致精度漂移）
  const restQ = new THREE.Quaternion(rest.quaternion[0], rest.quaternion[1], rest.quaternion[2], rest.quaternion[3]).normalize();
  const baseQ = new THREE.Quaternion(base.quaternion[0], base.quaternion[1], base.quaternion[2], base.quaternion[3]).normalize();
  const sampledQ = new THREE.Quaternion(sampled.quaternion[0], sampled.quaternion[1], sampled.quaternion[2], sampled.quaternion[3]).normalize();

  // delta = sampled * inverse(rest)
  const delta = sampledQ.clone().premultiply(restQ.clone().invert());

  // result = base * delta
  const resultQ = baseQ.clone().multiply(delta).normalize();

  // position = base + sampled - rest
  const resultP = new THREE.Vector3(
    base.position[0] + sampled.position[0] - rest.position[0],
    base.position[1] + sampled.position[1] - rest.position[1],
    base.position[2] + sampled.position[2] - rest.position[2]
  );

  return {
    quaternion: [resultQ.x, resultQ.y, resultQ.z, resultQ.w],
    position: [resultP.x, resultP.y, resultP.z]
  };
}
