import type { Emotion } from '../actor/actor-runtime';
import { createExpressionPose, getExpressionMicroAccents } from './expression-recipes';
import {
  FACIAL_CHANNELS,
  blendFacialPoses,
  clampFacialWeight,
  createEmptyFacialPose,
  type FacialChannel,
  type FacialPose
} from './facial-pose';

export interface ExpressionSample {
  readonly emotion: Emotion;
  readonly weight: number;
  readonly blush: number;
  readonly pose: FacialPose;
  readonly microExpression?: {
    readonly id: string;
    readonly weight: number;
  };
  /** Accepted dynamic expression currently enhancing the shared recipe. */
  readonly automaticExpression?: {
    readonly id: string;
    readonly category: string;
  };
}

export interface ExpressionTimelineOptions {
  readonly fadeIn?: boolean;
  readonly fadeOut?: boolean;
  /** Stable cue/reply seed used to rotate authored micro accents. */
  readonly microExpressionSeed?: number;
}

const EMOTIONS: readonly Emotion[] = [
  'neutral', 'serious', 'happy', 'smile', 'excited', 'surprised', 'angry', 'concerned', 'sad', 'shy',
  'thinking', 'curious', 'gentle', 'grateful', 'loving', 'delighted', 'shocked', 'furious',
  'heartbroken', 'skeptical', 'embarrassed', 'explaining', 'greeting',
  'apologetic', 'confident', 'playful'
];

const MICRO_OPPOSITES: Readonly<Partial<Record<FacialChannel, readonly FacialChannel[]>>> = {
  browInnerUp: ['browDownLeft', 'browDownRight'],
  browOuterUpLeft: ['browDownLeft'],
  browOuterUpRight: ['browDownRight'],
  browDownLeft: ['browInnerUp', 'browOuterUpLeft'],
  browDownRight: ['browInnerUp', 'browOuterUpRight'],
  eyeWideLeft: ['eyeSquintLeft', 'eyeSmile', 'eyeLidClose'],
  eyeWideRight: ['eyeSquintRight', 'eyeSmile', 'eyeLidClose'],
  eyeSquintLeft: ['eyeWideLeft'],
  eyeSquintRight: ['eyeWideRight'],
  eyeSmile: ['eyeWideLeft', 'eyeWideRight'],
  eyeLidClose: ['eyeWideLeft', 'eyeWideRight'],
  mouthSmileLeft: ['mouthFrownLeft'],
  mouthSmileRight: ['mouthFrownRight'],
  mouthFrownLeft: ['mouthSmileLeft'],
  mouthFrownRight: ['mouthSmileRight']
};

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function canonicalEmotion(value: string): Emotion {
  return EMOTIONS.includes(value as Emotion) ? value as Emotion : 'neutral';
}

export class ExpressionTimeline {
  private readonly emotion: Emotion;
  private readonly duration: number;
  private readonly intensity: number;
  private readonly fadeIn: boolean;
  private readonly fadeOut: boolean;
  private readonly microAccent: ReturnType<typeof getExpressionMicroAccents>[number] | undefined;

  constructor(
    emotion: string,
    durationSeconds: number,
    intensity = 0.65,
    options: ExpressionTimelineOptions = {}
  ) {
    this.emotion = canonicalEmotion(emotion);
    this.duration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
    this.intensity = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
    this.fadeIn = options.fadeIn !== false;
    this.fadeOut = options.fadeOut !== false;
    const accents = getExpressionMicroAccents(this.emotion);
    const seed = Number.isFinite(options.microExpressionSeed)
      ? Math.abs(Math.trunc(options.microExpressionSeed!))
      : 0;
    this.microAccent = accents.length > 0 ? accents[seed % accents.length] : undefined;
  }

  sample(timeSeconds: number): ExpressionSample {
    if (timeSeconds < 0 || timeSeconds > this.duration) {
      return { emotion: this.emotion, weight: 0, blush: 0, pose: createEmptyFacialPose() };
    }
    const enterSeconds = Math.min(0.42, this.duration * 0.3);
    const exitSeconds = Math.min(0.55, this.duration * 0.35);
    const enter = this.fadeIn ? smoothstep(timeSeconds / Math.max(0.001, enterSeconds)) : 1;
    const exit = this.fadeOut
      ? smoothstep((this.duration - timeSeconds) / Math.max(0.001, exitSeconds))
      : 1;
    const envelope = Math.min(enter, exit);
    const poseIntensity = this.emotion === 'neutral'
      ? Math.max(0.6, this.intensity)
      : this.intensity;
    const weight = (this.emotion === 'neutral'
      ? Math.min(0.15, this.intensity)
      : this.intensity) * envelope;
    // A speech segment must never fade through the PMX native face: on these
    // models that neutral mouth reads as a brief frown. Enter and exit from a
    // restrained shared smile, then blend continuously to the semantic pose.
    const boundaryPose = createExpressionPose('smile', 0.55, 1);
    const targetPose = createExpressionPose(this.emotion, poseIntensity, 1);
    const basePose = blendFacialPoses(boundaryPose, targetPose, envelope);
    const microWeight = this.sampleMicroExpression(timeSeconds);
    const pose = this.applyMicroExpression(basePose, microWeight);
    return {
      emotion: this.emotion,
      weight,
      blush: pose.blush,
      pose,
      microExpression: this.microAccent
        ? { id: this.microAccent.id, weight: microWeight }
        : undefined
    };
  }

  private sampleMicroExpression(timeSeconds: number): number {
    if (!this.microAccent || this.duration <= 0) return 0;
    const authoredDuration = this.microAccent.enterSeconds
      + this.microAccent.holdSeconds
      + this.microAccent.exitSeconds;
    const availableDuration = Math.min(authoredDuration, this.duration * 0.62);
    if (availableDuration <= 0.12) return 0;
    const scale = availableDuration / authoredDuration;
    const enter = this.microAccent.enterSeconds * scale;
    const hold = this.microAccent.holdSeconds * scale;
    const exit = this.microAccent.exitSeconds * scale;
    const start = Math.max(0, (this.duration - availableDuration) * 0.45);
    const local = timeSeconds - start;
    if (local <= 0 || local >= availableDuration) return 0;
    if (local < enter) return smoothstep(local / Math.max(0.001, enter));
    if (local <= enter + hold) return 1;
    return smoothstep((availableDuration - local) / Math.max(0.001, exit));
  }

  private applyMicroExpression(base: FacialPose, pulse: number): FacialPose {
    if (!this.microAccent || pulse <= 0) return base;
    const mutable = { ...base } as Record<FacialChannel, number>;
    for (const [channelKey, authoredWeight] of Object.entries(this.microAccent.channels)) {
      const channel = channelKey as FacialChannel;
      const accentWeight = Number(authoredWeight ?? 0) * pulse * Math.max(0.55, this.intensity);
      const safeMaximum = channel === 'blush' ? 0.35 : channel === 'tears' ? 0.12 : 1;
      mutable[channel] = Math.min(safeMaximum, clampFacialWeight(mutable[channel] + accentWeight));
      for (const opposite of MICRO_OPPOSITES[channel] ?? []) {
        mutable[opposite] = clampFacialWeight(mutable[opposite] * (1 - 0.42 * pulse));
      }
    }
    return Object.fromEntries(FACIAL_CHANNELS.map(channel => [channel, mutable[channel]])) as unknown as FacialPose;
  }
}
