import { describe, expect, it } from 'vitest';
import { getDesktopComposerBounds } from '../../electron/windows/desktop-composer-layout';

describe('desktop composer layout', () => {
  it('opens as a wide single-row composer instead of growing vertically', () => {
    const bounds = getDesktopComposerBounds({ width: 1920, height: 1040 });

    expect(bounds.width).toBe(680);
    expect(bounds.height).toBe(108);
    expect(bounds.minWidth).toBe(520);
    expect(bounds.minHeight).toBe(96);
    expect(bounds.maxWidth).toBe(1000);
    expect(bounds.maxHeight).toBe(180);
    expect(bounds.y + bounds.height).toBe(1020);
  });

  it('stays on screen when the usable desktop is short', () => {
    const bounds = getDesktopComposerBounds({ width: 1280, height: 180 });

    expect(bounds.height).toBeLessThanOrEqual(160);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(180);
  });
});
