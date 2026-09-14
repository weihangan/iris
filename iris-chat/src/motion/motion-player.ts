// Phase 5.2B: VMD 动作播放器（修正版 2026-07-19）
//
// 用户要求（2026-07-19）：
// - MotionPlayer 注入时间源：idle 可用单调本地时钟；speaking 必须直接使用已对齐的 PerformanceClock.now()，
//   且 AudioContext 未运行/未对齐时禁止启动 speaking motion
// - 真正执行 fade：idle 动作进入/退出至少 0.5 秒；动作切换不得先瞬间 reset 到 Base Pose
// - 实现 cooldown 调度，同一 idle accent 至少 30 秒不重复
//
// 职责：
// - 加载 VMD 字节 → MmdAnimation → model.setAnimation(animation)
// - 通过 BoneOwnershipRegistry claim 骨骼（store leases）
// - 通过 MorphOwnershipRegistry claim morph（如有 まばたき 轨道）
// - 每帧 model.update(seconds) 会采样 VMD 写入骨骼 quaternion + morph weight
// - 时间源注入：idle=local-clock，speaking=performance-clock
// - Fade 实现：进入/退出时 lerp rest pose 与 VMD-sampled pose
// - Cooldown：同一 packId 在 cooldownSeconds 内不重复启动
// - stop 时：fade-out → clearAnimation + release all leases + resetPose + 恢复 procedural
//
// 与 ProceduralLifeController 的协作：
// - MotionPlayer.play() claim 骨骼后，ProceduralLifeController.update() 每帧查 registry
//   发现 VMD 持有 → 跳过 procedural 写入 → VMD 值存活
// - MotionPlayer.stop() release 骨骼后，procedural 恢复写入
// - まばたき：VMD 有轨道時 claim morph，procedural 跳过眨眼；无轨道時 procedural 正常眨眼

import type { ThreeMmdModel } from '@yohawing/three-mmd-loader';
import type { MmdAnimation, VmdBoneTrack } from '@yohawing/three-mmd-loader/parser';
import * as THREE from 'three';
import {
  loadVmd,
  retargetBones,
  applyAmplitudeLimits,
  hasBlinkTrack,
  extractBoneNames,
  filterAnimationTracks,
  buildCompatibleBoneMapping,
  type LoadedVmd
} from './motion-pack-loader';
import type { AmplitudeLimits, BoneMapping } from './motion-pack-types';
import type {
  SpeechStanceAccent,
  SpeechStanceProfile
} from '../performance/speech-stance-director';
import {
  applySpeechStanceTracks,
  isRestrainedDialogueSourceBone
} from './speech-stance-tracks';
import {
  BoneOwnershipRegistry,
  MorphOwnershipRegistry,
  extractMorphNamesFromAnimation,
  type OwnershipLease
} from '../actor/bone-ownership-registry';
import type { PerformanceClock } from '../performance/performance-clock';
import { composeBonePose, type MotionCompositionMode, type BonePose } from './pose-composition';
import { MotionRequestGate } from './motion-request-gate';
import { PoseInertializer, type LocalBonePose } from './pose-inertializer';
import {
  createTransitionBridgeAnimation,
  isInertialTransitionBone,
  isUpperBodyVelocityContinuationBone,
  shouldInertializeTranslation,
  sampleVmdBoneTrack,
  stabilizeGroundedRootTrack,
  type TransitionBridgeProfile,
  type VmdLocalPose
} from './motion-transition-bridge';
import { stripCandidateMorphTracks } from './vmd-performance-candidate-router';

// 重新导出组合模式类型（供 MotionSequence 等外部使用）
export type { MotionCompositionMode };

// ============================================================
// 时间源
// ============================================================

/**
 * 时间源类型：
 * - 'local-clock'：单调本地时钟（performance.now() / 1000），用于 idle 等无音频关联的动作
 * - 'performance-clock'：已对齐的 PerformanceClock.now()，用于 speaking 等需要与 AudioContext 同步的动作
 */
export type MotionTimeSource = 'local-clock' | 'performance-clock';
export type CandidateTrackPolicy =
  | 'standard-upper-body'
  | 'dialogue-body-only'
  /** Shared full-body motions: keep authored joint rotations/morphs but rebase controller translations. */
  | 'grounded-full-body'
  /** Trusted user voice-pool clips retain authored lower-body tracks. */
  | 'trusted-voice-full-body';

const STANDARD_UPPER_BODY_BONE = /^(上半身[23]?|首|頭|[左右](肩P?|腕|腕捩|ひじ|手捩|手首|親指[０12]|人指[123]|中指[123]|薬指[123]|小指[123]))$/u;
/**
 * Bones that are safe to soften after a VMD sample has been evaluated.
 *
 * This is deliberately a controller allow-list rather than "all bones":
 * hair, cloth, ribbons and other Bullet-owned descendants must keep their
 * native physics output, while root/center/IK/lower-body channels must not
 * acquire a delayed smoothing pass that would read as foot sliding or model
 * drift. The upper-body chain is where a short rotational follow-through
 * removes the rigid, plate-like impression without disturbing grounded stance.
 */
const SOFT_MOTION_BONE = /^(?:上半身[23]?|首|頭|[左右](?:肩P?|腕|腕捩|ひじ|手捩|手首|親指[０12]|人指[123]|中指[123]|薬指[123]|小指[123]))$/u;
const SOFT_MOTION_BONE_EN = /^(?:upperbody[23]?|neck|head|(?:left|right)(?:shoulderp?|arm|armtwist|elbow|wrist|thumb\d*|index\d*|middle\d*|ring\d*|pinky\d*))$/iu;

/** True for authored pose controllers, false for dynamic physics descendants. */
export function isSoftMotionBone(boneName: string): boolean {
  return SOFT_MOTION_BONE.test(boneName) || SOFT_MOTION_BONE_EN.test(boneName);
}

const AUDITED_CANDIDATE_MORPHS = new Set(['まばたき', '笑い', 'あ', 'い', 'う', 'え', 'お']);
const RELAXED_ARM_BONES = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'] as const;
const SPEECH_MODEL_SPACE_CONTROLLER = /^(?:センター\d*|グルーブ\d*|腰|[左右](?:足|つま先)(?:ＩＫ|IK)(?:親)?)$/u;
const SPEECH_FOOT_IK_CONTROLLER = /^[左右](?:足|つま先)(?:ＩＫ|IK)(?:親)?$/u;
const SPEECH_STATIC_LEG_HELPER = /^[左右](?:足D|ひざD|膝D|足首D|足先EX)$/u;
const SPEECH_LOWER_BODY_TRANSITION_BONE = /^(?:全ての親|センター\d*|グルーブ\d*|腰|下半身|[左右](?:足|ひざ|膝|足首|足IK親|足ＩＫ親|足(?:ＩＫ|IK)|つま先(?:ＩＫ|IK)|足D|ひざD|膝D|足首D|足先EX))$/u;
// These bones define the model-space anchor.  During speech recovery they
// must stay at the currently visible pose; rebasing them to PMX/base pose is
// what causes the whole avatar to turn or slide sideways at the last frame.
const SPEECH_RECOVERY_ANCHOR_BONE = /^(?:全ての親|センター\d*|グルーブ\d*|腰|[左右](?:足|つま先)(?:ＩＫ|IK)(?:親)?)$/u;
const SAFE_ONE_SHOT_LEG_BONE = /^[左右](?:足|ひざ|膝|足首)$/u;
const LOWER_BODY_ANCHOR_OR_HELPER = /^(?:全ての親|センター\d*|グルーブ\d*|腰|下半身|[左右](?:足|つま先)(?:ＩＫ|IK)(?:親)?|[左右](?:足D|ひざD|膝D|足首D|足先EX))$/u;
type SpeechRecoveryHoldTrack = VmdBoneTrack & { __speechRecoveryHold?: true };
const SPEECH_ARM_CHAINS = [
  ['左肩', '左腕', '左腕捩', '左ひじ', '左手捩', '左手首'],
  ['右肩', '右腕', '右腕捩', '右ひじ', '右手捩', '右手首']
] as const;
const SPEECH_ENTRY_ACTIVITY_BONES = [
  '左腕', '右腕', '左腕捩', '右腕捩', '左ひじ', '右ひじ',
  '左手捩', '右手捩', '左手首', '右手首'
] as const;
// The calibrated relaxed base pose is intentionally subtle for idle fallback.
// For a rear-held idle it is still a little too open at the elbow, so the
// temporary bridge clearance lowers only the upper arm by a small additional
// 0.25 rad. This replaces the former ±0.55 rad outward flap.
const SPEECH_ENTRY_CLEARANCE_Z_RAD = 0.32;
// Some VMD exporters leave an unsigned sentinel in camera/property metadata
// (for example 0xFFFFFFFF).  Treating that as maxFrame turns a 1.5-second
// gesture into a multi-year clip, disables the short-action bridge and prevents
// natural completion. Avatar playback is driven only by bone/morph tracks, so
// derive its duration from finite authored keys and reject implausible frames.
const MAX_PLAYABLE_AVATAR_FRAME = 30 * 60 * 30; // 30 minutes at 30 fps

/** A one-key helper track is a source-model calibration, not a new pose. */
export function isBridgeCalibrationBone(
  boneName: string,
  targetTrack: Pick<VmdBoneTrack, 'frames'> | undefined
): boolean {
  if (!targetTrack || targetTrack.frames.length !== 1) return false;
  return SPEECH_STATIC_LEG_HELPER.test(boneName)
    || SPEECH_FOOT_IK_CONTROLLER.test(boneName);
}

export function resolvePlayableAvatarMaxFrame(loaded: LoadedVmd): number {
  let maximum = 0;
  const tracks = [
    ...Object.values(loaded.boneTracks),
    ...Object.values(loaded.morphTracks)
  ];
  for (const track of tracks) {
    for (const value of track.frames ?? []) {
      const frame = Number(value);
      if (Number.isFinite(frame) && frame >= 0 && frame <= MAX_PLAYABLE_AVATAR_FRAME) {
        maximum = Math.max(maximum, frame);
      }
    }
  }
  if (maximum > 0) return maximum;
  const metadataFrame = Number(loaded.animation.metadata?.maxFrame ?? 0);
  return Number.isFinite(metadataFrame)
    && metadataFrame >= 0
    && metadataFrame <= MAX_PLAYABLE_AVATAR_FRAME
    ? metadataFrame
    : 0;
}

export function normalizePlayableAvatarDuration(loaded: LoadedVmd): LoadedVmd {
  const maxFrame = resolvePlayableAvatarMaxFrame(loaded);
  if (loaded.animation.metadata?.maxFrame === maxFrame) return loaded;
  return {
    ...loaded,
    animation: {
      ...loaded.animation,
      metadata: { ...loaded.animation.metadata, maxFrame }
    }
  };
}

function controllerTranslationLimit(name: string): readonly [number, number, number] {
  if (/^[左右](?:足|つま先)(?:ＩＫ|IK)(?:親)?$/u.test(name)) return [0.18, 0.22, 0.18];
  if (name === '腰') return [0.18, 0.25, 0.18];
  return [0.32, 0.35, 0.24];
}

function vmdPoseRotationDistance(a: VmdLocalPose, b: VmdLocalPose): number {
  const aNorm = Math.hypot(...a.rotation);
  const bNorm = Math.hypot(...b.rotation);
  if (aNorm < 1e-8 || bNorm < 1e-8) return 0;
  const dot = Math.abs(
    a.rotation[0] * b.rotation[0]
      + a.rotation[1] * b.rotation[1]
      + a.rotation[2] * b.rotation[2]
      + a.rotation[3] * b.rotation[3]
  ) / (aNorm * bNorm);
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
}

function interpolateVmdPose(
  source: VmdLocalPose,
  target: VmdLocalPose,
  alpha: number
): VmdLocalPose {
  const t = THREE.MathUtils.clamp(alpha, 0, 1);
  const sourceRotation = new THREE.Quaternion(...source.rotation).normalize();
  const targetRotation = new THREE.Quaternion(...target.rotation).normalize();
  if (sourceRotation.dot(targetRotation) < 0) {
    targetRotation.set(-targetRotation.x, -targetRotation.y, -targetRotation.z, -targetRotation.w);
  }
  sourceRotation.slerp(targetRotation, t);
  return {
    translation: [
      THREE.MathUtils.lerp(source.translation[0], target.translation[0], t),
      THREE.MathUtils.lerp(source.translation[1], target.translation[1], t),
      THREE.MathUtils.lerp(source.translation[2], target.translation[2], t)
    ],
    rotation: [sourceRotation.x, sourceRotation.y, sourceRotation.z, sourceRotation.w]
  };
}

/**
 * A large arm-pose change can move the wrists through the torso when an idle
 * stores both hands behind the back. Route that side through the calibrated
 * relaxed pose inside the existing speech bridge. Translation remains at the
 * visible source value; only the arm-chain rotations take the safe route.
 */
export function createSpeechEntryArmWaypointSequences(
  sourcePoses: ReadonlyMap<string, VmdLocalPose>,
  targetPoses: ReadonlyMap<string, VmdLocalPose>,
  resolveRelaxedPose: (boneName: string) => VmdLocalPose | undefined
): Map<string, readonly VmdLocalPose[]> {
  const result = new Map<string, readonly VmdLocalPose[]>();
  for (const chain of SPEECH_ARM_CHAINS) {
    const candidates = chain.flatMap(boneName => {
      const source = sourcePoses.get(boneName);
      const target = targetPoses.get(boneName);
      const relaxed = resolveRelaxedPose(boneName);
      return source && target && relaxed ? [{ boneName, source, target, relaxed }] : [];
    });
    if (!candidates.some(({ source, relaxed }) => vmdPoseRotationDistance(source, relaxed) >= 0.3)) {
      continue;
    }
    for (const { boneName, source, target, relaxed } of candidates) {
      const sourceHold: VmdLocalPose = {
        translation: [...source.translation],
        rotation: [...source.rotation]
      };
      const relaxedSide: VmdLocalPose = {
        translation: [...source.translation],
        rotation: [...relaxed.rotation]
      };
      const targetAtSourceTranslation: VmdLocalPose = {
        translation: [...source.translation],
        rotation: [...target.rotation]
      };

      // Bring only the shoulder/upper arm to the calibrated side pose first.
      // Twist, elbow and wrist keep their rear-held local pose during that
      // phase, so the complete forearm follows its parent around the torso.
      // Continue the proximal chain through a half-way pose instead of holding
      // it at the side twice and forcing the full shoulder lift into the final
      // third of the bridge. There is deliberately no extra outward rotation.
      const proximal = /^[左右](肩|腕)$/u.test(boneName);
      const sourceToRelaxedMid = interpolateVmdPose(sourceHold, relaxedSide, 0.5);
      result.set(boneName, proximal
        ? [relaxedSide, interpolateVmdPose(relaxedSide, targetAtSourceTranslation, 0.5)]
        // Distal joints must leave the rear-held pose gradually. A midpoint
        // prevents the forearm/wrist from cutting through the torso or cloth
        // when the authored target begins in front of the body.
        : [sourceHold, sourceToRelaxedMid, relaxedSide]);
    }
  }
  return result;
}

/**
 * Reverse of the rear-idle speech-entry route.  A speech pose normally leaves
 * the hands in front of the torso; returning directly to a hands-behind idle
 * makes the wrists cross the body.  First relax the whole chain at the sides,
 * then move the proximal arm behind the torso, and only then fold the distal
 * chain into the authored rear-held idle pose.
 */
export function createSpeechToIdleArmWaypointSequences(
  sourcePoses: ReadonlyMap<string, VmdLocalPose>,
  targetPoses: ReadonlyMap<string, VmdLocalPose>,
  resolveRelaxedPose: (boneName: string) => VmdLocalPose | undefined
): Map<string, readonly VmdLocalPose[]> {
  const result = new Map<string, readonly VmdLocalPose[]>();
  for (const chain of SPEECH_ARM_CHAINS) {
    const candidates = chain.flatMap(boneName => {
      const source = sourcePoses.get(boneName);
      const target = targetPoses.get(boneName);
      const relaxed = resolveRelaxedPose(boneName);
      return source && target && relaxed ? [{ boneName, source, target, relaxed }] : [];
    });
    if (!candidates.some(({ source, target, relaxed }) =>
      vmdPoseRotationDistance(source, target) >= 0.3
        && vmdPoseRotationDistance(target, relaxed) >= 0.3)) {
      continue;
    }
    for (const { boneName, source, target, relaxed } of candidates) {
      const relaxedSide: VmdLocalPose = {
        translation: [...source.translation],
        rotation: [...relaxed.rotation]
      };
      const targetRotationAtSourceTranslation: VmdLocalPose = {
        translation: [...source.translation],
        rotation: [...target.rotation]
      };
      const proximal = /^[左右](肩|腕)$/u.test(boneName);
      result.set(boneName, proximal
        ? [
            relaxedSide,
            interpolateVmdPose(relaxedSide, targetRotationAtSourceTranslation, 0.5),
            targetRotationAtSourceTranslation
          ]
        : [relaxedSide, relaxedSide, relaxedSide]);
    }
  }
  return result;
}

/** Backward-compatible single-waypoint view for callers that only need a side pose. */
export function createSpeechEntryArmWaypoints(
  sourcePoses: ReadonlyMap<string, VmdLocalPose>,
  resolveRelaxedPose: (boneName: string) => VmdLocalPose | undefined
): Map<string, VmdLocalPose> {
  const sequences = createSpeechEntryArmWaypointSequences(sourcePoses, sourcePoses, resolveRelaxedPose);
  return new Map([...sequences.entries()].map(([name, sequence]) => [name, sequence[0]]));
}

/**
 * VMD exporters often put a PMX rest/A-pose at frame zero and only begin the
 * authored gesture a few frames later. Starting a speech bridge at that frame
 * makes the avatar visibly raise both arms and hold the wrong pose. Detect the
 * neutral lead-in from the arm-chain rotations and enter at its first coherent
 * authored keyframe. Already-active poses (including looping poses with only a
 * frame-zero key) deliberately keep frame zero so no part of the action is
 * discarded.
 */
export function selectSpeechEntryStartFrame(
  boneTracks: Readonly<Record<string, VmdBoneTrack>>,
  maxFrame: number,
  frameRate = 30
): number {
  const tracks = SPEECH_ENTRY_ACTIVITY_BONES
    .map(name => boneTracks[name])
    .filter((track): track is VmdBoneTrack => Boolean(track && track.frames.length > 0));
  if (tracks.length < 2) return 0;

  const identity: VmdLocalPose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const activityAt = (frame: number): { activeCount: number; totalAngle: number } => {
    let activeCount = 0;
    let totalAngle = 0;
    for (const track of tracks) {
      const pose = sampleVmdBoneTrack(track, frame);
      if (!pose) continue;
      const angle = vmdPoseRotationDistance(identity, pose);
      totalAngle += angle;
      if (angle >= 0.35) activeCount += 1;
    }
    return { activeCount, totalAngle };
  };

  // An active frame-zero pose is already safe to enter. The thresholds are
  // intentionally conservative: a neutral lead-in has only the upper-arm
  // rotations, while an authored pose engages elbows/twists as well.
  const firstActivity = activityAt(0);
  if (firstActivity.activeCount >= 4 && firstActivity.totalAngle >= 3) return 0;

  const leadInLimit = Math.min(
    Math.max(1, Math.floor(Math.max(0, maxFrame) * 0.2)),
    Math.max(1, Math.round(Math.max(1, frameRate) * 0.75))
  );
  const candidateFrames = [...new Set(
    tracks.flatMap(track => [...track.frames]
      .filter(frame => frame > 0 && frame <= leadInLimit))
  )].sort((a, b) => a - b);
  for (const frame of candidateFrames) {
    const activity = activityAt(frame);
    if (activity.activeCount >= 4 && activity.totalAngle >= 3) return frame;
  }
  return 0;
}

/**
 * Replace only the malformed neutral arm-chain sample at the beginning of a
 * speech VMD. The rest of the body keeps frame zero, so head/torso/leg motion
 * still starts at authored speed and Bullet never receives a whole-body clock
 * jump. Each repaired track eases from the first coherent arm pose into its
 * existing later keys.
 */
export function repairSpeechEntryNeutralArmLeadIn(
  loaded: LoadedVmd,
  entryFrame: number
): LoadedVmd {
  if (!Number.isFinite(entryFrame) || entryFrame <= 0) return loaded;
  let changed = false;
  const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
  for (const boneName of SPEECH_ENTRY_ACTIVITY_BONES) {
    const track = loaded.boneTracks[boneName];
    if (!track || track.frames.length === 0 || track.frames[0] !== 0) continue;
    const pose = sampleVmdBoneTrack(track, entryFrame);
    if (!pose) continue;
    const translations = new Float32Array(track.translations);
    const rotations = new Float32Array(track.rotations);
    translations.set(pose.translation, 0);
    rotations.set(pose.rotation, 0);
    boneTracks[boneName] = { ...track, translations, rotations };
    changed = true;
  }
  if (!changed) return loaded;
  return {
    ...loaded,
    animation: {
      ...loaded.animation,
      bytes: new Uint8Array(),
      boneTracks
    },
    boneTracks
  };
}

/**
 * Rebase source-model controller translations onto the currently rendered
 * pose. Downloaded VMD center/foot-IK tracks are absolute offsets calibrated
 * to the source PMX; the first frame can otherwise move a collider parent by
 * more than one model unit. Single-key semi-standard leg helpers are likewise
 * source-PMX calibration, so omit them instead of letting them take ownership
 * of the target model's helper chain. Multi-key helper animation, rotations,
 * frames and all relative controller translation changes remain authored.
 */
export function rebaseTrustedVoiceControllerTranslations(
  loaded: LoadedVmd,
  currentPose: (boneName: string) => VmdLocalPose
): LoadedVmd {
  let changed = false;
  const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
  for (const [name, track] of Object.entries(loaded.boneTracks)) {
    if (SPEECH_STATIC_LEG_HELPER.test(name) && track.frames.length === 1) {
      delete boneTracks[name];
      changed = true;
      continue;
    }
    const anchorRotation = currentPose(name).rotation;
    const isLowerBodyTrack = SPEECH_LOWER_BODY_TRANSITION_BONE.test(name);
    const isController = SPEECH_MODEL_SPACE_CONTROLLER.test(name);
    // 单 key 下半身轨道（authored 静态腿姿）也要进入处理：它们的 rotation
    // 需要锚定到当前可见姿态，否则过渡桥终点（保持可见腿姿）与绑定后第一
    // 帧采样（authored 静态腿姿）不一致，语音 cue 间腿部来回跳变并掀起裙摆。
    const isSingleKeyLowerBody = isLowerBodyTrack && track.frames.length === 1;
    if ((!isController || !track.translations || track.translations.length < 3)
      && !(isLowerBodyTrack && track.frames.length > 1)
      && !isSingleKeyLowerBody) continue;
    const anchor = currentPose(name).translation;
    const first = track.translations.slice(0, 3);
    const limit = controllerTranslationLimit(name);
    const translations = track.translations && track.translations.length >= 3
      ? new Float32Array(track.translations.length)
      : track.translations;
    if (isLowerBodyTrack && translations && track.translations && track.translations.length >= 3) {
      // Lower-body translations are source-model/controller offsets. Keep a
      // fixed local anchor across the trusted voice clip so authored leg-lift
      // rotations remain while feet cannot skate during a phrase handoff.
      for (let index = 0; index < translations.length; index += 3) {
        translations.set(anchor, index);
      }
    } else if (translations && track.translations && track.translations.length >= 3) {
      for (let index = 0; index < track.translations.length; index += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          const delta = track.translations[index + axis] - first[axis];
          translations[index + axis] = anchor[axis] + Math.max(-limit[axis], Math.min(limit[axis], delta));
        }
      }
    }
    let rotations = track.rotations;
    // Multi-key lower-body tracks can be authored against a different PMX
    // rest pose. Keep their relative leg motion, but anchor frame zero to the
    // pose currently visible on this model. Otherwise the first IK solve can
    // snap both legs before the transition bridge gets a chance to settle.
    if (isLowerBodyTrack && track.frames.length > 1) {
      const anchorQuaternion = new THREE.Quaternion(...anchorRotation).normalize();
      const firstQuaternion = new THREE.Quaternion(
        track.rotations[0] ?? 0,
        track.rotations[1] ?? 0,
        track.rotations[2] ?? 0,
        track.rotations[3] ?? 1
      ).normalize();
      const relativeFromFirst = firstQuaternion.clone().invert();
      const rebased = new Float32Array(track.rotations.length);
      for (let index = 0; index < track.frames.length; index += 1) {
        const offset = index * 4;
        const authored = new THREE.Quaternion(
          track.rotations[offset] ?? 0,
          track.rotations[offset + 1] ?? 0,
          track.rotations[offset + 2] ?? 0,
          track.rotations[offset + 3] ?? 1
        ).normalize();
        const rotation = anchorQuaternion.clone()
          .multiply(relativeFromFirst)
          .multiply(authored)
          .normalize();
        rebased.set([rotation.x, rotation.y, rotation.z, rotation.w], offset);
      }
      rotations = rebased;
    }
    changed = true;
    boneTracks[name] = {
      ...track,
      translations,
      // A single foot-IK key is normally source-PMX calibration, not authored
      // movement. Several short voice clips carry a ~43 degree static IK
      // rotation beside a mild right-leg pose; blending that calibration into
      // the current PMX makes both knees solve into a transient crouch. The
      // same applies to every single-key lower-body track: an authored static
      // leg pose differs between gestures and would jump one frame after the
      // bridge lands (the bridge endpoint deliberately holds the visible leg
      // pose), kicking the skirt between speech cues. Keep real multi-key
      // lower-body animation, but anchor static keys to the rendered pose.
      rotations: isLowerBodyTrack && track.frames.length === 1
        ? new Float32Array(anchorRotation)
        : rotations
    };
  }
  if (!changed) return loaded;
  const animation = {
    ...loaded.animation,
    bytes: new Uint8Array(),
    boneTracks
  };
  return { ...loaded, animation, boneTracks };
}

/**
 * Ground one-shot/action-pool VMDs before they can claim the model.  This is a
 * fail-closed safety filter, not a general VMD rewrite:
 * - root/center/waist/IK/helper tracks are never allowed to move the avatar;
 * - one-key lower-body tracks are treated as source-PMX calibration;
 * - authored real thigh/knee/ankle rotations are kept so the lower body can
 *   move with the clip; their translations are pinned to zero so feet cannot
 *   skate or drag the IK solver during a short handoff.
 */
export function filterUnsafeOneShotLowerBodyTracks(loaded: LoadedVmd): LoadedVmd {
  let changed = false;
  const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
  for (const [boneName, track] of Object.entries(loaded.boneTracks)) {
    if (!LOWER_BODY_ANCHOR_OR_HELPER.test(boneName) && !SAFE_ONE_SHOT_LEG_BONE.test(boneName)) continue;
    if (LOWER_BODY_ANCHOR_OR_HELPER.test(boneName)) {
      delete boneTracks[boneName];
      changed = true;
      continue;
    }
    if (track.frames.length < 2 || track.rotations.length < 4) {
      delete boneTracks[boneName];
      changed = true;
      continue;
    }
    // Authored real leg bones keep their rotation so one-shot gestures can
    // drive the lower body. Only the translation is pinned to zero so the leg
    // cannot skate or drag the IK solver during a short clip.
    if (track.translations.some(value => Math.abs(value) > 1e-6)) {
      boneTracks[boneName] = { ...track, translations: new Float32Array(track.translations.length) };
      changed = true;
    }
  }
  if (!changed) return loaded;
  const animation = {
    ...loaded.animation,
    bytes: new Uint8Array(),
    boneTracks
  };
  return { ...loaded, animation, boneTracks };
}

/**
 * 一次性下半身过滤只针对语音同步动作（dialogue-body-only）：
 * 语音期间腰/中心/足 IK 保持落地，避免短语衔接时全身滑动。
 * trusted-voice-full-body 已通过 rebase 锚定位移，保留其 authored 轨道。
 * local-clock 播放（待机、待机轮换动作、手动/长 VMD 舞蹈）完全不过滤，
 * 腰部与下半身按 VMD 原样驱动。
 */
export function shouldApplyOneShotLowerBodyGate(
  looping: boolean,
  timeSource: MotionTimeSource,
  policy: CandidateTrackPolicy | undefined
): boolean {
  return !looping
    && timeSource === 'performance-clock'
    && policy !== 'trusted-voice-full-body';
}

/** Add a stable relaxed track when an authored clip leaves an arm in PMX rest pose. */
export function injectRelaxedArmFallbackTracks(
  loaded: LoadedVmd,
  modelBoneNames: ReadonlySet<string>,
  resolvePose: (boneName: string) => VmdLocalPose | undefined
): LoadedVmd {
  const boneTracks = { ...loaded.boneTracks };
  const endFrame = Math.max(1, Math.round(loaded.animation.metadata.maxFrame ?? 0));
  let addedFrameCount = 0;
  for (const boneName of RELAXED_ARM_BONES) {
    if (!modelBoneNames.has(boneName) || boneTracks[boneName]) continue;
    const pose = resolvePose(boneName);
    if (!pose) continue;
    const track: VmdBoneTrack = {
      packed: 'bone',
      frames: new Uint32Array([0, endFrame]),
      translations: new Float32Array([...pose.translation, ...pose.translation]),
      rotations: new Float32Array([...pose.rotation, ...pose.rotation]),
      interpolations: new Float32Array(32),
      physicsToggles: new Int8Array([-1, -1])
    };
    boneTracks[boneName] = track;
    addedFrameCount += track.frames.length;
  }
  if (addedFrameCount === 0) return loaded;
  return {
    ...loaded,
    animation: {
      ...loaded.animation,
      bytes: new Uint8Array(),
      metadata: {
        ...loaded.animation.metadata,
        counts: {
          ...loaded.animation.metadata.counts,
          bones: loaded.animation.metadata.counts.bones + addedFrameCount
        }
      },
      boneTracks
    },
    boneTracks
  };
}

/**
 * Keep the currently visible grounded chain owned during a speech-to-idle
 * recovery when the selected body is intentionally filtered to upper-body
 * tracks. Without these static tracks the bridge releases the legs at its
 * endpoint and the relaxed-base layer takes over on the next frame, which
 * produces the characteristic post-speech leg snap. The tracks are only used
 * for the recovery bind and hold the visible pose; they do not author motion.
 */
export function injectSpeechLowerBodyHoldTracks(
  loaded: LoadedVmd,
  modelBoneNames: ReadonlySet<string>,
  resolvePose: (boneName: string) => VmdLocalPose | undefined
): LoadedVmd {
  const boneTracks = { ...loaded.boneTracks };
  const endFrame = Math.max(1, Math.round(loaded.animation.metadata.maxFrame ?? 0));
  let addedFrameCount = 0;
  for (const boneName of modelBoneNames) {
    if (!SPEECH_LOWER_BODY_TRANSITION_BONE.test(boneName) || boneTracks[boneName]) continue;
    const pose = resolvePose(boneName);
    if (!pose) continue;
    boneTracks[boneName] = {
      packed: 'bone',
      frames: new Uint32Array([0, endFrame]),
      translations: new Float32Array([...pose.translation, ...pose.translation]),
      rotations: new Float32Array([...pose.rotation, ...pose.rotation]),
      interpolations: new Float32Array(32),
      physicsToggles: new Int8Array([-1, -1]),
      __speechRecoveryHold: true
    } as SpeechRecoveryHoldTrack;
    addedFrameCount += 2;
  }
  if (addedFrameCount === 0) return loaded;
  return {
    ...loaded,
    animation: {
      ...loaded.animation,
      bytes: new Uint8Array(),
      metadata: {
        ...loaded.animation.metadata,
        counts: {
          ...loaded.animation.metadata.counts,
          bones: loaded.animation.metadata.counts.bones + addedFrameCount
        }
      },
      boneTracks
    },
    boneTracks
  };
}

export function isSpeechRecoveryHoldTrack(
  track: VmdBoneTrack | undefined
): boolean {
  return (track as SpeechRecoveryHoldTrack | undefined)?.__speechRecoveryHold === true;
}

function stripSpeechRecoveryHoldTracks(loaded: LoadedVmd): LoadedVmd {
  const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
  let removedFrameCount = 0;
  let changed = false;
  for (const [boneName, track] of Object.entries(loaded.boneTracks)) {
    if (!isSpeechRecoveryHoldTrack(track)) continue;
    delete boneTracks[boneName];
    removedFrameCount += track.frames.length;
    changed = true;
  }
  if (!changed) return loaded;
  const metadata = {
    ...loaded.animation.metadata,
    counts: {
      ...loaded.animation.metadata.counts,
      bones: Math.max(0, Number(loaded.animation.metadata.counts?.bones ?? 0) - removedFrameCount)
    }
  };
  const animation = { ...loaded.animation, bytes: new Uint8Array(), metadata, boneTracks };
  return { ...loaded, animation, boneTracks };
}

/**
 * A recovery target may contain source-model root/center/foot-IK calibration
 * keys.  Replaying those keys on another visible pose turns or slides the
 * entire avatar before the default idle settles.  Keep only the authored leg
 * joint rotations; recovery anchors stay at the captured visible transform.
 */
function stabilizeRecoveryAnchorTracks(
  loaded: LoadedVmd,
  currentPose: (boneName: string) => VmdLocalPose
): LoadedVmd {
  let changed = false;
  const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
  for (const [boneName, track] of Object.entries(loaded.boneTracks)) {
    if (!SPEECH_RECOVERY_ANCHOR_BONE.test(boneName)
      || track.frames.length === 0) continue;
    const pose = currentPose(boneName);
    const translations = new Float32Array(track.frames.length * 3);
    const rotations = new Float32Array(track.frames.length * 4);
    for (let index = 0; index < track.frames.length; index += 1) {
      translations.set(pose.translation, index * 3);
      rotations.set(pose.rotation, index * 4);
    }
    boneTracks[boneName] = { ...track, translations, rotations };
    changed = true;
  }
  if (!changed) return loaded;
  const animation = { ...loaded.animation, bytes: new Uint8Array(), boneTracks };
  return { ...loaded, animation, boneTracks };
}

export function isGroundedDialogueBoneAllowed(boneName: string): boolean {
  // Dialogue keeps anchors (root/center/waist/IK/helpers) grounded via the
  // model runtime, but real authored leg joints are admitted so the voice
  // action can drive the lower body naturally. Their translations are pinned
  // downstream to keep feet from skating during phrase handoffs.
  return STANDARD_UPPER_BODY_BONE.test(boneName) || SAFE_ONE_SHOT_LEG_BONE.test(boneName);
}

export function requiresParsedTrackExecution(policy: CandidateTrackPolicy | undefined): boolean {
  return policy === 'standard-upper-body'
    || policy === 'dialogue-body-only'
    || policy === 'grounded-full-body'
    || policy === 'trusted-voice-full-body';
}

/**
 * 语音时钟是不可绕过的落地硬门：任何与音频同步的 VMD 都只能控制上半身。
 * 调用方遗漏或请求较宽松策略时也不能重新启用根、中心、腿或足 IK。
 */
export function resolveEffectiveCandidateTrackPolicy(
  timeSource: MotionTimeSource,
  requested: CandidateTrackPolicy | undefined
): CandidateTrackPolicy | undefined {
  if (timeSource !== 'performance-clock') return requested;
  // Only the renderer can request this internal policy after the voice-pool
  // admission and exact-path checks. All other speech remains grounded.
  return requested === 'trusted-voice-full-body'
    ? requested
    : 'dialogue-body-only';
}

/** Keep the selected idle body as the target of a local speech recovery. */
export function shouldPreserveSpeechRecoveryTargetBody(
  timeSource: MotionTimeSource,
  transitionProfile: TransitionBridgeProfile | undefined,
  _candidateTrackPolicy: CandidateTrackPolicy | undefined
): boolean {
  return timeSource === 'local-clock'
    && transitionProfile === 'speech-to-idle-recovery';
}

/**
 * The hand-off must cover both clips, not only the incoming VMD.  Otherwise an
 * arm held by the outgoing clip but absent from the next clip is reset by the
 * runtime before its return-to-base pose can be eased out.
 */
export function collectTransitionBoneNames(
  outgoing: readonly string[],
  incoming: readonly string[],
  priorRendered: ReadonlyMap<string, unknown>
): string[] {
  // D/EX bones are PMX/physics helper descendants rather than authored pose
  // controllers. Letting the bridge claim them makes IK and Bullet solve the
  // same helper chain twice, which can flatten a bend or shift the leg at the
  // hand-off. Keep the authored leg/knee/ankle/IK controls on the bridge, but
  // leave these helpers to the model runtime for continuity.
  return [...new Set([...outgoing, ...incoming, ...priorRendered.keys()])]
    .filter(name => !SPEECH_STATIC_LEG_HELPER.test(name));
}

/**
 * Standard leg bones are IK outputs in the rendered skeleton. Feeding that
 * solved pose back into a native VMD bridge makes MMD solve the same chain a
 * second time on the bridge's first frame. Use the outgoing authored input for
 * those bones; controllers and all other bones keep the visible pose.
 */
export function resolveTransitionSourcePose(
  boneName: string,
  visiblePose: VmdLocalPose,
  outgoingTrack: VmdBoneTrack | undefined,
  outgoingFrame: number,
  preferVisiblePose = false
): VmdLocalPose {
  if (!/^[左右](?:足|ひざ|膝|足首)$/u.test(boneName)) return visiblePose;
  if (preferVisiblePose) return visiblePose;
  return sampleVmdBoneTrack(outgoingTrack, outgoingFrame) ?? visiblePose;
}

/**
 * Speech recovery uses the authored voice clip's first leg pose as a reverse
 * endpoint.  This lets the bridge unwind the leg lift along the same VMD path
 * before the selected idle takes ownership, instead of snapping toward a
 * possibly different PMX base pose.
 */
export function resolveSpeechRecoveryLegTargetPose(
  boneName: string,
  fallbackPose: VmdLocalPose,
  outgoingTrack: VmdBoneTrack | undefined
): VmdLocalPose | undefined {
  if (!/^[左右](?:足|ひざ|膝|足首)$/u.test(boneName)) return undefined;
  if (!outgoingTrack || outgoingTrack.frames.length < 2) return undefined;
  const first = sampleVmdBoneTrack(outgoingTrack, outgoingTrack.frames[0]);
  const last = sampleVmdBoneTrack(outgoingTrack, outgoingTrack.frames[outgoingTrack.frames.length - 1]);
  if (!first || !last) return fallbackPose;
  // Many voice-pool clips carry a static source-PMX leg calibration track.
  // Its first key is not a meaningful reverse pose; using it bends the knees
  // on exit even though the clip never moved the legs. Only a real authored
  // leg rotation is eligible for reverse recovery.
  if (vmdPoseRotationDistance(first, last) < THREE.MathUtils.degToRad(5)) return fallbackPose;
  return first;
}

/** The renderer keeps a monotonic clock; this only observes where the VMD loop crossed. */
export function getLoopCycle(elapsedSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, Math.floor(elapsedSeconds / durationSeconds));
}

/**
 * 时间源提供者：返回当前时间（秒）。
 * MotionPlayer 在每一帧调用此函数获取当前时间。
 */
export type MotionTimeProvider = () => number;

/**
 * AudioContext 状态提供者（用于 speaking motion 启动校验）。
 * 返回 'running' | 'suspended' | 'closed' | 'unknown'。
 */
export type AudioContextStateProvider = () => 'running' | 'suspended' | 'closed' | 'unknown';

/**
 * 单调本地时钟（performance.now() / 1000）。
 * 在 Node.js 和浏览器中都可用。
 */
function localClockNow(): number {
  return performance.now() / 1000;
}

// ============================================================
// Fade 状态机
// ============================================================

export type MotionPlayerState = 'idle' | 'bridging' | 'fading-in' | 'playing' | 'fading-out';

/**
 * Fade 配置。
 */
export interface FadeConfig {
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

const DEFAULT_FADE_CONFIG: FadeConfig = {
  fadeInSeconds: 0.7,
  fadeOutSeconds: 0.55
};

/**
 * 单个骨骼的 rest pose 快照（用于 fade 插值）。
 * 只记录 quaternion，不记录 position（VMD 通常不改 position，除了 センター/腰/全ての親）。
 * 对于 position，单独记录。
 */
interface BoneRestPoseSnapshot {
  boneName: string;
  quaternion: { x: number; y: number; z: number; w: number };
  position: { x: number; y: number; z: number };
}

// ============================================================
// Cooldown 调度
// ============================================================

interface CooldownRecord {
  packId: string;
  lastPlayedAt: number; // 启动时间（秒，基于 timeProvider）
}

/**
 * A VMD can remain bound while its asynchronous replacement is being decoded.
 * Keep its clock separately because the public player state is deliberately
 * reset to idle before `startPlay()` finishes claiming the replacement.
 */
interface RetainedAnimationClock {
  durationSeconds: number;
  startedAt: number;
  looping: boolean;
  playbackRate: number;
}

interface PendingTransitionSource {
  readonly loaded: LoadedVmd;
  readonly frame: number;
}

interface NativeBridgeTarget {
  readonly animation: MmdAnimation;
  readonly loaded: LoadedVmd;
  readonly boneNames: readonly string[];
  readonly durationSeconds: number;
  readonly looping: boolean;
  readonly timeSource: MotionTimeSource;
  readonly compositionMode: MotionCompositionMode;
  readonly startOffsetSeconds: number;
  readonly playbackRate: number;
  readonly groundedRecovery: boolean;
}

// ============================================================
// MotionPlayer
// ============================================================

/**
 * VMD 动作播放器。
 * 封装 VMD 加载 → setAnimation → 每帧 update → stop/clear 的完整生命周期。
 *
 * 修正版（2026-07-19）：
 * - 时间源注入：play() 时指定 timeSource（local-clock 或 performance-clock）
 * - Speaking motion 启动校验：AudioContext 必须 running + PerformanceClock 必须 aligned
 * - 真实 fade：进入/退出 lerp rest pose 与 VMD-sampled pose，至少 0.5 秒
 * - 动作切换不先 reset 到 Base Pose：旧动作 fade-out → 新动作 fade-in
 * - Cooldown：同一 packId 在 cooldownSeconds 内不重复启动（除非 force=true）
 */
export class MotionPlayer {
  private state: MotionPlayerState = 'idle';
  private currentAnimation: MmdAnimation | null = null;
  private currentLoadedVmd: LoadedVmd | null = null;
  private currentPackId: string | null = null;
  private boneLeases: OwnershipLease[] = [];
  private morphLeases: OwnershipLease[] = [];
  private animationDurationSec: number = 0;
  private animationStartedAt: number = 0;
  private looping: boolean = true;
  private currentTimeSource: MotionTimeSource = 'local-clock';
  private fadeConfig: FadeConfig = { ...DEFAULT_FADE_CONFIG };
  private fadeStartedAt: number = 0;
  private restPoseSnapshots: BoneRestPoseSnapshot[] = [];
  private fadeOutSnapshot: BoneRestPoseSnapshot[] = [];
  private currentCooldownSeconds: number = 0;
  private readonly cooldownRecords = new Map<string, CooldownRecord>();
  private pendingStopAfterFadeOut: boolean = false;
  private pendingSwitchPackId: string | null = null;
  private pendingSwitchBytes: Uint8Array | ArrayBuffer | null = null;
  private pendingSwitchToken: number | null = null;
  /**
   * Cross-fade 过渡期间保留的旧骨骼租约。
   * performStopCleanupInternal(true) 时不释放，而是暂存于此，
   * startPlay 在 claim 新骨骼前释放，避免跨帧间隙骨骼闪回 PMX T-pose。
   */
  private crossFadeLeases: OwnershipLease[] = [];
  /**
   * Old animation timing retained during an asynchronous cross-fade hand-off.
   * Without this, the renderer sees state=idle for one or more frames and
   * calls model.update(wallClock), sampling the still-bound old VMD at an
   * unrelated time. That produces the visible one-frame arm/body twitch.
   */
  private retainedAnimationClock: RetainedAnimationClock | null = null;
  private pendingTransitionSource: PendingTransitionSource | null = null;
  private nativeBridgeTarget: NativeBridgeTarget | null = null;
  private groundedRecoverySnapshots: BoneRestPoseSnapshot[] = [];
  private groundedRecoveryStartedAt = 0;
  private groundedRecoveryDuration = 0.9;
  private readonly requestGate = new MotionRequestGate();
  /**
   * 停止回调（MotionSequence 链式播放使用）。
   * performStopCleanup() 完成后调用，用于触发下一段。
   */
  private onStopCallback: (() => void) | null = null;
  private onNaturalEndCallback: (() => void) | null = null;
  private naturalEndNotified = false;
  private naturalEndHandoffPending = false;
  private pendingSwitchOptions: {
    boneMapping?: BoneMapping;
    amplitudeLimits?: AmplitudeLimits;
    looping?: boolean;
    timeSource?: MotionTimeSource;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    cooldownSeconds?: number;
    compositionMode?: MotionCompositionMode;
    candidateTrackPolicy?: CandidateTrackPolicy;
    speechStance?: SpeechStanceProfile;
    speechStanceAccent?: SpeechStanceAccent;
    speechStanceSourceRetention?: number;
    transitionProfile?: TransitionBridgeProfile;
    playbackRate?: number;
    candidateExpressionPolicy?: 'separate';
  } | null = null;
  /**
   * Phase 5.2B.3 Closeout Task 3：当前播放的 pack 的组合模式。
   * - 'absolute'：VMD 采样直接生效（外部 VMD 默认）
   * - 'additive-from-base'：VMD 采样作为 delta 叠加到 base pose（内部程序化 VMD）
   *
   * 在 startPlay() 中从 options.compositionMode 设置。
   * 在 applyPoseComposition() 中使用。
   */
  private currentCompositionMode: MotionCompositionMode = 'absolute';
  /**
   * Phase 5.2B.3 Closeout Task 3：base pose provider（来自 RelaxedBasePoseController）。
   * 返回某个骨骼的 (quaternion, position) 副本，或 undefined（未管理该骨骼）。
   * 在 applyPoseComposition() 中用于 additive 模式的 base。
   */
  private getBasePose: ((boneName: string) => BonePose | undefined) | null = null;
  /**
   * Phase 5.2B.3 Closeout Task 3：PMX rest pose 快照（constructor 时保存）。
   * 用于 additive 模式的 rest 参考。
   */
  private readonly pmxRestPoseSnapshots = new Map<string, BoneRestPoseSnapshot>();
  /**
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正：当前 VMD 实际采样的骨骼名集合。
   *
   * `applyPoseComposition` 只处理这个集合中的骨骼，避免对非 VMD 骨骼
   * （例如 idle-stand-breathe-v1 不包含 左腕/右腕/左ひじ/右ひじ）做错误的
   * additive 组合，导致每帧漂移。
   *
   * 在 `startPlay()` 中从 `extractBoneNames(loaded)` 填充，
   * 在 `performStopCleanup()` 中清空。
   */
  private currentVmdBoneNames: Set<string> = new Set();
  /**
   * 物理引擎启用时，从中剥离动态骨骼轨道（绑定到 dynamicWithBone 刚体的骨骼）。
   * 避免 VMD 和 Bullet 物理同时抢头发骨骼导致抖动。
   */
  private dynamicBoneFilter: Set<string> = new Set();
  /**
   * 骨骼查找缓存（按名称），避免每帧线性搜索。
   * key: 日文骨骼名（如 '左腕'），value: Three.js Bone 或 undefined（未找到）。
   * 在 constructor 中预热，后续 findBoneByName 优先查缓存。
   */
  private readonly boneCache = new Map<string, { name: string; userData: Record<string, unknown>; quaternion: { x: number; y: number; z: number; w: number }; position: { x: number; y: number; z: number } } | undefined>();
  /** Local-space offsets that bridge a captured visible pose to a new VMD sample. */
  private readonly inertializers = new Map<string, PoseInertializer>();
  private inertialSourceSnapshots = new Map<string, BoneRestPoseSnapshot>();
  private readonly previousRenderedSnapshots = new Map<string, BoneRestPoseSnapshot>();
  /** Last softened pose per authored controller; never populated for physics bones. */
  private readonly softenedPoseSnapshots = new Map<string, BoneRestPoseSnapshot>();
  private softenedPackId: string | null = null;
  private softenedLastSampleAt = 0;
  private inertialOverlayStarted = false;
  private inertialLastSampleAt = 0;
  private lastObservedLoopCycle = 0;
  /** User-selected multiplier: lower is slower and gives the exit/entry bridge more time. */
  private transitionSpeed = 0.7;
  private playbackRate = 1;
  private poseLocked = false;
  private lockedAnimationTime = 0;
  private poseLockStartedAt = 0;

  constructor(
    private readonly model: ThreeMmdModel,
    private readonly boneRegistry: BoneOwnershipRegistry,
    private readonly morphRegistry: MorphOwnershipRegistry,
    private readonly options: {
      performanceClock?: PerformanceClock;
      getAudioContextState?: AudioContextStateProvider;
      /**
       * Phase 5.2B.3 Closeout Task 3：base pose provider。
       * 由 RelaxedBasePoseController.getBasePoseSnapshot() 实现。
       * 用于 additive-from-base 模式的 base pose 参考。
       */
      getBasePose?: (boneName: string) => BonePose | undefined;
    } = {}
  ) {
    this.getBasePose = options.getBasePose ?? null;
    // 预热骨骼查找缓存（避免每帧线性搜索）
    this.warmBoneCache();
    // 快照 PMX rest pose（所有骨骼）
    this.snapshotPmxRestPose();
  }

  setTransitionSpeed(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return;
    this.transitionSpeed = Math.min(1.8, Math.max(0.5, multiplier));
  }

  getTransitionSpeed(): number {
    return this.transitionSpeed;
  }

  private transitionDuration(baseSeconds: number): number {
    return Math.min(2.4, Math.max(0.15, baseSeconds / this.transitionSpeed));
  }

  /**
   * 预热骨骼查找缓存：将 skeleton 中所有骨骼按日文名/英文名/name 三种 key 索引。
   * 后续 findBoneByName 直接查缓存，O(1) 替代 O(n)。
   */
  private warmBoneCache(): void {
    const bones = this.model.mesh.skeleton?.bones ?? [];
    for (const bone of bones) {
      const mmdName = (bone.userData as { mmdBoneName?: string }).mmdBoneName;
      const mmdEngName = (bone.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName;
      // 按日文名索引
      if (mmdName) this.boneCache.set(mmdName, bone as any);
      // 按英文名索引
      if (mmdEngName && mmdEngName !== mmdName) this.boneCache.set(mmdEngName, bone as any);
      // 按 bone.name 索引
      if (bone.name && bone.name !== mmdName && bone.name !== mmdEngName) {
        this.boneCache.set(bone.name, bone as any);
      }
    }
  }

  /**
   * Phase 5.2B.3 Closeout Task 3：快照 PMX rest pose（所有骨骼）。
   * 在 constructor 时调用一次，用于 additive 模式的 rest 参考。
   *
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正（bone lookup bug）：
   * 使用 resolveBoneKey 获取骨骼的规范名（日文 mmdBoneName 优先），
   * 确保 pmxRestPoseSnapshots 的 key 与 VMD 中的日文骨骼名一致。
   */
  private snapshotPmxRestPose(): void {
    const bones = this.model.mesh.skeleton?.bones ?? [];
    for (const bone of bones) {
      const boneKey = this.resolveBoneKey(bone);
      this.pmxRestPoseSnapshots.set(boneKey, {
        boneName: boneKey,
        quaternion: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w },
        position: { x: bone.position.x, y: bone.position.y, z: bone.position.z }
      });
    }
  }

  /**
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正：解析骨骼的规范名（key）。
   *
   * @yohawing/three-mmd-loader 加载 PMX 时，bone.name 可能是英文名（如 'LeftArm'），
   * 而 bone.userData.mmdBoneName 保存日文 PMX 名（如 '左腕'）。
   * VMD 文件使用日文骨骼名，因此所有 bone map 必须以日文名为 key。
   *
   * 查找顺序：mmdBoneName → mmdEnglishBoneName → bone.name
   * （与 __getBoneState / findArmBones 的 findBone 一致）
   */
  private resolveBoneKey(bone: { name: string; userData: Record<string, unknown> }): string {
    const mmdName = (bone.userData as { mmdBoneName?: string }).mmdBoneName;
    if (mmdName) return mmdName;
    const mmdEngName = (bone.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName;
    if (mmdEngName) return mmdEngName;
    return bone.name;
  }

  /**
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正：通过骨骼名（日文/英文）查找 Three.js Bone。
   * 检查 bone.name / userData.mmdBoneName / userData.mmdEnglishBoneName 三个来源。
   */
  private findBoneByName(name: string): { name: string; userData: Record<string, unknown>; quaternion: { x: number; y: number; z: number; w: number }; position: { x: number; y: number; z: number } } | undefined {
    // 优先查缓存（O(1)），缓存未命中时回退到线性搜索并写入缓存
    const cached = this.boneCache.get(name);
    if (cached !== undefined) return cached;
    // 缓存未命中（如 VMD 中的骨骼名在模型中不存在），回退线性搜索
    const bones = this.model.mesh.skeleton?.bones ?? [];
    const found = bones.find(b =>
      b.name === name ||
      (b.userData as { mmdBoneName?: string }).mmdBoneName === name ||
      (b.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name
    ) as typeof bones[number] | undefined;
    this.boneCache.set(name, found as any);
    return found as any;
  }

  /**
   * 获取当前时间源的时间（秒）。
   * - local-clock: performance.now() / 1000
   * - performance-clock: PerformanceClock.now()（必须已对齐）
   */
  private getTimeNow(): number {
    if (this.currentTimeSource === 'performance-clock') {
      const clock = this.options.performanceClock;
      if (!clock) {
        throw new Error('[MotionPlayer] performance-clock timeSource requires performanceClock in constructor options');
      }
      return clock.now();
    }
    return localClockNow();
  }

  /**
   * Transfer an in-flight speaking clip to the monotonic local clock while
   * preserving its current animation/fade elapsed time.
   *
   * The audio-owned PerformanceClock is intentionally cleared as soon as a
   * reply ends.  A pending stop fade must not keep reading that cleared clock
   * (which may be suspended or jump back to an AudioContext absolute time), or
   * the player can remain forever in `fading-out` and retain VMD ownership.
   */
  handoffToLocalClock(): void {
    // A native transition bridge keeps its own target time source until the
    // bridge finishes.  If audio ends during that short bridge, the old code
    // could leave the player in `bridging` while PerformanceClock had already
    // been cleared, so no later frame could advance or release its leases.
    const bridgeUsesPerformanceClock = this.state === 'bridging'
      && this.nativeBridgeTarget?.timeSource === 'performance-clock';
    if (this.currentTimeSource !== 'performance-clock' && !bridgeUsesPerformanceClock) return;
    const performanceNow = this.currentTimeSource === 'performance-clock'
      ? this.getTimeNow()
      : (this.options.performanceClock?.now() ?? 0);
    const localNow = localClockNow();
    const animationElapsed = Math.max(0, performanceNow - this.animationStartedAt);
    const fadeElapsed = Math.max(0, performanceNow - this.fadeStartedAt);
    this.currentTimeSource = 'local-clock';
    this.animationStartedAt = localNow - animationElapsed;
    this.fadeStartedAt = localNow - fadeElapsed;
    if (this.retainedAnimationClock) {
      const retainedElapsed = Math.max(0, performanceNow - this.retainedAnimationClock.startedAt);
      this.retainedAnimationClock = {
        ...this.retainedAnimationClock,
        startedAt: localNow - retainedElapsed
      };
    }
    // The bridge pose is already the visible speech pose.  Treat it as the
    // active local-clock clip for the fade-out/idle handoff instead of waiting
    // for a target that can no longer be reached after audio teardown.
    if (this.state === 'bridging') {
      this.nativeBridgeTarget = null;
      this.state = 'playing';
    }
  }

  /**
   * 校验 speaking motion 启动条件：
   * - timeSource='performance-clock' 时，AudioContext 必须 running
   * - PerformanceClock 必须 aligned（audioStartTime 已设置）
   *
   * 用户要求：AudioContext 未运行/未对齐时禁止启动 speaking motion
   */
  private validateSpeakingMotionStart(timeSource: MotionTimeSource): void {
    if (timeSource !== 'performance-clock') return;
    const clock = this.options.performanceClock;
    if (!clock) {
      throw new Error('[MotionPlayer] speaking motion requires performanceClock in constructor options');
    }
    if (clock.getAudioStartTime() === undefined) {
      throw new Error('[MotionPlayer] speaking motion rejected: PerformanceClock not aligned (audioStartTime undefined)');
    }
    const getState = this.options.getAudioContextState;
    if (getState) {
      const state = getState();
      if (state !== 'running') {
        throw new Error(`[MotionPlayer] speaking motion rejected: AudioContext state='${state}' (requires 'running')`);
      }
    }
    // 如果 getAudioContextState 未提供，跳过此检查（仅依赖 PerformanceClock aligned 检查）
  }

  /**
   * 加载并播放 VMD 动作。
   *
   * 用户要求（2026-07-19）：
   * - 动作切换不得先瞬间 reset 到 Base Pose：旧动作 fade-out → 新动作 fade-in
   * - 真正执行 fade：进入/退出至少 0.5 秒
   * - Cooldown：同一 packId 在 cooldownSeconds 内不重复启动
   *
   * 流程：
   * 1. 如果当前正在播放（state='playing' 或 'fading-in'）：
   *    - 不立即 stop，而是设置 pendingSwitch，进入 fade-out 状态
   *    - fade-out 完成后自动启动新动作
   * 2. 校验 speaking motion 启动条件（timeSource='performance-clock' 时）
   * 3. Cooldown 校验（同一 packId 在 cooldownSeconds 内拒绝）
   * 4. loadVmd(bytes) 解析 VMD
   * 5. retargetBones(loaded, mapping) 重定向骨骼名
   * 6. applyAmplitudeLimits(loaded, limits) 限幅
   * 7. 通过 BoneOwnershipRegistry claim 所有涉及的骨骼（store leases）
   * 8. 如有 まばたき 轨道，claim morph
   * 9. model.setAnimation(animation) 绑定动画
   * 10. 快照 rest pose（用于 fade 插值）
   * 11. 记录 animationStartedAt，进入 'fading-in' 状态
   *
   * 失败路径：
   * - VMD 解析失败 → 抛错，state 保持 idle
   * - claim 骨骼失败（被更高优先级持有）→ 抛错，已 claim 的 lease 全部释放
   * - Speaking motion 启动校验失败 → 抛错
   * - Cooldown 内重复启动 → 抛错（除非 force=true）
   */
  async play(
    packId: string,
    vmdBytes: Uint8Array | ArrayBuffer,
    options: {
      boneMapping?: BoneMapping;
      amplitudeLimits?: AmplitudeLimits;
      looping?: boolean;
      timeSource?: MotionTimeSource;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
      cooldownSeconds?: number;
      force?: boolean; // 跳过 cooldown 检查
      /**
       * Phase 5.2B.3 Closeout Task 3：组合模式。
       * 只能由本地注册的 manifest 提供，不允许 IPC 或 AI 传入。
       * - 'additive-from-base'：内部程序化 VMD，叠加在 relaxed base pose 上
       * - 'absolute' 或 undefined：外部 VMD，直接覆盖
       */
      compositionMode?: MotionCompositionMode;
      candidateTrackPolicy?: CandidateTrackPolicy;
      /** Internal real-time speech layer; ignored by local-clock idle/preview. */
      speechStance?: SpeechStanceProfile;
      /** Optional generated lower-body balance accent; raw VMD legs stay stripped. */
      speechStanceAccent?: SpeechStanceAccent;
      /** Rotation-only source retention for coordinated speech lower-body motion. */
      speechStanceSourceRetention?: number;
      /** Internal pose-bridge timing profile for a deliberate speech exit. */
      transitionProfile?: TransitionBridgeProfile;
      /** VMD-only sampling rate. Audio, subtitles and performance time stay unchanged. */
      playbackRate?: number;
      /** Candidate preview only: keep source morphs for the separate expression view. */
      candidateExpressionPolicy?: 'separate';
    } = {}
  ): Promise<void> {
    const requestToken = this.requestGate.next();
    const timeSource: MotionTimeSource = options.timeSource ?? 'local-clock';
    const fadeInSeconds = this.transitionDuration(options.fadeInSeconds ?? DEFAULT_FADE_CONFIG.fadeInSeconds);
    const fadeOutSeconds = this.transitionDuration(options.fadeOutSeconds ?? DEFAULT_FADE_CONFIG.fadeOutSeconds);
    const cooldownSeconds = options.cooldownSeconds ?? 0;
    const force = options.force === true;

    // 1. 动作切换直接进入 pose-aware bridge。旧实现先等待一个实际上不做
    // 姿态插值的 fade-out，再开始真正的 bridge；短语音会在 bridge 绑定前结束，
    // 连续 cue 还会互相覆盖 pendingSwitch。目标解析期间旧 VMD 继续采样，
    // 准备好后从屏幕上当前可见姿态立即生成本次专属桥。
    if (this.state !== 'idle') {
      // 校验新动作的启动条件
      this.validateSpeakingMotionStart(timeSource);
      // Cooldown 校验
      if (!force && cooldownSeconds > 0) {
        this.validateCooldown(packId, cooldownSeconds);
      }
      this.capturePendingTransitionSource();
      this.prepareImmediateSwitch();
      await this.startPlay(
        packId,
        vmdBytes,
        options,
        timeSource,
        fadeInSeconds,
        fadeOutSeconds,
        cooldownSeconds,
        requestToken
      );
      return;
    }

    // 2. state='idle'，直接启动新动作
    this.validateSpeakingMotionStart(timeSource);
    if (!force && cooldownSeconds > 0) {
      this.validateCooldown(packId, cooldownSeconds);
    }
    await this.startPlay(packId, vmdBytes, options, timeSource, fadeInSeconds, fadeOutSeconds, cooldownSeconds, requestToken);
  }

  /**
   * 实际启动新动作（内部方法）。
   * 调用前已校验 speaking motion + cooldown。
   */
  private async startPlay(
    packId: string,
    vmdBytes: Uint8Array | ArrayBuffer,
    options: {
      boneMapping?: BoneMapping;
      amplitudeLimits?: AmplitudeLimits;
      looping?: boolean;
      compositionMode?: MotionCompositionMode;
      candidateTrackPolicy?: CandidateTrackPolicy;
      speechStance?: SpeechStanceProfile;
      speechStanceAccent?: SpeechStanceAccent;
      speechStanceSourceRetention?: number;
      transitionProfile?: TransitionBridgeProfile;
      playbackRate?: number;
      candidateExpressionPolicy?: 'separate';
    },
    timeSource: MotionTimeSource,
    fadeInSeconds: number,
    fadeOutSeconds: number,
    cooldownSeconds: number,
    requestToken: number
  ): Promise<void> {
    const looping = options.looping ?? true;
    const boneMapping = options.boneMapping ?? {};
    const amplitudeLimits = options.amplitudeLimits ?? null;
    const targetCompositionMode = options.compositionMode ?? 'absolute';
    const targetPlaybackRate = Number.isFinite(options.playbackRate)
      ? Math.min(1, Math.max(0.5, options.playbackRate!))
      : 1;
    const effectiveTrackPolicy = resolveEffectiveCandidateTrackPolicy(timeSource, options.candidateTrackPolicy);
    this.currentCompositionMode = targetCompositionMode;

    // 1. 加载 VMD
    let loaded: LoadedVmd;
    try {
      loaded = await loadVmd(vmdBytes);
    } catch (e) {
      throw new Error(`[MotionPlayer] loadVmd failed: ${(e as Error).message}`);
    }
    this.requestGate.assertCurrent(requestToken);

    // 2. 重定向骨骼名
    if (Object.keys(boneMapping).length > 0) {
      loaded = retargetBones(loaded, boneMapping);
    }

    // 3. 限幅
    if (amplitudeLimits) {
      loaded = applyAmplitudeLimits(loaded, amplitudeLimits);
    }
    if (options.candidateExpressionPolicy === 'separate') {
      loaded = stripCandidateMorphTracks(loaded);
    }

    // Source VMDs often contain hundreds of static tracks for a different model.
    // Filter against the actual PMX before claiming ownership or binding animation.
    const modelBoneNames = new Set(
      (this.model.mesh.skeleton?.bones ?? []).map(bone => this.resolveBoneKey(bone))
    );
    // Imported PMX files are often authored with English body names while the
    // shared VMD pool uses the Japanese MMD names.  Retarget only the stable
    // body chain; unknown/hair tracks remain fail-closed and are filtered out.
    const automaticBoneMapping = buildCompatibleBoneMapping(loaded, modelBoneNames);
    if (Object.keys(automaticBoneMapping).length > 0) {
      loaded = retargetBones(loaded, automaticBoneMapping);
    }
    const allowedBones = new Set(modelBoneNames);
    const allowedMorphs = new Set(Object.keys(this.model.mesh.morphTargetDictionary ?? {}));
    const speechRecoveryKeepsGroundedTarget = shouldPreserveSpeechRecoveryTargetBody(
      timeSource,
      options.transitionProfile,
      effectiveTrackPolicy
    );
    if ((effectiveTrackPolicy === 'standard-upper-body' || effectiveTrackPolicy === 'dialogue-body-only')
      && !speechRecoveryKeepsGroundedTarget) {
      for (const name of [...allowedBones]) {
        const safeStanceSource = effectiveTrackPolicy === 'dialogue-body-only'
          && timeSource === 'performance-clock'
          && options.speechStance !== undefined
          && isRestrainedDialogueSourceBone(name);
        if (!isGroundedDialogueBoneAllowed(name) && !safeStanceSource) allowedBones.delete(name);
      }
      if (effectiveTrackPolicy === 'dialogue-body-only') {
        allowedMorphs.clear();
      } else {
        for (const name of [...allowedMorphs]) {
          if (!AUDITED_CANDIDATE_MORPHS.has(name)) allowedMorphs.delete(name);
        }
      }
    } else if (effectiveTrackPolicy === 'grounded-full-body'
      || effectiveTrackPolicy === 'trusted-voice-full-body') {
      // A user-approved voice action is allowed to keep its authored body,
      // legs and root tracks. Dynamic hair/clothing tracks are removed below
      // so the VMD cannot compete with Bullet. The shared grounded policy
      // keeps authored expression morphs for manual/action-pool preview;
      // trusted voice clips keep morph ownership with the facial performance
      // layer for stable lip-sync and differentiated expression.
      if (effectiveTrackPolicy === 'trusted-voice-full-body') allowedMorphs.clear();
    }
    loaded = filterAnimationTracks(
      loaded,
      allowedBones,
      allowedMorphs,
      requiresParsedTrackExecution(effectiveTrackPolicy)
    );

    // 4. 剥离动态骨骼轨道（物理引擎启用时）
    // 避免 VMD 和 Bullet 物理同时抢头发/裙子骨骼导致抖动。
    if (this.dynamicBoneFilter.size > 0) {
      const filteredBones = new Set(allowedBones);
      for (const name of this.dynamicBoneFilter) {
        filteredBones.delete(name);
      }
      loaded = filterAnimationTracks(loaded, filteredBones, allowedMorphs, true);
    }

    if (effectiveTrackPolicy === 'grounded-full-body'
      || effectiveTrackPolicy === 'trusted-voice-full-body') {
      loaded = rebaseTrustedVoiceControllerTranslations(
        loaded,
        boneName => this.captureCurrentVmdPose(boneName)
      );
    }

    // 下半身 fail-closed 门只对语音同步动作生效：语音短语衔接时腰/中心/足 IK
    // 保持落地。待机、待机轮换动作、手动动作与长 VMD 舞蹈（local-clock）完全
    // 不过滤，authored 腰部/下半身/中心轨道按 VMD 原样播放，不限制动作幅度。
    if (shouldApplyOneShotLowerBodyGate(looping, timeSource, effectiveTrackPolicy)) {
      loaded = filterUnsafeOneShotLowerBodyTracks(loaded);
    }

    // Reply stance is intentionally speech-only. Idle and motion-library
    // preview use local-clock and therefore retain their original tracks.
    // Raw dialogue lower-body tracks were removed above; this adds one small,
    // translation-free stance shared by every phrase VMD in the reply.
    if (timeSource === 'performance-clock'
      && effectiveTrackPolicy !== 'trusted-voice-full-body'
      && options.speechStance) {
      loaded = applySpeechStanceTracks(
        loaded,
        options.speechStance,
        1,
        modelBoneNames,
        options.speechStanceAccent,
        options.speechStanceSourceRetention
      );
    }

    // Normalize before adding fallback tracks. Otherwise an invalid metadata
    // sentinel is copied into those generated tracks and becomes impossible to
    // distinguish from a real authored key later in the pipeline.
    loaded = normalizePlayableAvatarDuration(loaded);

    if (options.transitionProfile === 'speech-to-idle-recovery'
      && effectiveTrackPolicy === 'dialogue-body-only') {
      loaded = injectSpeechLowerBodyHoldTracks(loaded, modelBoneNames, boneName =>
        this.captureCurrentVmdPose(boneName)
      );
    }

    loaded = injectRelaxedArmFallbackTracks(loaded, modelBoneNames, boneName => {
      const basePose = this.getBasePose?.(boneName);
      return basePose ? this.localPoseToVmdPose(boneName, basePose) : undefined;
    });

    const groundedRootTrack = loaded.boneTracks['全ての親'];
    if (groundedRootTrack) {
      const stabilizedRootTrack = stabilizeGroundedRootTrack(groundedRootTrack);
      const boneTracks = { ...loaded.boneTracks, '全ての親': stabilizedRootTrack };
      loaded = {
        ...loaded,
        animation: { ...loaded.animation, bytes: new Uint8Array(), boneTracks },
        boneTracks
      };
    }

    if (options.transitionProfile === 'speech-entry') {
      const speechEntryFrame = selectSpeechEntryStartFrame(
        loaded.boneTracks,
        loaded.animation.metadata?.maxFrame ?? 0,
        30
      );
      loaded = repairSpeechEntryNeutralArmLeadIn(loaded, speechEntryFrame);
    }

    if (options.transitionProfile === 'speech-to-idle-recovery') {
      loaded = stabilizeRecoveryAnchorTracks(loaded, boneName =>
        this.captureCurrentVmdPose(boneName)
      );
    }

    // 5. claim 所有涉及的骨骼
    // Cross-fade 修复：先释放跨渐变暂存的旧租约，再 claim 新骨骼。
    // 避免相同 owner ('vmd') 重复 claim 被拒绝。
    if (this.crossFadeLeases.length > 0) {
      for (const lease of this.crossFadeLeases) {
        try {
          this.boneRegistry.release(lease);
        } catch { /* ignore */ }
      }
      this.crossFadeLeases = [];
    }
    const transitionSource = this.pendingTransitionSource;
    this.pendingTransitionSource = null;
    const outgoingBoneNames = transitionSource
      ? extractBoneNames(transitionSource.loaded)
      : [...this.currentVmdBoneNames];
    const boneNames = extractBoneNames(loaded);
    const nativeBridgeBoneNames = collectTransitionBoneNames(outgoingBoneNames, boneNames, new Map());
    // Speech transitions must run as real MMD tracks before IK and Bullet.
    // A post-model local-pose overlay moves collider parents after physics has
    // already run, which launches hair and clothes even when Bullet itself is
    // continuous. Speech profiles use a deliberately short native bridge. The
    // selected target starts at frame zero after only a malformed neutral arm
    // lead-in has been repaired (active looping poses remain untouched).
    // A head-only reply fades its temporary default body to the natural base
    // pose. The next reply may therefore have no outgoing VMD loaded. Keep
    // this speech recovery on a native MMD bridge anyway so Bullet sees the
    // first body frames before physics instead of a post-model inertial jump.
    const useNativeBridge = nativeBridgeBoneNames.length > 0
      && (transitionSource !== null
        || options.transitionProfile === 'speech-to-idle-recovery'
        // speech-entry 在上一个回复已淡出（head-only/无出口 VMD）时也必须
        // 走 native 桥：否则目标 clip 帧 0 直接生效，身体/腿部一帧内跳变，
        // 表现为"没有衔接"。桥首姿态取当前渲染姿态（base/idle 快照）。
        || options.transitionProfile === 'speech-entry');
    const transitionBoneNames = useNativeBridge
      ? nativeBridgeBoneNames
      : collectTransitionBoneNames(outgoingBoneNames, boneNames, this.previousRenderedSnapshots);
    // Phase 5.2B.3 Closeout Task 3 Step 4 修正：记录当前 VMD 实际采样的骨骼名，
    // applyPoseComposition 只处理这些骨骼，避免对非 VMD 骨骼做错误的 additive 组合。
    this.currentVmdBoneNames = new Set(useNativeBridge ? nativeBridgeBoneNames : boneNames);
    const newLeases: OwnershipLease[] = [];
    for (const boneName of this.currentVmdBoneNames) {
      const lease = this.boneRegistry.claim(boneName, 'vmd');
      if (!lease) {
        for (const l of newLeases) {
          this.boneRegistry.release(l);
        }
        throw new Error(`[MotionPlayer] failed to claim bone '${boneName}' (held by higher priority owner)`);
      }
      newLeases.push(lease);
    }
    this.boneLeases = newLeases;

    // 5. claim morph（如有 まばたき 轨道）
    const morphNames = extractMorphNamesFromAnimation(loaded.animation);
    const newMorphLeases: OwnershipLease[] = [];
    for (const morphName of morphNames) {
      const lease = this.morphRegistry.claim(morphName, 'vmd');
      if (!lease) {
        for (const l of newMorphLeases) {
          this.morphRegistry.release(l);
        }
        for (const l of newLeases) {
          this.boneRegistry.release(l);
        }
        throw new Error(`[MotionPlayer] failed to claim morph '${morphName}' (held by higher priority owner)`);
      }
      newMorphLeases.push(lease);
    }
    this.morphLeases = newMorphLeases;

    // 6. 绑定动画
    // ChatX2 内部生成的 additive-from-base clips 使用完整的 JS 解析轨道。
    // 这些 bytes 并非来自真实作者导出的 VMD，当前 mmd-anim WASM clip
    // 在真实赛琳娜 PMX 上会抛出 "null pointer passed to rust"；清空 bytes
    // 会让 three-mmd-loader 走同一个公开 runtime 的 parsed-track fallback，
    // 保留骨骼/淡入/所有权语义。外部候选 VMD 保持原始 bytes，继续走 WASM。
    const animationForRuntime = this.currentCompositionMode === 'additive-from-base'
      ? { ...loaded.animation, bytes: new Uint8Array() }
      : loaded.animation;
    // Capture the currently rendered local pose before setAnimation(). The
    // loader restores rest transforms while binding, so sampling afterwards
    // would reintroduce the very rest-pose flash this transition prevents.
    const visibleSourceSnapshots = this.snapshotBones(transitionBoneNames);
    this.inertialSourceSnapshots = useNativeBridge
      ? new Map()
      : new Map(visibleSourceSnapshots.map(snapshot => [snapshot.boneName, snapshot]));
    this.inertializers.clear();
    this.inertialOverlayStarted = false;

    this.currentPackId = packId;
    // A new clip must start its own soft-pose history. Reusing the previous
    // clip's filtered quaternion would introduce a hidden one-frame blend on
    // repeated idle/voice actions, exactly where a bridge already owns the
    // hand-off.
    this.softenedPoseSnapshots.clear();
    this.softenedPackId = null;
    this.softenedLastSampleAt = 0;
    this.naturalEndNotified = false;
    this.naturalEndHandoffPending = false;
    // All parsing and ownership claims succeeded. setAnimation() below is
    // synchronous, so this is the first safe point to stop sampling the
    // retained outgoing VMD. If any earlier step throws, the old VMD remains
    // visually coherent instead of falling back to wall-clock sampling.
    this.retainedAnimationClock = null;

    // 7. 计算动画时长
    const maxFrame = loaded.animation.metadata?.maxFrame ?? 0;
    let frameRate = 30;
    try {
      const fs = this.model.runtime.frameState?.();
      if (fs && typeof fs.frameRate === 'number' && fs.frameRate > 0) {
        frameRate = fs.frameRate;
      }
    } catch {
      // frameState 不可用时使用默认 30fps
    }
    const authoredDurationSeconds = maxFrame / frameRate;
    const targetDurationSeconds = authoredDurationSeconds / targetPlaybackRate;

    let bridgeAnimation: MmdAnimation | null = null;
    let bridgeDurationSeconds = 0;
    if (useNativeBridge) {
      // fade-out 期间旧 VMD 仍在推进，因此请求切换时保存的 frame 已经过期。
      // 桥首帧必须来自 setAnimation() 前屏幕上实际显示的局部姿态，才能保证
      // 动作 A 的当前帧与临时桥第一帧完全相同。
      const visibleByName = new Map(visibleSourceSnapshots.map(snapshot => [snapshot.boneName, snapshot]));
      const sourcePoses = new Map<string, VmdLocalPose>();
      for (const boneName of nativeBridgeBoneNames) {
        const visible = visibleByName.get(boneName);
        const visiblePose = visible
          ? this.localPoseToVmdPose(boneName, this.snapshotToLocalPose(visible))
          : this.captureCurrentVmdPose(boneName);
        sourcePoses.set(boneName, resolveTransitionSourcePose(
          boneName,
          visiblePose,
          transitionSource?.loaded.boneTracks[boneName],
          transitionSource?.frame ?? 0,
          options.transitionProfile === 'speech-to-idle-recovery'
        ));
      }
      // The bridge endpoint must meet the incoming clip at frame zero for
      // every profile. Sampling an ordinary target a few frames in makes the
      // authored first pose appear only after the bridge, which is visible as
      // a lower-body shift when the selected idle takes ownership.
      const targetStartOffsetSeconds = 0;
      const releaseGroundedToTarget = options.transitionProfile === 'speech-to-idle-recovery'
        && (effectiveTrackPolicy !== 'dialogue-body-only' || timeSource === 'local-clock')
        && nativeBridgeBoneNames.some(boneName => SPEECH_LOWER_BODY_TRANSITION_BONE.test(boneName));
      const targetPoses = this.createTargetTransitionPoses(
        nativeBridgeBoneNames,
        loaded,
        targetStartOffsetSeconds * frameRate,
        releaseGroundedToTarget,
        transitionSource?.loaded ?? null
      );
      // P1 速度连续：采样出口 clip 切换帧之后短时刻的姿态，桥按外推速度
      // 继续运动而不是先冻结再缓动起步（仅上半身白名单骨骼；下半身/
      // 根骨/IK 保持原有 fail-closed 行为）。目标 clip 开场自带运动时，
      // 桥尾也带一点末速度，避免目标动作从静止突起步。
      const velocityLookaheadFrames = Math.max(1, Math.round(0.1 * frameRate));
      const sourceVelocityPoses = new Map<string, VmdLocalPose>();
      const targetVelocityPoses = new Map<string, VmdLocalPose>();
      for (const boneName of nativeBridgeBoneNames) {
        if (!isUpperBodyVelocityContinuationBone(boneName)) continue;
        if (transitionSource) {
          const outgoingTrack = transitionSource.loaded.boneTracks[boneName];
          if (outgoingTrack && outgoingTrack.frames.length > 1) {
            const velocityPose = sampleVmdBoneTrack(
              outgoingTrack,
              transitionSource.frame + velocityLookaheadFrames
            );
            if (velocityPose) sourceVelocityPoses.set(boneName, velocityPose);
          }
        }
        const targetTrack = loaded.boneTracks[boneName];
        if (targetTrack && targetTrack.frames.length > 1) {
          const targetVelocityPose = sampleVmdBoneTrack(
            targetTrack,
            targetStartOffsetSeconds * frameRate + velocityLookaheadFrames
          );
          if (targetVelocityPose) targetVelocityPoses.set(boneName, targetVelocityPose);
        }
      }
      const resolveRelaxedArmPose = (boneName: string): VmdLocalPose | undefined => {
            const basePose = this.getBasePose?.(boneName);
            if (basePose) {
              const pose = this.localPoseToVmdPose(boneName, basePose);
              if (options.transitionProfile === 'speech-entry' && /^[左右]腕$/u.test(boneName)) {
                const sign = boneName.startsWith('左') ? -1 : 1;
                const clearance = new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(0, 0, 1),
                  sign * SPEECH_ENTRY_CLEARANCE_Z_RAD
                );
                const rotation = new THREE.Quaternion(...pose.rotation)
                  .normalize()
                  .multiply(clearance)
                  .normalize();
                return {
                  translation: [...pose.translation],
                  rotation: [rotation.x, rotation.y, rotation.z, rotation.w]
                };
              }
              return pose;
            }
            const rest = this.pmxRestPoseSnapshots.get(boneName);
            return rest ? this.localPoseToVmdPose(boneName, {
              quaternion: [rest.quaternion.x, rest.quaternion.y, rest.quaternion.z, rest.quaternion.w],
              position: [rest.position.x, rest.position.y, rest.position.z]
            }) : undefined;
          };
      const waypointPoses = options.transitionProfile === 'speech-entry'
        ? createSpeechEntryArmWaypointSequences(sourcePoses, targetPoses, resolveRelaxedArmPose)
        : options.transitionProfile === 'speech-to-idle-recovery'
          ? createSpeechToIdleArmWaypointSequences(sourcePoses, targetPoses, resolveRelaxedArmPose)
          : undefined;
      const bridge = createTransitionBridgeAnimation(sourcePoses, targetPoses, {
        speedMultiplier: this.transitionSpeed,
        frameRate,
        profile: options.transitionProfile,
        sourceVelocityPoses,
        sourceVelocityLookaheadSeconds: velocityLookaheadFrames / frameRate,
        targetVelocityPoses,
        targetVelocityLookaheadSeconds: velocityLookaheadFrames / frameRate,
        // When the previous reply has already faded to the natural base there
        // is no outgoing VMD pose to bridge from. Give the complete body chain
        // a longer first entry so legs and Bullet-owned descendants never
        // receive a rushed frame-zero correction.
        minimumDurationSeconds: options.transitionProfile === 'speech-to-idle-recovery'
          ? releaseGroundedToTarget
            ? 1.7
            : transitionSource === null
              ? 1.5
              : undefined
          : undefined,
        maximumDurationSeconds: options.transitionProfile === 'speech-entry'
          && targetDurationSeconds <= 2.5
          // 0.75s 的硬截断曾把 profile 设计的 ≥1.0s 自然时长压到不足一秒：
          // 躯干/腿/手臂的大位移在桥内完成得太快，Bullet 裙摆链跟不上，
          // 表现为语音动作衔接突变、裙摆被掀起。2026-08 用户二次反馈
          // "进入语音动作太快"：上限从 1.5s 再放宽到 1.75s，让 profile 的
          // 自然时长（≥1.4s）生效；比例下限仍保证短 clip 本体可见。
           ? Math.min(1.75, Math.max(1.35, targetDurationSeconds * 0.7))
           : undefined,
        waypointSequences: waypointPoses
      });
      bridgeAnimation = bridge.animation;
      bridgeDurationSeconds = bridge.durationSeconds;
      this.nativeBridgeTarget = {
        animation: animationForRuntime,
        loaded,
        boneNames,
        durationSeconds: targetDurationSeconds,
        looping,
        timeSource,
        compositionMode: targetCompositionMode,
        startOffsetSeconds: targetStartOffsetSeconds,
        playbackRate: targetPlaybackRate,
        groundedRecovery: options.transitionProfile === 'speech-to-idle-recovery'
          && effectiveTrackPolicy === 'dialogue-body-only'
      };
      this.currentAnimation = bridgeAnimation;
      this.currentLoadedVmd = {
        bytes: bridgeAnimation.bytes,
        animation: bridgeAnimation,
        boneTracks: { ...bridgeAnimation.boneTracks },
        morphTracks: {}
      };
      this.currentCompositionMode = 'absolute';
      this.playbackRate = 1;
      this.bindAnimationAtStart(bridgeAnimation);
      this.animationDurationSec = bridgeDurationSeconds;
    } else {
      this.nativeBridgeTarget = null;
      this.currentAnimation = animationForRuntime;
      this.currentLoadedVmd = loaded;
      this.playbackRate = targetPlaybackRate;
      this.bindAnimationAtStart(animationForRuntime);
      this.animationDurationSec = targetDurationSeconds;
    }

    // 8. 切换时间源
    this.currentTimeSource = timeSource;
    this.looping = useNativeBridge ? false : looping;
    this.lastObservedLoopCycle = 0;
    const effectiveFadeInSeconds = options.transitionProfile === 'speech-entry'
      ? Math.min(1.2, Math.max(0.75, fadeInSeconds))
      : options.transitionProfile === 'speech-to-idle-recovery'
        // Keep the recovery bridge and fade on the same clock. A shorter fade
        // lets the idle VMD take ownership while the bridge is still moving,
        // which shows as a small shoulder/head twitch on return or a turn.
        // 2026-08: 与更长的桥时长同步放宽，淡入不再先于桥结束。
        ? Math.min(1.45, Math.max(0.95, fadeInSeconds))
        : fadeInSeconds > 0 ? Math.max(0.65, fadeInSeconds) : 0;
    this.fadeConfig = {
      fadeInSeconds: effectiveFadeInSeconds,
      fadeOutSeconds
    };
    this.currentCooldownSeconds = cooldownSeconds;

    // Keep the selected dialogue action on frame zero while the visible pose
    // converges. Otherwise the blend consumes the beginning of a 3-4 second
    // voice action and the user never sees its complete authored movement.
    const transitionStartedAt = this.getTimeNow();
    const holdTargetAtFirstFrame = !useNativeBridge
      && options.transitionProfile !== undefined
      && effectiveFadeInSeconds > 0;
    this.animationStartedAt = transitionStartedAt
      + (holdTargetAtFirstFrame ? effectiveFadeInSeconds : 0);

    // 9. 保留绑定前的可见姿态，供惯性化过渡作为起点。
    //
    // T-pose 修复（2026-07-28）：snapshotBones 读取的是当前骨骼的实际姿态
    // （来自 procedural controllers 或上一个 VMD），不是 PMX rest pose。
    // 因为 setAnimation 不改变骨骼值，所以在 setAnimation 后、第一帧 update 前，
    // 骨骼保持的是调用 play() 之前的姿态。
    //
    this.restPoseSnapshots = visibleSourceSnapshots;

    // 10. 记录 cooldown
    if (cooldownSeconds > 0) {
      this.cooldownRecords.set(packId, {
        packId,
        lastPlayedAt: transitionStartedAt
      });
    }

    // 11. 进入 fading-in 状态
    this.fadeStartedAt = transitionStartedAt;
    this.inertialLastSampleAt = transitionStartedAt;
    this.state = useNativeBridge
      ? 'bridging'
      : this.fadeConfig.fadeInSeconds > 0 ? 'fading-in' : 'playing';
  }

  /**
   * 启动 fade-out（不立即停止）。
   * fade-out 完成后，根据 pendingStopAfterFadeOut/pendingSwitchPackId 决定下一步。
   */
  private startFadeOut(fadeOutSeconds: number): void {
    if (this.state === 'idle' || this.state === 'fading-out') return;
    // 快照当前 VMD-sampled pose（用于 fade-out 插值起点）
    const boneNames = this.getCurrentBoneNames();
    this.fadeOutSnapshot = this.snapshotBones(boneNames);
    this.fadeConfig.fadeOutSeconds = fadeOutSeconds;
    this.fadeStartedAt = this.getTimeNow();
    this.state = 'fading-out';
  }

  /** Preserve the outgoing animation and ownership until startPlay binds its bridge. */
  private prepareImmediateSwitch(): void {
    if (this.boneLeases.length > 0) {
      this.crossFadeLeases = this.boneLeases;
      this.boneLeases = [];
    }
    for (const lease of this.morphLeases) {
      try { this.morphRegistry.release(lease); } catch { /* ignore */ }
    }
    this.morphLeases = [];
    this.pendingSwitchPackId = null;
    this.pendingSwitchBytes = null;
    this.pendingSwitchToken = null;
    this.pendingSwitchOptions = null;
    this.pendingStopAfterFadeOut = false;
  }

  /**
   * Cooldown 校验：同一 packId 在 cooldownSeconds 内拒绝启动。
   */
  private validateCooldown(packId: string, cooldownSeconds: number): void {
    const record = this.cooldownRecords.get(packId);
    if (!record) return;
    const now = this.getTimeNow();
    const elapsed = now - record.lastPlayedAt;
    if (elapsed < cooldownSeconds) {
      throw new Error(
        `[MotionPlayer] cooldown rejected: packId='${packId}' last played ${elapsed.toFixed(2)}s ago, ` +
        `cooldown=${cooldownSeconds}s (remaining ${(cooldownSeconds - elapsed).toFixed(2)}s)`
      );
    }
  }

  /**
   * 快照指定骨骼的当前 pose（quaternion + position）。
   * 用于 fade 插值的起点或终点。
   *
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正（bone lookup bug）：
   * 骨骼查找必须与 __getBoneState / findArmBones 一致，检查三个来源：
   *   bone.name → bone.userData.mmdBoneName → bone.userData.mmdEnglishBoneName
   * 否则 VMD 中的日文骨骼名（如 '左腕'）无法匹配 skeleton 中 name='LeftArm' 的骨骼，
   * 导致 restPoseSnapshots 只包含部分骨骼，fade 插值跳过手臂骨骼 → 闪回 PMX T-pose。
   */
  private snapshotBones(boneNames: readonly string[]): BoneRestPoseSnapshot[] {
    const snapshots: BoneRestPoseSnapshot[] = [];
    for (const boneName of boneNames) {
      const bone = this.findBoneByName(boneName);
      if (!bone) continue;
      snapshots.push({
        boneName,
        quaternion: { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w },
        position: { x: bone.position.x, y: bone.position.y, z: bone.position.z }
      });
    }
    return snapshots;
  }

  private restoreBoneSnapshots(snapshots: readonly BoneRestPoseSnapshot[]): void {
    for (const snapshot of snapshots) {
      const bone = this.findBoneByName(snapshot.boneName);
      if (!bone) continue;
      bone.position.x = snapshot.position.x;
      bone.position.y = snapshot.position.y;
      bone.position.z = snapshot.position.z;
      bone.quaternion.x = snapshot.quaternion.x;
      bone.quaternion.y = snapshot.quaternion.y;
      bone.quaternion.z = snapshot.quaternion.z;
      bone.quaternion.w = snapshot.quaternion.w;
    }
  }

  private capturePendingTransitionSource(): void {
    if (!this.currentLoadedVmd) return;
    let frame = 0;
    try {
      const state = this.model.runtime.frameState?.();
      if (state && typeof state.frame === 'number' && Number.isFinite(state.frame)) frame = state.frame;
    } catch {
      frame = Math.max(0, this.getCurrentAnimationTime() * 30);
    }
    this.pendingTransitionSource = { loaded: this.currentLoadedVmd, frame };
  }

  private createSourceTransitionPoses(
    boneNames: readonly string[],
    source: LoadedVmd,
    frame: number
  ): Map<string, VmdLocalPose> {
    const poses = new Map<string, VmdLocalPose>();
    for (const boneName of boneNames) {
      const sampled = sampleVmdBoneTrack(source.boneTracks[boneName], frame);
      poses.set(boneName, sampled ?? this.captureCurrentVmdPose(boneName));
    }
    return poses;
  }

  private createTargetTransitionPoses(
    boneNames: readonly string[],
    target: LoadedVmd,
    frame: number,
    releaseGroundedToTarget = false,
    recoverySource: LoadedVmd | null = null
  ): Map<string, VmdLocalPose> {
    const poses = new Map<string, VmdLocalPose>();
    for (const boneName of boneNames) {
      const sampled = sampleVmdBoneTrack(target.boneTracks[boneName], frame);
      const targetTrack = target.boneTracks[boneName];
      // Keep model-space/root and foot-IK anchors exactly where they are at
      // the handoff.  Only the actual leg joints may rotate toward recovery;
      // allowing these controllers to target PMX/base pose moves the whole
      // avatar even when the authored leg action has no translation.
      if (releaseGroundedToTarget && SPEECH_RECOVERY_ANCHOR_BONE.test(boneName)) {
        poses.set(boneName, this.captureCurrentVmdPose(boneName));
        continue;
      }
      if (releaseGroundedToTarget && recoverySource) {
        const reverseEndpoint = resolveSpeechRecoveryLegTargetPose(
          boneName,
          sampled ?? this.captureCurrentVmdPose(boneName),
          recoverySource.boneTracks[boneName]
        );
        if (reverseEndpoint) {
          poses.set(boneName, reverseEndpoint);
          continue;
        }
      }
      // One-key lower-body tracks in these imported clips are source-PMX
      // calibration/static pose keys. Applying them as the bridge endpoint
      // re-solves the target model's IK chain and can move a toe helper by
      // several units in one rendered frame. Only multi-key lower-body tracks
      // represent authored movement that should be entered here.
      if (sampled && (releaseGroundedToTarget
        || !SPEECH_LOWER_BODY_TRANSITION_BONE.test(boneName)
        || targetTrack.frames.length > 1)) {
        poses.set(boneName, sampled);
        continue;
      }
      // A target clip may omit auxiliary lower-body tracks entirely. Falling
      // back to PMX/base pose here creates a discontinuity on the first bridge
      // frame, before the target VMD is even bound. Keep the currently visible
      // leg-chain pose as the bridge endpoint; the target bind then preserves
      // the same pose for its missing tracks.
      if (SPEECH_LOWER_BODY_TRANSITION_BONE.test(boneName)) {
        if (releaseGroundedToTarget) {
          const basePose = this.getBasePose?.(boneName);
          const rest = this.pmxRestPoseSnapshots.get(boneName);
          poses.set(boneName, basePose
            ? this.localPoseToVmdPose(boneName, basePose)
            : rest
              ? this.localPoseToVmdPose(boneName, this.snapshotToLocalPose(rest))
              : { translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
          continue;
        }
        poses.set(boneName, this.captureCurrentVmdPose(boneName));
        continue;
      }
      const basePose = this.getBasePose?.(boneName);
      poses.set(boneName, basePose
        ? this.localPoseToVmdPose(boneName, basePose)
        : { translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
    }
    return poses;
  }

  private captureCurrentVmdPose(boneName: string): VmdLocalPose {
    const bone = this.findBoneByName(boneName);
    if (!bone) return { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
    return this.localPoseToVmdPose(boneName, {
      quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      position: [bone.position.x, bone.position.y, bone.position.z]
    });
  }

  private localPoseToVmdPose(boneName: string, pose: BonePose): VmdLocalPose {
    const rest = this.pmxRestPoseSnapshots.get(boneName);
    const restPosition = rest?.position ?? { x: 0, y: 0, z: 0 };
    return {
      translation: [
        pose.position[0] - restPosition.x,
        pose.position[1] - restPosition.y,
        -(pose.position[2] - restPosition.z)
      ],
      rotation: [
        -pose.quaternion[0],
        -pose.quaternion[1],
        pose.quaternion[2],
        pose.quaternion[3]
      ]
    };
  }

  /**
   * 停止当前动作。
   *
   * 用户要求（2026-07-19）：
   * - 真正执行 fade：动作退出至少 0.5 秒
   *
   * 行为：
   * - 如果当前正在 playing/fading-in，启动 fade-out（不立即 clearAnimation）
   * - fade-out 完成后执行 clearAnimation + resetPose + release leases
   * - 如果当前正在 fading-out，保持原 fade-out（不加速）
   * - 如果 state='idle'，直接返回
   *
   * 注意：调用方在 stop() 后不应立即认为 lease 已释放。
   * 应该通过 getState() === 'idle' 或 waitForState('idle') 等待 fade-out 完成。
   * 紧急停止（如模式切换）可调用 stopImmediate()。
   */
  stop(): void {
    if (this.state === 'idle') return;
    this.requestGate.invalidate();
    if (this.state === 'fading-out') return;
    // 启动 fade-out，标记 pendingStopAfterFadeOut
    this.pendingStopAfterFadeOut = true;
    this.pendingSwitchPackId = null;
    this.pendingSwitchBytes = null;
    this.pendingSwitchToken = null;
    this.pendingSwitchOptions = null;
    this.startFadeOut(this.fadeConfig.fadeOutSeconds);
  }

  /**
   * 立即停止（不等待 fade-out）。
   * 用于紧急情况：模式切换、Avatar crash、before-quit。
   * 跳过 fade，直接 clearAnimation + resetPose + release leases。
   */
  stopImmediate(): void {
    this.requestGate.invalidate();
    this.pendingStopAfterFadeOut = false;
    this.pendingSwitchPackId = null;
    this.pendingSwitchBytes = null;
    this.pendingSwitchToken = null;
    this.pendingSwitchOptions = null;
    this.pendingTransitionSource = null;
    this.nativeBridgeTarget = null;
    this.groundedRecoverySnapshots = [];
    // Cross-fade 修复：清理跨渐变暂存的旧租约，避免骨骼泄漏
    if (this.crossFadeLeases.length > 0) {
      for (const lease of this.crossFadeLeases) {
        try { this.boneRegistry.release(lease); } catch { /* ignore */ }
      }
      this.crossFadeLeases = [];
    }
    this.performStopCleanup();
  }

  /**
   * 设置停止回调（MotionSequence 链式播放使用）。
   * performStopCleanup() 完成后调用，用于触发下一段 VMD。
   * 传入 null 清除回调。
   */
  setOnStop(callback: (() => void) | null): void {
    this.onStopCallback = callback;
  }

  /** Called at the exact end of a one-shot clip, before its stop fade. */
  setOnNaturalEnd(callback: (() => void) | null): void {
    this.onNaturalEndCallback = callback;
  }

  /**
   * 设置动态骨骼过滤器。物理引擎启用时，传入应被 VMD 剥离的骨骼名集合。
   * 这些骨骼在 VMD 加载时会被过滤，避免动画和物理同时抢骨骼。
   */
  setDynamicBoneFilter(names: ReadonlySet<string>): void {
    this.dynamicBoneFilter = new Set(names);
  }

  /**
   * 执行 stop 后的清理：clearAnimation + release leases + 重置状态。
   * 抽搐修复：不再调用 resetPose()。
   *  - fade-out 路径：applyBoneBlendToRest(t=1) 已将骨骼 lerp 到 rest pose，无需再强制重置
   *  - stopImmediate 路径：调用方负责后续启动 idle，idle 的 fade-in 会从当前姿态平滑过渡
   *  避免 resetPose() 瞬间强制重置到 PMX rest pose 导致的视觉跳变（抽搐）
   */
  private performStopCleanup(): void {
    this.performStopCleanupInternal(false);
  }

  /**
   * performStopCleanup 的内部实现。
   * @param keepAnimation 如果为 true，不调用 clearAnimation（用于 cross-fade：旧动画保持绑定直到 setAnimation 替换）
   */
  private performStopCleanupInternal(keepAnimation: boolean): void {
    // 1. clearAnimation（清除 @yohawing 内部的动画采样状态）
    // T-pose 根本修复（2026-07-28）：
    // @yohawing/three-mmd-loader 的 clearAnimation() 会设置 _restPoseDirty=true，
    // 导致下一帧 model.update() → evaluate() 调用 evaluateRestPose() 把所有骨骼
    // 重置到 PMX 默认 T-pose（张开手）。修复：clearAnimation 后立即将 _restPoseDirty
    // 设为 false，阻止 rest pose 重置，让骨骼保持当前 VMD 采样值。
    // Cross-fade 修复：有 pendingSwitch 时跳过 clearAnimation，让旧动画保持绑定
    // startPlay 中的 setAnimation 会直接替换旧动画，避免无动画帧导致骨骼回正
    if (!keepAnimation) {
      try {
        this.model.runtime.clearAnimation();
        // 阻止下一帧 evaluate() 重置骨骼到 PMX T-pose
        (this.model.runtime as any)._restPoseDirty = false;
      } catch (e) {
        console.warn('[MotionPlayer] clearAnimation failed:', e);
      }
    }
    // 2. release bone leases（释放骨骼所有权，让 procedural 层可以接管）
    // Cross-fade 修复：keepAnimation=true 时不释放骨骼租约，而是暂存到 crossFadeLeases，
    // 由 startPlay 在 claim 新骨骼前释放。避免跨帧间隙骨骼闪回 PMX T-pose。
    if (keepAnimation && this.boneLeases.length > 0) {
      // `clearAnimation` is intentionally skipped, therefore the old VMD
      // remains bound until startPlay() installs its replacement. Preserve its
      // own clock across the temporary state='idle' window.
      this.retainedAnimationClock = this.animationDurationSec > 0
        ? {
            durationSeconds: this.animationDurationSec,
            startedAt: this.animationStartedAt,
            looping: this.looping
            , playbackRate: this.playbackRate
          }
        : null;
      this.crossFadeLeases = this.boneLeases;
      this.boneLeases = [];
    } else {
      for (const lease of this.boneLeases) {
        try {
          this.boneRegistry.release(lease);
        } catch { /* ignore */ }
      }
      this.boneLeases = [];
      this.crossFadeLeases = [];
      this.retainedAnimationClock = null;
    }
    // 3. release morph leases
    for (const lease of this.morphLeases) {
      try {
        this.morphRegistry.release(lease);
      } catch { /* ignore */ }
    }
    this.morphLeases = [];
    // 5. 清除状态
    // Phase 5.2B.3 修复（flaky idle 启动失败）：
    // 在清除 currentPackId 之前，先清除 cooldown 记录。
    // 原因：cooldown 是防止"播放中重复触发同一 pack"，而非"停止后不能重启"。
    // 如果 motionPlayer 被停止（无论原因），idle 应该能立即重启。
    // 否则在 startDefaultIdlePack 两次调用的竞态中（handleModeChange + 初始模式检查），
    // 第一次 play() 成功后若被 stopImmediate 停止，第二次 play() 会被 cooldown 拒绝，
    // 导致 idle 永远无法启动（直到 30s cooldown 过期）。
    if (this.currentCooldownSeconds > 0 && this.currentPackId) {
      this.cooldownRecords.delete(this.currentPackId);
    }
    this.currentAnimation = null;
    this.currentLoadedVmd = null;
    this.nativeBridgeTarget = null;
    if (!keepAnimation) this.pendingTransitionSource = null;
    this.currentPackId = null;
    this.animationDurationSec = 0;
    this.animationStartedAt = 0;
    this.restPoseSnapshots = [];
    this.fadeOutSnapshot = [];
    this.currentCooldownSeconds = 0;
    // Phase 5.2B.3 Closeout Task 3：重置组合模式
    this.currentCompositionMode = 'absolute';
    // Phase 5.2B.3 Closeout Task 3 Step 4 修正：清空 VMD 骨骼名集合，
    // 防止下次 idle 包复用旧的 currentVmdBoneNames（虽然 startPlay 会重新填充，
    // 但清空更安全，避免 stopImmediate 后 applyPoseComposition 误用旧值）。
    this.currentVmdBoneNames = new Set();
    this.softenedPoseSnapshots.clear();
    this.softenedPackId = null;
    this.softenedLastSampleAt = 0;
    this.onNaturalEndCallback = null;
    this.naturalEndNotified = false;
    this.naturalEndHandoffPending = false;
    this.state = 'idle';
    // 触发停止回调（MotionSequence 链式播放）
    const cb = this.onStopCallback;
    if (cb) {
      this.onStopCallback = null;
      try { cb(); } catch (e) { console.warn('[MotionPlayer] onStop callback failed:', e); }
    }
  }

  /**
   * Phase 5.2B.3 Closeout Task 3：应用姿态组合。
   *
   * 在 model.update(animationTime) 之后、applyFadeBlend() 之前调用。
   *
   * - absolute 模式：no-op（VMD 采样直接生效）
   * - additive-from-base 模式：把 VMD 采样的绝对姿态转换为 base * inverse(rest) * sampled，
   *   使内部程序化 VMD 叠加在 relaxed base pose 上，而不是直接覆盖。
   *
   * 这解决了"内部程序化 VMD 回到 PMX rest pose 闪回"问题：
   * - 旧实现：VMD 采样 = 绝对姿态，gesture 第一帧（identity delta）= PMX rest pose → 闪回
   * - 新实现：VMD 采样作为 delta，叠加到 base pose → gesture 第一帧 = base pose（无闪回）
   *
   * 调用方帧序（closeout plan Task 3 Step 4）：
   * 1. model.update(animationTime)
   * 2. motionPlayer.applyPoseComposition()   ← 本方法
   * 3. motionPlayer.applyFadeBlend()
   * 4. restore non-VMD morphs
   * 5. relaxed pose on unowned bones
   * 6. actor morph update
   * 7. procedural life
   * 8. render
   */
  applyPoseComposition(): void {
    if (this.state === 'idle') return;
    if (this.currentCompositionMode !== 'additive-from-base') return;
    // Phase 5.2B.3 Closeout Task 3 Step 4 修正：只处理当前 VMD 实际采样的骨骼，
    // 避免对非 VMD 骨骼（例如 idle 不包含的 左腕）做错误的 additive 组合导致漂移。
    if (this.currentVmdBoneNames.size === 0) return;

    // additive-from-base 模式：把 VMD 采样的绝对姿态转为 base * inverse(rest) * sampled
    // Phase 5.2B.3 Closeout Task 3 Step 4 修正：使用 resolveBoneKey 获取日文骨骼名，
    // 否则 bone.name='LeftArm' 无法匹配 currentVmdBoneNames 中的 '左腕'。
    const bones = this.model.mesh.skeleton?.bones ?? [];
    for (const bone of bones) {
      const boneKey = this.resolveBoneKey(bone);
      // 只处理当前 VMD 控制的骨骼
      if (!this.currentVmdBoneNames.has(boneKey)) continue;
      const restSnap = this.pmxRestPoseSnapshots.get(boneKey);
      if (!restSnap) continue;
      // 获取 base pose（来自 RelaxedBasePoseController）
      const basePose = this.getBasePose?.(boneKey);
      // 如果 base pose provider 未提供该骨骼的 base，跳过（保持 VMD 采样不变）
      if (!basePose) continue;

      // 当前 VMD 采样的姿态
      const sampled: BonePose = {
        quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
        position: [bone.position.x, bone.position.y, bone.position.z]
      };
      const rest: BonePose = {
        quaternion: [restSnap.quaternion.x, restSnap.quaternion.y, restSnap.quaternion.z, restSnap.quaternion.w],
        position: [restSnap.position.x, restSnap.position.y, restSnap.position.z]
      };

      const composed = composeBonePose('additive-from-base', rest, basePose, sampled);
      bone.quaternion.x = composed.quaternion[0];
      bone.quaternion.y = composed.quaternion[1];
      bone.quaternion.z = composed.quaternion[2];
      bone.quaternion.w = composed.quaternion[3];
      bone.position.x = composed.position[0];
      bone.position.y = composed.position[1];
      bone.position.z = composed.position[2];
    }
  }

  /**
   * 每帧调用：推进 fade 状态机，执行 fade 插值。
   *
   * 调用方应在 framePorts.updateModel 中：
   * 1. model.update(animTime) — 采样 VMD 写入骨骼
   * 2. motionPlayer.applyPoseComposition() — Phase 5.2B.3 Closeout Task 3：additive 模式下把 VMD 采样转为 base*delta
   * 3. motionPlayer.applyFadeBlend() — 如果正在 fade，覆盖骨骼为插值结果
   * 4. Bug 4 修复：恢复 morph 权重
   *
   * 此方法在 state='idle' 时是 no-op。
   */
  applyFadeBlend(): void {
    if (this.state === 'idle' || this.poseLocked) return;

    const now = this.getTimeNow();

    // 状态机推进
    if (this.state === 'bridging') {
      const elapsed = now - this.animationStartedAt;
      if (elapsed >= this.animationDurationSec) {
        this.finishNativeBridge(now);
      }
    } else if (this.state === 'fading-in') {
      const elapsed = now - this.fadeStartedAt;
      const duration = this.fadeConfig.fadeInSeconds;
      this.applyInertialTransitionOverlay(now, duration);
      if (duration <= 0 || elapsed >= duration) {
        // Inertial bridge converged onto the sampled VMD pose.
        this.state = 'playing';
      }
    } else if (this.state === 'fading-out') {
      const elapsed = now - this.fadeStartedAt;
      const duration = this.fadeConfig.fadeOutSeconds;
      if (duration <= 0 || elapsed >= duration) {
        // fade-out 完成
        // T-pose 修复（2026-07-28）：纯停止模式也不 snap 到 rest pose。
        // 原因：restPoseSnapshots 中非手臂骨骼（如手指）保留的是 PMX 默认 T-pose，
        // snap 到 rest 会导致模型瞬间张开手、回到 T-pose，非常难看。
        // 正确做法：保持当前 VMD 采样姿态，由下一帧的 relaxed base pose + procedural life
        // 自然接管，实现平滑过渡。与 cross-fade 模式行为一致。
        // pendingSwitch 模式：保持当前 VMD-sampled pose（不 snap 到 rest）
        const switchPackId = this.pendingSwitchPackId;
        const switchBytes = this.pendingSwitchBytes;
        const switchToken = this.pendingSwitchToken;
        const switchOptions = this.pendingSwitchOptions;
        const shouldStop = this.pendingStopAfterFadeOut;
        // 清除 pending 标志
        this.pendingSwitchPackId = null;
        this.pendingSwitchBytes = null;
        this.pendingSwitchToken = null;
        this.pendingSwitchOptions = null;
        this.pendingStopAfterFadeOut = false;
        // 执行清理
        // performStopCleanup 中会根据 pendingSwitchPackId 决定是否 clearAnimation
        // 但此时 pendingSwitchPackId 已被清空，需要提前判断
        const hasPendingSwitch = !!switchPackId;
        this.performStopCleanupInternal(hasPendingSwitch);
        // 如果有 pendingSwitch，启动新动作
        if (!shouldStop && switchPackId && switchBytes && switchOptions && switchToken !== null) {
          // 异步启动新动作（不阻塞当前帧）
          const timeSource: MotionTimeSource = switchOptions.timeSource ?? 'local-clock';
          const fadeInSeconds = this.transitionDuration(switchOptions.fadeInSeconds ?? DEFAULT_FADE_CONFIG.fadeInSeconds);
          const fadeOutSeconds = this.transitionDuration(switchOptions.fadeOutSeconds ?? DEFAULT_FADE_CONFIG.fadeOutSeconds);
          const cooldownSeconds = switchOptions.cooldownSeconds ?? 0;
          // 启动新动作（忽略返回的 Promise，下一帧会看到 state='fading-in'）
          this.startPlay(switchPackId, switchBytes, switchOptions, timeSource, fadeInSeconds, fadeOutSeconds, cooldownSeconds, switchToken)
            .catch(e => console.warn('[MotionPlayer] pendingSwitch startPlay failed:', e));
        }
      } else {
        // 应用 fade-out 插值
        // T-pose 修复（2026-07-28）：纯停止模式也不 lerp 到 rest pose。
        // 原因同上：restPoseSnapshots 中非手臂骨骼是 PMX T-pose，
        // 在 fade-out 期间 lerp 会导致模型逐渐张开手（用户看到的"动作结束后张开手"）。
        // 正确做法：让 VMD 继续自然采样直到 fade-out 完成，然后由 procedural 接管。
        // pendingSwitch 模式：VMD 继续采样，不 lerp（cross-fade）
      }
    } else if (this.state === 'playing') {
      if (this.beginLoopBridge(now)) {
        // The first loop bridge sample was applied at the exact wrap frame.
      } else if (this.inertializers.size > 0) {
        this.applyInertialTransitionOverlay(now, this.fadeConfig.fadeInSeconds);
      }
      // Phase 5.2B.3：非循环 gesture 自然完成路径
      // 用户要求（2026-07-21）：
      // > motion-player.ts:716 对 looping=false 只将播放时间钳制到末帧，不会自动 stop()、淡出或释放 lease。
      // > 对超过 2 秒的真实回复，gesture 可能先播完，然后保持末帧直到音频结束。
      //
      // 修复：当 looping=false 且播放时间到达 animationDurationSec 时，
      // 自动进入 fade-out（不切换到新 pack，只 stop + 释放 lease）。
      // fade-out 完成后 performStopCleanup() 释放 lease，
      // RelaxedBasePose + ProceduralLifeController 自动接管（它们每帧检查 ownership）。
      // 音频仍继续播放（由 desktop-avatar-renderer 管理，不受 MotionPlayer 影响）。
      // 音频真正结束后才由 stopPerformance('ended') 回 idle pack。
      if (!this.looping && this.animationDurationSec > 0) {
        const elapsed = now - this.animationStartedAt;
        if (elapsed >= this.animationDurationSec) {
          if (this.naturalEndHandoffPending) return;
          const naturalEnd = this.onNaturalEndCallback;
          if (!this.naturalEndNotified && naturalEnd) {
            this.naturalEndNotified = true;
            this.naturalEndHandoffPending = true;
            this.onNaturalEndCallback = null;
            try { naturalEnd(); } catch (e) {
              console.warn('[MotionPlayer] natural-end callback failed:', e);
            }
            // Keep the authored last pose until the replacement clip binds.
            // The renderer starts the user-selected idle immediately; avoiding
            // clearAnimation here removes the PMX-rest/T-pose gap.
            return;
          }
          // gesture 已播完，启动 fade-out + pendingStop（不切换到新 pack）
          this.pendingStopAfterFadeOut = true;
          this.pendingSwitchPackId = null;
          this.pendingSwitchBytes = null;
          this.pendingSwitchToken = null;
          this.pendingSwitchOptions = null;
          this.startFadeOut(this.fadeConfig.fadeOutSeconds);
        }
      }
    }
    this.applyGroundedRecoveryOverlay(now);
    // VMD already provides authored interpolation, but clips from different
    // exporters can still expose a hard per-frame angular step. Apply a
    // small controller-only inertial filter after the sample and before the
    // rest of the avatar life layer. This keeps shoulder→elbow→wrist motion
    // continuous without touching Bullet-owned hair/cloth or root/IK
    // translations (the two common causes of skating and ribbon jitter).
    this.applySoftMotionSmoothing(now);
    this.captureRenderedTransitionPoses();
    // state='playing' 的循环动画不做 fade 插值，VMD-sampled pose 直接生效
  }

  /**
   * Softens authored controller rotations while preserving VMD timing.
   *
   * The filter is intentionally short (roughly 50–70 ms response) and
   * adaptive: large changes get a little more response so a gesture does not
   * lag behind speech, while small changes retain a gentle follow-through.
   * Only local rotations are filtered. Positions remain exactly as sampled,
   * so the model cannot acquire a delayed root/center translation or foot
   * sliding. Dynamic bones are excluded by the existing physics filter.
   */
  private applySoftMotionSmoothing(now: number): void {
    if (this.state !== 'playing' || this.currentVmdBoneNames.size === 0 || !this.currentPackId) {
      if (this.state === 'idle') {
        this.softenedPoseSnapshots.clear();
        this.softenedPackId = null;
        this.softenedLastSampleAt = 0;
      }
      return;
    }

    if (this.softenedPackId !== this.currentPackId) {
      this.softenedPoseSnapshots.clear();
      this.softenedPackId = this.currentPackId;
      this.softenedLastSampleAt = now;
    }

    const delta = this.softenedLastSampleAt > 0
      ? THREE.MathUtils.clamp(now - this.softenedLastSampleAt, 1 / 120, 0.05)
      : 1 / 60;
    // A 55 ms time constant is enough to remove one-frame exporter steps
    // without making an audio-bound gesture visibly trail the spoken line.
    const baseResponse = 1 - Math.exp(-delta / 0.055);
    this.softenedLastSampleAt = now;

    for (const boneName of this.currentVmdBoneNames) {
      if (this.dynamicBoneFilter.has(boneName) || !isSoftMotionBone(boneName)) continue;
      const bone = this.findBoneByName(boneName);
      if (!bone) continue;

      const target = new THREE.Quaternion(
        bone.quaternion.x,
        bone.quaternion.y,
        bone.quaternion.z,
        bone.quaternion.w
      ).normalize();
      const previous = this.softenedPoseSnapshots.get(boneName);
      if (!previous) {
        this.softenedPoseSnapshots.set(boneName, {
          boneName,
          quaternion: { x: target.x, y: target.y, z: target.z, w: target.w },
          position: { x: bone.position.x, y: bone.position.y, z: bone.position.z }
        });
        continue;
      }

      const filtered = new THREE.Quaternion(
        previous.quaternion.x,
        previous.quaternion.y,
        previous.quaternion.z,
        previous.quaternion.w
      ).normalize();
      const angle = filtered.angleTo(target);
      // Distal joints follow the proximal chain just a fraction later. This
      // tiny difference creates a natural elbow/wrist arc instead of making
      // the entire arm rotate as one rigid plate.
      const distal = /(?:ひじ|手捩|手首|肘|elbow|wrist)/iu.test(boneName);
      const response = THREE.MathUtils.clamp(
        baseResponse * (distal ? 0.9 : 1) + (angle > 0.55 ? 0.1 : 0),
        0.2,
        0.62
      );
      filtered.slerp(target, response).normalize();
      bone.quaternion.x = filtered.x;
      bone.quaternion.y = filtered.y;
      bone.quaternion.z = filtered.z;
      bone.quaternion.w = filtered.w;
      // Keep the exact sampled local position. In particular, do not
      // inertialize center/waist/IK translation or physics parent offsets.
      this.softenedPoseSnapshots.set(boneName, {
        boneName,
        quaternion: { x: filtered.x, y: filtered.y, z: filtered.z, w: filtered.w },
        position: { x: bone.position.x, y: bone.position.y, z: bone.position.z }
      });
    }
  }

  /**
   * Applies local-space inertial offsets after the new VMD sample is available.
   * Root/center/lower-body/leg/IK channels are excluded by the allowlist, so
   * this method cannot introduce root motion or foot sliding.
   */
  private applyInertialTransitionOverlay(now: number, durationSeconds: number): void {
    const delta = Math.min(0.05, Math.max(0, now - this.inertialLastSampleAt));
    this.inertialLastSampleAt = now;
    const safeDuration = Math.max(0.15, durationSeconds);

    if (!this.inertialOverlayStarted) {
      for (const [boneName, source] of this.inertialSourceSnapshots) {
        if (!isInertialTransitionBone(boneName)) continue;
        const bone = this.findBoneByName(boneName);
        if (!bone) continue;
        const inertializer = new PoseInertializer();
        const previous = this.previousRenderedSnapshots.get(boneName) ?? source;
        inertializer.begin(
          this.snapshotToLocalPose(source),
          this.snapshotToLocalPose(previous),
          this.boneToLocalPose(bone),
          Math.max(1 / 120, delta),
          safeDuration,
          { allowTranslation: shouldInertializeTranslation(boneName) }
        );
        if (inertializer.active) this.inertializers.set(boneName, inertializer);
      }
      this.inertialOverlayStarted = true;
    }

    for (const [boneName, inertializer] of this.inertializers) {
      const bone = this.findBoneByName(boneName);
      if (!bone) continue;
      const pose = inertializer.sample(this.boneToLocalPose(bone), delta);
      bone.quaternion.x = pose.quaternion[0];
      bone.quaternion.y = pose.quaternion[1];
      bone.quaternion.z = pose.quaternion[2];
      bone.quaternion.w = pose.quaternion[3];
      // Translation blending is disabled by PoseInertializer unless a future
      // per-bone safety profile opts in, but preserve its returned target value.
      bone.position.x = pose.position[0];
      bone.position.y = pose.position[1];
      bone.position.z = pose.position[2];
      if (!inertializer.active) this.inertializers.delete(boneName);
    }
  }

  private finishNativeBridge(now: number): void {
    const target = this.nativeBridgeTarget;
    if (!target) {
      this.state = 'playing';
      return;
    }

    const groundedSnapshots = target.groundedRecovery
      ? this.snapshotBones([...this.currentVmdBoneNames].filter(name => SPEECH_LOWER_BODY_TRANSITION_BONE.test(name)))
      : [];
    const targetLoaded = target.groundedRecovery
      ? stripSpeechRecoveryHoldTracks(target.loaded)
      : target.loaded;
    // Lower-body holds belong to the bridge only.  Once it finishes, let the
    // grounded/base layer own those bones so applyGroundedRecoveryOverlay can
    // ease from the captured bridge pose instead of blending back to the same
    // held (and potentially crossed) IK pose forever.
    const targetBoneNames = new Set(
      target.groundedRecovery ? extractBoneNames(targetLoaded) : target.boneNames
    );

    const retainedLeases: OwnershipLease[] = [];
    for (const lease of this.boneLeases) {
      if (targetBoneNames.has(lease.boneName)) retainedLeases.push(lease);
      else this.boneRegistry.release(lease);
    }
    this.boneLeases = retainedLeases;

    const targetAnimation = target.groundedRecovery
      ? { ...target.animation, bytes: new Uint8Array(), boneTracks: targetLoaded.boneTracks }
      : target.animation;
    this.bindAnimationAtStart(targetAnimation);
    this.currentAnimation = targetAnimation;
    this.currentLoadedVmd = targetLoaded;
    this.currentVmdBoneNames = targetBoneNames;
    this.currentCompositionMode = target.compositionMode;
    this.animationDurationSec = target.durationSeconds;
    this.playbackRate = target.playbackRate;
    this.animationStartedAt = now - target.startOffsetSeconds;
    this.currentTimeSource = target.timeSource;
    this.looping = target.looping;
    this.lastObservedLoopCycle = 0;
    this.nativeBridgeTarget = null;
    this.inertialSourceSnapshots.clear();
    this.inertializers.clear();
    this.inertialOverlayStarted = false;
    this.state = 'playing';
    this.groundedRecoverySnapshots = groundedSnapshots;
    this.groundedRecoveryStartedAt = now;
  }

  private applyGroundedRecoveryOverlay(now: number): void {
    if (this.groundedRecoverySnapshots.length === 0) return;
    const elapsed = Math.max(0, now - this.groundedRecoveryStartedAt);
    const holdSeconds = 0.22;
    const fadeSeconds = Math.max(0.2, this.groundedRecoveryDuration - holdSeconds);
    const alpha = elapsed <= holdSeconds
      ? 0
      : Math.min(1, (elapsed - holdSeconds) / fadeSeconds);
    for (const snapshot of this.groundedRecoverySnapshots) {
      const bone = this.findBoneByName(snapshot.boneName);
      if (!bone) continue;
      // The native bridge already performs the one allowed lower-body
      // rotation.  A second post-bridge write races MMD IK and can bend both
      // knees or shift the model at the last frame, so leave the entire
      // grounded chain untouched here.  This deliberately prefers no extra
      // leg handoff over a visually unsafe correction.
      if (SPEECH_LOWER_BODY_TRANSITION_BONE.test(snapshot.boneName)) continue;
      const rotationOnly = false;
      if (alpha <= 0) {
        if (!rotationOnly) {
          bone.position.x = snapshot.position.x;
          bone.position.y = snapshot.position.y;
          bone.position.z = snapshot.position.z;
        }
        bone.quaternion.x = snapshot.quaternion.x;
        bone.quaternion.y = snapshot.quaternion.y;
        bone.quaternion.z = snapshot.quaternion.z;
        bone.quaternion.w = snapshot.quaternion.w;
        continue;
      }
      const targetQuaternion = new THREE.Quaternion(
        bone.quaternion.x,
        bone.quaternion.y,
        bone.quaternion.z,
        bone.quaternion.w
      );
      const sourceQuaternion = new THREE.Quaternion(
        snapshot.quaternion.x,
        snapshot.quaternion.y,
        snapshot.quaternion.z,
        snapshot.quaternion.w
      );
      sourceQuaternion.slerp(targetQuaternion, alpha);
      bone.quaternion.x = sourceQuaternion.x;
      bone.quaternion.y = sourceQuaternion.y;
      bone.quaternion.z = sourceQuaternion.z;
      bone.quaternion.w = sourceQuaternion.w;
      if (!rotationOnly) {
        bone.position.x = snapshot.position.x + (bone.position.x - snapshot.position.x) * alpha;
        bone.position.y = snapshot.position.y + (bone.position.y - snapshot.position.y) * alpha;
        bone.position.z = snapshot.position.z + (bone.position.z - snapshot.position.z) * alpha;
      }
    }
    if (alpha >= 1) this.groundedRecoverySnapshots = [];
  }

  /**
   * Recovery targets are bound immediately after the native bridge. The
   * rendered bridge endpoint is authoritative for the first target key: align
   * every lower-body track to that local pose, then preserve the authored
   * relative translation/rotation changes that follow. This prevents the
   * selected idle from reintroducing a one-frame leg translation or IK snap.
   */
  private rebaseStaticGroundedTracksAtBridgeFinish(loaded: LoadedVmd): LoadedVmd {
    let changed = false;
    const boneTracks: Record<string, VmdBoneTrack> = { ...loaded.boneTracks };
    for (const [boneName, track] of Object.entries(loaded.boneTracks)) {
      if (!SPEECH_LOWER_BODY_TRANSITION_BONE.test(boneName)
        || track.frames.length === 0
        || track.translations.length < 3
        || track.rotations.length < 4) continue;
      const currentPose = this.captureCurrentVmdPose(boneName);
      const translations = new Float32Array(track.translations.length);
      const rotations = new Float32Array(track.rotations.length);
      const firstTranslation = track.translations.slice(0, 3);
      const anchorQuaternion = new THREE.Quaternion(...currentPose.rotation).normalize();
      const firstQuaternion = new THREE.Quaternion(
        track.rotations[0] ?? 0,
        track.rotations[1] ?? 0,
        track.rotations[2] ?? 0,
        track.rotations[3] ?? 1
      ).normalize();
      const relativeFromFirst = firstQuaternion.clone().invert();
      for (let index = 0; index < translations.length; index += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          translations[index + axis] = currentPose.translation[axis]
            + (track.translations[index + axis] - firstTranslation[axis]);
        }
        const authored = new THREE.Quaternion(
          track.rotations[index / 3 * 4] ?? 0,
          track.rotations[index / 3 * 4 + 1] ?? 0,
          track.rotations[index / 3 * 4 + 2] ?? 0,
          track.rotations[index / 3 * 4 + 3] ?? 1
        ).normalize();
        const rotation = anchorQuaternion.clone()
          .multiply(relativeFromFirst)
          .multiply(authored)
          .normalize();
        rotations.set([rotation.x, rotation.y, rotation.z, rotation.w], index / 3 * 4);
      }
      boneTracks[boneName] = { ...track, translations, rotations };
      changed = true;
    }
    if (!changed) return loaded;
    const animation = {
      ...loaded.animation,
      bytes: new Uint8Array(),
      boneTracks
    };
    return { ...loaded, animation, boneTracks };
  }

  /**
   * three-mmd-loader 的 setAnimation() 会立即按 runtime 当前帧采样新 clip。
   * 切换时若保留旧动画时钟，新 clip 会先闪到中后段，再在下一帧回到 0 秒。
   */
  private bindAnimationAtStart(animation: MmdAnimation): void {
    // parsed-track runtime captures the current skeleton as its translation
    // rest basis. Restore the loader's stable PMX rest first, otherwise every
    // clip switch adds its translations on top of the preceding clip.
    // resetPose/setAnimation rewrite the complete skeleton. Preserve the
    // visible local pose so neither collider parents nor Bullet-owned dynamic
    // children expose a PMX-rest frame between the bridge and its target.
    const visibleSnapshots = this.snapshotBones(
      (this.model.mesh.skeleton?.bones ?? []).map(bone => this.resolveBoneKey(bone))
    );
    try {
      this.model.runtime.resetPose?.();
      this.model.runtime.seek?.(0);
      this.model.setAnimation(animation);
    } finally {
      this.restoreBoneSnapshots(visibleSnapshots);
    }
  }

  /**
   * Smooth a VMD's own tail-to-head discontinuity.  The runtime still receives
   * its monotonic time, keeping Bullet stable; only allowed local upper-body
   * rotations receive a short inertial offset after the new loop sample exists.
   */
  private beginLoopBridge(now: number): boolean {
    if (!this.looping || this.animationDurationSec <= 0 || this.currentVmdBoneNames.size === 0) return false;
    const cycle = getLoopCycle(now - this.animationStartedAt, this.animationDurationSec);
    if (cycle <= this.lastObservedLoopCycle) return false;
    this.lastObservedLoopCycle = cycle;

    const sources = new Map<string, BoneRestPoseSnapshot>();
    for (const boneName of this.currentVmdBoneNames) {
      const previous = this.previousRenderedSnapshots.get(boneName);
      if (previous) sources.set(boneName, previous);
    }
    if (sources.size === 0) return false;

    this.inertialSourceSnapshots = sources;
    this.inertializers.clear();
    this.inertialOverlayStarted = false;
    this.inertialLastSampleAt = now;
    this.applyInertialTransitionOverlay(now, this.transitionDuration(0.18));
    return true;
  }

  private captureRenderedTransitionPoses(): void {
    for (const snapshot of this.snapshotBones(this.getCurrentBoneNames())) {
      this.previousRenderedSnapshots.set(snapshot.boneName, snapshot);
    }
  }

  private snapshotToLocalPose(snapshot: BoneRestPoseSnapshot): LocalBonePose {
    return {
      quaternion: [snapshot.quaternion.x, snapshot.quaternion.y, snapshot.quaternion.z, snapshot.quaternion.w],
      position: [snapshot.position.x, snapshot.position.y, snapshot.position.z]
    };
  }

  private boneToLocalPose(bone: { quaternion: { x: number; y: number; z: number; w: number }; position: { x: number; y: number; z: number } }): LocalBonePose {
    return {
      quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      position: [bone.position.x, bone.position.y, bone.position.z]
    };
  }

  /** True while a generated local-pose bridge is settling into a VMD sample. */
  isInertializing(): boolean {
    return this.state === 'bridging' || this.state === 'fading-in' || this.inertializers.size > 0;
  }

  /**
   * Fade-in 插值：lerp(restPose, currentBonePose, t)
   * currentBonePose 是 model.update() 后 bones 的值（VMD-sampled）。
   * restPose 来自 restPoseSnapshots。
   *
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正：使用 findBoneByName 查找骨骼，
   * 因为 snap.boneName 是日文名（来自 VMD），而 bone.name 可能是英文名。
   */
  private applyBoneBlend(restSnapshots: readonly BoneRestPoseSnapshot[], t: number): void {
    for (const snap of restSnapshots) {
      const bone = this.findBoneByName(snap.boneName);
      if (!bone) continue;
      // slerp quaternion: rest → current VMD-sampled, weight t
      const currentQ = bone.quaternion;
      const restQ = snap.quaternion;
      this.slerpQuaternionToBone(bone, restQ, currentQ, t);
      // lerp position: rest → current VMD-sampled, weight t
      const currentP = bone.position;
      bone.position.x = snap.position.x + (currentP.x - snap.position.x) * t;
      bone.position.y = snap.position.y + (currentP.y - snap.position.y) * t;
      bone.position.z = snap.position.z + (currentP.z - snap.position.z) * t;
    }
  }

  /**
   * Fade-out 插值：lerp(currentBonePose, restPose, t)
   * currentBonePose 是 model.update() 后 bones 的值（VMD-sampled）。
   * restPose 来自 restSnapshots。
   *
   * Phase 5.2B.3 Closeout Task 3 Step 4 修正：使用 findBoneByName 查找骨骼。
   */
  private applyBoneBlendToRest(restSnapshots: readonly BoneRestPoseSnapshot[], t: number): void {
    for (const snap of restSnapshots) {
      const bone = this.findBoneByName(snap.boneName);
      if (!bone) continue;
      const currentQ = bone.quaternion;
      const restQ = snap.quaternion;
      // slerp: current → rest, weight t
      this.slerpQuaternionToBone(bone, currentQ, restQ, t);
      // lerp position
      const currentP = bone.position;
      bone.position.x = currentP.x + (snap.position.x - currentP.x) * t;
      bone.position.y = currentP.y + (snap.position.y - currentP.y) * t;
      bone.position.z = currentP.z + (snap.position.z - currentP.z) * t;
    }
  }

  /**
   * 将 slerp(q1, q2, t) 结果写入 bone.quaternion。
   * 使用 THREE.Quaternion.slerp 的实现（避免依赖 THREE 运行时）。
   */
  private slerpQuaternionToBone(
    bone: { quaternion: { x: number; y: number; z: number; w: number } },
    q1: { x: number; y: number; z: number; w: number },
    q2: { x: number; y: number; z: number; w: number },
    t: number
  ): void {
    // 标准 slerp 实现
    let ax = q1.x, ay = q1.y, az = q1.z, aw = q1.w;
    let bx = q2.x, by = q2.y, bz = q2.z, bw = q2.w;
    let cosOmega = aw * bw + ax * bx + ay * by + az * bz;
    if (cosOmega < 0) {
      bx = -bx; by = -by; bz = -bz; bw = -bw;
      cosOmega = -cosOmega;
    }
    let scale0, scale1;
    if (cosOmega > 0.9999) {
      // 线性插值
      scale0 = 1 - t;
      scale1 = t;
    } else {
      const omega = Math.acos(cosOmega);
      const sinOmega = Math.sqrt(1 - cosOmega * cosOmega);
      scale0 = Math.sin((1 - t) * omega) / sinOmega;
      scale1 = Math.sin(t * omega) / sinOmega;
    }
    bone.quaternion.x = scale0 * ax + scale1 * bx;
    bone.quaternion.y = scale0 * ay + scale1 * by;
    bone.quaternion.z = scale0 * az + scale1 * bz;
    bone.quaternion.w = scale0 * aw + scale1 * bw;
  }

  /**
   * 获取当前应该传给 model.update 的动画时间（秒）。
   *
   * 循环动作使用 clip-local 时间，确保 VMD 真正回到首帧而不是停在末帧。
   * Bullet 不使用这个回绕时间：ContinuousMmdPhysicsBackend 在循环边界
   * 替换为独立的单调时间和帧 delta，避免服饰/头发重同步弹飞。
   *
   * 调用方应在 framePorts.updateModel 中使用此时间（而不是 wall-clock elapsed）。
   */
  getCurrentAnimationTime(): number {
    if (this.poseLocked) return this.lockedAnimationTime;
    const now = this.getTimeNow();
    if (this.state === 'idle') {
      const retained = this.retainedAnimationClock;
      if (!retained || retained.durationSeconds <= 0) return 0;
      const elapsed = now - retained.startedAt;
      return retained.looping
        ? elapsed % retained.durationSeconds
        : Math.min(elapsed, retained.durationSeconds);
    }
    if (this.animationDurationSec <= 0) return 0;
    const elapsed = Math.max(0, now - this.animationStartedAt);
    if (this.looping) {
      return elapsed % this.animationDurationSec;
    }
    return Math.min(elapsed, this.animationDurationSec);
  }

  /** Clip-local time passed to the MMD runtime; speech can be slower than wall-clock progress. */
  getCurrentModelUpdateTime(): number {
    if (this.state === 'idle' && this.retainedAnimationClock) {
      return this.getCurrentAnimationTime() * this.retainedAnimationClock.playbackRate;
    }
    return this.getCurrentAnimationTime() * this.playbackRate;
  }

  /** Freeze only VMD time. Physics, face, blink, gaze and lip sync keep updating. */
  setPoseLocked(locked: boolean): boolean {
    if (locked === this.poseLocked) return this.poseLocked;
    if (locked) {
      this.lockedAnimationTime = this.getCurrentAnimationTime();
      this.poseLockStartedAt = this.getTimeNow();
      this.poseLocked = true;
      return true;
    }
    const pausedFor = Math.max(0, this.getTimeNow() - this.poseLockStartedAt);
    this.animationStartedAt += pausedFor;
    this.fadeStartedAt += pausedFor;
    if (this.retainedAnimationClock) {
      this.retainedAnimationClock.startedAt += pausedFor;
    }
    this.poseLocked = false;
    this.poseLockStartedAt = 0;
    return false;
  }

  isPoseLocked(): boolean {
    return this.poseLocked;
  }

  /**
   * 是否正在播放（包括 fading-in/fading-out）。
   */
  isPlaying(): boolean {
    return this.state === 'bridging'
      || this.state === 'playing'
      || this.state === 'fading-in'
      || this.state === 'fading-out'
      || this.retainedAnimationClock !== null;
  }

  /**
   * 当前播放状态。
   */
  getState(): MotionPlayerState {
    return this.state;
  }

  /**
   * 当前播放的 packId。
   */
  getCurrentPackId(): string | null {
    return this.currentPackId;
  }

  /**
   * 当前时间源。
   */
  getCurrentTimeSource(): MotionTimeSource {
    return this.currentTimeSource;
  }

  /**
   * 当前播放的动画时长（秒）。
   */
  getAnimationDuration(): number {
    return this.animationDurationSec;
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  /**
   * 当前播放涉及的骨骼名列表。
   */
  getCurrentBoneNames(): string[] {
    if (!this.currentLoadedVmd) return [];
    return extractBoneNames(this.currentLoadedVmd);
  }

  /** Names from the bound PMX skeleton, independent of the current VMD. */
  getModelBoneNames(): string[] {
    return (this.model.mesh.skeleton?.bones ?? []).map(bone => this.resolveBoneKey(bone));
  }

  /**
   * 当前播放涉及的 morph 名列表。
   */
  getCurrentMorphNames(): string[] {
    if (!this.currentLoadedVmd) return [];
    return extractMorphNamesFromAnimation(this.currentLoadedVmd);
  }

  /**
   * 当前播放是否含 まばたき 轨道。
   */
  hasBlinkTrack(): boolean {
    if (!this.currentLoadedVmd) return false;
    return hasBlinkTrack(this.currentLoadedVmd);
  }
}

/**
 * 扩展 BoneOwnershipRegistry：批量 claim 骨骼。
 * 如果任一 claim 失败，回滚已 claim 的 lease。
 */
export function claimBonesBatch(
  registry: BoneOwnershipRegistry,
  boneNames: readonly string[],
  owner: 'vmd' | 'performance-planner'
): { success: true; leases: OwnershipLease[] } | { success: false; failedBone: string; rolledBackLeases: OwnershipLease[] } {
  const leases: OwnershipLease[] = [];
  for (const boneName of boneNames) {
    const lease = registry.claim(boneName, owner);
    if (!lease) {
      for (const l of leases) {
        registry.release(l);
      }
      return { success: false, failedBone: boneName, rolledBackLeases: leases };
    }
    leases.push(lease);
  }
  return { success: true, leases };
}
