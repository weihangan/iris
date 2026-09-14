import { describe, expect, it } from 'vitest';
import { IdleLifecycleController, pickNextIdleId, shouldStartDefaultIdle } from '../../src/motion/idle-lifecycle';

describe('IdleLifecycleController', () => {
  it('does not rebind an already visible or in-flight default idle', () => {
    expect(shouldStartDefaultIdle({
      inDesktop: true,
      speechActive: false,
      requestedId: 'idle-a',
      currentPackId: 'idle-a',
      motionPlaying: true,
      startPendingForId: null
    })).toBe(false);
    expect(shouldStartDefaultIdle({
      inDesktop: true,
      speechActive: false,
      requestedId: 'idle-a',
      currentPackId: null,
      motionPlaying: false,
      startPendingForId: 'idle-a'
    })).toBe(false);
  });
  it('enters desktop by arming episodic idle without starting a permanent default loop', () => {
    const state = new IdleLifecycleController();

    expect(state.enterDesktop({
      enabledDefaultIds: ['default-idle'],
      poolIds: ['default-idle', 'idle-a', 'idle-b']
    })).toMatchObject({
      startDefaultId: 'default-idle',
      scheduleNext: true
    });
    expect(state.snapshot()).toMatchObject({
      currentIdleId: null,
      timerArmed: false
    });
  });

  it('resumes and leaves speech by scheduling the next one-shot instead of starting default idle', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['default-idle'], poolIds: ['default-idle', 'idle-a'] });
    state.setPaused(true);

    expect(state.setPaused(false)).toMatchObject({
      startDefaultId: null,
      scheduleNext: true
    });
    state.beginSpeech();
    expect(state.endSpeech()).toMatchObject({
      startDefaultId: null,
      scheduleNext: true
    });
  });

  it('arms the episodic pool while the selected default loop remains active', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['default-idle'], poolIds: ['idle-a'] });
    state.started('default-idle', 'default-loop');
    state.setPaused(true);

    expect(state.setPaused(false)).toMatchObject({
      stopCurrent: false,
      scheduleNext: true
    });
  });

  it('chooses every configured idle including the default without immediately repeating one', () => {
    const ids = ['default-idle', 'idle-a', 'idle-b'];
    expect(pickNextIdleId(ids, null, () => 0)).toBe('default-idle');
    expect(pickNextIdleId(ids, 'default-idle', () => 0)).toBe('idle-a');
    expect(pickNextIdleId(ids, 'idle-a', () => 0.999)).toBe('idle-b');
    expect(pickNextIdleId(['only-idle'], 'only-idle', () => 0.5)).toBe('only-idle');
  });

  it('keeps an explicitly empty idle set disabled instead of restoring defaults', () => {
    const state = new IdleLifecycleController();

    state.enterDesktop({ enabledDefaultIds: [], poolIds: [] });

    expect(state.snapshot()).toMatchObject({
      phase: 'disabled',
      timerArmed: false,
      enabledDefaultIds: [],
      enabledPoolIds: []
    });
  });

  it('invalidates the current idle and its callback when the action is disabled', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['idle-a'], poolIds: ['idle-b'] });
    state.started('idle-a', 'default-loop');
    const generation = state.currentGeneration();

    expect(state.refresh({ enabledDefaultIds: [], poolIds: [] })).toMatchObject({
      stopCurrent: true,
      clearCallback: true,
      clearTimer: true
    });
    expect(state.acceptCompletion(generation, 'idle-a')).toBe(false);
    expect(state.snapshot()).toMatchObject({
      phase: 'disabled',
      currentIdleId: null,
      timerArmed: false
    });
  });

  it('switches immediately to a newly selected default idle while on desktop', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['idle-a'], poolIds: ['idle-a', 'idle-b'] });
    state.started('idle-a', 'default-loop');

    expect(state.refresh({ enabledDefaultIds: ['idle-b'], poolIds: ['idle-b'] })).toMatchObject({
      stopCurrent: true,
      clearCallback: true,
      clearTimer: true,
      startDefaultId: 'idle-b'
    });
  });

  it('stops a current idle once when idle is paused and does not resurrect it', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['idle-a'], poolIds: ['idle-b'] });
    state.started('idle-a', 'default-loop');
    const generation = state.currentGeneration();

    expect(state.setPaused(true)).toMatchObject({
      stopCurrent: false,
      clearCallback: true,
      clearTimer: true
    });
    expect(state.setPaused(true).stopCurrent).toBe(false);
    expect(state.acceptCompletion(generation, 'idle-a')).toBe(false);
    expect(state.snapshot()).toMatchObject({
      phase: 'disabled',
      paused: true,
      currentIdleId: 'idle-a',
      timerArmed: false
    });
  });

  it('does not re-arm before cooldown expires and never schedules during speech', () => {
    let nowMs = 1_000;
    const state = new IdleLifecycleController({ now: () => nowMs, cooldownMs: 30_000 });
    state.enterDesktop({ enabledDefaultIds: ['idle-a'], poolIds: ['idle-b'] });
    state.started('idle-b', 'pool-shot');
    state.finished('idle-b');

    expect(state.canScheduleAt(30_999)).toBe(false);
    expect(state.canScheduleAt(31_000)).toBe(true);
    state.beginSpeech();
    nowMs = 31_000;
    expect(state.canScheduleAt(nowMs)).toBe(false);
    expect(state.snapshot()).toMatchObject({ phase: 'speech', timerArmed: false });
  });

  it('invalidates pending work when desktop mode is left', () => {
    const state = new IdleLifecycleController();
    state.enterDesktop({ enabledDefaultIds: ['idle-a'], poolIds: ['idle-b'] });
    state.started('idle-b', 'pool-shot');
    const generation = state.currentGeneration();

    expect(state.leaveDesktop()).toMatchObject({
      stopCurrent: true,
      clearCallback: true,
      clearTimer: true
    });
    expect(state.acceptCompletion(generation, 'idle-b')).toBe(false);
    expect(state.snapshot().phase).toBe('disabled');
  });
});
