/**
 * Task 0 RED/GREEN test：AvatarPerformanceProfile 校验逻辑。
 *
 * 验证：
 *   1. SHA 匹配 → valid
 *   2. SHA 不匹配 → invalid，lip/blink/blush/tears/gaze 全部禁用
 *   3. morph 不存在于 PMX → invalid
 *   4. 缺失可选 mouthStyle → 该能力禁用，其他能力不受影响
 *   5. 缺失必需 viseme → lipEnabled=false
 *   6. 缺失 blushMorph → blushEnabled=false（但不影响 valid）
 *   7. 跨模型 ID → invalid
 *   8. mirrorMorph 不存在 → invalid
 *   9. 真实 selena profile → GREEN
 *  10. 真实 yyxuanling profile → GREEN
 */
import { describe, it, expect } from 'vitest';
import {
  validateProfile,
  selectValidatedProfile,
  emotionToExpressionId,
  emotionToMouthStyleId,
  DISABLED_PROFILE,
  type AvatarPerformanceProfile
} from '../../src/actor/avatar-performance-profile';

// 模拟 PMX 能力集合
const SELENA_SHA = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';
const YYXUANLING_SHA = '6BEDE9E7A0A94C53F6F9B091F0E482624113AC44D572678B09D2FAC6B0C373BD';

const SELENA_MORPHS = new Set([
  'あ', 'い', 'う', 'え', 'お', 'まばたき',
  '真面目', '笑い', 'にこり', 'びっくり', '怒り', '困る', '照れ',
  '口角上げ左', '口角上げ右', '口角下げ左', '口角下げ右',
  '口横広げ左', '口横広げ右', '口横狭げ左', '口横狭げ右',
  'FaceRed', '涙',
  '怒り左', '怒り右', '困る左', '困る右', 'にこり左', 'にこり右',
  'びっくり左', 'びっくり2右', '目尻下げ左', '目尻下げ右'
]);

const YYXUANLING_MORPHS = new Set([
  'あ', 'い', 'う', 'え', 'お', 'まばたき',
  '真面目', '笑い', 'にこり', 'びっくり', '怒り', '困る', '照れ',
  '口角上げ', '口角下げ', 'にやり', '口横広げ',
  '左怒り', '右怒り', '左困る', '右困る', '左にこり2', '右にこり2',
  '左笑い目', '右笑い目', '左びっくり', '右びっくり',
  '左口角上げ', '右口角上げ', '左口角下げ', '右口角下げ',
  '左口横広げ', '右口横広げ', '口横狭め', '口close'
  // 注意：没有 FaceRed，没有 涙
]);

const BONES = new Set(['両目', '左目', '右目', '全ての親', 'センター', '頭']);

function makeSelenaProfile(overrides: Partial<AvatarPerformanceProfile> = {}): AvatarPerformanceProfile {
  return {
    profileVersion: 1,
    avatarSha256: SELENA_SHA,
    modelId: 'selena-xisheng',
    visemes: { A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お' },
    blinkMorph: 'まばたき',
    expressions: {
      serious: { morph: '真面目', maxWeight: 1.0 },
      happy: { morph: '笑い', maxWeight: 1.0 }
    },
    mouthStyles: {
      'mouth-corner-up': { morph: '口角上げ左', mirrorMorph: '口角上げ右', maxWeight: 0.35 }
    },
    blushMorph: 'FaceRed',
    tearsMorph: '涙',
    gaze: { supported: true, leftEyeBone: '左目', rightEyeBone: '右目', bothEyesBone: '両目' },
    conversationMotionIds: [],
    ...overrides
  };
}

describe('AvatarPerformanceProfile.validateProfile', () => {
  it('selects a SHA-bound profile only after modelId, morph and bone validation', () => {
    const result = selectValidatedProfile(
      [makeSelenaProfile()], SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng-v1'
    );
    expect(result.profile?.modelId).toBe('selena-xisheng');
    expect(result.validation.valid).toBe(true);
  });

  it('rejects a SHA match when the active model pack identifies another model', () => {
    const result = selectValidatedProfile(
      [makeSelenaProfile()], SELENA_SHA, SELENA_MORPHS, BONES, 'yyxuanling-v1'
    );
    expect(result.profile).toBeUndefined();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.reasons.some(reason => reason.includes('modelId mismatch'))).toBe(true);
  });

  it('rejects a facial channel binding whose native morph is absent', () => {
    const profile = {
      ...makeSelenaProfile(),
      profileVersion: 2,
      facialChannels: {
        browInnerUp: {
          morphs: [{ name: '不存在的眉毛', scale: 1 }],
          maxWeight: 0.5
        }
      }
    } as unknown as AvatarPerformanceProfile;

    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('facialChannel browInnerUp morph "不存在的眉毛" not found in PMX');
  });

  it('rejects a facial channel maxWeight outside [0, 1]', () => {
    const profile = {
      ...makeSelenaProfile(),
      profileVersion: 2,
      facialChannels: {
        browDownLeft: {
          morphs: [{ name: '怒り左', scale: 1 }],
          maxWeight: 1.2
        }
      }
    } as unknown as AvatarPerformanceProfile;

    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.reasons.some(reason => reason.includes('facialChannel browDownLeft maxWeight'))).toBe(true);
  });

  it('SHA 匹配 → valid', () => {
    const profile = makeSelenaProfile();
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('SHA 不匹配 → invalid，所有能力禁用', () => {
    const profile = makeSelenaProfile();
    const result = validateProfile(profile, 'WRONG_SHA', SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.lipEnabled).toBe(false);
    expect(result.blinkEnabled).toBe(false);
    expect(result.blushEnabled).toBe(false);
    expect(result.tearsEnabled).toBe(false);
    expect(result.gazeEnabled).toBe(false);
    expect(result.reasons.some(r => r.includes('SHA mismatch'))).toBe(true);
  });

  it('morph 不存在于 PMX → invalid', () => {
    const profile = makeSelenaProfile({
      visemes: { A: '不存在的morph', I: 'い', U: 'う', E: 'え', O: 'お' }
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('viseme A') && r.includes('不存在的morph'))).toBe(true);
  });

  it('缺失可选 mouthStyle → 不影响 valid', () => {
    const profile = makeSelenaProfile({
      mouthStyles: {}  // 完全没有 mouthStyle
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
  });

  it('缺失必需 viseme (A) → lipEnabled=false', () => {
    const profile = makeSelenaProfile({
      visemes: { I: 'い', U: 'う', E: 'え', O: 'お' }  // 缺 A
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.lipEnabled).toBe(false);
  });

  it('缺失 blushMorph → blushEnabled=false（不影响 valid）', () => {
    const profile = makeSelenaProfile({
      blushMorph: undefined
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.blushEnabled).toBe(false);
  });

  it('跨模型 ID → invalid', () => {
    const profile = makeSelenaProfile();
    // selena 的 profile 但期望 yyxuanling
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'yyxuanling');
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('modelId mismatch'))).toBe(true);
  });

  it('mirrorMorph 不存在 → invalid', () => {
    const profile = makeSelenaProfile({
      mouthStyles: {
        'mouth-corner-up': { morph: '口角上げ左', mirrorMorph: '不存在的右', maxWeight: 0.35 }
      }
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('mirrorMorph') && r.includes('不存在的右'))).toBe(true);
  });

  it('yyxuanling 无 blush/tears 能力 → blushEnabled/tearsEnabled=false', () => {
    const profile: AvatarPerformanceProfile = {
      profileVersion: 1,
      avatarSha256: YYXUANLING_SHA,
      modelId: 'yyxuanling',
      visemes: { A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お' },
      blinkMorph: 'まばたき',
      expressions: {
        serious: { morph: '真面目', maxWeight: 1.0 },
        happy: { morph: '笑い', maxWeight: 1.0 }
      },
      mouthStyles: {
        'mouth-corner-up': { morph: '口角上げ', maxWeight: 0.35 }
      },
      // 不声明 blushMorph 和 tearsMorph（因为 yyxuanling 没有）
      gaze: { supported: true, leftEyeBone: '左目', rightEyeBone: '右目', bothEyesBone: '両目' },
      conversationMotionIds: []
    };
    const result = validateProfile(profile, YYXUANLING_SHA, YYXUANLING_MORPHS, BONES, 'yyxuanling');
    expect(result.valid).toBe(true);
    expect(result.blushEnabled).toBe(false);
    expect(result.tearsEnabled).toBe(false);
    expect(result.lipEnabled).toBe(true);
  });

  it('gaze 不支持 → gazeEnabled=false', () => {
    const profile = makeSelenaProfile({
      gaze: { supported: false }
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.gazeEnabled).toBe(false);
  });

  it('仅声明运行时实际使用的両目骨骼时保持 profile 有效', () => {
    const profile = makeSelenaProfile({
      gaze: { supported: true, bothEyesBone: '両目' }
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, new Set(['両目']), 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.gazeEnabled).toBe(true);
  });

  it('gaze 骨骼不存在 → invalid', () => {
    const profile = makeSelenaProfile({
      gaze: { supported: true, leftEyeBone: '不存在的骨骼', rightEyeBone: '右目', bothEyesBone: '両目' }
    });
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, new Set(['右目', '両目']), 'selena-xisheng');
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('leftEyeBone') && r.includes('不存在的骨骼'))).toBe(true);
  });
});

describe('AvatarPerformanceProfile emotion 映射', () => {
  it('emotionToExpressionId: happy → happy', () => {
    expect(emotionToExpressionId('happy')).toBe('happy');
  });

  it('emotionToExpressionId: neutral → null', () => {
    expect(emotionToExpressionId('neutral')).toBeNull();
  });

  it('emotionToExpressionId: curious → null（无直接映射）', () => {
    expect(emotionToExpressionId('curious')).toBeNull();
  });

  it('emotionToMouthStyleId: happy → mouth-corner-up', () => {
    expect(emotionToMouthStyleId('happy')).toBe('mouth-corner-up');
  });

  it('emotionToMouthStyleId: concerned → mouth-corner-down', () => {
    expect(emotionToMouthStyleId('concerned')).toBe('mouth-corner-down');
  });

  it('emotionToMouthStyleId: shy → smirk', () => {
    expect(emotionToMouthStyleId('shy')).toBe('smirk');
  });

  it('emotionToMouthStyleId: neutral → null', () => {
    expect(emotionToMouthStyleId('neutral')).toBeNull();
  });

  it('DISABLED_PROFILE 所有能力禁用', () => {
    expect(DISABLED_PROFILE.valid).toBe(false);
    expect(DISABLED_PROFILE.lipEnabled).toBe(false);
    expect(DISABLED_PROFILE.blinkEnabled).toBe(false);
    expect(DISABLED_PROFILE.blushEnabled).toBe(false);
    expect(DISABLED_PROFILE.tearsEnabled).toBe(false);
    expect(DISABLED_PROFILE.gazeEnabled).toBe(false);
  });
});

describe('AvatarPerformanceProfile 真实 profile GREEN', () => {
  it('selena-xisheng profile 与 PMX 能力匹配', async () => {
    const profile = (await import('../../models/selena-xisheng/performance-profile.json')) as unknown as AvatarPerformanceProfile;
    expect(profile.profileVersion).toBe(2);
    expect(profile.facialChannels?.mouthSmileLeft?.morphs[0]?.name).toBe('口角上げ左');
    expect(profile.facialChannels?.browDownRight?.morphs[0]?.name).toBe('怒り右');
    const result = validateProfile(profile, SELENA_SHA, SELENA_MORPHS, BONES, 'selena-xisheng');
    expect(result.valid).toBe(true);
    expect(result.lipEnabled).toBe(true);
    expect(result.blinkEnabled).toBe(true);
    expect(result.blushEnabled).toBe(true);
    expect(result.tearsEnabled).toBe(true);
    expect(result.gazeEnabled).toBe(true);
  });

  it('yyxuanling profile 与 PMX 能力匹配并用真实照れ morph 提供脸红', async () => {
    const profile = (await import('../../models/yyxuanling/performance-profile.json')) as unknown as AvatarPerformanceProfile;
    expect(profile.profileVersion).toBe(2);
    expect(profile.facialChannels?.mouthClose?.morphs[0]?.name).toBe('口close');
    expect(profile.facialChannels?.eyeWideLeft?.morphs[0]?.name).toBe('左びっくり');
    const result = validateProfile(profile, YYXUANLING_SHA, YYXUANLING_MORPHS, BONES, 'yyxuanling');
    expect(result.valid).toBe(true);
    expect(result.lipEnabled).toBe(true);
    expect(result.blinkEnabled).toBe(true);
    expect(profile.blushMorph).toBe('照れ');
    expect(result.blushEnabled).toBe(true);
    expect(result.tearsEnabled).toBe(false);  // yyxuanling 无 tears
    expect(result.gazeEnabled).toBe(true);
  });
});
