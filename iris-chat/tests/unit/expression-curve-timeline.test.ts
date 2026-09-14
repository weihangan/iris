import { describe, expect, it } from 'vitest';
import { ExpressionCurveTimeline } from '../../src/performance/expression-curve-timeline';

describe('ExpressionCurveTimeline', () => {
  it('sorts and linearly interpolates deterministic candidate channel keys', () => {
    const timeline = new ExpressionCurveTimeline({
      durationSeconds: 2,
      channelCurves: {
        mouthSmileLeft: [
          { timeSeconds: 2, value: 0 },
          { timeSeconds: 0.5, value: 0.4 },
          { timeSeconds: 0, value: 0 }
        ]
      }
    });

    expect(timeline.sample(0).mouthSmileLeft).toBe(0);
    expect(timeline.sample(0.25).mouthSmileLeft).toBeCloseTo(0.2, 6);
    expect(timeline.sample(1.25).mouthSmileLeft).toBeCloseTo(0.2, 6);
    expect(timeline.sample(2).mouthSmileLeft).toBe(0);
    expect(timeline.sample(2.1).mouthSmileLeft).toBe(0);
  });

  it('clamps all weights and keeps blush at or below 0.35', () => {
    const timeline = new ExpressionCurveTimeline({
      durationSeconds: 1,
      channelCurves: {
        blush: [{ timeSeconds: 0.5, value: 2 }],
        eyeSmile: [{ timeSeconds: 0.5, value: 4 }]
      }
    });

    expect(timeline.sample(0.5).blush).toBe(0.35);
    expect(timeline.sample(0.5).eyeSmile).toBe(1);
  });

  it('rejects non-finite time and weight values', () => {
    expect(() => new ExpressionCurveTimeline({
      durationSeconds: 1,
      channelCurves: {
        eyeSmile: [{ timeSeconds: Number.NaN, value: 0.2 }]
      }
    })).toThrow('finite');
  });
});
