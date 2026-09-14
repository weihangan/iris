// Composer 窗口 preload：通过 contextBridge 暴露受限 API
// 权限：只读身份/模式、订阅模式变化、报告崩溃、对话 IPC
// 不能：signalAvatarReady（Composer 不应能伪造 readiness）
// 允许：transitionToChat（仅限切换到 chat 模式，用于聊天按钮）
// Phase 4：Chat 和 Desktop Composer 共用 conversation API（通过 IPC 调用唯一 Controller）
//   Composer renderer 传 source='desktop'，禁止 Composer 实现自己的聊天业务
// Phase 5.1 P0-A/B/C：Avatar Runtime 是唯一 AudioContext/解码器/播放时钟所有者。
//   Composer 不再拥有 AudioContext，不再调用 decodeAudioData，不再调度 sourceNode。
//   Composer 只负责：
//   - 收到 message-added(assistant, audioReady=true) 后调用 audioPlay(taskId) 请求 Avatar 播放
//   - 收到 performance:started(taskId) 后显示字幕
//   - 收到 performance:ended(taskId, reason) 后隐藏字幕、清理状态
//   - 新消息到达时调用 audioStop(currentTaskId) 打断旧播放
import { contextBridge, ipcRenderer } from 'electron';
import { BUILD_ID } from '../../src/build-identity';
// ChatX2 模型包类型（与 src/model-pack/model-pack-types.ts 同构，避免 preload 引入主进程模块）
export interface ModelPackListItem {
  packId: string;
  displayName: string;
  internalName: string;
  capabilities: string[];
  motionCount: number;
  isBuiltIn: boolean;
}
export interface SwitchModelResult {
  success: boolean;
  packId?: string;
  displayName?: string;
  sha256?: string;
  reason?: string;
}
export interface ModelPackMotions {
  idlePacks: string[];
  gesturePacks: string[];
  defaultIdle: string;
  customVmd: string[];
}
export interface ModelPackPhysics {
  disabledDynamicBones?: string[];
}

export type AppMode = 'chat' | 'loading' | 'desktop' | 'scene';

export interface ModeChangeEvent {
  from: AppMode;
  to: AppMode;
  reason?: string;
}

// Phase 4: 对话桥接类型（与 src/conversation/conversation-types.ts 同构）
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
  /**
   * Phase 5.1：音频优先硬门标志。
   * - user/system 消息：始终 false
   * - assistant 消息：true 表示主进程已校验 WAV 通过，renderer 可通过 audioPlay(taskId) 请求 Avatar 播放
   *   false 表示无音频或校验失败，renderer 不得请求播放、不张嘴、不说话
   *   Phase 5.1 修复（P0-1）：audioReady=false 时仍保留并显示 assistant 正文，但禁止音频/口型/说话动作。
   */
  audioReady: boolean;
  /**
   * Phase 5.1 修复（P0-1）：音频错误信息。
   * - assistant 消息：audioReady=false 时，audioError 描述失败原因。
   *   renderer 显示字幕文本 + 错误提示 + "重新生成语音"按钮。
   * - audioReady=true 时，audioError 为 undefined。
   */
  audioError?: string;
  /**
   * Phase 5.1 修复（P0-2）：assistant 消息关联的 taskId。
   * renderer 通过此字段调用 audioPlay(taskId) / audioStop(taskId) / audioRegenerate(taskId)。
   */
  taskId?: string;
}

/**
 * Phase 5.1 修复（P0-1）：重新生成语音结果。
 */
export interface AudioRegenerateResult {
  success: boolean;
  taskId: string;
  audioReady: boolean;
  audioError?: string;
}

/**
 * Phase 5.1 P0-A/B/C：表演结束原因（Avatar → 主进程 → Composer）。
 * - 'ended'：自然播放结束
 * - 'failed'：解码或播放失败
 * - 'interrupted'：被新消息打断或模式切换或取消
 */
export type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';

/**
 * Phase 5.2 修正（2026-07-19）：motion 语义级输入。
 * 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
 * 因此 motion IPC 只接受语义级 emotion/intent/gestureFamily，由 Planner 选择 pack。
 */
export interface MotionSemantic {
  emotion?: string;
  intent?: string;
  gestureFamily?: string;
}

/**
 * Phase 5.2 修正：motion pack 元信息（motion:list 返回）。
 * 不包含 VMD 字节、骨骼值、sourceUrl、sha256（防止 Renderer 自行加载）。
 */
export interface MotionPackInfo {
  packId: string;
  trigger: 'user-only' | 'conversation' | 'idle';
  allowedStates: string[];
  movesRoot: boolean;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  cooldownSeconds: number;
  mode: 'production' | 'candidate-review' | 'unknown';
}

/**
 * Phase 5.2 修正：motion IPC 操作结果。
 */
export interface MotionResult {
  success: boolean;
  reason?: string;
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

const api = {
  buildId: BUILD_ID,
  getIdentity: (): Promise<{
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
    conversationIsMock: boolean;
  }> => ipcRenderer.invoke('chatx2:get-identity'),

  getMode: (): Promise<AppMode> => ipcRenderer.invoke('chatx2:get-mode'),

  // 报告 Avatar 崩溃（renderer 侧）
  reportAvatarCrash: (): void => {
    ipcRenderer.send('chatx2:report-avatar-crash');
  },

  // 订阅模式变化事件
  onModeChange: (cb: (event: ModeChangeEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: ModeChangeEvent): void => cb(event);
    ipcRenderer.on('chatx2:mode-change', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:mode-change', handler);
    };
  },

  // Phase 4: 对话 IPC（Chat 和 Desktop Composer 共用）
  // Renderer 只提交纯文本；主进程按 event.sender 派生可信 source='desktop'。
  conversationSubmit: (text: string): Promise<ConversationSubmitResult> =>
    ipcRenderer.invoke('conversation:submit', text),

  transcribeVoiceInput: (audio: ArrayBuffer, mimeType: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice-input:transcribe', audio, mimeType),

  conversationHistory: (): Promise<ConversationHistory> =>
    ipcRenderer.invoke('conversation:history'),

  conversationCancel: (): Promise<{ cancelled: boolean; taskId?: string; reason?: string }> =>
    ipcRenderer.invoke('conversation:cancel'),

  // Phase 5.1 P0-A/B/C：请求 Avatar 开始播放 taskId 对应的 WAV。
  // Composer 收到 message-added(assistant, audioReady=true, taskId) 后调用此 IPC。
  // 主进程校验 taskId 在 wavCache 中，取出 wavBytes，转发 avatar:play(taskId, wavBytes) 给 Avatar。
  // Avatar 完成 decodeAudioData + sourceNode.start + actorRuntime.speak 后，发送 performance:started。
  // Composer 通过 onPerformanceStarted 监听此事件，显示字幕。
  // 硬门：在 performance:started 之前，Composer 不显示字幕、不设置 __composerSpeaking。
  audioPlay: (taskId: string): Promise<void> =>
    ipcRenderer.invoke('audio:play', taskId),

  // Phase 5.1 P0-A/B/C：请求 Avatar 停止当前播放（用于新消息打断）。
  // Composer 在收到新 message-added(assistant) 时调用此 IPC 打断旧播放。
  // 主进程转发 avatar:stop-play('interrupted') 给 Avatar。
  // Avatar 停止 sourceNode + actorRuntime.stopSpeak + 发送 performance:ended('interrupted')。
  audioStop: (taskId: string): Promise<void> =>
    ipcRenderer.invoke('audio:stop', taskId),

  // Phase 5.1 修复（P0-1）：重新生成语音入口。
  // renderer 在用户点击"重新生成语音"按钮时调用。
  // 主进程根据 taskId 重新生成 WAV（P0-D 修复后使用 VoiceAdapter.synthesize(assistantText)）。
  // 成功后 emit message-updated 事件，renderer 更新消息的 audioReady/audioError 字段。
  audioRegenerate: (taskId: string): Promise<AudioRegenerateResult> =>
    ipcRenderer.invoke('audio:regenerate', taskId),

  // Phase 5.1 P0-A/B/C：监听表演开始事件（Avatar → 主进程 → Composer）。
  // Avatar 在 AudioContext.state === 'running' 且 decodeAudioData 成功 且 sourceNode.start() 调度后发送。
  // Composer 收到后显示字幕、设置 __composerSpeaking = true。
  // Phase 5.2 Task 5.2.6：可选 audioStartTime 参数（AudioContext.currentTime 在 sourceNode.start() 时的值），
  // 供 Composer 字幕同步使用。回调签名向后兼容：第二个参数为可选 number。
  onPerformanceStarted: (cb: (taskId: string, audioStartTime?: number) => void): (() => void) => {
    const handler = (_e: unknown, taskId: string, audioStartTime?: unknown): void => {
      if (typeof audioStartTime === 'number' && Number.isFinite(audioStartTime)) {
        cb(taskId, audioStartTime);
      } else {
        cb(taskId);
      }
    };
    ipcRenderer.on('performance:started', handler);
    return () => {
      ipcRenderer.removeListener('performance:started', handler);
    };
  },

  // Phase 5.1 P0-A/B/C：监听表演结束事件（Avatar → 主进程 → Composer）。
  // Avatar 在播放自然结束、解码/播放失败、或被中断时发送。
  // Composer 收到后隐藏字幕、清除 __composerSpeaking。
  onPerformanceEnded: (cb: (taskId: string, reason: PerformanceEndReason) => void): (() => void) => {
    const handler = (_e: unknown, taskId: string, reason: PerformanceEndReason): void => cb(taskId, reason);
    ipcRenderer.on('performance:ended', handler);
    return () => {
      ipcRenderer.removeListener('performance:ended', handler);
    };
  },

  // 订阅 conversation 事件（message-added / message-updated / task-started / task-completed / task-cancelled / task-failed）
  onConversationEvent: (cb: (event: ConversationEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: ConversationEvent): void => cb(event);
    ipcRenderer.on('conversation:event', handler);
    return () => {
      ipcRenderer.removeListener('conversation:event', handler);
    };
  },

  // ============================================================
  // Phase 5.2 修正（2026-07-19）：motion IPC
  //
  // 用户要求：在主进程实现并校验 motion:load/play/stop/list，
  // 主进程持有 Registry 和生命周期；Renderer 不能自行信任路径或未白名单 pack。
  //
  // Renderer 只能通过语义级 emotion/intent/gestureFamily 请求 motion，
  // 不能直接传 packId/VMD 文件名/骨骼值。主进程校验后通过 motion:command 转发给 Avatar。
  // Avatar 收到后调用 Planner 选择 pack 并播放/加载/停止。
  // ============================================================

  // motion:list — 列出所有已注册的 motion pack 元信息
  // 返回 MotionPackInfo[]（不包含 VMD 字节、骨骼值、sourceUrl、sha256）
  motionList: (): Promise<MotionPackInfo[]> =>
    ipcRenderer.invoke('motion:list'),

  // motion:load — 预加载 pack（基于 semantic，由 Avatar 调用 Planner 选择 pack）
  motionLoad: (semantic: MotionSemantic): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:load', { semantic }),

  // motion:play — 播放 motion（基于 semantic，由 Avatar 调用 Planner 选择 pack）
  motionPlay: (semantic: MotionSemantic): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:play', { semantic }),

  // motion:stop — 停止当前 motion（紧急停止，用于模式切换等）
  motionStop: (): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:stop'),

  // motion:emotion-update — speaking 中切换 emotion（安全边界切换动作族）
  // Avatar 收到后调用 Planner 重新选择 gesture pack，通过 fade-out → fade-in 切换
  motionEmotionUpdate: (emotion: string, intent?: string): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:emotion-update', emotion, intent),

  // ============================================================
  // ChatX2 模型包管理 API
  // ============================================================
  listModelPacks: (): Promise<ModelPackListItem[]> =>
    ipcRenderer.invoke('chatx2:list-model-packs'),

  openModelsFolder: (): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('chatx2:open-models-folder'),

  getCurrentModelPack: (): Promise<{ success: boolean; packId?: string; displayName?: string; internalName?: string; capabilities?: string[]; motions?: ModelPackMotions; physics?: ModelPackPhysics }> =>
    ipcRenderer.invoke('chatx2:get-current-model-pack'),

  switchModelPack: (packId: string): Promise<SwitchModelResult> =>
    ipcRenderer.invoke('chatx2:switch-model-pack', packId),

  importVmd: (): Promise<{ success: boolean; relativePath?: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:import-vmd'),

  listMotionPacks: (): Promise<{ success: boolean; idlePacks?: string[]; gesturePacks?: string[]; customVmd?: string[]; defaultIdle?: string }> =>
    ipcRenderer.invoke('chatx2:list-motion-packs'),

  toggleMotionPack: (motionPackId: string, enabled: boolean, type: 'idle' | 'gesture'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-motion-pack', motionPackId, enabled, type),

  setDefaultIdle: (idlePackId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-default-idle', idlePackId),

  onModelPackChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { packId: string; displayName: string; sha256: string }): void => cb(payload);
    ipcRenderer.on('chatx2:model-pack-changed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:model-pack-changed', handler);
    };
  },

  // ============================================================
  // 桌宠窗口控制 API（从 Composer 窗口控制桌宠窗口）
  // ============================================================

  /** 请求设置手动模型穿透开关（Composer 按钮点击时调用）。
   *  不直接调 BrowserWindow.setIgnoreMouseEvents，由 Avatar renderer 处理。 */
  setModelPassThrough: (manual: boolean): Promise<void> =>
    ipcRenderer.invoke('chatx2:set-model-pass-through', manual),

  /** 调整桌宠窗口大小（scale: 1.15=放大，0.87=缩小） */
  /** 全屏模式下调整 3D 模型缩放（delta: 正=放大，负=缩小） */
  setModelScale: (delta: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-model-scale', delta),

  /** 切换视角模式（全身/半身） */
  setCameraView: (mode: 'full' | 'half'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-camera-view', mode),

  /** 设置模型手动朝向（左右 ±45°、上下 ±30°） */
  setModelRotation: (yaw: number, pitch: number): Promise<{ success: boolean; yaw?: number; pitch?: number }> =>
    ipcRenderer.invoke('chatx2:set-model-rotation', yaw, pitch),

  /** 暂停/恢复待机动作 */
  toggleIdlePaused: (): Promise<{ success: boolean; paused: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-idle-paused'),

  /** 获取待机动作暂停状态 */
  getIdlePaused: (): Promise<{ paused: boolean }> =>
    ipcRenderer.invoke('chatx2:get-idle-paused'),

  setPoseLock: (locked: boolean): Promise<{ success: boolean; locked: boolean }> =>
    ipcRenderer.invoke('chatx2:set-pose-lock', locked),
  togglePoseLock: (): Promise<{ success: boolean; locked: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-pose-lock'),
  getPoseLock: (): Promise<{ locked: boolean }> =>
    ipcRenderer.invoke('chatx2:get-pose-lock'),
  onPoseLockChanged: (cb: (payload: { locked: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { locked: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:pose-lock-changed', handler);
    return () => ipcRenderer.removeListener('chatx2:pose-lock-changed', handler);
  },

  setGazeLock: (locked: boolean): Promise<{ success: boolean; locked: boolean }> =>
    ipcRenderer.invoke('chatx2:set-gaze-lock', locked),
  getGazeLock: (): Promise<{ locked: boolean }> =>
    ipcRenderer.invoke('chatx2:get-gaze-lock'),
  onGazeLockChanged: (cb: (payload: { locked: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { locked: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:gaze-lock-changed', handler);
    return () => ipcRenderer.removeListener('chatx2:gaze-lock-changed', handler);
  },

  setRenderQuality: (level: 'low' | 'medium' | 'high' | 'ultra'): Promise<{ success: boolean; level?: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:set-render-quality', level),
  getRenderQuality: (): Promise<{ level: 'low' | 'medium' | 'high' | 'ultra' }> =>
    ipcRenderer.invoke('chatx2:get-render-quality'),

  /** 退出桌宠模式：隐藏 Avatar + Composer，切回 chat 模式 */
  exitDesktop: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:exit-desktop'),

  /** 切换窗口置顶状态 */
  toggleAlwaysOnTop: (onTop: boolean): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-always-on-top', onTop),

  /** 切换到聊天窗口（仅限 chat 模式，用于输入框聊天按钮） */
  transitionToChat: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:transition-to-chat'),

  /** 订阅手动模型穿透开关变化（只反映用户意图，不反映 hover 物理状态）。 */
  onModelPassThroughChanged: (cb: (payload: { manual: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { manual: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:model-pass-through-changed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:model-pass-through-changed', handler);
    };
  }
};

contextBridge.exposeInMainWorld('chatx2', api);
