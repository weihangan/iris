// Phase 5.2B 扩展：链式多段 VMD 播放器
//
// 用户需求（2026-07-24）：
// > 一个对话可不可以包含多个表情和动作呢？
//
// 实现：MotionSequence 管理一个 VMD 片段队列，按顺序播放。
// 每个片段可以有不同的 VMD（表情/动作），通过 MotionPlayer 的 fade 切换平滑过渡。
//
// 使用场景：
// - TTS 语音被分段为多个情绪段，每段对应不同 VMD
// - 一个对话回复中，先说"好的"（点头），再说"我不同意"（摇头），最后"再见"（挥手）
//
// 与现有 MotionPlayer 的关系：
// - MotionSequence 包装 MotionPlayer，不修改其内部状态机
// - 利用 MotionPlayer 的 pendingSwitch 机制实现段间 fade 过渡
// - 利用 MotionPlayer 的 setOnStop 回调检测非循环 VMD 播放完成
// - 也可通过 durationSeconds 定时切换

import { MotionPlayer } from './motion-player';
import type { MotionTimeSource, MotionCompositionMode } from './motion-player';
import type { BoneMapping, AmplitudeLimits } from './motion-pack-types';

/**
 * 单个 VMD 片段。
 */
export interface MotionSegment {
  /** 片段标识符 */
  packId: string;
  /** VMD 字节数据 */
  vmdBytes: Uint8Array | ArrayBuffer;
  /**
   * 播放时长（秒）。
   * - undefined：播完整个 VMD 后自动切换到下一段（非循环 VMD）
   * - 正数：定时切换到下一段（适合循环 VMD 只播一部分）
   */
  durationSeconds?: number;
  /** 播放选项（覆盖默认值） */
  options?: {
    boneMapping?: BoneMapping;
    amplitudeLimits?: AmplitudeLimits;
    timeSource?: MotionTimeSource;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    compositionMode?: MotionCompositionMode;
  };
}

/**
 * 链式多段 VMD 播放器。
 *
 * 用法：
 * ```ts
 * const seq = new MotionSequence(motionPlayer);
 * await seq.play([
 *   { packId: 'nod', vmdBytes: nodBytes, durationSeconds: 1.5 },
 *   { packId: 'explain', vmdBytes: explainBytes, durationSeconds: 2.0 },
 *   { packId: 'wave', vmdBytes: waveBytes, durationSeconds: 1.0 },
 * ], () => console.log('all segments done'));
 * ```
 */
export class MotionSequence {
  private segments: MotionSegment[] = [];
  private currentIndex: number = -1;
  private readonly motionPlayer: MotionPlayer;
  private onCompleteCallback: (() => void) | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isRunning: boolean = false;
  /** 是否正在等待当前段自然结束（非循环 VMD） */
  private waitingForNaturalEnd: boolean = false;
  /** 连续失败计数，防止无限递归 */
  private consecutiveFailures: number = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(motionPlayer: MotionPlayer) {
    this.motionPlayer = motionPlayer;
  }

  /**
   * 启动链式播放。
   * @param segments VMD 片段队列
   * @param onComplete 全部播放完成回调
   */
  async play(segments: MotionSegment[], onComplete?: () => void): Promise<void> {
    if (segments.length === 0) {
      onComplete?.();
      return;
    }
    this.segments = segments;
    this.currentIndex = -1;
    this.onCompleteCallback = onComplete ?? null;
    this.isRunning = true;
    await this.advanceToNext();
  }

  /**
   * 推进到下一段。
   */
  private async advanceToNext(): Promise<void> {
    this.currentIndex++;
    if (this.currentIndex >= this.segments.length) {
      this.isRunning = false;
      this.onCompleteCallback?.();
      this.onCompleteCallback = null;
      return;
    }

    const seg = this.segments[this.currentIndex];
    const opts = seg.options ?? {};

    try {
      // 清除之前的定时器
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.waitingForNaturalEnd = false;

      // 设置停止回调：当 VMD 自然结束（非循环模式）时自动推进
      if (seg.durationSeconds === undefined || seg.durationSeconds <= 0) {
        this.waitingForNaturalEnd = true;
        this.motionPlayer.setOnStop(() => {
          if (this.waitingForNaturalEnd && this.isRunning) {
            this.waitingForNaturalEnd = false;
            void this.advanceToNext();
          }
        });
      } else {
        this.motionPlayer.setOnStop(null);
      }

      await this.motionPlayer.play(seg.packId, seg.vmdBytes, {
        boneMapping: opts.boneMapping ?? {},
        amplitudeLimits: opts.amplitudeLimits ?? undefined,
        looping: false, // 链式播放不使用循环
        timeSource: opts.timeSource ?? 'local-clock',
        fadeInSeconds: opts.fadeInSeconds ?? 0.5,
        fadeOutSeconds: opts.fadeOutSeconds ?? 0.5,
        cooldownSeconds: 0,
        force: true,
        compositionMode: opts.compositionMode ?? 'absolute'
      });

      // 播放成功，重置失败计数
      this.consecutiveFailures = 0;

      // 如果指定了 duration，定时切换到下一段
      if (seg.durationSeconds && seg.durationSeconds > 0) {
        this.timerId = setTimeout(() => {
          this.timerId = null;
          // 防止竞态：onStop 和 setTimeout 同时触发 advanceToNext
          if (!this.isRunning) return;
          this.waitingForNaturalEnd = false;
          void this.advanceToNext();
        }, seg.durationSeconds * 1000);
      }
      // 如果没指定 duration，等待 VMD 自然结束（通过 onStop 回调）
      // MotionPlayer 在非循环模式播放完成后会自动 fade-out → performStopCleanup → 触发 onStop
    } catch (e) {
      console.warn(`[MotionSequence] segment ${this.currentIndex} play failed:`, e);
      // 连续失败保护：防止无限递归
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= MotionSequence.MAX_CONSECUTIVE_FAILURES) {
        console.error(`[MotionSequence] ${MotionSequence.MAX_CONSECUTIVE_FAILURES} consecutive failures, aborting`);
        this.isRunning = false;
        this.motionPlayer.setOnStop(null);
        this.onCompleteCallback?.();
        this.onCompleteCallback = null;
        return;
      }
      // 失败后继续下一个
      await this.advanceToNext();
    }
  }

  /**
   * 停止链式播放（带 fade-out）。
   */
  stop(): void {
    this.cleanup();
    this.motionPlayer.stop();
  }

  /**
   * 立即停止（不等待 fade-out）。
   */
  stopImmediate(): void {
    this.cleanup();
    this.motionPlayer.stopImmediate();
  }

  private cleanup(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.waitingForNaturalEnd = false;
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.motionPlayer.setOnStop(null);
    this.onCompleteCallback = null;
  }

  /** 是否正在播放 */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /** 当前播放到的片段索引 */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /** 总片段数 */
  getTotalSegments(): number {
    return this.segments.length;
  }
}