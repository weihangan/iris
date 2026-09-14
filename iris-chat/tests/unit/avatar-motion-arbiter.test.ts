import { describe, expect, it } from 'vitest';
import { AvatarMotionArbiter } from '../../src/motion/avatar-motion-arbiter';

describe('AvatarMotionArbiter', () => {
  it('allows idle only before a higher-priority owner starts', () => {
    const arbiter = new AvatarMotionArbiter();

    expect(arbiter.getMode()).toBe('idle');
    expect(arbiter.canRunIdle()).toBe(true);

    const preview = arbiter.requestPreview();
    expect(preview.accepted).toBe(true);
    expect(arbiter.getMode()).toBe('manual-preview');
    expect(arbiter.canRunIdle()).toBe(false);
  });

  it('keeps the selected default base available while the episodic idle pool is paused', () => {
    const arbiter = new AvatarMotionArbiter();
    arbiter.setIdlePaused(true);

    expect(arbiter.canRunIdle()).toBe(false);
    expect(arbiter.canRunDefaultIdle()).toBe(true);

    const speech = arbiter.beginSpeech();
    expect(arbiter.canRunDefaultIdle()).toBe(false);
    arbiter.endSpeech(speech);
    arbiter.setPoseLocked(true);
    expect(arbiter.canRunDefaultIdle()).toBe(false);
  });

  it('uses latest-request-wins for manual previews', () => {
    const arbiter = new AvatarMotionArbiter();
    const first = arbiter.requestPreview();
    const second = arbiter.requestPreview();

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) throw new Error('preview unexpectedly rejected');
    expect(arbiter.isCurrentPreview(first.requestId)).toBe(false);
    expect(arbiter.isCurrentPreview(second.requestId)).toBe(true);
  });

  it('speech invalidates pending preview and rejects new preview requests', () => {
    const arbiter = new AvatarMotionArbiter();
    const pending = arbiter.requestPreview();

    const speechGeneration = arbiter.beginSpeech();

    expect(arbiter.getMode()).toBe('speech');
    if (!pending.accepted) throw new Error('preview unexpectedly rejected');
    expect(arbiter.isCurrentPreview(pending.requestId)).toBe(false);
    expect(arbiter.isCurrentSpeech(speechGeneration)).toBe(true);
    expect(arbiter.requestPreview()).toEqual({ accepted: false, reason: 'speech-active' });
    expect(arbiter.canRunIdle()).toBe(false);
  });

  it('only the current speech generation can end speech ownership', () => {
    const arbiter = new AvatarMotionArbiter();
    const first = arbiter.beginSpeech();
    const second = arbiter.beginSpeech();

    expect(arbiter.endSpeech(first)).toBe(false);
    expect(arbiter.getMode()).toBe('speech');
    expect(arbiter.endSpeech(second)).toBe(true);
    expect(arbiter.getMode()).toBe('idle');
    expect(arbiter.canRunIdle()).toBe(true);
  });

  it('pose lock rejects every body-motion source while speech ownership stays available for face and audio', () => {
    const arbiter = new AvatarMotionArbiter();

    expect(arbiter.setPoseLocked(true)).toBe(true);
    expect(arbiter.isPoseLocked()).toBe(true);
    expect(arbiter.canRunIdle()).toBe(false);
    expect(arbiter.canRunSpeechMotion()).toBe(false);
    expect(arbiter.requestPreview()).toEqual({ accepted: false, reason: 'pose-locked' });

    const speech = arbiter.beginSpeech();
    expect(arbiter.isCurrentSpeech(speech)).toBe(true);
    expect(arbiter.canRunSpeechMotion()).toBe(false);
    expect(arbiter.endSpeech(speech)).toBe(true);

    expect(arbiter.setPoseLocked(false)).toBe(false);
    expect(arbiter.canRunIdle()).toBe(true);
    expect(arbiter.canRunSpeechMotion()).toBe(true);
  });

  it('changes pose lock only while idle', () => {
    const arbiter = new AvatarMotionArbiter();
    const speech = arbiter.beginSpeech();
    expect(arbiter.setPoseLocked(true)).toBe(false);
    expect(arbiter.isPoseLocked()).toBe(false);
    arbiter.endSpeech(speech);

    const preview = arbiter.requestPreview();
    expect(preview.accepted).toBe(true);
    expect(arbiter.setPoseLocked(true)).toBe(false);
    expect(arbiter.isPoseLocked()).toBe(false);
  });
});
