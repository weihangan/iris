// Phase 5.2 Task 5.2.5: PerformanceClock
//
// 职责：
// - 与 AudioContext.currentTime 对齐（同一时钟基准）
// - 提供 now() 返回当前表演时间（秒）
// - alignTo(taskId, audioStartTime) 锁定某个任务的音频开始时间
// - 后续 now() 返回相对于 audioStartTime 的时间
//
// 硬规则（Phase 5.1 不回归）：
// - Avatar 是唯一 AudioContext 所有者，PerformanceClock 不直接访问 AudioContext
// - 通过构造函数注入 getAudioContextTime 回调获取时间
// - Date.now() fallback 仅在 AudioContext 不可用时使用
//
// 设计：
// - 动作时间轴和音频时间轴使用同一 clock 实例
// - alignTo 后，now() = getAudioContextTime() - audioStartTime
// - clearAlignment 后，now() = getAudioContextTime()（原始值）

export type AudioContextTimeProvider = () => number;

export class PerformanceClock {
  private audioStartTime: number | undefined;
  private currentTaskId: string | undefined;

  constructor(
    private readonly getAudioContextTime: AudioContextTimeProvider
  ) {}

  /**
   * 返回当前表演时间（秒）。
   * - 未对齐时返回 getAudioContextTime() 原始值
   * - 对齐后返回 getAudioContextTime() - audioStartTime（相对于音频开始）
   * - AudioContext 不可用时 fallback 到 Date.now() / 1000
   */
  now(): number {
    let raw: number;
    try {
      raw = this.getAudioContextTime();
    } catch {
      // AudioContext 不可用时 fallback 到 Date.now() / 1000
      raw = Date.now() / 1000;
    }
    if (this.audioStartTime !== undefined) {
      return raw - this.audioStartTime;
    }
    return raw;
  }

  /**
   * 对齐到某个任务的音频开始时间。
   * 后续 now() 返回相对于 audioStartTime 的时间。
   */
  alignTo(taskId: string, audioStartTime: number): void {
    this.currentTaskId = taskId;
    this.audioStartTime = audioStartTime;
  }

  /**
   * 清除对齐。后续 now() 返回原始 audioContextTime。
   */
  clearAlignment(): void {
    this.currentTaskId = undefined;
    this.audioStartTime = undefined;
  }

  /**
   * 返回当前对齐的音频开始时间。未对齐返回 undefined。
   */
  getAudioStartTime(): number | undefined {
    return this.audioStartTime;
  }

  /**
   * Phase 5.2 修正（2026-07-19）：是否已对齐到某个任务的音频开始时间。
   * 用于 MotionPlayer 校验 speaking motion 启动条件（AudioContext 未对齐时禁止启动）。
   * E2E 通过此 API 验证 PerformanceClock 状态。
   */
  isAligned(): boolean {
    return this.audioStartTime !== undefined;
  }

  /**
   * 返回当前对齐的 taskId。未对齐返回 undefined。
   */
  getCurrentTaskId(): string | undefined {
    return this.currentTaskId;
  }
}
