import { describe, expect, it } from 'vitest';
import {
  MAX_IDLE_QUICK_SLOTS,
  buildIdleQuickSlots,
  normalizeIdleQuickSlotPaths
} from '../../src/model-pack/idle-quick-slots';

describe('idle quick slots', () => {
  it('maps the first four pool entries to stable numbered slots', () => {
    const slots = buildIdleQuickSlots(['a.vmd', 'b.vmd', 'c.vmd', 'd.vmd', 'e.vmd']);

    expect(MAX_IDLE_QUICK_SLOTS).toBe(4);
    expect(slots).toEqual([
      { slot: 1, path: 'a.vmd' },
      { slot: 2, path: 'b.vmd' },
      { slot: 3, path: 'c.vmd' },
      { slot: 4, path: 'd.vmd' }
    ]);
  });

  it('removes duplicates and empty paths before applying the limit', () => {
    expect(normalizeIdleQuickSlotPaths(['a.vmd', '', 'a.vmd', 'b.vmd'])).toEqual([
      'a.vmd',
      'b.vmd'
    ]);
  });
});
