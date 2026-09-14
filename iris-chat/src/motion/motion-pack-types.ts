// Phase 5.2 Task 5.2.1: MotionPack 类型与 8 门元数据
//
// 职责：定义 MotionPackManifest 接口、8 阶段强制门枚举、校验函数
// 设计原则（来自 docs/plans/future-motion-asset-pipeline.md）：
// - 8 阶段全部完成才允许运行时加载
// - 未知许可证 / 缺失哈希 / 缺失来源 / 未通过视频验收都 fail-closed
// - boneMapping 至少包含 頭/上半身/左肩/右肩（任何动作都涉及这些骨骼）
// - amplitudeLimits 必须显式设置（FaceRed ≤ 0.35 是模型硬规则）

/**
 * 8 阶段强制门枚举。顺序固定，对应 future-motion-asset-pipeline.md §3。
 */
export const MotionPackStage = {
  Download: 'download',
  Hash: 'hash',
  SourceRecord: 'source-record',
  SkeletonRetarget: 'skeleton-retarget',
  AmplitudeLimit: 'amplitude-limit',
  SkatingCheck: 'skating-check',
  VideoAcceptance: 'video-acceptance',
  WhitelistRegister: 'whitelist-register'
} as const;

export type MotionPackStage = typeof MotionPackStage[keyof typeof MotionPackStage];

/**
 * 被拒绝的许可证字符串（fail-closed）。
 * 任何包含这些值的 license 字段都视为未通过 SourceRecord 阶段。
 */
export const MISSING_LICENSE_REJECTS: readonly string[] = [
  'unknown',
  'missing',
  'empty',
  'unspecified',
  ''
];

/**
 * VMD 日文骨骼名 → 模型骨骼名映射。
 * 大多数情况下键值相同（模型使用日文骨骼名），但允许重定向。
 */
export interface BoneMapping {
  [vmdBoneName: string]: string;
}

/**
 * 关节幅度限制（度数）。超过上限的旋转会被钳制。
 * FaceRed 是 morph 权重上限（0-1）。
 */
export interface AmplitudeLimits {
  head: { x: number; y: number; z: number };
  upperBody: { x: number; y: number; z: number };
  shoulder: { x: number; y: number; z: number };
  /** Optional dialogue-only bounds. Ordinary idle and preview manifests omit them. */
  arm?: { x: number; y: number; z: number };
  elbow?: { x: number; y: number; z: number };
  wrist?: { x: number; y: number; z: number };
  faceRedMax: number;
}

/**
 * 视频验收记录。
 */
export interface VideoAcceptance {
  accepted: boolean;
  acceptedBy: string;
  acceptedAt: string;
  notes: string;
}

/**
 * MotionPack 元数据，必须通过完整 8 阶段门才允许运行时加载。
 */
export interface MotionPackManifest {
  /** 唯一标识符，例如 'idle-stand-breathe-v1' */
  packId: string;
  /** 阶段 1：下载来源 URL */
  sourceUrl: string;
  /** 阶段 1：下载时间（ISO 8601） */
  downloadedAt: string;
  /** 阶段 2：SHA-256 哈希（64 字符十六进制） */
  sha256: string;
  /** 阶段 3：作者 */
  author: string;
  /** 阶段 3：许可证（如 'CC-BY-NC-4.0'） */
  license: string;
  /** 阶段 4：VMD 日文骨骼名 → 模型骨骼名映射 */
  boneMapping: BoneMapping;
  /** 阶段 5：关节幅度限制 */
  amplitudeLimits: AmplitudeLimits | null;
  /** 阶段 6：脚滑/穿模检查通过 */
  skatingCheckPassed: boolean;
  /** 阶段 7：视频验收记录 */
  videoAcceptance: VideoAcceptance | null;
  /** 阶段 8：已加入白名单 */
  whitelistRegistered: boolean;
}

/**
 * 创建空 manifest，只有 packId 必填。
 */
export function createEmptyManifest(packId: string): MotionPackManifest {
  return {
    packId,
    sourceUrl: '',
    downloadedAt: '',
    sha256: '',
    author: '',
    license: '',
    boneMapping: {},
    amplitudeLimits: null,
    skatingCheckPassed: false,
    videoAcceptance: null,
    whitelistRegistered: false
  };
}

/**
 * 骨骼重定向最少必须包含的骨骼名（日文）。
 * 任何 VMD 动作都会涉及这些骨骼，缺失则无法正确应用。
 */
const REQUIRED_BONES = ['頭', '上半身', '左肩', '右肩'];

/**
 * 检查某个阶段是否完成。
 */
export function isStageComplete(manifest: MotionPackManifest, stage: MotionPackStage): boolean {
  switch (stage) {
    case MotionPackStage.Download:
      return manifest.sourceUrl.trim().length > 0 && manifest.downloadedAt.trim().length > 0;
    case MotionPackStage.Hash:
      return /^[a-fA-F0-9]{64}$/.test(manifest.sha256);
    case MotionPackStage.SourceRecord:
      if (manifest.author.trim().length === 0) return false;
      const lower = manifest.license.toLowerCase().trim();
      return !MISSING_LICENSE_REJECTS.includes(lower);
    case MotionPackStage.SkeletonRetarget:
      return REQUIRED_BONES.every(bone => manifest.boneMapping[bone]);
    case MotionPackStage.AmplitudeLimit:
      return manifest.amplitudeLimits !== null;
    case MotionPackStage.SkatingCheck:
      return manifest.skatingCheckPassed === true;
    case MotionPackStage.VideoAcceptance:
      return manifest.videoAcceptance !== null && manifest.videoAcceptance.accepted === true;
    case MotionPackStage.WhitelistRegister:
      return manifest.whitelistRegistered === true;
    default:
      return false;
  }
}

/**
 * 校验 manifest 是否通过完整 8 阶段门。
 * 返回 { valid, missing }，missing 列出未完成的阶段。
 *
 * 生产环境运行时加载必须通过此校验。
 */
export function validateMotionPackManifest(manifest: MotionPackManifest): {
  valid: boolean;
  missing: MotionPackStage[];
} {
  const allStages: MotionPackStage[] = [
    MotionPackStage.Download,
    MotionPackStage.Hash,
    MotionPackStage.SourceRecord,
    MotionPackStage.SkeletonRetarget,
    MotionPackStage.AmplitudeLimit,
    MotionPackStage.SkatingCheck,
    MotionPackStage.VideoAcceptance,
    MotionPackStage.WhitelistRegister
  ];
  const missing = allStages.filter(stage => !isStageComplete(manifest, stage));
  return { valid: missing.length === 0, missing };
}

/**
 * Candidate Review 阶段集合（阶段 1-5）。
 * 用户要求（2026-07-19）：视频验收 + 白名单注册保持 false 时，
 * 仅测试/本地验收环境可启用 candidate-review 模式加载这些 pack。
 *
 * 阶段 6-8（skating-check / video-acceptance / whitelist-register）属于视觉验收门禁，
 * 必须由人工视频验收完成，不得在测试或代码中提前 PASS。
 */
export const CANDIDATE_REVIEW_STAGES: readonly MotionPackStage[] = [
  MotionPackStage.Download,
  MotionPackStage.Hash,
  MotionPackStage.SourceRecord,
  MotionPackStage.SkeletonRetarget,
  MotionPackStage.AmplitudeLimit
];

/**
 * 校验 manifest 是否通过 candidate-review 阶段（1-5）。
 * 阶段 6-8（skating-check / video-acceptance / whitelist-register）允许 pending。
 *
 * 仅在 candidate-review 模式（测试 / 本地验收）下使用此校验。
 * 生产环境必须使用 validateMotionPackManifest（8 阶段全门）。
 *
 * 返回 { valid, missing, pending }：
 *   - valid: 阶段 1-5 是否全部通过
 *   - missing: 阶段 1-5 中未完成的阶段（必须修复才能注册）
 *   - pending: 阶段 6-8 中未完成的阶段（等待视频验收）
 */
export function validateMotionPackManifestForCandidateReview(manifest: MotionPackManifest): {
  valid: boolean;
  missing: MotionPackStage[];
  pending: MotionPackStage[];
} {
  const allStages: MotionPackStage[] = [
    MotionPackStage.Download,
    MotionPackStage.Hash,
    MotionPackStage.SourceRecord,
    MotionPackStage.SkeletonRetarget,
    MotionPackStage.AmplitudeLimit,
    MotionPackStage.SkatingCheck,
    MotionPackStage.VideoAcceptance,
    MotionPackStage.WhitelistRegister
  ];
  const candidateStages = new Set<MotionPackStage>(CANDIDATE_REVIEW_STAGES);
  const missing: MotionPackStage[] = [];
  const pending: MotionPackStage[] = [];
  for (const stage of allStages) {
    const complete = isStageComplete(manifest, stage);
    if (complete) continue;
    if (candidateStages.has(stage)) {
      missing.push(stage);
    } else {
      pending.push(stage);
    }
  }
  return { valid: missing.length === 0, missing, pending };
}
