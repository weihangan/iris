import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isAvatarComputeLevel,
  type AvatarComputeLevel
} from '../src/performance/avatar-compute-profile';

export const DEFAULT_AVATAR_COMPUTE_LEVEL: AvatarComputeLevel = 'high';

export function loadAvatarComputeLevel(
  settingsPath: string,
  fallback: AvatarComputeLevel = DEFAULT_AVATAR_COMPUTE_LEVEL
): AvatarComputeLevel {
  const safeFallback = isAvatarComputeLevel(fallback) ? fallback : DEFAULT_AVATAR_COMPUTE_LEVEL;
  try {
    if (!existsSync(settingsPath)) return safeFallback;
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const level = parsed && typeof parsed === 'object'
      ? (parsed as { level?: unknown }).level
      : undefined;
    return isAvatarComputeLevel(level) ? level : safeFallback;
  } catch {
    return safeFallback;
  }
}

export function saveAvatarComputeLevel(settingsPath: string, level: AvatarComputeLevel): boolean {
  if (!isAvatarComputeLevel(level)) return false;
  const directory = dirname(settingsPath);
  const temporaryPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify({
      schemaVersion: 1,
      level,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    renameSync(temporaryPath, settingsPath);
    return true;
  } catch {
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    return false;
  }
}
