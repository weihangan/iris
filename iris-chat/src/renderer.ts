// ChatX2 renderer 入口（Chat 窗口）
// Phase 4：通过 IPC 调用唯一 ConversationController，禁止自己实现聊天业务
// - 提交时传 source='chat'
// - 订阅 conversation:event 实时更新历史
// - Mock 回复醒目标注 MOCK（不能冒充真实 Chat5）
// - 启动时先订阅事件再加载历史快照，避免初始化竞态

import { startConversationHistorySync } from './conversation/history-sync';
import { bindVoiceInput } from './voice-input-controller';
import type { ModelPackListItem, SwitchModelResult, ModelPackMotions, ModelPackPhysics } from './model-pack/model-pack-types';
import { BUILD_ID } from './build-identity';
import type { DailyPerformanceCandidate } from './performance/daily-candidate-types';

document.documentElement.dataset.buildId = BUILD_ID;
(window as any).__CHATX2_BUILD_ID__ = BUILD_ID;

export type AppMode = 'chat' | 'loading' | 'desktop' | 'scene';

export interface ChatX2Identity {
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

export interface TransitionResult {
  status: 'ok' | 'failure' | 'unavailable';
  reason?: string;
  mode: AppMode;
}

export interface ModeChangeEvent {
  from: AppMode;
  to: AppMode;
  reason?: string;
}

// Phase 4: 对话类型（与 chat-preload 声明同构）
export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationSource = 'chat' | 'desktop' | 'controller';
export type ConversationTaskStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
export type ConversationEventType =
  | 'message-added'
  | 'message-updated'
  | 'task-started'
  | 'task-completed'
  | 'task-cancelled'
  | 'task-failed';

export interface ConversationMessage {
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

export interface AudioRegenerateResult {
  success: boolean;
  taskId: string;
  audioReady: boolean;
  audioError?: string;
}
export interface ConversationSubmitResult {
  accepted: boolean;
  taskId?: string;
  reason?: 'busy' | 'empty-text';
  userMessage?: ConversationMessage;
}
export interface ConversationTask {
  taskId: string;
  status: ConversationTaskStatus;
  userMessageId: string;
  source: 'chat' | 'desktop';
  inputText: string;
  startedAt: number;
  finishedAt?: number;
}
export interface ConversationHistory {
  messages: readonly ConversationMessage[];
  activeTask: ConversationTask | null;
}
export interface ConversationEvent {
  type: ConversationEventType;
  message?: ConversationMessage;
  taskId?: string;
  reason?: string;
}

// Chat 窗口的 chat6 API（来自 chat-preload）
// 注意：signalAvatarReady 只在 Avatar 窗口可用，这里不声明
// 以下声明必须与 composer-renderer.ts 的 window.chatx2 声明保持类型一致
// （否则 TS2717: Subsequent property declarations must have the same type）
// Phase 5.1 修复（P0-A/B/C）：Chat preload 不暴露音频播放相关方法（音频播放完全由 Avatar 负责）。
// Chat 不调用 audioPlay/audioStop/onPerformanceStarted/onPerformanceEnded，但类型声明需保留以保持 TS 合并兼容。
// Chat 只调用 audioRegenerate（用户点击"重新生成语音"按钮时）。
type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';

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
      // Phase 5.1 修复（P0-A/B/C）：新音频 IPC。
      // Chat preload 不暴露 audioPlay/audioStop/onPerformanceStarted/onPerformanceEnded，
      // 但类型声明需保留以保持 TS2717 兼容。Chat renderer 不会调用这些方法。
      audioPlay: (taskId: string) => Promise<void>;
      audioStop: (taskId: string) => Promise<void>;
      onPerformanceStarted: (cb: (taskId: string, audioStartTime?: number) => void) => (() => void);
      onPerformanceEnded: (cb: (taskId: string, reason: PerformanceEndReason) => void) => (() => void);
      // Phase 5.1 修复（P0-1/P0-D）：重新生成语音（主进程用 VoiceAdapter，不重新调用 ChatAdapter）
      audioRegenerate: (taskId: string) => Promise<AudioRegenerateResult>;
      // Phase 5.2 修正（2026-07-19）：motion IPC（语义级输入，与 composer-renderer 同构）
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
      toggleIdlePaused: () => Promise<{ success: boolean; paused: boolean }>;
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
      // 桌宠窗口控制
      setModelPassThrough: (manual: boolean) => Promise<void>;
      setModelScale: (delta: number) => Promise<{ success: boolean }>;
      setCameraView: (mode: 'full' | 'half') => Promise<{ success: boolean }>;
      setModelRotation: (yaw: number, pitch: number) => Promise<{ success: boolean; yaw?: number; pitch?: number }>;
      exitDesktop: () => Promise<{ success: boolean }>;
      toggleAlwaysOnTop: (onTop: boolean) => Promise<{ success: boolean }>;
      transitionToChat: () => Promise<{ success: boolean }>;
      onModelPassThroughChanged: (cb: (payload: { manual: boolean }) => void) => (() => void);
    };
  }
}

/**
 * Phase 5.1 修复（P0-1/P0-D）：重新生成语音。
 * Chat renderer 在用户点击"重新生成语音"按钮时调用。
 * 主进程用 VoiceAdapter.synthesize(assistantText) 生成 WAV，不调用 ChatAdapter.submit(userText)，
 * 避免重新请求聊天 API / 触发记忆 RAG / 生成不同回复。
 * 成功后 emit message-updated 事件。
 */
function regenerateAudioForTask(taskId: string): void {
  void window.chatx2.audioRegenerate(taskId).then(result => {
    if (!result.success) {
      console.warn(`[chat6] regenerate failed for taskId=${taskId}: ${result.audioError}`);
    }
    // 成功时主进程会 emit message-updated 事件，由 onConversationEvent 处理 DOM 更新。
  }).catch(e => {
    console.error('[chat6] audioRegenerate threw:', e);
  });
}

/**
 * 填充消息元素内容（不创建新元素，用于 renderMessage 和 updateMessageDisplay 共用）。
 * Phase 5.1 修复（P0-1）：assistant 消息 audioReady=false 时显示正文 + 音频错误 + 重新生成按钮。
 */
function populateMessageContent(el: HTMLElement, msg: ConversationMessage): void {
  el.textContent = '';
  el.classList.remove('mock', 'audio-error');

  if (msg.role === 'system') {
    el.textContent = `[系统] ${msg.text}`;
    return;
  }

  // Mock 醒目标注
  if (msg.isMock && msg.role === 'assistant') {
    el.classList.add('mock');
  }

  // 文本节点
  const prefix = msg.isMock && msg.role === 'assistant' ? '[MOCK] ' : '';
  const textNode = document.createTextNode(`${prefix}${msg.text}`);
  el.appendChild(textNode);

  // Phase 5.1 修复（P0-1）：assistant 消息 audioReady=false 时显示音频错误 + 重新生成按钮。
  // 项目硬规则：TTS 失败时必须保留并显示文字，但禁止音频、口型和说话动作。
  if (msg.role === 'assistant' && !msg.audioReady) {
    el.classList.add('audio-error');
    const errorSpan = document.createElement('span');
    errorSpan.className = 'audio-error-tag';
    errorSpan.style.cssText = 'color:#ff6b6b;margin-left:6px;font-size:11px;';
    errorSpan.textContent = `[音频未就绪：${msg.audioError || '未知原因'}]`;
    el.appendChild(errorSpan);

    if (msg.taskId) {
      const regenBtn = document.createElement('button');
      regenBtn.textContent = '重新生成语音';
      regenBtn.className = 'regen-audio-btn';
      regenBtn.style.cssText = 'margin-left:6px;padding:2px 8px;font-size:11px;background:#07c160;color:#fff;border:none;border-radius:3px;cursor:pointer;';
      regenBtn.setAttribute('data-regen-task-id', msg.taskId);
      regenBtn.addEventListener('click', () => regenerateAudioForTask(msg.taskId!));
      el.appendChild(regenBtn);
    }
  }
}

/**
 * 渲染单条消息到 DOM
 * - Mock 消息醒目标注 MOCK（黄色背景 + 前缀）
 * - 系统消息用灰色
 * - 用户消息用绿色
 * - Phase 5.1 修复（P0-1）：assistant 消息 audioReady=false 时显示正文 + 音频错误 + 重新生成按钮
 */
function renderMessage(messagesEl: HTMLElement, msg: ConversationMessage): void {
  // 避免重复渲染（按 id 去重）
  if (messagesEl.querySelector(`[data-msg-id="${msg.id}"]`)) {
    return;
  }

  const el = document.createElement('div');
  el.className = `msg ${msg.role}`;
  el.setAttribute('data-msg-id', msg.id);
  populateMessageContent(el, msg);

  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Phase 5.1 修复（P0-1）：更新已渲染消息的显示内容（用于 message-updated 事件）。
 * 重新生成语音成功后，主进程 emit message-updated 事件，此函数更新 DOM 元素内容。
 */
function updateMessageDisplay(messagesEl: HTMLElement, msg: ConversationMessage): void {
  const existing = messagesEl.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
  if (!existing) {
    // 消息不在 DOM 中（可能是快照前的事件），按新消息渲染。
    renderMessage(messagesEl, msg);
    return;
  }
  populateMessageContent(existing, msg);
}

/**
 * 全量重渲染历史（用于启动时加载或大差异同步）
 */
function renderAllHistory(messagesEl: HTMLElement, history: ConversationHistory): void {
  // 清除占位符和旧消息
  messagesEl.innerHTML = '';
  for (const msg of history.messages) {
    renderMessage(messagesEl, msg);
  }
}

async function init(): Promise<void> {
  const identityEl = document.getElementById('identity');
  const inputEl = document.getElementById('input') as HTMLInputElement | null;
  const sendBtn = document.getElementById('send') as HTMLButtonElement | null;
  const transitionSpeedEl = document.getElementById('transition-speed') as HTMLInputElement | null;
  const transitionSpeedValueEl = document.getElementById('transition-speed-value') as HTMLOutputElement | null;
  const messagesEl = document.getElementById('messages');
  const mockBadgeEl = document.getElementById('mock-badge');

  if (!identityEl || !inputEl || !sendBtn || !messagesEl) {
    console.error('ChatX2: required DOM elements missing');
    return;
  }

  // 先订阅事件，再异步加载快照；快照期间的新消息会缓冲并在快照后重放。
  const historySync = startConversationHistorySync({
    loadHistory: () => window.chatx2.conversationHistory(),
    subscribe: listener => window.chatx2.onConversationEvent(listener),
    applyHistory: history => renderAllHistory(messagesEl, history),
    applyMessage: message => renderMessage(messagesEl, message),
    onError: error => console.error('[chat6] load history failed:', error)
  });
  window.addEventListener('beforeunload', () => historySync.dispose(), { once: true });

  // Phase 5.1 修复（P0-1）：订阅 message-updated 事件，用于重新生成语音后更新 DOM。
  // history-sync 只处理 message-added，message-updated 需要单独订阅。
  const unsubscribeMessageUpdated = window.chatx2.onConversationEvent(event => {
    if (event.type === 'message-updated' && event.message) {
      updateMessageDisplay(messagesEl, event.message);
    }
  });
  window.addEventListener('beforeunload', () => unsubscribeMessageUpdated(), { once: true });

  // 显示身份信息
  let isMock = false;
  try {
    const identity = await window.chatx2.getIdentity();
    identityEl.textContent = `${identity.appId} · v${identity.version} · BUILD ${identity.buildId} · port ${identity.expressPort}`;
    document.title = `${identity.productName} v${identity.version}`;
    isMock = identity.conversationIsMock;
    // Mock 醒目标注：显示 MOCK 徽章
    if (mockBadgeEl) {
      if (isMock) {
        mockBadgeEl.style.display = 'inline-block';
        mockBadgeEl.textContent = 'MOCK 对话后端';
      } else {
        mockBadgeEl.style.display = 'none';
      }
    }
  } catch (e) {
    identityEl.textContent = '身份获取失败';
    console.error(e);
  }

  await historySync.ready;

  const renderTransitionSpeed = (value: number): void => {
    const label = value < 0.85 ? '慢' : value > 1.25 ? '快' : '标准';
    if (transitionSpeedEl) transitionSpeedEl.value = String(value);
    if (transitionSpeedValueEl) transitionSpeedValueEl.value = label;
  };
  if (transitionSpeedEl) {
    try {
      const { value } = await window.chatx2.getTransitionSpeed();
      renderTransitionSpeed(value);
    } catch (error) {
      console.warn('[chatx2] transition speed unavailable:', error);
    }
    transitionSpeedEl.addEventListener('input', () => {
      const value = Number(transitionSpeedEl.value);
      renderTransitionSpeed(value);
      void window.chatx2.setTransitionSpeed(value).then(result => {
        if (!result.success) console.warn('[chatx2] transition speed rejected:', result.reason);
      }).catch(error => console.warn('[chatx2] transition speed update failed:', error));
    });
  }

  // Phase 4: 只提交纯文本，主进程按 sender 派生 source='chat'
  const send = async (): Promise<void> => {
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';

    try {
      const result = await window.chatx2.conversationSubmit(text);
      if (!result.accepted) {
        // 拒绝原因提示
        const reasonText = result.reason === 'busy' ? '正在处理中，请稍候' : '消息为空';
        const tip = document.createElement('div');
        tip.className = 'msg system';
        tip.textContent = `[系统] ${reasonText}`;
        messagesEl.appendChild(tip);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      // 成功时 user 消息会通过 conversation:event 的 message-added 事件渲染
      // 不在这里手动渲染，避免重复
    } catch (e) {
      console.error('[chat6] submit failed:', e);
      const errMsg = document.createElement('div');
      errMsg.className = 'msg system';
      errMsg.textContent = '[系统] 提交失败';
      messagesEl.appendChild(errMsg);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  sendBtn.addEventListener('click', () => { void send(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void send();
  });

  const voiceInputBtn = document.getElementById('voice-input-btn') as HTMLButtonElement | null;
  if (voiceInputBtn) {
    const voiceInput = bindVoiceInput({
      button: voiceInputBtn,
      input: inputEl,
      transcribe: (audio, mimeType) => window.chatx2.transcribeVoiceInput(audio, mimeType),
      onError: message => {
        const errMsg = document.createElement('div');
        errMsg.className = 'msg system';
        errMsg.textContent = `[语音输入] ${message}`;
        messagesEl.appendChild(errMsg);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
    });
    window.addEventListener('beforeunload', () => voiceInput.dispose(), { once: true });
  }

  // Phase 3 收口修复：选择模型按钮
  const selectModelBtn = document.getElementById('select-model-btn') as HTMLButtonElement | null;
  if (selectModelBtn) {
    selectModelBtn.addEventListener('click', async () => {
      selectModelBtn.disabled = true;
      try {
        const result = await window.chatx2.selectPmxModel();
        const msg = document.createElement('div');
        msg.className = 'msg assistant';
        if (result.success) {
          msg.textContent = `[模型已切换] ${result.modelPath}`;
          console.log('[chat6] model switched:', result.modelPath, result.sha256);
        } else {
          const reasonText: Record<string, string> = {
            'cancelled': '已取消',
            'hash-mismatch': '哈希不匹配，模型未切换',
            'invalid-extension': '仅支持 .pmx 文件',
            'import-failed': '模型导入失败，请检查文件夹权限和模型文件完整性'
          };
          msg.textContent = `[选择模型失败] ${reasonText[result.reason ?? ''] ?? result.reason}`;
        }
        messagesEl.appendChild(msg);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (e) {
        console.error('[chat6] selectPmxModel failed:', e);
      } finally {
        selectModelBtn.disabled = false;
      }
    });
  }

  // Phase 5.2：模型管理面板
  initModelManager();
}

/**
 * 模型管理面板初始化（Phase 5.2）
 * - 切换面板显示
 * - 模型下拉填充 + 当前模型信息
 * - 动作管理（idle/gesture/customVmd）
 * - 模型开关（隐藏/恢复桌宠窗）
 * - 历史语音开关（localStorage 持久化）
 * - 订阅 onModelPackChanged 自动刷新
 * 所有 window.chatx2 调用均用 try/catch 包裹，避免 API 不可用时崩溃。
 */
function initModelManager(): void {
  const panel = document.getElementById('model-panel');
  const managerBtn = document.getElementById('model-manager-btn');
  const closeBtn = document.getElementById('close-panel-btn');
  const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
  const currentModelInfo = document.getElementById('current-model-info');
  const idlePacksList = document.getElementById('idle-packs-list');
  const gesturePacksList = document.getElementById('gesture-packs-list');
  const customVmdList = document.getElementById('custom-vmd-list');
  const motionCandidateList = document.getElementById('motion-candidate-list');
  const expressionCandidateList = document.getElementById('expression-candidate-list');
  const externalVmdCandidateList = document.getElementById('external-vmd-candidate-list');
  const externalVmdCount = document.getElementById('external-vmd-count');
  const importVmdBtn = document.getElementById('import-vmd-btn') as HTMLButtonElement | null;
  const modelEnabledToggle = document.getElementById('model-enabled-toggle') as HTMLInputElement | null;
  const voiceHistoryToggle = document.getElementById('voice-history-toggle') as HTMLInputElement | null;

  if (!panel || !managerBtn || !closeBtn || !modelSelect || !currentModelInfo
      || !idlePacksList || !gesturePacksList || !customVmdList
      || !motionCandidateList || !expressionCandidateList || !externalVmdCandidateList
      || !importVmdBtn || !modelEnabledToggle || !voiceHistoryToggle) {
    console.error('[chatx2] model manager: required DOM elements missing');
    return;
  }
  const motionCandidateContainer = motionCandidateList;
  const expressionCandidateContainer = expressionCandidateList;
  const externalVmdCandidateContainer = externalVmdCandidateList;

  // 切换面板显示 / 关闭面板
  managerBtn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

  // 刷新模型下拉 + 当前模型信息
  const refreshModelList = async (): Promise<void> => {
    try {
      const packs = await window.chatx2.listModelPacks();
      modelSelect.innerHTML = '';
      if (packs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（无可用模型）';
        opt.disabled = true;
        opt.selected = true;
        modelSelect.appendChild(opt);
      } else {
        for (const pack of packs) {
          const opt = document.createElement('option');
          opt.value = pack.packId;
          opt.textContent = `${pack.displayName}${pack.isBuiltIn ? '（内置）' : ''}`;
          modelSelect.appendChild(opt);
        }
      }
    } catch (e) {
      console.error('[chatx2] listModelPacks failed:', e);
      modelSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（加载失败）';
      opt.disabled = true;
      opt.selected = true;
      modelSelect.appendChild(opt);
    }

    try {
      const current = await window.chatx2.getCurrentModelPack();
      if (current.success && current.packId) {
        modelSelect.value = current.packId;
        const capText = current.capabilities && current.capabilities.length > 0
          ? current.capabilities.join(', ')
          : '（无）';
        currentModelInfo.textContent =
          `ID：${current.packId}\n名称：${current.displayName ?? '未知'}\n内部名：${current.internalName ?? '未知'}\n能力：${capText}`;
      } else {
        currentModelInfo.textContent = '未选择模型';
      }
    } catch (e) {
      console.error('[chatx2] getCurrentModelPack failed:', e);
      currentModelInfo.textContent = '当前模型获取失败';
    }
  };

  // VMD 列表缓存，供语音动作池编辑器使用
  type VmdItem = { path: string; displayName: string; duration: number; category: 'short' | 'medium' | 'long' };
  let vmdItems: VmdItem[] = [];

  // 情绪中文名映射（动作库 + 语音动作池共用）
  const emotionNames: Record<string, string> = {
    neutral: '中性/平淡',
    happy: '开心/高兴',
    smile: '微笑',
    angry: '生气/愤怒',
    sad: '悲伤/难过',
    concerned: '担忧/关心',
    surprised: '惊讶',
    thinking: '思考',
    curious: '好奇',
    shy: '害羞',
    serious: '严肃/认真',
    excited: '兴奋',
    loving: '喜欢/爱慕',
    grateful: '感激',
    greeting: '问候/招呼',
    graceful: '优雅',
    negative: '消极/否定',
    welcoming: '欢迎',
    explaining: '解释/说明',
    affirmative: '肯定/赞同',
    cute: '可爱/调皮',
    playful: '调皮/戏谑',
    exhausted: '精疲力竭',
    embarrassed: '尴尬',
    helpless: '无助',
    guilty: '内疚/自责',
    determined: '坚定/决心',
    pretend_angry: '假装生气',
    confident: '自信',
    energetic: '精神饱满',
    exaggerated: '夸张'
  };
  const allEmotions = Object.keys(emotionNames);

  // 语音动作元信息编辑器弹窗（动作库 + 语音动作池共用）
  const showVoiceActionEditor = (item: VmdItem, existing: {
    vmdPath: string;
    displayName: string;
    type: string;
    gestureFamily: string;
    intent: string;
    emotions: string[];
    description: string;
    dialogueSafe?: boolean;
  } | undefined, onDone: () => void): void => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:16px;min-width:320px;max-width:90vw;max-height:90vh;overflow:auto;color:#eee;font-size:13px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:bold;margin-bottom:12px;';
    title.textContent = existing ? `编辑语音动作：${item.displayName}` : `加入语音动作池：${item.displayName}`;
    box.appendChild(title);

    // displayName
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'margin-bottom:10px;';
    nameRow.innerHTML = '<div style="margin-bottom:4px;color:#aaa;">显示名称</div>';
    const nameInput = document.createElement('input');
    nameInput.value = existing?.displayName ?? item.displayName;
    nameInput.style.cssText = 'width:100%;background:#2a2a3e;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:4px 8px;color:#eee;box-sizing:border-box;';
    nameRow.appendChild(nameInput);
    box.appendChild(nameRow);

    // gestureFamily
    const gfRow = document.createElement('div');
    gfRow.style.cssText = 'margin-bottom:10px;';
    gfRow.innerHTML = '<div style="margin-bottom:4px;color:#aaa;">动作族 (gestureFamily)</div>';
    const gfInput = document.createElement('input');
    gfInput.value = existing?.gestureFamily ?? 'general';
    gfInput.style.cssText = nameInput.style.cssText;
    gfRow.appendChild(gfInput);
    box.appendChild(gfRow);

    // intent
    const intentRow = document.createElement('div');
    intentRow.style.cssText = 'margin-bottom:10px;';
    intentRow.innerHTML = '<div style="margin-bottom:4px;color:#aaa;">意图 (intent)</div>';
    const intentInput = document.createElement('input');
    intentInput.value = existing?.intent ?? 'speak';
    intentInput.style.cssText = nameInput.style.cssText;
    intentRow.appendChild(intentInput);
    box.appendChild(intentRow);

    // 情绪多选
    const emoRow = document.createElement('div');
    emoRow.style.cssText = 'margin-bottom:10px;';
    emoRow.innerHTML = '<div style="margin-bottom:6px;color:#aaa;">匹配情绪（可多选）</div>';
    const emoGrid = document.createElement('div');
    emoGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    const selected = new Set(existing?.emotions ?? []);
    for (const emo of allEmotions) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;background:#2a2a3e;padding:3px 6px;border-radius:4px;cursor:pointer;font-size:12px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = emo;
      cb.checked = selected.has(emo);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(emo); else selected.delete(emo);
      });
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = emotionNames[emo] ?? emo;
      label.appendChild(span);
      emoGrid.appendChild(label);
    }
    emoRow.appendChild(emoGrid);
    box.appendChild(emoRow);

    // description
    const descRow = document.createElement('div');
    descRow.style.cssText = 'margin-bottom:10px;';
    descRow.innerHTML = '<div style="margin-bottom:4px;color:#aaa;">描述</div>';
    const descInput = document.createElement('input');
    descInput.value = existing?.description ?? '';
    descInput.placeholder = '可选：描述该动作的使用场合';
    descInput.style.cssText = nameInput.style.cssText;
    descRow.appendChild(descInput);
    box.appendChild(descRow);

    // dialogueSafe
    const safeRow = document.createElement('div');
    safeRow.style.cssText = 'margin-bottom:14px;display:flex;align-items:center;gap:6px;';
    const safeCb = document.createElement('input');
    safeCb.type = 'checkbox';
    safeCb.checked = existing?.dialogueSafe ?? true;
    safeCb.id = 'va-dialogue-safe';
    const safeLabel = document.createElement('label');
    safeLabel.htmlFor = 'va-dialogue-safe';
    safeLabel.textContent = '对话安全（dialogueSafe）：语音 Planner 可以自动选用';
    safeLabel.style.cursor = 'pointer';
    safeRow.appendChild(safeCb);
    safeRow.appendChild(safeLabel);
    box.appendChild(safeRow);

    // 按钮
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:4px 12px;background:#3a3a4e;border:none;border-radius:4px;color:#eee;cursor:pointer;';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = document.createElement('button');
    saveBtn.textContent = existing ? '保存' : '加入';
    saveBtn.style.cssText = 'padding:4px 12px;background:#4a6a4a;border:none;border-radius:4px;color:#eee;cursor:pointer;';
    saveBtn.addEventListener('click', async () => {
      const emotions = Array.from(selected).sort();
      if (emotions.length === 0) {
        alert('请至少选择一个情绪');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
      try {
        if (existing) {
          const result = await window.chatx2.updateVoiceAction(item.path, {
            displayName: nameInput.value.trim() || item.displayName,
            gestureFamily: gfInput.value.trim() || 'general',
            intent: intentInput.value.trim() || 'speak',
            emotions,
            description: descInput.value.trim(),
            dialogueSafe: safeCb.checked
          });
          if (!result.success) throw new Error('语音动作修改未写入用户配置');
        } else {
          const result = await window.chatx2.addVoiceAction({
            vmdPath: item.path,
            displayName: nameInput.value.trim() || item.displayName,
            type: 'voice',
            gestureFamily: gfInput.value.trim() || 'general',
            intent: intentInput.value.trim() || 'speak',
            emotions,
            description: descInput.value.trim(),
            dialogueSafe: safeCb.checked
          });
          if (!result.success) throw new Error('语音动作未加入用户配置');
        }
        overlay.remove();
        onDone();
      } catch (err) {
        console.error('[chatx2] save voice action failed:', err);
        alert('保存失败');
        saveBtn.disabled = false;
        saveBtn.textContent = existing ? '保存' : '加入';
      }
    });
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    nameInput.focus();
  };

  // 刷新动作列表（idle/gesture/customVmd）
  const refreshMotionPacks = async (): Promise<void> => {
    // 保存面板滚动位置，避免 DOM 重建后跳回顶端
    const panelScrollTop = panel.scrollTop;
    // 保存三个内部滚动容器的位置
    const shortScroll = (document.querySelector('#vmd-category-short .vmd-category-scroll') as HTMLElement)?.scrollTop ?? 0;
    const mediumScroll = (document.querySelector('#vmd-category-medium .vmd-category-scroll') as HTMLElement)?.scrollTop ?? 0;
    const longScroll = (document.querySelector('#vmd-category-long .vmd-category-scroll') as HTMLElement)?.scrollTop ?? 0;
    let idlePacks: string[] = [];
    let gesturePacks: string[] = [];
    let customVmd: string[] = [];
    let defaultIdle: string | undefined;
    try {
      const result = await window.chatx2.listMotionPacks();
      if (result.success) {
        idlePacks = result.idlePacks ?? [];
        gesturePacks = result.gesturePacks ?? [];
        customVmd = result.customVmd ?? [];
        defaultIdle = result.defaultIdle;
      }
    } catch (e) {
      console.error('[chatx2] listMotionPacks failed:', e);
    }

    // 待机动作：复选框 + 单选（设为默认）
    idlePacksList.innerHTML = '';
    if (idlePacks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vmd-empty';
      empty.textContent = '（无待机动作）';
      idlePacksList.appendChild(empty);
    } else {
      for (const id of idlePacks) {
        const row = document.createElement('div');
        row.className = 'pack-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true; // listMotionPacks 返回的是已启用列表
        cb.dataset.packId = id;
        cb.addEventListener('change', () => {
          try {
            void window.chatx2.toggleMotionPack(id, cb.checked, 'idle');
          } catch (e) {
            console.error('[chatx2] toggleMotionPack(idle) failed:', e);
          }
        });
        row.appendChild(cb);

        const label = document.createElement('label');
        label.textContent = id;
        row.appendChild(label);

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'default-idle';
        radio.value = id;
        radio.title = '设为默认待机';
        if (defaultIdle && defaultIdle === id) {
          radio.checked = true;
        }
        radio.addEventListener('change', () => {
          if (radio.checked) {
            try {
              void window.chatx2.setDefaultIdle(id);
            } catch (e) {
              console.error('[chatx2] setDefaultIdle failed:', e);
            }
          }
        });
        row.appendChild(radio);

        const defaultTag = document.createElement('span');
        defaultTag.className = 'default-tag';
        defaultTag.textContent = '设为默认';
        defaultTag.addEventListener('click', () => { radio.click(); });
        row.appendChild(defaultTag);

        idlePacksList.appendChild(row);
      }
    }

    // 手势动作：仅复选框
    gesturePacksList.innerHTML = '';
    if (gesturePacks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vmd-empty';
      empty.textContent = '（无手势动作）';
      gesturePacksList.appendChild(empty);
    } else {
      for (const id of gesturePacks) {
        const row = document.createElement('div');
        row.className = 'pack-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.packId = id;
        cb.addEventListener('change', () => {
          try {
            void window.chatx2.toggleMotionPack(id, cb.checked, 'gesture');
          } catch (e) {
            console.error('[chatx2] toggleMotionPack(gesture) failed:', e);
          }
        });
        row.appendChild(cb);

        const label = document.createElement('label');
        label.textContent = id;
        row.appendChild(label);

        gesturePacksList.appendChild(row);
      }
    }

    // 自定义 VMD 列表：三组分类（短/中/长）+ 各自滚动浏览
    const searchInput = document.getElementById('vmd-search') as HTMLInputElement | null;
    const countSpan = document.getElementById('vmd-count');
    const emptyHint = document.getElementById('vmd-empty-hint');
    const shortBlock = document.getElementById('vmd-category-short');
    const mediumBlock = document.getElementById('vmd-category-medium');
    const longBlock = document.getElementById('vmd-category-long');

    // 获取带分类信息的 VMD 列表
    let vmdDefaultIdle = '';
    let vmdIdlePool: string[] = [];
    try {
      const info = await window.chatx2.listVmdWithInfo();
      if (info.success) {
        vmdItems = info.items ?? [];
        vmdDefaultIdle = info.defaultIdle ?? '';
        vmdIdlePool = info.idleVmdPool ?? [];
      }
    } catch (e) {
      console.error('[chatx2] listVmdWithInfo failed:', e);
    }

    // 同时加载语音动作池，用于判断每个 VMD 是否已被加入
    let voiceActionEntries: Array<{ vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean }> = [];
    try {
      const vaResult = await window.chatx2.listVoiceActions();
      if (vaResult.success) voiceActionEntries = vaResult.entries ?? [];
    } catch (e) {
      console.error('[chatx2] listVoiceActions failed:', e);
    }
    const findVoiceAction = (vmdPath: string) => voiceActionEntries.find(e => e.vmdPath === vmdPath);

    if (countSpan) {
      countSpan.textContent = `(${vmdItems.length} 个动作)`;
    }

    // 渲染单个 VMD 条目
    const renderVmdItem = (item: VmdItem): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'vmd-item';
      const isDefault = item.path === vmdDefaultIdle;
      const idleSlot = vmdIdlePool.indexOf(item.path) + 1;
      const isLong = item.category === 'long';

      const name = document.createElement('span');
      name.className = 'vmd-name';
      const statusPrefix = [isDefault ? '默认' : '', idleSlot > 0 ? `★${idleSlot}` : '']
        .filter(Boolean)
        .join(' · ');
      name.textContent = `${statusPrefix ? `${statusPrefix} ` : ''}${item.displayName}`;
      if (isDefault || idleSlot > 0) name.style.color = '#f0c060';
      name.title = item.path;
      row.appendChild(name);

      if (item.duration > 0) {
        const dur = document.createElement('span');
        dur.className = 'vmd-duration';
        dur.textContent = item.duration.toFixed(1) + 's';
        row.appendChild(dur);
      }

      const btnGroup = document.createElement('span');
      btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      const playBtn = document.createElement('button');
      playBtn.className = 'vmd-play-btn';
      playBtn.textContent = '播放';
      playBtn.addEventListener('click', async () => {
        playBtn.textContent = '...';
        playBtn.disabled = true;
        try {
          if (isLong) {
            await window.chatx2.previewLongVmd(item.path);
          } else {
            await window.chatx2.previewCustomVmd(item.path);
          }
        } catch {}
        playBtn.textContent = '播放';
        playBtn.disabled = false;
      });
      btnGroup.appendChild(playBtn);

      const defaultBtn = document.createElement('button');
      defaultBtn.className = isDefault ? 'vmd-default-btn active' : 'vmd-default-btn';
      defaultBtn.textContent = isDefault ? '默认' : '设为默认';
      if (!isDefault) {
        defaultBtn.addEventListener('click', async () => {
          defaultBtn.textContent = '...';
          defaultBtn.disabled = true;
          try { await window.chatx2.setDefaultIdle(item.path); } catch {}
        });
      }
      btnGroup.appendChild(defaultBtn);

      // 加入待机按钮
      const inPool = vmdIdlePool.includes(item.path);
      const idlePoolFull = vmdIdlePool.length >= 4;
      const idleBtn = document.createElement('button');
      idleBtn.className = inPool ? 'vmd-default-btn active' : 'vmd-default-btn';
      idleBtn.textContent = inPool ? `★${idleSlot} 待机` : '加入待机';
      idleBtn.title = inPool ? `待机动作 ${idleSlot}，点击移除` : idlePoolFull ? '最多只能选择 4 个待机动作' : '加入待机轮换池';
      idleBtn.disabled = !inPool && idlePoolFull;
      idleBtn.addEventListener('click', async () => {
        idleBtn.textContent = '...';
        idleBtn.disabled = true;
        try {
          const newInPool = !vmdIdlePool.includes(item.path);
          const result = await window.chatx2.toggleIdleVmd(item.path, newInPool);
          if (!result.success) {
            if (result.reason === 'idle-pool-full') alert(`最多只能选择 ${result.maxSlots ?? 4} 个待机动作`);
            idleBtn.disabled = false;
          }
        } catch { idleBtn.disabled = false; }
      });
      btnGroup.appendChild(idleBtn);

      // 加入/编辑语音动作池按钮
      const existingVa = findVoiceAction(item.path);
      const voiceBtn = document.createElement('button');
      voiceBtn.className = existingVa ? 'vmd-default-btn active' : 'vmd-default-btn';
      voiceBtn.textContent = existingVa ? '语音中' : '加入语音';
      voiceBtn.title = existingVa ? '编辑匹配的情绪和元信息' : '加入语音动作池';
      voiceBtn.addEventListener('click', () => {
        showVoiceActionEditor(item, existingVa, () => {
          void refreshMotionPacks();
          void refreshVoiceActions();
        });
      });
      btnGroup.appendChild(voiceBtn);

      // 删除按钮
      const delBtn = document.createElement('button');
      delBtn.className = 'vmd-default-btn';
      delBtn.textContent = '删除';
      delBtn.title = '删除此 VMD 动作';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`确定要删除 "${item.displayName}" 吗？`)) return;
        delBtn.textContent = '...';
        delBtn.disabled = true;
        try {
          const result = await window.chatx2.removeLibraryVmd(item.path);
          if (!result.success) {
            alert(`删除失败：${result.reason ?? '动作未被动作库引用'}`);
            delBtn.disabled = false;
          }
        } catch (error) {
          console.error('[chatx2] removeLibraryVmd failed:', error);
          alert('删除失败，请查看日志');
          delBtn.disabled = false;
        }
      });
      btnGroup.appendChild(delBtn);

      row.appendChild(btnGroup);
      return row;
    };

    // 渲染一个分类到对应容器
    const renderCategory = (items: VmdItem[], block: HTMLElement | null) => {
      if (!block) return;
      const countEl = block.querySelector('.vmd-category-count');
      const scrollEl = block.querySelector('.vmd-category-scroll') as HTMLElement | null;
      if (countEl) countEl.textContent = `(${items.length})`;
      if (scrollEl) {
        scrollEl.innerHTML = '';
        for (const item of items) {
          scrollEl.appendChild(renderVmdItem(item));
        }
      }
      block.style.display = items.length > 0 ? 'block' : 'none';
    };

    // 搜索过滤 + 渲染三个分类
    const doSearch = () => {
      const term = searchInput?.value.toLowerCase().trim() ?? '';
      const filtered = term
        ? vmdItems.filter(it => it.displayName.toLowerCase().includes(term) || it.path.toLowerCase().includes(term))
        : vmdItems;

      if (emptyHint) emptyHint.style.display = 'none';

      if (filtered.length === 0) {
        if (shortBlock) shortBlock.style.display = 'none';
        if (mediumBlock) mediumBlock.style.display = 'none';
        if (longBlock) longBlock.style.display = 'none';
        if (emptyHint) {
          emptyHint.style.display = 'block';
          emptyHint.textContent = term ? '（无匹配结果）' : '（无自定义 VMD）';
        }
        if (countSpan) countSpan.textContent = `(0 个动作)`;
        return;
      }

      if (countSpan) countSpan.textContent = `(${filtered.length} 个动作)`;
      renderCategory(filtered.filter(it => it.category === 'short'), shortBlock);
      renderCategory(filtered.filter(it => it.category === 'medium'), mediumBlock);
      renderCategory(filtered.filter(it => it.category === 'long'), longBlock);
    };

    // 初始渲染：直接显示所有动作（无需先搜索）
    doSearch();

    // 搜索框事件绑定（只绑定一次）
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = '1';
      searchInput.addEventListener('input', doSearch);
    }

    // 恢复滚动位置：使用双层 requestAnimationFrame 确保 DOM 布局完成后再设置
    // 避免在 DOM 重建过程中设置 scrollTop 被浏览器忽略
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.scrollTop = panelScrollTop;
        const shortEl = document.querySelector('#vmd-category-short .vmd-category-scroll') as HTMLElement;
        const mediumEl = document.querySelector('#vmd-category-medium .vmd-category-scroll') as HTMLElement;
        const longEl = document.querySelector('#vmd-category-long .vmd-category-scroll') as HTMLElement;
        if (shortEl) shortEl.scrollTop = shortScroll;
        if (mediumEl) mediumEl.scrollTop = mediumScroll;
        if (longEl) longEl.scrollTop = longScroll;
      });
    });
  }

  // 刷新语音动作列表（按情绪分组）
  const refreshVoiceActions = async (): Promise<void> => {
    const voiceActionsList = document.getElementById('voice-actions-list');
    const voiceActionCount = document.getElementById('voice-action-count');
    console.log('[chatx2] refreshVoiceActions called, voiceActionsList=', !!voiceActionsList);
    if (!voiceActionsList) return;
    
    try {
      const result = await window.chatx2.listVoiceActions();
      console.log('[chatx2] listVoiceActions result:', JSON.stringify({ success: result.success, entryCount: result.entries?.length, emotionCount: result.grouped ? Object.keys(result.grouped).length : 0 }));
      if (!result.success || !result.grouped) {
        voiceActionsList.innerHTML = '<div class="vmd-empty">加载失败</div>';
        return;
      }
      
      const grouped = result.grouped;
      const emotions = Object.keys(grouped).sort();
      const totalEntries = result.entries?.length ?? 0;
      if (voiceActionCount) voiceActionCount.textContent = `(${totalEntries} 个动作)`;
      
      voiceActionsList.innerHTML = '';
      
      if (emotions.length === 0) {
        voiceActionsList.innerHTML = '<div class="vmd-empty">（无语音动作）</div>';
        return;
      }
      
      // 全部展开/收起按钮
      const toggleBar = document.createElement('div');
      toggleBar.style.cssText = 'margin-bottom:6px;display:flex;gap:4px;';
      const expandAllBtn = document.createElement('span');
      expandAllBtn.textContent = '全部展开';
      expandAllBtn.style.cssText = 'font-size:11px;color:#6a8ab0;cursor:pointer;padding:2px 6px;border-radius:3px;';
      expandAllBtn.addEventListener('mouseenter', () => { expandAllBtn.style.background = '#2a2a3e'; });
      expandAllBtn.addEventListener('mouseleave', () => { expandAllBtn.style.background = ''; });
      expandAllBtn.addEventListener('click', () => {
        const allItems = voiceActionsList.querySelectorAll('.voice-emotion-items');
        const allOpen = Array.from(allItems).every(el => el.classList.contains('open'));
        allItems.forEach(el => el.classList.toggle('open', !allOpen));
        expandAllBtn.textContent = allOpen ? '全部展开' : '全部收起';
      });
      toggleBar.appendChild(expandAllBtn);
      voiceActionsList.appendChild(toggleBar);
      
      // 默认展开的常用情绪（首个分组始终展开）
      const autoOpenEmotions = new Set(['neutral', 'happy', 'thinking', 'explaining', 'concerned']);

      // 语音动作池条目操作按钮
      type VoiceActionEntry = {
        vmdPath: string;
        displayName: string;
        type: string;
        gestureFamily: string;
        intent: string;
        emotions: string[];
        description: string;
        dialogueSafe?: boolean;
        starred?: boolean;
        protected?: boolean;
        headTuning?: { rotationScale: number };
      };
      const createVoiceActionOps = (entry: VoiceActionEntry, itemDiv: HTMLElement): void => {
        const ops = document.createElement('span');
        ops.style.cssText = 'display:flex;gap:4px;margin-left:auto;';

        const starBtn = document.createElement('span');
        starBtn.textContent = entry.starred ? '★' : '☆';
        starBtn.title = entry.starred ? '取消高频语音动作' : '设为高频语音动作';
        starBtn.style.cssText = `cursor:pointer;color:${entry.starred ? '#f0c060' : '#6a8ab0'};font-size:14px;padding:0 4px;`;
        starBtn.addEventListener('click', async (e: Event) => {
          e.stopPropagation();
          starBtn.style.pointerEvents = 'none';
          try {
            const result = await window.chatx2.updateVoiceAction(entry.vmdPath, { starred: !entry.starred });
            if (!result.success) alert('收藏语音动作失败');
            await refreshVoiceActions();
          } catch (error) {
            console.error('[chatx2] star voice action failed:', error);
            starBtn.style.pointerEvents = '';
          }
        });
        ops.appendChild(starBtn);

        const safeBtn = document.createElement('span');
        safeBtn.className = 'toggle-dialogue-safe';
        safeBtn.textContent = entry.dialogueSafe === true ? '语音✓' : '语音×';
        safeBtn.title = entry.dialogueSafe === true
          ? '已允许语音 Planner 自动选用，点击禁用'
          : '点击允许语音 Planner 作为日常对话候选';
        safeBtn.style.cssText = `cursor:pointer;color:${entry.dialogueSafe === true ? '#78bd8d' : '#907878'};font-size:10px;padding:1px 4px;border:1px solid currentColor;border-radius:3px;`;
        safeBtn.addEventListener('click', async (e: Event) => {
          e.stopPropagation();
          safeBtn.style.pointerEvents = 'none';
          try {
            const result = await window.chatx2.updateVoiceAction(entry.vmdPath, { dialogueSafe: entry.dialogueSafe !== true });
            if (!result.success) alert('更新语音自动选用状态失败');
            await refreshVoiceActions();
          } catch (error) {
            console.error('[chatx2] toggle dialogueSafe failed:', error);
            safeBtn.style.pointerEvents = '';
          }
        });
        ops.appendChild(safeBtn);

        if (entry.protected) {
          const tuning = document.createElement('input');
          tuning.type = 'range';
          tuning.min = '0.75';
          tuning.max = '1.2';
          tuning.step = '0.05';
          tuning.value = String(entry.headTuning?.rotationScale ?? 1);
          tuning.title = `头部幅度 ${Math.round(Number(tuning.value) * 100)}%`;
          tuning.style.cssText = 'width:58px;accent-color:#7798c5;cursor:pointer;';
          tuning.addEventListener('click', (event: Event) => event.stopPropagation());
          tuning.addEventListener('input', () => {
            tuning.title = `头部幅度 ${Math.round(Number(tuning.value) * 100)}%`;
          });
          tuning.addEventListener('change', async (event: Event) => {
            event.stopPropagation();
            tuning.disabled = true;
            try {
              const result = await window.chatx2.updateVoiceAction(entry.vmdPath, {
                headTuning: { rotationScale: Number(tuning.value) }
              });
              if (!result.success) alert('更新头部动作幅度失败');
              await refreshVoiceActions();
            } catch (error) {
              console.error('[chatx2] update protected head tuning failed:', error);
              tuning.disabled = false;
            }
          });
          ops.appendChild(tuning);

          const lockBadge = document.createElement('span');
          lockBadge.textContent = '🔒';
          lockBadge.title = '内置语音动作，不可删除；只改变头部，身体动作与句子表情保持独立';
          lockBadge.style.cssText = 'color:#8499b5;font-size:11px;padding:0 3px;';
          ops.appendChild(lockBadge);
          itemDiv.appendChild(ops);
          return;
        }

        const editBtn = document.createElement('span');
        editBtn.textContent = '✎';
        editBtn.title = '编辑情绪和元信息';
        editBtn.style.cssText = 'cursor:pointer;color:#6a8ab0;font-size:12px;padding:0 4px;';
        editBtn.addEventListener('click', async (e: Event) => {
          e.stopPropagation();
          // 找到原始 VMD 项用于编辑器
          const vmdItem = vmdItems.find(v => v.path === entry.vmdPath);
          if (!vmdItem) {
            alert('未找到对应 VMD 文件');
            return;
          }
          showVoiceActionEditor(vmdItem, entry, () => {
            void refreshMotionPacks();
            void refreshVoiceActions();
          });
        });
        ops.appendChild(editBtn);

        const removeBtn = document.createElement('span');
        removeBtn.textContent = '✕';
        removeBtn.title = '从语音动作池移除';
        removeBtn.style.cssText = 'cursor:pointer;color:#8a6a6a;font-size:12px;padding:0 4px;';
        removeBtn.addEventListener('click', async (e: Event) => {
          e.stopPropagation();
          if (!confirm(`确定从语音动作池移除 "${entry.displayName}" 吗？`)) return;
          try {
            const result = await window.chatx2.removeVoiceAction(entry.vmdPath);
            if (!result.success) {
              alert(`移除失败：${result.reason ?? '配置未写入'}`);
              return;
            }
            await Promise.all([refreshMotionPacks(), refreshVoiceActions()]);
          } catch (err) {
            console.error('[chatx2] removeVoiceAction failed:', err);
          }
        });
        ops.appendChild(removeBtn);

        itemDiv.appendChild(ops);
      };
      
      for (const emotion of emotions) {
        const entries = grouped[emotion];
        const groupDiv = document.createElement('div');
        groupDiv.className = 'voice-emotion-group';
        
        const header = document.createElement('div');
        header.className = 'voice-emotion-header';
        header.textContent = `${emotionNames[emotion] || emotion} (${entries.length})`;
        header.addEventListener('click', () => {
          const items = groupDiv.querySelector('.voice-emotion-items');
          if (items) items.classList.toggle('open');
        });
        
        const itemsDiv = document.createElement('div');
        itemsDiv.className = 'voice-emotion-items';
        
        for (const entry of entries) {
          const item = document.createElement('div');
          item.className = 'voice-action-item';

          const name = document.createElement('span');
          name.className = 'voice-action-name';
          name.textContent = entry.displayName;
          name.title = `${entry.description}\n路径: ${entry.vmdPath}\ndialogueSafe: ${entry.dialogueSafe}`;
          item.appendChild(name);

          // dialogueSafe 状态标识
          const safeTag = document.createElement('span');
          safeTag.style.cssText = 'font-size:10px;padding:0 4px;border-radius:2px;margin-left:2px;';
          if (entry.dialogueSafe === true) {
            safeTag.textContent = '✓语音';
            safeTag.style.color = '#6a8a6a';
            safeTag.style.background = '#1a2a1a';
          } else {
            safeTag.textContent = '✗素材';
            safeTag.style.color = '#8a6a6a';
            safeTag.style.background = '#2a1a1a';
          }
          item.appendChild(safeTag);
          
          // 显示关联的其他情绪
          const otherEmotions = entry.emotions.filter((e: string) => e !== emotion);
          if (otherEmotions.length > 0) {
            const emoTag = document.createElement('span');
            emoTag.className = 'voice-action-emotions';
            emoTag.textContent = '+' + otherEmotions.map((e: string) => emotionNames[e] || e).join(', ');
            emoTag.title = '同时匹配: ' + otherEmotions.join(', ');
            item.appendChild(emoTag);
          }
          
          // 预览按钮
          const previewBtn = document.createElement('span');
          previewBtn.className = 'voice-action-preview';
          previewBtn.textContent = '▶';
          previewBtn.title = '预览此动作';
          previewBtn.addEventListener('click', async (e: Event) => {
            e.stopPropagation();
            try {
              await window.chatx2.previewCustomVmd(entry.vmdPath);
            } catch (err) {
              console.warn('[chatx2] preview voice action failed:', err);
            }
          });
          item.appendChild(previewBtn);

          // 编辑/移除按钮
          createVoiceActionOps(entry, item);

          itemsDiv.appendChild(item);
        }
        
        groupDiv.appendChild(header);
        groupDiv.appendChild(itemsDiv);
        voiceActionsList.appendChild(groupDiv);
        
        // 默认展开常用情绪分组
        if (autoOpenEmotions.has(emotion)) {
          itemsDiv.classList.add('open');
        }
      }
    } catch (e) {
      console.error('[chatx2] refreshVoiceActions failed:', e);
      voiceActionsList.innerHTML = '<div class="vmd-empty">加载失败</div>';
    }
  };

  let performanceCandidates: readonly DailyPerformanceCandidate[] = [];
  const candidateButton = (label: string, action: () => Promise<void>, className = ''): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        console.error(`[chatx2] candidate action failed: ${label}`, error);
        alert(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  };

  const renderCandidateMeta = (candidate: DailyPerformanceCandidate): HTMLElement => {
    const meta = document.createElement('div');
    meta.className = 'candidate-review-meta';
    const pair = candidate.pairId
      ? performanceCandidates.find(entry => entry.id === candidate.pairId)
      : undefined;
    meta.textContent = [
      `情感：${emotionNames[candidate.emotion] ?? candidate.emotion}`,
      `时长：${candidate.durationSeconds.toFixed(2)} 秒`,
      `来源：${candidate.source.sourceType} / ${candidate.source.author}`,
      `条款：${candidate.source.statedTerms}`,
      `SHA-256：${candidate.source.sha256.slice(0, 12)}…`,
      `自动审计：等待/已通过目录门禁`,
      `原配：${pair?.displayName ?? '无'}`
    ].join('\n');
    meta.style.whiteSpace = 'pre-line';
    return meta;
  };

  const renderMotionCandidate = (candidate: Extract<DailyPerformanceCandidate, { kind: 'motion' }>): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'candidate-review-row';
    const name = document.createElement('div');
    name.className = 'candidate-review-name';
    name.textContent = candidate.displayName;
    row.append(name, renderCandidateMeta(candidate));
    const actions = document.createElement('div');
    actions.className = 'candidate-review-actions';
    actions.appendChild(candidateButton('仅动作预览', async () => {
      await window.chatx2.previewMotionCandidate(candidate.id);
    }));
    if (candidate.pairId) {
      const pair = performanceCandidates.find(entry => entry.id === candidate.pairId && entry.kind === 'expression');
      if (pair) actions.appendChild(candidateButton('动作+原配表情', async () => {
        await window.chatx2.previewCombinedCandidate(candidate.id);
      }));
    }
    actions.appendChild(candidateButton('加入语音动作池', async () => {
      if (!confirm(`只把动作“${candidate.displayName}”加入正式语音动作池？原配表情不会同时加入。`)) return;
      await window.chatx2.acceptMotionCandidate(candidate.id);
      await Promise.all([refreshPerformanceCandidates(), refreshVoiceActions()]);
    }, 'candidate-accept'));
    actions.appendChild(candidateButton('删除候选', async () => {
      if (!confirm(`只删除动作候选“${candidate.displayName}”？原配表情和源文件不会删除。`)) return;
      await window.chatx2.deletePerformanceCandidate(candidate.id);
      await refreshPerformanceCandidates();
    }, 'candidate-delete'));
    row.appendChild(actions);
    return row;
  };

  const renderExpressionCandidate = (candidate: Extract<DailyPerformanceCandidate, { kind: 'expression' }>): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'candidate-review-row';
    const name = document.createElement('div');
    name.className = 'candidate-review-name';
    name.textContent = candidate.displayName;
    row.append(name, renderCandidateMeta(candidate));
    const actions = document.createElement('div');
    actions.className = 'candidate-review-actions';
    actions.appendChild(candidateButton('仅表情预览', async () => {
      await window.chatx2.previewExpressionCandidate(candidate.id);
    }));
    if (candidate.pairId) {
      const pair = performanceCandidates.find(entry => entry.id === candidate.pairId && entry.kind === 'motion');
      if (pair) actions.appendChild(candidateButton('动作+原配表情', async () => {
        await window.chatx2.previewCombinedCandidate(candidate.id);
      }));
    }
    actions.appendChild(candidateButton('加入表情池', async () => {
      if (!confirm(`只把表情“${candidate.displayName}”加入正式表情池？原配动作不会同时加入。`)) return;
      await window.chatx2.acceptExpressionCandidate(candidate.id);
      await refreshPerformanceCandidates();
    }, 'candidate-accept'));
    actions.appendChild(candidateButton('删除候选', async () => {
      if (!confirm(`只删除表情候选“${candidate.displayName}”？原配动作和源文件不会删除。`)) return;
      await window.chatx2.deletePerformanceCandidate(candidate.id);
      await refreshPerformanceCandidates();
    }, 'candidate-delete'));
    row.appendChild(actions);
    return row;
  };

  async function refreshPerformanceCandidates(): Promise<void> {
    try {
      performanceCandidates = await window.chatx2.listPerformanceCandidates();
      const motions = performanceCandidates.filter(
        (entry): entry is Extract<DailyPerformanceCandidate, { kind: 'motion' }> => entry.kind === 'motion'
      );
      const expressions = performanceCandidates.filter(
        (entry): entry is Extract<DailyPerformanceCandidate, { kind: 'expression' }> => entry.kind === 'expression'
      );
      motionCandidateContainer.innerHTML = '';
      expressionCandidateContainer.innerHTML = '';
      if (motions.length === 0) motionCandidateContainer.innerHTML = '<div class="vmd-empty">（暂无动作候选）</div>';
      if (expressions.length === 0) expressionCandidateContainer.innerHTML = '<div class="vmd-empty">（暂无表情候选）</div>';
      motions.forEach(candidate => motionCandidateContainer.appendChild(renderMotionCandidate(candidate)));
      expressions.forEach(candidate => expressionCandidateContainer.appendChild(renderExpressionCandidate(candidate)));
    } catch (error) {
      console.error('[chatx2] listPerformanceCandidates failed:', error);
      motionCandidateContainer.innerHTML = '<div class="vmd-empty">候选加载失败</div>';
      expressionCandidateContainer.innerHTML = '<div class="vmd-empty">候选加载失败</div>';
    }
  }

  type ExternalVmdCandidate = {
    path: string;
    displayName: string;
    duration: number;
    category: 'short' | 'medium' | 'long';
    size: number;
    valid: boolean;
  };
  let externalVmdCandidates: ExternalVmdCandidate[] = [];
  const externalCategoryNames: Record<ExternalVmdCandidate['category'], string> = {
    short: '短动作（≤3秒）',
    medium: '中动作（3–8秒）',
    long: '长动作/待机候选（>8秒）'
  };

  const renderExternalVmdCandidate = (candidate: ExternalVmdCandidate): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'candidate-review-row';
    const name = document.createElement('div');
    name.className = 'candidate-review-name';
    name.textContent = candidate.displayName;
    const meta = document.createElement('div');
    meta.className = 'candidate-review-meta';
    meta.textContent = [
      `时长：${candidate.duration > 0 ? `${candidate.duration.toFixed(2)} 秒` : '无法解析'}`,
      `文件：${candidate.path}`,
      `大小：${(candidate.size / 1024).toFixed(1)} KB`,
      candidate.valid ? '状态：可播放' : '状态：无效或不支持（不会写入动作池）'
    ].join('\n');
    meta.style.whiteSpace = 'pre-line';
    row.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'candidate-review-actions';

    const play = candidateButton('播放', async () => {
      const result = await window.chatx2.previewExternalVmd(candidate.path);
      if (!result.success) alert(`播放失败：${result.reason ?? '未知原因'}`);
    });
    play.disabled = !candidate.valid;
    actions.appendChild(play);

    actions.appendChild(candidateButton('加入动作池', async () => {
      if (!confirm(`将“${candidate.displayName}”复制到共享动作池的“${candidate.category}”时长文件夹？`)) return;
      const result = await window.chatx2.acceptExternalVmd(candidate.path);
      if (!result.success) {
        alert(`加入失败：${result.reason ?? '未知原因'}`);
        return;
      }
      alert(`已加入动作池：${result.relativePath ?? '完成'}`);
      await refreshMotionPacks();
    }, 'candidate-accept'));

    actions.appendChild(candidateButton('删除', async () => {
      if (!confirm(`将“${candidate.displayName}”移入备选池回收站？`)) return;
      const result = await window.chatx2.deleteExternalVmd(candidate.path);
      if (!result.success) {
        alert(`删除失败：${result.reason ?? '未知原因'}`);
        return;
      }
      await refreshExternalVmdCandidates();
    }, 'candidate-delete'));
    row.appendChild(actions);
    return row;
  };

  async function refreshExternalVmdCandidates(): Promise<void> {
    try {
      const result = await window.chatx2.listExternalVmdCandidates();
      externalVmdCandidates = result.success ? (result.items ?? []) : [];
      externalVmdCandidateContainer.innerHTML = '';
      if (externalVmdCount) externalVmdCount.textContent = `（${externalVmdCandidates.length} 个）`;
      if (externalVmdCandidates.length === 0) {
        externalVmdCandidateContainer.innerHTML = '<div class="vmd-empty">（暂无外部 VMD 候选）</div>';
        return;
      }
      for (const category of ['short', 'medium', 'long'] as const) {
        const entries = externalVmdCandidates.filter(candidate => candidate.category === category);
        if (entries.length === 0) continue;
        const heading = document.createElement('div');
        heading.className = 'candidate-review-category';
        heading.textContent = `${externalCategoryNames[category]} · ${entries.length}`;
        heading.style.cssText = 'color:#aab8d8;font-size:12px;margin:8px 0 4px;';
        externalVmdCandidateContainer.appendChild(heading);
        entries.forEach(candidate => externalVmdCandidateContainer.appendChild(renderExternalVmdCandidate(candidate)));
      }
    } catch (error) {
      console.error('[chatx2] listExternalVmdCandidates failed:', error);
      externalVmdCandidateContainer.innerHTML = '<div class="vmd-empty">外部候选加载失败</div>';
    }
  }

  // 模型下拉 change：切换模型，成功后刷新动作列表
  modelSelect.addEventListener('change', async () => {
    const packId = modelSelect.value;
    if (!packId) return;
    try {
      const result = await window.chatx2.switchModelPack(packId);
      if (result.success) {
        await refreshModelList();
        await refreshMotionPacks();
        await refreshVoiceActions();
      } else {
        console.warn('[chatx2] switchModelPack failed:', result.reason);
      }
    } catch (e) {
      console.error('[chatx2] switchModelPack threw:', e);
    }
  });

  // 导入 VMD：成功后刷新动作列表
  importVmdBtn.addEventListener('click', async () => {
    importVmdBtn.disabled = true;
    try {
      const result = await window.chatx2.importVmd();
      if (result.success) {
        await refreshMotionPacks();
        await refreshVoiceActions();
      } else {
        console.warn('[chatx2] importVmd cancelled/failed:', result.reason);
      }
    } catch (e) {
      console.error('[chatx2] importVmd threw:', e);
    } finally {
      importVmdBtn.disabled = false;
    }
  });

  // 模型开关：关闭时切换到 chat 模式（隐藏桌宠窗），开启时恢复原模式
  let previousMode: AppMode | null = null;
  modelEnabledToggle.addEventListener('change', async () => {
    if (!modelEnabledToggle.checked) {
      // 关闭 3D 模型：记录当前模式，切换到 chat
      try {
        previousMode = await window.chatx2.getMode();
      } catch (e) {
        console.error('[chatx2] getMode failed:', e);
        previousMode = null;
      }
      try {
        await window.chatx2.transition('chat');
      } catch (e) {
        console.error('[chatx2] transition(chat) failed:', e);
      }
    } else {
      // 启用 3D 模型：恢复原模式（若原模式即 chat，回退到 desktop）
      const restoreMode: AppMode = previousMode && previousMode !== 'chat' ? previousMode : 'desktop';
      try {
        await window.chatx2.transition(restoreMode);
        previousMode = null;
      } catch (e) {
        console.error('[chatx2] transition(restore) failed:', e);
      }
    }
  });

  // 历史语音开关：localStorage 持久化
  // 渲染历史消息时读取此设置决定是否显示播放按钮（当前聊天窗由 Avatar 负责播放，此设置供后续渲染逻辑使用）
  const VOICE_HISTORY_KEY = 'chatx2-voice-history';
  try {
    voiceHistoryToggle.checked = localStorage.getItem(VOICE_HISTORY_KEY) === '1';
  } catch (e) {
    console.error('[chatx2] read voice-history failed:', e);
  }
  voiceHistoryToggle.addEventListener('change', () => {
    try {
      localStorage.setItem(VOICE_HISTORY_KEY, voiceHistoryToggle.checked ? '1' : '0');
    } catch (e) {
      console.error('[chatx2] persist voice-history failed:', e);
    }
  });

  // 订阅模型切换事件，自动刷新面板（模型+动作列表）
  try {
    const unsubscribe = window.chatx2.onModelPackChanged(() => {
      void refreshModelList();
      void refreshMotionPacks();
      void refreshVoiceActions();
    });
    window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  } catch (e) {
    console.error('[chatx2] onModelPackChanged subscribe failed:', e);
  }

  // 订阅动作配置变更事件（设为默认/加入待机/删除/动作包开关），仅刷新动作列表
  try {
    const unsubscribe = window.chatx2.onMotionConfigChanged(() => {
      void refreshMotionPacks();
      void refreshVoiceActions();
      void refreshPerformanceCandidates();
    });
    window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  } catch (e) {
    console.error('[chatx2] onMotionConfigChanged subscribe failed:', e);
  }

  // 初始加载
  void refreshModelList();
  void refreshMotionPacks();
  void refreshVoiceActions();
  void refreshPerformanceCandidates();
  void refreshExternalVmdCandidates();
}

init();
