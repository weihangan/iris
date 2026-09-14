export type SpeechMotionPhase = 'idle' | 'preparing' | 'performing' | 'exiting';

export interface SpeechMotionDirectorOptions {
  readonly leadInMs?: number;
  readonly longReplySeconds?: number;
  readonly recentReplyWindow?: number;
  readonly shortReplyAccentLimit?: number;
  readonly longReplyAccentLimit?: number;
  readonly stableAccentGapMs?: number;
  /**
   * Minimum gap for a validated phrase-level emotion turn.  A turn is
   * allowed to hand off sooner than an ordinary accent, but still needs a
   * readable opening pose so two VMDs cannot fight on the same frame.
   */
  readonly emotionTurnGapMs?: number;
}

/**
 * Session-level gate for dialogue body motion. It does not select VMD files;
 * it only prevents overlapping requests and repetitive accents.
 */
export class SpeechMotionDirector {
  private leadInMs: number;
  private longReplySeconds: number;
  private recentReplyWindow: number;
  private shortReplyAccentLimit: number;
  private longReplyAccentLimit: number;
  private stableAccentGapMs: number;
  private emotionTurnGapMs: number;
  private phase: SpeechMotionPhase = 'idle';
  private generation = 0;
  private audioStartedAtMs = 0;
  /** Duration of the active reply, used to reserve motion slots for its tail. */
  private audioDurationMs = 0;
  private accentLimit = 1;
  private accentCount = 0;
  private lastAccentAtMs = Number.NEGATIVE_INFINITY;
  private backgroundDecisionClaimed = false;
  private readonly currentAccentIds = new Set<string>();
  private readonly recentReplies: Set<string>[] = [];

  constructor(options: SpeechMotionDirectorOptions = {}) {
    // The timeline dispatches once when a cue is entered. A non-zero default
    // rejected that sole attempt and made short replies skip the voice pool.
    this.leadInMs = Math.max(0, options.leadInMs ?? 0);
    this.longReplySeconds = Math.max(1, options.longReplySeconds ?? 12);
    this.recentReplyWindow = Math.max(0, Math.trunc(options.recentReplyWindow ?? 3));
    this.shortReplyAccentLimit = Math.max(0, Math.trunc(options.shortReplyAccentLimit ?? 1));
    this.longReplyAccentLimit = Math.max(this.shortReplyAccentLimit, Math.trunc(options.longReplyAccentLimit ?? 3));
    // 2026-08: 默认间隔放宽（1200→2400 / 650→1100）。渲染器用无参构造，
    // 这些默认值直接决定语音中动作换手的节奏；旧的 1.2s/0.65s 让中长
    // 回复的动作一个接一个，读作"太快、太密、突变"。
    this.stableAccentGapMs = Math.max(0, options.stableAccentGapMs ?? 2400);
    this.emotionTurnGapMs = Math.max(0, options.emotionTurnGapMs ?? 1100);
  }

  configure(options: SpeechMotionDirectorOptions): void {
    if (options.leadInMs !== undefined) this.leadInMs = Math.max(0, options.leadInMs);
    if (options.longReplySeconds !== undefined) this.longReplySeconds = Math.max(1, options.longReplySeconds);
    if (options.recentReplyWindow !== undefined) this.recentReplyWindow = Math.max(0, Math.trunc(options.recentReplyWindow));
    if (options.shortReplyAccentLimit !== undefined) {
      this.shortReplyAccentLimit = Math.max(0, Math.trunc(options.shortReplyAccentLimit));
    }
    if (options.longReplyAccentLimit !== undefined) {
      this.longReplyAccentLimit = Math.max(this.shortReplyAccentLimit, Math.trunc(options.longReplyAccentLimit));
    }
    if (options.stableAccentGapMs !== undefined) {
      this.stableAccentGapMs = Math.max(0, options.stableAccentGapMs);
    }
    if (options.emotionTurnGapMs !== undefined) {
      this.emotionTurnGapMs = Math.max(0, options.emotionTurnGapMs);
    }
  }

  prepare(_taskId: string): number {
    this.generation += 1;
    this.phase = 'preparing';
    this.audioStartedAtMs = 0;
    this.audioDurationMs = 0;
    this.accentLimit = 1;
    this.accentCount = 0;
    this.lastAccentAtMs = Number.NEGATIVE_INFINITY;
    this.backgroundDecisionClaimed = false;
    this.currentAccentIds.clear();
    return this.generation;
  }

  beginAudio(generation: number, startedAtMs: number, durationSeconds: number): boolean {
    if (!this.isCurrent(generation) || this.phase !== 'preparing') return false;
    this.audioStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;
    this.audioDurationMs = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds * 1000 : 0);
    this.accentLimit = durationSeconds >= this.longReplySeconds
      ? Math.max(
        this.longReplyAccentLimit,
        Math.min(6, Math.ceil(Math.max(0, durationSeconds) / 9))
      )
      : this.shortReplyAccentLimit;
    this.phase = 'performing';
    return true;
  }

  claimAccent(
    generation: number,
    motionId: string,
    atMs: number,
    _channel = 'body',
    options: { emotionTurn?: boolean } = {}
  ): boolean {
    if (!this.isCurrent(generation) || this.phase !== 'performing') return false;
    if (atMs < this.audioStartedAtMs + this.leadInMs) return false;
    const emotionTurn = options.emotionTurn === true;
    const gap = atMs - this.lastAccentAtMs;
    // A validated semantic turn is a deliberate handoff, not an additional
    // decorative accent.  Permit one extra action on short replies (whose
    // normal budget is one), while retaining a hard two-action ceiling for
    // ordinary short/medium replies.  Long replies keep their configured
    // budget and cannot grow without bound when many cues are emitted.
    const effectiveLimit = emotionTurn
      ? Math.max(this.accentLimit, Math.min(2, this.accentLimit + 1))
      : this.accentLimit;
    const minimumGap = emotionTurn ? this.emotionTurnGapMs : this.stableAccentGapMs;
    if (gap < minimumGap) return false;
    if (!motionId || this.accentCount >= effectiveLimit || this.currentAccentIds.has(motionId)) return false;
    // Long replies used to spend all of their accents on the opening cues.
    // Reserve cumulative slots across the whole audio duration. The first
    // cue remains immediate; later cues cannot claim the next slot until its
    // share of the reply has elapsed. A genuine semantic turn gets a small
    // lead so a turn can still be visible without allowing several opening
    // turns to consume the tail budget.
    if (this.audioDurationMs >= this.longReplySeconds * 1000 && this.accentLimit > 1) {
      const plannedElapsedMs = this.audioDurationMs * this.accentCount / this.accentLimit;
      const turnLead = emotionTurn ? 0.8 : 1;
      const elapsedMs = Math.max(0, atMs - this.audioStartedAtMs);
      if (elapsedMs < plannedElapsedMs * turnLead) return false;
    }
    // Cross-reply repetition is handled by the Planner through
    // getUnavailableMotionIds(). If the entire enabled pool is exhausted, the
    // Planner deliberately relaxes that history; rejecting it again here made
    // valid speech fall back to no body motion at all.
    this.currentAccentIds.add(motionId);
    this.accentCount += 1;
    this.lastAccentAtMs = atMs;
    return true;
  }

  /**
   * True when a long reply has not reached the next reserved motion slot.
   * Callers can retry the current cue instead of permanently dropping it.
   */
  shouldDeferAccent(generation: number, atMs: number, emotionTurn = false): boolean {
    if (!this.isCurrent(generation) || this.phase !== 'performing') return false;
    if (this.accentCount >= this.accentLimit) return false;
    if (this.audioDurationMs < this.longReplySeconds * 1000 || this.accentLimit <= 1) return false;
    const plannedElapsedMs = this.audioDurationMs * this.accentCount / this.accentLimit;
    const turnLead = emotionTurn ? 0.8 : 1;
    const elapsedMs = Math.max(0, atMs - this.audioStartedAtMs);
    return elapsedMs < plannedElapsedMs * turnLead;
  }

  claimBackgroundDecision(generation: number): boolean {
    if (!this.isCurrent(generation) || this.phase !== 'performing' || this.backgroundDecisionClaimed) return false;
    this.backgroundDecisionClaimed = true;
    return true;
  }

  end(generation: number): boolean {
    if (!this.isCurrent(generation) || this.phase === 'idle' || this.phase === 'exiting') return false;
    this.phase = 'exiting';
    return true;
  }

  completeExit(generation: number): boolean {
    if (!this.isCurrent(generation) || this.phase !== 'exiting') return false;
    this.recentReplies.push(new Set(this.currentAccentIds));
    while (this.recentReplies.length > this.recentReplyWindow) this.recentReplies.shift();
    this.currentAccentIds.clear();
    this.phase = 'idle';
    return true;
  }

  shouldStopVisibleMotion(generation: number): boolean {
    return this.isCurrent(generation) && this.phase === 'exiting';
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  getPhase(): SpeechMotionPhase {
    return this.phase;
  }

  /** Motions the Planner must exclude to avoid current/recent reply repeats. */
  getUnavailableMotionIds(): readonly string[] {
    const unavailable = new Set(this.currentAccentIds);
    for (const reply of this.recentReplies) {
      for (const motionId of reply) unavailable.add(motionId);
    }
    return Array.from(unavailable);
  }
}
