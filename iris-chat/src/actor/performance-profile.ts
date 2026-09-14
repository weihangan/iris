// Phase 5.2B.3 Closeout Task 1：PerformanceProfile 契约
//
// 用户要求（docs/plans/phase-5.2b3-closeout-and-performance-foundation-plan.md Task 1）：
// - SHA 绑定的 PerformanceProfile，avatarSha256 必须与运行时实际 PMX SHA-256 匹配
// - ProceduralLifeProfile：呼吸/摇摆幅度、speakingScale、眨眼间隔
// - IdleDirectorProfile：idle accent 调度参数
// - validatePerformanceProfile(profile, actualSha256) 严格校验
// - 拒绝：哈希不匹配、非有限值、负幅度、speakingScale 越界 [0,1]、blink min>max、
//   dwell min>max、recentHistorySize 负值、任何 relaxed-pose 分量绝对值 >= 0.3 rad
//
// 边界：
// - 不修改 PMX
// - 不接入 MotionPlayer
// - 不加入 whitelist
// - 只定义契约和校验器
// - 不暴露 mutable Three.js 对象

import type { RelaxedBasePoseOffsets } from './relaxed-base-pose';

/**
 * 程序化生命层 profile（呼吸/摇摆/眨眼）。
 *
 * - breathPrimaryRadians：主呼吸幅度（上半身 X 轴旋转，弧度）
 * - breathSecondaryRadians：次呼吸幅度（肩部 X 轴旋转，弧度）
 * - swayRadians：躯干微摆幅度（上半身 Z 轴旋转，弧度）
 * - speakingScale：说话时生命层缩放系数 [0, 1]
 * - blinkIntervalMinSeconds/MaxSeconds：眨眼间隔范围（秒）
 */
export interface ProceduralLifeProfile {
  readonly breathPrimaryRadians: number;
  readonly breathSecondaryRadians: number;
  readonly swayRadians: number;
  readonly speakingScale: number;
  readonly blinkIntervalMinSeconds: number;
  readonly blinkIntervalMaxSeconds: number;
}

/**
 * IdleDirector profile（idle accent 调度）。
 *
 * - minDwellSeconds/maxDwellSeconds：accent 之间的最小/最大停留间隔（秒）
 * - recentHistorySize：避免重复选择同一 accent 的历史长度
 */
export interface IdleDirectorProfile {
  readonly minDwellSeconds: number;
  readonly maxDwellSeconds: number;
  readonly recentHistorySize: number;
}

/**
 * 绑定到具体 PMX SHA-256 的性能 profile。
 *
 * avatarSha256 必须与运行时实际 PMX SHA-256 匹配，否则校验失败。
 * 这防止 profile 被错误地应用到不同模型。
 */
export interface PerformanceProfile {
  readonly avatarSha256: string;
  readonly relaxedBasePose: RelaxedBasePoseOffsets;
  readonly proceduralLife: ProceduralLifeProfile;
  readonly idleDirector: IdleDirectorProfile;
}

/**
 * relaxed-pose 分量幅度上限（弧度）。
 * 0.3 rad ≈ 17.2°，超过此值表明校准参数异常。
 */
const RELAXED_POSE_COMPONENT_MAX_RAD = 0.3;

/**
 * 校验 PerformanceProfile。
 *
 * 校验规则：
 * 1. avatarSha256 必须与 actualSha256 完全匹配（大小写敏感）
 * 2. avatarSha256 不能为空
 * 3. 所有 proceduralLife 数值必须有限
 * 4. breathPrimaryRadians / breathSecondaryRadians / swayRadians 不能为负
 * 5. speakingScale 必须在 [0, 1] 范围内
 * 6. blinkIntervalMinSeconds <= blinkIntervalMaxSeconds
 * 7. blink 间隔不能为负
 * 8. minDwellSeconds <= maxDwellSeconds
 * 9. dwell 秒数必须有限且不能为负
 * 10. recentHistorySize 必须有限且 >= 0
 * 11. 所有 relaxed-pose 分量必须有限
 * 12. 所有 relaxed-pose 分量绝对值必须 < 0.3 rad
 *
 * @param profile 待校验的 profile
 * @param actualSha256 运行时实际 PMX SHA-256（大写十六进制字符串）
 * @returns { valid: true } 或 { valid: false, reason }
 */
export function validatePerformanceProfile(
  profile: PerformanceProfile,
  actualSha256: string
): { valid: true } | { valid: false; reason: string } {
  // 1. SHA 绑定
  if (!profile.avatarSha256 || typeof profile.avatarSha256 !== 'string') {
    return { valid: false, reason: 'avatarSha256 is empty or not a string' };
  }
  if (profile.avatarSha256 !== actualSha256) {
    return {
      valid: false,
      reason: `SHA-256 mismatch: profile expects "${profile.avatarSha256}" but actual PMX is "${actualSha256}"`
    };
  }

  // 2. relaxedBasePose 校验
  const relaxedBoneNames: Array<keyof RelaxedBasePoseOffsets> = [
    'leftShoulder', 'rightShoulder',
    'leftArm', 'rightArm',
    'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist'
  ];
  for (const boneName of relaxedBoneNames) {
    const offset = profile.relaxedBasePose[boneName];
    if (!Array.isArray(offset) || offset.length !== 3) {
      return { valid: false, reason: `relaxedBasePose.${boneName} must be a 3-tuple` };
    }
    for (let i = 0; i < 3; i++) {
      const v = offset[i];
      if (!Number.isFinite(v)) {
        return { valid: false, reason: `relaxedBasePose.${boneName}[${i}] is not finite (${v})` };
      }
      if (Math.abs(v) >= RELAXED_POSE_COMPONENT_MAX_RAD) {
        return {
          valid: false,
          reason: `relaxedBasePose.${boneName}[${i}] absolute value ${v} >= ${RELAXED_POSE_COMPONENT_MAX_RAD} rad (幅度超界)`
        };
      }
    }
  }

  // 3. proceduralLife 校验
  const pl = profile.proceduralLife;
  if (!Number.isFinite(pl.breathPrimaryRadians)) {
    return { valid: false, reason: `breathPrimaryRadians is not finite (${pl.breathPrimaryRadians})` };
  }
  if (!Number.isFinite(pl.breathSecondaryRadians)) {
    return { valid: false, reason: `breathSecondaryRadians is not finite (${pl.breathSecondaryRadians})` };
  }
  if (!Number.isFinite(pl.swayRadians)) {
    return { valid: false, reason: `swayRadians is not finite (${pl.swayRadians})` };
  }
  if (!Number.isFinite(pl.speakingScale)) {
    return { valid: false, reason: `speakingScale is not finite (${pl.speakingScale})` };
  }
  if (!Number.isFinite(pl.blinkIntervalMinSeconds)) {
    return { valid: false, reason: `blinkIntervalMinSeconds is not finite (${pl.blinkIntervalMinSeconds})` };
  }
  if (!Number.isFinite(pl.blinkIntervalMaxSeconds)) {
    return { valid: false, reason: `blinkIntervalMaxSeconds is not finite (${pl.blinkIntervalMaxSeconds})` };
  }

  if (pl.breathPrimaryRadians < 0) {
    return { valid: false, reason: `breathPrimaryRadians is negative (${pl.breathPrimaryRadians})` };
  }
  if (pl.breathSecondaryRadians < 0) {
    return { valid: false, reason: `breathSecondaryRadians is negative (${pl.breathSecondaryRadians})` };
  }
  if (pl.swayRadians < 0) {
    return { valid: false, reason: `swayRadians is negative (${pl.swayRadians})` };
  }
  if (pl.speakingScale < 0 || pl.speakingScale > 1) {
    return { valid: false, reason: `speakingScale out of [0,1] range (${pl.speakingScale})` };
  }
  if (pl.blinkIntervalMinSeconds < 0 || pl.blinkIntervalMaxSeconds < 0) {
    return { valid: false, reason: `blink interval is negative (min=${pl.blinkIntervalMinSeconds}, max=${pl.blinkIntervalMaxSeconds})` };
  }
  if (pl.blinkIntervalMinSeconds > pl.blinkIntervalMaxSeconds) {
    return { valid: false, reason: `blinkIntervalMinSeconds (${pl.blinkIntervalMinSeconds}) > blinkIntervalMaxSeconds (${pl.blinkIntervalMaxSeconds})` };
  }

  // 4. idleDirector 校验
  const id = profile.idleDirector;
  if (!Number.isFinite(id.minDwellSeconds)) {
    return { valid: false, reason: `minDwellSeconds is not finite (${id.minDwellSeconds})` };
  }
  if (!Number.isFinite(id.maxDwellSeconds)) {
    return { valid: false, reason: `maxDwellSeconds is not finite (${id.maxDwellSeconds})` };
  }
  if (!Number.isFinite(id.recentHistorySize)) {
    return { valid: false, reason: `recentHistorySize is not finite (${id.recentHistorySize})` };
  }
  if (id.minDwellSeconds < 0 || id.maxDwellSeconds < 0) {
    return { valid: false, reason: `dwell seconds is negative (min=${id.minDwellSeconds}, max=${id.maxDwellSeconds})` };
  }
  if (id.minDwellSeconds > id.maxDwellSeconds) {
    return { valid: false, reason: `minDwellSeconds (${id.minDwellSeconds}) > maxDwellSeconds (${id.maxDwellSeconds})` };
  }
  if (id.recentHistorySize < 0 || !Number.isInteger(id.recentHistorySize)) {
    return { valid: false, reason: `recentHistorySize must be a non-negative integer (${id.recentHistorySize})` };
  }

  return { valid: true };
}
