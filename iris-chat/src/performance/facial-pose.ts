export const FACIAL_CHANNELS = [
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'browDownLeft',
  'browDownRight',
  'eyeWideLeft',
  'eyeWideRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeSmile',
  'eyeLidClose',
  'cheekRaiseLeft',
  'cheekRaiseRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthPucker',
  'mouthClose',
  'jawOpen',
  'blush',
  'tears'
] as const;

export type FacialChannel = typeof FACIAL_CHANNELS[number];
export type FacialPose = Readonly<Record<FacialChannel, number>>;

export function createEmptyFacialPose(): FacialPose {
  return Object.fromEntries(FACIAL_CHANNELS.map(channel => [channel, 0])) as unknown as FacialPose;
}

export function clampFacialWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function blendFacialPoses(from: FacialPose, to: FacialPose, amount: number): FacialPose {
  const alpha = clampFacialWeight(amount);
  return Object.fromEntries(FACIAL_CHANNELS.map(channel => [
    channel,
    from[channel] + (to[channel] - from[channel]) * alpha
  ])) as unknown as FacialPose;
}

const OPPOSING_FACIAL_CHANNELS: Readonly<Partial<Record<FacialChannel, readonly FacialChannel[]>>> = {
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

function smoothStep(amount: number): number {
  const value = clampFacialWeight(amount);
  return value * value * (3 - 2 * value);
}

/**
 * Return from an authored speech face to the shared idle face without
 * activating opposing semantic channels in the same frame.
 */
export function blendFacialPosesForIdleReturn(
  from: FacialPose,
  to: FacialPose,
  amount: number,
  releasePortion = 0.55
): FacialPose {
  const progress = clampFacialWeight(amount);
  const releaseEnd = Math.min(0.8, Math.max(0.2, releasePortion));
  return Object.fromEntries(FACIAL_CHANNELS.map(channel => {
    const opposites = OPPOSING_FACIAL_CHANNELS[channel] ?? [];
    const sourceConflicts = from[channel] > 0 && opposites.some(opposite => to[opposite] > 0);
    const targetConflicts = to[channel] > 0 && opposites.some(opposite => from[opposite] > 0);
    if (sourceConflicts) {
      return [channel, from[channel] * (1 - smoothStep(progress / releaseEnd))];
    }
    if (targetConflicts) {
      return [channel, to[channel] * smoothStep((progress - releaseEnd) / (1 - releaseEnd))];
    }
    const eased = smoothStep(progress);
    return [channel, from[channel] + (to[channel] - from[channel]) * eased];
  })) as unknown as FacialPose;
}
