import { describe, expect, it } from 'vitest';
import type { Emotion } from '../../src/actor/actor-runtime';
import { resolveSpeechMotionStyle } from '../../src/performance/speech-motion-style';

describe('speech motion style', () => {
  it('keeps every emotional playback rate inside the approved slow range', () => {
    const emotions: Emotion[] = [
      'neutral', 'gentle', 'happy', 'explaining', 'curious', 'thinking',
      'grateful', 'apologetic', 'excited', 'concerned'
    ];

    for (const emotion of emotions) {
      const style = resolveSpeechMotionStyle(emotion, 0.6);
      // 全局放缓约 4%：0.76~0.81。原 0.8~0.85 的采样速度读作"动作太快"。
      expect(style.playbackRate).toBeGreaterThanOrEqual(0.76);
      expect(style.playbackRate).toBeLessThanOrEqual(0.81);
    }
    expect(resolveSpeechMotionStyle('neutral', 0.5).playbackRate).toBe(0.8);
  });

  it('makes calm and apologetic delivery slower and more restrained than happy delivery', () => {
    const gentle = resolveSpeechMotionStyle('gentle', 0.6);
    const thinking = resolveSpeechMotionStyle('thinking', 0.6);
    const apologetic = resolveSpeechMotionStyle('apologetic', 0.6);
    const happy = resolveSpeechMotionStyle('happy', 0.6);

    expect(gentle.playbackRate).toBe(0.76);
    expect(thinking.playbackRate).toBe(0.77);
    expect(apologetic.playbackRate).toBe(0.76);
    expect(happy.playbackRate).toBe(0.81);
    expect(gentle.amplitudeLimits.shoulder.x).toBeLessThan(happy.amplitudeLimits.shoulder.x);
    expect(thinking.amplitudeLimits.upperBody.y).toBeLessThan(happy.amplitudeLimits.upperBody.y);
    expect(apologetic.amplitudeLimits.head.x).toBeLessThan(happy.amplitudeLimits.head.x);
  });

  it('does not clamp authored arm, elbow, or wrist expression', () => {
    for (const emotion of ['gentle', 'happy', 'explaining', 'curious'] as const) {
      const limits = resolveSpeechMotionStyle(emotion, 0.75).amplitudeLimits;
      expect(limits.arm).toBeUndefined();
      expect(limits.elbow).toBeUndefined();
      expect(limits.wrist).toBeUndefined();
      expect(limits.faceRedMax).toBe(0.35);
    }
  });

  it('allows intensity to grow only inside the emotion family safety ceiling', () => {
    const quiet = resolveSpeechMotionStyle('explaining', 0.2);
    const emphatic = resolveSpeechMotionStyle('explaining', 1);

    expect(emphatic.amplitudeLimits.shoulder.x).toBeGreaterThan(quiet.amplitudeLimits.shoulder.x);
    expect(emphatic.amplitudeLimits.shoulder.x).toBeLessThanOrEqual(9);
    expect(emphatic.amplitudeLimits.upperBody.x).toBeLessThanOrEqual(9);
    expect(emphatic.amplitudeLimits.head.x).toBeLessThanOrEqual(11);
  });
});
