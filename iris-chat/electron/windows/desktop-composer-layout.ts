export interface DesktopWorkAreaSize {
  readonly width: number;
  readonly height: number;
}

export interface DesktopComposerBounds {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly x: number;
  readonly y: number;
}

const DEFAULT_WIDTH = 680;
const DEFAULT_HEIGHT = 108;
const BOTTOM_MARGIN = 20;

export function getDesktopComposerBounds(workArea: DesktopWorkAreaSize): DesktopComposerBounds {
  const availableHeight = Math.max(60, workArea.height - BOTTOM_MARGIN);
  const height = Math.min(DEFAULT_HEIGHT, availableHeight);
  return {
    width: DEFAULT_WIDTH,
    height,
    minWidth: Math.min(520, DEFAULT_WIDTH),
    minHeight: Math.min(96, height),
    maxWidth: 1000,
    maxHeight: Math.max(height, Math.min(180, workArea.height)),
    x: Math.max(0, Math.round((workArea.width - DEFAULT_WIDTH) / 2)),
    y: Math.max(0, workArea.height - height - BOTTOM_MARGIN)
  };
}
