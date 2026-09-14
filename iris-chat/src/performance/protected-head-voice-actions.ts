import type { VmdEmotionEntry } from '../model-pack/model-pack-types';

export const MIN_PROTECTED_HEAD_ROTATION_SCALE = 0.75;
export const MAX_PROTECTED_HEAD_ROTATION_SCALE = 1.2;

export interface HeadOverlayTuning {
  readonly rotationScale: number;
}

export interface ProtectedHeadVoiceAction extends VmdEmotionEntry {
  readonly protected: true;
  readonly motionScope: 'head-overlay';
  readonly headOverlayId: NonNullable<VmdEmotionEntry['headOverlayId']>;
  readonly headTuning: HeadOverlayTuning;
}

export interface ProtectedHeadVoiceActionOverride {
  readonly starred?: boolean;
  readonly dialogueSafe?: boolean;
  readonly headTuning?: HeadOverlayTuning;
}

export type ProtectedHeadVoiceActionOverrides = Readonly<Record<string, ProtectedHeadVoiceActionOverride>>;

const protectedEntry = (
  headOverlayId: ProtectedHeadVoiceAction['headOverlayId'],
  vmdFile: string,
  displayName: string,
  gestureFamily: string,
  intent: string,
  emotions: string[],
  description: string
): ProtectedHeadVoiceAction => ({
  vmdPath: `../shared/motions/${vmdFile}`,
  displayName,
  type: 'voice',
  gestureFamily,
  intent,
  emotions,
  description,
  dialogueSafe: true,
  motionScope: 'head-overlay',
  headOverlayId,
  protected: true,
  headTuning: { rotationScale: 1 }
});

export const PROTECTED_HEAD_VOICE_ACTIONS: readonly ProtectedHeadVoiceAction[] = [
  protectedEntry(
    'curious-left-tilt',
    '疑惑_人物左侧歪头10度_仅头部.vmd',
    '疑惑·向人物左侧歪头（仅头部）',
    'curious',
    'think',
    ['curious', 'thinking'],
    '身体动作保持不变；头颈以人物自身方向缓慢向左侧歪约10°后自然回正，面部表情仍由当前句子情绪驱动。'
  ),
  protectedEntry(
    'concerned-down',
    '失落担心_低头30度_仅头部.vmd',
    '失落/担心·低头（仅头部）',
    'concerned',
    'concern',
    ['sad', 'concerned', 'worry'],
    '身体动作保持不变；头颈缓慢低下约30°再自然回正，面部表情仍由当前句子情绪驱动。'
  ),
  protectedEntry(
    'remember-inward-up',
    '回忆想念_朝屏幕中间上方侧脸_仅头部.vmd',
    '回忆/想念·朝屏幕中间上方侧脸（仅头部）',
    'remember',
    'remember',
    ['thinking', 'gentle', 'nostalgic'],
    '身体动作保持不变；根据人物所在屏幕位置，在动作开始时朝屏幕中间上方轻微侧脸，面部表情仍由当前句子情绪驱动。'
  )
];

export function normalizeProtectedVoiceActionPath(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

const protectedByPath = new Map(PROTECTED_HEAD_VOICE_ACTIONS.map(entry => [
  normalizeProtectedVoiceActionPath(entry.vmdPath),
  entry
]));

export function getProtectedHeadVoiceAction(value: string): ProtectedHeadVoiceAction | null {
  return protectedByPath.get(normalizeProtectedVoiceActionPath(value)) ?? null;
}

export function isProtectedVoiceActionPath(value: string): boolean {
  return protectedByPath.has(normalizeProtectedVoiceActionPath(value));
}

export function clampProtectedHeadRotationScale(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(MAX_PROTECTED_HEAD_ROTATION_SCALE, Math.max(MIN_PROTECTED_HEAD_ROTATION_SCALE, numeric));
}

export function sanitizeProtectedHeadVoiceActionUpdates(
  updates: Partial<VmdEmotionEntry>
): ProtectedHeadVoiceActionOverride | null {
  const keys = Object.keys(updates);
  if (keys.some(key => key !== 'starred' && key !== 'dialogueSafe' && key !== 'headTuning')) return null;
  const result: {
    starred?: boolean;
    dialogueSafe?: boolean;
    headTuning?: HeadOverlayTuning;
  } = {};
  if ('starred' in updates) {
    if (typeof updates.starred !== 'boolean') return null;
    result.starred = updates.starred;
  }
  if ('dialogueSafe' in updates) {
    if (typeof updates.dialogueSafe !== 'boolean') return null;
    result.dialogueSafe = updates.dialogueSafe;
  }
  if ('headTuning' in updates) {
    const tuning = updates.headTuning;
    if (!tuning || typeof tuning !== 'object') return null;
    result.headTuning = {
      rotationScale: clampProtectedHeadRotationScale(tuning.rotationScale)
    };
  }
  return result;
}

export function mergeProtectedHeadVoiceActions(
  persistedEntries: readonly VmdEmotionEntry[],
  overrides: ProtectedHeadVoiceActionOverrides = {}
): VmdEmotionEntry[] {
  const overrideByPath = new Map(Object.entries(overrides).map(([path, value]) => [
    normalizeProtectedVoiceActionPath(path),
    value
  ]));
  const protectedEntries = PROTECTED_HEAD_VOICE_ACTIONS.map(canonical => {
    const override = overrideByPath.get(normalizeProtectedVoiceActionPath(canonical.vmdPath));
    return {
      ...canonical,
      emotions: [...canonical.emotions],
      ...(override?.starred !== undefined ? { starred: override.starred } : {}),
      ...(override?.dialogueSafe !== undefined ? { dialogueSafe: override.dialogueSafe } : {}),
      headTuning: {
        rotationScale: clampProtectedHeadRotationScale(
          override?.headTuning?.rotationScale ?? canonical.headTuning.rotationScale
        )
      }
    };
  });
  const userEntries = persistedEntries
    .filter(entry => !isProtectedVoiceActionPath(entry.vmdPath))
    .map(entry => ({ ...entry, emotions: [...entry.emotions] }));
  return [...protectedEntries, ...userEntries];
}
