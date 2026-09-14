import { describe, expect, it } from 'vitest';
import type { AvatarPerformanceProfile } from '../../src/actor/avatar-performance-profile';
import { buildSpeechExpressionPool } from '../../src/performance/speech-expression-pool';
import type { AcceptedExpressionRecord } from '../../src/performance/daily-candidate-types';

const profile: AvatarPerformanceProfile = {
  profileVersion: 2,
  avatarSha256: 'A'.repeat(64),
  modelId: 'test-model',
  visemes: { A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お' },
  blinkMorph: 'まばたき',
  expressions: {},
  mouthStyles: {},
  facialChannels: {
    browInnerUp: { morphs: [{ name: '困る', scale: 1 }], maxWeight: 0.5 },
    eyeSquintLeft: { morphs: [{ name: '左笑眼', scale: 1 }], maxWeight: 0.4 },
    eyeSquintRight: { morphs: [{ name: '右笑眼', scale: 1 }], maxWeight: 0.4 },
    eyeSmile: { morphs: [{ name: '笑い', scale: 1 }], maxWeight: 0.5 },
    eyeLidClose: { morphs: [{ name: 'まばたき', scale: 1 }], maxWeight: 0.55 },
    mouthSmileLeft: { morphs: [{ name: '左嘴角', scale: 1 }], maxWeight: 0.4 },
    mouthSmileRight: { morphs: [{ name: '右嘴角', scale: 1 }], maxWeight: 0.4 }
  },
  gaze: { supported: true, leftEyeBone: '左目', rightEyeBone: '右目', bothEyesBone: '両目' },
  conversationMotionIds: []
};

const acceptedExpression: AcceptedExpressionRecord = {
  kind: 'expression',
  id: 'expression-gentle-accepted',
  displayName: '温柔候选表情',
  emotion: 'gentle',
  durationSeconds: 2,
  source: {
    sourceType: 'generated',
    sourceUrl: 'generated://daily/gentle',
    author: 'ChatX2',
    statedTerms: 'original local candidate',
    downloadedAt: '2026-08-15T00:00:00.000Z',
    sha256: 'A'.repeat(64),
    sourceRelativePath: 'generated/gentle.json'
  },
  status: 'accepted',
  automatic: true,
  acceptedAt: '2026-08-15T01:00:00.000Z',
  channelCurves: {
    eyeSmile: [{ timeSeconds: 0.5, value: 0.2 }],
    mouthSmileLeft: [{ timeSeconds: 0.5, value: 0.25 }]
  }
};

describe('speech expression pool', () => {
  it('exposes shared semantic recipes with per-model channel support', () => {
    const pool = buildSpeechExpressionPool(profile);
    const happy = pool.find(entry => entry.id === 'happy');
    expect(pool.length).toBeGreaterThanOrEqual(15);
    expect(happy?.name).toBe('开心');
    expect(happy?.previewOnly).toBe(false);
    expect(happy?.automatic).toBe(true);
    expect(happy?.microAccents).toEqual(['warm-eye-smile', 'brief-brighten']);
    expect(happy?.supported).toBe(true);
    expect(happy?.supportedChannels).toContain('mouthSmileLeft');
    expect(happy?.missingChannels).toContain('cheekRaiseLeft');
    expect(happy?.channels.find(channel => channel.id === 'mouthSmileLeft')).toMatchObject({
      name: '双嘴角微扬',
      supported: true
    });
  });

  it('exposes paired brows, eyes and mouth corners as synchronized previews', () => {
    const neutral = buildSpeechExpressionPool(profile).find(entry => entry.id === 'neutral');
    expect(neutral?.channels).toHaveLength(3);
    expect(neutral?.channels.map(channel => channel.id)).toEqual([
      'eyeSquintLeft', 'eyeSmile', 'mouthSmileLeft'
    ]);
    expect(neutral?.channels.every(channel => channel.supported)).toBe(true);
    expect(neutral?.channels.every(channel => channel.weight >= 0.38)).toBe(true);
  });

  it('marks a recipe unsupported when none of its native channels are mapped', () => {
    const pool = buildSpeechExpressionPool({ ...profile, facialChannels: {} });
    expect(pool.find(entry => entry.id === 'happy')?.supported).toBe(false);
  });

  it('appends accepted dynamic expressions without exposing unaccepted candidates', () => {
    const pool = buildSpeechExpressionPool(profile, [acceptedExpression]);
    const accepted = pool.find(entry => entry.id === acceptedExpression.id);

    expect(accepted).toMatchObject({
      id: acceptedExpression.id,
      name: acceptedExpression.displayName,
      automatic: true,
      previewOnly: false,
      supported: true
    });
    expect(accepted?.supportedChannels).toEqual(['eyeSmile', 'mouthSmileLeft']);
  });
});
