import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

export const MIN_TRANSITION_SPEED = 0.5;
export const MAX_TRANSITION_SPEED = 1.8;
export const DEFAULT_TRANSITION_SPEED = 0.7;

function isValidTransitionSpeed(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_TRANSITION_SPEED
    && value <= MAX_TRANSITION_SPEED;
}

/** Read only the user preference; malformed data fails closed to the default. */
export function loadTransitionSpeed(
  settingsPath: string,
  fallback = DEFAULT_TRANSITION_SPEED
): number {
  const safeFallback = isValidTransitionSpeed(fallback) ? fallback : DEFAULT_TRANSITION_SPEED;
  try {
    if (!existsSync(settingsPath)) return safeFallback;
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const value = parsed && typeof parsed === 'object'
      ? (parsed as { transitionSpeed?: unknown }).transitionSpeed
      : undefined;
    return isValidTransitionSpeed(value) ? value : safeFallback;
  } catch {
    return safeFallback;
  }
}

/** Persist atomically so a crash cannot leave a half-written preference. */
export function saveTransitionSpeed(settingsPath: string, value: number): boolean {
  if (!isValidTransitionSpeed(value)) return false;
  const directory = dirname(settingsPath);
  const temporaryPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify({
      schemaVersion: 1,
      transitionSpeed: value,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    renameSync(temporaryPath, settingsPath);
    return true;
  } catch {
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    return false;
  }
}
