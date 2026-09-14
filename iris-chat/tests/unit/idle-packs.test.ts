import { describe, expect, it } from 'vitest';
import {
  IDLE_PACK_IDS,
  getAllIdlePackIds,
  getAllIdlePackManifests,
  getIdlePackBytes,
  getIdlePackCatalog,
  getIdlePackDisplayName,
  getIdlePackManifest,
  initializeIdlePackHashes
} from '../../src/motion/idle-packs';

describe('legacy procedural idle packs', () => {
  it('stays empty because the user-selected customVmd idle is authoritative', async () => {
    await expect(initializeIdlePackHashes()).resolves.toBeUndefined();
    expect(IDLE_PACK_IDS).toEqual([]);
    expect(getAllIdlePackIds()).toEqual([]);
    expect(getAllIdlePackManifests()).toEqual([]);
    expect(getIdlePackCatalog()).toEqual([]);
  });

  it('does not silently seed a removed procedural idle', () => {
    expect(getIdlePackDisplayName('idle-stand-breathe-v1')).toBe('');
    expect(getIdlePackManifest('idle-stand-breathe-v1')).toBeUndefined();
    expect(() => getIdlePackBytes('idle-stand-breathe-v1'))
      .toThrow(/程序化动作已废弃.*customVmd/u);
  });
});
