import { describe, expect, it } from 'vitest';
import { SpeechMotionDirector } from '../../src/performance/speech-motion-director';

describe('SpeechMotionDirector', () => {
  it('keeps the current idle visible while speech is preparing', () => {
    const director = new SpeechMotionDirector();
    const generation = director.prepare('reply-1');

    expect(director.getPhase()).toBe('preparing');
    expect(director.shouldStopVisibleMotion(generation)).toBe(false);
  });

  it('blocks an arm accent during the first 600ms of audio', () => {
    const director = new SpeechMotionDirector({ leadInMs: 600 });
    const generation = director.prepare('reply-1');
    expect(director.beginAudio(generation, 10_000, 4)).toBe(true);

    expect(director.claimAccent(generation, 'raise-hand', 10_599, 'arms')).toBe(false);
    expect(director.claimAccent(generation, 'raise-hand', 10_600, 'arms')).toBe(true);
  });

  it('allows the first selected voice-pool action immediately by default', () => {
    const director = new SpeechMotionDirector();
    const generation = director.prepare('reply-immediate');
    expect(director.beginAudio(generation, 10_000, 2)).toBe(true);

    expect(director.claimAccent(generation, 'user-selected.vmd', 10_000, 'body')).toBe(true);
  });

  it('allows at most one accent for a short reply and three for a long reply', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, longReplySeconds: 12 });
    const shortGeneration = director.prepare('short');
    director.beginAudio(shortGeneration, 0, 4);
    expect(director.claimAccent(shortGeneration, 'one', 0, 'arms')).toBe(true);
    expect(director.claimAccent(shortGeneration, 'two', 1000, 'arms')).toBe(false);
    director.end(shortGeneration);
    director.completeExit(shortGeneration);

    const longGeneration = director.prepare('long');
    director.beginAudio(longGeneration, 0, 20);
    expect(director.claimAccent(longGeneration, 'one-long', 0, 'arms')).toBe(true);
    // Long-reply slots are paced across the audio instead of being consumed
    // by the first few semantic cues.
    expect(director.claimAccent(longGeneration, 'two-long', 5000, 'arms')).toBe(false);
    expect(director.claimAccent(longGeneration, 'two-long', 7_000, 'arms')).toBe(true);
    expect(director.claimAccent(longGeneration, 'three-long', 10_000, 'arms')).toBe(false);
    expect(director.claimAccent(longGeneration, 'three-long', 14_000, 'arms')).toBe(true);
    expect(director.claimAccent(longGeneration, 'four-long', 15_000, 'arms')).toBe(false);
  });

  it('reserves later accent slots across a cached long reply', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, longReplySeconds: 12 });
    const generation = director.prepare('cached-long');
    expect(director.beginAudio(generation, 0, 25.6)).toBe(true);
    expect(director.claimAccent(generation, 'opening', 0)).toBe(true);
    expect(director.claimAccent(generation, 'early', 4500)).toBe(false);
    expect(director.claimAccent(generation, 'middle', 9000)).toBe(true);
    expect(director.claimAccent(generation, 'late', 18000)).toBe(true);
  });

  it('reports a reserved slot as deferred so the current cue can be retried', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, longReplySeconds: 12 });
    const generation = director.prepare('retry-long');
    director.beginAudio(generation, 1000, 24);
    expect(director.claimAccent(generation, 'opening', 1000)).toBe(true);
    expect(director.shouldDeferAccent(generation, 7000)).toBe(true);
    expect(director.shouldDeferAccent(generation, 9000)).toBe(false);
  });

  it('expands the long-reply budget enough to vary motion within every ten seconds', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, longReplySeconds: 12 });
    const generation = director.prepare('very-long');
    director.beginAudio(generation, 0, 36);

    expect(director.claimAccent(generation, 'one', 0, 'body')).toBe(true);
    expect(director.claimAccent(generation, 'two', 9_000, 'body')).toBe(true);
    expect(director.claimAccent(generation, 'three', 18_000, 'body')).toBe(true);
    expect(director.claimAccent(generation, 'four', 27_000, 'body')).toBe(true);
  });

  it('permits one validated emotion-turn handoff on an otherwise short reply', () => {
    const director = new SpeechMotionDirector({
      leadInMs: 0,
      longReplySeconds: 12,
      shortReplyAccentLimit: 1,
      stableAccentGapMs: 1200,
      emotionTurnGapMs: 650
    });
    const generation = director.prepare('turning-short');
    director.beginAudio(generation, 0, 4);

    expect(director.claimAccent(generation, 'opening', 0, 'body')).toBe(true);
    // The normal 1.2s decorative gap and one-accent budget would reject this;
    // a semantic turn is admitted once the opening pose was visible for 650ms.
    expect(director.claimAccent(
      generation,
      'turn',
      650,
      'body',
      { emotionTurn: true }
    )).toBe(true);
    // A third action is still rejected, so a noisy timeline cannot keep
    // replacing the body indefinitely.
    expect(director.claimAccent(
      generation,
      'third',
      2_000,
      'body',
      { emotionTurn: true }
    )).toBe(false);
  });

  it('paces a default emotion-turn handoff more calmly than a decorative accent', () => {
    // 渲染器用无参构造（默认间隔）。语义转折的换手间隔从 650ms 放宽到
    // 1100ms：650ms 内刚起的手势还没被看清就换下一个，读作突变。
    const director = new SpeechMotionDirector();
    const generation = director.prepare('calm-turn');
    director.beginAudio(generation, 0, 4);

    expect(director.claimAccent(generation, 'opening', 0, 'body')).toBe(true);
    expect(director.claimAccent(generation, 'turn', 1_000, 'body', { emotionTurn: true })).toBe(false);
    expect(director.claimAccent(generation, 'turn', 1_200, 'body', { emotionTurn: true })).toBe(true);
  });

  it('keeps the ordinary stable gap for non-turn accents', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, stableAccentGapMs: 1200, emotionTurnGapMs: 650 });
    const generation = director.prepare('ordinary-gap');
    director.beginAudio(generation, 0, 20);
    expect(director.claimAccent(generation, 'first', 0)).toBe(true);
    expect(director.claimAccent(generation, 'second', 900)).toBe(false);
  });

  it('requires a stable gap between major body accents', () => {
    const director = new SpeechMotionDirector({
      leadInMs: 0,
      longReplySeconds: 12,
      stableAccentGapMs: 1200
    });
    const generation = director.prepare('long-stable');
    director.beginAudio(generation, 0, 20);

    expect(director.claimAccent(generation, 'one', 0, 'body')).toBe(true);
    expect(director.claimAccent(generation, 'two', 1199, 'body')).toBe(false);
    expect(director.claimAccent(generation, 'two', 6_700, 'body')).toBe(true);
  });

  it('uses mode-specific short and long reply accent budgets', () => {
    const director = new SpeechMotionDirector({
      leadInMs: 0,
      longReplySeconds: 12,
      shortReplyAccentLimit: 2,
      longReplyAccentLimit: 4,
      stableAccentGapMs: 0
    });
    const generation = director.prepare('detailed');
    director.beginAudio(generation, 0, 20);

    expect(director.claimAccent(generation, 'accent-0', 0, 'arms')).toBe(true);
    expect(director.claimAccent(generation, 'accent-1', 1000, 'arms')).toBe(false);
    expect(director.claimAccent(generation, 'accent-1', 7000, 'arms')).toBe(true);
    expect(director.claimAccent(generation, 'accent-2', 14000, 'arms')).toBe(true);
    expect(director.claimAccent(generation, 'accent-3', 20000, 'arms')).toBe(true);
    expect(director.claimAccent(generation, 'accent-5', 25000, 'arms')).toBe(false);
  });

  it('invalidates late work from a superseded preparation', () => {
    const director = new SpeechMotionDirector();
    const stale = director.prepare('old');
    const current = director.prepare('new');

    expect(director.beginAudio(stale, 0, 4)).toBe(false);
    expect(director.isCurrent(stale)).toBe(false);
    expect(director.beginAudio(current, 0, 4)).toBe(true);
  });

  it('exposes the previous three replies to the Planner but admits its exhausted-pool fallback', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, recentReplyWindow: 3 });

    for (const [taskId, motionId] of [['r1', 'nod'], ['r2', 'think'], ['r3', 'smile']] as const) {
      const generation = director.prepare(taskId);
      director.beginAudio(generation, 0, 4);
      expect(director.claimAccent(generation, motionId, 0, 'arms')).toBe(true);
      director.end(generation);
      director.completeExit(generation);
    }

    const fourth = director.prepare('r4');
    director.beginAudio(fourth, 0, 4);
    expect(new Set(director.getUnavailableMotionIds())).toEqual(new Set(['nod', 'think', 'smile']));
    // The Planner normally avoids these IDs. If no alternative exists it can
    // deliberately relax history, and the Director must not create a silent
    // no-motion reply by rejecting that fallback a second time.
    expect(director.claimAccent(fourth, 'nod', 0, 'arms')).toBe(true);
  });

  it('schedules the background decision only once per reply', () => {
    const director = new SpeechMotionDirector({ leadInMs: 600 });
    const generation = director.prepare('reply-1');
    director.beginAudio(generation, 1000, 4);

    expect(director.claimBackgroundDecision(generation)).toBe(true);
    expect(director.claimBackgroundDecision(generation)).toBe(false);
  });

  it('does not count the user-selected background as a recent accent', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, recentReplyWindow: 3 });
    const generation = director.prepare('background-only');
    director.beginAudio(generation, 0, 5);

    expect(director.claimBackgroundDecision(generation)).toBe(true);
    director.end(generation);
    director.completeExit(generation);

    expect(director.getUnavailableMotionIds()).toEqual([]);
  });

  it('reports current and recent reply motions as unavailable to the planner', () => {
    const director = new SpeechMotionDirector({ leadInMs: 0, recentReplyWindow: 3 });
    const first = director.prepare('first');
    director.beginAudio(first, 0, 4);
    director.claimAccent(first, 'recent.vmd', 0);
    director.end(first);
    director.completeExit(first);

    const second = director.prepare('second');
    director.beginAudio(second, 0, 20);
    director.claimAccent(second, 'current.vmd', 0);

    expect(new Set(director.getUnavailableMotionIds())).toEqual(
      new Set(['recent.vmd', 'current.vmd'])
    );
  });
});
