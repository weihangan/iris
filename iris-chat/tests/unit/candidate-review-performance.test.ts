import { describe, expect, it } from 'vitest';
import { selectCandidateReviewPerformance } from '../../src/performance/candidate-review-performance';

describe('selectCandidateReviewPerformance', () => {
  it.each([
    ['不是这样的，我们换个思路吧。', 'concerned-soft', 'disagree-small', 'user', 'concerned', 0.45],
    ['原来如此，我明白你的意思了。', 'gentle-smile', 'acknowledge-small', 'user', 'smile', 0.45],
    ['让我想一想，这里可能还有一种办法。', 'thinking-serious', 'thinking-deep', 'side-down', 'thinking', 0.55],
    ['对了，我想到一个更合适的做法。', 'surprised-to-happy', 'realization-small', 'user', 'surprised', 0.65],
    ['这次真的做得很好，我很开心。', 'warm-happy', 'giggle-small', 'user', 'happy', 0.65],
    ['你这样夸我……我会有点不好意思的。', 'shy-side-down', 'shy-glance', 'side-down', 'shy', 0.55]
  ])('%s selects %s/%s', (text, expressionId, cueId, gaze, emotion, intensity) => {
    expect(selectCandidateReviewPerformance({
      text,
      durationSeconds: 3,
      ttsReady: true
    })).toMatchObject({ expressionId, cueId, gaze, emotion, intensity });
  });

  it('strong resolved shy TTS emotion selects the shy cue for otherwise ambiguous text', () => {
    expect(selectCandidateReviewPerformance({
      text: '谢谢你这样说。',
      ttsEmotion: 'shy',
      durationSeconds: 3,
      ttsReady: true
    })).toMatchObject({
      expressionId: 'shy-side-down',
      cueId: 'shy-glance',
      gaze: 'side-down'
    });
  });

  it('unknown text fails closed to a gentle expression without motion', () => {
    expect(selectCandidateReviewPerformance({
      text: '今天是星期一。',
      durationSeconds: 3,
      ttsReady: true
    })).toEqual({
      cueId: null,
      expressionId: 'gentle-neutral',
      gaze: 'user',
      emotion: 'serious',
      intensity: 0.3
    });
  });

  it('does not treat a gentle suggestion containing 来 as an invitation gesture', () => {
    expect(selectCandidateReviewPerformance({
      text: '指挥，窗外的风似乎停了，空气里只剩下琴弦微颤的余音。(轻抚琴盖) 这静谧的时刻，你此刻……是在忙些什么呢？若得闲，不妨来听听这首新谱的曲子。愿旋律能如晚风般轻柔，拂去你一日的疲惫。',
      durationSeconds: 29.6,
      ttsReady: true
    })).toMatchObject({ cueId: null, expressionId: 'gentle-neutral', gaze: 'user' });
  });

  it.each([
    ['short audio', { durationSeconds: 0.8 }],
    ['TTS not ready', { ttsReady: false }],
    ['muted', { muted: true }],
    ['proactive', { proactive: true }],
    ['cancelled', { cancelled: true }],
    ['stale', { stale: true }]
  ])('%s suppresses the speaking gesture', (_name, override) => {
    const result = selectCandidateReviewPerformance({
      text: '对了，我想到一个更合适的做法。',
      durationSeconds: 3,
      ttsReady: true,
      ...override
    });
    expect(result.cueId).toBeNull();
  });

  it('explicit thinking/realization intent wins before generic happy or shy words', () => {
    expect(selectCandidateReviewPerformance({
      text: '对了，我想到一个更合适的做法，虽然有点不好意思，但我很开心。',
      ttsEmotion: 'shy',
      durationSeconds: 3,
      ttsReady: true
    })).toMatchObject({
      cueId: 'realization-small',
      expressionId: 'surprised-to-happy'
    });
  });
});
