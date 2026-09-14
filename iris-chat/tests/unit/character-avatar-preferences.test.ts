import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LIGHTING_PRESET_SUMMARIES,
  mergeLightingPresetSummaries
} from '../../electron/character-avatar-preferences';

const projectRoot = resolve(__dirname, '..', '..');
const source = (relativePath: string): string => readFileSync(resolve(projectRoot, relativePath), 'utf8');

describe('character-scoped Avatar preferences', () => {
  it('keeps all five built-in lighting presets when the Avatar runtime is not ready', () => {
    expect(BUILTIN_LIGHTING_PRESET_SUMMARIES).toEqual([
      { id: 'warm-studio', name: '暖色工作室' },
      { id: 'cool-daylight', name: '冷色日光' },
      { id: 'dramatic', name: '戏剧舞台' },
      { id: 'soft-portrait', name: '柔和肖像' },
      { id: 'night-mood', name: '夜色氛围' }
    ]);
    expect(mergeLightingPresetSummaries([])).toEqual(BUILTIN_LIGHTING_PRESET_SUMMARIES);
  });

  it('merges runtime lighting presets without removing or duplicating built-ins', () => {
    expect(mergeLightingPresetSummaries([
      { id: 'warm-studio', name: '角色暖光' },
      { id: 'custom-moon', name: '角色月光' }
    ])).toEqual([
      { id: 'warm-studio', name: '角色暖光' },
      { id: 'cool-daylight', name: '冷色日光' },
      { id: 'dramatic', name: '戏剧舞台' },
      { id: 'soft-portrait', name: '柔和肖像' },
      { id: 'night-mood', name: '夜色氛围' },
      { id: 'custom-moon', name: '角色月光' }
    ]);
  });

  it('does not overwrite the restored character model with legacy profile data', () => {
    const browser = source('chat5-compat/public/app.js');
    expect(browser).toContain('let avatarRestoredByElectron = false;');
    expect(browser).toContain('avatarRestoredByElectron = Boolean(activeResult && activeResult.success);');
    expect(browser).toContain('if (!avatarRestoredByElectron && data.modelPackId && window.chatx2 && window.chatx2.switchModelPack)');
    expect(browser).not.toContain('if (data.modelPackId && window.chatx2 && window.chatx2.switchModelPack)');
  });

  it('returns saved dynamic lighting to the settings panel', () => {
    const main = source('electron/main.ts');
    const html = source('chat5-compat/public/index.html');
    expect(main).toContain('dynamic: savedLighting.dynamic ?? {}');
    expect(html).toContain('applyLightingStateToSliders(result.dynamic || {})');
    expect(main).toContain("'contrast'");
    expect(html).toContain('id="lt-contrast"');
    expect(html).toContain('contrast: contrast');
    expect(main).toContain("'saturation'");
    expect(html).toContain('id="lt-saturation"');
    expect(html).toContain('saturation: saturation');
  });
});
