import { describe, expect, it } from 'vitest';
import {
  AVATAR_COMPUTE_LEVELS,
  getAvatarComputeProfile
} from '../../src/performance/avatar-compute-profile';

describe('avatar compute profiles', () => {
  it('keeps physics and animation continuous in every mode', () => {
    for (const level of AVATAR_COMPUTE_LEVELS) {
      const profile = getAvatarComputeProfile(level);
      expect(profile.runtime.physicsEveryFrame).toBe(true);
      expect(profile.runtime.animationEveryFrame).toBe(true);
      // Phrase motion dispatch is edge-triggered. A delayed acceptance gate
      // would reject the only request and leave the default idle visible for
      // the entire reply even though Planner selected a voice-pool action.
      expect(profile.speech.leadInMs).toBe(0);
      // Rendering quality may change cue density, but it must not make one
      // spoken sentence churn through several unrelated body actions.
      expect(profile.speech.shortReplyAccentLimit).toBe(1);
      expect(profile.speech.longReplyAccentLimit).toBeLessThanOrEqual(2);
    }
  });

  it('spends progressively more compute on lip and speech-motion matching', () => {
    const low = getAvatarComputeProfile('low');
    const medium = getAvatarComputeProfile('medium');
    const high = getAvatarComputeProfile('high');
    const ultra = getAvatarComputeProfile('ultra');

    expect(low.speech.lipFrameSeconds).toBeGreaterThan(medium.speech.lipFrameSeconds);
    expect(medium.speech.lipFrameSeconds).toBeGreaterThan(high.speech.lipFrameSeconds);
    expect(high.speech.lipFrameSeconds).toBeGreaterThan(ultra.speech.lipFrameSeconds);
    expect(low.speech.semanticBeatSeconds).toBeGreaterThan(medium.speech.semanticBeatSeconds);
    expect(medium.speech.longReplyAccentLimit).toBeLessThanOrEqual(high.speech.longReplyAccentLimit);
    expect(high.speech.longReplyAccentLimit).toBeLessThanOrEqual(ultra.speech.longReplyAccentLimit);
    expect(high.speech.longReplyAccentLimit).toBe(2);
    expect(ultra.speech.longReplyAccentLimit).toBe(2);
    expect(low.physics.maxSubSteps).toBeLessThan(medium.physics.maxSubSteps);
    expect(medium.physics.solverIterations).toBeLessThan(high.physics.solverIterations);
    expect(high.physics.solverIterations).toBeLessThanOrEqual(ultra.physics.solverIterations);
    expect(high.physics.solverIterations).toBeGreaterThanOrEqual(16);
    expect(low.physics.rotationFeedbackScale).toBeLessThan(high.physics.rotationFeedbackScale);
  });

  it('paces speech gesture handoffs conservatively so actions feel fewer and calmer', () => {
    // 语音手势的换手间隔整体放宽：低配 9s、中配 6s、高配 5s、极致 4.5s。
    // 旧的 7/4/3.5/3s 让中长回复在几秒内连续换动作，读作"动作太快、太密"。
    expect(getAvatarComputeProfile('low').speech.gestureGapSeconds).toBeGreaterThanOrEqual(9);
    expect(getAvatarComputeProfile('medium').speech.gestureGapSeconds).toBeGreaterThanOrEqual(6);
    expect(getAvatarComputeProfile('high').speech.gestureGapSeconds).toBeGreaterThanOrEqual(5);
    expect(getAvatarComputeProfile('ultra').speech.gestureGapSeconds).toBeGreaterThanOrEqual(4.5);
    expect(getAvatarComputeProfile('low').speech.gestureGapSeconds)
      .toBeGreaterThan(getAvatarComputeProfile('medium').speech.gestureGapSeconds);
    expect(getAvatarComputeProfile('medium').speech.gestureGapSeconds)
      .toBeGreaterThan(getAvatarComputeProfile('high').speech.gestureGapSeconds);
  });

  it('uses balanced as the safe fallback for an unknown level', () => {
    expect(getAvatarComputeProfile('invalid' as never)).toEqual(getAvatarComputeProfile('medium'));
  });
});
