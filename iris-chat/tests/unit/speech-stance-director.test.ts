import { describe, expect, it } from 'vitest';
import { SpeechStanceDirector } from '../../src/performance/speech-stance-director';

describe('SpeechStanceDirector', () => {
  it('keeps one stance for the complete reply across phrase cues', () => {
    const director = new SpeechStanceDirector();
    const first = director.beginReply('reply-1', 'happy', 0.7);
    const repeated = director.beginReply('reply-1', 'angry', 1);

    expect(repeated).toBe(first);
    expect(director.getActiveSelection()).toBe(first);
  });

  it('selects restrained emotion-appropriate grounded profiles', () => {
    const director = new SpeechStanceDirector();

    expect(director.beginReply('serious-1', 'serious', 0.8).profile.id)
      .toBe('earnest-forward');
    director.endReply();

    const gentle = director.beginReply('gentle-1', 'shy', 0.5).profile.id;
    expect(['warm-left', 'warm-right']).toContain(gentle);
  });

  it('keeps the generated stance visibly engaged without becoming locomotion', () => {
    const director = new SpeechStanceDirector();
    const neutral = director.beginReply('neutral-visible', 'neutral', 0.5).profile;

    expect(neutral.pelvisPitchDegrees).toBeGreaterThanOrEqual(0.4);
    expect(neutral.leftKneePitchDegrees).toBeGreaterThanOrEqual(0.55);
    expect(neutral.rightKneePitchDegrees).toBeGreaterThanOrEqual(0.55);

    director.endReply();
    const warm = director.beginReply('warm-visible', 'gentle', 0.5).profile;
    expect(Math.abs(warm.pelvisRollDegrees)).toBeGreaterThanOrEqual(0.8);
    expect(Math.max(warm.leftKneePitchDegrees, warm.rightKneePitchDegrees)).toBeGreaterThanOrEqual(0.85);
  });

  it('admits at most one safe lower-body accent and rejects locomotion', () => {
    const director = new SpeechStanceDirector();
    director.beginReply('reply-2', 'excited', 0.8);

    expect(director.claimLowerBodyAccent('walk')).toBe(false);
    expect(director.claimLowerBodyAccent('in-place-accent')).toBe(true);
    expect(director.claimLowerBodyAccent('in-place-accent')).toBe(false);
  });

  it('keeps short calm replies stable and gives a long calm reply one restrained accent', () => {
    const director = new SpeechStanceDirector();
    director.beginReply('short-calm', 'gentle', 0.4);

    expect(director.selectAccent({
      index: 1,
      isOpening: false,
      isClosing: false,
      gestureEligible: true,
      emotion: 'gentle',
      intensity: 0.4
    }, 4, 6)).toBeNull();

    director.endReply();
    director.beginReply('long-calm', 'neutral', 0.45);
    const accent = director.selectAccent({
      index: 3,
      isOpening: false,
      isClosing: false,
      gestureEligible: true,
      emotion: 'neutral',
      intensity: 0.45
    }, 6, 24);
    expect(accent).not.toBeNull();
    expect(['weight-left', 'weight-right']).toContain(accent?.kind);
    expect(director.selectAccent({
      index: 4,
      isOpening: false,
      isClosing: false,
      gestureEligible: true,
      emotion: 'gentle',
      intensity: 0.4
    }, 6, 24)).toBeNull();
  });

  it('allows one balance change in a medium calm reply', () => {
    const director = new SpeechStanceDirector();
    director.beginReply('medium-calm', 'gentle', 0.42);

    const accent = director.selectAccent({
      index: 2,
      isOpening: false,
      isClosing: false,
      gestureEligible: true,
      emotion: 'gentle',
      intensity: 0.42
    }, 4, 12);

    expect(accent).not.toBeNull();
    expect(['weight-left', 'weight-right']).toContain(accent?.kind);
  });

  it('schedules at most two non-adjacent accents inside a long expressive reply', () => {
    const director = new SpeechStanceDirector();
    director.beginReply('long-expressive', 'happy', 0.72);
    const selected = Array.from({ length: 7 }, (_, index) => director.selectAccent({
      index,
      isOpening: index === 0,
      isClosing: index === 6,
      gestureEligible: true,
      emotion: 'happy',
      intensity: 0.72
    }, 7, 24));
    const selectedIndices = selected
      .map((accent, index) => accent ? index : -1)
      .filter(index => index >= 0);

    expect(selected[0]).toBeNull();
    expect(selected[6]).toBeNull();
    expect(selectedIndices).toHaveLength(2);
    expect(selectedIndices[1] - selectedIndices[0]).toBeGreaterThan(1);
    expect(selected.filter(Boolean).every(accent =>
      ['weight-left', 'weight-right', 'soft-knee'].includes(accent!.kind))).toBe(true);
  });

  it('never turns locomotion cues into a speech stance accent', () => {
    const director = new SpeechStanceDirector();
    director.beginReply('unsafe-movement', 'excited', 0.9);

    for (const movement of ['walk', 'run', 'multi-step', 'jump', 'unknown'] as const) {
      expect(director.claimLowerBodyAccent(movement)).toBe(false);
    }
  });

  it('clears the stance at reply end and allows the next reply to choose again', () => {
    const director = new SpeechStanceDirector();
    const first = director.beginReply('reply-3', 'neutral', 0.3);
    director.endReply();

    expect(director.getActiveSelection()).toBeNull();
    const second = director.beginReply('reply-4', 'serious', 0.8);
    expect(second.replyId).toBe('reply-4');
    expect(second).not.toBe(first);
  });
});
