/** Neutral model contrast. Zero keeps the existing canvas output unchanged. */
export const DEFAULT_LIGHTING_CONTRAST = 0;
/** Neutral model saturation. Zero keeps the existing canvas colors unchanged. */
export const DEFAULT_LIGHTING_SATURATION = 0;

const MIN_LIGHTING_CONTRAST = -1;
const MAX_LIGHTING_CONTRAST = 1;

function clampLightingValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_LIGHTING_CONTRAST, Math.max(MIN_LIGHTING_CONTRAST, value));
}

/** Normalize persisted/UI contrast values before applying them to the canvas. */
export function clampLightingContrast(value: unknown): number {
  return clampLightingValue(value);
}

/** Normalize persisted/UI saturation values before applying them to the canvas. */
export function clampLightingSaturation(value: unknown): number {
  return clampLightingValue(value);
}

/** Convert the normalized value to a CSS filter for the transparent avatar canvas. */
export function contrastCssFilter(value: unknown): string {
  const normalized = clampLightingContrast(value);
  if (normalized === DEFAULT_LIGHTING_CONTRAST) return 'none';
  return `contrast(${1 + normalized})`;
}

/** Convert saturation to a CSS filter while keeping zero neutral. */
export function saturationCssFilter(value: unknown): string {
  const normalized = clampLightingSaturation(value);
  if (normalized === DEFAULT_LIGHTING_SATURATION) return 'none';
  return `saturate(${1 + normalized})`;
}

/** Compose the independent contrast and saturation controls for the canvas. */
export function lightingCanvasFilter(contrast: unknown, saturation: unknown): string {
  return [contrastCssFilter(contrast), saturationCssFilter(saturation)]
    .filter(filter => filter !== 'none')
    .join(' ') || 'none';
}
