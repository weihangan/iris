import { describe, expect, it, vi } from 'vitest';
import type { CandidateMotionPayload } from '../../electron/candidate-review-motion-catalog';
import { CandidateReviewGestureController } from '../../src/performance/candidate-review-gesture-controller';
import type { CandidateCueId } from '../../src/performance/candidate-review-performance';

const payload: CandidateMotionPayload = {
  cueId: 'thinking-deep',
  bytes: new Uint8Array([1, 2, 3]),
  durationSeconds: 1.567,
  candidateTrackPolicy: 'dialogue-body-only',
  looping: false,
  fadeInSeconds: 0.35,
  fadeOutSeconds: 0.55
};

const input = {
  text: '让我想一想，这里可能还有一种办法。',
  durationSeconds: 3,
  ttsReady: true
} as const;

function createController(overrides?: {
  load?: (cueId: CandidateCueId) => Promise<CandidateMotionPayload | null>;
  play?: (candidate: CandidateMotionPayload) => Promise<void>;
  isCurrentSpeech?: (generation: number) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  const load = vi.fn(overrides?.load ?? (async () => payload));
  const play = vi.fn(overrides?.play ?? (async () => undefined));
  const isCurrentSpeech = vi.fn(overrides?.isCurrentSpeech ?? (() => true));
  const delay = vi.fn(overrides?.delay ?? (async () => undefined));
  const warn = vi.fn();
  return {
    controller: new CandidateReviewGestureController({ load, play, isCurrentSpeech, delay, warn }),
    load,
    play,
    isCurrentSpeech,
    warn,
    delay
  };
}

describe('CandidateReviewGestureController', () => {
  it('does not load or play before the audio start hard gate', async () => {
    const { controller, load, play } = createController();
    await expect(controller.startAfterAudio(input, 1, false)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('loads and plays exactly one semantic candidate after audio starts', async () => {
    const { controller, load, play, delay } = createController();
    await expect(controller.startAfterAudio(input, 7, true)).resolves.toBe(true);
    expect(delay).toHaveBeenCalledWith(180);
    expect(load).toHaveBeenCalledWith('thinking-deep');
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(payload);
  });

  it('reserves the generation before async loading so duplicate calls cannot double-play', async () => {
    let resolveLoad!: (value: CandidateMotionPayload | null) => void;
    const loadPromise = new Promise<CandidateMotionPayload | null>(resolve => { resolveLoad = resolve; });
    const { controller, load, play } = createController({ load: async () => loadPromise });
    const first = controller.startAfterAudio(input, 3, true);
    const duplicate = controller.startAfterAudio(input, 3, true);
    resolveLoad(payload);
    await expect(first).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('drops a candidate whose speech generation becomes stale during load', async () => {
    let current = true;
    let resolveLoad!: (value: CandidateMotionPayload | null) => void;
    const loadPromise = new Promise<CandidateMotionPayload | null>(resolve => { resolveLoad = resolve; });
    const { controller, play } = createController({
      load: async () => loadPromise,
      isCurrentSpeech: () => current
    });
    const started = controller.startAfterAudio(input, 4, true);
    current = false;
    resolveLoad(payload);
    await expect(started).resolves.toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('fails closed when the SHA catalog returns no payload', async () => {
    const { controller, play } = createController({ load: async () => null });
    await expect(controller.startAfterAudio(input, 5, true)).resolves.toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('contains motion playback failure without rejecting the audio path', async () => {
    const { controller, warn } = createController({
      play: async () => { throw new Error('motion failed'); }
    });
    await expect(controller.startAfterAudio(input, 6, true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('motion failed'));
  });

  it('reset invalidates pending work and permits the next speech generation', async () => {
    let resolveLoad!: (value: CandidateMotionPayload | null) => void;
    const loadPromise = new Promise<CandidateMotionPayload | null>(resolve => { resolveLoad = resolve; });
    const { controller, play } = createController({ load: async () => loadPromise });
    const stale = controller.startAfterAudio(input, 1, true);
    controller.reset();
    resolveLoad(payload);
    await expect(stale).resolves.toBe(false);
    await expect(controller.startAfterAudio(input, 2, true)).resolves.toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
  });
});
