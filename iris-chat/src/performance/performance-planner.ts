// Phase 6 重构（2026-07-24）：PerformancePlanner 迁移到 VMD 文件系统
//
// 旧版本依赖 idle-packs.ts / gesture-packs.ts 的程序化生成动作。
// 新版本通过 manifest.json 中的 vmdEmotionMap 配置，将情绪/意图映射到
// models/selena-xisheng/motions/ 目录下的真实 VMD 文件。
//
// 职责：
// - 接受语义级输入（emotion/intent/intensity/gaze/gestureFamily）
// - 根据 manifest.json 中的 vmdEmotionMap 选择 VMD 文件
// - 输出归一化的 intensity（0-1）供下游使用
// - 不接受 packId/VMD 文件名/骨骼值作为输入（防注入）
//
// 安全边界规则：
// - 同一 gestureFamily 内的 emotion 切换可以立即切换 VMD
// - 不同 gestureFamily 之间的切换需要经过 fade-out → fade-in（由 MotionPlayer 处理）
// - 切换时机：sourceNode.start() 后、语音结束前、emotion 变化时

import { isAutomaticVoiceAction } from './voice-action-pool';

export type PerformanceState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type GazeDirection = 'user' | 'away' | 'down';

/**
 * VMD 情绪映射条目（从 manifest.json 的 vmdEmotionMap 读取）。
 * 每个 VMD 文件可以关联多个情绪和意图。
 */
export interface VmdEmotionEntry {
  /** VMD 文件路径（相对于 motions/ 目录） */
  vmdPath: string;
  /** 显示名称 */
  displayName: string;
  /** 动作类型：idle | gesture */
  type: 'idle' | 'gesture' | 'voice';
  /** 手势家族 */
  gestureFamily: string;
  /** 意图标签 */
  intent: string;
  /** 关联的情绪列表 */
  emotions: string[];
  /** 描述 */
  description: string;
  /** Explicitly admitted for restrained automatic dialogue. Manual preview does not use this flag. */
  dialogueSafe?: boolean;
  /** User-selected high-frequency speech action. */
  starred?: boolean;
  /** Preserve the current default-idle body and play a separately validated head overlay. */
  motionScope?: 'head-overlay';
  /** Registered runtime overlay; never interpreted as an arbitrary bone name. */
  headOverlayId?: 'curious-left-tilt' | 'concerned-down' | 'remember-inward-up';
  /** Runtime-provided built-in voice action. Protected entries cannot be removed or re-identified. */
  protected?: boolean;
  /** User-adjustable, bounded amplitude for protected head overlays. */
  headTuning?: { rotationScale: number };
}

/**
 * PerformancePlan：Planner 输出。
 */
export interface PerformancePlan {
  /** 表演状态 */
  state: PerformanceState;
  /** 情绪标签（透传输入） */
  emotion: string;
  /** 意图标签（透传输入，未提供为空字符串） */
  intent: string;
  /** 归一化强度 [0, 1] */
  intensity: number;
  /** 注视方向 */
  gaze: GazeDirection;
  /** 手势家族 */
  gestureFamily: string;
  /** 选中的 VMD 文件路径（相对于 motions/ 目录），仅 speaking 状态非空 */
  speakingVmdPath?: string;
  /** Runtime audit information for the selected voice-action entry. */
  speakingVmdMatch?: {
    level: 'intent' | 'gestureFamily' | 'emotion' | 'daily';
    entry: VmdEmotionEntry;
  };
  /** Why the automatic user voice pool did or did not produce a clip. */
  voiceActionSelectionReason?: 'selected' | 'voice-pool-empty' | 'no-matching-enabled-action';
  /** 表情 morph 配置（从 VMD 或 emotion profile 推断） */
  expressionMorphs?: ExpressionMorphConfig;
}

/**
 * 微表情 morph 配置。
 * 在语音播放期间驱动面部表情变化。
 */
export interface ExpressionMorphConfig {
  /** 主要表情 morph 名称（如 '笑い', '怒り', '困る'） */
  primaryMorph: string;
  /** 主要表情权重 [0, 1] */
  primaryWeight: number;
  /** 次要表情 morph 名称 */
  secondaryMorph?: string;
  /** 次要表情权重 */
  secondaryWeight?: number;
  /** 眨眼频率倍率（1.0 = 正常，>1 = 更频繁） */
  blinkRateMultiplier: number;
  /** 是否启用腮红 */
  blushEnabled: boolean;
  /** 腮红权重 */
  blushWeight: number;
}

/**
 * 语义级 Planner 输入。
 */
export interface PlannerInput {
  emotion: string;
  speaking: boolean;
  intent?: string;
  intensity?: number;
  gaze?: GazeDirection;
  gestureFamily?: string;
  /** 当前模型包启用的 VMD 列表 */
  enabledVmdPaths?: readonly string[];
  /** Current/recent reply motions that must not be selected again. */
  excludedVmdPaths?: readonly string[];
  /** 默认待机 VMD 路径 */
  defaultIdleVmd?: string;
}

const INTENT_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['explaining', 'explain'],
  ['thinking', 'think'],
  ['concerned', 'concern', 'worry', 'worried'],
  ['reassuring', 'reassure', 'comfort', 'comforting'],
  ['rejecting', 'reject', 'disagree', 'assert', 'warn'],
  ['gratitude', 'thank', 'thanks', 'appreciate'],
  ['affirmative', 'agree', 'agreement', 'celebrate', 'cheer'],
  ['questioning', 'question', 'ask', 'inquiry'],
  ['inviting', 'invite', 'welcoming', 'welcome', 'greeting'],
  ['apologizing', 'apologize', 'apology', 'sorry'],
  ['encouraging', 'encourage', 'motivate'],
  ['playful', 'play', 'tease', 'teasing'],
  ['shy', 'embarrassed'],
  ['surprised', 'surprise', 'react'],
  ['listening', 'listen'],
  ['remembering', 'remember', 'nostalgic']
];

const EMOTION_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['happy', 'smile', 'delighted', 'loving', 'grateful', 'greeting', 'affirmative'],
  ['excited', 'delighted'],
  ['surprised', 'shocked'],
  ['angry', 'furious', 'pretend_angry'],
  ['sad', 'heartbroken', 'exhausted', 'helpless', 'guilty'],
  ['concerned', 'worried', 'worry', 'apologetic'],
  ['shy', 'embarrassed'],
  ['curious', 'skeptical'],
  ['serious', 'confident', 'determined'],
  ['playful', 'cute']
];

function intentAliases(value: string): ReadonlySet<string> {
  const normalized = value.trim().toLowerCase();
  return new Set(INTENT_ALIAS_GROUPS.find(group => group.includes(normalized)) ?? [normalized]);
}

function emotionAliases(value: string): ReadonlySet<string> {
  const normalized = value.trim().toLowerCase();
  return new Set(EMOTION_ALIAS_GROUPS.find(group => group.includes(normalized)) ?? [normalized]);
}

function normalizeVmdPath(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * Manifest paths can be local (`motions/foo.vmd`) while the shared voice
 * catalog uses `../shared/motions/foo.vmd` or `../<model>/motions/foo.vmd`.
 * The motions-relative suffix is the stable admission key; the catalog path
 * itself is still returned for loading so the owning pack remains authoritative.
 */
function normalizeMotionAlias(value: string): string {
  const normalized = normalizeVmdPath(value);
  const marker = '/motions/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + 1);
  return normalized.replace(/^(?:\.\.\/)+/, '');
}

// ============================================================
// 情绪 → 微表情映射表
// ============================================================

interface EmotionProfile {
  intensity: number;
  gaze: GazeDirection;
  gestureFamily: string;
  expressionMorphs: ExpressionMorphConfig;
}

const EMOTION_PROFILES: Record<string, EmotionProfile> = {
  neutral: {
    intensity: 0.3, gaze: 'user', gestureFamily: 'neutral',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.15, blinkRateMultiplier: 1.0, blushEnabled: false, blushWeight: 0 }
  },
  happy: {
    intensity: 0.8, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.6, secondaryMorph: 'にこり', secondaryWeight: 0.3, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.15 }
  },
  smile: {
    intensity: 0.6, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.5, secondaryMorph: '笑い', secondaryWeight: 0.2, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.1 }
  },
  angry: {
    intensity: 0.9, gaze: 'user', gestureFamily: 'angry',
    expressionMorphs: { primaryMorph: '怒り', primaryWeight: 0.75, secondaryMorph: '困る', secondaryWeight: 0.25, blinkRateMultiplier: 1.3, blushEnabled: false, blushWeight: 0 }
  },
  sad: {
    intensity: 0.4, gaze: 'down', gestureFamily: 'sad',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.5, secondaryMorph: '涙', secondaryWeight: 0.2, blinkRateMultiplier: 0.7, blushEnabled: false, blushWeight: 0 }
  },
  concerned: {
    intensity: 0.5, gaze: 'down', gestureFamily: 'concerned',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.4, blinkRateMultiplier: 0.8, blushEnabled: false, blushWeight: 0 }
  },
  surprised: {
    intensity: 0.85, gaze: 'user', gestureFamily: 'surprised',
    expressionMorphs: { primaryMorph: 'びっくり', primaryWeight: 0.7, blinkRateMultiplier: 1.5, blushEnabled: false, blushWeight: 0 }
  },
  thinking: {
    intensity: 0.3, gaze: 'away', gestureFamily: 'thinking',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.3, blinkRateMultiplier: 0.8, blushEnabled: false, blushWeight: 0 }
  },
  listening: {
    intensity: 0.3, gaze: 'user', gestureFamily: 'listening',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.2, blinkRateMultiplier: 0.9, blushEnabled: false, blushWeight: 0 }
  },
  curious: {
    intensity: 0.6, gaze: 'user', gestureFamily: 'curious',
    expressionMorphs: { primaryMorph: 'びっくり', primaryWeight: 0.2, secondaryMorph: 'にこり', secondaryWeight: 0.15, blinkRateMultiplier: 1.1, blushEnabled: false, blushWeight: 0 }
  },
  shy: {
    intensity: 0.4, gaze: 'away', gestureFamily: 'shy',
    expressionMorphs: { primaryMorph: '照れ', primaryWeight: 0.55, blinkRateMultiplier: 1.2, blushEnabled: true, blushWeight: 0.25 }
  },
  serious: {
    intensity: 0.5, gaze: 'user', gestureFamily: 'serious',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.45, blinkRateMultiplier: 0.9, blushEnabled: false, blushWeight: 0 }
  },
  excited: {
    intensity: 0.9, gaze: 'user', gestureFamily: 'excited',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.7, secondaryMorph: 'びっくり', secondaryWeight: 0.2, blinkRateMultiplier: 1.3, blushEnabled: true, blushWeight: 0.2 }
  },
  loving: {
    intensity: 0.65, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.5, secondaryMorph: '照れ', secondaryWeight: 0.3, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.2 }
  },
  grateful: {
    intensity: 0.6, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.45, secondaryMorph: '照れ', secondaryWeight: 0.2, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.15 }
  },
  greeting: {
    intensity: 0.7, gaze: 'user', gestureFamily: 'greeting',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.55, secondaryMorph: 'にこり', secondaryWeight: 0.25, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.1 }
  },
  graceful: {
    intensity: 0.5, gaze: 'user', gestureFamily: 'graceful',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.35, blinkRateMultiplier: 0.9, blushEnabled: true, blushWeight: 0.08 }
  },
  negative: {
    intensity: 0.45, gaze: 'away', gestureFamily: 'negative',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.4, blinkRateMultiplier: 0.8, blushEnabled: false, blushWeight: 0 }
  },
  welcoming: {
    intensity: 0.7, gaze: 'user', gestureFamily: 'welcoming',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.5, secondaryMorph: 'にこり', secondaryWeight: 0.3, blinkRateMultiplier: 1.0, blushEnabled: true, blushWeight: 0.12 }
  },
  explaining: {
    intensity: 0.5, gaze: 'user', gestureFamily: 'explaining',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.35, blinkRateMultiplier: 1.0, blushEnabled: false, blushWeight: 0 }
  },
  affirmative: {
    intensity: 0.6, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.4, blinkRateMultiplier: 1.0, blushEnabled: false, blushWeight: 0 }
  },
  // ===== 新增情绪 profile（语音动作匹配用）=====
  cute: {
    intensity: 0.7, gaze: 'user', gestureFamily: 'cute',
    expressionMorphs: { primaryMorph: 'にこり', primaryWeight: 0.5, secondaryMorph: '照れ', secondaryWeight: 0.25, blinkRateMultiplier: 1.1, blushEnabled: true, blushWeight: 0.2 }
  },
  playful: {
    intensity: 0.75, gaze: 'user', gestureFamily: 'cute',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.55, secondaryMorph: 'にこり', secondaryWeight: 0.3, blinkRateMultiplier: 1.2, blushEnabled: true, blushWeight: 0.18 }
  },
  exhausted: {
    intensity: 0.3, gaze: 'down', gestureFamily: 'sad',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.5, blinkRateMultiplier: 0.5, blushEnabled: false, blushWeight: 0 }
  },
  embarrassed: {
    intensity: 0.5, gaze: 'away', gestureFamily: 'shy',
    expressionMorphs: { primaryMorph: '照れ', primaryWeight: 0.6, secondaryMorph: '困る', secondaryWeight: 0.2, blinkRateMultiplier: 1.3, blushEnabled: true, blushWeight: 0.3 }
  },
  helpless: {
    intensity: 0.35, gaze: 'down', gestureFamily: 'sad',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.45, blinkRateMultiplier: 0.6, blushEnabled: false, blushWeight: 0 }
  },
  guilty: {
    intensity: 0.4, gaze: 'down', gestureFamily: 'sad',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.5, secondaryMorph: '照れ', secondaryWeight: 0.2, blinkRateMultiplier: 0.7, blushEnabled: true, blushWeight: 0.15 }
  },
  determined: {
    intensity: 0.65, gaze: 'user', gestureFamily: 'serious',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.55, blinkRateMultiplier: 0.9, blushEnabled: false, blushWeight: 0 }
  },
  delighted: {
    intensity: 0.9, gaze: 'user', gestureFamily: 'happy',
    expressionMorphs: { primaryMorph: '笑い', primaryWeight: 0.85, secondaryMorph: 'にこり', secondaryWeight: 0.35, blinkRateMultiplier: 1.2, blushEnabled: true, blushWeight: 0.18 }
  },
  shocked: {
    intensity: 0.92, gaze: 'user', gestureFamily: 'surprised',
    expressionMorphs: { primaryMorph: 'びっくり', primaryWeight: 0.9, blinkRateMultiplier: 1.4, blushEnabled: false, blushWeight: 0 }
  },
  furious: {
    intensity: 0.92, gaze: 'user', gestureFamily: 'angry',
    expressionMorphs: { primaryMorph: '怒り', primaryWeight: 0.9, secondaryMorph: '困る', secondaryWeight: 0.18, blinkRateMultiplier: 1.25, blushEnabled: false, blushWeight: 0 }
  },
  heartbroken: {
    intensity: 0.7, gaze: 'down', gestureFamily: 'sad',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.78, secondaryMorph: '涙', secondaryWeight: 0.3, blinkRateMultiplier: 0.55, blushEnabled: false, blushWeight: 0 }
  },
  skeptical: {
    intensity: 0.58, gaze: 'away', gestureFamily: 'curious',
    expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.45, secondaryMorph: '困る', secondaryWeight: 0.12, blinkRateMultiplier: 0.85, blushEnabled: false, blushWeight: 0 }
  },
  apologetic: {
    intensity: 0.48, gaze: 'down', gestureFamily: 'concerned',
    expressionMorphs: { primaryMorph: '困る', primaryWeight: 0.55, blinkRateMultiplier: 0.75, blushEnabled: false, blushWeight: 0 }
  },
  pretend_angry: {
    intensity: 0.5, gaze: 'user', gestureFamily: 'angry',
    expressionMorphs: { primaryMorph: '怒り', primaryWeight: 0.35, secondaryMorph: 'にこり', secondaryWeight: 0.15, blinkRateMultiplier: 1.0, blushEnabled: false, blushWeight: 0 }
  }
};

const DEFAULT_PROFILE: EmotionProfile = {
  intensity: 0.3, gaze: 'user', gestureFamily: 'neutral',
  expressionMorphs: { primaryMorph: '真面目', primaryWeight: 0.1, blinkRateMultiplier: 1.0, blushEnabled: false, blushWeight: 0 }
};

function getEmotionProfile(emotion: string): EmotionProfile {
  const normalized = emotion.toLowerCase();
  const canonical = normalized === 'worried' || normalized === 'worry'
    ? 'concerned'
    : normalized === 'determined'
      ? 'determined'
      : normalized;
  return EMOTION_PROFILES[canonical]
    ?? EMOTION_PROFILES[[...emotionAliases(normalized)][0]]
    ?? DEFAULT_PROFILE;
}

function determineState(input: PlannerInput): PerformanceState {
  if (input.speaking) return 'speaking';
  const e = input.emotion.toLowerCase();
  if (e === 'listening') return 'listening';
  if (e === 'thinking') return 'thinking';
  return 'idle';
}

/**
 * 根据语义级输入从 VMD 情绪映射表中选择 VMD 文件。
 *
 * 选择规则（按优先级）：
 * 1. intent 精确匹配 → 收集所有匹配的 VMD，轮换选择
 *    （文本意图是最多样化的信号，优先用它驱动动作选择）
 * 2. gestureFamily 匹配 → 收集所有匹配的 VMD，轮换选择
 *    （情绪家族作为 fallback，保证情绪一致性）
 * 3. emotion 匹配 → 收集所有匹配的 VMD，轮换选择
 *    每一级优先 starred，其次 dialogueSafe；只有没有 safe 候选时才用其他用户池动作
 * 4. 没有语义匹配时返回 undefined，由上层保持当前默认待机
 *
 * 轮换机制：同一 selectionKey 下，每次调用返回不同的 VMD，避免重复动作。
 */
function selectSpeakingVmd(
  input: PlannerInput,
  vmdMap: readonly VmdEmotionEntry[],
  rotationState: Map<string, number>
): { path: string; level: 'intent' | 'gestureFamily' | 'emotion' | 'daily'; entry: VmdEmotionEntry } | undefined {
  const emotion = input.emotion.toLowerCase();
  const acceptedEmotions = emotionAliases(emotion);
  const intent = (input.intent ?? '').toLowerCase();
  const gestureFamily = (input.gestureFamily ?? '').toLowerCase();
  // Mandatory Worktree Correction Gate #3：
  // enabledVmdPaths=[]（空数组）表示"无动作准入"，不是"全部启用"。
  // null/undefined 表示"未提供 catalog"，此时返回 undefined（无可信动作）。
  // 之前的语义把空数组当作"全部启用"，会让文件名推断的候选 VMD 在无白名单时被盲选。
  const enabled = input.enabledVmdPaths !== undefined
    ? new Set(input.enabledVmdPaths.flatMap(path => [normalizeVmdPath(path), normalizeMotionAlias(path)]))
    : null;  // null = 未提供 catalog（不同于空数组 = 明确无准入）
  const excluded = new Set((input.excludedVmdPaths ?? [])
    .flatMap(path => [normalizeVmdPath(path), normalizeMotionAlias(path)]));
  const isEnabled = (path: string) => {
    const normalized = normalizeVmdPath(path);
    const alias = normalizeMotionAlias(path);
    return enabled !== null
      && (enabled.has(normalized) || enabled.has(alias));
  };
  const isExcluded = (path: string) => {
    const normalized = normalizeVmdPath(path);
    const alias = normalizeMotionAlias(path);
    return excluded.has(normalized) || excluded.has(alias);
  };

  // The automatic candidate set must be identical to the user-facing enabled
  // voice pool. Legacy gesture rows remain available for manual preview and
  // action-library management, but speech can never select them implicitly.
  const speechEntries = vmdMap.filter(isAutomaticVoiceAction);
  const isContextualDailyVoice = (entry: VmdEmotionEntry): boolean => {
    if (entry.type !== 'voice') return false;
    const isGeneral = entry.intent.trim().toLowerCase() === 'general'
      || entry.gestureFamily.trim().toLowerCase() === 'general';
    return isGeneral && entry.emotions.some(value => acceptedEmotions.has(value.trim().toLowerCase()));
  };

  /** Collect and rank matching entries without losing their catalog metadata. */
  function collectCandidates(
    predicate: (entry: VmdEmotionEntry) => boolean,
    allowExcluded = false,
    rank: (entry: VmdEmotionEntry) => number = () => 0
  ): VmdEmotionEntry[] {
    const seen = new Set<string>();
    const result: VmdEmotionEntry[] = [];
    for (const entry of speechEntries) {
      const key = normalizeMotionAlias(entry.vmdPath);
      if (predicate(entry)
        && isEnabled(entry.vmdPath)
        && (allowExcluded || !isExcluded(entry.vmdPath))
        && !seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
    }
    // Specific semantic matches must be considered before a generic daily
    // action. Starred still wins inside the same specificity tier, so the
    // user preference remains effective without allowing a generic action to
    // mask an exact emotion/intent match.
    return result.sort((left, right) => {
      const rankDelta = rank(right) - rank(left);
      if (rankDelta !== 0) return rankDelta;
      return Number(right.starred === true) - Number(left.starred === true);
    });
  }

  /** Choose one candidate with deterministic per-semantic rotation. */
  function pickFromCandidates(candidates: VmdEmotionEntry[], key: string): VmdEmotionEntry | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    const idx = rotationState.get(key) ?? 0;
    rotationState.set(key, (idx + 1) % candidates.length);
    return candidates[idx];
  }

  // 1. intent 优先匹配（文本意图比情绪家族更多样化）
  if (intent) {
    const acceptedIntents = intentAliases(intent);
    const candidates = collectCandidates(
      e => acceptedIntents.has(e.intent.trim().toLowerCase()) || isContextualDailyVoice(e),
      false,
      e => acceptedIntents.has(e.intent.trim().toLowerCase()) ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `intent:${intent}`);
    if (picked) {
      return {
        path: picked.vmdPath,
        level: isContextualDailyVoice(picked) && !acceptedIntents.has(picked.intent.trim().toLowerCase())
          ? 'daily'
          : 'intent',
        entry: picked
      };
    }
  }

  // 2. gestureFamily 匹配（情绪一致性 fallback）
  if (gestureFamily) {
    const candidates = collectCandidates(
      e => e.gestureFamily.toLowerCase() === gestureFamily || isContextualDailyVoice(e),
      false,
      e => e.gestureFamily.toLowerCase() === gestureFamily ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `gf:${gestureFamily}`);
    if (picked) {
      return {
        path: picked.vmdPath,
        level: isContextualDailyVoice(picked) && picked.gestureFamily.toLowerCase() !== gestureFamily
          ? 'daily'
          : 'gestureFamily',
        entry: picked
      };
    }
  }

  // 3. emotion 匹配
  {
    const candidates = collectCandidates(
      e => e.emotions.some(em => acceptedEmotions.has(em.toLowerCase())),
      false,
      e => e.emotions.some(em => em.toLowerCase() === emotion) ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `emo:${emotion}`);
    if (picked) return { path: picked.vmdPath, level: 'emotion', entry: picked };
  }

  // 4. Exact semantic choices can be exhausted by the recent-reply window.
  // Keep speech visibly animated by choosing another enabled daily voice
  // action before considering a repeat from that window.
  {
    const candidates = collectCandidates(e => e.type === 'voice');
    const picked = pickFromCandidates(candidates, 'daily:fallback');
    if (picked) return { path: picked.vmdPath, level: 'daily', entry: picked };
  }

  // 5. If every enabled candidate is in the recent window, reuse a semantic
  // candidate instead of returning no motion. Rotation state still advances,
  // so the least-diverse pool repeats only when no alternative is available.
  if (intent) {
    const acceptedIntents = intentAliases(intent);
    const candidates = collectCandidates(
      e => acceptedIntents.has(e.intent.trim().toLowerCase()) || isContextualDailyVoice(e),
      true,
      e => acceptedIntents.has(e.intent.trim().toLowerCase()) ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `intent:${intent}`);
    if (picked) {
      return {
        path: picked.vmdPath,
        level: isContextualDailyVoice(picked) && !acceptedIntents.has(picked.intent.trim().toLowerCase())
          ? 'daily'
          : 'intent',
        entry: picked
      };
    }
  }
  if (gestureFamily) {
    const candidates = collectCandidates(
      e => e.gestureFamily.toLowerCase() === gestureFamily || isContextualDailyVoice(e),
      true,
      e => e.gestureFamily.toLowerCase() === gestureFamily ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `gf:${gestureFamily}`);
    if (picked) {
      return {
        path: picked.vmdPath,
        level: isContextualDailyVoice(picked) && picked.gestureFamily.toLowerCase() !== gestureFamily
          ? 'daily'
          : 'gestureFamily',
        entry: picked
      };
    }
  }
  {
    const candidates = collectCandidates(
      e => e.emotions.some(em => acceptedEmotions.has(em.toLowerCase())),
      true,
      e => e.emotions.some(em => em.toLowerCase() === emotion) ? 2 : 1
    );
    const picked = pickFromCandidates(candidates, `emo:${emotion}`);
    if (picked) return { path: picked.vmdPath, level: 'emotion', entry: picked };
  }
  {
    const candidates = collectCandidates(e => e.type === 'voice', true);
    const picked = pickFromCandidates(candidates, 'daily:fallback');
    if (picked) return { path: picked.vmdPath, level: 'daily', entry: picked };
  }

  // 6. 缺失 catalog 匹配时返回 undefined。没有文件名推断或硬编码动作
  // 兜底，避免播放不存在或与语境无关的 VMD。
  return undefined;
}

/**
 * PerformancePlanner：根据语义级输入生成 PerformancePlan。
 *
 * Phase 6 重构：不再依赖程序化 pack，而是通过 manifest.json 的 vmdEmotionMap
 * 配置选择真实的 VMD 文件。
 */
export class PerformancePlanner {
  /** VMD 情绪映射表（从 manifest.json 加载） */
  private vmdEmotionMap: readonly VmdEmotionEntry[] = [];
  /**
   * VMD 轮换状态：记录每个 selectionKey 的下次索引。
   * 同一 selectionKey（如 `gf:serious`、`emo:happy`）下，
   * 每次调用 plan() 返回不同的 VMD，避免连续重复动作。
   */
  private readonly rotationState = new Map<string, number>();

  /**
   * 更新 VMD 情绪映射表。
   * 应在模型包切换时调用，从新的 manifest.json 加载映射。
   */
  updateVmdEmotionMap(map: readonly VmdEmotionEntry[]): void {
    this.vmdEmotionMap = map;
    // 切换模型包时重置轮换状态
    this.rotationState.clear();
  }

  /**
   * 生成 PerformancePlan。
   */
  plan(input: PlannerInput): PerformancePlan {
    const state = determineState(input);
    const profile = getEmotionProfile(input.emotion);
    const intent = input.intent ?? '';

    // intensity：优先使用输入，否则使用 emotion profile 推断
    const baseIntensity = input.intensity ?? profile.intensity;
    const intensity = input.speaking
      ? Math.min(1, baseIntensity + 0.1)
      : baseIntensity;

    // gaze：优先使用输入，否则使用 emotion profile 推断
    const gaze = input.gaze ?? profile.gaze;

    // gestureFamily：优先使用输入，否则使用 emotion profile 推断
    const gestureFamily = input.gestureFamily ?? profile.gestureFamily;

    let speakingVmdPath: string | undefined;
    let speakingVmdMatch: PerformancePlan['speakingVmdMatch'];
    let voiceActionSelectionReason: PerformancePlan['voiceActionSelectionReason'];

    if (state === 'speaking') {
      // speaking 状态：从 VMD 情绪映射表中选择 gesture VMD（支持轮换）
      const selection = selectSpeakingVmd({
        emotion: input.emotion,
        intent,
        gestureFamily,
        speaking: true,
        enabledVmdPaths: input.enabledVmdPaths,
        excludedVmdPaths: input.excludedVmdPaths,
        defaultIdleVmd: input.defaultIdleVmd
      }, this.vmdEmotionMap, this.rotationState);
      speakingVmdPath = selection?.path;
      speakingVmdMatch = selection
        ? { level: selection.level, entry: selection.entry }
        : undefined;
      voiceActionSelectionReason = selection
        ? 'selected'
        : this.vmdEmotionMap.some(isAutomaticVoiceAction)
          ? 'no-matching-enabled-action'
          : 'voice-pool-empty';
    }

    return {
      state,
      emotion: input.emotion,
      intent,
      intensity,
      gaze,
      gestureFamily,
      speakingVmdPath,
      speakingVmdMatch,
      voiceActionSelectionReason,
      expressionMorphs: profile.expressionMorphs
    };
  }
}
