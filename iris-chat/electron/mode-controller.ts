// ModeController：ChatX2 模式状态机
// 职责：管理 chat / loading / desktop / scene 模式之间的受控切换
// 设计要点（Phase 2 修复）：
// - 初始 mode 为 chat；Desktop 加载期间及失败后 Chat 必须保持可见
// - 只有"有效模型证据"才允许切到 desktop；placeholder-canvas 不是有效证据
// - Phase 2 仅 test-only-ready（测试主进程注入）可授权 Desktop 切换；pmx-first-frame 留给 Phase 3
// - 切换为事务：beginDesktopTransition → 窗口确认可见 → commitDesktop；失败回滚到 chat
// - Scene 只返回 unavailable（D4 决策：不创建场景资源）
// - Avatar 关闭或崩溃必须恢复 Chat

export type AppMode = 'chat' | 'loading' | 'desktop' | 'scene';

export type TransitionResult =
  | { status: 'ok'; mode: AppMode }
  | { status: 'failure'; reason: 'no-avatar-ready' | 'already-in-mode' | 'unknown-target' | 'not-in-loading' | 'already-loading'; mode: AppMode }
  | { status: 'unavailable'; reason: 'scene-not-implemented'; mode: AppMode };

export interface AvatarReadyEvidence {
  // placeholder-canvas: Phase 2 透明 Canvas 占位（非真实 PMX，不能授权 Desktop 切换）
  // test-only-ready: 测试主进程通过受控 IPC 注入（仅测试模式可用）
  // pmx-first-frame: Phase 3 真实 PMX 首帧（Phase 2/3 不得使用，Phase 3 才接入）
  readonly source: 'placeholder-canvas' | 'test-only-ready' | 'pmx-first-frame';
  readonly timestamp: number;
}

export interface ModeChangeEvent {
  from: AppMode;
  to: AppMode;
  reason?: string;
  evidence?: AvatarReadyEvidence;
}

type ModeChangeCallback = (payload: ModeChangeEvent) => void;
type AvatarReadyCallback = (payload: AvatarReadyEvidence) => void;
type EventCallback = ModeChangeCallback | AvatarReadyCallback;

/**
 * 判断证据源是否"有效"——即可以授权正式 Desktop 切换。
 * placeholder-canvas 永远不是有效证据（只是占位）。
 * test-only-ready 仅测试模式可用。
 * pmx-first-frame 是 Phase 3 才有的真实模型证据。
 */
function isValidModelEvidence(evidence: AvatarReadyEvidence): boolean {
  return evidence.source === 'test-only-ready' || evidence.source === 'pmx-first-frame';
}

export class ModeController {
  private mode: AppMode = 'chat';
  private avatarReady: AvatarReadyEvidence | null = null;
  private readonly listeners: Map<string, Set<EventCallback>> = new Map();

  getMode(): AppMode {
    return this.mode;
  }

  getAvatarReadyEvidence(): AvatarReadyEvidence | null {
    return this.avatarReady;
  }

  /**
   * 设置 avatar-ready 证据。
   * placeholder-canvas 会被记录但不授权 Desktop 切换（仅作为占位通知）。
   * test-only-ready 和 pmx-first-frame 是有效证据。
   *
   * 优先级保护：高优先级证据不会被低优先级覆盖。
   * pmx-first-frame > test-only-ready > placeholder-canvas
   * 这防止了 PMX 首帧成功后，后续错误回退的 signalAvatarReady() 覆盖掉有效证据。
   */
  setAvatarReady(evidence: AvatarReadyEvidence): void {
    // 优先级保护：高优先级证据不被低优先级覆盖
    const PRIORITY: Record<string, number> = {
      'pmx-first-frame': 3,
      'test-only-ready': 2,
      'placeholder-canvas': 1
    };
    if (this.avatarReady && (PRIORITY[evidence.source] ?? 0) < (PRIORITY[this.avatarReady.source] ?? 0)) {
      console.log(
        '[mode-controller] avatarReady: ignoring lower-priority evidence',
        evidence.source, '(current:', this.avatarReady.source, ')'
      );
      return;
    }
    this.avatarReady = evidence;
    console.log('[mode-controller] avatarReady SET:', evidence.source, '@', new Date(evidence.timestamp).toISOString());
    this.emit('avatar-ready', evidence);
  }

  /**
   * 清除 avatar-ready 证据（不触发模式回退；如需回退用 reportAvatarCrash）。
   */
  clearAvatarReady(): void {
    this.avatarReady = null;
  }

  /**
   * 报告 Avatar 崩溃或关闭：清除证据并从 desktop/loading 恢复到 chat。
   */
  reportAvatarCrash(): void {
    console.warn('[mode-controller] reportAvatarCrash called — clearing avatarReady. mode=', this.mode);
    this.avatarReady = null;
    if (this.mode === 'desktop' || this.mode === 'loading') {
      const from = this.mode;
      this.mode = 'chat';
      this.emit('mode-change', { from, to: 'chat', reason: 'avatar-crash' });
    }
  }

  /**
   * 切换到目标模式（外部触发）。
   * - chat → desktop：需要有效 avatar-ready 证据；先进入 loading 状态
   * - 任意 → scene：返回 unavailable
   * - desktop/loading → chat：直接成功（loading 也回退）
   * 注意：进入 desktop 需要先经过 loading，窗口确认可见后调用 commitDesktop。
   */
  async transition(target: AppMode): Promise<TransitionResult> {
    if (target === this.mode) {
      return { status: 'failure', reason: 'already-in-mode', mode: this.mode };
    }

    if (target === 'scene') {
      return { status: 'unavailable', reason: 'scene-not-implemented', mode: this.mode };
    }

    if (target === 'desktop') {
      // 必须从 chat 切入 loading，不能从其他状态直接跳 desktop
      if (this.mode !== 'chat') {
        return { status: 'failure', reason: 'already-loading', mode: this.mode };
      }
      // 必须有有效证据（placeholder-canvas 无效）
      if (!this.avatarReady || !isValidModelEvidence(this.avatarReady)) {
        const evidenceDesc = this.avatarReady
          ? `source=${this.avatarReady.source}, timestamp=${new Date(this.avatarReady.timestamp).toISOString()}`
          : 'null';
        console.warn('[mode-controller] transition(desktop) rejected: no-avatar-ready. evidence=', evidenceDesc);
        return { status: 'failure', reason: 'no-avatar-ready', mode: this.mode };
      }
      // 进入 loading 状态（窗口显示前）
      const from = this.mode;
      this.mode = 'loading';
      this.emit('mode-change', { from, to: 'loading', evidence: this.avatarReady, reason: 'begin-desktop-transition' });
      return { status: 'ok', mode: this.mode };
    }

    if (target === 'chat') {
      const from = this.mode;
      this.mode = 'chat';
      this.emit('mode-change', { from, to: 'chat', reason: 'user-transition' });
      return { status: 'ok', mode: this.mode };
    }

    return { status: 'failure', reason: 'unknown-target', mode: this.mode };
  }

  /**
   * 提交 Desktop 切换：必须在 loading 状态下调用，窗口已确认可见。
   * 调用后 mode 变为 desktop，Chat 才会被隐藏。
   */
  commitDesktop(): TransitionResult {
    if (this.mode !== 'loading') {
      return { status: 'failure', reason: 'not-in-loading', mode: this.mode };
    }
    const from = this.mode;
    this.mode = 'desktop';
    this.emit('mode-change', { from, to: 'desktop', evidence: this.avatarReady ?? undefined, reason: 'desktop-committed' });
    return { status: 'ok', mode: this.mode };
  }

  /**
   * 回滚 Desktop 切换：loading 状态下窗口显示失败时调用，回到 chat。
   * 注意：不回滚时不清除 avatarReady 证据——Avatar 窗口仍然存在且就绪，
   * 只是隐藏了。如果清除证据，用户下次点击桌宠按钮会因 no-avatar-ready 而失败。
   * 只有 Avatar 真正崩溃/关闭时才清除证据（reportAvatarCrash）。
   */
  rollbackDesktop(): TransitionResult {
    if (this.mode !== 'loading') {
      return { status: 'failure', reason: 'not-in-loading', mode: this.mode };
    }
    const from = this.mode;
    this.mode = 'chat';
    this.emit('mode-change', { from, to: 'chat', reason: 'desktop-rollback' });
    return { status: 'ok', mode: this.mode };
  }

  /**
   * 订阅事件。返回取消订阅函数。
   * 事件：'mode-change' | 'avatar-ready'
   */
  on(event: 'mode-change', cb: ModeChangeCallback): () => void;
  on(event: 'avatar-ready', cb: AvatarReadyCallback): () => void;
  on(event: 'mode-change' | 'avatar-ready', cb: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  private emit(event: string, payload: ModeChangeEvent | AvatarReadyEvidence): void {
    this.listeners.get(event)?.forEach(cb => (cb as (p: ModeChangeEvent | AvatarReadyEvidence) => void)(payload));
  }
}