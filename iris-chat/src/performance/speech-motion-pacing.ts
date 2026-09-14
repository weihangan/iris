export const DEFAULT_SPEECH_MOTION_RATE = 0.8;
// 2026-08: 下限 0.8 → 0.76，与放缓后的情绪包络（0.76~0.81）一致，
// 准入测算不再把实际更慢的动作误算成更快完成。
export const MIN_SPEECH_MOTION_RATE = 0.76;
export const MAX_SPEECH_MOTION_RATE = 0.85;

export interface SpeechMotionAdmission {
  readonly remainingSpeechSeconds: number;
  readonly authoredActionSeconds: number;
  readonly playbackRate?: number;
  readonly bridgeInSeconds?: number;
  readonly bridgeOutSeconds?: number;
  readonly settleSeconds?: number;
}

export function clampSpeechMotionRate(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEECH_MOTION_RATE;
  return Math.min(MAX_SPEECH_MOTION_RATE, Math.max(MIN_SPEECH_MOTION_RATE, value!));
}

export function minimumRemainingSpeechSeconds(
  authoredActionSeconds: number,
  bridgeInSeconds = 1,
  bridgeOutSeconds = 0.9,
  settleSeconds = 0.8,
  playbackRate = DEFAULT_SPEECH_MOTION_RATE
): number {
  const rate = clampSpeechMotionRate(playbackRate);
  const readableActionSeconds = Math.min(2, Math.max(0, authoredActionSeconds) / rate);
  return Math.max(0, bridgeInSeconds)
    + readableActionSeconds
    + Math.max(0, bridgeOutSeconds)
    + Math.max(0, settleSeconds);
}

export function canStartSpeechMotion(input: SpeechMotionAdmission): boolean {
  const required = minimumRemainingSpeechSeconds(
    input.authoredActionSeconds,
    input.bridgeInSeconds,
    input.bridgeOutSeconds,
    input.settleSeconds,
    input.playbackRate
  );
  return Number.isFinite(input.remainingSpeechSeconds)
    && input.remainingSpeechSeconds + 1e-7 >= required;
}
