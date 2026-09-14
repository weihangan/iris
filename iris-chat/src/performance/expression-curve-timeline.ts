import type { ExpressionCurveKey } from './daily-candidate-types';
import {
  FACIAL_CHANNELS,
  clampFacialWeight,
  createEmptyFacialPose,
  type FacialChannel,
  type FacialPose
} from './facial-pose';

export interface ExpressionCurveTimelineDefinition {
  readonly durationSeconds: number;
  readonly channelCurves: Readonly<Partial<Record<FacialChannel, readonly ExpressionCurveKey[]>>>;
}

const BLUSH_MAXIMUM = 0.35;

function clampChannelWeight(channel: FacialChannel, value: number): number {
  const clamped = clampFacialWeight(value);
  return channel === 'blush' ? Math.min(BLUSH_MAXIMUM, clamped) : clamped;
}

export class ExpressionCurveTimeline {
  private readonly durationSeconds: number;
  private readonly channelCurves = new Map<FacialChannel, readonly ExpressionCurveKey[]>();

  constructor(definition: ExpressionCurveTimelineDefinition) {
    if (!Number.isFinite(definition.durationSeconds)) {
      throw new Error('Expression duration must be finite');
    }
    this.durationSeconds = Math.max(0, definition.durationSeconds);

    for (const channel of FACIAL_CHANNELS) {
      const sourceKeys = definition.channelCurves[channel];
      if (!sourceKeys?.length) continue;
      const keys = sourceKeys.map(key => {
        if (!Number.isFinite(key.timeSeconds) || !Number.isFinite(key.value)) {
          throw new Error('Expression curve time and value must be finite');
        }
        return { timeSeconds: key.timeSeconds, value: key.value };
      }).sort((left, right) => left.timeSeconds - right.timeSeconds);
      this.channelCurves.set(channel, keys);
    }
  }

  getDurationSeconds(): number {
    return this.durationSeconds;
  }

  sample(timeSeconds: number): FacialPose {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > this.durationSeconds) {
      return createEmptyFacialPose();
    }

    const pose = { ...createEmptyFacialPose() } as Record<FacialChannel, number>;
    for (const [channel, keys] of this.channelCurves) {
      pose[channel] = clampChannelWeight(channel, this.sampleCurve(keys, timeSeconds));
    }
    return pose;
  }

  private sampleCurve(keys: readonly ExpressionCurveKey[], timeSeconds: number): number {
    if (timeSeconds <= keys[0].timeSeconds) return keys[0].value;
    const last = keys[keys.length - 1];
    if (timeSeconds >= last.timeSeconds) return last.value;

    for (let index = 1; index < keys.length; index += 1) {
      const right = keys[index];
      if (timeSeconds > right.timeSeconds) continue;
      const left = keys[index - 1];
      const span = right.timeSeconds - left.timeSeconds;
      if (span <= 0) return right.value;
      const amount = (timeSeconds - left.timeSeconds) / span;
      return left.value + (right.value - left.value) * amount;
    }
    return last.value;
  }
}
