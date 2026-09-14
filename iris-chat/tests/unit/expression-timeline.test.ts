import { describe, expect, it } from 'vitest';
import { ExpressionTimeline } from '../../src/performance/expression-timeline';
import { FACIAL_CHANNELS } from '../../src/performance/facial-pose';

describe('ExpressionTimeline', () => {
  it('neutral 返回低权重微表情（真面目）', () => {
    const timeline = new ExpressionTimeline('neutral', 2, 0.8);
    const s = timeline.sample(1);
    expect(s.emotion).toBe('neutral');
    expect(s.weight).toBeGreaterThan(0);
    expect(s.weight).toBeLessThanOrEqual(0.15);
    expect(s.blush).toBe(0);
    expect(Object.values(s.pose).some(weight => weight > 0)).toBe(true);
    expect(Math.max(...Object.values(s.pose))).toBeLessThan(0.1);
  });

  it('happy 使用 enter/hold/tail/exit 连续包络', () => {
    const timeline = new ExpressionTimeline('happy', 2, 0.8);
    expect(timeline.sample(0).weight).toBe(0);
    expect(timeline.sample(0.125).weight).toBeGreaterThan(0);
    expect(timeline.sample(0.12).weight).toBeLessThan(timeline.sample(0.25).weight);
    expect(timeline.sample(0.5).weight).toBeCloseTo(0.8, 2);
    expect(timeline.sample(1.5).weight).toBeGreaterThan(0);
    expect(timeline.sample(2).weight).toBe(0);
    expect(timeline.sample(0.5).pose.mouthSmileLeft).toBeGreaterThan(0);
    expect(timeline.sample(0.5).pose.eyeSquintRight).toBeGreaterThan(0);
  });

  it('uses the restrained smile as the visible boundary pose instead of a downturned native mouth', () => {
    const timeline = new ExpressionTimeline('concerned', 2, 0.8);
    for (const sample of [timeline.sample(0), timeline.sample(2)]) {
      expect(sample.pose.mouthSmileLeft).toBeGreaterThan(0.15);
      expect(sample.pose.mouthSmileRight).toBeGreaterThan(0.15);
      expect(sample.pose.mouthFrownLeft).toBe(0);
      expect(sample.pose.mouthFrownRight).toBe(0);
    }
  });

  it('uses a smooth non-linear transition instead of an instant or linear jump', () => {
    const timeline = new ExpressionTimeline('shocked', 2, 1);
    const early = timeline.sample(0.08).weight;
    const middle = timeline.sample(0.21).weight;
    const settled = timeline.sample(0.5).weight;

    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.15);
    expect(middle).toBeGreaterThan(early);
    expect(middle).toBeLessThan(0.75);
    expect(settled).toBeCloseTo(1, 5);
  });

  it('fade disabled keeps a compound pose active at both phrase boundaries', () => {
    const timeline = new ExpressionTimeline('concerned', 2, 0.7, {
      fadeIn: false,
      fadeOut: false
    });

    for (const sample of [timeline.sample(0), timeline.sample(2)]) {
      expect(FACIAL_CHANNELS.filter(channel => sample.pose[channel] > 0).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('thinking preserves asymmetric channels through the envelope', () => {
    const sample = new ExpressionTimeline('thinking', 2, 0.8).sample(1);

    expect(sample.pose.browOuterUpLeft).toBeGreaterThan(sample.pose.browOuterUpRight);
    expect(sample.pose.mouthPucker).toBeGreaterThan(0);
  });

  it('applies a deterministic smooth micro-expression accent during speech', () => {
    const timeline = new ExpressionTimeline('explaining', 3, 0.72, {
      fadeIn: false,
      fadeOut: false,
      microExpressionSeed: 0
    });
    const before = timeline.sample(0);
    const accented = timeline.sample(1.35);
    const after = timeline.sample(3);

    expect(accented.microExpression?.id).toBe('single-brow-emphasis');
    expect(accented.microExpression?.weight).toBeGreaterThan(0.2);
    expect(accented.pose.browOuterUpLeft).toBeGreaterThan(before.pose.browOuterUpLeft);
    expect(after.microExpression?.weight ?? 0).toBe(0);
  });

  it('rotates through the authored micro-expression accents without per-frame randomness', () => {
    const first = new ExpressionTimeline('happy', 3, 0.8, { microExpressionSeed: 0 });
    const second = new ExpressionTimeline('happy', 3, 0.8, { microExpressionSeed: 1 });

    expect(first.sample(1.35).microExpression?.id).toBe('warm-eye-smile');
    expect(second.sample(1.35).microExpression?.id).toBe('brief-brighten');
    expect(first.sample(1.35)).toEqual(first.sample(1.35));
  });

  it('shy 的 FaceRed 永不超过 0.35', () => {
    const timeline = new ExpressionTimeline('shy', 3, 1);
    expect(timeline.sample(1).blush).toBeLessThanOrEqual(0.35);
    expect(timeline.sample(1).blush).toBeGreaterThan(0);
  });

  it('未知 emotion 降级 neutral 并返回低权重微表情', () => {
    const timeline = new ExpressionTimeline('not-real', 2, 1);
    const s = timeline.sample(1);
    expect(s.emotion).toBe('neutral');
    expect(s.weight).toBeGreaterThan(0);
    expect(s.weight).toBeLessThanOrEqual(0.15);
    expect(s.blush).toBe(0);
  });

  it('负数和超出时长均返回零', () => {
    const timeline = new ExpressionTimeline('concerned', 1, 0.6);
    expect(timeline.sample(-1).weight).toBe(0);
    expect(timeline.sample(2).weight).toBe(0);
    expect(Object.values(timeline.sample(-1).pose).every(weight => weight === 0)).toBe(true);
    expect(Object.values(timeline.sample(2).pose).every(weight => weight === 0)).toBe(true);
  });
});
