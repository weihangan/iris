import { describe, it, expect, vi } from 'vitest';
import { ModeController } from '../../electron/mode-controller';
import type { AvatarReadyEvidence, TransitionResult } from '../../electron/mode-controller';

// 类型保护：从 TransitionResult 中提取 reason（仅在 failure/unavailable 状态下存在）
function expectFailure(result: TransitionResult): { status: 'failure'; reason: string; mode: string } {
  if (result.status === 'failure') {
    return result;
  }
  throw new Error(`Expected failure status, got ${result.status}`);
}

function expectUnavailable(result: TransitionResult): { status: 'unavailable'; reason: string; mode: string } {
  if (result.status === 'unavailable') {
    return result;
  }
  throw new Error(`Expected unavailable status, got ${result.status}`);
}

function expectOk(result: TransitionResult): { status: 'ok'; mode: string } {
  if (result.status === 'ok') {
    return result;
  }
  throw new Error(`Expected ok status, got ${result.status}`);
}

// Phase 2 Task 2.1（修复后）: ModeController 状态机测试
// 设计要点（修复）：
// - 初始 mode 为 chat，Desktop 加载期间及失败后 Chat 必须保持可见
// - 只有"有效模型证据"（test-only-ready/pmx-first-frame）才允许切到 desktop
// - placeholder-canvas 不是有效证据，不能授权 Desktop 切换
// - 切换为事务：transition(desktop) → loading → commitDesktop；失败 rollbackDesktop
// - Scene 只返回 unavailable（D4 决策）
// - Avatar 关闭或崩溃必须恢复 Chat

describe('ModeController（修复后）', () => {
  it('初始 mode 为 chat', () => {
    const ctrl = new ModeController();
    expect(ctrl.getMode()).toBe('chat');
  });

  it('placeholder-canvas 证据不能授权 Desktop 切换', async () => {
    const ctrl = new ModeController();
    const evidence: AvatarReadyEvidence = {
      source: 'placeholder-canvas',
      timestamp: Date.now()
    };
    ctrl.setAvatarReady(evidence);
    // placeholder-canvas 是占位证据，不能授权
    const result = await ctrl.transition('desktop');
    const failure = expectFailure(result);
    expect(failure.reason).toBe('no-avatar-ready');
    expect(ctrl.getMode()).toBe('chat');
  });

  it('test-only-ready 证据可以授权 Desktop 切换（进入 loading）', async () => {
    const ctrl = new ModeController();
    const evidence: AvatarReadyEvidence = {
      source: 'test-only-ready',
      timestamp: Date.now()
    };
    ctrl.setAvatarReady(evidence);
    const result = await ctrl.transition('desktop');
    const ok = expectOk(result);
    expect(ok.mode).toBe('loading');
    expect(ctrl.getMode()).toBe('loading');
  });

  it('pmx-first-frame 证据可以授权 Desktop 切换（进入 loading）', async () => {
    const ctrl = new ModeController();
    const evidence: AvatarReadyEvidence = {
      source: 'pmx-first-frame',
      timestamp: Date.now()
    };
    ctrl.setAvatarReady(evidence);
    const result = await ctrl.transition('desktop');
    const ok = expectOk(result);
    expect(ok.mode).toBe('loading');
  });

  it('无证据时 transition(desktop) 返回 failure', async () => {
    const ctrl = new ModeController();
    const result = await ctrl.transition('desktop');
    const failure = expectFailure(result);
    expect(failure.reason).toBe('no-avatar-ready');
    expect(ctrl.getMode()).toBe('chat');
  });

  it('transition(scene) 返回 unavailable，mode 不变', async () => {
    const ctrl = new ModeController();
    const result = await ctrl.transition('scene');
    const unavail = expectUnavailable(result);
    expect(unavail.reason).toBe('scene-not-implemented');
    expect(ctrl.getMode()).toBe('chat');
  });

  it('commitDesktop 在 loading 状态下提交为 desktop', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    expect(ctrl.getMode()).toBe('loading');
    const result = ctrl.commitDesktop();
    expectOk(result);
    expect(ctrl.getMode()).toBe('desktop');
  });

  it('commitDesktop 在非 loading 状态下返回 failure', () => {
    const ctrl = new ModeController();
    const result = ctrl.commitDesktop();
    const failure = expectFailure(result);
    expect(failure.reason).toBe('not-in-loading');
  });

  it('rollbackDesktop 在 loading 状态下回滚到 chat 并保留模型就绪证据', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    expect(ctrl.getMode()).toBe('loading');
    const result = ctrl.rollbackDesktop();
    expectOk(result);
    expect(ctrl.getMode()).toBe('chat');
    // 窗口仍存活时保留 PMX 就绪证据，允许用户再次打开桌宠。
    const again = await ctrl.transition('desktop');
    expectOk(again);
    expect(ctrl.getMode()).toBe('loading');
  });

  it('rollbackDesktop 在非 loading 状态下返回 failure', () => {
    const ctrl = new ModeController();
    const result = ctrl.rollbackDesktop();
    const failure = expectFailure(result);
    expect(failure.reason).toBe('not-in-loading');
  });

  it('从 loading 状态 transition(chat) 回退到 chat', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    expect(ctrl.getMode()).toBe('loading');
    const result = await ctrl.transition('chat');
    expectOk(result);
    expect(ctrl.getMode()).toBe('chat');
  });

  it('从 desktop 状态 transition(chat) 回退到 chat', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    ctrl.commitDesktop();
    expect(ctrl.getMode()).toBe('desktop');
    const result = await ctrl.transition('chat');
    expectOk(result);
    expect(ctrl.getMode()).toBe('chat');
  });

  it('transition 到相同 mode 返回 failure (already-in-mode)', async () => {
    const ctrl = new ModeController();
    const result = await ctrl.transition('chat');
    const failure = expectFailure(result);
    expect(failure.reason).toBe('already-in-mode');
  });

  it('在 loading 状态再次 transition(desktop) 返回 failure (already-loading)', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    const result = await ctrl.transition('desktop');
    const failure = expectFailure(result);
    expect(failure.reason).toBe('already-loading');
  });

  it('reportAvatarCrash 在 desktop 模式时恢复到 chat', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    ctrl.commitDesktop();
    expect(ctrl.getMode()).toBe('desktop');
    ctrl.reportAvatarCrash();
    expect(ctrl.getMode()).toBe('chat');
  });

  it('reportAvatarCrash 在 loading 模式时恢复到 chat', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    expect(ctrl.getMode()).toBe('loading');
    ctrl.reportAvatarCrash();
    expect(ctrl.getMode()).toBe('chat');
  });

  it('reportAvatarCrash 后证据清除，再次 transition(desktop) 失败', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    ctrl.commitDesktop();
    ctrl.reportAvatarCrash();
    const result = await ctrl.transition('desktop');
    expectFailure(result);
  });

  it('on(mode-change) 在切到 loading 时收到回调', async () => {
    const ctrl = new ModeController();
    const cb = vi.fn();
    ctrl.on('mode-change', cb);
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({
      from: 'chat',
      to: 'loading'
    }));
  });

  it('on(mode-change) 在 commitDesktop 时收到回调', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    const cb = vi.fn();
    ctrl.on('mode-change', cb);
    ctrl.commitDesktop();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({
      from: 'loading',
      to: 'desktop'
    }));
  });

  it('on(mode-change) 在 rollbackDesktop 时收到回调', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    const cb = vi.fn();
    ctrl.on('mode-change', cb);
    ctrl.rollbackDesktop();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({
      from: 'loading',
      to: 'chat',
      reason: 'desktop-rollback'
    }));
  });

  it('on(mode-change) 在 avatar 崩溃恢复时收到回调', async () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    await ctrl.transition('desktop');
    ctrl.commitDesktop();
    const cb = vi.fn();
    ctrl.on('mode-change', cb);
    ctrl.reportAvatarCrash();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({
      from: 'desktop',
      to: 'chat',
      reason: 'avatar-crash'
    }));
  });

  it('clearAvatarReady 清除证据但不改变当前 chat mode', () => {
    const ctrl = new ModeController();
    ctrl.setAvatarReady({ source: 'test-only-ready', timestamp: Date.now() });
    ctrl.clearAvatarReady();
    expect(ctrl.getMode()).toBe('chat');
  });
});
