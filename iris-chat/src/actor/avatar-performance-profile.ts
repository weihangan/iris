/**
 * AvatarPerformanceProfile —— Task 0: SHA 绑定的模型能力档案。
 *
 * 每个模型（selena-xisheng / yyxuanling）都有独立的 performance-profile.json，
 * 通过 PMX SHA-256 绑定。档案中只声明模型实际拥有的能力，缺失能力直接不执行，
 * 不能跨模型借 morph。
 *
 * 校验规则：
 *   1. 实际 PMX SHA 与 profile.avatarSha256 不匹配 → reject，禁用自动表演
 *   2. profile 中任何 morph 名不在该 PMX 的 morph 字典中 → reject
 *   3. 缺失可选 mouthStyle/expression → 返回 no cue，不替代其他模型的 morph
 *   4. 缺失必需 A/I/U/E/O → 音频仍播放，但 lip 表演禁用
 *   5. profile 不得引用其他模型目录的 morph
 *   6. semantic/IPC 对象永远不携带解析后的 morph 名
 */
import type { Emotion } from './actor-runtime';
import { FACIAL_CHANNELS, type FacialChannel } from '../performance/facial-pose';
import type { FacialPersonalityBias } from '../performance/expression-recipes';

/** 表情预设 ID（与 Emotion 对齐，但 neutral 不需要 morph） */
export type ExpressionId =
  | 'serious' | 'happy' | 'smile' | 'surprised'
  | 'angry' | 'concerned' | 'shy' | 'sad' | 'thinking';

/** 嘴型风格 ID（情绪驱动的嘴角偏移） */
export type MouthStyleId =
  | 'mouth-corner-up'    // 嘴角上扬（happy/smile/greeting）
  | 'mouth-corner-down'  // 嘴角下垂（concerned/sad/angry）
  | 'smirk'              // 坏笑（shy/loving，克制使用）
  | 'mouth-wide'         // 嘴角横向扩张（surprised）
  | 'mouth-small';       // 嘴收拢（thinking）

/** 五口型 ID */
export type VisemeId = 'A' | 'I' | 'U' | 'E' | 'O';

/** 表情预设：morph 名 + 最大权重 */
export interface ExpressionPreset {
  readonly morph: string;
  readonly maxWeight: number;
}

/** 嘴型风格预设：morph 名 + 最大权重（叠加在 viseme 之上）。
 * 部分模型的嘴部 morph 分左右（如 selena 的"口角上げ左"/"口角上げ右"），
 * mirrorMorph 用于声明右侧镜像 morph，运行时同时驱动。
 */
export interface MouthStylePreset {
  readonly morph: string;
  readonly mirrorMorph?: string;
  readonly maxWeight: number;
}

/** 视线能力档案 */
export interface GazeCapabilityProfile {
  /** 是否支持视线控制（需要 左目/右目/両目 骨骼） */
  readonly supported: boolean;
  /** 视线骨骼名（如有） */
  readonly leftEyeBone?: string;
  readonly rightEyeBone?: string;
  readonly bothEyesBone?: string;
}

export interface FacialMorphBinding {
  readonly name: string;
  readonly scale: number;
}

export interface FacialChannelBinding {
  readonly morphs: readonly FacialMorphBinding[];
  readonly maxWeight: number;
  readonly opposingGroup?: string;
}

/** 模型能力档案（SHA 绑定） */
export interface AvatarPerformanceProfile {
  readonly profileVersion: 1 | 2;
  /** 绑定的 PMX SHA-256（大写 hex） */
  readonly avatarSha256: string;
  /** 模型 ID（用于日志，不参与校验） */
  readonly modelId: string;

  /** 五口型 morph 映射。缺失任何一项 → lip 表演禁用 */
  readonly visemes: Readonly<Partial<Record<VisemeId, string>>>;

  /** 眨眼 morph。缺失 → 眨眼禁用 */
  readonly blinkMorph?: string;

  /** 表情预设。缺失的预设 → 不产生 cue，不替代 */
  readonly expressions: Readonly<Partial<Record<ExpressionId, ExpressionPreset>>>;

  /** 嘴型风格预设。缺失的预设 → 不产生 cue，不替代 */
  readonly mouthStyles: Readonly<Partial<Record<MouthStyleId, MouthStylePreset>>>;

  /** FACS/ARKit-style semantic channels mapped to this model's native PMX morphs. */
  readonly facialChannels?: Readonly<Partial<Record<FacialChannel, FacialChannelBinding>>>;

  /** Optional face-only character bias. Missing means an unbiased ordinary model. */
  readonly facialPersonality?: FacialPersonalityBias;

  /** 腮红 morph（独立通道，非复合表情）。缺失 → 腮红禁用 */
  readonly blushMorph?: string;

  /** 眼泪 morph。缺失 → 眼泪禁用 */
  readonly tearsMorph?: string;

  /** 视线能力 */
  readonly gaze: GazeCapabilityProfile;

  /** 已准入的对话动作 ID 列表（来自 vmdEmotionMap，已审核） */
  readonly conversationMotionIds: readonly string[];
}

/** 校验结果 */
export interface ProfileValidationResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
  /** lip 表演是否可用（需要全部 5 个 viseme） */
  readonly lipEnabled: boolean;
  /** 眨眼是否可用 */
  readonly blinkEnabled: boolean;
  /** 腮红是否可用 */
  readonly blushEnabled: boolean;
  /** 眼泪是否可用 */
  readonly tearsEnabled: boolean;
  /** 视线控制是否可用 */
  readonly gazeEnabled: boolean;
}

/** 缺失能力的空档案（用于校验失败时返回，禁用所有自动表演） */
export const DISABLED_PROFILE: ProfileValidationResult = {
  valid: false,
  reasons: ['profile not loaded or validation failed'],
  lipEnabled: false,
  blinkEnabled: false,
  blushEnabled: false,
  tearsEnabled: false,
  gazeEnabled: false
};

export interface ValidatedProfileSelection {
  readonly profile?: AvatarPerformanceProfile;
  readonly validation: ProfileValidationResult;
}

function modelIdFromPackId(packId: string): string {
  return String(packId ?? '').trim().replace(/-v\d+(?:\.\d+)*$/i, '');
}

export function selectValidatedProfile(
  profiles: readonly AvatarPerformanceProfile[],
  actualSha256: string,
  actualMorphNames: ReadonlySet<string>,
  actualBoneNames: ReadonlySet<string>,
  activePackId: string
): ValidatedProfileSelection {
  const selected = profiles.find(profile =>
    profile.avatarSha256.toUpperCase() === actualSha256.toUpperCase());
  if (!selected) {
    return {
      validation: {
        ...DISABLED_PROFILE,
        reasons: [`no performance profile for PMX SHA ${actualSha256}`]
      }
    };
  }
  const validation = validateProfile(
    selected,
    actualSha256,
    actualMorphNames,
    actualBoneNames,
    modelIdFromPackId(activePackId)
  );
  return validation.valid ? { profile: selected, validation } : { validation };
}

/**
 * 校验 profile 是否与实际 PMX 能力匹配。
 *
 * @param profile 待校验的档案
 * @param actualSha256 实际 PMX 的 SHA-256（大写 hex）
 * @param actualMorphNames PMX 中实际存在的 morph 名集合
 * @param actualBoneNames PMX 中实际存在的骨骼名集合（用于视线校验）
 * @param expectedModelId 期望的模型 ID（防止跨模型借 morph）
 */
export function validateProfile(
  profile: AvatarPerformanceProfile,
  actualSha256: string,
  actualMorphNames: ReadonlySet<string>,
  actualBoneNames: ReadonlySet<string>,
  expectedModelId: string
): ProfileValidationResult {
  const reasons: string[] = [];

  // 1. SHA 校验
  if (profile.avatarSha256.toUpperCase() !== actualSha256.toUpperCase()) {
    reasons.push(`SHA mismatch: profile=${profile.avatarSha256} actual=${actualSha256}`);
  }

  // 2. modelId 校验（防止加载错误的 profile）
  if (profile.modelId !== expectedModelId) {
    reasons.push(`modelId mismatch: profile=${profile.modelId} expected=${expectedModelId}`);
  }

  // 3. visemes 校验：morph 必须存在
  for (const [id, morph] of Object.entries(profile.visemes)) {
    if (morph && !actualMorphNames.has(morph)) {
      reasons.push(`viseme ${id} morph "${morph}" not found in PMX`);
    }
  }

  // 4. blinkMorph 校验
  if (profile.blinkMorph && !actualMorphNames.has(profile.blinkMorph)) {
    reasons.push(`blink morph "${profile.blinkMorph}" not found in PMX`);
  }

  // 5. expressions 校验
  for (const [id, preset] of Object.entries(profile.expressions)) {
    if (preset && !actualMorphNames.has(preset.morph)) {
      reasons.push(`expression ${id} morph "${preset.morph}" not found in PMX`);
    }
  }

  // 6. mouthStyles 校验
  for (const [id, preset] of Object.entries(profile.mouthStyles)) {
    if (preset && !actualMorphNames.has(preset.morph)) {
      reasons.push(`mouthStyle ${id} morph "${preset.morph}" not found in PMX`);
    }
    if (preset?.mirrorMorph && !actualMorphNames.has(preset.mirrorMorph)) {
      reasons.push(`mouthStyle ${id} mirrorMorph "${preset.mirrorMorph}" not found in PMX`);
    }
  }

  // 7. blushMorph 校验
  if (profile.blushMorph && !actualMorphNames.has(profile.blushMorph)) {
    reasons.push(`blush morph "${profile.blushMorph}" not found in PMX`);
  }

  // 8. tearsMorph 校验
  if (profile.tearsMorph && !actualMorphNames.has(profile.tearsMorph)) {
    reasons.push(`tears morph "${profile.tearsMorph}" not found in PMX`);
  }

  // Profile v2 semantic facial channel bindings.
  const knownFacialChannels = new Set<string>(FACIAL_CHANNELS);
  for (const [channel, binding] of Object.entries(profile.facialChannels ?? {})) {
    if (!knownFacialChannels.has(channel)) {
      reasons.push(`unknown facialChannel ${channel}`);
      continue;
    }
    if (!binding || !Array.isArray(binding.morphs) || binding.morphs.length === 0) {
      reasons.push(`facialChannel ${channel} must bind at least one morph`);
      continue;
    }
    if (!Number.isFinite(binding.maxWeight) || binding.maxWeight < 0 || binding.maxWeight > 1) {
      reasons.push(`facialChannel ${channel} maxWeight must be within [0, 1]`);
    }
    for (const morph of binding.morphs) {
      if (!actualMorphNames.has(morph.name)) {
        reasons.push(`facialChannel ${channel} morph "${morph.name}" not found in PMX`);
      }
      if (!Number.isFinite(morph.scale) || morph.scale < 0 || morph.scale > 1) {
        reasons.push(`facialChannel ${channel} morph "${morph.name}" scale must be within [0, 1]`);
      }
    }
  }

  for (const [trait, value] of Object.entries(profile.facialPersonality ?? {})) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      reasons.push(`facialPersonality ${trait} must be within [0, 1]`);
    }
  }

  // 9. gaze 校验
  if (profile.gaze.supported) {
    if (profile.gaze.bothEyesBone && !actualBoneNames.has(profile.gaze.bothEyesBone)) {
      reasons.push(`gaze bothEyesBone "${profile.gaze.bothEyesBone}" not found in PMX`);
    }
    if (profile.gaze.leftEyeBone && !actualBoneNames.has(profile.gaze.leftEyeBone)) {
      reasons.push(`gaze leftEyeBone "${profile.gaze.leftEyeBone}" not found in PMX`);
    }
    if (profile.gaze.rightEyeBone && !actualBoneNames.has(profile.gaze.rightEyeBone)) {
      reasons.push(`gaze rightEyeBone "${profile.gaze.rightEyeBone}" not found in PMX`);
    }
  }

  const valid = reasons.length === 0;

  // 计算各项能力是否可用
  const visemesComplete = ['A', 'I', 'U', 'E', 'O'].every(
    id => profile.visemes[id as VisemeId] && (!valid || actualMorphNames.has(profile.visemes[id as VisemeId]!))
  );
  const lipEnabled = valid && visemesComplete;
  const blinkEnabled = valid && Boolean(profile.blinkMorph);
  const blushEnabled = valid && Boolean(profile.blushMorph);
  const tearsEnabled = valid && Boolean(profile.tearsMorph);
  const gazeEnabled = valid && Boolean(profile.gaze.supported);

  return {
    valid,
    reasons,
    lipEnabled,
    blinkEnabled,
    blushEnabled,
    tearsEnabled,
    gazeEnabled
  };
}

/**
 * 解析 Emotion 到 ExpressionId。
 * thinking/curious/grateful/loving 等 Emotion 没有直接对应的 ExpressionId，
 * 由上层 fallback 到 serious/surprised/smile。
 */
export function emotionToExpressionId(emotion: Emotion): ExpressionId | null {
  const map: Partial<Record<Emotion, ExpressionId>> = {
    serious: 'serious',
    happy: 'happy',
    smile: 'smile',
    surprised: 'surprised',
    angry: 'angry',
    concerned: 'concerned',
    shy: 'shy',
    thinking: 'thinking'
  };
  return map[emotion] ?? null;
}

/**
 * 解析 Emotion 到 MouthStyleId。
 * 返回 null 表示该情绪不需要嘴型风格叠加。
 */
export function emotionToMouthStyleId(emotion: Emotion): MouthStyleId | null {
  const map: Partial<Record<Emotion, MouthStyleId>> = {
    happy: 'mouth-corner-up',
    smile: 'mouth-corner-up',
    concerned: 'mouth-corner-down',
    angry: 'mouth-corner-down',
    surprised: 'mouth-wide',
    shy: 'smirk',
    thinking: 'mouth-small',
    loving: 'smirk'
  };
  return map[emotion] ?? null;
}
