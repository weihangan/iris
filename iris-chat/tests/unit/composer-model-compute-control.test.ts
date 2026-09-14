import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('desktop composer model controls', () => {
  it('exposes four model compute levels without coupling them to TTS', () => {
    const html = read('src/composer.html');
    const preload = read('electron/preloads/composer-preload.ts');
    const renderer = read('src/composer-renderer.ts');

    for (const level of ['low', 'medium', 'high', 'ultra']) {
      expect(html).toContain(`data-compute-level="${level}"`);
    }
    expect(preload).toContain("ipcRenderer.invoke('chatx2:set-render-quality', level)");
    expect(preload).toContain("ipcRenderer.invoke('chatx2:get-render-quality')");
    expect(renderer).toContain('initModelComputeControl');
    expect(renderer).not.toMatch(/setRenderQuality[\s\S]{0,120}(tts|voice|device)/i);
  });

  it('offers one-click dialogue-safe selection beside voice action controls', () => {
    const renderer = read('src/renderer.ts');
    const compatibilityUi = read('chat5-compat/public/index.html');
    expect(renderer).toContain('toggle-dialogue-safe');
    expect(compatibilityUi).toContain('chatx2-voice-safe-toggle');
  });

  it('offers a user-focus lock in the model input toolbar', () => {
    const html = read('src/composer.html');
    const preload = read('electron/preloads/composer-preload.ts');
    expect(html).toContain('btn-avatar-gaze-lock');
    expect(preload).toContain("ipcRenderer.invoke('chatx2:set-gaze-lock', locked)");
  });
});
