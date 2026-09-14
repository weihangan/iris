// Avatar 窗口 preload：通过 contextBridge 暴露受限 API
// 权限：只读身份/模式、signalAvatarReady（仅此窗口有）、报告崩溃、订阅模式变化
// Phase 3 Task 3.2：PMX 模型/纹理加载、pmx-first-frame 通知
// Phase 5.1 P0-A/B/C：Avatar Runtime 是唯一 AudioContext/解码器/播放时钟所有者
//   - 接收 avatar:play(taskId, wavBytes, semantic?) 信号（主进程转发，携带 WAV 字节）
//   - Avatar 内部完成 decodeAudioData、sourceNode 调度、actorRuntime.speak()
//   - 解码成功且 audioContext.state === 'running' 后才发送 performance:started
//   - 播放结束/失败/中断发送 performance:ended
//   - 不携带对话文本（隐私边界）：Avatar 只收到 taskId、wavBytes、semantic（emotion/intent）
// Phase 5.2 修正（2026-07-19）：
//   - avatar:play 增加 semantic 参数（emotion/intent，供 Planner 选择 gesture）
//   - motion:emotion-update：speaking 中 emotion 变化时主进程通知 Avatar 切换动作族
//   - motion:command：主进程授权的 motion:load/play/stop/list 命令
//   - 主进程持有 MotionPackRegistry 与生命周期，Renderer 不能自行信任路径或未白名单 pack
import { contextBridge, ipcRenderer } from 'electron';
import type { PerformanceSemantic } from '../../src/performance/semantic-performance';
import type { CandidateCueId } from '../../src/performance/candidate-review-performance';
import type { CandidateMotionPayload } from '../candidate-review-motion-catalog';
import type {
  AcceptedExpressionRecord,
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../../src/performance/daily-candidate-types';
import { BUILD_ID } from '../../src/build-identity';
// 右键菜单树（与 src/desktop-avatar-renderer.ts 的 AvatarContextMenuItem 同构，避免 preload 引入 src）
export type AvatarContextMenuItemPayload =
  | { id: string; label: string; type: 'normal' | 'checkbox'; checked?: boolean; disabled?: boolean }
  | { id: string; label: string; type: 'submenu'; submenu: AvatarContextMenuItemPayload[] }
  | { id: string; type: 'separator' };
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
  longActionVmd?: string[];
  idleVmdPool?: string[];
  vmdEmotionMap?: Array<{
    vmdPath: string;
    displayName: string;
    type: 'idle' | 'gesture' | 'voice';
    gestureFamily: string;
    intent: string;
    emotions: string[];
    description: string;
    dialogueSafe?: boolean;
  }>;
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

/**
 * Phase 5.1 P0-A/B/C：Avatar 停止表演的原因。
 * - 'interrupted'：Composer 发起 audioStop（新消息打断）或主进程发起 audio:stop
 * - 'mode-change'：模式切换离开 desktop（主进程发起 avatar:stop-play）
 * - 'cancel'：对话任务被取消
 */
export type AvatarStopReason = 'interrupted' | 'mode-change' | 'cancel' | 'ended';

/**
 * Phase 5.1 P0-A/B/C：表演结束原因（Avatar → 主进程）。
 * - 'ended'：自然播放结束（sourceNode.onended）
 * - 'failed'：解码或播放失败（decodeAudioData 抛错、sourceNode.start 抛错、AudioContext 无法 resume）
 * - 'interrupted'：被 audioStop 或 mode-change 或 cancel 中断
 */
export type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';

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
    pmxRenderInTest: boolean;
  }> => ipcRenderer.invoke('chatx2:get-identity'),

  getMode: (): Promise<AppMode> => ipcRenderer.invoke('chatx2:get-mode'),

  // Avatar renderer 调用：通知主进程 placeholder-canvas 已就绪
  // 注意：placeholder-canvas 仅作为占位通知，不能授权 Desktop 切换
  // 真实授权需要 test-only-ready（测试）或 pmx-first-frame（Phase 3）
  signalAvatarReady: (): void => {
    ipcRenderer.send('chatx2:avatar-placeholder-ready');
  },

  // Phase 3 Task 3.2：通知主进程真实 PMX 首帧结果
  // success=true 时设置 pmx-first-frame 证据（可授权 Desktop 切换）
  // success=false 时清除证据并记录错误
  signalPmxFirstFrame: (success: boolean, error?: string): void => {
    ipcRenderer.send('chatx2:pmx-first-frame', { success, error });
  },

  // Phase 3 Task 3.2：加载 PMX 模型文件（返回 ArrayBuffer）
  // 主进程读取模型文件并返回；sandbox renderer 不能直接访问文件系统
  loadPmxModel: (): Promise<ArrayBuffer> => ipcRenderer.invoke('chatx2:load-pmx-model'),

  // Phase 3 Task 3.2：加载纹理文件（返回 ArrayBuffer 或 null）
  // relativePath 相对于模型目录
  loadTexture: (relativePath: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('chatx2:load-texture', relativePath),

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

  // Phase 5.1 P0-A/B/C + Phase 5.2 修正：接收来自主进程的 play 信号（携带 wavBytes + 可选 semantic）。
  // 主进程在收到 Composer 的 audio:play(taskId) 后，校验 taskId 在 wavCache 中，
  // 取出 wavBytes，转发 avatar:play(taskId, wavBytes, semantic?) 给 Avatar 窗口。
  // Avatar 收到后：
  //   1. 确保 AudioContext.state === 'running'（必要时 await ctx.resume()）
  //   2. ctx.decodeAudioData(wavBytes) 解码
  //   3. 创建 sourceNode，sourceNode.start() 调度播放
  //   4. 调用 actorRuntime.speak() 开始张嘴
  //   5. sourceNode.start() 后调用 Planner 选择 gesture pack 并播放
  //   6. 发送 sendPerformanceStarted(taskId) 通知 Composer 显示字幕
  // 隐私边界：Avatar 只收到 taskId、wavBytes、semantic（emotion/intent），不收到对话文本。
  // semantic 是语义级 emotion/intent，不携带 packId/VMD 文件名/骨骼值（Planner 自行选择 pack）。
  //
  // Avatar 同步扩展：mute 参数（可选，默认 false）。
  //   mute=true 时 Avatar 不发声（sourceNode 不连接 destination），仅驱动口型/动作。
  //   用于 Chat 窗口自己播放语音时，让 Avatar 同步表演但不重复发声。
  onAvatarPlay: (cb: (taskId: string, wavBytes: ArrayBuffer, semantic?: Partial<PerformanceSemantic>, speechText?: string, mute?: boolean) => void): (() => void) => {
    const handler = (
      _e: unknown,
      taskId: string,
      wavBytes: ArrayBuffer,
      semantic?: Partial<PerformanceSemantic>,
      speechText?: string,
      mute?: boolean
    ): void => cb(taskId, wavBytes, semantic, speechText, mute);
    ipcRenderer.on('avatar:play', handler);
    return () => {
      ipcRenderer.removeListener('avatar:play', handler);
    };
  },

  loadTestMotionCandidate: (): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('chatx2:test-load-motion-candidate'),

  loadCandidateReviewMotion: (cueId: CandidateCueId): Promise<CandidateMotionPayload | null> =>
    ipcRenderer.invoke('chatx2:load-candidate-review-motion', cueId),

  // Phase 5.2 修正（2026-07-19）：接收主进程的 emotion 更新信号。
  // 用户要求：emotion 变化只能在安全边界切换动作族。
  // 主进程在 speaking 过程中根据对话语义决定新的 emotion/intent，通过此 IPC 通知 Avatar。
  // Avatar 收到后调用 Planner 重新选择 gesture pack，并通过 MotionPlayer 的 fade-out → fade-in 切换。
  // 主进程不传 packId/VMD 文件名/骨骼值，只传语义级 emotion/intent。
  onMotionEmotionUpdate: (cb: (emotion: string, intent?: string) => void): (() => void) => {
    const handler = (_e: unknown, emotion: string, intent?: string): void => cb(emotion, intent);
    ipcRenderer.on('motion:emotion-update', handler);
    return () => {
      ipcRenderer.removeListener('motion:emotion-update', handler);
    };
  },

  // Phase 5.2 修正（2026-07-19）：接收主进程的 motion 命令。
  // 主进程持有 MotionPackRegistry 和生命周期，Renderer 不能自行信任路径或未白名单 pack。
  // 主进程校验后通过此 IPC 通知 Renderer 执行 motion:load/play/stop/list 命令。
  // action='play' 时 semantic 必填，Renderer 根据 semantic 调用 Planner 选择 pack（不直接信任 packId）。
  onMotionCommand: (cb: (command: {
    action: 'load' | 'play' | 'stop' | 'list';
    packId?: string;
    semantic?: { emotion?: string; intent?: string; gestureFamily?: string };
  }) => void): (() => void) => {
    const handler = (
      _e: unknown,
      command: {
        action: 'load' | 'play' | 'stop' | 'list';
        packId?: string;
        semantic?: { emotion?: string; intent?: string; gestureFamily?: string };
      }
    ): void => cb(command);
    ipcRenderer.on('motion:command', handler);
    return () => {
      ipcRenderer.removeListener('motion:command', handler);
    };
  },

  // Phase 5.1 P0-A/B/C + P1-E：接收停止表演信号。
  // 触发场景：
  //   - 'interrupted'：Composer 发起 audioStop（新消息打断旧播放）
  //   - 'mode-change'：模式切换离开 desktop（主进程发起，P1-E 统一 stopPerformance）
  //   - 'cancel'：对话任务被取消
  // Avatar 收到后立即调用 stopPerformance()：
  //   - sourceNode.stop() + disconnect()
  //   - actorRuntime.stopSpeak() 清零口型
  //   - 发送 sendPerformanceEnded(taskId, 'interrupted') 通知主进程释放 wavCache
  onAvatarStopPlay: (cb: (reason: AvatarStopReason, taskId?: string) => void): (() => void) => {
    const handler = (_e: unknown, reason: AvatarStopReason, taskId?: string): void => cb(reason, taskId);
    ipcRenderer.on('avatar:stop-play', handler);
    return () => {
      ipcRenderer.removeListener('avatar:stop-play', handler);
    };
  },

  // Phase 5.1 P0-A/B/C：通知主进程表演已开始（Avatar → 主进程 → Composer）。
  // Avatar 在 AudioContext.state === 'running' 且 decodeAudioData 成功 且 sourceNode.start() 调度后调用。
  // Composer 收到 performance:started 后显示字幕。
  // 这是硬门的核心：在 performance:started 之前，Composer 不显示字幕、不设置 __composerSpeaking。
  // Phase 5.2 Task 5.2.6：可选携带 audioStartTime（AudioContext.currentTime 在 sourceNode.start() 时的值）
  // 供 Composer 字幕同步使用。向后兼容：未提供时为 undefined，主进程转发时检查 typeof。
  sendPerformanceStarted: (taskId: string, audioStartTime?: number): void => {
    if (typeof audioStartTime === 'number' && Number.isFinite(audioStartTime)) {
      ipcRenderer.send('performance:started', taskId, audioStartTime);
    } else {
      ipcRenderer.send('performance:started', taskId);
    }
  },

  // Phase 5.1 P0-A/B/C：通知主进程表演已结束（Avatar → 主进程 → Composer）。
  // 触发场景：
  //   - 'ended'：sourceNode.onended 自然结束
  //   - 'failed'：decodeAudioData 抛错或 sourceNode.start 抛错或 AudioContext 无法 resume
  //   - 'interrupted'：被 audioStop 或 mode-change 或 cancel 中断
  // 主进程收到后释放 wavCache[taskId]，转发给 Composer 隐藏字幕。
  sendPerformanceEnded: (taskId: string, reason: PerformanceEndReason): void => {
    ipcRenderer.send('performance:ended', taskId, reason);
  },

  // ============================================================
  // ChatX2 模型包管理 API
  // ============================================================
  listModelPacks: (): Promise<ModelPackListItem[]> =>
    ipcRenderer.invoke('chatx2:list-model-packs'),

  getCurrentModelPack: (): Promise<{ success: boolean; packId?: string; displayName?: string; internalName?: string; capabilities?: string[]; motions?: ModelPackMotions; physics?: ModelPackPhysics }> =>
    ipcRenderer.invoke('chatx2:get-current-model-pack'),

  switchModelPack: (packId: string): Promise<SwitchModelResult> =>
    ipcRenderer.invoke('chatx2:switch-model-pack', packId),

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
  }> => ipcRenderer.invoke('chatx2:list-all-motion-packs'),

  toggleMotionPack: (motionPackId: string, enabled: boolean, type: 'idle' | 'gesture'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-motion-pack', motionPackId, enabled, type),

  setDefaultIdle: (idlePackId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-default-idle', idlePackId),

  /** 将 customVmd 加入/移出待机轮换池 */
  toggleIdleVmd: (vmdPath: string, inPool: boolean): Promise<{ success: boolean; reason?: string; maxSlots?: number }> =>
    ipcRenderer.invoke('chatx2:toggle-idle-vmd', vmdPath, inPool),

  /** 预览指定动作包：主进程从模型管理面板转发给 Avatar 窗口 */
  onPreviewMotionPack: (cb: (payload: { packId: string; type: 'idle' | 'gesture' }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { packId: string; type: 'idle' | 'gesture' }): void => cb(payload);
    ipcRenderer.on('chatx2:preview-motion-pack', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:preview-motion-pack', handler);
    };
  },

  /** 预览自定义 VMD：主进程转发给 Avatar 窗口即时播放 */
  onPreviewCustomVmd: (cb: (payload: { relativePath: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { relativePath: string }): void => cb(payload);
    ipcRenderer.on('chatx2:preview-custom-vmd', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:preview-custom-vmd', handler);
    };
  },

  onPreviewMotionCandidate: (cb: (record: MotionCandidateRecord, bytes: ArrayBuffer) => void): (() => void) => {
    const handler = (_e: unknown, record: MotionCandidateRecord, bytes: ArrayBuffer): void => cb(record, bytes);
    ipcRenderer.on('chatx2:preview-motion-candidate', handler);
    return () => ipcRenderer.removeListener('chatx2:preview-motion-candidate', handler);
  },

  onPreviewExpressionCandidate: (cb: (record: ExpressionCandidateRecord) => void): (() => void) => {
    const handler = (_e: unknown, record: ExpressionCandidateRecord): void => cb(record);
    ipcRenderer.on('chatx2:preview-expression-candidate', handler);
    return () => ipcRenderer.removeListener('chatx2:preview-expression-candidate', handler);
  },

  onAcceptedExpressionsChanged: (cb: (entries: readonly AcceptedExpressionRecord[]) => void): (() => void) => {
    const handler = (_e: unknown, entries: readonly AcceptedExpressionRecord[]): void => cb(entries);
    ipcRenderer.on('chatx2:accepted-expressions-changed', handler);
    return () => ipcRenderer.removeListener('chatx2:accepted-expressions-changed', handler);
  },

  getAcceptedExpressions: (): Promise<readonly AcceptedExpressionRecord[]> =>
    ipcRenderer.invoke('chatx2:get-accepted-expressions'),

  /** Unified short/medium/long VMD preview request with actual playback acknowledgement. */
  onPreviewVmd: (cb: (payload: { requestId: string; relativePath: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { requestId: string; relativePath: string }): void => cb(payload);
    ipcRenderer.on('chatx2:preview-vmd', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:preview-vmd', handler);
    };
  },

  /** 预览项目外备选 VMD：主进程直接传递字节，不落盘、不加入动作池 */
  onPreviewRawVmd: (cb: (payload: { requestId: string; displayName: string; bytes: ArrayBuffer }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { requestId: string; displayName: string }, bytes: ArrayBuffer): void => {
      cb({ ...payload, bytes });
    };
    ipcRenderer.on('chatx2:preview-raw-vmd', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:preview-raw-vmd', handler);
    };
  },

  sendPreviewVmdResult: (result: { requestId: string; success: boolean; reason?: string; packId?: string }): void => {
    ipcRenderer.send('chatx2:preview-vmd-result', result);
  },

  /** 待机动作暂停/恢复：Composer 窗口触发 */
  onToggleIdlePaused: (cb: (payload: { paused: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { paused: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:toggle-idle-paused', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:toggle-idle-paused', handler);
    };
  },

  /** Read the authoritative main-process state after renderer/model reload. */
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
  getGazeLock: (): Promise<{ locked: boolean }> =>
    ipcRenderer.invoke('chatx2:get-gaze-lock'),
  onGazeLockChanged: (cb: (payload: { locked: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { locked: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:gaze-lock-changed', handler);
    return () => ipcRenderer.removeListener('chatx2:gaze-lock-changed', handler);
  },

  /** 全局默认表情：读主进程权威状态（跨模型统一偏好） */
  getDefaultExpression: (): Promise<{ expression: string }> =>
    ipcRenderer.invoke('chatx2:get-default-expression'),
  setDefaultExpression: (expression: string): Promise<{ success: boolean; expression: string; reason?: string }> =>
    ipcRenderer.invoke('chatx2:set-default-expression', expression),
  onDefaultExpressionChanged: (cb: (expression: string) => void): (() => void) => {
    const handler = (_e: unknown, expression: string): void => cb(expression);
    ipcRenderer.on('chatx2:default-expression-changed', handler);
    return () => ipcRenderer.removeListener('chatx2:default-expression-changed', handler);
  },
  /** 右键菜单：渲染进程提供菜单树，主进程用 native Menu.popup() 弹出 */
  openAvatarContextMenu: (items: ReadonlyArray<AvatarContextMenuItemPayload>): void => {
    ipcRenderer.send('chatx2:open-avatar-context-menu', items);
  },
  onAvatarContextMenuSelected: (cb: (id: string) => void): (() => void) => {
    const handler = (_e: unknown, id: string): void => cb(id);
    ipcRenderer.on('chatx2:avatar-context-menu-selected', handler);
    return () => ipcRenderer.removeListener('chatx2:avatar-context-menu-selected', handler);
  },

  /** 打光预设切换：主进程转发给 Avatar 窗口 */
  onSetLighting: (cb: (payload: { presetId: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { presetId: string }): void => cb(payload);
    ipcRenderer.on('chatx2:set-lighting', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-lighting', handler);
    };
  },

  onTransitionSpeedChanged: (cb: (multiplier: number) => void): (() => void) => {
    const handler = (_e: unknown, multiplier: number): void => cb(multiplier);
    ipcRenderer.on('chatx2:set-transition-speed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-transition-speed', handler);
    };
  },

  getTransitionSpeed: (): Promise<{ value: number }> =>
    ipcRenderer.invoke('chatx2:get-transition-speed'),

  /** 动态打光调节：主进程转发给 Avatar 窗口 */
  onSetLightingDynamic: (cb: (params: { keyIntensity?: number; keyX?: number; keyY?: number; keyZ?: number; fillIntensity?: number; rimIntensity?: number; hemiIntensity?: number; contrast?: number; saturation?: number }) => void): (() => void) => {
    const handler = (_e: unknown, params: { keyIntensity?: number; keyX?: number; keyY?: number; keyZ?: number; fillIntensity?: number; rimIntensity?: number; hemiIntensity?: number; contrast?: number; saturation?: number }): void => cb(params);
    ipcRenderer.on('chatx2:set-lighting-dynamic', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-lighting-dynamic', handler);
    };
  },

  /** 渲染精度切换：主进程转发给 Avatar 窗口 */
  onSetRenderQuality: (cb: (payload: { level: 'low' | 'medium' | 'high' | 'ultra' }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { level: 'low' | 'medium' | 'high' | 'ultra' }): void => cb(payload);
    ipcRenderer.on('chatx2:set-render-quality', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-render-quality', handler);
    };
  },

  getRenderQuality: (): Promise<{ level: 'low' | 'medium' | 'high' | 'ultra' }> =>
    ipcRenderer.invoke('chatx2:get-render-quality'),

  /** 表情切换：主进程转发给 Avatar 窗口 */
  onSetExpression: (cb: (payload: { expressionId: string; channel?: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { expressionId: string; channel?: string }): void => cb(payload);
    ipcRenderer.on('chatx2:set-expression', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-expression', handler);
    };
  },

  /** 预览长时间 VMD：主进程转发给 Avatar 窗口即时播放 */
  onPreviewLongVmd: (cb: (payload: { relativePath: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { relativePath: string }): void => cb(payload);
    ipcRenderer.on('chatx2:preview-long-vmd', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:preview-long-vmd', handler);
    };
  },

  /** 视角模式切换：主进程转发给 Avatar 窗口（全身/半身） */
  onSetCameraView: (cb: (mode: 'full' | 'half') => void): (() => void) => {
    const handler = (_e: unknown, mode: 'full' | 'half'): void => cb(mode);
    ipcRenderer.on('chatx2:set-camera-view', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-camera-view', handler);
    };
  },

  /** 模型手动朝向：主进程转发给 Avatar renderer */
  onSetModelRotation: (cb: (payload: { yaw: number; pitch: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { yaw: number; pitch: number }): void => cb(payload);
    ipcRenderer.on('chatx2:set-model-rotation', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-model-rotation', handler);
    };
  },

  /** 模型缩放：主进程转发给 Avatar 窗口（delta: 正=放大，负=缩小） */
  onSetModelScale: (cb: (delta: number) => void): (() => void) => {
    const handler = (_e: unknown, delta: number): void => cb(delta);
    ipcRenderer.on('chatx2:set-model-scale', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-model-scale', handler);
    };
  },

  /** 加载自定义 VMD 字节（供 Avatar 播放） */
  loadCustomVmdBytes: (relativePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('chatx2:load-custom-vmd', relativePath),

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
  // 桌宠窗口控制 API
  // ============================================================

  /** 退出桌宠模式：隐藏 Avatar + Composer 窗口，切回 chat 模式 */
  exitDesktop: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:exit-desktop'),

  /** 移动桌宠窗口位置（屏幕像素偏移） */
  moveAvatarWindow: (deltaX: number, deltaY: number): Promise<void> =>
    ipcRenderer.invoke('chatx2:move-avatar-window', deltaX, deltaY),

  /** 请求设置手动模型穿透开关（用户点击"模型穿透"按钮时调用）。
   *  主进程 ipcMain.handle 注册，必须用 invoke 才能生效（2026-07-29 修复）。
   *  manual=false → forward模式（模型外穿透、模型内可交互）
   *  manual=true  → 完全穿透（模型+模型外都不可交互） */
  setModelPassThrough: (manual: boolean): Promise<void> =>
    ipcRenderer.invoke('chatx2:set-model-pass-through', manual).then(() => undefined),

  /** 订阅主进程转发的手动模型穿透请求（Composer 按钮点击经主进程转发到 Avatar）。
   *  Avatar renderer 是唯一事实源，收到后更新 manualModelPassThrough、广播变化、重算窗口物理穿透。 */
  onSetModelPassThrough: (cb: (manual: boolean) => void): (() => void) => {
    const handler = (_e: unknown, manual: boolean): void => cb(manual);
    ipcRenderer.on('chatx2:set-model-pass-through', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:set-model-pass-through', handler);
    };
  },

  /** Main-process system cursor probe result; keeps the hover cursor responsive. */
  onNativeAvatarHover: (cb: (onModel: boolean) => void): (() => void) => {
    const handler = (_e: unknown, onModel: boolean): void => cb(onModel);
    ipcRenderer.on('chatx2:native-avatar-hover', handler);
    return () => ipcRenderer.removeListener('chatx2:native-avatar-hover', handler);
  },

  /** 订阅手动模型穿透开关变化（仅用户意图，不含 hover 自动状态）。
   *  Avatar → Composer：广播 manualModelPassThrough 变化。 */
  onModelPassThroughChanged: (cb: (payload: { manual: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { manual: boolean }): void => cb(payload);
    ipcRenderer.on('chatx2:model-pass-through-changed', handler);
    return () => {
      ipcRenderer.removeListener('chatx2:model-pass-through-changed', handler);
    };
  },

  /** 广播手动模型穿透开关变化（Avatar → 主进程 → Composer）。
   *  仅在 manualModelPassThrough 因用户意图变化时调用，hover 物理状态变化绝不调用。 */
  notifyModelPassThroughChanged: (payload: { manual: boolean }): Promise<void> => {
    ipcRenderer.send('chatx2:model-pass-through-changed', payload);
    return Promise.resolve();
  },

  /** 应用公式计算出的窗口物理穿透状态。
   *  Avatar → 主进程：调用 BrowserWindow.setIgnoreMouseEvents(effectiveIgnoreMouse, {forward:true})。
   *  使用 sendSync 同步执行，避免 forward 模式下 mousedown 丢失。 */
  applyAvatarMousePolicy: (effectiveIgnoreMouse: boolean): Promise<void> => {
    ipcRenderer.sendSync('chatx2:apply-avatar-mouse-policy', effectiveIgnoreMouse);
    return Promise.resolve();
  },

  /**
   * Brackets a model drag so the Windows-level hover probe cannot turn mouse
   * passthrough back on while the model is moving under a stationary cursor.
   */
  setAvatarDragging: (dragging: boolean): void => {
    ipcRenderer.send('chatx2:avatar-dragging', dragging);
  },

  /** 全屏模式下调整 3D 模型缩放（delta: 正=放大，负=缩小） */
  setModelScale: (delta: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:set-model-scale', delta),

  /** 切换窗口置顶状态 */
  toggleAlwaysOnTop: (onTop: boolean): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chatx2:toggle-always-on-top', onTop)
};

contextBridge.exposeInMainWorld('chatx2', api);
