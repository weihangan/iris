// Desktop Composer renderer（Phase 4）
// 职责：通过 IPC 调用唯一 ConversationController，禁止自己实现聊天业务
// - 提交时传 source='desktop'
// - 不显示历史（Composer 是小型输入栏，只负责提交）
// - Mock 后端时显示 MOCK 徽章
//
// Phase 5.1 修复（P0-A/B/C）：Composer 不再拥有 AudioContext。
// 旧架构（已废弃）：
//   - Composer 创建 AudioContext，调用 decodeAudioData，调度 sourceNode.start
//   - 调用 audioSpeak(taskId, scheduledStartAt) 通知 Avatar 张嘴
//   问题1（P0）：有效 taskId 仍可在解码完成前张嘴（authorizeSpeak 只检查缓存，不检查解码状态）
//   问题2（P0）：AudioContext suspended 时 currentTime 不前进，但 sourceNode.start + setTimeout 仍执行，
//               导致"无声表演"（字幕显示、张嘴、但无声音）
// 新架构：
//   - Composer 收到 message-added(assistant, audioReady=true, taskId) 后调用 audioPlay(taskId)
//   - 主进程校验 taskId 在 wavCache 中后，转发 avatar:play(taskId, wavBytes) 给 Avatar
//   - Avatar 自主完成 AudioContext + decodeAudioData + sourceNode.start + actorRuntime.speak
//   - Avatar 在所有条件满足后发送 performance:started → Composer 显示字幕 + __composerSpeaking=true
//   - Avatar 在播放结束/失败/中断时发送 performance:ended → Composer 隐藏字幕 + __composerSpeaking=false
//   硬门：Composer 无法在解码完成前张嘴，因为 Composer 不再有 AudioContext 和 audioSpeak 调用。
import type { ModelPackListItem, SwitchModelResult, ModelPackMotions, ModelPackPhysics } from './model-pack/model-pack-types';
import { BUILD_ID } from './build-identity';
import type { DailyPerformanceCandidate } from './performance/daily-candidate-types';
import { bindVoiceInput } from './voice-input-controller';

document.documentElement.dataset.buildId = BUILD_ID;
(window as any).__CHATX2_BUILD_ID__ = BUILD_ID;

export {};

// Phase 4: 对话类型（与 composer-preload 声明同构）
type AppMode = 'chat' | 'loading' | 'desktop' | 'scene';
type ConversationRole = 'user' | 'assistant' | 'system';
type ConversationSource = 'chat' | 'desktop' | 'controller';
type ConversationTaskStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
type ConversationEventType =
  | 'message-added'
  | 'message-updated'
  | 'task-started'
  | 'task-completed'
  | 'task-cancelled'
  | 'task-failed';

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  text: string;
  source: ConversationSource;
  timestamp: number;
  isMock: boolean;
  audioReady: boolean;
  audioError?: string;
  taskId?: string;
}

interface AudioRegenerateResult {
  success: boolean;
  taskId: string;
  audioReady: boolean;
  audioError?: string;
}

interface ConversationSubmitResult {
  accepted: boolean;
  taskId?: string;
  reason?: 'busy' | 'empty-text';
  userMessage?: ConversationMessage;
}

interface ConversationTask {
  taskId: string;
  status: ConversationTaskStatus;
  userMessageId: string;
  source: 'chat' | 'desktop';
  inputText: string;
  startedAt: number;
  finishedAt?: number;
}

interface ConversationHistory {
  messages: readonly ConversationMessage[];
  activeTask: ConversationTask | null;
}

interface ConversationEvent {
  type: ConversationEventType;
  message?: ConversationMessage;
  taskId?: string;
  reason?: string;
}

interface ChatX2Identity {
  appId: string;
  productName: string;
  version: string;
  buildId: string;
  appPath: string;
  resourcesPath: string;
  expressPort: number;
  ttsPort: number;
  userDataDir: string;
  sharedDataDir: string;
  isTest: boolean;
  isChat5: boolean;
  pmxRenderInTest: boolean;
  conversationIsMock: boolean;
}

interface ModeChangeEvent {
  from: AppMode;
  to: AppMode;
  reason?: string;
}

interface TransitionResult {
  status: 'ok' | 'failure' | 'unavailable';
  reason?: string;
  mode: AppMode;
}

/**
 * Phase 5.1 修复（P0-A/B/C）：Avatar 表演结束原因（来自 performance:ended IPC）。
 * 与 conversation-types.ts 的 AudioPlaybackState 不同——这里是 Avatar 视角的完整枚举。
 */
type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';

// Composer 不使用所有方法，但必须与 renderer.ts 的 window.chatx2 声明保持类型一致
// （否则 TS2717: Subsequent property declarations must have the same type）
declare global {
  interface Window {
    chatx2: {
      listPerformanceCandidates: () => Promise<readonly DailyPerformanceCandidate[]>;
      previewMotionCandidate: (id: string) => Promise<{ success: boolean }>;
      previewExpressionCandidate: (id: string) => Promise<{ success: boolean }>;
      previewCombinedCandidate: (id: string) => Promise<{ success: boolean }>;
      acceptMotionCandidate: (id: string) => Promise<{ success: boolean }>;
      acceptExpressionCandidate: (id: string) => Promise<{ success: boolean }>;
      deletePerformanceCandidate: (id: string) => Promise<{ success: boolean }>;
      getIdentity: () => Promise<ChatX2Identity>;
      getMode: () => Promise<AppMode>;
      transition: (target: AppMode) => Promise<TransitionResult>;
      hasAvatarReady: () => Promise<boolean>;
      getWindowsVisibility: () => Promise<Array<{ title: string; visible: boolean; type: string }>>;
      selectPmxModel: () => Promise<{
        success: boolean;
        modelPath?: string;
        sha256?: string;
        packId?: string;
        reason?: 'cancelled' | 'hash-mismatch' | 'invalid-extension' | 'import-failed';
      }>;
      testInjectReady: () => Promise<{ success: boolean; reason?: string }>;
      reportAvatarCrash: () => void;
      onModeChange: (cb: (event: ModeChangeEvent) => void) => (() => void);
      // Phase 4: 对话 IPC
      conversationSubmit: (text: string) => Promise<ConversationSubmitResult>;
      transcribeVoiceInput: (audio: ArrayBuffer, mimeType: string) => Promise<{ success: boolean; text?: string; error?: string }>;
      conversationHistory: () => Promise<ConversationHistory>;
      conversationCancel: () => Promise<{ cancelled: boolean; taskId?: string; reason?: string }>;
      onConversationEvent: (cb: (event: ConversationEvent) => void) => (() => void);
      // Phase 5.1 修复（P0-A/B/C）：新音频 IPC（Composer 不再有 AudioContext）
      // Composer 请求 Avatar 开始播放（主进程校验 taskId 后转发 avatar:play）
      audioPlay: (taskId: string) => Promise<void>;
      // Composer 请求 Avatar 停止播放（新消息打断）
      audioStop: (taskId: string) => Promise<void>;
      // Avatar → 主进程 → Composer：表演已开始（Composer 显示字幕 + __composerSpeaking=true）
      // Phase 5.2 Task 5.2.6：可选 audioStartTime 参数（AudioContext.currentTime），用于字幕同步
      onPerformanceStarted: (cb: (taskId: string, audioStartTime?: number) => void) => (() => void);
      // Avatar → 主进程 → Composer：表演已结束（Composer 隐藏字幕 + __composerSpeaking=false）
      onPerformanceEnded: (cb: (taskId: string, reason: PerformanceEndReason) => void) => (() => void);
      // Phase 5.1 修复（P0-1）：重新生成语音（主进程用 VoiceAdapter，不重新调用 ChatAdapter）
      audioRegenerate: (taskId: string) => Promise<AudioRegenerateResult>;
      // Phase 5.2 修正（2026-07-19）：motion IPC（语义级输入，主进程校验后转发 Avatar）
      motionList: () => Promise<Array<{
        packId: string;
        trigger: 'user-only' | 'conversation' | 'idle';
        allowedStates: string[];
        movesRoot: boolean;
        fadeInSeconds: number;
        fadeOutSeconds: number;
        cooldownSeconds: number;
        mode: 'production' | 'candidate-review' | 'unknown';
      }>>;
      motionLoad: (semantic: { emotion?: string; intent?: string; gestureFamily?: string }) =>
        Promise<{ success: boolean; reason?: string }>;
      motionPlay: (semantic: { emotion?: string; intent?: string; gestureFamily?: string }) =>
        Promise<{ success: boolean; reason?: string }>;
      motionStop: () => Promise<{ success: boolean; reason?: string }>;
      motionEmotionUpdate: (emotion: string, intent?: string) =>
        Promise<{ success: boolean; reason?: string }>;
      // ChatX2 模型包管理 API
      listModelPacks: () => Promise<ModelPackListItem[]>;
      openModelsFolder: () => Promise<{ success: boolean; reason?: string }>;
      getCurrentModelPack: () => Promise<{ success: boolean; packId?: string; displayName?: string; internalName?: string; capabilities?: string[]; motions?: ModelPackMotions; physics?: ModelPackPhysics }>;
      switchModelPack: (packId: string) => Promise<SwitchModelResult>;
      importVmd: () => Promise<{ success: boolean; relativePath?: string; reason?: string }>;
      listMotionPacks: () => Promise<{ success: boolean; idlePacks?: string[]; gesturePacks?: string[]; customVmd?: string[]; defaultIdle?: string }>;
      toggleMotionPack: (motionPackId: string, enabled: boolean, type: 'idle' | 'gesture') => Promise<{ success: boolean }>;
      setDefaultIdle: (idlePackId: string) => Promise<{ success: boolean }>;
      previewMotionPack: (motionPackId: string, type: 'idle' | 'gesture') => Promise<{ success: boolean }>;
      previewCustomVmd: (relativePath: string) => Promise<{ success: boolean }>;
      previewLongVmd: (relativePath: string) => Promise<{ success: boolean }>;
      listVmdWithInfo: () => Promise<{
        success: boolean;
        items?: Array<{ path: string; displayName: string; duration: number; category: 'short' | 'medium' | 'long' }>;
        defaultIdle?: string;
        idleVmdPool?: string[];
      }>;
      listExternalVmdCandidates: () => Promise<{
        success: boolean;
        root?: string;
        items?: Array<{ path: string; displayName: string; duration: number; category: 'short' | 'medium' | 'long'; size: number; valid: boolean }>;
      }>;
      previewExternalVmd: (relativePath: string) => Promise<{ success: boolean; reason?: string; packId?: string }>;
      deleteExternalVmd: (relativePath: string) => Promise<{ success: boolean; reason?: string }>;
      acceptExternalVmd: (relativePath: string) => Promise<{ success: boolean; relativePath?: string; folder?: string; reason?: string }>;
      removeCustomVmd: (relativePath: string) => Promise<{ success: boolean }>;
      removeLongVmd: (relativePath: string) => Promise<{ success: boolean }>;
      removeLibraryVmd: (relativePath: string) => Promise<{ success: boolean; removedReferences?: number; reason?: string }>;
      importLongVmd: () => Promise<{ success: boolean; imported?: string[]; reason?: string }>;
      toggleIdleVmd: (vmdPath: string, inPool: boolean) => Promise<{ success: boolean; reason?: string; maxSlots?: number }>;
      onModelPackChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void) => (() => void);
      onMotionConfigChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void) => (() => void);
      // 语音动作（统一管理，所有模型共享）
      listVoiceActions: () => Promise<{
        success: boolean;
        entries?: Array<{ vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }>;
        grouped?: Record<string, Array<{ vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }>>;
      }>;
      addVoiceAction: (entry: { vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }) => Promise<{ success: boolean }>;
      removeVoiceAction: (vmdPath: string) => Promise<{ success: boolean; reason?: string }>;
      updateVoiceAction: (vmdPath: string, updates: { emotions?: string[]; displayName?: string; gestureFamily?: string; intent?: string; description?: string; dialogueSafe?: boolean; starred?: boolean; headTuning?: { rotationScale: number } }) => Promise<{ success: boolean }>;
      setTransitionSpeed: (multiplier: number) => Promise<{ success: boolean; value?: number; reason?: string }>;
      getTransitionSpeed: () => Promise<{ value: number }>;
      /** 暂停/恢复待机动作 */
      toggleIdlePaused: () => Promise<{ success: boolean; paused: boolean }>;
      /** 获取待机动作暂停状态 */
      getIdlePaused: () => Promise<{ paused: boolean }>;
      setPoseLock: (locked: boolean) => Promise<{ success: boolean; locked: boolean }>;
      togglePoseLock: () => Promise<{ success: boolean; locked: boolean }>;
      getPoseLock: () => Promise<{ locked: boolean }>;
      onPoseLockChanged: (cb: (payload: { locked: boolean }) => void) => (() => void);
      setGazeLock: (locked: boolean) => Promise<{ success: boolean; locked: boolean }>;
      getGazeLock: () => Promise<{ locked: boolean }>;
      onGazeLockChanged: (cb: (payload: { locked: boolean }) => void) => (() => void);
      setRenderQuality: (level: 'low' | 'medium' | 'high' | 'ultra') => Promise<{ success: boolean; level?: string; reason?: string }>;
      getRenderQuality: () => Promise<{ level: 'low' | 'medium' | 'high' | 'ultra' }>;
      // 桌宠窗口控制
      setModelPassThrough: (manual: boolean) => Promise<void>;
      setModelScale: (delta: number) => Promise<{ success: boolean }>;
      setCameraView: (mode: 'full' | 'half') => Promise<{ success: boolean }>;
      setModelRotation: (yaw: number, pitch: number) => Promise<{ success: boolean; yaw?: number; pitch?: number }>;
      /** 退出桌宠模式 */
      exitDesktop: () => Promise<{ success: boolean }>;
      /** 切换窗口置顶 */
      toggleAlwaysOnTop: (onTop: boolean) => Promise<{ success: boolean }>;
      /** 切换到聊天窗口 */
      transitionToChat: () => Promise<{ success: boolean }>;
      /** 手动模型穿透开关变化（仅用户意图，不含 hover 物理状态） */
      onModelPassThroughChanged: (cb: (payload: { manual: boolean }) => void) => (() => void);
    };
  }
}

/**
 * 初始化桌宠窗口控制工具栏（穿透/放大/缩小/视角切换）。
 * 按钮位于 Composer 输入框上方，用于控制桌宠窗口。
 * 放在 Composer 窗口而非桌宠窗口的原因：开启穿透后桌宠窗口无法接收点击事件。
 */
function initAvatarCtrlBar(): void {
  const bar = document.getElementById('avatar-ctrl-bar');
  if (!bar) return;

  let isOnTop = true;   // 默认置顶
  const btnOnTop = document.getElementById('btn-avatar-on-top');
  const btnThrough = document.getElementById('btn-avatar-through');
  const btnZoomIn = document.getElementById('btn-avatar-zoom-in');
  const btnZoomOut = document.getElementById('btn-avatar-zoom-out');
  const btnIdle = document.getElementById('btn-avatar-idle');
  const btnPoseLock = document.getElementById('btn-avatar-pose-lock');
  const btnGazeLock = document.getElementById('btn-avatar-gaze-lock');

  if (btnOnTop) {
    // 初始状态：默认置顶
    btnOnTop.style.background = 'rgba(180,160,60,0.7)';
    btnOnTop.style.color = '#e0d080';
    btnOnTop.textContent = '取消置顶';
    btnOnTop.addEventListener('click', async () => {
      try {
        isOnTop = !isOnTop;
        await window.chatx2.toggleAlwaysOnTop(isOnTop);
        btnOnTop.style.background = isOnTop ? 'rgba(180,160,60,0.7)' : 'rgba(60,60,72,0.6)';
        btnOnTop.style.color = isOnTop ? '#e0d080' : '#a0b0c0';
        btnOnTop.textContent = isOnTop ? '取消置顶' : '置顶';
      } catch (e) {
        console.warn('[composer-ctrl] toggleAlwaysOnTop failed:', e);
        isOnTop = !isOnTop;
      }
    });
  }
  if (btnThrough) {
    // 按钮只反映手动模型穿透开关（用户意图），不反映 hover 物理状态
    let manualPassThrough = false;
    const updateThroughBtn = (manual: boolean): void => {
      manualPassThrough = manual;
      btnThrough.style.background = manual ? 'rgba(180,140,80,0.7)' : 'rgba(60,60,72,0.6)';
      btnThrough.style.color = manual ? '#d0b080' : '#a0b0c0';
      btnThrough.textContent = manual ? '取消穿透' : '穿透';
    };
    updateThroughBtn(false);
    btnThrough.addEventListener('click', async () => {
      try {
        // 只发请求给 Avatar renderer，不直接调 Electron 窗口 API
        await window.chatx2.setModelPassThrough(!manualPassThrough);
      } catch (e) {
        console.warn('[composer-ctrl] setModelPassThrough failed:', e);
      }
    });
    // 只订阅手动模型穿透开关变化（不订阅 hover 物理状态）
    try {
      const unsubscribe = window.chatx2.onModelPassThroughChanged((payload) => {
        updateThroughBtn(payload.manual);
      });
      window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
    } catch (e) {
      console.warn('[composer-ctrl] onModelPassThroughChanged failed:', e);
    }
  }
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', async () => {
      try { await window.chatx2.setModelScale(0.1); }
      catch (e) { console.warn('[composer-ctrl] setModelScale (+):', e); }
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', async () => {
      try { await window.chatx2.setModelScale(-0.1); }
      catch (e) { console.warn('[composer-ctrl] setModelScale (-):', e); }
    });
  }
  if (btnIdle) {
    // 待机动作开关：初始状态为开启
    let isIdlePaused = false;
    const idleBtn = btnIdle; // narrow type for closure
    // 启动时查询当前状态
    (async () => {
      try {
        const res = await window.chatx2.getIdlePaused();
        isIdlePaused = res.paused;
        updateIdleBtn();
      } catch { /* ignore */ }
    })();
    function updateIdleBtn(): void {
      idleBtn.style.background = isIdlePaused ? 'rgba(140,60,60,0.7)' : 'rgba(60,60,72,0.6)';
      idleBtn.style.color = isIdlePaused ? '#d0a0a0' : '#a0d0a0';
      // 显示当前状态，避免“待机”被误读为点击后开启。
      idleBtn.textContent = isIdlePaused ? '待机：关' : '待机：开';
    }
    idleBtn.addEventListener('click', async () => {
      try {
        const res = await window.chatx2.toggleIdlePaused();
        isIdlePaused = res.paused;
        updateIdleBtn();
      } catch (e) {
        console.warn('[composer-ctrl] toggleIdlePaused failed:', e);
      }
    });
  }
  if (btnPoseLock) {
    let poseLocked = false;
    const updatePoseLockBtn = (locked: boolean): void => {
      poseLocked = locked;
      btnPoseLock.style.background = locked ? 'rgba(110,75,160,0.8)' : 'rgba(60,60,72,0.6)';
      btnPoseLock.style.color = locked ? '#f0e8ff' : '#c0b0e0';
      btnPoseLock.textContent = locked ? '解锁' : '锁定';
    };
    void window.chatx2.getPoseLock().then(result => updatePoseLockBtn(result.locked)).catch(() => {});
    btnPoseLock.addEventListener('click', () => {
      void window.chatx2.setPoseLock(!poseLocked).then(result => updatePoseLockBtn(result.locked)).catch(e => {
        console.warn('[composer-ctrl] setPoseLock failed:', e);
      });
    });
    const unsubscribe = window.chatx2.onPoseLockChanged(payload => updatePoseLockBtn(payload.locked));
    window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  }
  if (btnGazeLock) {
    let gazeLocked = false;
    const updateGazeLockBtn = (locked: boolean): void => {
      gazeLocked = locked;
      btnGazeLock.style.background = locked ? 'rgba(50,105,135,0.85)' : 'rgba(60,60,72,0.6)';
      btnGazeLock.style.color = locked ? '#effaff' : '#9ec8df';
      btnGazeLock.textContent = locked ? '目光：锁定' : '目光锁定';
    };
    void window.chatx2.getGazeLock().then(result => updateGazeLockBtn(result.locked)).catch(() => {});
    btnGazeLock.addEventListener('click', () => {
      void window.chatx2.setGazeLock(!gazeLocked).then(result => updateGazeLockBtn(result.locked)).catch(e => {
        console.warn('[composer-ctrl] setGazeLock failed:', e);
      });
    });
    const unsubscribe = window.chatx2.onGazeLockChanged(payload => updateGazeLockBtn(payload.locked));
    window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  }

  // 视角切换按钮
  const viewButtons: Array<{ btn: HTMLElement | null; mode: 'full' | 'half' }> = [
    { btn: document.getElementById('btn-view-full'), mode: 'full' },
    { btn: document.getElementById('btn-view-half'), mode: 'half' }
  ];
  for (const { btn, mode } of viewButtons) {
    if (!btn) continue;
    btn.addEventListener('click', async () => {
      try {
        await window.chatx2.setCameraView(mode);
        // 高亮当前选中的视角按钮
        for (const { btn: b } of viewButtons) {
          if (b) {
            b.style.background = 'rgba(60,60,72,0.6)';
            b.style.color = '#b0c0e0';
          }
        }
        btn.style.background = 'rgba(80,120,180,0.7)';
        btn.style.color = '#ffffff';
      } catch (e) {
        console.warn('[composer-ctrl] setCameraView failed:', e);
      }
    });
  }

  // 退出模型按钮
  const btnExit = document.getElementById('btn-exit-desktop');
  if (btnExit) {
    btnExit.addEventListener('click', async () => {
      try {
        await window.chatx2.exitDesktop();
      } catch (e) {
        console.warn('[composer-ctrl] exitDesktop failed:', e);
      }
    });
  }
}

function initModelComputeControl(): void {
  type ComputeLevel = 'low' | 'medium' | 'high' | 'ultra';
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-compute-level]'));
  if (buttons.length === 0) return;
  let selected: ComputeLevel = 'high';
  const render = (level: ComputeLevel): void => {
    selected = level;
    for (const button of buttons) {
      button.classList.toggle('active', button.dataset.computeLevel === level);
    }
  };
  render(selected);
  void window.chatx2.getRenderQuality().then(({ level }) => render(level)).catch(() => {});
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const next = button.dataset.computeLevel as ComputeLevel;
      const previous = selected;
      render(next);
      buttons.forEach(item => { item.disabled = true; });
      try {
        const result = await window.chatx2.setRenderQuality(next);
        if (!result.success) render(previous);
      } catch (e) {
        render(previous);
        console.warn('[composer-compute] setRenderQuality failed:', e);
      } finally {
        buttons.forEach(item => { item.disabled = false; });
      }
    });
  }
}

function initModelRotationControl(): void {
  const yaw = document.getElementById('model-yaw') as HTMLInputElement | null;
  const pitch = document.getElementById('model-pitch') as HTMLInputElement | null;
  const yawValue = document.getElementById('model-yaw-value');
  const pitchValue = document.getElementById('model-pitch-value');
  if (!yaw || !pitch) return;

  let framePending = false;
  const renderValues = (): void => {
    if (yawValue) yawValue.textContent = `${yaw.value}°`;
    if (pitchValue) pitchValue.textContent = `${pitch.value}°`;
  };
  const send = (): void => {
    framePending = false;
    void window.chatx2.setModelRotation(Number(yaw.value), Number(pitch.value)).catch(e => {
      console.warn('[composer-rotation] setModelRotation failed:', e);
    });
  };
  const onInput = (): void => {
    renderValues();
    // Coalesce high-frequency range input events to one IPC call per frame.
    if (!framePending) {
      framePending = true;
      requestAnimationFrame(send);
    }
  };
  renderValues();
  yaw.addEventListener('input', onInput);
  pitch.addEventListener('input', onInput);
}

function initComposerRenderer(): void {
  initModelComputeControl();
  initModelRotationControl();
  const inputEl = document.getElementById('input') as HTMLInputElement | null;
  const sendBtn = document.getElementById('send') as HTMLButtonElement | null;
  const mockBadgeEl = document.getElementById('mock-badge');
  const subtitleEl = document.getElementById('subtitle') as HTMLElement | null;
  const chatBtn = document.getElementById('chat-btn') as HTMLButtonElement | null;
  const statusBar = document.getElementById('status-bar');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  if (!inputEl || !sendBtn) {
    console.error('[composer] required DOM elements missing');
    return;
  }

  // 初始化桌宠窗口控制工具栏（穿透/放大/缩小）
  initAvatarCtrlBar();

  // Phase 5.1: 测试可见标志（E2E 验证音频优先硬门）
  (window as any).__composerSubtitle = '';
  (window as any).__composerDecoding = false;
  (window as any).__composerSpeaking = false;

  // 状态栏更新工具函数
  const showStatus = (state: 'thinking' | 'speaking' | 'error' | 'idle', text: string): void => {
    if (!statusBar || !statusDot || !statusText) return;
    statusDot.className = state === 'idle' ? '' : state;
    statusText.textContent = text;
    if (state === 'idle') {
      statusBar.classList.remove('visible');
    } else {
      statusBar.classList.add('visible');
    }
  };

  // 打开完整聊天窗口按钮
  if (chatBtn) {
    chatBtn.addEventListener('click', () => {
      void window.chatx2.transitionToChat().catch(e => {
        console.warn('[composer] transitionToChat failed:', e);
      });
    });
  }

  // Phase 4: 显示 Mock 徽章（如果后端是 Mock）
  window.chatx2.getIdentity().then(identity => {
    if (mockBadgeEl) {
      if (identity.conversationIsMock) {
        mockBadgeEl.style.display = 'inline-block';
        mockBadgeEl.textContent = 'MOCK';
      } else {
        mockBadgeEl.style.display = 'none';
      }
    }
  }).catch(e => {
    console.error('[composer] getIdentity failed:', e);
  });

  // Phase 5.1 修复（P0-1）：assistant 消息 audioReady=false 时显示正文 + 错误 + "重新生成语音"按钮。
  const showTextWithAudioError = (message: ConversationMessage, taskId: string, errorMsg: string): void => {
    if (subtitleEl) {
      subtitleEl.textContent = '';
      subtitleEl.style.visibility = 'visible';
      subtitleEl.classList.add('visible', 'error');
      subtitleEl.classList.remove('mock', 'speaking');

      const textSpan = document.createElement('span');
      const display = message.isMock ? `[MOCK] ${message.text}` : message.text;
      textSpan.textContent = `${display} [${errorMsg}] `;
      subtitleEl.appendChild(textSpan);

      const regenBtn = document.createElement('button');
      regenBtn.textContent = '重新生成语音';
      regenBtn.style.cssText = 'padding:2px 6px;font-size:11px;background:#07c160;color:#fff;border:none;border-radius:3px;cursor:pointer;margin-left:4px;-webkit-app-region:no-drag;';
      regenBtn.setAttribute('data-regen-task-id', taskId);
      regenBtn.addEventListener('click', () => { void regenerateAudioForTask(taskId); });
      subtitleEl.appendChild(regenBtn);
    }
    showStatus('error', '语音生成失败');
    (window as any).__composerSubtitle = message.text;
  };

  const hideSubtitle = (): void => {
    if (subtitleEl) {
      subtitleEl.textContent = '';
      subtitleEl.style.visibility = 'hidden';
      subtitleEl.classList.remove('visible', 'mock', 'error', 'speaking');
    }
    (window as any).__composerSubtitle = '';
  };

  // 字幕中的中文引号引用段（“……”）渲染为小一号 span，与 Chat 窗口
  // 的 .inline-quote 规则保持一致；无引号时退化为纯文本。
  const appendQuotedText = (container: HTMLElement, text: string): void => {
    const value = String(text || '');
    const quoteRe = /“([^”]{1,40})”/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let matched = false;
    quoteRe.lastIndex = 0;
    while ((m = quoteRe.exec(value)) !== null) {
      matched = true;
      if (m.index > lastIdx) {
        container.appendChild(document.createTextNode(value.slice(lastIdx, m.index)));
      }
      const quoteSpan = document.createElement('span');
      quoteSpan.className = 'inline-quote';
      quoteSpan.textContent = m[0];
      container.appendChild(quoteSpan);
      lastIdx = m.index + m[0].length;
    }
    if (!matched) {
      container.appendChild(document.createTextNode(value));
      return;
    }
    if (lastIdx < value.length) {
      container.appendChild(document.createTextNode(value.slice(lastIdx)));
    }
  };

  const showSubtitle = (text: string, isMock: boolean): void => {
    if (subtitleEl) {
      const display = isMock ? `[MOCK] ${text}` : text;
      subtitleEl.textContent = '';
      appendQuotedText(subtitleEl, display);
      subtitleEl.style.visibility = 'visible';
      subtitleEl.classList.add('visible');
      subtitleEl.classList.toggle('mock', isMock);
      subtitleEl.classList.remove('error');
      subtitleEl.classList.add('speaking');
    }
    showStatus('speaking', '正在说话');
    (window as any).__composerSubtitle = text;
  };

  /**
   * Phase 5.1 修复（P0-D）：重新生成语音。
   */
  const regenerateAudioForTask = async (taskId: string): Promise<void> => {
    showStatus('thinking', '重新生成语音...');
    try {
      const result = await window.chatx2.audioRegenerate(taskId);
      if (!result.success) {
        console.warn(`[composer] regenerate failed for taskId=${taskId}: ${result.audioError}`);
        showStatus('error', '重新生成失败');
        return;
      }
      // 成功：主进程会 emit message-updated 事件，由 onConversationEvent 处理重新播放。
    } catch (e) {
      console.error('[composer] audioRegenerate threw:', e);
      showStatus('error', '重新生成失败');
    }
  };

  /**
   * Phase 5.1 修复（P0-A/B/C）：处理 assistant 消息。
   */
  let currentPlaybackTaskId: string | null = null;

  const handleAssistantMessage = async (message: ConversationMessage, taskId?: string): Promise<void> => {
    if (!taskId) {
      console.warn('[composer] message-added without taskId, cannot process audio');
      return;
    }

    // P0-1：audioReady=false 时分两种情况：
    //   - 有 audioError（明确失败）：显示正文 + 错误 + 重新生成按钮
    //   - 无 audioError（正在合成中）：显示"正在合成语音..."状态，等待 message-updated
    if (!message.audioReady) {
      // 停止旧播放
      if (currentPlaybackTaskId) {
        try { await window.chatx2.audioStop(currentPlaybackTaskId); } catch { /* ignore */ }
        currentPlaybackTaskId = null;
      }
      (window as any).__composerSpeaking = false;
      hideSubtitle();
      if (message.audioError) {
        // 明确失败：显示错误 + 重新生成按钮
        showTextWithAudioError(message, taskId, message.audioError);
      } else {
        // 正在合成中：显示"正在合成语音..."状态（等待 message-updated 事件）
        showStatus('thinking', '正在合成语音...');
      }
      return;
    }

    // audioReady=true：新消息到达，打断旧播放
    if (currentPlaybackTaskId && currentPlaybackTaskId !== taskId) {
      try { await window.chatx2.audioStop(currentPlaybackTaskId); } catch { /* ignore */ }
      currentPlaybackTaskId = null;
    }
    (window as any).__composerSpeaking = false;
    hideSubtitle();
    showStatus('thinking', '准备播放...');

    // P0-A/B/C：调用 audioPlay(taskId) 请求 Avatar 开始播放
    currentPlaybackTaskId = taskId;
    try {
      await window.chatx2.audioPlay(taskId);
    } catch (e) {
      console.error('[composer] audioPlay failed:', e);
      currentPlaybackTaskId = null;
      showTextWithAudioError(message, taskId, '播放请求失败');
    }
  };

  // Phase 5.1 修复（P0-C）：订阅 performance:started
  // 桌宠窗口打开前已经存在的历史/挂起消息不得重新进入语音流程；
  // 只有本次窗口启动后产生的角色回复才允许显示合成并播放。
  const composerSessionStartedAt = Date.now();
  const composerSessionTaskIds = new Set<string>();
  window.chatx2.onPerformanceStarted((taskId: string, _audioStartTime?: number) => {
    if (currentPlaybackTaskId !== taskId) {
      return;
    }
    const poseLockButton = document.getElementById('btn-avatar-pose-lock') as HTMLButtonElement | null;
    if (poseLockButton) {
      poseLockButton.disabled = true;
      poseLockButton.title = '语音播放期间不能切换姿势锁定';
      poseLockButton.style.opacity = '0.45';
      poseLockButton.style.cursor = 'not-allowed';
    }
    // 从历史中查找 assistant 消息文本
    void window.chatx2.conversationHistory().then(history => {
      const msg = history.messages.find(m => m.taskId === taskId && m.role === 'assistant');
      if (msg) {
        showSubtitle(msg.text, msg.isMock);
        (window as any).__composerSpeaking = true;
      } else {
        (window as any).__composerSpeaking = true;
        showStatus('speaking', '正在说话');
      }
    }).catch(e => {
      console.warn('[composer] conversationHistory on performance:started failed:', e);
      (window as any).__composerSpeaking = true;
      showStatus('speaking', '正在说话');
    });
  });

  // Phase 5.1 修复（P0-C + P1-E）：订阅 performance:ended
  window.chatx2.onPerformanceEnded((taskId: string, reason: PerformanceEndReason) => {
    if (currentPlaybackTaskId === taskId || taskId === '') {
      currentPlaybackTaskId = null;
      (window as any).__composerSpeaking = false;
      const poseLockButton = document.getElementById('btn-avatar-pose-lock') as HTMLButtonElement | null;
      if (poseLockButton) {
        poseLockButton.disabled = false;
        poseLockButton.title = '锁定当前身体姿势；口型、表情、视线、呼吸和眨眼继续';
        poseLockButton.style.opacity = '1';
        poseLockButton.style.cursor = 'pointer';
      }
      if (subtitleEl) {
        subtitleEl.classList.remove('speaking');
      }
      if (reason === 'failed') {
        void window.chatx2.conversationHistory().then(history => {
          const msg = taskId
            ? history.messages.find(m => m.taskId === taskId && m.role === 'assistant')
            : history.messages.find(m => m.role === 'assistant' && m.audioReady);
          if (msg && msg.taskId) {
            showTextWithAudioError(msg, msg.taskId, '音频播放失败');
          } else {
            hideSubtitle();
            showStatus('idle', '');
          }
        }).catch(() => {
          hideSubtitle();
          showStatus('idle', '');
        });
      } else {
        // ended / interrupted：正常隐藏字幕
        hideSubtitle();
        showStatus('idle', '');
      }
    }
  });

  // 订阅对话事件
  window.chatx2.onConversationEvent((event: ConversationEvent) => {
    if (event.type === 'task-started') {
      showStatus('thinking', '正在思考...');
    } else if (event.type === 'task-failed') {
      // Adapter/网络/TTS 失败时没有 assistant audio 事件可供收尾；
      // 如果不在这里清理，桌宠会永久停留在“正在思考”。
      if (!currentPlaybackTaskId) {
        showStatus('error', event.reason ? `回复失败：${event.reason}` : '回复失败，请重试');
      }
    } else if (event.type === 'task-completed') {
      // 状态由 assistant message-added/message-updated 或 performance 事件更新
    } else if (event.type === 'message-added' && event.message && event.message.role === 'assistant') {
      // 忽略打开桌宠前已经存在的消息，避免历史任务在进入窗口时显示“合成中”。
      if (!event.taskId || Number(event.message.timestamp || 0) < composerSessionStartedAt) return;
      if (event.taskId) composerSessionTaskIds.add(event.taskId);
      void handleAssistantMessage(event.message, event.taskId);
    } else if (event.type === 'message-updated' && event.message && event.message.role === 'assistant') {
      if (!event.taskId || !composerSessionTaskIds.has(event.taskId)) return;
      if (event.message.audioReady && event.taskId) {
        void handleAssistantMessage(event.message, event.taskId);
      } else if (!event.message.audioReady && event.taskId) {
        void handleAssistantMessage(event.message, event.taskId);
      }
    }
  });

  // Phase 4: 只提交纯文本，主进程按 sender 派生 source='desktop'
  const send = async (): Promise<void> => {
    const text = inputEl.value.trim();
    if (!text) return;

    try {
      const result = await window.chatx2.conversationSubmit(text);
      if (result.accepted) {
        inputEl.value = '';
        showStatus('thinking', '正在思考...');
      } else {
        const reasonText = result.reason === 'busy' ? '正在处理中' : '消息为空';
        console.warn('[composer] submit rejected:', reasonText);
        inputEl.style.borderColor = '#ff6b6b';
        setTimeout(() => {
          inputEl.style.borderColor = '';
        }, 500);
      }
    } catch (e) {
      console.error('[composer] submit failed:', e);
      inputEl.style.borderColor = '#ff6b6b';
      setTimeout(() => {
        inputEl.style.borderColor = '';
      }, 500);
    }
  };

  sendBtn.addEventListener('click', () => { void send(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void send();
  });

  const micBtn = document.getElementById('mic-btn') as HTMLButtonElement | null;
  if (micBtn) {
    const voiceInput = bindVoiceInput({
      button: micBtn,
      input: inputEl,
      transcribe: (audio, mimeType) => window.chatx2.transcribeVoiceInput(audio, mimeType),
      onError: message => showStatus('error', `语音输入失败：${message}`),
    });
    window.addEventListener('beforeunload', () => voiceInput.dispose(), { once: true });
  }

  // 自动聚焦输入框
  inputEl.focus();
}

initComposerRenderer();
