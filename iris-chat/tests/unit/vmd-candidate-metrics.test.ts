import { describe, expect, it } from 'vitest';
import { measureDailyMotionCandidate } from '../../src/performance/vmd-candidate-metrics';

function quaternionZ(degrees: number): number[] {
  const half = degrees * Math.PI / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

function track(frames: number[], translations: number[], rotations: number[]) {
  return { frames, translations, rotations };
}

describe('measureDailyMotionCandidate', () => {
  it('measures a neutral-start upper-body motion without inventing lower-body activity', () => {
    const animation = {
      boneTracks: {
        '頭': track([0, 30, 90], [0, 0, 0, 0, 0, 0, 0, 0, 0], [
          ...quaternionZ(0), ...quaternionZ(6), ...quaternionZ(0)
        ]),
        '右肩': track([0, 45, 90], [0, 0, 0, 0, 0, 0, 0, 0, 0], [
          ...quaternionZ(0), ...quaternionZ(5), ...quaternionZ(0)
        ])
      },
      morphTracks: {}
    };

    expect(measureDailyMotionCandidate(animation)).toMatchObject({
      durationSeconds: 3,
      activeBoneTrackCount: 2,
      rootTranslationMax: 0,
      centerTranslationMax: 0,
      maximumTurnDegrees: 0,
      maximumLegLift: 0,
      maximumKneeBendDegrees: 0,
      hasStaticLegHelper: false,
      headEntryDegrees: 0,
      shoulderEntryDegrees: 0
    });
  });

  it('detects initial displacement, leg lift, knee bend and a one-frame D/EX helper', () => {
    const animation = {
      boneTracks: {
        '全ての親': track([0, 60], [0.1, 0, 0, 0.1, 0, 0], [
          ...quaternionZ(24), ...quaternionZ(24)
        ]),
        'センター': track([0, 60], [0, 0.2, 0, 0, 0.2, 0], [
          ...quaternionZ(0), ...quaternionZ(0)
        ]),
        '左足ＩＫ': track([0, 60], [0, 0, 0, 0, 0.15, 0], [
          ...quaternionZ(0), ...quaternionZ(0)
        ]),
        '左ひざ': track([0, 60], [0, 0, 0, 0, 0, 0], [
          ...quaternionZ(0), ...quaternionZ(42)
        ]),
        '右足D': track([0], [0, 0, 0], quaternionZ(0))
      },
      morphTracks: {}
    };

    const metrics = measureDailyMotionCandidate(animation);
    expect(metrics.activeBoneTrackCount).toBe(4);
    expect(metrics.rootTranslationMax).toBeCloseTo(0.1);
    expect(metrics.centerTranslationMax).toBeCloseTo(0.2);
    expect(metrics.maximumTurnDegrees).toBeCloseTo(24);
    expect(metrics.maximumLegLift).toBeCloseTo(0.15);
    expect(metrics.maximumKneeBendDegrees).toBeCloseTo(42);
    expect(metrics.hasStaticLegHelper).toBe(true);
    expect(metrics.maximumBoneStep).toBeGreaterThan(0.2);
  });
});
