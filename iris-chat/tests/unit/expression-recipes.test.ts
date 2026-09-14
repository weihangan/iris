import { describe, expect, it } from 'vitest';
import {
  createExpressionChannelPose,
  createExpressionPose,
  deriveFacialEmotion,
  getExpressionRecipeDefinitions
} from '../../src/performance/expression-recipes';
import { FACIAL_CHANNELS, type FacialPose } from '../../src/performance/facial-pose';

function activeChannels(pose: FacialPose): string[] {
  return FACIAL_CHANNELS.filter(channel => pose[channel] > 0.001);
}

function poseDistance(left: FacialPose, right: FacialPose): number {
  return FACIAL_CHANNELS.reduce((sum, channel) => sum + Math.abs(left[channel] - right[channel]), 0);
}

describe('expression recipes', () => {
  it.each([
    ['终于见到你了，我真的太兴奋了！', 'happy', 'excited'],
    ['想到这件事，我真的很难过。', 'concerned', 'sad'],
    ['别害怕，我会温柔地陪着你。', 'serious', 'gentle'],
    ['这件事让我有些担心。', 'concerned', 'concerned'],
    ['这样说有点不好意思。', 'shy', 'shy']
  ] as const)('refines only the facial emotion for %s', (text, baseEmotion, facialEmotion) => {
    expect(deriveFacialEmotion(text, baseEmotion)).toBe(facialEmotion);
  });

  it.each([
    ['太棒了，我简直开心得不得了！', 'happy', 'delighted'],
    ['这也太震惊了，我完全不敢相信！', 'surprised', 'shocked'],
    ['这真的气死我了，绝对不能原谅！', 'angry', 'furious'],
    ['我真的好委屈，心都要碎了。', 'sad', 'heartbroken'],
    ['真的吗？我对此表示怀疑。', 'curious', 'skeptical'],
    ['太尴尬了，我刚才说错话了。', 'shy', 'embarrassed']
  ] as const)('selects exaggerated universal expression for %s', (text, baseEmotion, facialEmotion) => {
    expect(deriveFacialEmotion(text, baseEmotion)).toBe(facialEmotion);
    expect(activeChannels(createExpressionPose(facialEmotion, 1, 1)).length).toBeGreaterThanOrEqual(4);
  });

  it('publishes at least six exaggerated recipes in the shared pool', () => {
    const definitions = new Set(getExpressionRecipeDefinitions().map(recipe => recipe.id));
    for (const id of ['delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed']) {
      expect(definitions.has(id as any)).toBe(true);
    }
    expect(definitions.size).toBeGreaterThanOrEqual(26);
  });

  it.each([
    ['happy', ['eyeSquintLeft', 'eyeSquintRight', 'mouthSmileLeft', 'mouthSmileRight']],
    ['shy', ['browInnerUp', 'eyeSquintLeft', 'mouthSmileLeft', 'blush']],
    ['concerned', ['browInnerUp', 'mouthFrownLeft', 'mouthFrownRight']],
    ['sad', ['browInnerUp', 'eyeSquintLeft', 'mouthFrownLeft']],
    ['angry', ['browDownLeft', 'browDownRight', 'mouthFrownLeft', 'mouthClose']],
    ['surprised', ['browInnerUp', 'eyeWideLeft', 'eyeWideRight', 'jawOpen']],
    ['gentle', ['eyeSquintLeft', 'eyeSquintRight', 'mouthSmileLeft']],
    ['loving', ['eyeSquintLeft', 'mouthSmileLeft', 'mouthSmileRight']]
  ] as const)('%s uses a compound facial pose', (emotion, requiredChannels) => {
    const pose = createExpressionPose(emotion, 1, 1);

    expect(activeChannels(pose).length).toBeGreaterThanOrEqual(3);
    for (const channel of requiredChannels) {
      expect(pose[channel]).toBeGreaterThan(0);
    }
  });

  it('thinking uses an asymmetric brow and restrained lips', () => {
    const pose = createExpressionPose('thinking', 1, 1);

    expect(pose.browOuterUpLeft).toBeGreaterThan(pose.browOuterUpRight);
    expect(pose.eyeSquintLeft).toBeGreaterThan(0);
    expect(pose.mouthPucker).toBeGreaterThan(0);
  });

  it('shy is a strongly specialized blushing face rather than a faint smile', () => {
    const shy = createExpressionPose('shy', 1, 1);
    const gentle = createExpressionPose('gentle', 1, 1);

    expect(shy.blush).toBeCloseTo(0.35, 6);
    expect(shy.browInnerUp).toBeGreaterThanOrEqual(0.5);
    expect(shy.eyeSquintLeft).toBeGreaterThanOrEqual(0.5);
    expect(shy.eyeSquintRight).toBe(shy.eyeSquintLeft);
    expect(shy.mouthSmileLeft).toBeGreaterThanOrEqual(0.45);
    expect(shy.mouthSmileRight).toBe(shy.mouthSmileLeft);
    expect(poseDistance(shy, gentle)).toBeGreaterThan(1);
  });

  it('keeps gentle, loving, and concerned eyes readable at normal speech intensity', () => {
    const gentle = createExpressionPose('gentle', 0.6, 1);
    const loving = createExpressionPose('loving', 0.6, 1);
    const concerned = createExpressionPose('concerned', 0.6, 1);

    expect(gentle.eyeSquintLeft).toBeGreaterThanOrEqual(0.2);
    expect(gentle.eyeSmile).toBeGreaterThanOrEqual(0.16);
    expect(gentle.mouthSmileLeft).toBeGreaterThanOrEqual(0.27);
    expect(loving.eyeSquintLeft).toBeGreaterThanOrEqual(0.24);
    expect(loving.mouthSmileLeft).toBeGreaterThanOrEqual(0.3);
    expect(concerned.browInnerUp).toBeGreaterThanOrEqual(0.22);
    expect(concerned.mouthFrownLeft).toBeGreaterThanOrEqual(0.12);
  });

  it('uses visibly distinct synchronized eyelid openness levels', () => {
    const surprised = createExpressionPose('surprised', 1, 1);
    const gentle = createExpressionPose('gentle', 1, 1);
    const concerned = createExpressionPose('concerned', 1, 1);
    const sad = createExpressionPose('sad', 1, 1);

    expect(surprised.eyeLidClose).toBe(0);
    expect(gentle.eyeLidClose).toBeLessThanOrEqual(0.05);
    expect(concerned.eyeLidClose).toBeGreaterThan(gentle.eyeLidClose);
    expect(concerned.eyeLidClose).toBeLessThanOrEqual(0.14);
    expect(sad.eyeLidClose).toBeGreaterThanOrEqual(0.2);
    expect(surprised.eyeWideLeft).toBeGreaterThan(0.6);
  });

  it('does not use sustained blink morph as the default neutral or gentle look', () => {
    expect(createExpressionPose('neutral', 1, 1).eyeLidClose).toBeLessThanOrEqual(0.02);
    expect(createExpressionPose('gentle', 1, 1).eyeLidClose).toBeLessThanOrEqual(0.05);
    expect(createExpressionPose('happy', 1, 1).eyeLidClose).toBeLessThanOrEqual(0.04);
  });

  it('keeps neighboring emotion families visibly separated', () => {
    const pose = (emotion: string) => createExpressionPose(emotion, 1, 1);

    expect(poseDistance(pose('neutral'), pose('gentle'))).toBeGreaterThan(0.75);
    expect(poseDistance(pose('gentle'), pose('loving'))).toBeGreaterThan(0.55);
    expect(poseDistance(pose('smile'), pose('happy'))).toBeGreaterThan(0.55);
    expect(poseDistance(pose('concerned'), pose('sad'))).toBeGreaterThan(0.45);
    expect(poseDistance(pose('serious'), pose('angry'))).toBeGreaterThan(0.65);
    expect(poseDistance(pose('thinking'), pose('curious'))).toBeGreaterThan(0.8);
  });

  it('applies a gentle calm personality bias to comforting night dialogue', () => {
    const personality = { warmth: 0.9, calmness: 0.9, affection: 0.8, concern: 0.85 };
    expect(deriveFacialEmotion('你还没休息吗？', 'curious', personality, 0)).toBe('concerned');
    expect(deriveFacialEmotion('不妨听听我的歌声。', 'serious', personality, 1)).toBe('gentle');
    expect(deriveFacialEmotion('我愿为你奏一曲安眠的乐章，伴你度过黑夜。', 'serious', personality, 2)).toBe('loving');
  });

  it('keeps ordinary models unbiased when no facial personality is configured', () => {
    expect(deriveFacialEmotion('普通的夜晚说明。', 'serious')).toBe('serious');
  });

  it('creates a preview pose containing only the selected recipe channel', () => {
    const pose = createExpressionChannelPose('neutral', 'mouthSmileLeft', 1);
    expect(pose.mouthSmileLeft).toBeGreaterThan(0);
    expect(activeChannels(pose)).toEqual(['mouthSmileLeft']);
    expect(pose.mouthSmileLeft).toBeGreaterThanOrEqual(0.35);
  });

  it('previews eyelid close as a full blink pulse rather than a held droop', () => {
    const pose = createExpressionChannelPose('sad', 'eyeLidClose', 1);
    expect(activeChannels(pose)).toEqual(['eyeLidClose']);
    expect(pose.eyeLidClose).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps a visibly curved mouth for gentle personalities during ordinary speech', () => {
    const personality = { warmth: 0.9, calmness: 0.9, affection: 0.8, concern: 0.85 };
    const emotion = deriveFacialEmotion('我来说明一下现在的情况。', 'neutral', personality, 0);
    const pose = createExpressionPose(emotion, 0.6, 1);

    expect(emotion).toBe('gentle');
    expect(pose.eyeSmile).toBeGreaterThanOrEqual(0.16);
    expect(pose.mouthSmileLeft).toBeGreaterThanOrEqual(0.27);
    expect(pose.mouthSmileRight).toBe(pose.mouthSmileLeft);
  });

  it('scales every channel by intensity and envelope phase', () => {
    const full = createExpressionPose('happy', 1, 1);
    const partial = createExpressionPose('happy', 0.5, 0.5);

    for (const channel of FACIAL_CHANNELS) {
      expect(partial[channel]).toBeCloseTo(full[channel] * 0.25, 6);
    }
  });

  it('clamps invalid intensity and phase and keeps every channel finite in [0, 1]', () => {
    const poses = [
      createExpressionPose('surprised', 8, 4),
      createExpressionPose('angry', Number.NaN, Number.POSITIVE_INFINITY),
      createExpressionPose('unknown-emotion', 1, 1)
    ];

    for (const pose of poses) {
      for (const channel of FACIAL_CHANNELS) {
        expect(Number.isFinite(pose[channel])).toBe(true);
        expect(pose[channel]).toBeGreaterThanOrEqual(0);
        expect(pose[channel]).toBeLessThanOrEqual(1);
      }
    }
  });
});
