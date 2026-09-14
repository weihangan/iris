export type AvatarSyncStopReason = 'interrupted' | 'cancel' | 'ended';
export type PerformanceStopReason = 'interrupted' | 'ended';

export function normalizeAvatarSyncStopReason(value: unknown): AvatarSyncStopReason {
  return value === 'cancel' || value === 'ended' || value === 'interrupted'
    ? value
    : 'interrupted';
}

export function performanceStopReasonForAvatarSignal(
  reason: AvatarSyncStopReason,
  mutedPlayback: boolean
): PerformanceStopReason {
  if (reason === 'ended') return 'ended';
  if (reason === 'cancel' && mutedPlayback) return 'ended';
  return 'interrupted';
}
