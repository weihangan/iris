import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVmd } from '../../src/motion/motion-pack-loader';
import { resolvePlayableAvatarMaxFrame } from '../../src/motion/motion-player';
import { validateHeadOverlayTracks } from '../../src/motion/head-overlay';

const assets = [
  { file: '失落担心_低头30度_仅头部.vmd', maxFrame: 156 },
  { file: '回忆想念_朝屏幕中间上方侧脸_仅头部.vmd', maxFrame: 150 }
] as const;

describe('formal head-only voice-action assets', () => {
  for (const asset of assets) {
    it(`${asset.file} contains only zero-translation head and neck tracks`, async () => {
      const bytes = await readFile(resolve(process.cwd(), 'models', 'shared', 'motions', asset.file));
      const loaded = await loadVmd(bytes);
      expect(validateHeadOverlayTracks(loaded)).toEqual({ valid: true, reasons: [] });
      expect(Object.keys(loaded.boneTracks).sort()).toEqual(['首', '頭'].sort());
      expect(resolvePlayableAvatarMaxFrame(loaded)).toBe(asset.maxFrame);
      if (asset.file === '失落担心_低头30度_仅头部.vmd') {
        const headRotations = Array.from(loaded.boneTracks['頭'].rotations);
        const headX = headRotations.filter((_value, index) => index % 4 === 0);
        const neckRotations = Array.from(loaded.boneTracks['首'].rotations);
        const neckX = neckRotations.filter((_value, index) => index % 4 === 0);
        expect(Math.min(...headX)).toBeLessThan(-0.1);
        expect(Math.min(...neckX)).toBeLessThan(-0.03);
      }
    });
  }
});
