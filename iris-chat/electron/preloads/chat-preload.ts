// Chat 窗口 preload：通过 contextBridge 暴露受限 API
// 权限：只读身份/模式、发起切换请求、订阅模式变化、报告崩溃、对话 IPC
// 不能：signalAvatarReady（只有 Avatar 窗口可以）
// Phase 4：Chat 和 Desktop Composer 共用 conversation API（通过 IPC 调用唯一 Controller）
// Phase 5.1 P0-A/B/C：Chat 不播放音频（只有 Desktop 模式才播放）。
//   Chat preload 不暴露 audioPlay/audioStop/onPerformanceStarted/onPerformanceEnded。
//   但 window.chatx2 类型声明需与 composer-renderer.ts 保持一致（TS2717 兼容）。
//   Chat renderer 只使用 audioRegenerate（"重新生成语音"按钮）。
// Avatar 同步扩展：Chat 窗口自己播放语音时，通过 avatarSyncVoice/avatarSyncStop
//   通知 Avatar 窗口静音播放同一音频，驱动桌宠口型/动作。Avatar 不发声（mute=true）。
import { contextBridge, ipcRenderer } from 'electron';
import type { PerformanceSemantic } from '../../src/performance/semantic-performance';
import type { AvatarSyncStopReason } from '../avatar-sync-stop-policy';
import type { DailyPerformanceCandidate } from '../../src/performance/daily-candidate-types';
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
   * - assistant 消息：true 表示主进程已校验 WAV 通过
   *   false 表示无音频或校验失败，renderer 不得渲染字幕/不张嘴/不说话
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
   * renderer 通过此字段调用 audioRegenerate(taskId)。
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
 * Phase 5.1 P0-A/B/C：表演结束原因（类型声明，Chat renderer 不使用，仅 TS2717 兼容）。
 */
export type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';

/**
 * Phase 5.2 修正（2026-07-19）：motion 语义级输入（与 composer-preload 同构）。
 * 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
 */
export interface MotionSemantic {
  emotion?: string;
  intent?: string;
  gestureFamily?: string;
}

/**
 * Phase 5.2 修正：motion pack 元信息（motion:list 返回）。
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

  listPerformanceCandidates: (): Promise<readonly DailyPerformanceCandidate[]> =>
    ipcRenderer.invoke('chatx2:list-performance-candidates'),
  previewMotionCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:preview-motion-candidate', id),
  previewExpressionCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:preview-expression-candidate', id),
  previewCombinedCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:preview-combined-candidate', id),
  acceptMotionCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:accept-motion-candidate', id),
  acceptExpressionCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:accept-expression-candidate', id),
  deletePerformanceCandidate: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:delete-performance-candidate', id),
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
    pmxRenderInTest: boolean;
    conversationIsMock: boolean;
  }> => ipcRenderer.invoke('chatx2:get-identity'),

  getMode: (): Promise<AppMode> => ipcRenderer.invoke('chatx2:get-mode'),

  transition: (target: AppMode): Promise<TransitionResult> =>
    ipcRenderer.invoke('chatx2:transition', target),

  // 退出桌宠模式：隐藏 Avatar + Composer 窗口，切回 chat 模式
  exitDesktop: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:exit-desktop'),

  // 检查 avatar-ready 证据是否就绪（测试用）
  hasAvatarReady: (): Promise<boolean> => ipcRenderer.invoke('chatx2:has-avatar-ready'),

  // 获取所有窗口的可见性（测试用）
  getWindowsVisibility: (): Promise<Array<{ title: string; visible: boolean; type: string }>> =>
    ipcRenderer.invoke('chatx2:get-windows-visibility'),

  // Phase 3 收口修复：用户选择 PMX 模型文件
  // 主进程通过 dialog.showOpenDialog 让用户选择，校验 SHA-256 后更新内部 selectedModel
  // 返回 { success: true, modelPath, sha256 } 或 { success: false, reason }
  selectPmxModel: (): Promise<{
    success: boolean;
    modelPath?: string;
    sha256?: string;
    packId?: string;
    reason?: 'cancelled' | 'hash-mismatch' | 'invalid-extension' | 'import-failed';
  }> => ipcRenderer.invoke('chatx2:select-pmx-model'),

  // 测试专用：注入 test-only-ready 证据。主进程会校验 IS_TEST，生产模式返回失败。
  // 这是 Phase 2 测试需要的"受控证据注入入口"，不绕过 sender 校验：
  // 真实的 signalAvatarReady 仍然只暴露给 avatar-preload，Chat renderer 无法调用它。
  testInjectReady: (): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('chatx2:test-inject-ready'),

  // 报告 Avatar 崩溃（renderer 侧或测试触发）
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
  // Renderer 只提交纯文本；主进程按 event.sender 派生可信 source='chat'。
  conversationSubmit: (text: string): Promise<ConversationSubmitResult> =>
    ipcRenderer.invoke('conversation:submit', text),

  transcribeVoiceInput: (audio: ArrayBuffer, mimeType: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice-input:transcribe', audio, mimeType),

  conversationHistory: (): Promise<ConversationHistory> =>
    ipcRenderer.invoke('conversation:history'),

  conversationCancel: (): Promise<{ cancelled: boolean; taskId?: string; reason?: string }> =>
    ipcRenderer.invoke('conversation:cancel'),

  // ChatX2 双向同步：Chat 页面通过 HTTP /api/chat 发送消息后，通知 Controller 注入外部消息。
  // Composer 收到 conversation:event 后实时显示 Chat 页面的消息。
  conversationInjectExternal: (
    userText: string,
    assistantText: string,
    userTimestamp?: number,
    assistantTimestamp?: number,
    performance?: Partial<PerformanceSemantic>,
  ): Promise<void> =>
    ipcRenderer.invoke('conversation:inject-external', {
      userText,
      assistantText,
      userTimestamp,
      assistantTimestamp,
      performance,
    }),

  // Phase 5.1 P0-A/B/C：Chat 不播放音频，不暴露 audioPlay/audioStop。
  // Chat renderer 保留 audioRegenerate 用于"重新生成语音"按钮。
  // 类型声明需与 composer-preload.ts 保持一致（TS2717 兼容），但实际不暴露 audioPlay/audioStop。

  // Phase 5.1 修复（P0-1）：重新生成语音入口。
  // renderer 在用户点击"重新生成语音"按钮时调用，主进程根据 taskId 重新生成 WAV。
  // 成功后 emit message-updated 事件，renderer 更新消息的 audioReady/audioError 字段。
  audioRegenerate: (taskId: string): Promise<AudioRegenerateResult> =>
    ipcRenderer.invoke('audio:regenerate', taskId),

  // ============================================================
  // Avatar 同步扩展：Chat 窗口播放语音时，通知 Avatar 窗口静音播放同一音频。
  // Avatar 收到 wavBytes 后以 mute=true 模式解码播放，驱动口型/动作但不发声。
  // 这使 Chat 窗口聊天的语音和点击历史语音记录时，桌宠也同步表演。
  // ============================================================

  // 通知 Avatar 同步播放语音（静音模式，仅驱动口型/动作）
  // taskId: 唯一标识此次播放（用于停止）
  // wavBytes: WAV 音频字节（Chat 窗口 fetch audioUrl 获取）
  // semantic: 语义级 emotion/intent，供 Planner 选择 gesture pack
  // speechText: 对话文本（可选，用于口型同步的备选方案）
  avatarSyncVoice: (taskId: string, wavBytes: ArrayBuffer, semantic?: Partial<PerformanceSemantic>, speechText?: string): Promise<MotionResult> =>
    ipcRenderer.invoke('avatar:sync-voice', taskId, wavBytes, semantic, speechText),

  // 通知 Avatar 停止同步播放（Chat 窗口暂停/停止语音时调用）
  avatarSyncStop: (taskId: string, reason: AvatarSyncStopReason = 'cancel'): Promise<MotionResult> =>
    ipcRenderer.invoke('avatar:sync-stop', taskId, reason),

  // 订阅 conversation 事件（message-added / message-updated / task-started / task-completed / task-cancelled / task-failed）
  onConversationEvent: (cb: (event: ConversationEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: ConversationEvent): void => {
      cb(event);
    };
    ipcRenderer.on('conversation:event', handler);
    return () => {
      ipcRenderer.removeListener('conversation:event', handler);
    };
  },

  // ============================================================
  // Phase 5.2 修正（2026-07-19）：motion IPC
  // 与 composer-preload 同构。Chat renderer 也可触发 motion（用于测试/调试）。
  // 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
  // ============================================================

  // motion:list — 列出所有已注册的 motion pack 元信息
  motionList: (): Promise<MotionPackInfo[]> =>
    ipcRenderer.invoke('motion:list'),

  // motion:load — 预加载 pack（基于 semantic，由 Avatar 调用 Planner 选择 pack）
  motionLoad: (semantic: MotionSemantic): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:load', { semantic }),

  // motion:play — 播放 motion（基于 semantic，由 Avatar 调用 Planner 选择 pack）
  motionPlay: (semantic: MotionSemantic): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:play', { semantic }),

  // motion:stop — 停止当前 motion（紧急停止）
  motionStop: (): Promise<MotionResult> =>
    ipcRenderer.invoke('motion:stop'),

  // motion:emotion-update — speaking 中切换 emotion（安全边界切换动作族）
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

  /** 激活角色上下文，使模型/待机/打光偏好按角色恢复。 */
  setActiveCharacter: (characterId: string): Promise<{ success: boolean; characterId?: string; modelPackId?: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:set-active-character', characterId),

  importVmd: (): Promise<{ success: boolean; relativePath?: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:import-vmd'),

  listMotionPacks: (): Promise<{ success: boolean; idlePacks?: string[]; gesturePacks?: string[]; customVmd?: string[]; defaultIdle?: string }> =>
    ipcRenderer.invoke('chatx2:list-motion-packs'),

  listAllMotionPacks: (): Promise<{
    success: boolean;
    idlePacks?: Array<{ packId: string; displayName: string; description: string; enabled: boolean }>;
    gesturePacks?: Array<{ packId: string; displayName: string; gestureFamily: string; description: string; enabled: boolean }>;
    customVmd?: string[];
    defaultIdle?: string;
    idleVmdPool?: string[];
    longActionVmd?: string[];
  }> => ipcRenderer.invoke('chatx2:list-all-motion-packs'),

  /** 获取所有 VMD 带时长和分类信息（短/中/长） */
  listVmdWithInfo: (): Promise<{
    success: boolean;
    items?: Array<{ path: string; displayName: string; duration: number; category: 'short' | 'medium' | 'long'; available: boolean }>;
    defaultIdle?: string;
    idleVmdPool?: string[];
  }> => ipcRenderer.invoke('chatx2:list-vmd-with-info'),

  /** 项目外 VMD 备选池（不写入项目，直到用户明确点击加入动作池） */
  listExternalVmdCandidates: (): Promise<{
    success: boolean;
    root?: string;
    items?: Array<{
      path: string;
      displayName: string;
      duration: number;
      category: 'short' | 'medium' | 'long';
      size: number;
      valid: boolean;
    }>;
  }> => ipcRenderer.invoke('chatx2:list-external-vmd-candidates'),

  previewExternalVmd: (relativePath: string): Promise<{ success: boolean; reason?: string; packId?: string }> =>
    ipcRenderer.invoke('chatx2:preview-external-vmd', relativePath),

  deleteExternalVmd: (relativePath: string): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('chatx2:delete-external-vmd', relativePath),

  acceptExternalVmd: (relativePath: string): Promise<{ success: boolean; relativePath?: string; folder?: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:accept-external-vmd', relativePath),

  toggleMotionPack: (motionPackId: string, enabled: boolean, type: 'idle' | 'gesture'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-motion-pack', motionPackId, enabled, type),

  setDefaultIdle: (idlePackId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-default-idle', idlePackId),

  /** 将 customVmd 加入/移出待机轮换池 */
  toggleIdleVmd: (vmdPath: string, inPool: boolean): Promise<{ success: boolean; reason?: string; maxSlots?: number }> =>
    ipcRenderer.invoke('chatx2:toggle-idle-vmd', vmdPath, inPool),

  /** 预览指定动作包（idle 循环播放 / gesture 播放一次），仅发送到 Avatar 窗口 */
  previewMotionPack: (motionPackId: string, type: 'idle' | 'gesture'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:preview-motion-pack', motionPackId, type),

  /** 预览自定义 VMD：从模型管理面板发送给 Avatar 窗口即时播放 */
  previewCustomVmd: (relativePath: string): Promise<{ success: boolean; reason?: string; packId?: string }> =>
    ipcRenderer.invoke('chatx2:preview-custom-vmd', relativePath),

  /** 导入长时间 VMD 动作（舞蹈/场景） */
  importLongVmd: (): Promise<{ success: boolean; imported?: string[]; reason?: string }> =>
    ipcRenderer.invoke('chatx2:import-long-vmd'),

  /** 预览长时间 VMD 动作 */
  previewLongVmd: (relativePath: string): Promise<{ success: boolean; reason?: string; packId?: string }> =>
    ipcRenderer.invoke('chatx2:preview-long-vmd', relativePath),

  /** 删除长时间 VMD 动作 */
  removeLongVmd: (relativePath: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:remove-long-vmd', relativePath),

  /** 删除自定义 VMD 动作 */
  removeCustomVmd: (relativePath: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:remove-custom-vmd', relativePath),

  /** 从合并动作库软删除所有索引引用，不删除磁盘 VMD。 */
  removeLibraryVmd: (relativePath: string): Promise<{ success: boolean; removedReferences?: number; reason?: string }> =>
    ipcRenderer.invoke('chatx2:remove-library-vmd', relativePath),

  // ============================================================
  // 语音动作统一管理（所有模型共享）
  // ============================================================

  /** 获取所有语音动作（按情绪分组） */
  listVoiceActions: (): Promise<{ success: boolean; entries?: Array<{ vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }>; grouped?: Record<string, Array<{ vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }>> }> =>
    ipcRenderer.invoke('chatx2:list-voice-actions'),

  /** 添加语音动作到共享映射表 */
  addVoiceAction: (entry: { vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:add-voice-action', entry),

  /** 从共享映射表移除语音动作 */
  removeVoiceAction: (vmdPath: string): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('chatx2:remove-voice-action', vmdPath),

  /** 更新语音动作的情绪映射 */
  updateVoiceAction: (vmdPath: string, updates: { emotions?: string[]; displayName?: string; gestureFamily?: string; intent?: string; description?: string; dialogueSafe?: boolean; starred?: boolean; headTuning?: { rotationScale: number } }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:update-voice-action', vmdPath, updates),

  /** 用户调节动作的收势/入势速度；主进程校验后转发给 Avatar。 */
  setTransitionSpeed: (multiplier: number): Promise<{ success: boolean; value?: number; reason?: string }> =>
    ipcRenderer.invoke('chatx2:set-transition-speed', multiplier),

  getTransitionSpeed: (): Promise<{ value: number }> =>
    ipcRenderer.invoke('chatx2:get-transition-speed'),

  /** 切换打光预设 */
  setLighting: (presetId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-lighting', presetId),

  /** 动态打光调节：设置灯光方向/强度 */
  setLightingDynamic: (params: { keyIntensity?: number; keyX?: number; keyY?: number; keyZ?: number; fillIntensity?: number; rimIntensity?: number; hemiIntensity?: number; contrast?: number; saturation?: number }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-lighting-dynamic', params),

  /** 渲染精度切换：low/medium/high/ultra */
  setRenderQuality: (level: 'low' | 'medium' | 'high' | 'ultra'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-render-quality', level),

  /** 获取当前渲染精度级别 */
  getRenderQuality: (): Promise<{ level: 'low' | 'medium' | 'high' | 'ultra' }> =>
    ipcRenderer.invoke('chatx2:get-render-quality'),

  /** 获取打光预设列表 */
  getLightingPresets: (): Promise<{ success: boolean; presets: Array<{ id: string; name: string }>; current: string; dynamic: Record<string, number> }> =>
    ipcRenderer.invoke('chatx2:get-lighting-presets'),

  /** 短时预览表情池配方（语音期间会被拒绝） */
  setExpression: (expressionId: string, channel?: string): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('chatx2:set-expression', expressionId, channel),

  /** 获取表情池及当前模型支持情况 */
  getExpressionPresets: (): Promise<{ success: boolean; presets: Array<{
    id: string;
    name: string;
    previewOnly: boolean;
    automatic: boolean;
    microAccents: string[];
    supported: boolean;
    supportedChannels: string[];
    missingChannels: string[];
    channels: Array<{ id: string; name: string; weight: number; supported: boolean }>;
  }>; current: string }> =>
    ipcRenderer.invoke('chatx2:get-expression-presets'),

  onModelPackChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { packId: string; displayName: string; sha256: string }): void => cb(payload);
    ipcRenderer.on('chatx2:model-pack-changed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:model-pack-changed', handler);
    };
  },

  // 动作配置变更（设为默认/加入待机/删除/动作包开关）— 不触发模型重载
  onMotionConfigChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { packId: string; displayName: string; sha256: string }): void => cb(payload);
    ipcRenderer.on('chatx2:motion-config-changed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:motion-config-changed', handler);
    };
  },

  // ============================================================
  // 桌宠窗口控制 API（从聊天窗口控制桌宠窗口）
  // ============================================================

  /** 请求设置手动模型穿透开关（由 Avatar renderer 处理，不直接调窗口 API） */
  setModelPassThrough: (manual: boolean): Promise<void> =>
    ipcRenderer.invoke('chatx2:set-model-pass-through', manual),

  /** 全屏模式下调整 3D 模型缩放（delta: 正=放大，负=缩小） */
  setModelScale: (delta: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-model-scale', delta),

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
  }
};

contextBridge.exposeInMainWorld('chatx2', api);
