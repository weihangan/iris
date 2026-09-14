// Phase 5.2 Task 5.2.6: AvatarPerformanceSession
//
// 职责：
// - 封装 PerformanceClock + LipTimeline + PerformancePlanner 的集成逻辑
// - 在 Avatar 渲染器内提供"同一音频时钟基准"的表演会话
// - 对齐音频开始时间、生成 viseme 时间轴、查询当前 viseme 权重
// - 暴露 PerformanceClock 供动作播放器（Phase 5.3+）使用
// - 表演结束时清零 viseme + 清除时钟对齐
//
// 硬规则（Phase 5.1 不回归）：
// - Avatar 是唯一 AudioContext/解码器/播放时钟所有者，session 不直接访问 AudioContext
// - 通过构造函数注入 getAudioContextTime 回调获取时间
// - session 不向 Composer/Chat 暴露 wavBytes / 时间轴内容（隐私边界）
// - endPerformance 后必须清零所有 viseme 权重，防止切回 Chat 后口型残留
//
// Phase 5.2 限制：
// - LipTimeline 使用 Mock 实现（基于 WAV 时长生成确定性 viseme 序列）
// - 不接入真实 VMD 动作播放（Phase 5.3+ MotionPackRunner）
// - PerformancePlanner 仅生成 plan，不直接驱动动作（Phase 5.3+）

import { PerformanceClock, type AudioContextTimeProvider } from './performance-clock';
import {
  LipTimeline,
  emptyVisemeWeights,
  type VisemeKeyframe,
  type VisemeWeights
} from './lip-timeline';
import { PerformancePlanner, type PlannerInput, type PerformancePlan, type VmdEmotionEntry } from './performance-planner';
import { ExpressionTimeline, type ExpressionSample } from './expression-timeline';
import { buildSpeechPerformanceTimeline, type SpeechPerformanceCue } from './speech-performance-timeline';
import type { PerformanceSemantic } from './semantic-performance';
import { blendFacialPoses, createEmptyFacialPose } from './facial-pose';
import { deriveFacialEmotion, type FacialPersonalityBias } from './expression-recipes';
import type { AcceptedExpressionRecord } from './daily-candidate-types';
import {
  buildAutomaticSpeechExpressionRuns,
  overlayAutomaticSpeechExpression,
  sampleAutomaticSpeechExpression,
  type AutomaticSpeechExpressionRun
} from './automatic-speech-expression-pool';
import type { FacialChannel } from './facial-pose';
import {
  getAvatarComputeProfile,
  type AvatarComputeLevel,
  type AvatarComputeProfile
} from './avatar-compute-profile';

/**
 * 表演会话状态。
 * - 'idle'：无任务，时钟未对齐，无 viseme 时间轴
 * - 'performing'：任务进行中，时钟对齐，viseme 时间轴可用
 */
export type SessionState = 'idle' | 'performing';

/**
 * 表演开始信息（用于 IPC 通知 Composer / 调试）。
 * - taskId：当前任务 ID
 * - audioStartTime：AudioContext.currentTime 在 sourceNode.start() 时的值
 * - visemeCount：viseme 时间轴 keyframe 数量（调试用）
 * - durationSeconds：预计表演时长（秒）
 */
export interface PerformanceBeginInfo {
  readonly taskId: string;
  readonly audioStartTime: number;
  readonly visemeCount: number;
  readonly durationSeconds: number;
}

/**
 * Avatar 表演会话。
 * 在 Avatar 渲染器内组合 PerformanceClock + LipTimeline + PerformancePlanner。
 *
 * 使用方式：
 *   const session = new AvatarPerformanceSession(() => audioCtx.currentTime);
 *   // 在 sourceNode.start() 后：
 *   const info = session.beginPerformance(taskId, ctx.currentTime, wavBytes);
 *   // 每帧：
 *   const t = session.getCurrentTime();
 *   const viseme = session.getCurrentViseme(t);
 *   // 播放结束 / 中断：
 *   session.endPerformance();
 */
export class AvatarPerformanceSession {
  private readonly clock: PerformanceClock;
  private readonly lipTimeline: LipTimeline;
  private readonly planner: PerformancePlanner;
  private state: SessionState = 'idle';
  private currentTaskId: string | null = null;
  private currentVisemes: VisemeKeyframe[] = [];
  private currentDuration = 0;
  private expressionTimeline: ExpressionTimeline | null = null;
  private performanceCues: SpeechPerformanceCue[] = [];
  private cueExpressionTimelines: ExpressionTimeline[] = [];
  private automaticExpressionRuns: AutomaticSpeechExpressionRun[] = [];
  private acceptedExpressions: readonly AcceptedExpressionRecord[] = [];
  private supportedExpressionChannels: readonly FacialChannel[] = [];
  private readonly automaticExpressionRotation = new Map<AcceptedExpressionRecord['emotion'], number>();
  private facialPersonality: FacialPersonalityBias | undefined;
  private computeProfile: AvatarComputeProfile = getAvatarComputeProfile('high');

  constructor(getAudioContextTime: AudioContextTimeProvider) {
    this.clock = new PerformanceClock(getAudioContextTime);
    this.lipTimeline = new LipTimeline();
    this.planner = new PerformancePlanner();
  }

  /**
   * 返回内部 PerformanceClock。
   * 动作播放器（Phase 5.3+）用 clock.now() 作为时间基准。
   */
  getClock(): PerformanceClock {
    return this.clock;
  }

  /**
   * 返回当前会话状态。
   */
  getState(): SessionState {
    return this.state;
  }

  /**
   * 返回当前任务 ID。无任务返回 null。
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setFacialPersonality(personality: FacialPersonalityBias | undefined): void {
    this.facialPersonality = personality ? { ...personality } : undefined;
  }

  /**
   * Install the accepted per-role expression pool for future speech turns.
   * The renderer supplies channels actually supported by the selected PMX;
   * unsupported or empty pools fail closed to the shared recipes.
   */
  updateAcceptedExpressions(
    entries: readonly AcceptedExpressionRecord[],
    supportedChannels: readonly FacialChannel[] = []
  ): void {
    this.acceptedExpressions = entries
      .filter(entry => entry.status === 'accepted' && entry.automatic === true)
      .map(entry => structuredClone(entry));
    this.supportedExpressionChannels = [...supportedChannels];
    if (this.state !== 'performing') {
      this.automaticExpressionRuns = [];
    }
  }

  setComputeLevel(level: AvatarComputeLevel): void {
    this.computeProfile = getAvatarComputeProfile(level);
  }

  getComputeLevel(): AvatarComputeLevel {
    return this.computeProfile.level;
  }

  /**
   * 开始表演会话。
   * - 对齐 PerformanceClock 到 audioStartTime
   * - 从 wavBytes 生成 viseme 时间轴（Mock 实现）
   * - 切换状态到 'performing'
   *
   * 不会清零已有 viseme（调用方负责在 beginPerformance 之前 endPerformance 旧任务）。
   * 返回 PerformanceBeginInfo 供调用方用于 IPC 通知。
   */
  beginPerformance(
    taskId: string,
    audioStartTime: number,
    wavBytes: ArrayBuffer,
    speechText?: string,
    emotion = 'neutral',
    intensity = 0.65,
    baseSemantic?: PerformanceSemantic
  ): PerformanceBeginInfo {
    this.currentTaskId = taskId;
    this.clock.alignTo(taskId, audioStartTime);
    this.currentVisemes = this.lipTimeline.fromWav(wavBytes, speechText, {
      frameSeconds: this.computeProfile.speech.lipFrameSeconds
    });
    this.currentDuration = this.computeDuration(wavBytes);
    this.expressionTimeline = new ExpressionTimeline(emotion, this.currentDuration, intensity);
    const fallbackSemantic: PerformanceSemantic = baseSemantic ?? {
      emotion: emotion as PerformanceSemantic['emotion'],
      intent: 'explaining',
      intensity,
      gaze: ['thinking', 'concerned', 'shy'].includes(emotion) ? 'side-down' : 'user'
    };
    const semanticCues = buildSpeechPerformanceTimeline(speechText, this.currentDuration, fallbackSemantic, {
      semanticBeatSeconds: this.computeProfile.speech.semanticBeatSeconds,
      gestureGapSeconds: this.computeProfile.speech.gestureGapSeconds,
      maxMajorEmotionTransitions: this.computeProfile.speech.maxMajorEmotionTransitions
    });
    this.performanceCues = semanticCues.map((cue, index) => ({
      ...cue,
      facialEmotion: deriveFacialEmotion(
        cue.text,
        cue.emotion,
        this.facialPersonality,
        index,
        cue.intent
      )
    }));
    this.cueExpressionTimelines = this.performanceCues.map((cue, index) => {
      const facialEmotion = cue.facialEmotion;
      const visibleIntensity = facialEmotion === 'neutral'
        ? Math.max(0.45, cue.intensity)
        : facialEmotion === 'shy' || facialEmotion === 'embarrassed'
          ? Math.max(0.95, cue.intensity)
          : Math.max(0.72, cue.intensity);
      return new ExpressionTimeline(
        facialEmotion,
        cue.endSeconds - cue.startSeconds,
        visibleIntensity,
        {
          fadeIn: index === 0,
          // The final face is handed directly to ActorRuntime's idle-face
          // crossfade. Fading it to an empty pose first creates a visible
          // mouth-corner dip during the speech-to-idle motion transition.
          fadeOut: false,
          microExpressionSeed: index
        }
      );
    });
    this.automaticExpressionRuns = buildAutomaticSpeechExpressionRuns(
      this.performanceCues,
      this.acceptedExpressions,
      this.supportedExpressionChannels.length > 0
        ? this.supportedExpressionChannels
        : undefined,
      this.automaticExpressionRotation
    );
    this.state = 'performing';
    return {
      taskId,
      audioStartTime,
      visemeCount: this.currentVisemes.length,
      durationSeconds: this.currentDuration
    };
  }

  /**
   * 返回当前表演时间（秒）。
   * - 未开始会话（state='idle'）返回 0
   * - 表演中返回 clock.now()（相对于 audioStartTime）
   */
  getCurrentTime(): number {
    if (this.state !== 'performing') return 0;
    return this.clock.now();
  }

  /**
   * 返回当前时刻应该应用的 viseme keyframe。
   * 通过线性查找当前时间对应的 keyframe。
   * - 未开始会话返回 null
   * - 时间超出最后一帧返回最后一帧（权重应为 0）
   * - 时间早于第一帧返回第一帧（权重应为 0）
   *
   * Phase 5.2 简化实现：返回当前时间最近的 keyframe。
   * Phase 5.5+ 改为插值。
   */
  getCurrentViseme(time: number): VisemeKeyframe | null {
    if (this.state !== 'performing' || this.currentVisemes.length === 0) {
      return null;
    }
    if (time <= this.currentVisemes[0].time) {
      return this.currentVisemes[0];
    }
    const last = this.currentVisemes[this.currentVisemes.length - 1];
    if (time >= last.time) {
      return last;
    }
    // 线性查找：返回最后一个 time <= 当前时间 的 keyframe
    let low = 0;
    let high = this.currentVisemes.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.currentVisemes[middle].time <= time) low = middle;
      else high = middle - 1;
    }
    return this.currentVisemes[low];
  }

  /** Sample all five mouth channels against the aligned AudioContext clock. */
  getCurrentVisemeWeights(): VisemeWeights {
    if (this.state !== 'performing') return emptyVisemeWeights();
    return this.lipTimeline.sampleAt(this.currentVisemes, this.clock.now());
  }

  getCurrentExpression(): ExpressionSample {
    if (this.state !== 'performing') {
      return { emotion: 'neutral', weight: 0, blush: 0, pose: createEmptyFacialPose() };
    }
    const now = this.clock.now();
    const cue = this.findCue(now);
    if (cue) {
      const cueDuration = Math.max(0, cue.endSeconds - cue.startSeconds);
      // AudioContext and WAV duration arithmetic can differ by a few ulps at
      // the endpoint. Clamp locally so the final rendered frame keeps its face
      // instead of sampling the timeline's out-of-range empty pose.
      const cueTime = Math.min(cueDuration, Math.max(0, now - cue.startSeconds));
      const current = this.sampleCueExpression(cue, cueTime, now);
      if (cue.index > 0) {
        const transitionSeconds = Math.min(0.38, (cue.endSeconds - cue.startSeconds) * 0.3);
        const rawTransition = Math.min(1, Math.max(0, (now - cue.startSeconds) / Math.max(0.001, transitionSeconds)));
        const transition = rawTransition * rawTransition * (3 - 2 * rawTransition);
        if (transition < 1) {
          const previousCue = this.performanceCues[cue.index - 1];
          const previous = this.sampleCueExpression(
            previousCue,
            previousCue.endSeconds - previousCue.startSeconds,
            previousCue.endSeconds
          );
          const pose = blendFacialPoses(previous.pose, current.pose, transition);
          return {
            emotion: current.emotion,
            weight: previous.weight + (current.weight - previous.weight) * transition,
            blush: pose.blush,
            pose,
            automaticExpression: current.automaticExpression
          };
        }
      }
      return current;
    }
    if (!this.expressionTimeline) {
      return { emotion: 'neutral', weight: 0, blush: 0, pose: createEmptyFacialPose() };
    }
    return this.expressionTimeline.sample(now);
  }

  getPerformanceCues(): readonly SpeechPerformanceCue[] {
    return this.performanceCues;
  }

  getCurrentPerformanceCue(): SpeechPerformanceCue | null {
    if (this.state !== 'performing') return null;
    return this.findCue(this.clock.now());
  }

  /**
   * 返回当前 viseme 时间轴（只读）。
   * 调试/测试用，运行时不应直接驱动 morph（用 getCurrentViseme 替代）。
   */
  getVisemeTimeline(): readonly VisemeKeyframe[] {
    return this.currentVisemes;
  }

  /**
   * 生成 PerformancePlan。
   * 调用方根据 plan.state/gaze/gestureFamily 决定后续动作（Phase 5.3+）。
   */
  plan(input: PlannerInput): PerformancePlan {
    return this.planner.plan(input);
  }

  /**
   * Phase 6：更新 VMD 情绪映射表。
   * 在模型包切换或动作配置变更时调用，从 manifest.json 的 vmdEmotionMap 加载。
   */
  updateVmdEmotionMap(map: readonly VmdEmotionEntry[]): void {
    this.planner.updateVmdEmotionMap(map);
  }

  /**
   * 结束表演会话。
   * - 清除 PerformanceClock 对齐
   * - 清空 viseme 时间轴
   * - 切换状态到 'idle'
   * - 不释放骨骼所有权（由调用方通过 BoneOwnershipRegistry 释放）
   *
   * 调用方负责在 endPerformance 后将 viseme morph 权重清零（通过 ActorRuntime.stopSpeak）。
   */
  endPerformance(): void {
    this.clock.clearAlignment();
    this.currentVisemes = [];
    this.currentDuration = 0;
    this.expressionTimeline = null;
    this.performanceCues = [];
    this.cueExpressionTimelines = [];
    this.automaticExpressionRuns = [];
    this.currentTaskId = null;
    this.state = 'idle';
  }

  /**
   * 返回预计表演时长（秒）。
   * 用于动作播放器在到达末尾时停止。
   */
  getDurationSeconds(): number {
    return this.currentDuration;
  }

  /**
   * 从 WAV 字节解析时长。
   * 委托给 LipTimeline 内部的 parseWavDuration 逻辑（这里复制以避免暴露内部函数）。
   * 失败返回 0。
   */
  private computeDuration(wavBytes: ArrayBuffer): number {
    if (!wavBytes || wavBytes.byteLength < 44) return 0;
    try {
      const view = new DataView(wavBytes);
      const riff = String.fromCharCode(
        view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
      );
      if (riff !== 'RIFF') return 0;
      const sampleRate = view.getUint32(24, true);
      const channels = view.getUint16(22, true);
      const bitsPerSample = view.getUint16(34, true);
      if (sampleRate === 0 || channels === 0 || bitsPerSample === 0) return 0;
      let offset = 12;
      while (offset < wavBytes.byteLength - 8) {
        const chunkId = String.fromCharCode(
          view.getUint8(offset),
          view.getUint8(offset + 1),
          view.getUint8(offset + 2),
          view.getUint8(offset + 3)
        );
        const chunkSize = view.getUint32(offset + 4, true);
        if (chunkId === 'data') {
          const bytesPerSample = bitsPerSample / 8;
          const samples = chunkSize / (bytesPerSample * channels);
          return samples / sampleRate;
        }
        offset += 8 + chunkSize;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private findCue(timeSeconds: number): SpeechPerformanceCue | null {
    if (this.performanceCues.length === 0) return null;
    if (timeSeconds <= this.performanceCues[0].startSeconds) return this.performanceCues[0];
    const last = this.performanceCues[this.performanceCues.length - 1];
    if (timeSeconds >= last.endSeconds) return last;
    return this.performanceCues.find(cue =>
      timeSeconds >= cue.startSeconds && timeSeconds < cue.endSeconds) ?? last;
  }

  private sampleCueExpression(
    cue: SpeechPerformanceCue,
    cueTimeSeconds: number,
    speechTimeSeconds: number
  ): ExpressionSample {
    const base = this.cueExpressionTimelines[cue.index].sample(cueTimeSeconds);
    // Select by cue start rather than a raw boundary timestamp so the
    // preceding cue can still be sampled at its endpoint during crossfade.
    const run = this.automaticExpressionRuns.find(candidate =>
      cue.startSeconds >= candidate.startSeconds
      && cue.startSeconds < candidate.endSeconds
    );
    if (!run) return base;
    const automatic = sampleAutomaticSpeechExpression(run, speechTimeSeconds);
    const pose = overlayAutomaticSpeechExpression(
      base.pose,
      automatic,
      run.activeChannels,
      cue.intensity
    );
    return {
      ...base,
      pose,
      blush: pose.blush,
      automaticExpression: { id: run.expressionId, category: run.category }
    };
  }
}
