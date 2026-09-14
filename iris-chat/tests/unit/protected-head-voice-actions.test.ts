import { describe, expect, it } from 'vitest';
import {
  PROTECTED_HEAD_VOICE_ACTIONS,
  isProtectedVoiceActionPath,
  mergeProtectedHeadVoiceActions,
  sanitizeProtectedHeadVoiceActionUpdates
} from '../../src/performance/protected-head-voice-actions';

describe('protected head-only voice actions', () => {
  it('defines the three canonical protected voice-pool entries', () => {
    expect(PROTECTED_HEAD_VOICE_ACTIONS.map(entry => entry.headOverlayId)).toEqual([
      'curious-left-tilt',
      'concerned-down',
      'remember-inward-up'
    ]);
    for (const entry of PROTECTED_HEAD_VOICE_ACTIONS) {
      expect(entry).toMatchObject({
        type: 'voice',
        dialogueSafe: true,
        motionScope: 'head-overlay',
        protected: true
      });
      expect(entry.vmdPath).toMatch(/^\.\.\/shared\/motions\/.+\.vmd$/u);
    }
  });

  it('recognizes canonical paths across slash and case aliases', () => {
    const canonical = PROTECTED_HEAD_VOICE_ACTIONS[0].vmdPath;

    expect(isProtectedVoiceActionPath(` ${canonical.replaceAll('/', '\\').toUpperCase()} `)).toBe(true);
    expect(isProtectedVoiceActionPath('../shared/motions/not-protected.vmd')).toBe(false);
  });

  it('deduplicates a persisted canonical entry in memory without trusting its identity fields', () => {
    const canonical = PROTECTED_HEAD_VOICE_ACTIONS[0];
    const merged = mergeProtectedHeadVoiceActions([{
      ...canonical,
      displayName: '用户文件中的旧副本',
      protected: false,
      headOverlayId: 'concerned-down'
    }]);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual(canonical);
  });

  it('applies only permitted overrides and clamps head rotation tuning', () => {
    const canonical = PROTECTED_HEAD_VOICE_ACTIONS[0];
    const merged = mergeProtectedHeadVoiceActions([], {
      [canonical.vmdPath]: {
        starred: true,
        dialogueSafe: false,
        headTuning: { rotationScale: 99 }
      }
    });

    expect(merged[0]).toMatchObject({
      starred: true,
      dialogueSafe: false,
      headTuning: { rotationScale: 1.2 }
    });
    expect(sanitizeProtectedHeadVoiceActionUpdates({ displayName: '不能改名' })).toBeNull();
    expect(sanitizeProtectedHeadVoiceActionUpdates({ headTuning: { rotationScale: 0 } })).toEqual({
      headTuning: { rotationScale: 0.75 }
    });
  });
});
