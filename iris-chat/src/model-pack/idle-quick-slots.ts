export const MAX_IDLE_QUICK_SLOTS = 4;

export interface IdleQuickSlot {
  readonly slot: number;
  readonly path: string | null;
}

export function normalizeIdleQuickSlotPaths(paths: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const path of paths) {
    const value = typeof path === 'string' ? path.trim() : '';
    if (!value || normalized.includes(value)) continue;
    normalized.push(value);
    if (normalized.length === MAX_IDLE_QUICK_SLOTS) break;
  }
  return normalized;
}

export function buildIdleQuickSlots(paths: readonly string[]): IdleQuickSlot[] {
  const normalized = normalizeIdleQuickSlotPaths(paths);
  return Array.from({ length: MAX_IDLE_QUICK_SLOTS }, (_, index) => ({
    slot: index + 1,
    path: normalized[index] ?? null
  }));
}
