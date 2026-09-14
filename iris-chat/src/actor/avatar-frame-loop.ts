// Task 6 Step 1: 可测试的单帧函数
// 职责：协调每帧的调用顺序，钳制 delta 避免卡顿后物理爆炸
//
// 设计原则：
// - 纯逻辑：不依赖 Three.js / DOM，可在测试中直接验证顺序
// - 顺序保证：updateModel → updateActor → updateLife → render
//   原因：骨骼/IK 必须先于 morph 应用；生命层（眨眼/呼吸）基于最新骨骼状态；
//   渲染必须在所有状态更新后执行
// - delta 钳制：最大 0.05s（20fps 下限），避免窗口卡顿后物理爆炸；
//   负数钳制为 0，避免时钟回退导致负向物理

/**
 * 每帧需要的外部端口。渲染器实现这些接口将帧逻辑连接到真实 Three.js 对象。
 */
export interface AvatarFramePorts {
  /**
   * Advance the external physics adapter with the clamped render-frame delta.
   * This is separate from clip-local animation time so speech VMD switches and
   * loop wraps cannot send Bullet a negative or oversized time step.
   */
  advancePhysics?(deltaSeconds: number): void;
  /** Update root-space orientation before model sampling and Bullet evaluation. */
  updateOrientation?(deltaSeconds: number): void;
  /**
   * 更新骨骼/IK/物理。elapsedSeconds 是当前秒数（@yohawing model.update 参数）。
   * physics 控制物理是否启用；ik 始终为 true。
   */
  updateModel(
    elapsedSeconds: number,
    options: { physics: boolean; ik: boolean }
  ): void;
  /**
   * Phase 5.2B.1 Task 2：应用放松基础姿态（手臂自然下垂）。
   * 在 updateModel 之后调用，确保 VMD 采样后的骨骼状态不被覆盖（通过 ownership 检查）。
   * 只在 owner=none/procedural 的手臂骨骼上写入。
   */
  updateRelaxedBasePose?(): void;
  /**
   * 更新 ActorRuntime 状态。deltaSeconds 是钳制后的帧间隔。
   */
  updateActor(deltaSeconds: number): void;
  /**
   * 更新生命层（眨眼/呼吸/视线/头肩小动作）。
   * elapsedSeconds 用于相位计算；deltaSeconds 用于插值。
   */
  updateLife(elapsedSeconds: number, deltaSeconds: number): void;
  /**
   * 在 render 之前、所有骨骼/物理/生命层更新之后执行的最终姿态钩子。
   * 移动模型拖动时的次级骨骼必须在这里做最终钳制：updateModel 内的钳制
   * 会在后续物理步/updateLife 中被覆盖，只有渲染前一刻的最终姿态钳制
   * 才能保证对外可见的骨骼真正停在守卫包络内。
   */
  finalizePoseBeforeRender?(): void;
  /**
   * 渲染一帧到 Canvas。
   */
  render(): void;
}

/**
 * 执行单帧 avatar 更新。
 *
 * 顺序：updateModel → updateRelaxedBasePose → updateActor → updateLife → render
 * delta 钳制：[0, 0.05]，避免卡顿后物理爆炸和时钟回退
 *
 * 顺序说明：
 * - updateModel 先采样 VMD 写入骨骼（VMD 持有的骨骼）
 * - updateRelaxedBasePose 应用放松姿态到 owner=none/procedural 的手臂骨骼
 *   （VMD 持有的骨骼通过 ownership 检查跳过，不会被覆盖）
 * - updateActor 更新 morph 权重（不涉及骨骼）
 * - updateLife 应用呼吸/摇摆到上半身/頭/肩
 * - render 渲染最终状态
 *
 * @param ports 外部端口实现
 * @param elapsedSeconds 当前累积秒数（从启动开始）
 * @param deltaSeconds 本帧间隔（秒）
 * @param physicsEnabled 是否启用物理
 */
export function stepAvatarFrame(
  ports: AvatarFramePorts,
  elapsedSeconds: number,
  deltaSeconds: number,
  physicsEnabled: boolean
): void {
  // 钳制 delta：[0, 0.05]
  // 上限 0.05s = 20fps 下限，避免窗口卡顿后物理爆炸
  // 下限 0，避免时钟回退（performance.now() 不应回退，但防御性编程）
  const safeDelta = Math.min(Math.max(deltaSeconds, 0), 0.05);

  // 帧成本诊断（_frameCosts）：滚动累计各阶段耗时，CDP 可随时读取归因。
  // 只在明确开启时采样（window.__chatx2FrameCostSample = true），零常态开销。
  const sampling = (globalThis as { __chatx2FrameCostSample?: boolean }).__chatx2FrameCostSample === true;
  if (sampling) {
    // 每帧只计一次帧数（阶段计数在 t() 内会多次触发，不能作为帧率依据）
    const store = (globalThis as { __chatx2FrameCosts?: Record<string, number> }).__chatx2FrameCosts
      ?? ((globalThis as { __chatx2FrameCosts?: Record<string, number> }).__chatx2FrameCosts = {});
    store.__frames = (store.__frames ?? 0) + 1;
  }
  const t = (label: string, from?: number): number => {
    const now = performance.now();
    if (sampling && from !== undefined) {
      const store = (globalThis as { __chatx2FrameCosts?: Record<string, number> }).__chatx2FrameCosts
        ?? ((globalThis as { __chatx2FrameCosts?: Record<string, number> }).__chatx2FrameCosts = {});
      store[label] = (store[label] ?? 0) + (now - from);
    }
    return now;
  };

  // 顺序：骨骼/IK → 放松基础姿态 → ActorRuntime → 生命层 → 渲染
  let mark = performance.now();
  ports.updateOrientation?.(safeDelta);
  mark = t('orientation', mark);
  if (physicsEnabled && ports.advancePhysics) {
    ports.advancePhysics(safeDelta);
  }
  mark = t('physics', mark);
  ports.updateModel(elapsedSeconds, {
    physics: physicsEnabled,
    ik: true
  });
  mark = t('modelUpdate', mark);
  // Phase 5.2B.1 Task 2：可选的放松基础姿态（手臂自然下垂）
  if (ports.updateRelaxedBasePose) {
    ports.updateRelaxedBasePose();
  }
  mark = t('relaxedBasePose', mark);
  ports.updateActor(safeDelta);
  mark = t('actor', mark);
  ports.updateLife(elapsedSeconds, safeDelta);
  mark = t('life', mark);
  // 所有骨骼/物理/生命层更新完成后的最终姿态钩子：拖动时次级骨骼守卫
  // 在此做最后钳制，确保渲染出的骨骼停在包络内（见端口注释）。
  ports.finalizePoseBeforeRender?.();
  mark = t('finalize', mark);
  ports.render();
  t('render', mark);
}
