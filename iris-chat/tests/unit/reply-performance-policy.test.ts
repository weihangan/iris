import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const policy = require('../../chat5-compat/services/replyPerformancePolicy.js') as {
  extractReplyPerformance: (reply: string) => { cleanReply: string; raw: Record<string, unknown> | null };
  normalizeReplyPerformance: (raw: Record<string, unknown> | null, reply: string) => any;
  applyPerformanceSegmentTags: (text: string, segments: unknown[]) => string;
};

describe('reply performance policy', () => {
  it('removes nested hidden metadata from the visible reply and preserves only valid fields', () => {
    const rawReply = '先别急，我会陪你把这一点理清。<!--performance:{"user_emotion":"焦虑","user_intensity":3,"character_emotion":"克制关注","character_intensity":2,"voice_emotion":"comfort","performance_emotion":"concerned","intent":"reassuring","gaze":"user","confidence":0.68,"inference":"implicit","evidence":"用户反复确认结果且说不敢看","emphasis":[{"text":"我会陪你","tone":"坚定","strength":0.55}]}-->';
    const extracted = policy.extractReplyPerformance(rawReply);
    const performance = policy.normalizeReplyPerformance(extracted.raw, extracted.cleanReply);

    expect(extracted.cleanReply).toBe('先别急，我会陪你把这一点理清。');
    expect(performance).toMatchObject({
      voiceEmotion: 'comfort',
      emotion: 'concerned',
      intent: 'reassuring',
      source: 'model'
    });
    expect(performance.emphasis).toEqual([{ text: '我会陪你', tone: '坚定', strength: 0.55 }]);
  });

  it('limits unsupported implicit guesses and rejects emphasis that is not in the reply', () => {
    const reply = '我们先把已知的部分列出来。';
    const performance = policy.normalizeReplyPerformance({
      voice_emotion: 'sad',
      performance_emotion: 'sad',
      confidence: 0.99,
      inference: 'implicit',
      evidence: '用户用了一个普通问号',
      emphasis: [{ text: '不存在的短语', tone: '悲伤', strength: 0.9 }]
    }, reply);

    expect(performance.confidence).toBe(0.72);
    expect(performance.emphasis).toEqual([]);
  });

  it('recognizes implicit shy stage directions instead of downgrading to a question', () => {
    const reply = '指挥……(耳尖微红)您这是在夸我吗？(慌乱地移开视线)我……我只是刚好站在这里而已。(手指不自觉地摩挲着鸢尾书签)';
    const performance = policy.normalizeReplyPerformance(null, reply);
    expect(performance).toMatchObject({
      voiceEmotion: 'shy_happy',
      emotion: 'shy',
      intent: 'shy',
      gaze: 'side-down',
      source: 'fallback'
    });
  });

  it('lets strong shy stage directions override a weak model question label', () => {
    const reply = '您这是在夸我吗？(耳尖泛红，慌乱地移开视线)';
    const performance = policy.normalizeReplyPerformance({
      voice_emotion: 'question',
      performance_emotion: 'curious',
      intent: 'questioning',
      confidence: 0.65,
      inference: 'implicit',
      evidence: '句末问号'
    }, reply);
    expect(performance).toMatchObject({ voiceEmotion: 'shy_happy', emotion: 'shy', intent: 'shy' });
  });

  it('lets other strong stage directions override a weak generic label', () => {
    const reply = '(一怔，睁大眼)怎么会这样？';
    const performance = policy.normalizeReplyPerformance({
      voice_emotion: 'question',
      performance_emotion: 'curious',
      intent: 'questioning',
      confidence: 0.65,
      inference: 'implicit',
      evidence: '句末问号'
    }, reply);
    expect(performance).toMatchObject({ emotion: 'surprised', intent: 'surprised', gaze: 'user' });
  });

  it('recognizes non-shy implicit emotion families instead of falling back to a generic question', () => {
    expect(policy.normalizeReplyPerformance(null, '我好委屈，心都要碎了。')).toMatchObject({
      emotion: 'heartbroken', intent: 'concerned', gaze: 'side-down'
    });
    expect(policy.normalizeReplyPerformance(null, '对不起，是我的错。')).toMatchObject({
      emotion: 'apologetic', intent: 'apologizing', gaze: 'side-down'
    });
    expect(policy.normalizeReplyPerformance(null, '放心交给我，我一定可以做到。')).toMatchObject({
      emotion: 'confident', intent: 'encouraging', gaze: 'user'
    });
  });

  it('normalizes common model aliases before motion and face selection', () => {
    expect(policy.normalizeReplyPerformance({
      voice_emotion: 'firm', performance_emotion: 'determined', intent: 'encourage',
      confidence: 0.7, inference: 'implicit', evidence: '坚定承诺'
    }, '我会做到。')).toMatchObject({
      voiceEmotion: 'strong', emotion: 'confident', intent: 'encouraging'
    });
  });

  it('accepts only ordered phrase-level emotion turns and creates TTS-only tags', () => {
    const reply = '这件事确实不容易。可是我会陪你把下一步做好。';
    const performance = policy.normalizeReplyPerformance({
      confidence: 0.65,
      inference: 'implicit',
      evidence: '前半承认困难，后半给出坚定承诺',
      segments: [
        { text: '这件事确实不容易。', voice_emotion: 'sad', performance_emotion: 'concerned', intent: 'concerned', intensity: 0.45, gaze: 'side-down', confidence: 0.65 },
        { text: '可是我会陪你把下一步做好。', voice_emotion: 'strong', performance_emotion: 'confident', intent: 'encouraging', intensity: 0.58, gaze: 'user', confidence: 0.65 }
      ]
    }, reply);

    expect(performance.segments).toHaveLength(2);
    expect(policy.applyPerformanceSegmentTags(reply, performance.segments as unknown[])).toBe(
      '[语气:悲伤]这件事确实不容易。[/语气][语气:坚定]可是我会陪你把下一步做好。[/语气]'
    );
  });
});
