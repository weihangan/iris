import * as THREE from 'three';
import type { VmdBoneTrack } from '@yohawing/three-mmd-loader/parser';
import type {
  SpeechStanceAccent,
  SpeechStanceProfile
} from '../performance/speech-stance-director';
import type { LoadedVmd } from './motion-pack-loader';

const RAW_DIALOGUE_LOWER_BODY_BONES = new Set([
  '全ての親', 'センター', 'グルーブ', '腰', '下半身',
  '左足', '右足', '左ひざ', '右ひざ', '左膝', '右膝',
  '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ'
]);

const RESTRAINED_DIALOGUE_SOURCE_BONES = new Set([
  '下半身', '左足', '右足', '左ひざ', '右ひざ', '左膝', '右膝'
]);

export const SPEECH_STANCE_SOURCE_RETENTION = 0.85;
export const SPEECH_BACKGROUND_STANCE_SOURCE_RETENTION = 1;

export function isRestrainedDialogueSourceBone(boneName: string): boolean {
  return RESTRAINED_DIALOGUE_SOURCE_BONES.has(boneName);
}

function rotationQuaternion(pitchDegrees: number, rollDegrees: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(pitchDegrees),
    0,
    THREE.MathUtils.degToRad(rollDegrees),
    'XYZ'
  )).normalize();
}

function createEaseInOutInterpolations(frameCount: number): Float32Array {
  const values = new Float32Array(frameCount * 16);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = frameIndex * 16 + channel * 4;
      values[offset] = 0.25;
      values[offset + 1] = 0;
      values[offset + 2] = 0.75;
      values[offset + 3] = 1;
    }
  }
  return values;
}

function createRotationTrack(
  frames: Uint32Array,
  samples: ReadonlyArray<readonly [number, number]>
): VmdBoneTrack {
  const rotations = new Float32Array(samples.length * 4);
  samples.forEach(([pitchDegrees, rollDegrees], index) => {
    const quaternion = rotationQuaternion(pitchDegrees, rollDegrees);
    rotations.set([quaternion.x, quaternion.y, quaternion.z, quaternion.w], index * 4);
  });
  const physicsToggles = new Int8Array(samples.length);
  physicsToggles.fill(-1);
  return {
    packed: 'bone',
    frames,
    translations: new Float32Array(samples.length * 3),
    rotations,
    interpolations: createEaseInOutInterpolations(samples.length),
    physicsToggles
  };
}

function accentDelta(
  boneName: string,
  accent: SpeechStanceAccent
): readonly [number, number] {
  const weight = Math.min(1, Math.max(0, accent.intensity));
  const values: Record<SpeechStanceAccent['kind'], Record<string, readonly [number, number]>> = {
    'weight-left': {
      '下半身': [0.12, 2.2],
      '左足': [-0.9, 0],
      '右足': [1.2, 0],
      '左ひざ': [0.8, 0],
      '右ひざ': [1.8, 0]
    },
    'weight-right': {
      '下半身': [0.12, -2.2],
      '左足': [1.2, 0],
      '右足': [-0.9, 0],
      '左ひざ': [1.8, 0],
      '右ひざ': [0.8, 0]
    },
    'soft-knee': {
      '下半身': [1.2, 0],
      '左足': [-0.8, 0],
      '右足': [-0.8, 0],
      '左ひざ': [1.6, 0],
      '右ひざ': [1.6, 0]
    }
  };
  const [pitch, roll] = values[accent.kind][boneName] ?? [0, 0];
  return [pitch * weight, roll * weight];
}

function clampRotation(boneName: string, pitch: number, roll: number): readonly [number, number] {
  if (boneName === '下半身') {
    return [THREE.MathUtils.clamp(pitch, -3.2, 3.2), THREE.MathUtils.clamp(roll, -3.2, 3.2)];
  }
  if (boneName === '左足' || boneName === '右足') {
    return [THREE.MathUtils.clamp(pitch, -1.6, 1.6), 0];
  }
  return [THREE.MathUtils.clamp(pitch, -2.8, 2.8), 0];
}

function balanceDelta(boneName: string, direction: 1 | -1): readonly [number, number] {
  const values: Record<string, readonly [number, number]> = {
    '下半身': [0.25, 1.05 * direction],
    '左足': [0.7 * direction, 0],
    '右足': [-0.65 * direction, 0],
    '左ひざ': [direction > 0 ? 1.25 : 0.55, 0],
    '右ひざ': [direction > 0 ? 0.55 : 1.25, 0]
  };
  return values[boneName] ?? [0, 0];
}

function restrainedSourceTrack(
  source: VmdBoneTrack,
  boneName: string,
  base: readonly [number, number],
  accent?: SpeechStanceAccent,
  sourceRetention = SPEECH_STANCE_SOURCE_RETENTION
): VmdBoneTrack | null {
  if (source.frames.length < 2) return null;
  const rotations = new Float32Array(source.frames.length * 4);
  const translations = new Float32Array(source.frames.length * 3);
  const identity = new THREE.Quaternion();
  const baseRotation = rotationQuaternion(base[0], base[1]);
  const firstFrame = source.frames[0];
  const lastFrame = source.frames[source.frames.length - 1];
  const frameSpan = Math.max(1, lastFrame - firstFrame);
  const maxDegrees = boneName === '下半身' ? 13 : boneName.includes('ひざ') || boneName.includes('膝') ? 12 : 10;
  const maxRadians = THREE.MathUtils.degToRad(maxDegrees);
  const retention = THREE.MathUtils.clamp(sourceRetention, 0, 1);

  for (let index = 0; index < source.frames.length; index += 1) {
    const progress = (source.frames[index] - firstFrame) / frameSpan;
    const envelope = Math.sin(Math.PI * THREE.MathUtils.clamp(progress, 0, 1));
    const offset = index * 4;
    const authored = new THREE.Quaternion(
      source.rotations[offset],
      source.rotations[offset + 1],
      source.rotations[offset + 2],
      source.rotations[offset + 3]
    ).normalize();
    const authoredDelta = identity.clone().slerp(authored, retention * envelope);
    const result = baseRotation.clone().multiply(authoredDelta);
    if (accent) {
      const delta = accentDelta(boneName, accent);
      result.multiply(rotationQuaternion(delta[0] * envelope, delta[1] * envelope));
    }
    const angle = identity.angleTo(result);
    if (angle > maxRadians) identity.clone().slerp(result, maxRadians / angle).toArray(rotations, offset);
    else result.toArray(rotations, offset);
  }

  return {
    packed: 'bone',
    frames: source.frames.slice(),
    translations,
    rotations,
    interpolations: source.interpolations.slice(),
    physicsToggles: source.physicsToggles.slice()
  };
}

/**
 * Replaces source lower-body motion with one reply-owned grounded stance.
 * Callers invoke this only for performance-clock speech. The source LoadedVmd
 * and original VMD bytes remain unchanged.
 */
export function applySpeechStanceTracks(
  loaded: LoadedVmd,
  profile: SpeechStanceProfile,
  intensity: number,
  modelBoneNames: ReadonlySet<string>,
  accent?: SpeechStanceAccent,
  sourceRetention = SPEECH_STANCE_SOURCE_RETENTION
): LoadedVmd {
  const boneTracks = Object.fromEntries(
    Object.entries(loaded.boneTracks)
      .filter(([name]) => !RAW_DIALOGUE_LOWER_BODY_BONES.has(name))
  ) as Record<string, VmdBoneTrack>;
  const scale = 0.55 + 0.45 * Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.5));
  const candidates: ReadonlyArray<readonly [string, number, number]> = [
    ['下半身', profile.pelvisPitchDegrees, profile.pelvisRollDegrees],
    ['左足', profile.leftLegPitchDegrees, 0],
    ['右足', profile.rightLegPitchDegrees, 0],
    ['左ひざ', profile.leftKneePitchDegrees, 0],
    ['右ひざ', profile.rightKneePitchDegrees, 0]
  ];
  const sourceMaxFrame = Math.max(0, Math.round(loaded.animation.metadata.maxFrame ?? 0));
  const accentEndFrame = Math.max(4, sourceMaxFrame);
  const enterFrame = Math.max(1, Math.round(accentEndFrame * 0.35));
  const peakFrame = Math.max(enterFrame + 1, Math.round(accentEndFrame * 0.5));
  const releaseFrame = Math.max(peakFrame + 1, Math.round(accentEndFrame * 0.76));
  const curveFrames = new Uint32Array([0, enterFrame, peakFrame, releaseFrame, accentEndFrame]);
  for (const [boneName, pitchDegrees, rollDegrees] of candidates) {
    if (!modelBoneNames.has(boneName)) continue;
    const base = clampRotation(boneName, pitchDegrees * scale, rollDegrees * scale);
    const sourceTrack = loaded.boneTracks[boneName];
    if (sourceTrack) {
      const restrained = restrainedSourceTrack(sourceTrack, boneName, base, accent, sourceRetention);
      if (restrained) {
        boneTracks[boneName] = restrained;
        continue;
      }
    }
    const primary = accent
      ? accentDelta(boneName, accent)
      : balanceDelta(boneName, 1);
    const secondary = accent
      ? [primary[0] * 0.45, primary[1] * -0.35] as const
      : balanceDelta(boneName, -1);
    const primaryPeak = clampRotation(boneName, base[0] + primary[0], base[1] + primary[1]);
    const secondaryPeak = clampRotation(boneName, base[0] + secondary[0], base[1] + secondary[1]);
    boneTracks[boneName] = createRotationTrack(
      curveFrames,
      [base, primaryPeak, primaryPeak, secondaryPeak, base]
    );
  }

  const boneFrameCount = Object.values(boneTracks)
    .reduce((count, track) => count + track.frames.length, 0);
  return {
    bytes: loaded.bytes,
    animation: {
      ...loaded.animation,
      // Safety changes must execute from parsed tracks. Keeping source bytes
      // would allow the WASM path to restore stripped locomotion channels.
      bytes: new Uint8Array(),
      metadata: {
        ...loaded.animation.metadata,
        maxFrame: accentEndFrame,
        counts: {
          ...loaded.animation.metadata.counts,
          bones: boneFrameCount
        }
      },
      boneTracks
    },
    boneTracks,
    morphTracks: { ...loaded.morphTracks }
  };
}
