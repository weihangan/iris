import type { DailyMotionCandidateMetrics } from './daily-candidate-audit';

interface VmdNumericTrack {
  readonly frames?: ArrayLike<number>;
  readonly translations?: ArrayLike<number>;
  readonly rotations?: ArrayLike<number>;
}

export interface ParsedVmdForDailyAudit {
  readonly boneTracks: Readonly<Record<string, VmdNumericTrack>>;
  readonly morphTracks: Readonly<Record<string, Pick<VmdNumericTrack, 'frames'>>>;
}

const ROOT_BONE = /^(?:全ての親|グルーブ\d*|腰)$/u;
const CENTER_BONE = /^センター\d*$/u;
const TURN_BONE = /^(?:全ての親|センター\d*|グルーブ\d*|腰|下半身)$/u;
const LEG_BONE = /^(?:左|右)(?:足|ひざ|膝|足首|つま先|足ＩＫ|足IK|つま先ＩＫ|つま先IK)/u;
const KNEE_BONE = /^(?:左|右)(?:ひざ|膝)$/u;
const LEG_HELPER_BONE = /^(?:左|右).*(?:D|Ｄ|EX)$/iu;
const HEAD_BONE = /^(?:頭|首)$/u;
const SHOULDER_BONE = /^(?:左|右)肩(?:P)?$/u;

type Quaternion = readonly [number, number, number, number];

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function quaternionAt(values: ArrayLike<number> | undefined, index: number): Quaternion {
  const offset = index * 4;
  const x = finite(values?.[offset]);
  const y = finite(values?.[offset + 1]);
  const z = finite(values?.[offset + 2]);
  const w = finite(values?.[offset + 3]);
  const length = Math.hypot(x, y, z, w);
  return length > 0.000001
    ? [x / length, y / length, z / length, w / length]
    : [0, 0, 0, 1];
}

function quaternionAngleDegrees(left: Quaternion, right: Quaternion): number {
  const dot = Math.abs(
    left[0] * right[0] + left[1] * right[1]
      + left[2] * right[2] + left[3] * right[3]
  );
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

function quaternionChord(left: Quaternion, right: Quaternion): number {
  const direct = Math.hypot(
    left[0] - right[0], left[1] - right[1],
    left[2] - right[2], left[3] - right[3]
  );
  const negated = Math.hypot(
    left[0] + right[0], left[1] + right[1],
    left[2] + right[2], left[3] + right[3]
  );
  return Math.min(direct, negated);
}

function translationAt(values: ArrayLike<number> | undefined, index: number): readonly [number, number, number] {
  const offset = index * 3;
  return [finite(values?.[offset]), finite(values?.[offset + 1]), finite(values?.[offset + 2])];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function measureDailyMotionCandidate(
  animation: ParsedVmdForDailyAudit
): DailyMotionCandidateMetrics {
  let maximumFrame = 0;
  let activeBoneTrackCount = 0;
  let rootTranslationMax = 0;
  let centerTranslationMax = 0;
  let maximumTurnDegrees = 0;
  let maximumLegLift = 0;
  let maximumKneeBendDegrees = 0;
  let hasStaticLegHelper = false;
  let headEntryDegrees = 0;
  let shoulderEntryDegrees = 0;
  let maximumBoneStep = 0;
  const identity: Quaternion = [0, 0, 0, 1];

  for (const [name, track] of Object.entries(animation.boneTracks)) {
    const frameCount = track.frames?.length ?? Math.max(
      Math.floor((track.translations?.length ?? 0) / 3),
      Math.floor((track.rotations?.length ?? 0) / 4)
    );
    for (let index = 0; index < (track.frames?.length ?? 0); index += 1) {
      maximumFrame = Math.max(maximumFrame, finite(track.frames?.[index]));
    }
    if (LEG_HELPER_BONE.test(name) && frameCount <= 1) hasStaticLegHelper = true;
    if (frameCount === 0) continue;

    const firstTranslation = translationAt(track.translations, 0);
    const firstRotation = quaternionAt(track.rotations, 0);
    if (HEAD_BONE.test(name)) {
      headEntryDegrees = Math.max(headEntryDegrees, quaternionAngleDegrees(identity, firstRotation));
    }
    if (SHOULDER_BONE.test(name)) {
      shoulderEntryDegrees = Math.max(shoulderEntryDegrees, quaternionAngleDegrees(identity, firstRotation));
    }

    let previousTranslation: readonly [number, number, number] = [0, 0, 0];
    let previousRotation = identity;
    let trackIsActive = false;
    for (let index = 0; index < frameCount; index += 1) {
      const translation = translationAt(track.translations, index);
      const rotation = quaternionAt(track.rotations, index);
      const translationMagnitude = Math.hypot(...translation);
      if (translationMagnitude > 0.00001 || quaternionAngleDegrees(identity, rotation) > 0.01) {
        trackIsActive = true;
      }
      if (ROOT_BONE.test(name)) rootTranslationMax = Math.max(rootTranslationMax, translationMagnitude);
      if (CENTER_BONE.test(name)) centerTranslationMax = Math.max(centerTranslationMax, translationMagnitude);
      if (TURN_BONE.test(name)) {
        maximumTurnDegrees = Math.max(maximumTurnDegrees, quaternionAngleDegrees(identity, rotation));
      }
      if (LEG_BONE.test(name)) {
        maximumLegLift = Math.max(maximumLegLift, Math.abs(translation[1] - firstTranslation[1]));
      }
      if (KNEE_BONE.test(name)) {
        maximumKneeBendDegrees = Math.max(
          maximumKneeBendDegrees,
          quaternionAngleDegrees(firstRotation, rotation)
        );
      }
      maximumBoneStep = Math.max(
        maximumBoneStep,
        Math.hypot(
          translation[0] - previousTranslation[0],
          translation[1] - previousTranslation[1],
          translation[2] - previousTranslation[2]
        ),
        quaternionChord(previousRotation, rotation)
      );
      previousTranslation = translation;
      previousRotation = rotation;
    }
    if (trackIsActive) activeBoneTrackCount += 1;
  }

  for (const track of Object.values(animation.morphTracks)) {
    for (let index = 0; index < (track.frames?.length ?? 0); index += 1) {
      maximumFrame = Math.max(maximumFrame, finite(track.frames?.[index]));
    }
  }

  return {
    durationSeconds: round(maximumFrame / 30),
    activeBoneTrackCount,
    rootTranslationMax: round(rootTranslationMax),
    centerTranslationMax: round(centerTranslationMax),
    maximumTurnDegrees: round(maximumTurnDegrees),
    maximumLegLift: round(maximumLegLift),
    maximumKneeBendDegrees: round(maximumKneeBendDegrees),
    hasStaticLegHelper,
    headEntryDegrees: round(headEntryDegrees),
    shoulderEntryDegrees: round(shoulderEntryDegrees),
    maximumBoneStep: round(maximumBoneStep)
  };
}
