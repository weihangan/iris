import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ActorRuntime, type AvatarManifest, type Emotion } from '../../src/actor/actor-runtime';
import type { MorphSink } from '../../src/actor/morph-controller';
import type { AvatarPerformanceProfile } from '../../src/actor/avatar-performance-profile';
import { createExpressionPose } from '../../src/performance/expression-recipes';
import type { ExpressionCandidateRecord } from '../../src/performance/daily-candidate-types';

// Phase 3 Task 3.1: ActorRuntime 测试
// 验证：load + SHA-256 校验、setEmotion、setGaze、speak、update、reset
// 模型只读，不得修改/上传/分发

const MODEL_PATH = resolve(__dirname, '..', '..', '赛琳娜 希声', '赛琳娜 希声 合并.pmx');
const EXPECTED_SHA256 = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';

const manifest: AvatarManifest = {
  schemaVersion: 1,
  model: {
    internalName: '赛琳娜希声',
    displayName: '赛琳娜 希声',
    sha256: EXPECTED_SHA256,
    pmxVersion: 2.0,
    geometry: { vertices: 43694, triangles: 44597, materials: 41, bones: 594, morphs: 108, textures: 15 },
    textures: [],
    credit: '',
    licenseStatus: 'blocked-distribution-missing-readme'
  },
  morphs: {
    visemes: { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' },
    blink: 'まばたき',
    emotions: {
      // Phase 3 收口修复 Step 4：拆分 neutral 和 serious
      // - neutral = reset 后的自然表情，不激活任何 emotion morph
      // - serious = 真面目（原本被错误映射到 neutral）
      neutral: '',
      serious: '真面目',
      happy: '笑い',
      smile: 'にこり',
      surprised: 'びっくり',
      angry: '怒り',
      concerned: '困る'
    },
    blush: { name: 'FaceRed', safeRange: { min: 0, max: 0.35 } },
    shy: '照れ',
    tears: '涙'
  },
  bones: {
    root: '全ての親', center: 'センター', head: '頭', neck: '首',
    bothEyes: '両目', leftEye: '左目', rightEye: '右目',
    upperBody: '上半身', lowerBody: '下半身', waist: '腰'
  },
  clothing: { white: 'White', blue: 'Blue', note: '' },
  capabilities: ['visemes', 'blink', 'emotions', 'gaze', 'blush', 'shy', 'tears'],
  audit: { createdAt: '2026-07-17', createdBy: 'test', contractRef: '', notes: '' }
};

const layeredProfile: AvatarPerformanceProfile = {
  profileVersion: 2,
  avatarSha256: EXPECTED_SHA256,
  modelId: 'selena-xisheng',
  visemes: { A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お' },
  blinkMorph: 'まばたき',
  expressions: {},
  mouthStyles: {},
  facialChannels: {
    eyeSquintLeft: { morphs: [{ name: '目尻下げ左', scale: 1 }], maxWeight: 0.35 },
    eyeSquintRight: { morphs: [{ name: '目尻下げ右', scale: 1 }], maxWeight: 0.35 },
    mouthSmileLeft: { morphs: [{ name: '口角上げ左', scale: 1 }], maxWeight: 0.4 },
    mouthSmileRight: { morphs: [{ name: '口角上げ右', scale: 1 }], maxWeight: 0.4 }
  },
  gaze: { supported: true, leftEyeBone: '左目', rightEyeBone: '右目', bothEyesBone: '両目' },
  conversationMotionIds: []
};

const expressionCandidate: ExpressionCandidateRecord = {
  kind: 'expression',
  id: 'expression-gentle-runtime-preview',
  displayName: '温柔候选表情',
  emotion: 'gentle',
  durationSeconds: 1,
  source: {
    sourceType: 'generated',
    sourceUrl: 'generated://daily/gentle/runtime-preview',
    author: 'ChatX2',
    statedTerms: 'original local candidate',
    downloadedAt: '2026-08-15T00:00:00.000Z',
    sha256: 'A'.repeat(64),
    sourceRelativePath: 'generated/gentle/runtime-preview.json'
  },
  status: 'candidate',
  automatic: false,
  channelCurves: {
    eyeLidClose: [
      { timeSeconds: 0, value: 0 },
      { timeSeconds: 0.5, value: 0.3 },
      { timeSeconds: 1, value: 0 }
    ],
    mouthSmileLeft: [
      { timeSeconds: 0, value: 0 },
      { timeSeconds: 0.5, value: 0.4 },
      { timeSeconds: 1, value: 0 }
    ]
  }
};

describe('ActorRuntime（Phase 3 Task 3.1）', () => {
  let runtime: ActorRuntime;

  beforeEach(() => {
    runtime = new ActorRuntime(manifest);
  });

  it('load 成功加载并校验 SHA-256，返回 PmxModelInfo', async () => {
    const info = await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    expect(info.magic).toBe('PMX ');
    expect(info.modelNameJp).toBe('赛琳娜希声');
    expect(info.vertexCount).toBe(43694);
    const state = runtime.getState();
    expect(state.loaded).toBe(true);
  });

  it('load 时 SHA-256 不匹配则 fail-closed（抛错且 loaded=false）', async () => {
    await expect(
      runtime.load(MODEL_PATH, { expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000' })
    ).rejects.toThrow(/sha-256/i);
    expect(runtime.getState().loaded).toBe(false);
  });

  it('load 不修改原文件（只读）', async () => {
    const buf = readFileSync(MODEL_PATH);
    const beforeHash = createHash('sha256').update(buf).digest('hex').toUpperCase();
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    const afterBuf = readFileSync(MODEL_PATH);
    const afterHash = createHash('sha256').update(afterBuf).digest('hex').toUpperCase();
    expect(afterHash).toBe(beforeHash);
  });

  it('未 load 时调用 setEmotion 抛错', () => {
    expect(() => runtime.setEmotion('happy')).toThrow(/not loaded/i);
  });

  it('setEmotion 设置对应 emotion morph 权重为 1，其他 emotion morph 重置为 0', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    const mc = runtime.getMorphController();
    runtime.setEmotion('happy');
    expect(mc.getWeight('笑い')).toBe(1);
    expect(mc.getWeight('怒り')).toBe(0);
    expect(runtime.getState().emotion).toBe('happy');
    runtime.setEmotion('angry');
    expect(mc.getWeight('怒り')).toBe(1);
    expect(mc.getWeight('笑い')).toBe(0);
  });

  it('setEmotion("neutral") 重置所有 emotion morph 为 0', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    const mc = runtime.getMorphController();
    runtime.setEmotion('happy');
    runtime.setEmotion('neutral');
    expect(mc.getWeight('笑い')).toBe(0);
    expect(mc.getWeight('怒り')).toBe(0);
    expect(mc.getWeight('真面目')).toBe(0);
    expect(runtime.getState().emotion).toBe('neutral');
  });

  it('未知 emotion 抛错', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    expect(() => runtime.setEmotion('unknown' as Emotion)).toThrow(/unknown emotion/i);
  });

  it('setGaze 设置 gaze 状态（不依赖骨骼，仅记录意图）', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    runtime.setGaze(0.1, -0.05, 1.0);
    const state = runtime.getState();
    expect(state.gaze).toEqual({ x: 0.1, y: -0.05, z: 1.0 });
  });

  it('setGaze 接受单位向量范围 [-1,1]', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    runtime.setGaze(1, 1, 1);
    expect(runtime.getState().gaze).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('speak 只设置 speaking=true，音频时钟帧到达前保持闭嘴', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    runtime.speak('测试');
    const state = runtime.getState();
    expect(state.speaking).toBe(true);
    const mc = runtime.getMorphController();
    const visemes = ['あ', 'い', 'う', 'え', 'お'];
    const activeViseme = visemes.find(v => mc.getWeight(v) > 0);
    expect(activeViseme).toBeUndefined();

    runtime.applyVisemeWeights({ A: 0.6, I: 0.2, U: 0, E: 0, O: 0 });
    expect(mc.getWeight('あ')).toBe(0.6);
    expect(mc.getWeight('い')).toBe(0.2);
    runtime.stopSpeak();
    expect(visemes.every(name => mc.getWeight(name) === 0)).toBe(true);
  });

  it('profile v2 mixes compound mouth corners with visemes without erasing the expression', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();
    layered.speak('测试复合表情');
    layered.applyExpressionSample({
      emotion: 'happy',
      weight: 1,
      blush: 0,
      pose: createExpressionPose('happy', 1, 1)
    });
    layered.applyVisemeWeights({ A: 1, I: 0, U: 0, E: 0, O: 0 });

    const morphs = layered.getMorphController();
    expect(morphs.getWeight('目尻下げ左')).toBeGreaterThan(0);
    const happyPose = createExpressionPose('happy', 1, 1);
    expect(morphs.getWeight('口角上げ左')).toBeCloseTo(Math.min(0.4, happyPose.mouthSmileLeft) * 0.55, 6);
    expect(morphs.getWeight('口角上げ右')).toBeCloseTo(Math.min(0.4, happyPose.mouthSmileRight) * 0.55, 6);
    expect(morphs.getWeight('あ')).toBe(1);
  });

  it('applies expression and visemes through one combined performance commit', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();
    layered.speak('单次提交');

    layered.applyPerformanceSample({
      emotion: 'happy', weight: 1, blush: 0,
      pose: createExpressionPose('happy', 1, 1)
    }, { A: 0.8, I: 0.1, U: 0, E: 0, O: 0 });

    expect(layered.getMorphController().getWeight('あ')).toBeCloseTo(0.8, 6);
    expect(layered.getMorphController().getWeight('口角上げ左')).toBeGreaterThan(0);
    expect(layered.getState().emotion).toBe('happy');
  });

  it('stopSpeak clears both speech visemes and the speech expression layer', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();
    layered.speak('测试语音表情清理');
    layered.applyExpressionSample({
      emotion: 'happy', weight: 1, blush: 0,
      pose: createExpressionPose('happy', 1, 1)
    });
    layered.applyVisemeWeights({ A: 0.7, I: 0.2, U: 0, E: 0, O: 0 });

    layered.stopSpeak();

    expect(layered.getState().speaking).toBe(false);
    expect(layered.getState().emotion).toBe('neutral');
    expect(layered.getMorphController().getActiveMorphs()).toEqual([]);
  });

  it('natural speech completion keeps the last face while clearing visemes for an idle-smile crossfade', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();
    layered.speak('自然结束时保持表情');
    layered.applyExpressionSample({
      emotion: 'happy', weight: 1, blush: 0,
      pose: createExpressionPose('happy', 1, 1)
    });
    layered.applyVisemeWeights({ A: 0.7, I: 0.2, U: 0, E: 0, O: 0 });
    const smileDuringSpeech = layered.getMorphController().getWeight('口角上げ左');

    layered.stopSpeak({ preserveExpression: true });

    const morphs = layered.getMorphController();
    expect(layered.getState().speaking).toBe(false);
    expect(morphs.getWeight('あ')).toBe(0);
    expect(morphs.getWeight('い')).toBe(0);
    expect(morphs.getWeight('口角上げ左')).toBeGreaterThanOrEqual(smileDuringSpeech);

    layered.previewExpression('smile', 0.62);
    layered.update(0.1);
    expect(morphs.getWeight('口角上げ左')).toBeGreaterThan(0);
  });

  it('returns a negative speech face to the default smile without mixing opposite mouth corners', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右',
      '口角上げ左', '口角上げ右', '口角下げ左', '口角下げ右'
    ];
    const profile: AvatarPerformanceProfile = {
      ...layeredProfile,
      facialChannels: {
        ...layeredProfile.facialChannels,
        mouthFrownLeft: { morphs: [{ name: '口角下げ左', scale: 1 }], maxWeight: 0.5 },
        mouthFrownRight: { morphs: [{ name: '口角下げ右', scale: 1 }], maxWeight: 0.5 }
      }
    };
    const layered = new ActorRuntime(manifest, available, profile);
    layered.markLoaded();
    layered.speak('这件事让我很难过。');
    layered.applyExpressionSample({
      emotion: 'sad', weight: 1, blush: 0,
      pose: createExpressionPose('sad', 1, 1)
    });
    const morphs = layered.getMorphController();
    const initialFrown = morphs.getWeight('口角下げ左');
    expect(initialFrown).toBeGreaterThan(0);

    layered.stopSpeak({ preserveExpression: true });
    layered.transitionToIdleSmile(0.9, 0.62);

    expect(layered.getState().emotion).toBe('smile');
    layered.update(0.3);
    expect(morphs.getWeight('口角下げ左')).toBeLessThan(initialFrown);
    expect(morphs.getWeight('口角上げ左')).toBe(0);

    layered.update(0.3);
    expect(morphs.getWeight('口角下げ左')).toBe(0);
    expect(morphs.getWeight('口角上げ左')).toBeGreaterThan(0);

    layered.update(0.3);
    expect(morphs.getWeight('口角下げ左')).toBe(0);
    expect(morphs.getWeight('口角上げ左')).toBeGreaterThan(0);
  });

  it('previews one expression recipe channel without activating the other channels', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();

    layered.previewExpressionChannel('neutral', 'mouthSmileLeft');
    layered.update(0.4);

    const morphs = layered.getMorphController();
    expect(morphs.getWeight('口角上げ左')).toBeGreaterThan(0);
    expect(morphs.getWeight('口角上げ右')).toBe(morphs.getWeight('口角上げ左'));
    expect(morphs.getWeight('目尻下げ左')).toBe(0);
  });

  it('eases management previews in and out instead of changing morphs instantly', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();

    layered.previewExpression('happy');
    expect(layered.getMorphController().getWeight('口角上げ左')).toBe(0);
    layered.update(0.1);
    const entering = layered.getMorphController().getWeight('口角上げ左');
    expect(entering).toBeGreaterThan(0);
    expect(entering).toBeLessThan(0.4);
    layered.update(0.4);
    const held = layered.getMorphController().getWeight('口角上げ左');
    expect(held).toBeCloseTo(0.4, 4);

    layered.clearExpressionPreview();
    expect(layered.getMorphController().getWeight('口角上げ左')).toBe(held);
    layered.update(0.12);
    const exiting = layered.getMorphController().getWeight('口角上げ左');
    expect(exiting).toBeGreaterThan(0);
    expect(exiting).toBeLessThan(held);
    layered.update(0.5);
    expect(layered.getMorphController().getWeight('口角上げ左')).toBe(0);
  });

  it('previews candidate expression curves only while real speech is inactive', () => {
    const candidateProfile: AvatarPerformanceProfile = {
      ...layeredProfile,
      facialChannels: {
        ...layeredProfile.facialChannels,
        eyeLidClose: { morphs: [{ name: 'まばたき', scale: 1 }], maxWeight: 0.55 }
      }
    };
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, candidateProfile);
    layered.markLoaded();

    layered.speak('真实语音优先');
    layered.previewCandidateExpression(expressionCandidate);
    layered.update(0.5);
    expect(layered.getMorphController().getWeight('口角上げ左')).toBe(0);

    layered.stopSpeak();
    layered.previewCandidateExpression(expressionCandidate);
    layered.update(0.5);
    expect(layered.getMorphController().getWeight('口角上げ左')).toBeCloseTo(0.4, 5);
    expect(layered.getMorphController().getWeight('口角上げ右')).toBeCloseTo(0.4, 5);
    expect(layered.getMorphController().getWeight('まばたき')).toBeCloseTo(0.3, 5);
  });

  it('clears candidate expression ownership without clearing the normal blink lane', () => {
    const candidateProfile: AvatarPerformanceProfile = {
      ...layeredProfile,
      facialChannels: {
        ...layeredProfile.facialChannels,
        eyeLidClose: { morphs: [{ name: 'まばたき', scale: 1 }], maxWeight: 0.55 }
      }
    };
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, candidateProfile);
    layered.markLoaded();
    layered.setAuxiliaryMorphWeight('blink', 'まばたき', 0.12);
    layered.previewCandidateExpression(expressionCandidate);
    layered.update(0.5);

    layered.clearExpressionPreview();
    layered.update(0.5);

    expect(layered.getMorphController().getWeight('口角上げ左')).toBe(0);
    expect(layered.getMorphController().getWeight('口角上げ右')).toBe(0);
    expect(layered.getMorphController().getWeight('まばたき')).toBeCloseTo(0.12, 5);
  });

  it('releases a finished candidate so normal expression previews can resume', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();
    layered.previewCandidateExpression(expressionCandidate);
    layered.update(0.5);
    expect(layered.getMorphController().getWeight('口角上げ左')).toBeGreaterThan(0);
    layered.update(0.5);

    layered.previewExpression('happy');
    layered.update(0.4);

    expect(layered.getMorphController().getWeight('口角上げ左')).toBeCloseTo(0.4, 5);
  });

  it('ignores automatic expression samples until speech has started', () => {
    const available = [
      'あ', 'い', 'う', 'え', 'お', 'まばたき',
      '目尻下げ左', '目尻下げ右', '口角上げ左', '口角上げ右'
    ];
    const layered = new ActorRuntime(manifest, available, layeredProfile);
    layered.markLoaded();

    layered.applyExpressionSample({
      emotion: 'happy', weight: 1, blush: 0,
      pose: createExpressionPose('happy', 1, 1)
    });

    expect(layered.getMorphController().getActiveMorphs()).toEqual([]);
    expect(layered.getState().emotion).toBe('neutral');
  });

  it('speak 空字符串抛错', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    expect(() => runtime.speak('')).toThrow(/non-empty/i);
  });

  it('reset 将所有状态归零（emotion=neutral, speaking=false, gaze=0,0,0, 所有 morph=0）', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    runtime.setEmotion('happy');
    runtime.setGaze(0.5, 0.5, 0.5);
    runtime.speak('测试');
    runtime.reset();
    const state = runtime.getState();
    expect(state.emotion).toBe('neutral');
    expect(state.speaking).toBe(false);
    expect(state.gaze).toEqual({ x: 0, y: 0, z: 0 });
    const mc = runtime.getMorphController();
    expect(mc.getActiveMorphs()).toHaveLength(0);
  });

  it('getMorphController 在 load 前也可用（基于 manifest 的 knownMorphs）', () => {
    const mc = runtime.getMorphController();
    expect(mc).toBeDefined();
    // manifest 中已知 morph 应可设置
    mc.setWeight('あ', 0.5);
    expect(mc.getWeight('あ')).toBe(0.5);
  });

  it('load 后 MorphController 的 knownMorphs 包含 manifest 中所有 morph', async () => {
    await runtime.load(MODEL_PATH, { expectedSha256: EXPECTED_SHA256 });
    const mc = runtime.getMorphController();
    const known = mc.getKnownMorphs();
    // 检查所有 manifest 中提到的 morph 都在 known 列表
    const expected = ['あ', 'い', 'う', 'え', 'お', 'まばたき', '笑い', 'にこり', 'びっくり', '怒り', '困る', '真面目', 'FaceRed', '照れ', '涙'];
    for (const name of expected) {
      expect(known).toContain(name);
    }
  });
});

// Bug 4 修复：markLoaded + bindMorphSink 测试
// 验证 renderer 使用 markLoaded 跳过文件校验 + bindMorphSink 推送权重到 sink
describe('ActorRuntime Bug 4 修复（markLoaded + bindMorphSink）', () => {
  let runtime: ActorRuntime;

  beforeEach(() => {
    runtime = new ActorRuntime(manifest);
  });

  it('markLoaded 将状态设为 loaded，无需读取文件', () => {
    // 不调用 load()，直接 markLoaded
    runtime.markLoaded();
    const state = runtime.getState();
    expect(state.loaded).toBe(true);
    expect(state.emotion).toBe('neutral');
    expect(state.speaking).toBe(false);
    expect(state.gaze).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('markLoaded 后 setEmotion 不抛错', () => {
    runtime.markLoaded();
    expect(() => runtime.setEmotion('happy')).not.toThrow();
    expect(runtime.getState().emotion).toBe('happy');
  });

  it('bindMorphSink 后 setEmotion 推送权重到 sink', () => {
    runtime.markLoaded();
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('happy');
    // setEmotion('happy') 先将所有 emotion morph 置 0，再激活 笑い = 1
    // emotionMorphNames = [真面目, 笑い, にこり, びっくり, 怒り, 困る]
    const setWeights = calls.filter(c => c.weight > 0);
    expect(setWeights).toEqual([{ name: '笑い', weight: 1 }]);
  });

  it('bindMorphSink 后 setEmotion("shy") 推送 照れ=1 + FaceRed=0.15', () => {
    runtime.markLoaded();
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('shy');
    const setWeights = calls.filter(c => c.weight > 0);
    expect(setWeights).toContainEqual({ name: '照れ', weight: 1 });
    expect(setWeights).toContainEqual({ name: 'FaceRed', weight: 0.15 });
  });

  it('bindMorphSink 后 speak 推送 viseme 权重到 sink', () => {
    runtime.markLoaded();
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.speak('测试');
    // speak 只切换 speaking 状态；可见口型由音频时钟时间轴逐帧写入。
    expect(calls.filter(c => c.weight > 0)).toEqual([]);

    runtime.applyVisemeWeights({ A: 0.2, I: 0.3, U: 0.1, E: 0, O: 0 });
    expect(calls.slice(-5)).toEqual([
      { name: 'あ', weight: 0.2 },
      { name: 'い', weight: 0.3 },
      { name: 'う', weight: 0.1 },
      { name: 'え', weight: 0 },
      { name: 'お', weight: 0 }
    ]);
  });

  it('中断清理可同时清零连续表情和五口型', () => {
    runtime.markLoaded();
    runtime.speak('测试中断清理');
    runtime.applyExpressionSample({
      emotion: 'shy', weight: 0.7, blush: 0.2,
      pose: createExpressionPose('shy', 0.7, 1)
    });
    runtime.applyVisemeWeights({ A: 0.4, I: 0.2, U: 0, E: 0, O: 0 });
    runtime.stopSpeak();
    runtime.setEmotion('neutral');
    expect(runtime.getMorphController().getActiveMorphs()).toHaveLength(0);
  });

  it('bindMorphSink 后 reset 推送 resetAll 到 sink', () => {
    runtime.markLoaded();
    let resetCalled = false;
    const sink: MorphSink = {
      setWeight(): void {},
      resetAll(): void { resetCalled = true; }
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('happy');
    runtime.reset();
    expect(resetCalled).toBe(true);
  });

  it('bindMorphSink 后 setEmotion 切换情绪时推送所有 emotion morph=0 再推送新 morph=1', () => {
    runtime.markLoaded();
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('happy');   // 笑い=1
    const happyCallsCount = calls.length;
    runtime.setEmotion('angry');    // 所有 emotion morph=0, 怒り=1

    // 切换到 angry 后：笑い 应被重置为 0，怒り 应被设为 1
    const angryCalls = calls.slice(happyCallsCount);
    const zeroed笑い = angryCalls.find(c => c.name === '笑い' && c.weight === 0);
    expect(zeroed笑い).toBeDefined();
    const set怒り = angryCalls.find(c => c.name === '怒り' && c.weight === 1);
    expect(set怒り).toBeDefined();
    // 最后一次调用应是 怒り=1
    expect(angryCalls[angryCalls.length - 1]).toEqual({ name: '怒り', weight: 1 });
  });
});

// Task 2: shy 残留修复测试
// 验证：从 shy 切换到其他情绪时，照れ和 FaceRed 必须被清除
describe('ActorRuntime Task 2: shy 情绪切换不残留', () => {
  let runtime: ActorRuntime;

  beforeEach(() => {
    runtime = new ActorRuntime(manifest);
    runtime.markLoaded();
  });

  it('从 shy 切换到 angry 时清除照れ和 FaceRed', () => {
    runtime.setEmotion('shy');
    expect(runtime.getMorphController().getWeight('照れ')).toBe(1);
    expect(runtime.getMorphController().getWeight('FaceRed')).toBeCloseTo(0.15, 6);

    runtime.setEmotion('angry');

    expect(runtime.getMorphController().getWeight('照れ')).toBe(0);
    expect(runtime.getMorphController().getWeight('FaceRed')).toBe(0);
    expect(runtime.getMorphController().getWeight('怒り')).toBe(1);
  });

  it('从 shy 切换到 neutral 时清除照れ和 FaceRed', () => {
    runtime.setEmotion('shy');
    runtime.setEmotion('neutral');

    expect(runtime.getMorphController().getWeight('照れ')).toBe(0);
    expect(runtime.getMorphController().getWeight('FaceRed')).toBe(0);
    expect(runtime.getMorphController().getWeight('真面目')).toBe(0);
  });

  it('从 shy 切换到 happy 时清除照れ和 FaceRed', () => {
    runtime.setEmotion('shy');
    runtime.setEmotion('happy');

    expect(runtime.getMorphController().getWeight('照れ')).toBe(0);
    expect(runtime.getMorphController().getWeight('FaceRed')).toBe(0);
    expect(runtime.getMorphController().getWeight('笑い')).toBe(1);
  });
});

// Phase 3 收口修复 Step 4：拆分 neutral 和 serious
// 验证：
// - neutral = reset 后的自然表情，不激活任何 emotion morph（包括 真面目）
// - serious = 真面目 morph（原本被错误映射到 neutral）
// - 切换到 neutral 时所有 emotion morph 清零（包括 真面目）
// - 切换到 serious 时激活 真面目=1
describe('ActorRuntime Step 4: 拆分 neutral 和 serious', () => {
  let runtime: ActorRuntime;

  beforeEach(() => {
    runtime = new ActorRuntime(manifest);
    runtime.markLoaded();
  });

  it('setEmotion("serious") 激活 真面目=1', () => {
    runtime.setEmotion('serious');
    expect(runtime.getMorphController().getWeight('真面目')).toBe(1);
    expect(runtime.getState().emotion).toBe('serious');
  });

  it('setEmotion("neutral") 不激活任何 emotion morph（包括 真面目）', () => {
    runtime.setEmotion('neutral');
    const mc = runtime.getMorphController();
    expect(mc.getWeight('真面目')).toBe(0);
    expect(mc.getWeight('笑い')).toBe(0);
    expect(mc.getWeight('怒り')).toBe(0);
    expect(mc.getWeight('困る')).toBe(0);
    expect(mc.getWeight('にこり')).toBe(0);
    expect(mc.getWeight('びっくり')).toBe(0);
    expect(mc.getWeight('照れ')).toBe(0);
    expect(mc.getWeight('FaceRed')).toBe(0);
    expect(runtime.getState().emotion).toBe('neutral');
  });

  it('从 serious 切换到 neutral 时 真面目 清零', () => {
    runtime.setEmotion('serious');
    expect(runtime.getMorphController().getWeight('真面目')).toBe(1);

    runtime.setEmotion('neutral');

    expect(runtime.getMorphController().getWeight('真面目')).toBe(0);
    expect(runtime.getState().emotion).toBe('neutral');
  });

  it('从 serious 切换到 happy 时 真面目 清零，笑い=1', () => {
    runtime.setEmotion('serious');
    runtime.setEmotion('happy');

    expect(runtime.getMorphController().getWeight('真面目')).toBe(0);
    expect(runtime.getMorphController().getWeight('笑い')).toBe(1);
  });

  it('从 happy 切换到 serious 时 笑い 清零，真面目=1', () => {
    runtime.setEmotion('happy');
    runtime.setEmotion('serious');

    expect(runtime.getMorphController().getWeight('笑い')).toBe(0);
    expect(runtime.getMorphController().getWeight('真面目')).toBe(1);
  });

  it('reset 后 emotion=neutral，真面目=0', () => {
    runtime.setEmotion('serious');
    runtime.reset();

    expect(runtime.getState().emotion).toBe('neutral');
    expect(runtime.getMorphController().getWeight('真面目')).toBe(0);
  });

  it('bindMorphSink 后 setEmotion("serious") 推送 真面目=1 到 sink', () => {
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('serious');
    const setWeights = calls.filter(c => c.weight > 0);
    expect(setWeights).toEqual([{ name: '真面目', weight: 1 }]);
  });

  it('bindMorphSink 后 setEmotion("neutral") 不推送任何 weight > 0 的 morph', () => {
    const calls: Array<{ name: string; weight: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ name, weight });
      },
      resetAll(): void {}
    };
    runtime.bindMorphSink(sink);

    runtime.setEmotion('neutral');
    const setWeights = calls.filter(c => c.weight > 0);
    expect(setWeights).toEqual([]);
  });
});
