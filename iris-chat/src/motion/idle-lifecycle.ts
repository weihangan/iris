export type IdlePhase = 'disabled' | 'default' | 'pool' | 'speech' | 'cooldown';

export interface IdleSources {
  readonly enabledDefaultIds: readonly string[];
  readonly poolIds: readonly string[];
}

export interface IdleLifecycleDecision {
  readonly stopCurrent: boolean;
  readonly clearCallback: boolean;
  readonly clearTimer: boolean;
  readonly startDefaultId: string | null;
  /** Arm the delayed one-shot scheduler; never start a permanent idle loop. */
  readonly scheduleNext: boolean;
}

export interface IdleLifecycleSnapshot {
  readonly phase: IdlePhase;
  readonly inDesktop: boolean;
  readonly paused: boolean;
  readonly speechActive: boolean;
  readonly enabledDefaultIds: readonly string[];
  readonly enabledPoolIds: readonly string[];
  readonly currentIdleId: string | null;
  readonly currentKind: 'default-loop' | 'pool-shot' | null;
  readonly timerArmed: boolean;
  readonly cooldownRemainingMs: number;
  readonly generation: number;
}

export interface IdleLifecycleOptions {
  readonly now?: () => number;
  readonly cooldownMs?: number;
}

export function shouldStartDefaultIdle(input: {
  readonly inDesktop: boolean;
  readonly speechActive: boolean;
  readonly requestedId: string;
  readonly currentPackId: string | null;
  readonly motionPlaying: boolean;
  readonly startPendingForId: string | null;
}): boolean {
  const requestedId = input.requestedId.trim();
  if (!input.inDesktop || input.speechActive || requestedId.length === 0) return false;
  if (input.startPendingForId === requestedId) return false;
  return !(input.motionPlaying && input.currentPackId === requestedId);
}

const noDecision = (): IdleLifecycleDecision => ({
  stopCurrent: false,
  clearCallback: false,
  clearTimer: false,
  startDefaultId: null,
  scheduleNext: false
});

const normalizeIds = (ids: readonly string[]): string[] => Array.from(new Set(
  ids.filter(id => typeof id === 'string' && id.trim().length > 0)
));

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Select one episodic idle while preventing an immediate repeat when possible. */
export function pickNextIdleId(
  ids: readonly string[],
  previousId: string | null,
  random: () => number = Math.random
): string | null {
  const normalized = normalizeIds(ids);
  if (normalized.length === 0) return null;
  const candidates = normalized.length > 1
    ? normalized.filter(id => id !== previousId)
    : normalized;
  const randomValue = random();
  const unit = Number.isFinite(randomValue)
    ? Math.min(0.999999999, Math.max(0, randomValue))
    : 0;
  return candidates[Math.floor(unit * candidates.length)] ?? candidates[0] ?? null;
}

export class IdleLifecycleController {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private phase: IdlePhase = 'disabled';
  private inDesktop = false;
  private paused = false;
  private speechActive = false;
  private enabledDefaultIds: string[] = [];
  private enabledPoolIds: string[] = [];
  private currentIdleId: string | null = null;
  private currentKind: 'default-loop' | 'pool-shot' | null = null;
  private timerArmed = false;
  private cooldownUntilMs = 0;
  private generation = 0;

  constructor(options: IdleLifecycleOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
  }

  enterDesktop(sources: IdleSources): IdleLifecycleDecision {
    this.inDesktop = true;
    this.updateSources(sources);
    this.generation += 1;
    this.timerArmed = false;
    this.recomputePhase();
    return {
      ...noDecision(),
      clearCallback: true,
      clearTimer: true,
      // The selected default is the stationary desktop base even while the
      // episodic idle pool is paused. `scheduleNext` remains gated by pause.
      startDefaultId: this.enabledDefaultIds[0] ?? null,
      scheduleNext: this.shouldScheduleNext()
    };
  }

  leaveDesktop(): IdleLifecycleDecision {
    const stopCurrent = this.currentIdleId !== null;
    this.inDesktop = false;
    this.speechActive = false;
    this.currentIdleId = null;
    this.currentKind = null;
    this.timerArmed = false;
    this.phase = 'disabled';
    this.generation += 1;
    return {
      stopCurrent,
      clearCallback: true,
      clearTimer: true,
      startDefaultId: null,
      scheduleNext: false
    };
  }

  refresh(sources: IdleSources): IdleLifecycleDecision {
    const previousDefaultId = this.enabledDefaultIds[0] ?? null;
    const nextDefaults = normalizeIds(sources.enabledDefaultIds);
    const nextPool = normalizeIds(sources.poolIds);
    const sourcesChanged = !sameIds(nextDefaults, this.enabledDefaultIds)
      || !sameIds(nextPool, this.enabledPoolIds);
    this.enabledDefaultIds = nextDefaults;
    this.enabledPoolIds = nextPool;

    const defaultChanged = previousDefaultId !== (nextDefaults[0] ?? null);
    const currentStillEnabled = this.currentIdleId === null
      || (this.currentKind === 'default-loop'
        ? this.enabledDefaultIds.includes(this.currentIdleId)
        : this.enabledPoolIds.includes(this.currentIdleId));
    // A changed default is a real base-pose switch. Invalidate any visible
    // idle (including a pool shot) so the renderer can cross-fade to the new
    // user-selected default instead of leaving the old body bound.
    const stopCurrent = !currentStillEnabled || (defaultChanged && this.currentIdleId !== null);
    if (stopCurrent) {
      this.currentIdleId = null;
      this.currentKind = null;
    }
    if (stopCurrent) {
      this.generation += 1;
    }
    if (sourcesChanged || stopCurrent) this.timerArmed = false;
    this.recomputePhase();
    return {
      stopCurrent,
      clearCallback: stopCurrent,
      clearTimer: sourcesChanged || stopCurrent,
      startDefaultId: this.inDesktop && !this.speechActive && (defaultChanged || stopCurrent)
        ? this.enabledDefaultIds[0] ?? null
        : null,
      scheduleNext: this.shouldScheduleNext()
    };
  }

  setPaused(paused: boolean): IdleLifecycleDecision {
    if (paused === this.paused) return noDecision();
    this.paused = paused;
    // Pausing disables only pool shots. The selected default loop is the
    // always-visible desktop base and must remain bound.
    const stopCurrent = paused && this.currentKind === 'pool-shot';
    if (paused) {
      if (stopCurrent) {
        this.currentIdleId = null;
        this.currentKind = null;
      }
      this.timerArmed = false;
    }
    this.generation += 1;
    this.recomputePhase();
    return {
      stopCurrent,
      clearCallback: true,
      clearTimer: true,
      startDefaultId: null,
      scheduleNext: this.shouldScheduleNext()
    };
  }

  beginSpeech(): IdleLifecycleDecision {
    if (this.speechActive) return noDecision();
    this.speechActive = true;
    this.timerArmed = false;
    this.phase = 'speech';
    this.generation += 1;
    return {
      ...noDecision(),
      clearCallback: true,
      clearTimer: true
    };
  }

  endSpeech(): IdleLifecycleDecision {
    if (!this.speechActive) return noDecision();
    this.speechActive = false;
    this.generation += 1;
    this.recomputePhase();
    return {
      ...noDecision(),
      clearCallback: true,
      clearTimer: true,
      scheduleNext: this.shouldScheduleNext()
    };
  }

  started(id: string, kind: 'default-loop' | 'pool-shot'): void {
    if (!this.inDesktop || this.speechActive || (this.paused && kind !== 'default-loop')) return;
    const enabled = kind === 'default-loop'
      ? this.enabledDefaultIds.includes(id)
      : this.enabledPoolIds.includes(id);
    if (!enabled) return;
    this.currentIdleId = id;
    this.currentKind = kind;
    this.timerArmed = false;
    this.generation += 1;
    this.phase = kind === 'default-loop' ? 'default' : 'pool';
  }

  finished(id: string): void {
    if (id !== this.currentIdleId) return;
    this.currentIdleId = null;
    this.currentKind = null;
    this.cooldownUntilMs = this.now() + this.cooldownMs;
    this.timerArmed = false;
    this.generation += 1;
    this.recomputePhase();
  }

  currentGeneration(): number {
    return this.generation;
  }

  acceptCompletion(generation: number, id: string): boolean {
    return generation === this.generation
      && this.inDesktop
      && !this.paused
      && !this.speechActive
      && this.currentKind === 'pool-shot'
      && this.currentIdleId === id
      && this.enabledPoolIds.includes(id);
  }

  canScheduleAt(nowMs: number): boolean {
    return this.inDesktop
      && !this.paused
      && !this.speechActive
      && this.enabledPoolIds.length > 0
      && nowMs >= this.cooldownUntilMs;
  }

  setTimerArmed(armed: boolean): void {
    this.timerArmed = armed && this.inDesktop && !this.paused && !this.speechActive
      && this.enabledPoolIds.length > 0;
  }

  snapshot(): IdleLifecycleSnapshot {
    return {
      phase: this.phase,
      inDesktop: this.inDesktop,
      paused: this.paused,
      speechActive: this.speechActive,
      enabledDefaultIds: [...this.enabledDefaultIds],
      enabledPoolIds: [...this.enabledPoolIds],
      currentIdleId: this.currentIdleId,
      currentKind: this.currentKind,
      timerArmed: this.timerArmed,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMs - this.now()),
      generation: this.generation
    };
  }

  private updateSources(sources: IdleSources): void {
    this.enabledDefaultIds = normalizeIds(sources.enabledDefaultIds);
    this.enabledPoolIds = normalizeIds(sources.poolIds);
  }

  private shouldScheduleNext(): boolean {
    return this.inDesktop
      && !this.paused
      && !this.speechActive
      // The selected default loop is the persistent body base. It must not
      // prevent the episodic pool timer from being armed when idle is enabled.
      // A pool-shot, on the other hand, owns the player until it finishes.
      && (this.currentIdleId === null || this.currentKind === 'default-loop')
      && this.enabledPoolIds.length > 0;
  }

  private recomputePhase(): void {
    if (!this.inDesktop || this.paused
      || (this.enabledDefaultIds.length === 0 && this.enabledPoolIds.length === 0)) {
      this.phase = 'disabled';
      return;
    }
    if (this.speechActive) {
      this.phase = 'speech';
      return;
    }
    if (this.currentKind === 'default-loop') {
      this.phase = 'default';
      return;
    }
    if (this.currentKind === 'pool-shot') {
      this.phase = 'pool';
      return;
    }
    this.phase = this.now() < this.cooldownUntilMs ? 'cooldown' : 'default';
  }
}
