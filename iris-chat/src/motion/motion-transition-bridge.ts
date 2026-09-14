import * as THREE from 'three';
import type { MmdAnimation, VmdBoneTrack } from '@yohawing/three-mmd-loader/parser';

export interface VmdLocalPose {
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

export interface TransitionBridgeOptions {
  readonly speedMultiplier: number;
  readonly frameRate?: number;
  readonly profile?: TransitionBridgeProfile;
  /** Upper bound used for short one-shot actions so the bridge cannot hide the clip. */
  readonly maximumDurationSeconds?: number;
  /** Optional lower bound for a first body bind from the natural base pose. */
  readonly minimumDurationSeconds?: number;
  /** Optional local-pose waypoints reached before the target pose. */
  readonly waypointPoses?: ReadonlyMap<string, VmdLocalPose>;
  /** Optional ordered route, used when one clearance point is not enough. */
  readonly waypointSequences?: ReadonlyMap<string, readonly VmdLocalPose[]>;
  /**
   * Outgoing clip poses sampled a short moment after the handoff frame.
   * Upper-body bones with real motion receive an extrapolation waypoint so
   * the bridge continues at the outgoing angular speed instead of freezing
   * and restarting (C1 velocity continuity). Lower body is never touched.
   */
  readonly sourceVelocityPoses?: ReadonlyMap<string, VmdLocalPose>;
  /** Seconds between sourcePoses and sourceVelocityPoses samples. Default 0.1. */
  readonly sourceVelocityLookaheadSeconds?: number;
  /**
   * Target clip poses sampled shortly after the bridge's target frame. Used
   * only to relax the final S-curve's end slope so the target clip's own
   * opening motion does not start from a standstill.
   */
  readonly targetVelocityPoses?: ReadonlyMap<string, VmdLocalPose>;
  /** Seconds between the bridge target pose and targetVelocityPoses samples. Default 0.1. */
  readonly targetVelocityLookaheadSeconds?: number;
}

export type TransitionBridgeProfile = 'default' | 'speech-entry' | 'speech-to-idle-recovery';

export interface TransitionBridgeResult {
  readonly animation: MmdAnimation;
  readonly durationSeconds: number;
}

const IDENTITY_POSE: VmdLocalPose = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1]
};

const LOWER_BODY_TRANSITION_BONE = /^(?:全ての親|センター\d*|グルーブ\d*|腰|下半身|[左右](?:足|ひざ|膝|足首|足(?:ＩＫ|IK)親|つま先(?:ＩＫ|IK)親|足(?:ＩＫ|IK)|つま先(?:ＩＫ|IK)|足D|ひざD|膝D|足首D|足先EX))$/u;
const UPPER_BODY_INERTIAL_TRANSITION_BONE = /^(?:上半身[23]?|首|頭|[左右](?:肩P?|腕|腕捩|ひじ|手捩|手首|親指[０12]|人指[123]|中指[123]|薬指[123]|小指[123]))$/u;
const TRANSLATION_INERTIAL_TRANSITION_BONE = /^(?:センター\d*|グルーブ\d*|腰|[左右](?:(?:足|つま先)(?:ＩＫ|IK)(?:親)?))$/u;

export function isLowerBodyTransitionBone(boneName: string): boolean {
  return LOWER_BODY_TRANSITION_BONE.test(boneName);
}

export function isInertialTransitionBone(boneName: string): boolean {
  return isLowerBodyTransitionBone(boneName)
    || UPPER_BODY_INERTIAL_TRANSITION_BONE.test(boneName);
}

/**
 * These controller bones legitimately carry authored local translation.  If
 * they are rebound without translation inertialization, every descendant
 * (including Bullet-owned hair and clothes) receives the same one-frame world
 * displacement even when its own physics output is continuous.
 */
export function shouldInertializeTranslation(boneName: string): boolean {
  return TRANSLATION_INERTIAL_TRANSITION_BONE.test(boneName);
}

/**
 * Bones allowed to receive C1 velocity continuation at a bridge handoff.
 * Deliberately upper-body only: root/center/waist/legs/IK keep their frozen
 * fail-closed behavior and are never extrapolated.
 */
export function isUpperBodyVelocityContinuationBone(boneName: string): boolean {
  return UPPER_BODY_INERTIAL_TRANSITION_BONE.test(boneName);
}

/** 速度连续桥的外推 waypoint：帧号、姿态与切换瞬间的角速度（rad/s）。 */
interface VelocityWaypoint {
  readonly frame: number;
  readonly pose: VmdLocalPose;
  readonly angularSpeed: number;
}

function transitionWindow(name: string, profile: TransitionBridgeProfile): { start: number; end: number } {
  if (profile === 'speech-to-idle-recovery') {
    if (/^上半身[23]?$/u.test(name)) return { start: 0.03, end: 0.68 };
    if (/^[左右]肩P?$/u.test(name)) return { start: 0.06, end: 0.72 };
    if (/^[左右](腕|腕捩|ひじ|手捩|手首)$/u.test(name)) return { start: 0.08, end: 0.78 };
    if (/^(首|頭)$/u.test(name)) return { start: 0.12, end: 1 };
  }
  // Keep every lower-body controller on one clock. Staggering hip/leg/knee/IK
  // used to briefly solve the feet against mismatched parents, producing the
  // visible two-leg crouch between otherwise mild one-leg poses.
  if (isLowerBodyTransitionBone(name)) {
    return { start: 0.02, end: 1 };
  }
  if (/^上半身[23]?$/u.test(name)) return { start: 0.03, end: 0.86 };
  if (/^(首|頭)$/u.test(name)) return { start: 0.04, end: 0.9 };
  if (/^[左右]肩P?$/u.test(name)) return { start: 0.06, end: 0.93 };
  if (/^[左右](腕|腕捩)$/u.test(name)) return { start: 0.08, end: 0.95 };
  if (/^[左右](ひじ|手捩)$/u.test(name)) return { start: 0.1, end: 0.97 };
  if (/^[左右]手首$/u.test(name)) return { start: 0.12, end: 1 };
  if (/^[左右](親指|人指|中指|薬指|小指)/u.test(name)) return { start: 0.15, end: 1 };
  return { start: 0.08, end: 0.94 };
}

function quaternionAngle(a: VmdLocalPose, b: VmdLocalPose): number {
  return new THREE.Quaternion(...a.rotation).normalize()
    .angleTo(new THREE.Quaternion(...b.rotation).normalize());
}

function translationDistance(a: VmdLocalPose, b: VmdLocalPose): number {
  const dx = a.translation[0] - b.translation[0];
  const dy = a.translation[1] - b.translation[1];
  const dz = a.translation[2] - b.translation[2];
  return Math.hypot(dx, dy, dz);
}

function copyPose(value: VmdLocalPose): VmdLocalPose {
  return {
    translation: [...value.translation],
    rotation: [...value.rotation]
  };
}

function interpolatePoses(a: VmdLocalPose, b: VmdLocalPose, alpha: number): VmdLocalPose {
  const t = THREE.MathUtils.clamp(alpha, 0, 1);
  const aRotation = new THREE.Quaternion(...a.rotation).normalize();
  const bRotation = new THREE.Quaternion(...b.rotation).normalize();
  if (aRotation.dot(bRotation) < 0) {
    bRotation.set(-bRotation.x, -bRotation.y, -bRotation.z, -bRotation.w);
  }
  aRotation.slerp(bRotation, t);
  return {
    translation: [
      THREE.MathUtils.lerp(a.translation[0], b.translation[0], t),
      THREE.MathUtils.lerp(a.translation[1], b.translation[1], t),
      THREE.MathUtils.lerp(a.translation[2], b.translation[2], t)
    ],
    rotation: [aRotation.x, aRotation.y, aRotation.z, aRotation.w]
  };
}

/**
 * Builds an extrapolation waypoint for a mid-motion handoff. The outgoing
 * clip's angular velocity is estimated from a short lookahead sample and the
 * visible source pose is extended along that direction, so the bridge begins
 * moving at the outgoing speed instead of freezing. Guardrails:
 * - negligible motion (< 0.18 rad/s) or extreme speed (> 8 rad/s capped);
 * - extrapolated angle capped at ~17° and translation at 0.06;
 * - a strong move away from the target is damped, then rejected if it still
 *   heads away — the bridge falls back to the plain eased track.
 */
function buildVelocityWaypoint(
  source: VmdLocalPose,
  velocityPose: VmdLocalPose | undefined,
  lookaheadSeconds: number,
  frameRate: number,
  startFrame: number,
  endFrame: number,
  target: VmdLocalPose
): VelocityWaypoint | undefined {
  if (!velocityPose) return undefined;
  const lookahead = THREE.MathUtils.clamp(lookaheadSeconds, 1 / 60, 0.25);
  const deltaAngle = quaternionAngle(source, velocityPose);
  const angularSpeed = deltaAngle / lookahead;
  if (angularSpeed < 0.18) return undefined;
  const baseFrame = startFrame > 0 ? startFrame : 0;
  const maxHorizonFrames = endFrame - 1 - baseFrame;
  if (maxHorizonFrames < 2) return undefined;
  const horizonFrames = Math.min(maxHorizonFrames, Math.max(2, Math.round(0.12 * frameRate)));
  const velocityFrame = baseFrame + horizonFrames;
  const elapsedSeconds = velocityFrame / frameRate;
  const scale = Math.min(1, elapsedSeconds / lookahead, 0.3 / Math.max(deltaAngle, 1e-6));
  if (scale <= 0.02) return undefined;
  const sourceRotation = new THREE.Quaternion(...source.rotation).normalize();
  const velocityRotation = new THREE.Quaternion(...velocityPose.rotation).normalize();
  if (sourceRotation.dot(velocityRotation) < 0) {
    velocityRotation.set(-velocityRotation.x, -velocityRotation.y, -velocityRotation.z, -velocityRotation.w);
  }
  const deltaRotation = sourceRotation.clone().invert().multiply(velocityRotation).normalize();
  const step = new THREE.Quaternion().slerp(deltaRotation, scale);
  const rotation = sourceRotation.clone().multiply(step).normalize();
  const rawTranslation: [number, number, number] = [
    source.translation[0] + (velocityPose.translation[0] - source.translation[0]) * scale,
    source.translation[1] + (velocityPose.translation[1] - source.translation[1]) * scale,
    source.translation[2] + (velocityPose.translation[2] - source.translation[2]) * scale
  ];
  const translationMagnitude = Math.hypot(
    rawTranslation[0] - source.translation[0],
    rawTranslation[1] - source.translation[1],
    rawTranslation[2] - source.translation[2]
  );
  const translation = translationMagnitude > 0.06 && translationMagnitude > 1e-9
    ? [
        source.translation[0] + (rawTranslation[0] - source.translation[0]) * (0.06 / translationMagnitude),
        source.translation[1] + (rawTranslation[1] - source.translation[1]) * (0.06 / translationMagnitude),
        source.translation[2] + (rawTranslation[2] - source.translation[2]) * (0.06 / translationMagnitude)
      ] as [number, number, number]
    : rawTranslation;
  let pose: VmdLocalPose = {
    translation,
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w]
  };
  // 偏航防护：外推允许小幅“顺势过头”（follow-through），但远离目标的
  // 幅度不得超过剩余行程的一半（下限 0.1、上限 0.3 rad）。超限时先衰减
  // 两次，仍严重偏离则放弃外推，回退到普通 eased 轨道。
  const sourceToTarget = quaternionAngle(source, target);
  const allowedAway = THREE.MathUtils.clamp(0.5 * sourceToTarget, 0.1, 0.3);
  let away = quaternionAngle(pose, target) - sourceToTarget;
  let dampings = 0;
  while (away > allowedAway && dampings < 2) {
    pose = interpolatePoses(source, pose, 0.5);
    away = quaternionAngle(pose, target) - sourceToTarget;
    dampings += 1;
  }
  if (away > allowedAway) return undefined;
  const effectiveSpeed = Math.max(
    0.18,
    quaternionAngle(source, pose) / Math.max(1 / frameRate, elapsedSeconds)
  );
  return { frame: velocityFrame, pose, angularSpeed: Math.min(effectiveSpeed, 8) };
}

/**
 * Lower-body controller translations are model-space offsets, not a safe
 * handoff signal. Keep the visible source translation while the joint
 * rotations move through the bridge; authored in-place leg lifts remain in
 * the rotation channels and therefore still play normally.
 */
function preserveTransitionTranslation(name: string): boolean {
  return isLowerBodyTransitionBone(name);
}

function createEaseInOutInterpolations(frameCount: number): Float32Array {
  const values = new Float32Array(frameCount * 16);
  for (let frameIndex = 1; frameIndex < frameCount; frameIndex += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = frameIndex * 16 + channel * 4;
      // 更强的自然 S 曲线：(0.36, 0, 0.64, 1) 在 1/4 时间处只完成约 15%
      // 的变化（旧 (0.25, 0, 0.75, 1) 约 18.5%，接近线性）。起步有预备、
      // 收尾带缓落，配合更长的桥时长，衔接读作连续而非突变。
      values[offset] = 0.36;
      values[offset + 1] = 0;
      values[offset + 2] = 0.64;
      values[offset + 3] = 1;
    }
  }
  return values;
}

function normalizeTargetRotation(source: VmdLocalPose, target: VmdLocalPose): VmdLocalPose {
  const sourceRotation = new THREE.Quaternion(...source.rotation).normalize();
  const targetRotation = new THREE.Quaternion(...target.rotation).normalize();
  if (sourceRotation.dot(targetRotation) < 0) {
    targetRotation.set(-targetRotation.x, -targetRotation.y, -targetRotation.z, -targetRotation.w);
  }
  return {
    translation: target.translation,
    rotation: [targetRotation.x, targetRotation.y, targetRotation.z, targetRotation.w]
  };
}

function createTrack(
  source: VmdLocalPose,
  target: VmdLocalPose,
  startFrame: number,
  endFrame: number,
  waypoints: readonly VmdLocalPose[] = [],
  velocityWaypoint?: VelocityWaypoint,
  targetAngularSpeed = 0,
  frameRate = 30
): VmdBoneTrack {
  const sourceRotation = new THREE.Quaternion(...source.rotation).normalize();
  const normalizedSource: VmdLocalPose = {
    translation: source.translation,
    rotation: [sourceRotation.x, sourceRotation.y, sourceRotation.z, sourceRotation.w]
  };
  const normalizedWaypoints: VmdLocalPose[] = [];
  let previous = normalizedSource;
  for (const waypoint of waypoints) {
    const normalized = normalizeTargetRotation(previous, waypoint);
    normalizedWaypoints.push(normalized);
    previous = normalized;
  }
  const normalizedTarget = normalizeTargetRotation(previous, target);
  const waypointFrames = normalizedWaypoints.map((_, index) => Math.max(
    startFrame + index + 1,
    Math.min(
      endFrame - (normalizedWaypoints.length - index),
      Math.round(startFrame + ((endFrame - startFrame) * (index + 1)) / (normalizedWaypoints.length + 1))
    )
  ));
  const useWaypoints = normalizedWaypoints.length > 0
    && waypointFrames.every((frame, index) => frame > startFrame && frame < endFrame
      && (index === 0 || frame > waypointFrames[index - 1]));
  // 速度连续路径只在没有 authored waypoint 路线时启用（调用方同样保证），
  // 两条路线同时存在会互相覆盖关键帧布局。
  const useVelocityWaypoint = velocityWaypoint !== undefined && !useWaypoints;
  const velocityFrame = useVelocityWaypoint ? velocityWaypoint!.frame : 0;
  if (useVelocityWaypoint && velocityFrame <= startFrame) {
    // 外推帧必须落在 startFrame 之后，否则退回普通 eased 轨道。
    return createTrack(source, target, startFrame, endFrame, waypoints);
  }

  let frames: Uint32Array;
  let poses: VmdLocalPose[];
  /** 需要近乎线性插值（保持外推速度）的关键帧下标。 */
  const linearKeyIndices: number[] = [];
  if (useVelocityWaypoint) {
    const velocityPose = normalizeTargetRotation(normalizedSource, velocityWaypoint!.pose);
    if (startFrame > 0) {
      // 桥的前段不再冻结：按外推速度穿过 [0, startFrame] 继续运动，
      // 使切换瞬间速度连续（C1）而非急停后再起步。
      const holdPose = interpolatePoses(normalizedSource, velocityPose, startFrame / velocityFrame);
      frames = new Uint32Array([0, startFrame, velocityFrame, endFrame]);
      poses = [normalizedSource, holdPose, velocityPose, normalizedTarget];
      linearKeyIndices.push(1, 2);
    } else {
      frames = new Uint32Array([0, velocityFrame, endFrame]);
      poses = [normalizedSource, velocityPose, normalizedTarget];
      linearKeyIndices.push(1);
    }
  } else if (startFrame > 0) {
    frames = useWaypoints
      ? new Uint32Array([0, startFrame, ...waypointFrames, endFrame])
      : new Uint32Array([0, startFrame, endFrame]);
    poses = useWaypoints
      ? [normalizedSource, normalizedSource, ...normalizedWaypoints, normalizedTarget]
      : [normalizedSource, normalizedSource, normalizedTarget];
  } else {
    frames = useWaypoints
      ? new Uint32Array([0, ...waypointFrames, endFrame])
      : new Uint32Array([0, endFrame]);
    poses = useWaypoints
      ? [normalizedSource, ...normalizedWaypoints, normalizedTarget]
      : [normalizedSource, normalizedTarget];
  }
  const translations = new Float32Array(poses.length * 3);
  const rotations = new Float32Array(poses.length * 4);
  poses.forEach((pose, index) => {
    translations.set(pose.translation, index * 3);
    rotations.set(pose.rotation, index * 4);
  });
  const interpolations = createEaseInOutInterpolations(poses.length);
  // 中间关键帧 C1 速度连续（2026-08 用户反馈"动作连贯性差"）：
  // 默认每段都是 ease-in-out（首尾速度 0），带 waypoint 的多段路线在
  // 中间关键帧处速度归零，观感"走走停停"。按相邻段的平均角速度在共享
  // 关键帧处匹配离开/到达斜率，让整条路线匀畅贯通；首尾关键帧仍保留
  // 缓起缓落。相邻段有一段近似静止（角度 < 1e-4 rad）时不匹配，退回
  // ease-in-out，避免给静止段注入虚假速度。
  for (let keyIndex = 1; keyIndex < poses.length - 1; keyIndex += 1) {
    const previousSegmentSeconds = (frames[keyIndex] - frames[keyIndex - 1]) / Math.max(1, frameRate);
    const nextSegmentSeconds = (frames[keyIndex + 1] - frames[keyIndex]) / Math.max(1, frameRate);
    const previousSegmentAngle = quaternionAngle(poses[keyIndex - 1], poses[keyIndex]);
    const nextSegmentAngle = quaternionAngle(poses[keyIndex], poses[keyIndex + 1]);
    if (previousSegmentSeconds <= 0 || nextSegmentSeconds <= 0) continue;
    if (previousSegmentAngle < 1e-4 || nextSegmentAngle < 1e-4) continue;
    const previousSpeed = previousSegmentAngle / previousSegmentSeconds;
    const nextSpeed = nextSegmentAngle / nextSegmentSeconds;
    // 共享关键帧处的公共速度取调和平均：两段速度差再大也不会放大越界。
    const commonSpeed = 2 * previousSpeed * nextSpeed / (previousSpeed + nextSpeed);
    const leaveSlope = THREE.MathUtils.clamp(commonSpeed / Math.max(nextSpeed, 1e-9), 0.15, 0.85);
    const arriveSlope = THREE.MathUtils.clamp(commonSpeed / Math.max(previousSpeed, 1e-9), 0.15, 0.85);
    for (let channel = 0; channel < 4; channel += 1) {
      // 前段（到达 keyIndex）终点控制点：x2 固定 0.64，y2 = 1 - slope*(1-0.64)。
      const arriveOffset = keyIndex * 16 + channel * 4;
      interpolations[arriveOffset + 3] = 1 - arriveSlope * 0.36;
      // 后段（离开 keyIndex）起点控制点：x1 固定 0.36，y1 = slope*0.36。
      const leaveOffset = (keyIndex + 1) * 16 + channel * 4;
      interpolations[leaveOffset + 1] = leaveSlope * 0.36;
    }
  }
  // 速度段用线性控制点（控制点在对角线上 => 恒定斜率），保持切换瞬间的角速度。
  for (const keyIndex of linearKeyIndices) {
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = keyIndex * 16 + channel * 4;
      interpolations[offset] = 0.2;
      interpolations[offset + 1] = 0.2;
      interpolations[offset + 2] = 0.8;
      interpolations[offset + 3] = 0.8;
    }
  }
  // 最后一段的旋转通道按端点速度匹配贝塞尔控制点：
  // 起始斜率 = y1/x1，应等于外推角速度；结束斜率 = (1-y2)/(1-x2)，
  // 应等于目标 clip 的开场角速度，避免桥尾减速到零后目标动作突起步。
  const lastKeyIndex = poses.length - 1;
  const finalSegmentSeconds = (frames[lastKeyIndex] - frames[lastKeyIndex - 1]) / Math.max(1, frameRate);
  const finalSegmentAngle = quaternionAngle(poses[lastKeyIndex - 1], poses[lastKeyIndex]);
  if (finalSegmentSeconds > 0 && finalSegmentAngle > 1e-4) {
    const rotationOffset = lastKeyIndex * 16 + 3 * 4;
    if (useVelocityWaypoint) {
      interpolations[rotationOffset + 1] = THREE.MathUtils.clamp(
        0.36 * (velocityWaypoint!.angularSpeed * finalSegmentSeconds) / finalSegmentAngle,
        0,
        0.85
      );
    }
    if (targetAngularSpeed > 0.18) {
      interpolations[rotationOffset + 3] = THREE.MathUtils.clamp(
        1 - 0.36 * (targetAngularSpeed * finalSegmentSeconds) / finalSegmentAngle,
        0.15,
        1
      );
    }
  }
  const physicsToggles = new Int8Array(poses.length);
  physicsToggles.fill(-1);
  return {
    packed: 'bone',
    frames,
    translations,
    rotations,
    interpolations,
    physicsToggles
  };
}

/**
 * Builds a short in-memory VMD so interpolation happens before append bones,
 * IK and Bullet. Root translation is deliberately pinned; center and foot-IK
 * offsets remain in the clip and therefore move continuously through MMD IK.
 */
export function createTransitionBridgeAnimation(
  sourcePoses: ReadonlyMap<string, VmdLocalPose>,
  targetPoses: ReadonlyMap<string, VmdLocalPose>,
  options: TransitionBridgeOptions
): TransitionBridgeResult {
  const speed = Math.min(1.8, Math.max(0.5, Number.isFinite(options.speedMultiplier) ? options.speedMultiplier : 1));
  const frameRate = Math.max(1, options.frameRate ?? 30);
  const profile = options.profile ?? 'default';
  const names = [...new Set([...sourcePoses.keys(), ...targetPoses.keys()])];

  let maxAngle = 0;
  let maxTranslation = 0;
  let maxRouteSegments = 1;
  for (const name of names) {
    const source = sourcePoses.get(name) ?? IDENTITY_POSE;
    const target = targetPoses.get(name) ?? IDENTITY_POSE;
    const route = [
      source,
      ...(options.waypointSequences?.get(name) ?? (options.waypointPoses?.has(name)
        ? [options.waypointPoses.get(name)!]
        : [])),
      target
    ];
    maxRouteSegments = Math.max(maxRouteSegments, route.length - 1);
    for (let index = 1; index < route.length; index += 1) {
      maxAngle = Math.max(maxAngle, quaternionAngle(route[index - 1], route[index]));
      maxTranslation = Math.max(maxTranslation, translationDistance(route[index - 1], route[index]));
    }
  }
  const baseDurationSeconds = THREE.MathUtils.clamp(
    (0.75 + maxAngle * 0.5 + Math.min(maxTranslation, 5) * 0.06) / speed,
    0.75,
    1.45
  );
  const profileDurationSeconds = profile === 'speech-to-idle-recovery'
    // The reverse hands-behind route needs enough time for three deliberate
    // phases: speech pose -> arms at sides -> proximal arm behind -> idle.
    // 2026-08: 各档整体放宽（原 1.18/[1.12,1.4] 与 1.08/[0.84,1.14]）——
    // 用户反馈语音动作衔接仍偏快、希望更稳更自然；更长的桥配合更强的
    // S 曲线让中段行程平缓、裙摆链可跟随。
      ? maxRouteSegments >= 3
      ? THREE.MathUtils.clamp(baseDurationSeconds * 1.35, 1.35, 1.8)
      : THREE.MathUtils.clamp(baseDurationSeconds * 1.15, 0.95, 1.3)
    : profile === 'speech-entry'
      // Give arms and secondary physics enough time to clear the torso before
      // the authored speech clip starts. This is still one short bridge, not
      // an extra action, but avoids a visibly rushed handoff.
      // 2026-08（用户二次反馈"进入语音动作太快"）：各档再放宽 ~0.2s，
      // 中段行程更平缓，Bullet 裙摆/袖子链有时间跟随。
      ? maxRouteSegments >= 3
        ? THREE.MathUtils.clamp(baseDurationSeconds * 1.5, 1.5, 1.9)
        : THREE.MathUtils.clamp(baseDurationSeconds * 1.45, 1.4, 1.8)
      : baseDurationSeconds;
  const requestedMaximum = Number.isFinite(options.maximumDurationSeconds)
    ? Math.max(0.2, options.maximumDurationSeconds!)
    : Number.POSITIVE_INFINITY;
  // A staged arm route needs at least four intervals (source, two clearance
  // points, target). Preserve enough real frames for that route while keeping
  // the handoff proportionate to a short user-imported clip.
  const routeMinimumSeconds = Math.max(2, maxRouteSegments + 1) / frameRate;
  const durationSeconds = Math.max(
    routeMinimumSeconds,
    Number.isFinite(options.minimumDurationSeconds)
      ? Math.max(0.2, options.minimumDurationSeconds!)
      : 0,
    Math.min(profileDurationSeconds, requestedMaximum)
  );
  const durationFrames = Math.max(2, Math.round(durationSeconds * frameRate));
  const boneTracks: Record<string, VmdBoneTrack> = {};

  for (const name of names) {
    const source = copyPose(sourcePoses.get(name) ?? IDENTITY_POSE);
    const rawTarget = copyPose(targetPoses.get(name) ?? IDENTITY_POSE);
    const target = preserveTransitionTranslation(name)
      ? { ...rawTarget, translation: [...source.translation] as [number, number, number] }
      : rawTarget;
    const window = transitionWindow(name, profile);
    // P3: 大转角的上半身骨骼提前启动，避免大位移骨骼在桥尾仓促赶位、
    // 小位移骨骼早早到位干等。下半身保持同一时钟（IK 链一致性），不受影响。
    const boneAngle = quaternionAngle(source, target);
    const adaptiveStart = isLowerBodyTransitionBone(name)
      ? window.start
      : window.start * THREE.MathUtils.clamp(1 - boneAngle / Math.PI, 0.5, 1);
    const startFrame = Math.min(durationFrames - 1, Math.round(durationFrames * adaptiveStart));
    const endFrame = Math.max(startFrame + 1, Math.round(durationFrames * window.end));
    const waypoints = options.waypointSequences?.get(name)
      ?? (options.waypointPoses?.has(name) ? [options.waypointPoses.get(name)!] : []);
    // P1: 运动中切换时，上半身骨骼按外推速度继续运动（C1 连续），
    // 不再先冻结再缓动起步。带 authored waypoint 路线的骨骼（背后手
    // 路线等）不叠加外推，避免两条路线互相冲突。
    const velocityWaypoint = waypoints.length === 0 && isUpperBodyVelocityContinuationBone(name)
      ? buildVelocityWaypoint(
          source,
          options.sourceVelocityPoses?.get(name),
          options.sourceVelocityLookaheadSeconds ?? 0.1,
          frameRate,
          startFrame,
          endFrame,
          target
        )
      : undefined;
    // 目标 clip 开场自带运动时，桥尾提前带一点末速度，目标动作不从静止突起步。
    const targetVelocityPose = isUpperBodyVelocityContinuationBone(name)
      ? options.targetVelocityPoses?.get(name)
      : undefined;
    const targetAngularSpeed = targetVelocityPose
      ? Math.min(
          8,
          quaternionAngle(target, targetVelocityPose)
            / THREE.MathUtils.clamp(options.targetVelocityLookaheadSeconds ?? 0.1, 1 / 60, 0.25)
        )
      : 0;
    boneTracks[name] = createTrack(
      source,
      target,
      startFrame,
      endFrame,
      waypoints,
      velocityWaypoint,
      targetAngularSpeed,
      frameRate
    );
  }

  const boneFrameCount = Object.values(boneTracks)
    .reduce((count, track) => count + track.frames.length, 0);
  return {
    durationSeconds: durationFrames / frameRate,
    animation: {
      kind: 'vmd',
      bytes: new Uint8Array(),
      metadata: {
        modelName: 'ChatX2 transition bridge',
        counts: {
          bones: boneFrameCount,
          morphs: 0,
          cameras: 0,
          lights: 0,
          selfShadows: 0,
          properties: 0
        },
        maxFrame: durationFrames,
        name: 'pose-aware-transition-bridge'
      } as any,
      boneTracks,
      morphTracks: {},
      cameraFrames: [],
      lightFrames: [],
      selfShadowFrames: [],
      propertyFrames: []
    }
  };
}

/** Keeps desktop avatars grounded: no root translation, pitch or roll. */
export function stabilizeGroundedRootTrack(track: VmdBoneTrack): VmdBoneTrack {
  const rotations = new Float32Array(track.rotations.length);
  for (let index = 0; index < track.frames.length; index += 1) {
    const offset = index * 4;
    const source = new THREE.Quaternion(
      track.rotations[offset] ?? 0,
      track.rotations[offset + 1] ?? 0,
      track.rotations[offset + 2] ?? 0,
      track.rotations[offset + 3] ?? 1
    ).normalize();
    const euler = new THREE.Euler().setFromQuaternion(source, 'YXZ');
    const yawOnly = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y);
    rotations.set([yawOnly.x, yawOnly.y, yawOnly.z, yawOnly.w], offset);
  }
  return {
    ...track,
    translations: new Float32Array(track.translations.length),
    rotations
  };
}

export function sampleVmdBoneTrack(track: VmdBoneTrack | undefined, frame: number): VmdLocalPose | undefined {
  if (!track || track.frames.length === 0) return undefined;
  let previousIndex = 0;
  let nextIndex = 0;
  for (let index = 1; index < track.frames.length; index += 1) {
    if ((track.frames[index] ?? 0) >= frame) {
      nextIndex = index;
      break;
    }
    previousIndex = index;
    nextIndex = index;
  }
  if (frame <= (track.frames[0] ?? 0)) previousIndex = nextIndex = 0;
  const previousFrame = track.frames[previousIndex] ?? 0;
  const nextFrame = track.frames[nextIndex] ?? previousFrame;
  const t = nextFrame === previousFrame
    ? 0
    : THREE.MathUtils.clamp((frame - previousFrame) / (nextFrame - previousFrame), 0, 1);
  const translation = [0, 1, 2].map(axis => THREE.MathUtils.lerp(
    track.translations[previousIndex * 3 + axis] ?? 0,
    track.translations[nextIndex * 3 + axis] ?? 0,
    t
  )) as [number, number, number];
  const previousRotation = new THREE.Quaternion(
    track.rotations[previousIndex * 4] ?? 0,
    track.rotations[previousIndex * 4 + 1] ?? 0,
    track.rotations[previousIndex * 4 + 2] ?? 0,
    track.rotations[previousIndex * 4 + 3] ?? 1
  ).normalize();
  const nextRotation = new THREE.Quaternion(
    track.rotations[nextIndex * 4] ?? 0,
    track.rotations[nextIndex * 4 + 1] ?? 0,
    track.rotations[nextIndex * 4 + 2] ?? 0,
    track.rotations[nextIndex * 4 + 3] ?? 1
  ).normalize();
  previousRotation.slerp(nextRotation, t);
  return {
    translation,
    rotation: [previousRotation.x, previousRotation.y, previousRotation.z, previousRotation.w]
  };
}
