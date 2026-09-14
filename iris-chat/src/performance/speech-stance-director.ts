export type SpeechStanceId =
  | 'neutral-balanced'
  | 'warm-left'
  | 'warm-right'
  | 'earnest-forward';

export type DialogueMovementClass =
  | 'in-place-accent'
  | 'step-and-return'
  | 'walk'
  | 'run'
  | 'multi-step'
  | 'jump'
  | 'unknown';

export interface SpeechStanceProfile {
  readonly id: SpeechStanceId;
  readonly pelvisPitchDegrees: number;
  readonly pelvisRollDegrees: number;
  readonly leftLegPitchDegrees: number;
  readonly rightLegPitchDegrees: number;
  readonly leftKneePitchDegrees: number;
  readonly rightKneePitchDegrees: number;
}

export interface SpeechStanceSelection {
  readonly replyId: string;
  readonly profile: SpeechStanceProfile;
  readonly intensity: number;
}

export type SpeechStanceAccentKind = 'weight-left' | 'weight-right' | 'soft-knee';

export interface SpeechStanceAccent {
  readonly kind: SpeechStanceAccentKind;
  readonly intensity: number;
}

export interface SpeechStanceCue {
  readonly index: number;
  readonly isOpening: boolean;
  readonly isClosing: boolean;
  readonly gestureEligible: boolean;
  readonly emotion: string;
  readonly intensity: number;
}

const PROFILES: Readonly<Record<SpeechStanceId, SpeechStanceProfile>> = {
  'neutral-balanced': {
    id: 'neutral-balanced',
    pelvisPitchDegrees: 1.05,
    pelvisRollDegrees: 0,
    leftLegPitchDegrees: -0.8,
    rightLegPitchDegrees: -0.7,
    leftKneePitchDegrees: 1.7,
    rightKneePitchDegrees: 1.55
  },
  'warm-left': {
    id: 'warm-left',
    pelvisPitchDegrees: 1.1,
    pelvisRollDegrees: 1.9,
    leftLegPitchDegrees: -0.9,
    rightLegPitchDegrees: 0.75,
    leftKneePitchDegrees: 1.4,
    rightKneePitchDegrees: 2.2
  },
  'warm-right': {
    id: 'warm-right',
    pelvisPitchDegrees: 1.1,
    pelvisRollDegrees: -1.9,
    leftLegPitchDegrees: 0.75,
    rightLegPitchDegrees: -0.9,
    leftKneePitchDegrees: 2.2,
    rightKneePitchDegrees: 1.4
  },
  'earnest-forward': {
    id: 'earnest-forward',
    pelvisPitchDegrees: 2.1,
    pelvisRollDegrees: 0,
    leftLegPitchDegrees: -1.1,
    rightLegPitchDegrees: -1.1,
    leftKneePitchDegrees: 2.4,
    rightKneePitchDegrees: 2.4
  }
};

function stableParity(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 1;
}

function selectProfile(replyId: string, emotion: string): SpeechStanceProfile {
  const semantic = emotion.trim().toLowerCase();
  if (['serious', 'angry', 'determined', 'excited'].includes(semantic)) {
    return PROFILES['earnest-forward'];
  }
  if (['happy', 'gentle', 'loving', 'grateful', 'shy', 'concerned', 'thinking', 'sad'].includes(semantic)) {
    return stableParity(replyId) === 0 ? PROFILES['warm-left'] : PROFILES['warm-right'];
  }
  return PROFILES['neutral-balanced'];
}

function scaleProfile(profile: SpeechStanceProfile, intensity: number): SpeechStanceProfile {
  const scale = 0.65 + intensity * 0.35;
  return {
    ...profile,
    pelvisPitchDegrees: profile.pelvisPitchDegrees * scale,
    pelvisRollDegrees: profile.pelvisRollDegrees * scale,
    leftLegPitchDegrees: profile.leftLegPitchDegrees * scale,
    rightLegPitchDegrees: profile.rightLegPitchDegrees * scale,
    leftKneePitchDegrees: profile.leftKneePitchDegrees * scale,
    rightKneePitchDegrees: profile.rightKneePitchDegrees * scale
  };
}

export class SpeechStanceDirector {
  private active: SpeechStanceSelection | null = null;
  private lowerBodyAccentClaimed = false;
  private scheduledAccentCount = 0;
  private lastAccentCueIndex = Number.NEGATIVE_INFINITY;

  beginReply(replyId: string, emotion: string, intensity: number): SpeechStanceSelection {
    if (this.active?.replyId === replyId) return this.active;
    const boundedIntensity = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.5));
    this.active = {
      replyId,
      profile: scaleProfile(selectProfile(replyId, emotion), boundedIntensity),
      intensity: boundedIntensity
    };
    this.lowerBodyAccentClaimed = false;
    this.scheduledAccentCount = 0;
    this.lastAccentCueIndex = Number.NEGATIVE_INFINITY;
    return this.active;
  }

  /**
   * Selects a small, generated balance accent for an actual speech gesture.
   * Raw VMD leg, center, root and foot-IK tracks remain prohibited.
   */
  selectAccent(
    cue: SpeechStanceCue,
    cueCount: number,
    replyDurationSeconds: number
  ): SpeechStanceAccent | null {
    if (!this.active || !cue.gestureEligible || cue.isOpening || cue.isClosing) return null;
    const duration = Number.isFinite(replyDurationSeconds) ? Math.max(0, replyDurationSeconds) : 0;
    const count = Number.isFinite(cueCount) ? Math.max(0, Math.trunc(cueCount)) : 0;
    if (duration < 7 || count < 3) return null;

    const emotion = String(cue.emotion ?? '').trim().toLowerCase();
    const intensity = Math.min(1, Math.max(0, Number.isFinite(cue.intensity) ? cue.intensity : 0.5));
    const calm = ['neutral', 'gentle', 'loving', 'concerned'].includes(emotion) && intensity <= 0.5;
    // Long calm replies still need one visible balance change. Keep it near the
    // middle so the opening and closing poses remain stable.
    if (calm && (duration < 10 || count < 4 || cue.index < Math.floor(count / 2))) return null;

    const maxAccents = calm ? 1 : (duration >= 18 && count >= 5 ? 2 : 1);
    if (this.scheduledAccentCount >= maxAccents
      || cue.index - this.lastAccentCueIndex <= 1) return null;

    const expressive = ['serious', 'angry', 'determined', 'excited', 'surprised'].includes(emotion);
    const side = stableParity(`${this.active.replyId}:${this.scheduledAccentCount}`) === 0
      ? 'weight-left'
      : 'weight-right';
    const kind: SpeechStanceAccentKind = expressive && this.scheduledAccentCount === 0
      ? 'soft-knee'
      : side;
    this.scheduledAccentCount += 1;
    this.lastAccentCueIndex = cue.index;
    return {
      kind,
      intensity: Math.min(0.85, Math.max(0.45, 0.35 + intensity * 0.55))
    };
  }

  claimLowerBodyAccent(movement: DialogueMovementClass): boolean {
    if (!this.active || this.lowerBodyAccentClaimed) return false;
    if (movement !== 'in-place-accent' && movement !== 'step-and-return') return false;
    this.lowerBodyAccentClaimed = true;
    return true;
  }

  getActiveSelection(): SpeechStanceSelection | null {
    return this.active;
  }

  endReply(): void {
    this.active = null;
    this.lowerBodyAccentClaimed = false;
    this.scheduledAccentCount = 0;
    this.lastAccentCueIndex = Number.NEGATIVE_INFINITY;
  }
}
