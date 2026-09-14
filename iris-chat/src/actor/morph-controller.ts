// MorphController（Phase 3 Task 3.1）
// 职责：按名称管理 PMX morph 权重，强制安全范围，事务性批量设置
//
// 设计原则：
// - fail-closed：未知 morph 名称一律拒绝，避免误操作未审计的表情
// - 安全范围：某些 morph（如 FaceRed）有视觉/审美上限，需单独配置
// - 事务性：applyBatch 中若任一 morph 未知，整批拒绝，不做部分修改
// - 纯逻辑：不依赖 Three.js / DOM，可在主进程和测试中使用
// - 可观察：通过 bindSink 将权重变更推送到外部 sink（如 Three.js mesh）
//
// 实际的 PMX morph 绑定（MMDLoader mesh.morphTargetInfluences）通过 MorphSink 完成。

export interface MorphSafeRange {
  readonly min: number;
  readonly max: number;
}

export interface ActiveMorph {
  readonly name: string;
  readonly weight: number;
}

/**
 * Morph 权重变更接收器。渲染器实现此接口将逻辑层权重推送到 Three.js mesh。
 * Bug 4 修复：ActorRuntime 通过 MorphController.bindSink 与屏幕 mesh 建立绑定。
 */
export interface MorphSink {
  /**
   * 接收单个 morph 权重变更。weight 已经过 MorphController 的安全范围钳制。
   * 未知 morph 名称（mesh 上没有对应 morph target）由 sink 自行忽略。
   */
  setWeight(name: string, weight: number): void;
  /**
   * 接收重置通知。sink 应将所有 morph 权重归零。
   */
  resetAll(): void;
}

const DEFAULT_RANGE: MorphSafeRange = { min: 0, max: 1 };

/**
 * 管理 PMX morph 权重。所有 setWeight/applyBatch 操作都会被钳制到安全范围。
 * 未知 morph 名称会抛出错误（fail-closed）。
 *
 * 通过 bindSink 可将权重变更推送到外部（如 Three.js mesh.morphTargetInfluences），
 * 实现 ActorRuntime 与屏幕 mesh 的绑定（Bug 4 修复）。
 */
export class MorphController {
  private readonly weights = new Map<string, number>();
  private readonly knownMorphs: ReadonlySet<string>;
  private readonly safeRanges: ReadonlyMap<string, MorphSafeRange>;
  private sink?: MorphSink;

  constructor(
    knownMorphs: readonly string[],
    safeRanges: Record<string, MorphSafeRange> = {}
  ) {
    this.knownMorphs = new Set(knownMorphs);
    this.safeRanges = new Map(Object.entries(safeRanges));
  }

  /**
   * 绑定 MorphSink。之后所有 setWeight/applyBatch/reset 操作都会推送到 sink。
   * 传入 undefined 解除绑定。
   * 绑定时不推送当前状态；调用方如需同步现有状态应手动调用 sink.setWeight。
   */
  bindSink(sink?: MorphSink): void {
    this.sink = sink;
  }

  /**
   * 设置单个 morph 权重。未知 morph 抛错；权重被钳制到该 morph 的安全范围。
   * 若已绑定 sink，钳制后的权重会推送到 sink。
   */
  setWeight(name: string, weight: number): void {
    if (!this.knownMorphs.has(name)) {
      throw new Error(`Unknown morph: ${name}`);
    }
    const range = this.safeRanges.get(name) ?? DEFAULT_RANGE;
    const clamped = Math.max(range.min, Math.min(range.max, weight));
    this.weights.set(name, clamped);
    this.sink?.setWeight(name, clamped);
  }

  /**
   * 读取 morph 权重。未知 morph 返回 0（不抛错，便于查询）。
   */
  getWeight(name: string): number {
    return this.weights.get(name) ?? 0;
  }

  /**
   * 批量设置 morph 权重。事务性：若任一 morph 未知，整批拒绝，已设置的 morph 不变。
   * 若已绑定 sink，每个成功设置的 morph 都会推送到 sink。
   */
  applyBatch(weights: Record<string, number>): void {
    // 先校验全部 morph 名称
    for (const name of Object.keys(weights)) {
      if (!this.knownMorphs.has(name)) {
        throw new Error(`Unknown morph: ${name}`);
      }
    }
    // 全部已知，再逐个设置
    for (const [name, weight] of Object.entries(weights)) {
      this.setWeight(name, weight);
    }
  }

  /**
   * 重置所有权重为 0。若已绑定 sink，通知 sink 重置所有 morph。
   */
  reset(): void {
    this.weights.clear();
    this.sink?.resetAll();
  }

  /**
   * 返回当前权重 > 0 的 morph 列表。
   */
  getActiveMorphs(): ActiveMorph[] {
    const result: ActiveMorph[] = [];
    for (const [name, weight] of this.weights) {
      if (weight > 0) {
        result.push({ name, weight });
      }
    }
    return result;
  }

  /**
   * 返回已知 morph 名称列表（只读）。
   */
  getKnownMorphs(): readonly string[] {
    return Array.from(this.knownMorphs);
  }
}
