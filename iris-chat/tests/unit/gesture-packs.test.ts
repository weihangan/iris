import { describe, expect, it } from 'vitest';
import {
  GESTURE_PACK_IDS,
  getAllGesturePackIds,
  getAllGesturePackManifests,
  getGesturePackBytes,
  getGesturePackCatalog,
  getGesturePackDisplayName,
  getGesturePackManifest,
  getGestureSemanticMappings,
  initializeGesturePackHashes
} from '../../src/motion/gesture-packs';

describe('legacy procedural gesture packs', () => {
  it('stays empty because production gestures come from model customVmd files', async () => {
    await expect(initializeGesturePackHashes()).resolves.toBeUndefined();
    expect(GESTURE_PACK_IDS).toEqual([]);
    expect(getAllGesturePackIds()).toEqual([]);
    expect(getAllGesturePackManifests()).toEqual([]);
    expect(getGesturePackCatalog()).toEqual([]);
    expect(getGestureSemanticMappings()).toEqual([]);
  });

  it('does not silently resurrect a removed procedural default', () => {
    expect(getGesturePackDisplayName('gesture-open-hand-small-v1')).toBe('');
    expect(getGesturePackManifest('gesture-open-hand-small-v1')).toBeUndefined();
    expect(() => getGesturePackBytes('gesture-open-hand-small-v1'))
      .toThrow(/程序化动作已废弃.*customVmd/u);
  });
});
