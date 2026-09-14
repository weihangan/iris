export const AVATAR_COMPUTE_LEVELS = ['low', 'medium', 'high', 'ultra'] as const;

export type AvatarComputeLevel = typeof AVATAR_COMPUTE_LEVELS[number];

export interface AvatarComputeProfile {
  readonly level: AvatarComputeLevel;
  readonly render: {
    readonly pixelRatioCap: number;
    readonly shadows: 'off' | 'soft' | 'vsm';
    readonly exposure: number;
  };
  readonly speech: {
    readonly lipFrameSeconds: number;
    readonly semanticBeatSeconds: number;
    readonly gestureGapSeconds: number;
    readonly maxMajorEmotionTransitions: number;
    readonly shortReplyAccentLimit: number;
    readonly longReplyAccentLimit: number;
    readonly longReplySeconds: number;
    readonly leadInMs: number;
    readonly recentReplyWindow: number;
  };
  readonly runtime: {
    readonly animationEveryFrame: true;
    readonly physicsEveryFrame: true;
  };
  readonly physics: {
    readonly fixedTimeStep: number;
    readonly maxSubSteps: number;
    readonly solverIterations: number;
    readonly rotationFeedbackScale: number;
    readonly rootInertiaScale: number;
  };
}

const CONTINUOUS_RUNTIME = {
  animationEveryFrame: true,
  physicsEveryFrame: true
} as const;

const PROFILES: Readonly<Record<AvatarComputeLevel, AvatarComputeProfile>> = {
  low: {
    level: 'low',
    render: { pixelRatioCap: 1, shadows: 'off', exposure: 1 },
    speech: {
      lipFrameSeconds: 0.04,
      semanticBeatSeconds: 8,
      gestureGapSeconds: 9,
      maxMajorEmotionTransitions: 1,
      shortReplyAccentLimit: 1,
      longReplyAccentLimit: 1,
      longReplySeconds: 14,
      // Speech cues are edge-triggered when the timeline enters a phrase.
      // A non-zero gate discards that single request instead of delaying it,
      // so the selected voice-pool VMD never reaches MotionPlayer.
      leadInMs: 0,
      recentReplyWindow: 2
    },
    runtime: CONTINUOUS_RUNTIME,
    physics: { fixedTimeStep: 1 / 60, maxSubSteps: 1, solverIterations: 8, rotationFeedbackScale: 0.08, rootInertiaScale: 0.75 }
  },
  medium: {
    level: 'medium',
    render: { pixelRatioCap: 1.5, shadows: 'off', exposure: 1.1 },
    speech: {
      lipFrameSeconds: 0.025,
      semanticBeatSeconds: 5.5,
      gestureGapSeconds: 6,
      maxMajorEmotionTransitions: 2,
      shortReplyAccentLimit: 1,
      longReplyAccentLimit: 2,
      longReplySeconds: 12,
      leadInMs: 0,
      recentReplyWindow: 3
    },
    runtime: CONTINUOUS_RUNTIME,
    physics: { fixedTimeStep: 1 / 60, maxSubSteps: 2, solverIterations: 10, rotationFeedbackScale: 0.1, rootInertiaScale: 0.9 }
  },
  high: {
    level: 'high',
    render: { pixelRatioCap: 1.75, shadows: 'soft', exposure: 1.1 },
    speech: {
      lipFrameSeconds: 0.02,
      semanticBeatSeconds: 4.5,
      gestureGapSeconds: 5,
      maxMajorEmotionTransitions: 3,
      shortReplyAccentLimit: 1,
      longReplyAccentLimit: 2,
      longReplySeconds: 11,
      leadInMs: 0,
      recentReplyWindow: 4
    },
    runtime: CONTINUOUS_RUNTIME,
    physics: { fixedTimeStep: 1 / 90, maxSubSteps: 3, solverIterations: 16, rotationFeedbackScale: 0.13, rootInertiaScale: 1 }
  },
  ultra: {
    level: 'ultra',
    render: { pixelRatioCap: 2, shadows: 'vsm', exposure: 1.2 },
    speech: {
      lipFrameSeconds: 1 / 60,
      semanticBeatSeconds: 3.5,
      gestureGapSeconds: 4.5,
      maxMajorEmotionTransitions: 3,
      shortReplyAccentLimit: 1,
      longReplyAccentLimit: 2,
      longReplySeconds: 10,
      leadInMs: 0,
      recentReplyWindow: 5
    },
    runtime: CONTINUOUS_RUNTIME,
    physics: { fixedTimeStep: 1 / 120, maxSubSteps: 4, solverIterations: 18, rotationFeedbackScale: 0.16, rootInertiaScale: 1.1 }
  }
};

export function isAvatarComputeLevel(value: unknown): value is AvatarComputeLevel {
  return typeof value === 'string' && (AVATAR_COMPUTE_LEVELS as readonly string[]).includes(value);
}

export function getAvatarComputeProfile(level: AvatarComputeLevel): AvatarComputeProfile {
  return PROFILES[isAvatarComputeLevel(level) ? level : 'medium'];
}
