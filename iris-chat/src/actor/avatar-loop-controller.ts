// Phase 3 收口修复 Step 6.1: AvatarLoopController
// 职责：封装 Three.js setAnimationLoop 的启停逻辑，提供幂等的 start/stop 接口
//
// 设计原则：
// - 纯逻辑：不依赖 Three.js / DOM，通过依赖注入接收 setAnimationLoop 回调
// - 幂等：start() 已运行时 no-op；stop() 已停止时 no-op
// - 时间戳重置：start() 时重置 previous timestamp，避免巨大 delta
// - 不可恢复的 cleanup：窗口关闭后永久停止
//
// 解决的问题：
// - 旧实现：renderer.setAnimationLoop 直接调用，无法暂停/恢复
// - Step 6 要求：返回 Chat 时停止循环，进入 Desktop 时恢复，cleanup 后永久停止
// - 避免巨大 delta：恢复时如果不重置 previous，delta 会是返回 Chat 期间的累积时间

/**
 * 依赖注入接口。渲染器实现 setAnimationLoop（通常是 Three.js renderer.setAnimationLoop）。
 * onFrame 是每帧回调，调用方负责调用 stepAvatarFrame。
 */
export interface AvatarLoopDependencies {
  /**
   * 设置动画循环回调。传入 null 停止循环。
   * 实现应委托给 THREE.WebGLRenderer.setAnimationLoop。
   */
  setAnimationLoop(callback: ((timestampMs: number) => void) | null): void;
  /**
   * 每帧回调。
   * @param deltaSeconds 距上一帧的秒数（已重置，避免恢复时巨大 delta）
   * @param elapsedSeconds 自本次 start() 起的累积秒数
   */
  onFrame(deltaSeconds: number, elapsedSeconds: number): void;
  /**
   * 手动渲染一帧（不推进时间）。
   * 用于 stop() 后需要强制刷新画面的场景（如 E2E 测试设置 morph 后读取像素）。
   * 实现应调用 stepAvatarFrame 或直接 renderer.render。
   */
  renderOneFrame(): void;
}

/**
 * Avatar 动画循环控制器。
 *
 * - start()：启动循环。幂等。重置 previous timestamp。
 * - stop()：停止循环。幂等。不清空 frame count（便于测试观察增长）。
 * - isRunning()：当前是否运行中。
 * - getFrameCount()：自最近一次 start() 起的帧数。
 * - cleanup()：永久停止，后续 start() 无效（用于窗口关闭）。
 *
 * 时间戳重置：start() 时把 previousTimestamp 设为 0（哨兵）。
 * 第一帧 callback 收到时间戳后，把 previousTimestamp 设为该值，
 * 因此第一帧 delta = 0（避免恢复时巨大 delta）。
 */
export class AvatarLoopController {
  private running = false;
  private disposed = false;
  private frameCount = 0;
  private previousTimestamp = 0;
  private startedAt = 0;
  private lastElapsed = 0;

  constructor(private readonly deps: AvatarLoopDependencies) {}

  /**
   * 启动动画循环。幂等：已运行时 no-op。已 cleanup 时 no-op。
   * 重置 previousTimestamp 哨兵为 0，第一帧 callback 会初始化它。
   */
  start(): void {
    if (this.disposed) return;       // 窗口已关闭，永久不可启动
    if (this.running) return;        // 已运行，幂等
    this.running = true;
    this.frameCount = 0;
    this.previousTimestamp = 0;      // 哨兵：第一帧时初始化
    this.startedAt = 0;              // 哨兵：第一帧时初始化

    this.deps.setAnimationLoop((timestampMs: number) => {
      const now = timestampMs / 1000;
      // 第一帧：初始化 startedAt 和 previousTimestamp，delta = 0
      if (this.startedAt === 0) {
        this.startedAt = now;
        this.previousTimestamp = now;
      }
      const elapsed = Math.max(0, now - this.startedAt);
      const delta = Math.max(0, now - this.previousTimestamp);
      this.previousTimestamp = now;
      this.lastElapsed = elapsed;
      this.frameCount++;
      this.deps.onFrame(delta, elapsed);
    });
  }

  /**
   * 停止动画循环。幂等：已停止时 no-op。
   * 不清空 frame count，便于测试观察"停止后 count 不增长"。
   */
  stop(): void {
    if (!this.running) return;       // 已停止，幂等
    this.running = false;
    this.deps.setAnimationLoop(null);
  }

  /**
   * 当前是否运行中。
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 自最近一次 start() 起的帧数。
   * stop() 不清零，所以 stop 后 frameCount 保持不变（用于测试断言"停止后不再增长"）。
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * 返回最近一帧的 elapsed 时间（秒）。
   * 用于 renderOneFrame() 时传入相同的 elapsed，避免骨骼/IK 推进时间。
   */
  getLastElapsed(): number {
    return this.lastElapsed;
  }

  /**
   * 手动渲染一帧（不推进时间，不增加 frameCount）。
   * 用于 stop() 后需要刷新画面的场景：例如 E2E 测试在暂停循环后设置 morph，
   * 需要强制渲染才能读取像素。实现委托给 deps.renderOneFrame。
   */
  renderOneFrame(): void {
    if (this.disposed) return;
    this.deps.renderOneFrame();
  }

  /**
   * 永久停止并标记为已弃用。后续 start() 无效。
   * 用于 beforeunload / 窗口关闭：cleanup 必须取消 mode-change 订阅 + 停止循环。
   */
  cleanup(): void {
    this.disposed = true;
    this.stop();
  }
}
