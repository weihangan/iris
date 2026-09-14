// 规格：穿透状态拆分（click-through-and-motion-transition-spec.md 第一部分）
//
// 三状态拆分：
// - manualModelPassThrough：用户意图（仅"模型穿透"按钮可改）
// - pointerOnModel：瞬时命中（射线检测）
// - draggingModel：瞬时状态（mousedown/mouseup）
//
// 窗口实际状态公式：
//   effectiveIgnoreMouse =
//     manualModelPassThrough ||
//     (!pointerOnModel && !draggingModel);

/**
 * 计算 Electron 窗口是否应忽略鼠标事件（穿透）。
 *
 * 语义：
 * - manualModelPassThrough=true：用户手动开启模型穿透，无论鼠标位置如何，窗口都穿透
 * - pointerOnModel=true：鼠标在模型上，窗口不穿透（模型可交互）
 * - draggingModel=true：正在拖拽模型，窗口不穿透（可继续拖拽）
 *
 * 优先级：manualModelPassThrough > draggingModel > pointerOnModel
 *
 * @param manualModelPassThrough 用户手动开启的模型穿透开关
 * @param pointerOnModel 鼠标是否命中模型（射线检测）
 * @param draggingModel 是否正在拖拽模型
 * @returns true 表示窗口应穿透（setIgnoreMouseEvents(true)），false 表示不穿透
 */
export function computeEffectiveIgnoreMouse(
  manualModelPassThrough: boolean,
  pointerOnModel: boolean,
  draggingModel: boolean
): boolean {
  return manualModelPassThrough || (!pointerOnModel && !draggingModel);
}

export interface AvatarMousePolicyState {
  readonly manualModelPassThrough: boolean;
  readonly pointerOnModel: boolean;
  readonly draggingModel: boolean;
  readonly effectiveIgnoreMouse: boolean;
}

/**
 * Owns the three independent mouse-policy inputs and applies the effective
 * BrowserWindow state only when it changes. The renderer supplies the actual
 * IPC callback so this class remains deterministic and unit-testable.
 */
export class AvatarMousePolicyController {
  private manualModelPassThrough = false;
  private pointerOnModel = false;
  private draggingModel = false;
  private lastApplied: boolean | undefined;

  constructor(private readonly apply: (effectiveIgnoreMouse: boolean) => void) {}

  sync(): void {
    this.applyIfChanged(true);
  }

  setManualModelPassThrough(value: boolean): void {
    this.manualModelPassThrough = value;
    this.applyIfChanged();
  }

  setPointerOnModel(value: boolean): void {
    this.pointerOnModel = value;
    this.applyIfChanged();
  }

  setDraggingModel(value: boolean): void {
    this.draggingModel = value;
    this.applyIfChanged();
  }

  getState(): AvatarMousePolicyState {
    return {
      manualModelPassThrough: this.manualModelPassThrough,
      pointerOnModel: this.pointerOnModel,
      draggingModel: this.draggingModel,
      effectiveIgnoreMouse: computeEffectiveIgnoreMouse(
        this.manualModelPassThrough,
        this.pointerOnModel,
        this.draggingModel
      )
    };
  }

  private applyIfChanged(force = false): void {
    const effective = computeEffectiveIgnoreMouse(
      this.manualModelPassThrough,
      this.pointerOnModel,
      this.draggingModel
    );
    if (!force && effective === this.lastApplied) return;
    this.lastApplied = effective;
    this.apply(effective);
  }
}
