import { describe, expect, it } from 'vitest';
import {
  derivePerformanceSemantic,
  resolvePlaybackSemantic
} from '../../src/performance/semantic-performance';

describe('derivePerformanceSemantic', () => {
  it('classifies thanks as gratitude instead of a generic explanation', () => {
    expect(derivePerformanceSemantic('谢谢你一直认真帮我。')).toMatchObject({
      emotion: 'grateful',
      intent: 'gratitude'
    });
  });
  it.each([
    ['你好，欢迎回来', 'happy', 'greeting'],
    ['请来这边坐吧', 'happy', 'inviting'],
    ['让我认真想一想', 'serious', 'thinking'],
    ['这件事让我有些担心', 'concerned', 'concerned'],
    ['这样说有点害羞', 'shy', 'shy'],
    ['居然会这样！', 'surprised', 'surprised'],
    ['这件事必须认真说明', 'serious', 'explaining']
  ])('%s -> %s/%s', (text, emotion, intent) => {
    expect(derivePerformanceSemantic(text)).toMatchObject({ emotion, intent });
  });

  it('recognizes implicit shy stage directions', () => {
    const text = '指挥……(耳尖微红)您这是在夸我吗？(慌乱地移开视线)我只是刚好站在这里而已。(手指不自觉地摩挲着鸢尾书签)';
    expect(derivePerformanceSemantic(text)).toMatchObject({
      emotion: 'shy',
      intent: 'shy',
      gaze: 'side-down'
    });
  });

  it.each([
    ['(一怔，睁大眼)怎么会这样？', 'surprised', 'surprised'],
    ['(咬牙攥紧拳)我不能接受。', 'angry', 'rejecting'],
    ['(眼神黯淡，轻声叹气)我没事。', 'sad', 'concerned'],
    ['(眉头微蹙)你还好吗？', 'concerned', 'concerned'],
    ['(歪着头)为什么呢？', 'curious', 'questioning'],
    ['(嘴角上扬)终于成功了。', 'happy', 'affirmative'],
    ['(狡黠地眨眨眼)只是逗你玩的。', 'playful', 'playful'],
  ])('隐含动作 %s -> %s/%s', (text, emotion, intent) => {
    expect(derivePerformanceSemantic(text)).toMatchObject({ emotion, intent });
  });

  it.each([
    ['完全不敢相信，简直惊呆了！', 'shocked', 'surprised'],
    ['气死我了，绝对不能原谅。', 'furious', 'rejecting'],
    ['我好委屈，心都要碎了。', 'heartbroken', 'concerned'],
    ['太尴尬了，我刚才说错话了。', 'embarrassed', 'shy'],
    ['真的吗？我对此表示怀疑。', 'skeptical', 'questioning'],
    ['对不起，是我的错。', 'apologetic', 'apologizing'],
    ['放心交给我，我一定可以做到。', 'confident', 'encouraging'],
    ['我激动得都快跳起来了！', 'excited', 'affirmative'],
    ['太棒了，我开心得不得了！', 'delighted', 'affirmative'],
  ])('更强/含蓄情绪 %s -> %s/%s', (text, emotion, intent) => {
    expect(derivePerformanceSemantic(text)).toMatchObject({ emotion, intent });
  });

  it('未知内容安全降级 serious/explaining', () => {
    expect(derivePerformanceSemantic('普通内容')).toEqual({
      emotion: 'serious', intent: 'explaining', intensity: 0.5, gaze: 'user'
    });
  });

  it.each([
    ['gentle', 'serious', 0.4, 'user'],
    ['comfort', 'concerned', 0.45, 'user'],
    ['sad', 'concerned', 0.5, 'side-down'],
    ['happy', 'happy', 0.65, 'user'],
    ['excited', 'happy', 0.75, 'user'],
    ['question', 'serious', 0.5, 'user']
  ])('Chat5 TTS emotion %s 自动映射为 %s', (ttsEmotion, emotion, intensity, gaze) => {
    expect(derivePerformanceSemantic('普通回复内容', ttsEmotion)).toMatchObject({
      emotion,
      intensity,
      gaze
    });
  });

  it('TTS 情绪决定表情，正文仍决定 intent', () => {
    expect(derivePerformanceSemantic('让我认真想一想', 'comfort')).toEqual({
      emotion: 'concerned',
      intent: 'thinking',
      intensity: 0.45,
      gaze: 'side-down'
    });
  });

  it('未知 TTS 情绪退回正文派生', () => {
    expect(derivePerformanceSemantic('这样说有点害羞', 'unknown-profile')).toMatchObject({
      emotion: 'shy',
      intent: 'shy'
    });
  });

  it('同一句同时包含情绪词和动作意图时，动作意图优先', () => {
    const semantic = derivePerformanceSemantic('让我想一想……这样说有点害羞，不过我会认真陪你。', 'shy');
    expect(semantic.emotion).toBe('shy');
    expect(semantic.intent).toBe('thinking');
    expect(semantic.gaze).toBe('side-down');
  });

  it('keeps a caring musical invitation gentle even when it contains one question', () => {
    const semantic = derivePerformanceSemantic(
      '指挥，窗外的风似乎停了，空气里只剩下琴弦微颤的余音。这静谧的时刻，你是在忙些什么呢？若得闲，不妨来听听这首新谱的曲子。愿旋律如晚风般轻柔，拂去你一日的疲惫。',
      'question'
    );
    expect(semantic).toMatchObject({ emotion: 'gentle', intent: 'explaining', gaze: 'user' });
  });

  it('preserves the complete task-bound semantic that was resolved with the actual WAV', () => {
    const provided = {
      emotion: 'concerned' as const,
      intent: 'thinking',
      intensity: 0.45,
      gaze: 'side-down' as const
    };

    expect(resolvePlaybackSemantic('太好了，我很开心！', provided)).toEqual(provided);
  });

  it('safely fills partial playback semantic and clamps intensity', () => {
    expect(resolvePlaybackSemantic('让我想一想。', {
      emotion: 'shy',
      intensity: 4
    })).toEqual({
      emotion: 'shy',
      intent: 'thinking',
      intensity: 1,
      gaze: 'side-down'
    });
    expect(resolvePlaybackSemantic('这件事让我担心。', {
      emotion: 'not-a-real-emotion' as any,
      intent: '  '
    })).toMatchObject({ emotion: 'concerned', intent: 'concerned' });
  });

  it('does not let a weak question semantic erase shy stage directions', () => {
    expect(resolvePlaybackSemantic('您这是在夸我吗？(耳尖微红，慌乱地移开视线)', {
      emotion: 'curious',
      intent: 'questioning',
      intensity: 0.46,
      gaze: 'user',
      voiceEmotion: 'question'
    })).toMatchObject({ emotion: 'shy', intent: 'shy', gaze: 'side-down' });
  });

  it('keeps strong non-shy text evidence over a weak generic label', () => {
    expect(resolvePlaybackSemantic('(一怔，睁大眼)怎么会这样？', {
      emotion: 'curious',
      intent: 'questioning',
      intensity: 0.46,
      gaze: 'user',
      voiceEmotion: 'question'
    })).toMatchObject({ emotion: 'surprised', intent: 'surprised', gaze: 'user' });
  });

  it('normalizes common model aliases before choosing expression and motion semantics', () => {
    expect(resolvePlaybackSemantic('我会做到的。', {
      emotion: 'determined' as any,
      intent: 'encourage',
      voiceEmotion: 'firm' as any,
      intensity: 0.6,
      gaze: 'user'
    })).toMatchObject({
      emotion: 'confident',
      intent: 'encouraging',
      voiceEmotion: 'strong',
      gaze: 'user'
    });
  });
});
