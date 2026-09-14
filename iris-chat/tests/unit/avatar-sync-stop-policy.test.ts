import { describe, expect, it } from 'vitest';
import {
  normalizeAvatarSyncStopReason,
  performanceStopReasonForAvatarSignal
} from '../../electron/avatar-sync-stop-policy';

describe('avatar sync stop policy', () => {
  it('keeps replacement playback interruptions distinct from user pause and natural completion', () => {
    expect(normalizeAvatarSyncStopReason('interrupted')).toBe('interrupted');
    expect(normalizeAvatarSyncStopReason('cancel')).toBe('cancel');
    expect(normalizeAvatarSyncStopReason('ended')).toBe('ended');
    expect(normalizeAvatarSyncStopReason('anything-else')).toBe('interrupted');
  });

  it('returns muted Chat playback to the selected default after pause or natural completion', () => {
    expect(performanceStopReasonForAvatarSignal('cancel', true)).toBe('ended');
    expect(performanceStopReasonForAvatarSignal('ended', true)).toBe('ended');
    expect(performanceStopReasonForAvatarSignal('interrupted', true)).toBe('interrupted');
  });

  it('does not turn an ordinary desktop interruption into a natural completion', () => {
    expect(performanceStopReasonForAvatarSignal('cancel', false)).toBe('interrupted');
    expect(performanceStopReasonForAvatarSignal('ended', false)).toBe('ended');
  });
});
