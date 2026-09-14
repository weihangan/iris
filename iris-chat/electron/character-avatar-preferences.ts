export interface LightingPresetSummary {
  id: string;
  name: string;
}

/**
 * Stable presets are owned by ChatX2, not by a model or renderer lifecycle.
 * Keeping this metadata in the main process prevents a temporarily unavailable
 * Avatar window from erasing the settings-panel choices.
 */
export const BUILTIN_LIGHTING_PRESET_SUMMARIES: readonly LightingPresetSummary[] = Object.freeze([
  { id: 'warm-studio', name: '暖色工作室' },
  { id: 'cool-daylight', name: '冷色日光' },
  { id: 'dramatic', name: '戏剧舞台' },
  { id: 'soft-portrait', name: '柔和肖像' },
  { id: 'night-mood', name: '夜色氛围' }
]);

export function mergeLightingPresetSummaries(runtimePresets: unknown): LightingPresetSummary[] {
  const merged = new Map<string, LightingPresetSummary>(
    BUILTIN_LIGHTING_PRESET_SUMMARIES.map(preset => [preset.id, { ...preset }])
  );
  if (!Array.isArray(runtimePresets)) return [...merged.values()];
  for (const candidate of runtimePresets) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = 'id' in candidate && typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = 'name' in candidate && typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!id || !name) continue;
    merged.set(id, { id, name });
  }
  return [...merged.values()];
}
