import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 默认待机表情（全局统一偏好，跨模型）。
 * 右键点击模型 → "默认表情" 可切换；持久化到 sharedDataDir 下，
 * 所有模型（内置 + 导入）共用一个默认表情。
 */

export type DefaultAvatarExpression =
  | 'loving'   // 开心（微笑+开心+羞涩复合，含情脉脉）
  | 'serious'  // 冷酷（认真）
  | 'sad'      // 伤心
  | 'shy'      // 害羞
  | 'angry';   // 生气

export const DEFAULT_AVATAR_EXPRESSION: DefaultAvatarExpression = 'loving';

const VALID = new Set<string>(['loving', 'serious', 'sad', 'shy', 'angry']);

export function isValidDefaultExpression(value: unknown): value is DefaultAvatarExpression {
  return typeof value === 'string' && VALID.has(value);
}

/** 只读偏好；损坏数据回退到默认值。 */
export function loadDefaultAvatarExpression(
  settingsPath: string,
  fallback: DefaultAvatarExpression = DEFAULT_AVATAR_EXPRESSION
): DefaultAvatarExpression {
  const safeFallback = isValidDefaultExpression(fallback) ? fallback : DEFAULT_AVATAR_EXPRESSION;
  try {
    if (!existsSync(settingsPath)) return safeFallback;
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const value = parsed && typeof parsed === 'object'
      ? (parsed as { defaultExpression?: unknown }).defaultExpression
      : undefined;
    return isValidDefaultExpression(value) ? value : safeFallback;
  } catch {
    return safeFallback;
  }
}

/** 原子写入，崩溃不会留下半写偏好。 */
export function saveDefaultAvatarExpression(settingsPath: string, value: DefaultAvatarExpression): boolean {
  if (!isValidDefaultExpression(value)) return false;
  const directory = dirname(settingsPath);
  const temporaryPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify({
      schemaVersion: 1,
      defaultExpression: value,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    renameSync(temporaryPath, settingsPath);
    return true;
  } catch {
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    return false;
  }
}