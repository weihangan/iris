import {
  clampLightingContrast,
  clampLightingSaturation,
  contrastCssFilter,
  DEFAULT_LIGHTING_CONTRAST,
  DEFAULT_LIGHTING_SATURATION,
  lightingCanvasFilter
} from '../../src/lighting/contrast';

describe('lighting contrast', () => {
  it('uses zero as the neutral default', () => {
    expect(DEFAULT_LIGHTING_CONTRAST).toBe(0);
    expect(DEFAULT_LIGHTING_SATURATION).toBe(0);
    expect(clampLightingContrast(undefined)).toBe(0);
    expect(clampLightingSaturation(undefined)).toBe(0);
    expect(contrastCssFilter(0)).toBe('none');
    expect(lightingCanvasFilter(0, 0)).toBe('none');
  });

  it('clamps finite values to the supported range', () => {
    expect(clampLightingContrast(-2)).toBe(-1);
    expect(clampLightingContrast(2)).toBe(1);
    expect(clampLightingContrast(Number.NaN)).toBe(0);
    expect(clampLightingContrast(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampLightingSaturation(-2)).toBe(-1);
    expect(clampLightingSaturation(2)).toBe(1);
  });

  it('maps contrast to a canvas CSS filter without changing the neutral state', () => {
    expect(contrastCssFilter(-0.5)).toBe('contrast(0.5)');
    expect(contrastCssFilter(0.25)).toBe('contrast(1.25)');
    expect(contrastCssFilter(1)).toBe('contrast(2)');
  });

  it('combines contrast and saturation without changing neutral output', () => {
    expect(lightingCanvasFilter(0, 0.5)).toBe('saturate(1.5)');
    expect(lightingCanvasFilter(0.25, 0)).toBe('contrast(1.25)');
    expect(lightingCanvasFilter(0.25, 0.5)).toBe('contrast(1.25) saturate(1.5)');
    expect(lightingCanvasFilter(0, -1)).toBe('saturate(0)');
  });
});
