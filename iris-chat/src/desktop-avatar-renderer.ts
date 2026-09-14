// Desktop Avatar renderer（Phase 3 Task 3.3 - 运行时更换）
// 职责：使用 @yohawing/three-mmd-loader 加载真实 PMX 模型并渲染
// 重要：模型只读，不得修改/转换/上传/分发
// 失败时回退到 placeholder-canvas 并通过 signalAvatarReady 通知（保持向后兼容）
//
// 运行时更换原因（2026-07-18）：
// - three@0.185.1 从 r172 起删除了官方 MMDLoader，手写 BufferGeometry 方案存在 4 个 bug
// - @yohawing/three-mmd-loader 支持 three >=0.176 <1.0，覆盖 r185
// - 该库正确处理骨骼/IK/Morph/Toon 材质/物理，PMX 坐标系转换由库内部完成
//
// 修复的 4 个 bug：
// 1. morphTargetsRelative = true（由库自动设置，PMX morph 偏移是相对的）
// 2. FaceRed 0.35 上限（morphControl.setWeight 中应用安全范围）
// 3. 纹理异步加载（loadModel() 是 async，resolve 后纹理已加载）
// 4. ActorRuntime 绑定（morphControl 直接操作 model.mesh.morphTargetInfluences）

import * as THREE from 'three';
import { BUILD_ID } from './build-identity';
import { lightingCanvasFilter } from './lighting/contrast';
import { ThreeMmdLoader, normalizeMmdTexturePath, disposeMmdModel, type ThreeMmdModel } from '@yohawing/three-mmd-loader';
import { initMorphPanel } from './desktop-avatar/morph-panel';
import {
  applyMmdMaterialCompatibility,
  computeSha256Hex,
  type MmdMaterialCompatibilityManifest
} from './desktop-avatar/mmd-material-compatibility';
import {
  disableInvisibleMaterialDepthWrite,
  replaceMmdMaterialsWithStandard
} from './desktop-avatar/mmd-material-conversion';
import { createViewerControls, type ViewerControls } from './desktop-avatar/viewer-controls';
import { ModelRootDragController } from './desktop-avatar/model-root-drag-controller';
import {
  RootDragSecondaryAttachmentController,
  selectRootDragAttachmentBones
} from './physics/root-drag-secondary-attachment';
import { ModelUserFacingController } from './desktop-avatar/model-user-facing-controller';
import { buildIdleQuickSlots } from './model-pack/idle-quick-slots';
import { ActorRuntime, type AvatarManifest, type Emotion } from './actor/actor-runtime';
import {
  selectValidatedProfile,
  type AvatarPerformanceProfile,
  type ProfileValidationResult
} from './actor/avatar-performance-profile';
import { PupilController } from './actor/pupil-controller';
import { createAvatarMorphControl, createMeshMorphSink } from './actor/three-morph-bridge';
import { syncMorphSplitTargetInfluences } from './actor/morph-split-sync';
import {
  ProceduralLifeController,
  shouldOverlayIdleBreathing,
  type LifeBones
} from './actor/procedural-life-controller';
import { GazeController, type GazeBones } from './actor/gaze-controller';
import {
  RelaxedBasePoseController,
  type RelaxedBasePoseBones
} from './actor/relaxed-base-pose';
import { stepAvatarFrame, type AvatarFramePorts } from './actor/avatar-frame-loop';
import { AvatarLoopController } from './actor/avatar-loop-controller';
import { AvatarPerformanceSession } from './performance/avatar-performance-session';
import {
  AudioPreparationCancelledError,
  AudioPreloader
} from './performance/audio-preloader';
import {
  resolvePlaybackSemantic,
  type PerformanceSemantic
} from './performance/semantic-performance';
import type { VmdEmotionEntry } from './performance/performance-planner';
import { resolveModelMotionTuning, type ModelPackMotionTuning, type ResolvedModelMotionTuning } from './model-pack/model-pack-types';
import {
  isAutomaticVoiceAction,
  isExactAutomaticVoiceSelection,
  isVoiceActionPoolEntry
} from './performance/voice-action-pool';
import { getProtectedHeadVoiceAction } from './performance/protected-head-voice-actions';
import { SpeechMotionDirector } from './performance/speech-motion-director';
import {
  getAvatarComputeProfile,
  type AvatarComputeLevel
} from './performance/avatar-compute-profile';
import { SpeechStanceDirector } from './performance/speech-stance-director';
import {
  buildSpeechExpressionPool,
  getSupportedSpeechExpressionChannels,
  type SpeechExpressionPoolEntry
} from './performance/speech-expression-pool';
import type { FacialChannel } from './performance/facial-pose';
import type { CandidateCueId } from './performance/candidate-review-performance';
import type { CandidateMotionPayload } from '../electron/candidate-review-motion-catalog';
import type {
  AcceptedExpressionRecord,
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from './performance/daily-candidate-types';
import { performanceStopReasonForAvatarSignal } from '../electron/avatar-sync-stop-policy';
import {
  buildSpeechPlannerExclusions,
  coordinateSpeechMotionSemantic,
  resolveSpeechGazeSemantic,
  selectSpeechBackgroundVmd,
  shouldDispatchSpeechGesture,
  shouldDeferSpeechGestureForCurrentOwner,
  shouldUseSpeechBackgroundForCue,
  shouldRestoreSpeechBackground,
  SpeechCueDispatchState,
  type SpeechPerformanceCue
} from './performance/speech-performance-timeline';
import { BoneOwnershipRegistry, MorphOwnershipRegistry } from './actor/bone-ownership-registry';
import { MotionPlayer } from './motion/motion-player';
import { resolvePlayableAvatarMaxFrame } from './motion/motion-player';
import { AvatarMotionArbiter } from './motion/avatar-motion-arbiter';
import {
  IdleLifecycleController,
  pickNextIdleId,
  shouldStartDefaultIdle,
  type IdleLifecycleDecision
} from './motion/idle-lifecycle';
import { MotionRequestSupersededError } from './motion/motion-request-gate';
import {
  HEAD_OVERLAY_DEFINITIONS,
  HeadOverlayController,
  resolveHeadOverlayId,
  resolveInwardHeadDirection,
  validateHeadOverlayTracks
} from './motion/head-overlay';
import { MotionSequence } from './motion/motion-sequence';
import { AvatarMousePolicyController } from './click-through-policy';
import { getIdlePackBytes, getAllIdlePackIds, getIdlePackManifest, initializeIdlePackHashes } from './motion/idle-packs';
import {
  getGesturePackBytes,
  getGesturePackManifest,
  initializeGesturePackHashes,
  GESTURE_PACK_IDS
} from './motion/gesture-packs';
import {
  DEFAULT_AMPLITUDE_LIMITS,
  loadVmd,
  hasCompatibleBoneTracks,
  getVmdParseCacheStats
} from './motion/motion-pack-loader';
import {
  canStartSpeechMotion,
  DEFAULT_SPEECH_MOTION_RATE
} from './performance/speech-motion-pacing';
import { resolveSpeechMotionStyle } from './performance/speech-motion-style';
import type { TransitionBridgeProfile } from './motion/motion-transition-bridge';
import type { MotionCompositionMode } from './motion/pose-composition';
import {
  auditPmxPhysics,
  loadBulletPhysics,
  getBulletBackend,
  disposeBulletPhysics,
  resolveUnifiedDynamicBonePolicy,
  resolveModelSpecificDisabledDynamicBones,
  type PmxPhysicsAudit
} from './physics/avatar-physics-runtime';
import manifestJson from './actor/selena/avatar-manifest.json';
import selenaPerformanceProfileJson from '../models/selena-xisheng/performance-profile.json';
import yangyangPerformanceProfileJson from '../models/yyxuanling/performance-profile.json';

export {};

type AppMode = 'chat' | 'loading' | 'desktop' | 'scene';

interface ModeChangeEvent {
  from: AppMode;
  to: AppMode;
  reason?: string;
}

/** 原生右键菜单项（渲染进程序列化 → 主进程 Menu.buildFromTemplate）。 */
export type AvatarContextMenuItem =
  | { id: string; label: string; type: 'normal' | 'checkbox'; checked?: boolean; disabled?: boolean }
  | { id: string; label: string; type: 'submenu'; submenu: AvatarContextMenuItem[] }
  | { id: string; type: 'separator' };

interface ChatX2Api {
  /** 原生右键菜单：渲染进程提供菜单树，主进程用 native Menu.popup() 弹出（保证在透明穿透窗口上可见） */
  openAvatarContextMenu: (items: ReadonlyArray<AvatarContextMenuItem>) => void;
  /** 用户点击了原生菜单的某个 item，回调其 id */
  onAvatarContextMenuSelected: (cb: (id: string) => void) => (() => void);
  getIdentity: () => Promise<{
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
  }>;
  signalAvatarReady: () => void;
  signalPmxFirstFrame: (success: boolean, error?: string) => void;
  loadPmxModel: () => Promise<ArrayBuffer>;
  loadTexture: (relativePath: string) => Promise<ArrayBuffer | null>;
  /** Phase 3 Step 6.2：获取当前模式（用于初始化时决定是否启动循环） */
  getMode: () => Promise<AppMode>;
  /** Phase 3 Step 6.2：订阅 mode-change 事件，desktop 时 start，chat 时 stop */
  onModeChange: (cb: (event: ModeChangeEvent) => void) => (() => void);
  /** Phase 5.1 P0-A/B/C：接收来自主进程的 play 信号（携带 wavBytes + 可选语义级 emotion/intent） */
  /** mute=true 时 Avatar 不发声，仅驱动口型/动作（Chat 窗口同步播放时使用） */
  onAvatarPlay: (cb: (taskId: string, wavBytes: ArrayBuffer, semantic?: Partial<PerformanceSemantic>, speechText?: string, mute?: boolean) => void) => (() => void);
  /** Phase 5.1 P0-A/B/C + P1-E：接收停止表演信号（interrupted/mode-change/cancel/ended） */
  onAvatarStopPlay: (cb: (reason: 'interrupted' | 'mode-change' | 'cancel' | 'ended', taskId?: string) => void) => (() => void);
  /** Phase 5.1 P0-A/B/C：通知主进程表演已开始（Avatar → 主进程 → Composer 显示字幕） */
  sendPerformanceStarted: (taskId: string, audioStartTime?: number) => void;
  /** Phase 5.1 P0-A/B/C：通知主进程表演已结束（Avatar → 主进程 → Composer 隐藏字幕 + 释放 wavCache） */
  sendPerformanceEnded: (taskId: string, reason: 'ended' | 'failed' | 'interrupted') => void;
  /**
   * Phase 5.2 修正（2026-07-19）：接收主进程的 emotion 更新信号。
   * 用于在 speaking 过程中安全边界切换动作族（Planner 重新选择 gesture pack）。
   * 主进程通过 ConversationController 在语义级别决定 emotion，不传 packId/VMD 文件名/骨骼值。
   */
  onMotionEmotionUpdate: (cb: (emotion: string, intent?: string) => void) => (() => void);
  /**
   * Phase 5.2 修正（2026-07-19）：接收主进程的 motion IPC 信号。
   * 主进程持有 MotionPackRegistry 和生命周期，Renderer 不能自行信任路径或未白名单 pack。
   * 主进程校验后通过此 IPC 通知 Renderer 加载/播放/停止/列出 motion pack。
   */
  onMotionCommand: (cb: (command: { action: 'load' | 'play' | 'stop' | 'list'; packId?: string; semantic?: { emotion?: string; intent?: string; gestureFamily?: string } }) => void) => (() => void);
  loadTestMotionCandidate?: () => Promise<ArrayBuffer>;
  loadCandidateReviewMotion: (cueId: CandidateCueId) => Promise<CandidateMotionPayload | null>;
  /**
   * 预览指定动作包：从模型管理面板发送，Avatar 窗口即时播放。
   * - type='idle'：循环播放该 idle pack
   * - type='gesture'：播放一次该 gesture pack
   */
  onPreviewMotionPack: (cb: (payload: { packId: string; type: 'idle' | 'gesture' }) => void) => (() => void);
  /** 预览自定义 VMD：主进程转发给 Avatar 窗口即时播放 */
  onPreviewCustomVmd: (cb: (payload: { relativePath: string }) => void) => (() => void);
  onPreviewMotionCandidate: (cb: (record: MotionCandidateRecord, bytes: ArrayBuffer) => void) => (() => void);
  onPreviewExpressionCandidate: (cb: (record: ExpressionCandidateRecord) => void) => (() => void);
  getAcceptedExpressions: () => Promise<readonly AcceptedExpressionRecord[]>;
  onAcceptedExpressionsChanged: (cb: (entries: readonly AcceptedExpressionRecord[]) => void) => (() => void);
  onPreviewVmd: (cb: (payload: { requestId: string; relativePath: string }) => void) => (() => void);
  onPreviewRawVmd: (cb: (payload: { requestId: string; displayName: string; bytes: ArrayBuffer }) => void) => (() => void);
  sendPreviewVmdResult: (result: { requestId: string; success: boolean; reason?: string; packId?: string }) => void;
  /** 打光预设切换：主进程转发给 Avatar 窗口 */
  onSetLighting: (cb: (payload: { presetId: string }) => void) => (() => void);
  onTransitionSpeedChanged: (cb: (multiplier: number) => void) => (() => void);
  getTransitionSpeed: () => Promise<{ value: number }>;
  /** 表情切换：主进程转发给 Avatar 窗口 */
  onSetExpression: (cb: (payload: { expressionId: string; channel?: FacialChannel }) => void) => (() => void);
  /**
   * 渲染精度切换：主进程转发给 Avatar 窗口。
   * low/medium/high/ultra 分别对应不同的像素比/抗锯齿/阴影配置。
   */
  onSetRenderQuality: (cb: (payload: { level: 'low' | 'medium' | 'high' | 'ultra' }) => void) => (() => void);
  getRenderQuality: () => Promise<{ level: 'low' | 'medium' | 'high' | 'ultra' }>;
  /** 加载自定义 VMD 字节 */
  loadCustomVmdBytes: (relativePath: string) => Promise<ArrayBuffer>;
  /** 动态打光调节：主进程转发给 Avatar 窗口 */
  onSetLightingDynamic: (cb: (params: { keyIntensity?: number; keyX?: number; keyY?: number; keyZ?: number; fillIntensity?: number; rimIntensity?: number; hemiIntensity?: number; contrast?: number; saturation?: number }) => void) => (() => void);
  /** 预览长时间 VMD：主进程转发给 Avatar 窗口即时播放 */
  onPreviewLongVmd: (cb: (payload: { relativePath: string }) => void) => (() => void);
  /** 视角模式切换回调（全身/半身） */
  onSetCameraView: (cb: (mode: 'full' | 'half') => void) => (() => void);
  /** 手动模型朝向（角度）：左右 ±45°、上下 ±30° */
  onSetModelRotation: (cb: (payload: { yaw: number; pitch: number }) => void) => (() => void);
  /** 待机动作暂停/恢复回调 */
  onToggleIdlePaused: (cb: (payload: { paused: boolean }) => void) => (() => void);
  getIdlePaused: () => Promise<{ paused: boolean }>;
  setPoseLock: (locked: boolean) => Promise<{ success: boolean; locked: boolean }>;
  togglePoseLock: () => Promise<{ success: boolean; locked: boolean }>;
  getPoseLock: () => Promise<{ locked: boolean }>;
  onPoseLockChanged: (cb: (payload: { locked: boolean }) => void) => (() => void);
  getDefaultExpression: () => Promise<{ expression: string }>;
  setDefaultExpression: (expression: string) => Promise<{ success: boolean; expression: string; reason?: string }>;
  onDefaultExpressionChanged: (cb: (expression: string) => void) => (() => void);
  getGazeLock: () => Promise<{ locked: boolean }>;
  onGazeLockChanged: (cb: (payload: { locked: boolean }) => void) => (() => void);
  /** 模型缩放回调（delta: 正=放大，负=缩小） */
  onSetModelScale: (cb: (delta: number) => void) => (() => void);
  /**
   * Phase 5.2 Task 5.2.x：读取当前模型包配置（idle/gesture 启用列表、默认 idle）。
   */
  getCurrentModelPack: () => Promise<{ success: boolean; packId?: string; displayName?: string; internalName?: string; capabilities?: string[]; manifest?: any; motions?: { idlePacks: string[]; gesturePacks: string[]; defaultIdle: string; customVmd: string[] }; physics?: { disabledDynamicBones?: string[] }; lighting?: { currentPreset: string; presets: Record<string, any>; dynamic?: Record<string, number> } }>;
  /**
   * Phase 5.2 Task 5.2.x：模型包配置变更通知（UI 切换动作开关 / 设置默认 idle 后）。
   */
  onModelPackChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void) => (() => void);
  onMotionConfigChanged: (cb: (payload: { packId: string; displayName: string; sha256: string }) => void) => (() => void);
  /** 退出桌宠模式：隐藏窗口，切回 chat */
  exitDesktop: () => Promise<{ success: boolean }>;
  /** 移动桌宠窗口位置（屏幕像素偏移） */
  moveAvatarWindow: (deltaX: number, deltaY: number) => Promise<void>;
  /** 请求设置手动模型穿透开关（Composer → Avatar renderer） */
  setModelPassThrough?: (manual: boolean) => Promise<void>;
  /** 订阅主进程转发的手动模型穿透请求（Composer 按钮经主进程转发到 Avatar） */
  onSetModelPassThrough?: (cb: (manual: boolean) => void) => (() => void);
  onNativeAvatarHover?: (cb: (onModel: boolean) => void) => (() => void);
  /** 订阅手动模型穿透开关变化（Avatar → Composer，仅用户意图） */
  onModelPassThroughChanged?: (cb: (payload: { manual: boolean }) => void) => (() => void);
  /** 广播手动模型穿透开关变化（Avatar → 主进程 → Composer，仅用户意图变化时调用） */
  notifyModelPassThroughChanged?: (payload: { manual: boolean }) => Promise<void>;
  /** 应用公式计算出的窗口物理穿透状态（Avatar → 主进程） */
  applyAvatarMousePolicy?: (effectiveIgnoreMouse: boolean) => Promise<void>;
  /** Keeps the native hover probe from restoring passthrough during a drag. */
  setAvatarDragging?: (dragging: boolean) => void;
  /** 调整 3D 模型缩放 */
  setModelScale: (delta: number) => Promise<{ success: boolean }>;
  /** 切换桌宠窗口置顶状态 */
  toggleAlwaysOnTop: (onTop: boolean) => Promise<{ success: boolean }>;
}

interface AvatarRenderer {
  cleanup: () => void;
}

let rendererInstance: AvatarRenderer | null = null;

/**
 * 运行时 API 命名空间。
 * contextBridge.exposeInMainWorld('chatx2', ...) 创建只读代理，
 * 渲染器无法在其上添加新属性。因此 morphControl / cameraControl / actorRuntime 等运行时 API
 * 通过 window.__chatx2Runtime 暴露，该对象可由渲染器自由写入。
 */
interface ChatX2Runtime {
  morphControl?: unknown;
  cameraControl?: unknown;
  /** 手动触发一次渲染（例如拖拽后直接更新画面） */
  render?: () => void;
  __testIsPointOnModel?: (x: number, y: number) => boolean;
  __testGetAvatarMousePolicy?: () => unknown;
  actorRuntime?: ActorRuntime;
  /** Phase 5.2 Task 5.2.6：表演会话（PerformanceClock + LipTimeline + Planner 集成） */
  performanceSession?: AvatarPerformanceSession;
  /**
   * Phase 5.2B：VMD 动作播放器（封装 loadAnimation → setAnimation → update → stop）。
   * 接入 BoneOwnershipRegistry + MorphOwnershipRegistry 实现 VMD 与 procedural 仲裁。
   * E2E 通过此 API 检查播放状态、当前 packId、骨骼/morph 名列表、blink 轨道。
   */
  motionPlayer?: {
    play(packId: string, vmdBytes: Uint8Array | ArrayBuffer, options?: {
      boneMapping?: Record<string, string>;
      amplitudeLimits?: typeof DEFAULT_AMPLITUDE_LIMITS;
      looping?: boolean;
      /**
       * Phase 5.2 修正（2026-07-19）：时间源注入。
       * - 'local-clock'：单调本地时钟（performance.now()/1000），idle 使用
       * - 'performance-clock'：PerformanceClock.now()，与 AudioContext 对齐，speaking 使用
       * AudioContext 未运行/未对齐时禁止启动 speaking motion（validateSpeakingMotionStart）
       */
      timeSource?: 'local-clock' | 'performance-clock';
      /** 最小 0.5 秒 fade-in（用户硬规则） */
      fadeInSeconds?: number;
      /** 最小 0.5 秒 fade-out（用户硬规则） */
      fadeOutSeconds?: number;
      /** 同一 pack 至少 N 秒不重复（idle ≥ 30s，gesture ≥ 5s） */
      cooldownSeconds?: number;
      /** emotion 变化时强制切换（绕过 cooldown） */
      force?: boolean;
      /**
       * Phase 5.2B.3 Closeout Task 3：组合模式。
       * 只能由本地注册的 manifest 提供，不允许 IPC 或 AI 传入。
       * - 'additive-from-base'：内部程序化 VMD，叠加在 relaxed base pose 上
       * - 'absolute' 或 undefined：外部 VMD，直接覆盖
       */
      compositionMode?: MotionCompositionMode;
      /** Local manifest/test policy only; never accepted from AI or motion IPC. */
      candidateTrackPolicy?: 'standard-upper-body' | 'dialogue-body-only' | 'grounded-full-body' | 'trusted-voice-full-body';
      /** Internal reply-owned stance; used only with performance-clock. */
       speechStance?: import('./performance/speech-stance-director').SpeechStanceProfile;
       /** Generated rotation-only balance accent for selected speech gestures. */
       speechStanceAccent?: import('./performance/speech-stance-director').SpeechStanceAccent;
       /** Rotation-only lower-body source retention for the speech role. */
       speechStanceSourceRetention?: number;
       /** Internal timing profile used only for deliberate pose handoffs. */
       transitionProfile?: TransitionBridgeProfile;
       /** VMD-only sampling rate; audio/subtitle clocks remain unchanged. */
      playbackRate?: number;
      /** Candidate VMD morph tracks remain available to the separate expression preview. */
      candidateExpressionPolicy?: 'separate';
    }): Promise<void>;
    stop(): void;
    /** Switch an ended speech clip to the monotonic cleanup clock before fade-out. */
    handoffToLocalClock(): void;
    /**
     * Phase 5.2 修正：紧急停止（mode-change/cleanup/interrupted/failed）。
     * 与 stop() 的区别：不进行 fade-out，立即清零骨骼并释放 lease。
     */
    stopImmediate(): void;
    setOnStop(callback: (() => void) | null): void;
    setOnNaturalEnd(callback: (() => void) | null): void;
    isPlaying(): boolean;
    getState(): 'idle' | 'bridging' | 'fading-in' | 'playing' | 'fading-out';
    getCurrentPackId(): string | null;
    getAnimationDuration(): number;
    getCurrentAnimationTime(): number;
    getCurrentModelUpdateTime(): number;
    getPlaybackRate(): number;
    getCurrentBoneNames(): string[];
    getModelBoneNames(): string[];
    getCurrentMorphNames(): string[];
    hasBlinkTrack(): boolean;
    /**
     * Phase 5.2 修正：每帧 fade 混合（在 model.update() 之后调用）。
     * 实现 fading-in/fading-out 期间的 slerp 四元数插值，
     * 避免动作切换时瞬间 reset 到 Base Pose。
     */
    applyFadeBlend(): void;
    /**
     * Phase 5.2B.3 Closeout Task 3：每帧姿态组合（在 model.update() 之后、applyFadeBlend() 之前调用）。
     * - absolute 模式：no-op
     * - additive-from-base 模式：把 VMD 采样的绝对姿态转为 base * inverse(rest) * sampled
     */
    applyPoseComposition(): void;
    setPoseLocked(locked: boolean): boolean;
    isPoseLocked(): boolean;
  };
  /**
   * Phase 5.2B 扩展：链式多段 VMD 播放器（MotionSequence）。
   * 一个对话中可以包含多个表情和动作，按顺序播放。
   * 通过此 API 可检查播放状态、当前段索引、总段数。
   */
  motionSequence?: {
    getIsRunning(): boolean;
    getCurrentIndex(): number;
    getTotalSegments(): number;
    stopImmediate(): void;
  };
  /**
   * Phase 5.2B：骨骼所有权注册表（VMD / procedural / performance-planner 仲裁）。
   * E2E 通过此 API 验证 VMD 播放期间 頭/上半身 等 owner 为 'vmd'，停止后恢复 'none'。
   */
  boneOwnershipRegistry?: BoneOwnershipRegistry;
  /**
   * Phase 5.2B：morph 所有权注册表（まばたき / viseme / 表情 仲裁）。
   */
  morphOwnershipRegistry?: MorphOwnershipRegistry;
  /**
   * Phase 5.2B.1 Task 2：放松基础姿态控制器（手臂自然下垂）。
   * E2E 通过此 API 验证：
   * - 默认 desktop idle 不再保持 A/T Pose
   * - VMD gesture claim 手臂后基础姿态停止写入
   * - gesture release 后恢复放松姿态（不闪回 PMX 原始 T Pose）
   */
  relaxedBasePose?: RelaxedBasePoseController;
  /**
   * Phase 5.2B：切换 idle pack（仅允许白名单中的三个 idle pack ID）。
   * 用于 E2E 测试观察不同 idle pack 涉及的骨骼变化（頭/上半身/腰 等）。
   * 后续 Phase 5.3 表演规划器也可通过此 API 切换 idle。
   * 返回 Promise<boolean>，true 表示切换成功，false 表示 packId 不在白名单或播放失败。
   */
  playIdlePack?: (packId: string) => Promise<boolean>;
  /** Phase 3 Step 6: 动画循环控制器（start/stop/isRunning/getFrameCount/renderOneFrame/cleanup） */
  avatarLoop?: {
    start(): void;
    stop(): void;
    isRunning(): boolean;
    getFrameCount(): number;
    renderOneFrame(): void;
    cleanup(): void;
  };
  /**
   * Phase 3 Step 4.2 诊断 API：返回 morph split body meshes 的状态。
   * 用于 E2E 测试排查 morph 权重是否同步到实际渲染的子几何体。
   * 不用于生产运行时（仅调试/测试）。
   */
  __debugGetMorphSplitState?: () => {
    bodyMeshCount: number;
    mainMorphCount: number;
    mainHasInfluences: boolean;
    bodyStates: Array<{
      materialIndex: number;
      morphCount: number;
      hasInfluences: boolean;
      hasOnBeforeRenderSync: boolean;
      sampleInfluences: number[];
      materialType: string;
      visible: boolean;
    }>;
  };
  /**
   * Phase 5.2B：返回指定骨骼的当前 quaternion + position（来自 SkinnedMesh.skeleton.bones）。
   * 用于 E2E 真实 PMX 动作验收 — 观察 頭/上半身/腰/全ての親 等骨骼在 VMD 播放期间的实际变化。
   * 不只是检查 session 状态，而是直接读取 Mesh 上的骨骼变换，证明 VMD 真的被采样并应用。
   *
   * 返回 null 表示骨骼未找到（模型骨架不包含该骨骼名）。
   */
  __getBoneState?: (boneName: string) => {
    quaternion: [number, number, number, number];
    position: [number, number, number];
  } | null;
  /**
   * Phase 5.2B：批量返回多个骨骼的状态（避免多次 IPC 往返）。
   * 用于 E2E 高频轮询（如每 100ms 读取 頭/上半身/腰 状态比较变化）。
   */
  __getBoneStates?: (boneNames: string[]) => Record<string, {
    quaternion: [number, number, number, number];
    position: [number, number, number];
  } | null>;
  /**
   * Phase 5.2 修正（2026-07-19）：批量返回多个骨骼的 WORLD position。
   * 用户要求：E2E 必须直接采样左右脚踝/足IK 世界坐标检查脚滑。
   * 使用 THREE.Object3D.getWorldPosition，包含父级变换。
   */
  __getBoneWorldPositions?: (boneNames: string[]) => Record<string, [number, number, number] | null>;
  /** Bone positions expressed in the model root's local space (drag diagnostics). */
  __getBoneRootLocalPositions?: (boneNames: string[]) => Record<string, [number, number, number] | null>;
  /** Test diagnostics for complete-model user facing and residual eye focus. */
  __debugUserFacing?: () => {
    currentYaw: number;
    targetYaw: number;
    gazeYaw: number;
    gazePitch: number;
  };
  /**
   * Phase 5.2B debug：返回 MotionPlayer 内部状态 + runtime frame state。
   * 用于 E2E 调试 VMD 播放：animTime、durationSec、metadata.maxFrame、runtime frame。
   * 不用于生产运行时（仅调试/测试）。
   */
  __debugMotionPlayerState?: () => {
    state: string;
    currentPackId: string | null;
    isPlaying: boolean;
    animationDurationSec: number;
    currentAnimationTime: number;
    currentModelUpdateTime: number;
    playbackRate: number;
    animationStartedAt: number;
    nowSeconds: number;
    currentBoneNames: string[];
    currentMorphNames: string[];
    hasBlinkTrack: boolean;
    runtimeFrame: number | null;
    runtimeSeconds: number | null;
    runtimeFrameRate: number | null;
    upperBodyOwner: string;
    upperBodyQuaternion: [number, number, number, number] | null;
    skeletonBoneCount: number;
    skeletonBoneNames: string[];
    runtimeType?: string;
    parsedPreparedIkChainCount?: number;
    parsedDisabledIkBoneNames?: string[];
  };
  /**
   * Phase 5.2B.3 Closeout Task 3：测试专用 gesture 播放钩子。
   *
   * 用于 E2E 测试在不依赖 TTS/IPC 的情况下直接播放 gesture pack，
   * 验证 additive-from-base 组合模式下骨骼实际状态。
   *
   * - 只接受已注册的内部 gesture pack ID（来自 gesture-packs.ts 的 candidate-review 注册）
   * - 使用 local-clock 时间源（测试不依赖 AudioContext 对齐）
   * - compositionMode 从 manifest 自动读取（不允许测试覆盖）
   * - looping=false, fadeIn=0.5s, fadeOut=0.5s, cooldown=0（便于重复测试）
   *
   * 返回 true 表示 play() 调用成功（异步启动），false 表示 pack 未找到或参数错误。
   * 测试需通过 waitForPlaying / getCurrentPackId 自行等待状态切换。
   */
  __testPlayGesture?: (packId: string) => Promise<boolean>;
  /**
   * Phase 5.2B.3 Closeout Task 3：测试专用 gesture 立即停止钩子。
   * 调用 motionPlayer.stopImmediate()，跳过 fade-out。
   */
  __testStopGesture?: () => void;
  /** 打光预设：应用指定预设 ID */
  applyLightingPreset?: (presetId: string) => void;
  /** 获取所有打光预设列表 */
  getLightingPresets?: () => Array<{ id: string; name: string }>;
  /** 获取当前打光预设 ID */
  getCurrentLightingPreset?: () => string;
  /** 短时预览语音表情；不会写入待机设置。 */
  applyIdleExpression?: (expressionId: string) => void;
  previewSpeechExpression?: (expressionId: string, channel?: FacialChannel) => boolean;
  /** 获取共享语音表情池及当前模型支持情况。 */
  getExpressionPresets?: () => readonly SpeechExpressionPoolEntry[];
  getCurrentExpression?: () => string;
  __debugSpeechExpression?: () => unknown;
  getFacialProfileValidation?: () => ProfileValidationResult;
  __debugSpeechStance?: () => ReturnType<SpeechStanceDirector['getActiveSelection']>;
  __debugVmdParseCacheStats?: () => ReturnType<typeof getVmdParseCacheStats>;
  __debugPhysicsContinuity?: () => ReturnType<NonNullable<ReturnType<typeof getBulletBackend>>['diagnosticsState']> | null;
  /** Latest animation-input/Bullet/output matrices for selected physics bones. */
  __debugBonePhysicsPipeline?: (boneNames: string[]) => ReturnType<NonNullable<ReturnType<typeof getBulletBackend>>['debugBonePhysicsPipeline']>;
  /** Read-only PMX audit output for real-model physics stability sampling. */
  __debugDynamicBoneNames?: () => string[];
  /** Exact body-connected dynamic roots guarded during model dragging. */
  __debugRootDragAttachmentBoneNames?: () => string[];
  /** Per-bone guard state from the most recent apply() (drag diagnostics). */
  __debugRootDragAttachmentFrame?: () => ReadonlyArray<{
    boneName: string;
    rawPositionOffset: number;
    rawRotationOffset: number;
    clamped: boolean;
  }>;
  /** 同名骨骼解析探针：guard 持有对象 vs findBone 线性命中是否同一对象。 */
  __debugRootDragBoneResolution?: (boneNames: string[]) => Record<string, {
    findBoneIndex: number | null;
    guardedSkeletonIndex: number | null;
    candidateIndices: number[];
  }>;
  __debugHeadOverlay?: () => {
    activeId: string | null;
    weight: number;
    currentBodyPackId: string | null;
  };
}
declare global {
  interface Window { __chatx2Runtime?: ChatX2Runtime; }
}
// 拖拽 settle 尾巴结束后的折叠判定阈值：当守卫样本中被钳制（物理持续推越界）的
// 骨骼占比达到该值时，判定发生了裙摆 Z 形折叠并重建 Bullet 世界；否则视为正常
// 回摆，不触发重置（避免不必要的重置清零长发动量、把甩动峰值推迟到 >1s）。
const KINK_FOLD_RATIO_THRESHOLD = 0.6;
function getRuntime(): ChatX2Runtime {
  if (!window.__chatx2Runtime) {
    window.__chatx2Runtime = {};
  }
  return window.__chatx2Runtime;
}

/**
 * 暴露 ActorRuntime 和 MorphControl API（Task 2：单一状态源）。
 *
 * 架构：
 * - ActorRuntime 持有 MorphController（唯一 Morph 写入口）
 * - createMeshMorphSink 将 mesh 作为 Sink 绑定到 MorphController
 * - createAvatarMorphControl 暴露面板 API，写入经过 MorphController
 * - getRenderedWeight 读取真实 mesh.morphTargetInfluences，用于 E2E 验证
 *
 * 解决的双状态问题：
 * - 旧实现：morphPanel 直接写 mesh，ActorRuntime 维护另一套权重，reset 后不一致
 * - 新实现：所有写入都经过 MorphController，mesh 只是 Sink
 *
 * FaceRed 0.35 上限只在 MorphController.safeRanges 中定义，不重复。
 */
function buildRuntimeAvatarManifest(pack: any): AvatarManifest {
  const source = pack?.manifest;
  if (!source?.morphs || !source?.bones || !source?.model) return manifestJson as AvatarManifest;
  const base = manifestJson as AvatarManifest;
  return {
    ...base,
    schemaVersion: Number(source.schemaVersion ?? base.schemaVersion),
    model: {
      ...base.model,
      internalName: String(source.internalName ?? base.model.internalName),
      displayName: String(source.displayName ?? base.model.displayName),
      sha256: String(source.model.sha256 ?? base.model.sha256),
      pmxVersion: Number(source.model.pmxVersion ?? base.model.pmxVersion),
      geometry: source.model.geometry ?? base.model.geometry,
      textures: Array.isArray(source.textures) ? source.textures : base.model.textures,
      credit: String(source.model.credit ?? base.model.credit),
      licenseStatus: String(source.model.licenseStatus ?? base.model.licenseStatus)
    },
    morphs: {
      visemes: {
        a: String(source.morphs.visemes?.a ?? ''),
        i: String(source.morphs.visemes?.i ?? ''),
        u: String(source.morphs.visemes?.u ?? ''),
        e: String(source.morphs.visemes?.e ?? ''),
        o: String(source.morphs.visemes?.o ?? '')
      },
      blink: String(source.morphs.blink ?? ''),
      emotions: {
        neutral: String(source.morphs.emotions?.neutral ?? ''),
        serious: String(source.morphs.emotions?.serious ?? ''),
        happy: String(source.morphs.emotions?.happy ?? ''),
        smile: String(source.morphs.emotions?.smile ?? ''),
        surprised: String(source.morphs.emotions?.surprised ?? ''),
        angry: String(source.morphs.emotions?.angry ?? ''),
        concerned: String(source.morphs.emotions?.concerned ?? '')
      },
      ...(source.morphs.blush ? { blush: source.morphs.blush } : {}),
      shy: String(source.morphs.shy ?? ''),
      ...(typeof source.morphs.tears === 'string' ? { tears: source.morphs.tears } : {})
    },
    bones: source.bones,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : base.capabilities,
    // suppress-color 规则按 numeric materialIndex 绑定各自模型的材质数组顺序。
    // spread 合并会把内置希声 manifest 的 index 规则泄漏给导入模型：SHA 已被替换
    // 为导入模型，fail-closed 校验反而放行，希声的 index 7（Face_2+ 鼻部覆盖层）
    // 命中导入模型的 body_（皮肤）→ 四肢皮肤 colorWrite=false（透明但写深度，
    // 轮廓 outline 独立可见）。因此必须以当前 pack 自己的规则为准，缺省为空。
    materialCompatibility: {
      rules: Array.isArray(source.materialCompatibility?.rules)
        ? source.materialCompatibility.rules
        : []
    }
  };
}

/**
 * Build a facial profile for imported PMX packs without a SHA-bound profile.
 * Selena variants which expose the complete calibrated morph vocabulary can
 * reuse the Selena channel calibration; partial rigs stay on the conservative
 * composite fallback below and never receive missing morph names.
 */
function buildImportedPerformanceProfile(
  pack: any,
  actualSha256: string,
  availableMorphs: ReadonlySet<string> = new Set()
): AvatarPerformanceProfile | undefined {
  const source = pack?.manifest;
  if (!source?.morphs || !source?.model) return undefined;

  const identity = [source.displayName, source.internalName, source.packId]
    .filter(value => typeof value === 'string')
    .join(' ');
  const reference = selenaPerformanceProfileJson as unknown as AvatarPerformanceProfile;
  const isSelenaFamily = /赛琳娜|selena/i.test(identity);
  if (isSelenaFamily && availableMorphs.size > 0) {
    // The established Selena variants use the same facial vocabulary with a
    // few exporters changing side suffixes (左/右 vs L/R or prefix order).
    // Resolve those aliases against the current mesh, then discard only the
    // channels that are genuinely absent from this model.
    const aliases: Readonly<Record<string, readonly string[]>> = {
      '困る左': ['左困る', '困るL'], '困る右': ['右困る', '困るR'],
      'にこり左': ['左にこり', 'にこりL'], 'にこり右': ['右にこり', 'にこりR'],
      '怒り左': ['左怒り', '怒りL'], '怒り右': ['右怒り', '怒りR'],
      'びっくり左': ['左びっくり', 'びっくりL', 'びっくり左'],
      'びっくり2右': ['右びっくり', 'びっくりR', 'びっくり右'],
      '目尻下げ左': ['左目尻下げ', '目尻下げL', 'じと目L', 'じと目左', '垂れ目'],
      '目尻下げ右': ['右目尻下げ', '目尻下げR', 'じと目R', 'じと目右', '垂れ目'],
      '口角上げ左': ['左口角上げ', '口角上げL'], '口角上げ右': ['右口角上げ', '口角上げR'],
      '口角下げ左': ['左口角下げ', '口角下げL'], '口角下げ右': ['右口角下げ', '口角下げR'],
      '口横広げ左': ['左口横広げ', '口横広げL'], '口横広げ右': ['右口横広げ', '口横広げR'],
      '口横狭げ左': ['左口横狭げ', '左口横狭め', '口横狭げL', '口横狭めL'],
      '口横狭げ右': ['右口横狭げ', '右口横狭め', '口横狭げR', '口横狭めR']
    };
    const resolve = (name?: string): string | undefined => {
      if (!name) return undefined;
      if (availableMorphs.has(name)) return name;
      return aliases[name]?.find(candidate => availableMorphs.has(candidate));
    };
    const expressions = Object.fromEntries(
      Object.entries(reference.expressions)
        .map(([key, preset]) => {
          const nativeName = key === 'shy'
            ? source.morphs.shy
            : source.morphs.emotions?.[key as keyof typeof source.morphs.emotions];
          const morph = resolve(nativeName) ?? resolve(preset?.morph);
          return [key, morph ? { ...preset, morph } : undefined];
        })
        .filter(entry => Boolean(entry[1]))
    );
    const mouthStyles = Object.fromEntries(
      Object.entries(reference.mouthStyles)
        .map(([key, preset]) => {
          const morph = resolve(preset?.morph);
          const mirrorMorph = resolve(preset?.mirrorMorph);
          return [key, morph ? { ...preset, morph, ...(mirrorMorph ? { mirrorMorph } : {}) } : undefined];
        })
        .filter(entry => Boolean(entry[1]))
    );
    const facialChannels = Object.fromEntries(
      Object.entries(reference.facialChannels ?? {})
        .map(([key, binding]) => {
          const morphs = (binding?.morphs ?? [])
            .map(morph => ({ ...morph, name: resolve(morph.name) }))
            .filter((morph): morph is { name: string; scale: number } => Boolean(morph.name));
          return [key, morphs.length > 0 ? { ...binding, morphs } : undefined];
        })
        .filter(entry => Boolean(entry[1]))
    );
    if (Object.keys(expressions).length > 0 && Object.keys(facialChannels).length > 0) {
      return {
        ...reference,
        avatarSha256: actualSha256,
        modelId: String(source.packId ?? 'imported-selena-model'),
        visemes: {
          A: resolve(source.morphs.visemes?.a) ?? resolve(reference.visemes.A),
          I: resolve(source.morphs.visemes?.i) ?? resolve(reference.visemes.I),
          U: resolve(source.morphs.visemes?.u) ?? resolve(reference.visemes.U),
          E: resolve(source.morphs.visemes?.e) ?? resolve(reference.visemes.E),
          O: resolve(source.morphs.visemes?.o) ?? resolve(reference.visemes.O)
        },
        blinkMorph: resolve(source.morphs.blink) ?? resolve(reference.blinkMorph),
        expressions,
        mouthStyles,
        facialChannels,
        blushMorph: resolve(source.morphs.blush?.name) ?? resolve(reference.blushMorph),
        tearsMorph: resolve(source.morphs.tears) ?? resolve(reference.tearsMorph),
        gaze: {
          supported: Boolean(source.bones?.bothEyes || source.bones?.leftEye || source.bones?.rightEye),
          bothEyesBone: source.bones?.bothEyes || undefined,
          leftEyeBone: source.bones?.leftEye || undefined,
          rightEyeBone: source.bones?.rightEye || undefined
        }
      };
    }
  }

  const m = source.morphs;
  const expression = (key: string, morph?: string) => morph ? { morph, maxWeight: 0.85 } : undefined;
  // Imported packs only carry the seven classic emotion morphs, so semantic
  // FACS channels are synthesized from those composite morphs. Each channel
  // lists every emotion that contributes to it in the shared recipes; the
  // MorphLayerMixer sums overlapping channels (clamped to 1), which lands
  // composite weights in a natural range — e.g. the default loving smile
  // reads as smile+happy+shy stacked on the mouth/eye channels.
  const emotion = (key: keyof typeof m.emotions | 'shy') =>
    (key === 'shy' ? m.shy : m.emotions?.[key as keyof typeof m.emotions]) as string | undefined;
  const facialChannels: Partial<Record<string, { morphs: { name: string; scale: number }[]; maxWeight: number }>> = {};
  const assignChannel = (
    channel: string,
    maxWeight: number,
    contributions: readonly (readonly [string | undefined, number])[]
  ) => {
    const morphs = contributions
      .filter(([name]) => Boolean(name))
      .map(([name, scale]) => ({ name: name as string, scale }));
    if (morphs.length > 0) facialChannels[channel] = { morphs, maxWeight };
  };
  assignChannel('mouthSmileLeft', 0.75, [[emotion('smile'), 0.45], [emotion('happy'), 0.3], [emotion('shy'), 0.2]]);
  assignChannel('mouthSmileRight', 0.75, [[emotion('smile'), 0.45], [emotion('happy'), 0.3], [emotion('shy'), 0.2]]);
  assignChannel('eyeSmile', 0.6, [[emotion('smile'), 0.3], [emotion('happy'), 0.25], [emotion('shy'), 0.15]]);
  assignChannel('eyeSquintLeft', 0.55, [[emotion('smile'), 0.15], [emotion('happy'), 0.2], [emotion('shy'), 0.2], [emotion('serious'), 0.1], [emotion('angry'), 0.15], [emotion('concerned'), 0.1]]);
  assignChannel('eyeSquintRight', 0.55, [[emotion('smile'), 0.15], [emotion('happy'), 0.2], [emotion('shy'), 0.2], [emotion('serious'), 0.1], [emotion('angry'), 0.15], [emotion('concerned'), 0.1]]);
  assignChannel('cheekRaiseLeft', 0.5, [[emotion('smile'), 0.12], [emotion('happy'), 0.15], [emotion('shy'), 0.2]]);
  assignChannel('cheekRaiseRight', 0.5, [[emotion('smile'), 0.12], [emotion('happy'), 0.15], [emotion('shy'), 0.2]]);
  assignChannel('browInnerUp', 0.55, [[emotion('surprised'), 0.35], [emotion('concerned'), 0.4], [emotion('shy'), 0.2]]);
  assignChannel('browOuterUpLeft', 0.5, [[emotion('happy'), 0.25], [emotion('surprised'), 0.3]]);
  assignChannel('browOuterUpRight', 0.5, [[emotion('happy'), 0.25], [emotion('surprised'), 0.3]]);
  assignChannel('browDownLeft', 0.7, [[emotion('serious'), 0.4], [emotion('angry'), 0.5]]);
  assignChannel('browDownRight', 0.7, [[emotion('serious'), 0.4], [emotion('angry'), 0.5]]);
  assignChannel('eyeWideLeft', 0.7, [[emotion('surprised'), 0.55]]);
  assignChannel('eyeWideRight', 0.7, [[emotion('surprised'), 0.55]]);
  assignChannel('mouthFrownLeft', 0.6, [[emotion('serious'), 0.12], [emotion('concerned'), 0.2], [emotion('angry'), 0.35]]);
  assignChannel('mouthFrownRight', 0.6, [[emotion('serious'), 0.12], [emotion('concerned'), 0.2], [emotion('angry'), 0.35]]);
  assignChannel('jawOpen', 0.8, [[emotion('surprised'), 0.3]]);
  assignChannel('mouthClose', 0.6, [[emotion('angry'), 0.2]]);
  return {
    // v2 is required: ActorRuntime only builds MorphLayerMixer (semantic
    // channels, visemes, blink lane) for profileVersion === 2. v1 left every
    // imported model without a mixer, so expressions never reached the mesh.
    profileVersion: 2,
    avatarSha256: actualSha256,
    modelId: String(source.packId ?? 'imported-model'),
    visemes: { A: m.visemes?.a || undefined, I: m.visemes?.i || undefined, U: m.visemes?.u || undefined, E: m.visemes?.e || undefined, O: m.visemes?.o || undefined },
    blinkMorph: m.blink || undefined,
    expressions: {
      serious: expression('serious', m.emotions?.serious), happy: expression('happy', m.emotions?.happy),
      smile: expression('smile', m.emotions?.smile), surprised: expression('surprised', m.emotions?.surprised),
      angry: expression('angry', m.emotions?.angry), concerned: expression('concerned', m.emotions?.concerned),
      shy: expression('shy', m.shy), thinking: expression('thinking', m.emotions?.serious)
    },
    ...(Object.keys(facialChannels).length > 0 ? { facialChannels } : {}),
    mouthStyles: {},
    blushMorph: m.blush?.name || undefined,
    tearsMorph: m.tears || undefined,
    gaze: { supported: Boolean(source.bones?.bothEyes || source.bones?.leftEye || source.bones?.rightEye), bothEyesBone: source.bones?.bothEyes || undefined, leftEyeBone: source.bones?.leftEye || undefined, rightEyeBone: source.bones?.rightEye || undefined },
    conversationMotionIds: []
  };
}

function exposeActorRuntime(
  model: ThreeMmdModel,
  render: () => void,
  performanceProfile?: AvatarPerformanceProfile,
  runtimeManifest: AvatarManifest = manifestJson as AvatarManifest
): ActorRuntime {
  const mesh = model.mesh;
  const availableMorphs = Object.keys(mesh.morphTargetDictionary ?? {});

  const actorRuntime = new ActorRuntime(
    runtimeManifest,
    availableMorphs,
    performanceProfile
  );

  // 先绑定 sink 再 markLoaded，确保 resetAll 同步到真实 mesh
  try {
    const sink = createMeshMorphSink(mesh, render);
    actorRuntime.bindMorphSink(sink);
  } catch (err) {
    console.warn('[avatar] bindMorphSink failed, actorRuntime will not drive mesh:', err);
  }

  actorRuntime.markLoaded();

  const morphControl = createAvatarMorphControl(actorRuntime, mesh);

  const runtime = getRuntime();
  runtime.actorRuntime = actorRuntime;
  runtime.morphControl = morphControl;

  // Phase 3 Step 4.2 诊断 API：暴露 morph split body meshes 状态
  // 用于 E2E 测试排查 morph 权重同步问题（仅调试/测试用）
  runtime.__debugGetMorphSplitState = () => {
    const bodyMeshes = (mesh.userData as { mmdMorphSplitBodyMeshes?: THREE.SkinnedMesh[] }).mmdMorphSplitBodyMeshes;
    const bodyList = Array.isArray(bodyMeshes) ? bodyMeshes : [];
    return {
      bodyMeshCount: bodyList.length,
      mainMorphCount: mesh.morphTargetInfluences?.length ?? 0,
      mainHasInfluences: !!mesh.morphTargetInfluences,
      bodyStates: bodyList.map((body) => {
        const split = (body.userData as { mmdMorphSplitBody?: { materialIndex?: number } }).mmdMorphSplitBody;
        const infl = body.morphTargetInfluences ?? [];
        const syncAttached = !!(body.userData as { mmdMorphSplitInfluenceSyncAttached?: boolean }).mmdMorphSplitInfluenceSyncAttached;
        return {
          materialIndex: split?.materialIndex ?? -1,
          morphCount: infl.length,
          hasInfluences: !!body.morphTargetInfluences,
          hasOnBeforeRenderSync: syncAttached,
          sampleInfluences: Array.from(infl.slice(0, 10)),
          materialType: Array.isArray(body.material)
            ? body.material.map(m => m?.constructor?.name ?? '?').join(',')
            : (body.material as THREE.Material)?.constructor?.name ?? '?',
          visible: body.visible
        };
      })
    };
  };

  return actorRuntime;
}

/**
 * 暴露查看器控制 API（Task 4）：相机视角、缩放、纹理诊断、物理开关。
 * - face 镜头用头骨世界坐标定位，避免旧实现用包围盒估算不准
 * - full 镜头用更大 margin 确保头顶和脚底不出框
 * - 缩放钳制 0.4-1.6
 * - 物理默认关闭，backend 不可用时拒绝开启
 */
function exposeViewerControls(
  model: ThreeMmdModel,
  camera: THREE.PerspectiveCamera,
  bbox: THREE.Box3,
  render: () => void,
  canvasHeight: number,
  physicsAvailable: boolean,
  onPhysicsToggle: (enabled: boolean) => void
): void {
  const controls = createViewerControls({
    root: model.root,
    mesh: model.mesh,
    camera,
    bounds: bbox,
    render,
    canvasHeight,
    physicsAvailable,
    onPhysicsChanged: (enabled) => {
      console.log('[avatar] physics toggled:', enabled);
      onPhysicsToggle(enabled);
    }
  });

  getRuntime().cameraControl = controls;
}

/**
 * 从 SkinnedMesh 骨架中找到生命层需要的骨骼（Task 6 Step 3）。
 * 根据 manifest.bones 中的日文名称查找：
 * - 頭（head）：头部，用于轻微倾头
 * - 上半身（upperBody）：呼吸起伏
 * - 左肩/右肩（leftShoulder/rightShoulder）：呼吸带动
 *
 * Phase 5.2B 扩展：增加 腰/下半身/全ての親（idle-shift-weight 涉及的骨骼）。
 * - 腰（waist）：重心转移 X 位移
 * - 下半身（lowerBody）：重心补偿 Z 旋转
 * - 全ての親（root）：根骨骼轻微 X 位移
 * procedural 只写 頭/上半身/左肩/右肩；扩展骨骼只保存 rest pose 供 resetPose 后恢复。
 *
 * 骨骼查找顺序与 @yohawing/three-mmd-loader 的 findBoneTrack 一致：
 *   userData.mmdBoneName → userData.mmdEnglishBoneName → bone.name
 * 这样日文骨骼名（如 '左肩'）能匹配模型的英文名（如 'LeftShoulder'）。
 *
 * 缺失的骨骼返回 undefined，ProceduralLifeController 会跳过。
 */
function findLifeBones(mesh: THREE.SkinnedMesh): LifeBones {
  const bones = mesh.skeleton?.bones ?? [];
  const find = (name: string): THREE.Bone | undefined =>
    bones.find(b =>
      b.name === name ||
      (b.userData as { mmdBoneName?: string }).mmdBoneName === name ||
      (b.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name
    ) as THREE.Bone | undefined;

  return {
    head: find('頭'),
    upperBody: find('上半身'),
    leftShoulder: find('左肩'),
    rightShoulder: find('右肩'),
    // Phase 5.2B：idle-shift-weight 涉及的骨骼（仅保存 rest pose，procedural 不写）
    waist: find('腰'),
    lowerBody: find('下半身'),
    root: find('全ての親')
  };
}

function findGazeBones(mesh: THREE.SkinnedMesh): GazeBones {
  const bones = mesh.skeleton?.bones ?? [];
  const find = (name: string): THREE.Bone | undefined =>
    bones.find(b =>
      b.name === name ||
      (b.userData as { mmdBoneName?: string }).mmdBoneName === name ||
      (b.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name
    ) as THREE.Bone | undefined;
  return {
    bothEyes: find('両目'),
    leftEye: find('左目'),
    rightEye: find('右目'),
    head: find('頭'),
    neck: find('首')
  };
}

/**
 * Phase 5.2B.1 Task 2：查找放松基础姿态所需的手臂骨骼。
 *
 * 候选骨骼：左肩、右肩、左腕、右腕、左ひじ、右ひじ、左手首、右手首
 * 不查找：全ての親、センター、腰、下半身、腿、足 IK（由用户硬约束）
 *
 * 缺失的骨骼返回 undefined，RelaxedBasePoseController 会跳过。
 */
function findArmBones(mesh: THREE.SkinnedMesh): RelaxedBasePoseBones {
  const bones = mesh.skeleton?.bones ?? [];
  const find = (name: string): THREE.Bone | undefined =>
    bones.find(b =>
      b.name === name ||
      (b.userData as { mmdBoneName?: string }).mmdBoneName === name ||
      (b.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name
    ) as THREE.Bone | undefined;

  return {
    leftShoulder: find('左肩'),
    rightShoulder: find('右肩'),
    leftArm: find('左腕'),
    rightArm: find('右腕'),
    leftElbow: find('左ひじ'),
    rightElbow: find('右ひじ'),
    leftWrist: find('左手首'),
    rightWrist: find('右手首')
  };
}

/**
 * 材质转换和兼容性由独立模块负责：
 * - replaceMmdMaterialsWithStandard: src/desktop-avatar/mmd-material-conversion.ts
 *   将 MeshToonMaterial 转换为 shader-hook-free 的 MeshStandardMaterial，保留纹理/alpha/颜色
 *   和安全的 MMD transparencyMode 元数据，不复制 SDEF shader hooks。
 * - applyMmdMaterialCompatibility: src/desktop-avatar/mmd-material-compatibility.ts
 *   按模型 SHA-256 绑定的 numeric material index 应用兼容规则（如鼻部 Face_2+ colorWrite=false）。
 *   每次 model.update() 同步后重新应用（runtime sync 会恢复 colorWrite）。
 */

async function initAvatarRenderer(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const statusLabel = document.getElementById('status-label') as HTMLElement | null;
  if (!canvas) {
    console.error('[avatar] canvas element missing');
    return;
  }

  const api = (window as unknown as { chatx2: ChatX2Api }).chatx2;
  if (!api) {
    console.error('[avatar] chat6 API not available');
    return;
  }

  // Start independent read-only IPC immediately. These requests used to run
  // one after another around PMX parsing, adding avoidable desktop-entry wait.
  const vmdBytesCache = new Map<string, Uint8Array>();
  const startupIdentityPromise = api.getIdentity();
  const startupComputeLevelPromise = api.getRenderQuality()
    .then(result => result.level)
    .catch(() => 'high' as AvatarComputeLevel);
  // Warm up Bullet while PMX bytes, model metadata and the hidden window are
  // still loading. The backend is still attached to the model only after the
  // PMX audit completes, so this changes ordering, not runtime behavior.
  const startupPhysicsLoadPromise = startupComputeLevelPromise.then(level => {
    const profile = getAvatarComputeProfile(level);
    return loadBulletPhysics({
      backendOptions: {
        maxSubSteps: profile.physics.maxSubSteps,
        fixedTimeStep: profile.physics.fixedTimeStep,
        resetCatchUpSteps: 0,
        solverIterations: profile.physics.solverIterations,
        collisionMargin: 0.004,
        splitImpulse: true,
        dynamicWithBoneRotationFeedbackScale: profile.physics.rotationFeedbackScale,
      }
    });
  });
  const startupModelPackPromise = api.getCurrentModelPack()
    .catch(() => ({ success: false } as Awaited<ReturnType<ChatX2Api['getCurrentModelPack']>>));
  const startupIdlePausePromise = api.getIdlePaused().catch(() => ({ paused: false }));
  const startupDefaultIdlePreloadPromise = startupModelPackPromise.then(async currentPack => {
    const defaultIdle = currentPack.success && currentPack.motions
      ? currentPack.motions.defaultIdle
      : '';
    const isVmdPath = defaultIdle.startsWith('motions/')
      || (defaultIdle.startsWith('../') && defaultIdle.includes('/motions/'));
    if (!isVmdPath || vmdBytesCache.has(defaultIdle)) return;
    const bytes = await api.loadCustomVmdBytes(defaultIdle);
    vmdBytesCache.set(defaultIdle, new Uint8Array(bytes));
  }).catch(error => {
    // Preload is an optimization only. The normal start path retries the same
    // local VMD load and reports its own actionable error if needed.
    console.warn('[avatar] default idle preload failed:', error);
  });

  // Phase 5.2B.1 Task 5：statusLabel 默认隐藏（CSS display:none）。
  // 仅在显式 debug 模式下添加 'debug-visible' class 显示。
  // 触发条件：
  //   1. URL 参数 ?debugAvatar=1
  //   2. localStorage.debugAvatar === '1'
  //   3. identity.isTest && identity.pmxRenderInTest（evidence 脚本环境）
  // 生产模式下不显示，确保截图无 [PMX rendered: ...] 等调试文本。
  const debugAvatarViaUrl = new URLSearchParams(window.location.search).get('debugAvatar') === '1';
  const debugAvatarViaStorage = (() => {
    try { return localStorage.getItem('debugAvatar') === '1'; } catch { return false; }
  })();
  const isDebugMode = debugAvatarViaUrl || debugAvatarViaStorage;
  if (statusLabel && isDebugMode) {
    statusLabel.classList.add('debug-visible');
  }

  // Phase 5.1 修复（P0-A/B/C）：Avatar Runtime 是唯一 AudioContext/解码器/播放时钟所有者。
  // 旧架构（已废弃）：Composer 拥有 AudioContext，解码后通过 audioSpeak 通知 Avatar 张嘴。
  //   问题1（P0）：有效 taskId 仍可在解码完成前张嘴（authorizeSpeak 只检查缓存，不检查解码状态）。
  //   问题2（P0）：AudioContext suspended 时 currentTime 不前进，但 sourceNode.start + setTimeout 仍执行，
  //               导致"无声表演"（字幕显示、张嘴、但无声音）。
  // 新架构：Avatar 拥有 AudioContext，自行解码 + 播放 + 张嘴。
  //   硬门1：Composer 不再有 AudioContext，无法在解码完成前调用 audioSpeak。
  //   硬门2：Avatar 在 ctx.state === 'running' && decodeAudioData 成功 && sourceNode.start 调度后
  //          才发送 performance:started → Composer 显示字幕。
  //          若 ctx.state === 'suspended' 且无法 resume，发送 performance:ended('failed')，
  //          Composer 显示错误提示 + 重新生成按钮，不显示字幕、不张嘴。
  //   硬门3：模式切换/崩溃/取消/播放结束统一调用 stopPerformance()，清零 viseme + 停止 sourceNode。
  (window as any).__avatarSpeaking = false;
  let audioCtx: AudioContext | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  let mutedPlaybackFallbackTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentPlaybackTaskId: string | null = null;
  // Avatar 同步扩展：mute 模式标志（Chat 窗口播放语音时，Avatar 静音同步口型/动作）
  // mute=true 时不连接 destination、不发送 performance:started/ended 给 Composer
  let currentPlaybackMute = false;
  // VMD 字节缓存已在启动 IPC 前创建，默认待机会与 PMX/Bullet 并行预取。
  // 待执行的 decode 调度（用于 stopPlay 时取消未完成的 decode）
  let pendingDecode: Promise<void> | null = null;
  let playbackGeneration = 0;
  let audioPreloader: AudioPreloader<AudioBuffer> | null = null;

  // Phase 5.2 Task 5.2.6：AvatarPerformanceSession 提供同一音频时钟基准。
  // - getAudioContextTime 回调读取当前 AudioContext.currentTime
  // - AudioContext 未创建时返回 0（session.now() 会 fallback 到 Date.now()/1000）
  // - 在 sourceNode.start() 后调用 beginPerformance(taskId, ctx.currentTime, wavBytes)
  // - 在 stopPerformance 中调用 endPerformance() 清零 viseme + 清除时钟对齐
  // - 暴露到 __chatx2Runtime.performanceSession 供 E2E 测试和后续动作播放器（Phase 5.3+）使用
  const getPerformanceClockTime = (): number => {
    // Chat owns the audible HTMLAudioElement for avatar:sync-voice. Chromium
    // may suspend the avatar's zero-gain AudioContext on the first cold play,
    // so a muted synchronization must not use that frozen clock for body,
    // face or lip progress. The audible path still uses AudioContext time.
    if (currentPlaybackMute) return performance.now() / 1000;
    if (audioCtx && audioCtx.state !== 'closed') {
      return audioCtx.currentTime;
    }
    throw new Error('AudioContext unavailable');
  };
  const performanceSession = new AvatarPerformanceSession(getPerformanceClockTime);
  const motionArbiter = new AvatarMotionArbiter();
  const idleLifecycle = new IdleLifecycleController();
  const initialIdlePause = await startupIdlePausePromise;
  motionArbiter.setIdlePaused(initialIdlePause.paused);
  idleLifecycle.setPaused(initialIdlePause.paused);
  let poseLockedState = false;

  // 全局默认表情：右键菜单 "默认表情" 切换，跨模型统一（主进程权威状态）。
  // 语义 emotion 直接走 MorphLayerMixer 配方；导入模型 profile 已含这些通道。
  const DEFAULT_EXPRESSION_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'loving', label: '开心（微笑+开心+羞涩）' },
    { key: 'serious', label: '冷酷' },
    { key: 'sad', label: '伤心' },
    { key: 'shy', label: '害羞' },
    { key: 'angry', label: '生气' }
  ];
  let defaultIdleExpression: string = 'loving';
  const applyDefaultExpression = (expression: string): void => {
    if (!DEFAULT_EXPRESSION_OPTIONS.some(opt => opt.key === expression)) return;
    defaultIdleExpression = expression;
  };
  const selectedExpressionLabel = (expression: string): string =>
    DEFAULT_EXPRESSION_OPTIONS.find(opt => opt.key === expression)?.label ?? expression;

  // 原生右键菜单：openContextMenu 时把「id → 动作」暂存，主进程菜单点击后回传 id 再执行。
  let pendingContextMenuActions: ReadonlyMap<string, () => void> | null = null;
  const speechMotionDirector = new SpeechMotionDirector();
  const speechStanceDirector = new SpeechStanceDirector();
  getRuntime().performanceSession = performanceSession;
  let gazeControllerRef: GazeController | null = null;
  let userFacingControllerRef: ModelUserFacingController | null = null;
  let pupilControllerRef: PupilController | null = null;
  let lifeControllerRef: ProceduralLifeController | null = null;
  let relaxedBasePoseRef: RelaxedBasePoseController | null = null;

  /**
   * 根据模型当前屏幕位置更新眼神，使其自然看向屏幕中心（电脑使用者方向）。
   * Speech semantics may add a brief glance, but the centered user remains
   * the base focus. The body yaw is removed so eyes do not over-rotate.
   */
  function updateGazeToScreenCenter(): void {
    if (!gazeControllerRef) return;
    const ctrl = getRuntime().cameraControl as ViewerControls | undefined;
    if (!ctrl) return;
    const canvasW = window.innerWidth;
    const canvasH = window.innerHeight;
    const pos = ctrl.getModelScreenPosition(canvasW, canvasH);
    gazeControllerRef.setScreenCenterTarget(
      pos.x,
      pos.y,
      canvasW * 0.5,
      canvasH * 0.5,
      userFacingControllerRef?.getCurrentYaw() ?? 0
    );
  }

  /**
   * 获取 AudioContext，并在 suspended 状态下尝试 resume。
   * Electron renderer 在无用户交互时 AudioContext 可能 suspended，必须显式 resume。
   * 返回的 AudioContext 状态可能是 'running' / 'suspended'（resume 失败时）。
   */
  const getAudioContext = async (): Promise<AudioContext> => {
    if (!audioCtx || audioCtx.state === 'closed') {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      audioCtx = new Ctor();
    }
    // P0-C 硬门：suspended 状态下 currentTime 不前进，sourceNode.start 调度的音频不会播放。
    // 必须显式 resume，且 await 等待状态切换。
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (e) {
        console.warn('[avatar] AudioContext.resume failed:', e);
      }
    }
    return audioCtx;
  };

  /**
   * Phase 5.1 修复（P1-E）：统一停止表演。
   * 在以下场景调用：
   * - 播放自然结束（sourceNode.onended）
   * - 解码失败 / AudioContext suspended / sourceNode.start 失败
   * - 新消息打断（avatar:stop-play 'interrupted'）
   * - 模式切换（avatar:stop-play 'mode-change'）
   * - 取消（avatar:stop-play 'cancel'）
   * - 窗口 beforeunload
   *
   * 清理顺序：
   * 1. sourceNode.stop() + disconnect()（停止音频）
   * 2. actorRuntime.stopSpeak()（清零 viseme，关键：防止切回 Chat 后口型残留）
   * 3. Phase 5.2B：motionPlayer.stop()（clearAnimation + resetPose + release lease）
   *    仅在 'interrupted' / 'failed' 路径停止（模式切换/取消/崩溃）；
   *    'ended' 路径不停 VMD（语音结束后 idle pack 应继续播放，由调用方决定）
   * 4. performanceSession.endPerformance()（清零时钟对齐 + viseme 时间轴）
   * 5. sendPerformanceEnded(taskId, reason)（通知主进程释放 wavCache + 通知 Composer 隐藏字幕）
   *
   * Phase 5.2B：'ended' 路径在清理后通过 startDefaultIdlePackRef() 回到 idle pack
   * （只有在 desktop 模式下才回到 idle，其他模式不启动）
   * startDefaultIdlePackRef 在 PMX 加载后通过闭包赋值，避免前向引用问题
   */
  // startDefaultIdlePackRef 在 PMX 加载后被赋值（闭包前向引用）
  // force 参数：true 时绕过 cooldown（用于语音结束后必须回到 idle 的场景）
  let startDefaultIdlePackRef: ((force?: boolean, transitionProfile?: TransitionBridgeProfile) => Promise<void>) | null = null;
  let stopIdleRotationRef: (() => void) | null = null;
  let scheduleIdleRotationRef: (() => void) | null = null;
  let currentSpeechGeneration: number | null = null;
  let currentSpeechMotionGeneration: number | null = null;
  let currentSpeechCueOwnerGeneration: number | null = null;
  let currentSpeechBackgroundVmdPath: string | null = null;
  let speechPhysicsBackendRef: ReturnType<typeof getBulletBackend> = null;
  const headOverlayController = new HeadOverlayController();
  let lastStableInwardHeadDirection: -1 | 1 = 1;
  const resolveCurrentDisplayInwardDirection = (): -1 | 1 => {
    const controls = getRuntime().cameraControl as ViewerControls | undefined;
    const modelScreenPosition = controls?.getModelScreenPosition(window.innerWidth, window.innerHeight);
    const screen = window.screen as Screen & { availLeft?: number };
    const direction = resolveInwardHeadDirection({
      avatarCenterX: window.screenX + (modelScreenPosition?.x ?? window.outerWidth / 2),
      displayLeft: screen.availLeft ?? 0,
      displayWidth: screen.availWidth,
      lastStable: lastStableInwardHeadDirection
    });
    lastStableInwardHeadDirection = direction;
    return direction;
  };
  (getRuntime() as any).__debugIdleLifecycle = () => idleLifecycle.snapshot();
  getRuntime().__debugSpeechStance = () => speechStanceDirector.getActiveSelection();
  getRuntime().__debugPhysicsContinuity = () =>
    speechPhysicsBackendRef?.diagnosticsState() ?? null;
  getRuntime().__debugBonePhysicsPipeline = (boneNames) =>
    speechPhysicsBackendRef?.debugBonePhysicsPipeline(boneNames) ?? [];
  (getRuntime() as any).__debugSpeechMotionSelection = () => ({
    currentSpeechGeneration,
    currentSpeechMotionGeneration,
    currentSpeechCueOwnerGeneration,
    speechMotionPhase: speechMotionDirector.getPhase(),
    performanceState: performanceSession.getState(),
    motionMode: motionArbiter.getMode(),
    canRunSpeechMotion: motionArbiter.canRunSpeechMotion(),
    enabledVmdPathCount: enabledVmdPaths.length,
    voiceActionEntryCount: currentVmdEmotionMap.filter(isVoiceActionPoolEntry).length,
    automaticVoiceActionCount: currentVmdEmotionMap.filter(isAutomaticVoiceAction).length,
    lastSelection: lastSpeechMotionSelection,
    backgroundVmdPath: selectSpeechBackgroundVmd(
      enabledVmdPaths,
      currentSpeechGeneration ?? 0,
      currentVmdEmotionMap,
      currentDefaultIdle
    ) ?? null,
    gestureRequestInFlight: speechGestureRequestInFlight,
    backgroundRequestInFlight: speechBackgroundRequestInFlight
  });
  const speechCueDispatch = new SpeechCueDispatchState();
  let speechGestureRequestInFlight = false;
  let speechBackgroundRequestInFlight = false;
  let isDesktopModeRef = false;
  // Phase 5.2 修正（2026-07-19）：默认 idle pack ID（用于语音结束后回到 idle）
  // 与 PMX 加载后的 DEFAULT_IDLE_PACK_ID 保持一致
  let currentDefaultIdle = '../shared/motions/待机 女性的.vmd';
  let enabledIdlePackIds: string[] = [];
  let enabledGesturePackIds: string[] = Array.from(GESTURE_PACK_IDS);
  // Phase 6: 已启用的自定义 VMD 路径列表（用于 speaking gesture 选择）
  let enabledVmdPaths: string[] = [];
  let currentVmdEmotionMap: VmdEmotionEntry[] = [];
  let lastSpeechMotionSelection: {
    cueIndex: number;
    cueText: string;
    coordinatedEmotion: string;
    intent: string;
    gestureFamily: string | undefined;
    selectedVmdPath: string | null;
    matchLevel: 'intent' | 'gestureFamily' | 'emotion' | 'daily' | null;
    selectedEntry: Pick<VmdEmotionEntry, 'vmdPath' | 'displayName' | 'type' | 'intent' | 'gestureFamily' | 'dialogueSafe' | 'starred' | 'motionScope' | 'headOverlayId' | 'protected' | 'headTuning'> | null;
    selectedFromVoiceActionPool: boolean;
    selectionReason: 'selected' | 'voice-pool-empty' | 'no-matching-enabled-action';
    enabledVmdPathCount: number;
    voiceActionEntryCount: number;
    automaticVoiceActionCount: number;
  } | null = null;
  const mergeEnabledVmdPaths = (
    customVmd: readonly string[] | undefined,
    voiceActionMap: readonly VmdEmotionEntry[]
  ): string[] => Array.from(new Set([
    ...(Array.isArray(customVmd) ? customVmd : []),
    ...voiceActionMap.map(entry => entry.vmdPath)
  ].filter(path => typeof path === 'string' && path.trim().length > 0)));
  // 待机轮换池：参与自动轮换的 VMD 路径列表（非空时启用多 VMD 轮换）
  let enabledIdleVmdPool: string[] = [];
  // 模型专属动作手感微调（每个模型 manifest.json 的 motionTuning，加载/切换模型时刷新）
  let currentModelMotionTuning: ResolvedModelMotionTuning = resolveModelMotionTuning();

  const isSpeechCueWaitingForMotionHandoff = (
    cue: SpeechPerformanceCue,
    speechGeneration: number
  ): boolean => {
    const mp = getRuntime().motionPlayer;
    const reservedSlot = speechMotionDirector.shouldDeferAccent(
      currentSpeechMotionGeneration ?? -1,
      performance.now(),
      cue.emotionTurn
    );
    const ownerHandoff = Boolean(mp && currentSpeechCueOwnerGeneration === speechGeneration
      && shouldDeferSpeechGestureForCurrentOwner({
        ownerGeneration: currentSpeechCueOwnerGeneration,
        requestedGeneration: speechGeneration,
        motionPlaying: mp.isPlaying(),
        currentPackId: mp.getCurrentPackId(),
        state: mp.getState(),
        currentAnimationTime: mp.getCurrentAnimationTime(),
        animationDuration: mp.getAnimationDuration(),
        emotionTurn: cue.emotionTurn
      }));
    return reservedSlot || ownerHandoff;
  };

  const playSpeechCueGesture = async (
    cue: SpeechPerformanceCue,
    speechGeneration: number,
    speechMotionGeneration: number,
    facialEmotion = cue.facialEmotion,
    continuation = false
  ): Promise<boolean> => {
    if ((!continuation && !shouldDispatchSpeechGesture(
      cue,
      speechGeneration,
      lastSpeechMotionSelection?.selectedVmdPath == null
    ))
      || !motionArbiter.isCurrentSpeech(speechGeneration)
      || !speechMotionDirector.isCurrent(speechMotionGeneration)
      || !motionArbiter.canRunSpeechMotion()) return false;
    const mp = getRuntime().motionPlayer;
    if (!mp || shouldDeferSpeechGestureForCurrentOwner({
        ownerGeneration: currentSpeechCueOwnerGeneration,
        requestedGeneration: speechGeneration,
        motionPlaying: mp.isPlaying(),
        currentPackId: mp.getCurrentPackId(),
        state: mp.getState(),
        currentAnimationTime: mp.getCurrentAnimationTime(),
        animationDuration: mp.getAnimationDuration(),
        emotionTurn: cue.emotionTurn
      })) return false;
    const coordinated = coordinateSpeechMotionSemantic(cue, facialEmotion);
    const motionStyle = resolveSpeechMotionStyle(coordinated.emotion, cue.intensity);
    // Long cached WAVs reserve accent slots across the full duration. If the
    // cue arrives before its slot, keep the cue latched for a retry on the
    // next audio frame instead of silently falling back to the background.
    if (!continuation && speechMotionDirector.shouldDeferAccent(
      speechMotionGeneration,
      performance.now(),
      cue.emotionTurn
    )) return false;
    const recentlyAdmittedPath = lastSpeechMotionSelection?.selectedVmdPath;
    const plan = performanceSession.plan({
      emotion: coordinated.emotion,
      intent: coordinated.intent,
      intensity: cue.intensity,
      gestureFamily: coordinated.gestureFamily,
      speaking: true,
      enabledVmdPaths,
      excludedVmdPaths: buildSpeechPlannerExclusions(
        [
          ...speechMotionDirector.getUnavailableMotionIds(),
          // The director's recent-reply window is intentionally bounded. Keep
          // the immediately previous admitted path out as well so adjacent
          // replies cannot repeat merely because their semantic keys differ.
          ...(recentlyAdmittedPath ? [recentlyAdmittedPath] : [])
        ],
        currentSpeechBackgroundVmdPath
      ),
      defaultIdleVmd: currentDefaultIdle
    });
    const vmdPath = plan.speakingVmdPath;
    if (!vmdPath) {
      lastSpeechMotionSelection = {
        cueIndex: cue.index,
        cueText: cue.text,
        coordinatedEmotion: coordinated.emotion,
        intent: coordinated.intent,
        gestureFamily: coordinated.gestureFamily,
        selectedVmdPath: null,
        matchLevel: null,
        selectedEntry: null,
        selectedFromVoiceActionPool: false,
        selectionReason: plan.voiceActionSelectionReason ?? 'no-matching-enabled-action',
        enabledVmdPathCount: enabledVmdPaths.length,
        voiceActionEntryCount: currentVmdEmotionMap.filter(isVoiceActionPoolEntry).length,
        automaticVoiceActionCount: currentVmdEmotionMap.filter(isAutomaticVoiceAction).length
      };
      return false;
    }
    const selectedEntry = plan.speakingVmdMatch?.entry;
    // Defense in depth at the final playback boundary: even if a future
    // Planner regression returns a fallback/gesture path, automatic speech
    // must never load it unless the exact entry is an enabled voice action.
    if (!isExactAutomaticVoiceSelection(selectedEntry, vmdPath)) {
      lastSpeechMotionSelection = {
        cueIndex: cue.index,
        cueText: cue.text,
        coordinatedEmotion: coordinated.emotion,
        intent: coordinated.intent,
        gestureFamily: coordinated.gestureFamily,
        selectedVmdPath: null,
        matchLevel: null,
        selectedEntry: selectedEntry
          ? {
              vmdPath: selectedEntry.vmdPath,
              displayName: selectedEntry.displayName,
              type: selectedEntry.type,
              intent: selectedEntry.intent,
              gestureFamily: selectedEntry.gestureFamily,
              dialogueSafe: selectedEntry.dialogueSafe,
              starred: selectedEntry.starred,
              motionScope: selectedEntry.motionScope,
              headOverlayId: selectedEntry.headOverlayId,
              protected: selectedEntry.protected,
              headTuning: selectedEntry.headTuning
            }
          : null,
        selectedFromVoiceActionPool: false,
        selectionReason: 'no-matching-enabled-action',
        enabledVmdPathCount: enabledVmdPaths.length,
        voiceActionEntryCount: currentVmdEmotionMap.filter(isVoiceActionPoolEntry).length,
        automaticVoiceActionCount: currentVmdEmotionMap.filter(isAutomaticVoiceAction).length
      };
      console.warn('[avatar] rejected non-voice-pool speech action:', vmdPath);
      return false;
    }
    let bytes = vmdBytesCache.get(vmdPath);
    if (!bytes) {
      const buffer = await api.loadCustomVmdBytes(vmdPath);
      bytes = new Uint8Array(buffer);
      vmdBytesCache.set(vmdPath, bytes);
    }
    if (!motionArbiter.isCurrentSpeech(speechGeneration)
      || !speechMotionDirector.isCurrent(speechMotionGeneration)
      || !motionArbiter.canRunSpeechMotion()) return false;
    const parsedForPacing = await loadVmd(bytes);
    const modelBoneNames = new Set(mp.getModelBoneNames());
    if (!hasCompatibleBoneTracks(parsedForPacing, modelBoneNames)) {
      console.warn('[avatar] skipped speech VMD: no compatible bone tracks', {
        vmdPath,
        modelBoneCount: modelBoneNames.size,
        vmdBoneCount: Object.keys(parsedForPacing.boneTracks).length
      });
      return false;
    }
    const headOverlayId = resolveHeadOverlayId(selectedEntry);
    if (headOverlayId) {
      const validation = validateHeadOverlayTracks(parsedForPacing);
      if (!validation.valid) {
        console.warn('[avatar] rejected unsafe head-overlay VMD:', vmdPath, validation.reasons);
        return false;
      }
    }
    const authoredActionSeconds = headOverlayId
      ? HEAD_OVERLAY_DEFINITIONS[headOverlayId].durationSeconds
      : resolvePlayableAvatarMaxFrame(parsedForPacing) / 30;
    const remainingSpeechSeconds = Math.max(
      0,
      performanceSession.getDurationSeconds() - performanceSession.getCurrentTime()
    );
    const hasFullSpeechMotionWindow = canStartSpeechMotion({
      remainingSpeechSeconds,
      authoredActionSeconds,
      playbackRate: motionStyle.playbackRate
    });
    // A voice action may be longer than the remaining phrase. The first
    // admitted action is still useful when at least a short readable window
    // remains; MotionPlayer will fade it out with the audio handoff. Requiring
    // the full authored clip here made imported models appear motionless.
    const allowReadablePartialWindow = lastSpeechMotionSelection?.selectedVmdPath == null
      && remainingSpeechSeconds >= 1.2;
    if (!hasFullSpeechMotionWindow && !allowReadablePartialWindow) return false;
    if (!speechCueDispatch.canClaimMotion(vmdPath, cue.startSeconds, 9)) return false;
    if (!speechMotionDirector.claimAccent(
      speechMotionGeneration,
      vmdPath,
      performance.now(),
      headOverlayId ? 'head' : 'body',
      { emotionTurn: cue.emotionTurn }
    )) {
      return false;
    }
    if (!speechCueDispatch.claimMotion(vmdPath, cue.startSeconds, 9)) return false;
    // Diagnostics must describe a request admitted to the player, not every
    // Planner candidate considered after the reply accent budget was spent.
    lastSpeechMotionSelection = {
      cueIndex: cue.index,
      cueText: cue.text,
      coordinatedEmotion: coordinated.emotion,
      intent: coordinated.intent,
      gestureFamily: coordinated.gestureFamily,
      selectedVmdPath: vmdPath,
      matchLevel: plan.speakingVmdMatch?.level ?? null,
      selectedEntry: selectedEntry
        ? {
            vmdPath: selectedEntry.vmdPath,
            displayName: selectedEntry.displayName,
            type: selectedEntry.type,
            intent: selectedEntry.intent,
            gestureFamily: selectedEntry.gestureFamily,
            dialogueSafe: selectedEntry.dialogueSafe,
            starred: selectedEntry.starred,
            motionScope: selectedEntry.motionScope,
            headOverlayId: selectedEntry.headOverlayId,
            protected: selectedEntry.protected,
            headTuning: selectedEntry.headTuning
          }
        : null,
      selectedFromVoiceActionPool: isAutomaticVoiceAction(selectedEntry),
      selectionReason: plan.voiceActionSelectionReason ?? 'selected',
      enabledVmdPathCount: enabledVmdPaths.length,
      voiceActionEntryCount: currentVmdEmotionMap.filter(isVoiceActionPoolEntry).length,
      automaticVoiceActionCount: currentVmdEmotionMap.filter(isAutomaticVoiceAction).length
    };

    speechGestureRequestInFlight = true;
    try {
      if (!motionArbiter.isCurrentSpeech(speechGeneration)
        || !speechMotionDirector.isCurrent(speechMotionGeneration)
        || !motionArbiter.canRunSpeechMotion()) return false;
      if (headOverlayId) {
        // A head-only voice action always composes over the user's configured
        // default body. It must never inherit a random episodic idle that
        // happened to be visible when speech began.
        const backgroundReady = await ensureSpeechBackgroundMotion(
          speechGeneration,
          speechMotionGeneration,
          true
        );
        if (!backgroundReady) return false;
        headOverlayController.start(headOverlayId, {
          rotationScale: selectedEntry?.headTuning?.rotationScale,
          inwardDirection: resolveCurrentDisplayInwardDirection()
        });
        currentSpeechCueOwnerGeneration = speechGeneration;
        return true;
      }
      const speechStanceAccent = speechStanceDirector.selectAccent(
        cue,
        performanceSession.getPerformanceCues().length,
        performanceSession.getDurationSeconds()
      ) ?? undefined;
      const packId = `speech-cue:${cue.index}:${vmdPath.replace(/[\\/]/g, '_')}`;
      speechPhysicsBackendRef?.beginSpeechContinuity();
      await mp.play(packId, bytes, {
        boneMapping: {},
        // This entry passed the exact user voice-pool admission gate above.
        // Preserve the authored clip instead of rewriting it into the old
        // dialogue-body-only stance; Bullet still owns dynamic secondary bones.
        amplitudeLimits: motionStyle.amplitudeLimits,
        looping: false,
        timeSource: 'performance-clock',
        // 0.72 → 0.85：桥后淡入同步放缓，衔接整体更稳（用户反馈动作
        // 衔接仍偏快，希望少一点、稳一点、非线性自然过渡）。
        fadeInSeconds: 0.85,
        fadeOutSeconds: 0.85,
        cooldownSeconds: 0,
        force: true,
        compositionMode: 'absolute',
        candidateTrackPolicy: 'trusted-voice-full-body',
        playbackRate: motionStyle.playbackRate,
        transitionProfile: 'speech-entry',
        speechStance: speechStanceDirector.getActiveSelection()?.profile,
        speechStanceAccent
      });
      currentSpeechCueOwnerGeneration = speechGeneration;
      // 设置 onStop 回调：gesture 播完后自动启动 background motion，
      // 避免手臂在 gesture 结束后掉落到放松姿态（"抬起然后放下"问题）。
      mp.setOnStop(() => {
        if (!motionArbiter.isCurrentSpeech(speechGeneration)
          || performanceSession.getState() !== 'performing') {
          return;
        }
        void ensureSpeechBackgroundMotion(speechGeneration, speechMotionGeneration);
      });
      mp.setOnNaturalEnd(() => {
        if (!motionArbiter.isCurrentSpeech(speechGeneration)
          || performanceSession.getState() !== 'performing') return;
        // A voice-pool clip is a one-shot accent. Never replay the same VMD
        // (the old continuation/loop path made a 20s reply repeat one gesture
        // until it looked like a random, non-pool action). After its authored
        // frames finish, return to the user's selected idle as a stable speech
        // background and wait for the next timeline cue.
        setTimeout(() => {
          if (!motionArbiter.isCurrentSpeech(speechGeneration)
            || performanceSession.getState() !== 'performing'
            || mp.getCurrentPackId() !== packId) return;
          currentSpeechCueOwnerGeneration = null;
          void ensureSpeechBackgroundMotion(speechGeneration, speechMotionGeneration, true);
        }, 180);
      });
      return true;
    } catch (e) {
      speechPhysicsBackendRef?.endSpeechContinuity();
      if (!(e instanceof MotionRequestSupersededError)) {
        console.warn('[avatar] phrase gesture failed:', vmdPath, e);
      }
      return false;
    } finally {
      speechGestureRequestInFlight = false;
    }
  };

  const ensureSpeechBackgroundMotion = async (
    speechGeneration: number,
    speechMotionGeneration: number,
    force = false
  ): Promise<boolean> => {
    if (!motionArbiter.canRunSpeechMotion() || !speechMotionDirector.isCurrent(speechMotionGeneration)) return false;
    const mp = getRuntime().motionPlayer;
    if (!mp) return false;
    const alreadyOwnedSpeechBackground = currentSpeechBackgroundVmdPath !== null;
    const selectedPath = selectSpeechBackgroundVmd(
      enabledVmdPaths,
      speechGeneration,
      currentVmdEmotionMap,
      currentDefaultIdle
    );
    const vmdPath = currentSpeechBackgroundVmdPath ?? selectedPath;
    if (!vmdPath) return false;
    if (!currentSpeechBackgroundVmdPath) {
      if (!speechMotionDirector.claimBackgroundDecision(speechMotionGeneration)) return false;
      currentSpeechBackgroundVmdPath = vmdPath;
    }
    // The selected default body is already the desktop base. Never rebind it
    // when speech starts; rebinding the same VMD resets parent matrices and
    // makes Bullet launch bangs/hair. Head overlays can compose directly over
    // this existing body. If no body is visible yet, bind it once below.
    if (mp.getCurrentPackId() === vmdPath && mp.isPlaying()) {
      currentSpeechCueOwnerGeneration = null;
      return true;
    }
    // If the user's selected default idle is already visible, keep it bound.
    // Re-wrapping the same VMD as speech-background used to create an entirely
    // artificial bridge through the clip's PMX export pose before speech.
    if (alreadyOwnedSpeechBackground
      && mp.getCurrentPackId() === vmdPath
      && mp.isPlaying()) return true;
    // Keep the user's default idle under its canonical pack ID and original
    // local-clock/full-body policy. A synthetic speech-background wrapper
    // stripped the authored lower body and forced an unnecessary second bind
    // when speech ended, which could kick the physical hair/clothing chains.
    const backgroundPackId = vmdPath;
    if (!force && !shouldRestoreSpeechBackground({
      speechActive: motionArbiter.isCurrentSpeech(speechGeneration)
        && performanceSession.getState() === 'performing',
      motionPlaying: mp.isPlaying(),
      currentPackId: mp.getCurrentPackId(),
      requestInFlight: speechGestureRequestInFlight || speechBackgroundRequestInFlight
    })) return false;
    speechBackgroundRequestInFlight = true;
    try {
      let bytes = vmdBytesCache.get(vmdPath);
      if (!bytes) {
        const buffer = await api.loadCustomVmdBytes(vmdPath);
        bytes = new Uint8Array(buffer);
        vmdBytesCache.set(vmdPath, bytes);
      }
      if (!motionArbiter.isCurrentSpeech(speechGeneration)
        || !speechMotionDirector.isCurrent(speechMotionGeneration)
        || !motionArbiter.canRunSpeechMotion()
        || performanceSession.getState() !== 'performing') return false;
      speechPhysicsBackendRef?.beginSpeechContinuity();
      await mp.play(backgroundPackId, bytes, {
        boneMapping: {},
        amplitudeLimits: {
          ...DEFAULT_AMPLITUDE_LIMITS,
          // The selected default body's speech background is intentionally
          // restrained; authored lower tracks are already removed above, and
          // a smaller torso/shoulder envelope prevents re-entry from kicking
          // the shared hair/clothing chains.
          upperBody: { x: 8, y: 8, z: 8 },
          shoulder: { x: 6, y: 6, z: 6 }
        },
        looping: true,
        timeSource: 'local-clock',
        // 与语音手势一致放缓到 0.85s：background 回接不再抢拍。
        fadeInSeconds: 0.85,
        fadeOutSeconds: 0.85,
        cooldownSeconds: 0,
        force: true,
        compositionMode: 'absolute',
        // Head-only speech uses the selected default body's upper-body pose,
        // while lower-body/IK tracks stay on the grounded natural base. This
        // is still the user's default body pack; it simply cannot reintroduce
        // a leg transition when the temporary speech body is rebound.
        candidateTrackPolicy: 'dialogue-body-only',
        transitionProfile: 'speech-to-idle-recovery'
      });
      currentSpeechCueOwnerGeneration = null;
      return true;
    } catch (e) {
      speechPhysicsBackendRef?.endSpeechContinuity();
      if (!(e instanceof MotionRequestSupersededError)) {
        console.warn('[avatar] speech background failed:', vmdPath, e);
      }
      return false;
    } finally {
      speechBackgroundRequestInFlight = false;
    }
  };
  const stopPerformance = (reason: 'ended' | 'failed' | 'interrupted'): void => {
    headOverlayController.stop();
    speechPhysicsBackendRef?.setBoneRotationOverlays(new Map());
    const speechMotionGeneration = currentSpeechMotionGeneration;
    const speechExitStarted = speechMotionGeneration !== null
      && speechMotionDirector.end(speechMotionGeneration);
    currentSpeechMotionGeneration = null;
    currentSpeechCueOwnerGeneration = null;
    currentSpeechBackgroundVmdPath = null;
    playbackGeneration++;
    speechCueDispatch.reset();
    speechGestureRequestInFlight = false;
    speechBackgroundRequestInFlight = false;
    if (currentPlaybackTaskId) audioPreloader?.cancel(currentPlaybackTaskId);
    // 取消未完成的 decode
    pendingDecode = null;
    // 停止 sourceNode
    if (currentSource) {
      try { currentSource.onended = null; } catch { /* ignore */ }
      try { currentSource.stop(); } catch { /* already ended */ }
      try { currentSource.disconnect(); } catch { /* already disconnected */ }
      currentSource = null;
    }
    if (mutedPlaybackFallbackTimeout !== null) {
      clearTimeout(mutedPlaybackFallbackTimeout);
      mutedPlaybackFallbackTimeout = null;
    }
    // 清零 viseme（P1-E 硬门：切回 Chat 时口型必须归零）
    (window as any).__avatarSpeaking = false;
    // 清除安全超时
    if ((window as any).__avatarSpeakingSafetyTimeout) {
      clearTimeout((window as any).__avatarSpeakingSafetyTimeout);
      (window as any).__avatarSpeakingSafetyTimeout = null;
    }
    try {
      const rt = getRuntime().actorRuntime;
      if (rt) {
        rt.stopSpeak({ preserveExpression: reason === 'ended' });
        if (reason === 'ended') {
          // Keep the facial handoff on the same timescale as the body return.
          // Opposing channels (for example frown -> smile) are released before
          // the idle channel enters, preventing a midpoint emotion snap.
          rt.transitionToIdleSmile(0.9, 0.62, defaultIdleExpression as Emotion);
        }
      }
    } catch (e) {
      console.warn('[avatar] actorRuntime.stopSpeak failed:', e);
    }
    // Phase 5.2 修正（2026-07-19）：
    // - 'interrupted' 路径：不停 VMD。
    //   理由：新语音打断时 handleAvatarPlay 会通过 mp.play() 直接交叉淡入淡出
    //   从 idle 过渡到 speech gesture；用户取消时 unsubscribeStopPlay 会显式重启 idle。
    //   如果在此停止 idle，会导致 idle → rest pose → speech gesture 的抽搐路径。
    // - 'failed' 路径使用 stopImmediate() 紧急停止
    //   理由：音频解码失败时无后续动作需要过渡，直接停止即可
    // - 'ended' 路径不停 VMD（语音结束后由 startDefaultIdlePackRef 切换回 idle，需要 fade 切换）
    try {
      // Phase 5.2B 扩展：先停止链式多段 VMD 播放
      const ms = getRuntime().motionSequence;
      if (ms && ms.getIsRunning()) {
        ms.stopImmediate();
      }
      const mp = getRuntime().motionPlayer;
      if (mp && mp.isPlaying()) {
        if (reason === 'failed') {
          mp.stopImmediate();
          // failed 后立即应用 relaxed base pose，避免 1 帧 T-pose 闪现
          try {
            const rbp = getRuntime().relaxedBasePose;
            if (rbp) rbp.apply();
          } catch (e) {
            console.warn('[avatar] relaxedBasePose.apply after stopImmediate failed:', e);
          }
        }
        if (reason === 'ended') {
          // PerformanceSession.endPerformance() clears the audio alignment
          // immediately below. Preserve the current pose/fade elapsed time on
          // the local monotonic clock so the final speech gesture cannot stay
          // stuck in fading-out after the AudioContext stops advancing.
          try { mp.handoffToLocalClock(); } catch (e) {
            console.warn('[avatar] motionPlayer handoffToLocalClock failed:', e);
          }
        }
        // phase 5.2E 修正：interrupted 不再调用 mp.stop()，
        // 让 idle 继续播放，由 handleAvatarPlay 或 unsubscribeStopPlay 负责后续动作切换
      }
      // 清除 speech gesture 的 onStop 回调，防止 gesture 结束后触发过时的 background motion
      try { mp?.setOnStop(null); } catch { /* ignore */ }
      try { mp?.setOnNaturalEnd(null); } catch { /* ignore */ }
    } catch (e) {
      console.warn('[avatar] motionPlayer stop failed:', e);
    }
    // Phase 5.2 Task 5.2.6：结束 PerformanceSession（清零时钟对齐 + viseme 时间轴）
    // 必须在 actorRuntime.stopSpeak() 之后调用，确保 viseme 权重清零
    try {
      performanceSession.endPerformance();
    } catch (e) {
      console.warn('[avatar] performanceSession.endPerformance failed:', e);
    }
    gazeControllerRef?.setSemanticTarget('neutral');
    // 空闲/ neutral 状态下眼神看向屏幕中心
    updateGazeToScreenCenter();
    gazeControllerRef?.stopSpeaking();
    pupilControllerRef?.stopSpeaking();
    if (currentSpeechGeneration !== null) {
      motionArbiter.endSpeech(currentSpeechGeneration);
      currentSpeechGeneration = null;
    }
    const idleExitDecision = idleLifecycle.endSpeech();
    speechStanceDirector.endReply();
    // 通知主进程 + Composer
    const taskId = currentPlaybackTaskId;
    const wasMuted = currentPlaybackMute;
    currentPlaybackTaskId = null;
    currentPlaybackMute = false;
    if (taskId && !wasMuted) {
      // mute 模式下不通知 Composer（Chat 窗口自行管理 UI）
      try {
        api.sendPerformanceEnded(taskId, reason);
      } catch (e) {
        console.warn('[avatar] sendPerformanceEnded failed:', e);
      }
    }
    // The configured default body is a speech-only background for head
    // overlays. After speech it fades out to the natural base pose; desktop
    // idle resumes only by arming its delayed one-shot timer.
    if (reason === 'ended') {
      try {
        const mp = getRuntime().motionPlayer;
        const defaultStillVisible = mp?.isPlaying()
          && mp.getCurrentPackId() === currentDefaultIdle;
        if (defaultStillVisible) {
          // The selected default is the desktop base. Keep it bound through
          // the speech handoff; only episodic pool actions are suppressed by
          // the idle toggle.
          idleLifecycle.started(currentDefaultIdle, 'default-loop');
        } else {
          if (mp?.isPlaying()) mp.stop();
          if (startDefaultIdlePackRef && isDesktopModeRef && motionArbiter.canRunDefaultIdle()) {
            void startDefaultIdlePackRef(true, 'speech-to-idle-recovery');
          }
        }
      } catch (error) {
        console.warn('[avatar] speech body handoff failed:', error);
      }
    }
    if (speechExitStarted && speechMotionGeneration !== null) {
      speechMotionDirector.completeExit(speechMotionGeneration);
    }
    if (idleExitDecision.scheduleNext && isDesktopModeRef && !motionArbiter.isPoseLocked()) {
      scheduleIdleRotationRef?.();
    }
  };

  /**
   * Phase 5.1 修复（P0-A/B/C）：处理 avatar:play 信号。
   * Avatar 是唯一 AudioContext/解码器/播放时钟所有者。
   *
   * 流程：
   * 1. 停止任何现有表演（清零旧 taskId 的口型）
   * 2. getAudioContext() → resume() 确保 ctx.state === 'running'
   * 3. ctx.decodeAudioData(wavBytes) 解码
   * 4. ctx.createBufferSource() + sourceNode.connect + sourceNode.start
   * 5. actorRuntime.speak() 开始张嘴
   * 6. sendPerformanceStarted(taskId) 通知 Composer 显示字幕
   *
   * 硬门失败路径（发送 performance:ended('failed')）：
   * - ctx.state !== 'running'（resume 失败，AudioContext 仍 suspended）
   * - decodeAudioData 抛错
   * - sourceNode.start 抛错
   *
   * 隐私边界：Avatar 只收到 taskId 和 wavBytes，不收到对话文本。
   */
  const handleAvatarPlay = async (taskId: string, wavBytes: ArrayBuffer, semantic?: Partial<PerformanceSemantic>, speechText?: string, mute?: boolean): Promise<void> => {
    // 停止任何现有表演（清零旧 taskId 的口型）
    stopPerformance('interrupted');
    const requestGeneration = playbackGeneration;
    const speechMotionGeneration = speechMotionDirector.prepare(taskId);
    currentSpeechMotionGeneration = speechMotionGeneration;
    lastSpeechMotionSelection = null;

    // 重新设置 currentPlaybackTaskId（stopPerformance 已清空）
    currentPlaybackTaskId = taskId;
    currentPlaybackMute = mute === true;

    let ctx: AudioContext;
    try {
      ctx = await getAudioContext();
    } catch (e) {
      console.error('[avatar] getAudioContext failed:', e);
      stopPerformance('failed');
      return;
    }

    // P0-C 硬门：AudioContext.state !== 'running' 时禁止建立 active presentation
    if (ctx.state !== 'running') {
      console.error(`[avatar] AudioContext state is ${ctx.state}, cannot perform (taskId=${taskId})`);
      stopPerformance('failed');
      return;
    }

    // AudioPreloader 只在 Avatar 已拥有的 AudioContext 内校验和解码。
    // 它没有 source/start API，不会建立 active presentation，并保留一份未 detach 的 WAV
    // 供 LipTimeline 使用。实际播放仍只能发生在下方 sourceNode.start()。
    audioPreloader ??= new AudioPreloader<AudioBuffer>({
      decode: async bytes => {
        if (!audioCtx || audioCtx.state === 'closed') throw new Error('AudioContext unavailable during decode');
        return audioCtx.decodeAudioData(bytes);
      }
    });
    let decoded: AudioBuffer;
    let wavBytesForLipTimeline: ArrayBuffer;
    const decodePromise = audioPreloader.prepare(taskId, wavBytes);
    pendingDecode = decodePromise.then(() => { /* mark complete */ }).catch(() => { /* swallow */ });
    try {
      const prepared = await decodePromise;
      decoded = prepared.decodedAudio;
      wavBytesForLipTimeline = prepared.wavBytes;
    } catch (e) {
      if (requestGeneration !== playbackGeneration || e instanceof AudioPreparationCancelledError) {
        console.log(`[avatar] playback for taskId=${taskId} was cancelled during decode`);
        return;
      }
      console.error('[avatar] decodeAudioData failed:', e);
      stopPerformance('failed');
      return;
    }

    // 解码期间可能已被停止或被新任务抢占。generation 防止旧 Promise
    // 在全局 pendingDecode 已指向新任务时错误继续启动播放。
    if (requestGeneration !== playbackGeneration || pendingDecode === null) {
      audioPreloader.cancel(taskId);
      console.log(`[avatar] playback for taskId=${taskId} was cancelled during decode`);
      return;
    }
    pendingDecode = null;
    audioPreloader.take(taskId);

    const playbackSemantic = resolvePlaybackSemantic(speechText ?? '', semantic);
    const performanceEmotion = playbackSemantic.emotion;
    const performanceIntensity = playbackSemantic.intensity;
    const performanceGaze = playbackSemantic.gaze;

    // P0-C 硬门：解码后再次检查 ctx.state（解码是 async，期间状态可能变化）
    if (ctx.state !== 'running') {
      console.error(`[avatar] AudioContext state became ${ctx.state} after decode, cannot perform`);
      stopPerformance('failed');
      return;
    }

    // 创建 sourceNode 并启动播放
    let sourceNode: AudioBufferSourceNode;
    try {
      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = decoded;
      if (currentPlaybackMute) {
        // 静音模式：通过 gain=0 的 GainNode 连接，确保音频图完整但不发声
        // sourceNode 仍会正常 start 和触发 onended，驱动口型/动作
        const muteGain = ctx.createGain();
        muteGain.gain.value = 0;
        sourceNode.connect(muteGain);
        muteGain.connect(ctx.destination);
      } else {
        sourceNode.connect(ctx.destination);
      }
      sourceNode.onended = () => {
        // 自然结束：只在 sourceNode 仍是当前播放的节点时才处理
        if (currentSource === sourceNode) {
          currentSource = null;
          stopPerformance('ended');
        }
      };
    } catch (e) {
      console.error('[avatar] createBufferSource failed:', e);
      stopPerformance('failed');
      return;
    }

    try {
      sourceNode.start();
    } catch (e) {
      console.error('[avatar] sourceNode.start failed:', e);
      try { sourceNode.disconnect(); } catch { /* ignore */ }
      stopPerformance('failed');
      return;
    }

    currentSource = sourceNode;
    if (currentPlaybackMute) {
      // A zero-gain source can lose its `onended` callback while Chromium's
      // audio service is waking. Chat normally sends avatarSyncStop when its
      // audible element ends; this timer is the deterministic fallback for a
      // missing stop/onended signal and formal direct-sync verification.
      mutedPlaybackFallbackTimeout = setTimeout(() => {
        if (currentSource === sourceNode && currentPlaybackTaskId === taskId) {
          currentSource = null;
          try { sourceNode.onended = null; } catch { /* ignore */ }
          try { sourceNode.disconnect(); } catch { /* ignore */ }
          stopPerformance('ended');
        }
      }, Math.max(1, Math.ceil(decoded.duration * 1000) + 100));
    }

    // Audio has actually started: speech now becomes the sole high-level
    // motion owner. Decode time remains free to show idle, but after this
    // boundary neither manual preview nor idle rotation may enter.
    currentSpeechGeneration = motionArbiter.beginSpeech();
    idleLifecycle.beginSpeech();
    if (!speechMotionDirector.beginAudio(speechMotionGeneration, performance.now(), decoded.duration)) {
      console.warn(`[avatar] stale speech motion preparation rejected (taskId=${taskId})`);
      stopPerformance('interrupted');
      return;
    }
    speechStanceDirector.beginReply(taskId, performanceEmotion, performanceIntensity);
    speechCueDispatch.reset();
    stopIdleRotationRef?.();
    // 不再调用 mp.stop() 停止当前 idle，而是让 idle 继续播放直到音频解码完成；
    // playSpeechCueGesture / ensureSpeechBackgroundMotion 会通过 mp.play() 的交叉淡入淡出
    // 直接从 idle 过渡到 speech gesture，避免 idle → rest pose → speech gesture 的抽搐路径。

    // 立即设置 __avatarSpeaking 标志，防止 idle 轮换在音频启动后误切换
    (window as any).__avatarSpeaking = true;
    // 安全超时：如果 120 秒后 __avatarSpeaking 仍为 true（音频异常结束未清理），强制重置
    const speakingSafetyTimeout = setTimeout(() => {
      if ((window as any).__avatarSpeaking) {
        console.warn('[avatar] __avatarSpeaking safety timeout (120s), forcing reset');
        (window as any).__avatarSpeaking = false;
      }
    }, 120000);
    (window as any).__avatarSpeakingSafetyTimeout = speakingSafetyTimeout;

    // 音频真正开始后只开启 speech 状态。表情和口型由同一 PerformanceClock
    // 在后续渲染帧采样，避免解码/动作切换前提前写脸。
    try {
      const rt = getRuntime().actorRuntime;
      if (rt) {
        rt.speak('speaking');
      }
    } catch (e) {
      console.warn('[avatar] actorRuntime.speak failed:', e);
    }

    // 开始 PerformanceSession（对齐 PerformanceClock，生成 viseme 时间轴）
    let audioStartTime = 0;
    let performanceClockStarted = false;
    try {
      const beginInfo = performanceSession.beginPerformance(
        taskId,
        getPerformanceClockTime(),
        wavBytesForLipTimeline,
        speechText,
        performanceEmotion,
        performanceIntensity,
        {
          ...playbackSemantic,
          emotion: performanceEmotion as PerformanceSemantic['emotion'],
          intent: playbackSemantic.intent,
          intensity: performanceIntensity,
          gaze: performanceGaze
        }
      );
      audioStartTime = beginInfo.audioStartTime;
      performanceClockStarted = true;
      const initialCue = performanceSession.getCurrentPerformanceCue();
      gazeControllerRef?.setSpeakingSemantic(
        initialCue ? resolveSpeechGazeSemantic(initialCue) : performanceEmotion
      );
      gazeControllerRef?.startSpeaking();
      pupilControllerRef?.startSpeaking(initialCue?.facialEmotion ?? performanceEmotion);
    } catch (e) {
      console.warn('[avatar] performanceSession.beginPerformance failed:', e);
    }

    // Candidate review admits at most one SHA-bound gesture for the complete
    // reply. Missing/SHA-invalid candidates fail closed to lip + expression;
    // they do not fall back to a filename-selected VMD.
    const initialCue = performanceSession.getCurrentPerformanceCue();
    if (initialCue && speechCueDispatch.enter(initialCue) && currentSpeechGeneration !== null) {
      const speechGeneration = currentSpeechGeneration;
      const facialEmotion = initialCue.facialEmotion;
      void playSpeechCueGesture(initialCue, speechGeneration, speechMotionGeneration, facialEmotion).then(started => {
        if (!started && isSpeechCueWaitingForMotionHandoff(initialCue, speechGeneration)) {
          speechCueDispatch.release(initialCue);
        } else if (!started) {
          void ensureSpeechBackgroundMotion(speechGeneration, speechMotionGeneration);
        }
      }).catch(error => {
        console.warn('[avatar] speech gesture request failed; releasing motion owner:', error);
        speechCueDispatch.release(initialCue);
        void ensureSpeechBackgroundMotion(speechGeneration, speechMotionGeneration);
      });
    } else if (currentSpeechGeneration !== null) {
      void ensureSpeechBackgroundMotion(currentSpeechGeneration, speechMotionGeneration);
    }

    // P0-C 硬门：所有条件满足后才通知 Composer 显示字幕
    // 条件：ctx.state === 'running' && decodeAudioData 成功 && sourceNode.start 调度 && actorRuntime.speak 调用
    // Phase 5.2 Task 5.2.6：携带 audioStartTime 供 Composer 字幕同步（可选，向后兼容）
    // mute 模式下跳过（Chat 窗口自行管理 UI，不通知 Composer）
    if (!currentPlaybackMute) {
      try {
        api.sendPerformanceStarted(taskId, audioStartTime);
      } catch (e) {
        console.warn('[avatar] sendPerformanceStarted failed:', e);
      }
    }
  };

  const unsubscribePlay = api.onAvatarPlay((taskId: string, wavBytes: ArrayBuffer, semantic?: Partial<PerformanceSemantic>, speechText?: string, mute?: boolean) => {
    // 异步处理，不阻塞 IPC 回调
    void handleAvatarPlay(taskId, wavBytes, semantic, speechText, mute).catch(e => {
      console.error('[avatar] handleAvatarPlay unexpected error:', e);
      stopPerformance('failed');
    });
  });

  const unsubscribeStopPlay = api.onAvatarStopPlay((reason, taskId) => {
    if (taskId && taskId !== currentPlaybackTaskId) return;
    const normalizedReason = reason === 'mode-change' ? 'interrupted' : reason;
    const performanceReason = performanceStopReasonForAvatarSignal(normalizedReason, currentPlaybackMute);
    // A Chat-side pause/cancel of muted sync playback behaves like a completed
    // performance so the current gesture transitions immediately to default
    // idle. A replacement interruption keeps the visible pose for the next cue.
    stopPerformance(performanceReason);
  });

  // Phase 5.2 修正（2026-07-19）：订阅 emotion 更新信号
  // 用户要求：emotion 变化只能在安全边界切换动作族
  // 安全边界 = speaking 状态下，通过 MotionPlayer 的 fade-out → fade-in 切换
  // 此回调在 speaking 过程中收到新的 emotion/intent 时：
  // 1. 调用 Planner 重新选择 gesture pack
  // 2. 通过 motionPlayer.play() 触发 fade-out → fade-in 切换（不先 reset 到 Base Pose）
  // 3. 如果新 emotion 对应不同的 gestureFamily，fade 切换确保动作平滑过渡
  // 4. 如果不在 speaking 状态，忽略（idle 切换由 mode-change 或 idle 结束处理）
  const unsubscribeMotionEmotionUpdate = api.onMotionEmotionUpdate(() => {
    // The immutable speech timeline is the sole owner of expression, gaze and
    // gesture changes while audio is active. Untimed IPC updates are ignored.
  });

  // Phase 5.2 修正（2026-07-19）：订阅 motion 命令 IPC
  // 主进程持有 MotionPackRegistry 和生命周期，通过此 IPC 通知 Renderer 执行 motion 命令。
  // 用户要求：Renderer 不能自行信任路径或未白名单 pack。
  // 主进程校验 pack 后通过此 IPC 发送命令，Renderer 只执行主进程授权的命令。
  const unsubscribeMotionCommand = api.onMotionCommand((command) => {
    try {
      const mp = getRuntime().motionPlayer;
      if (!mp) return;
      switch (command.action) {
        case 'stop':
          // 主进程授权的停止（如模式切换、用户取消）
          // 使用 stopImmediate() 紧急停止（主进程已决定停止，不需要 fade）
          mp.stopImmediate();
          break;
        case 'list':
          // 主进程请求列出当前可用的 pack（通过 sendPerformanceEnded 或其他 IPC 回传）
          // 当前 Phase 5.2 只记录日志，实际列表由主进程 Registry 维护
          console.log('[avatar] motion:list command received, packId=', mp.getCurrentPackId());
          break;
        case 'load':
        case 'play':
          // load/play 命令由主进程通过 motion:play IPC 触发，包含 semantic 信息
          // Renderer 根据 semantic 调用 Planner 选择 VMD（不直接信任 packId）
          if (command.semantic) {
            const emotion = command.semantic.emotion ?? 'neutral';
            const intent = command.semantic.intent ?? '';
            const plan = performanceSession.plan({
              emotion,
              intent,
              speaking: true,
              enabledVmdPaths: enabledVmdPaths,
              defaultIdleVmd: currentDefaultIdle
            });
            if (plan.speakingVmdPath) {
              const vmdPath = plan.speakingVmdPath;
              const packId = `speaking:${vmdPath.replace(/[\\/]/g, '_')}`;
              void api.loadCustomVmdBytes(vmdPath).then(vmdBytes => {
                void mp.play(packId, vmdBytes, {
                  boneMapping: {},
                  amplitudeLimits: DEFAULT_AMPLITUDE_LIMITS,
                  looping: false,
                  timeSource: 'performance-clock',
                  fadeInSeconds: 0.35,
                  fadeOutSeconds: 0.55,
                  cooldownSeconds: 4,
                  compositionMode: 'absolute',
                  candidateTrackPolicy: 'dialogue-body-only',
                  // 进入侧衔接：speech-entry 桥在动作起始时限制腿部大范围变化
                  // 并持腿，避免进入姿态跳变。
                  transitionProfile: 'speech-entry'
                });
                // 退出侧衔接：动作播放结束后复用语音后台恢复（speech-to-idle-recovery），
                // 捕获当前腿部姿态平滑松弛回默认，避免一帧内平移瞬移。
                // 仅当仍处于 speech 会话时拉起，避免脱离上下文空跑。
                mp.setOnStop(() => {
                  if (currentSpeechGeneration === null
                    || !motionArbiter.isCurrentSpeech(currentSpeechGeneration)
                    || performanceSession.getState() !== 'performing') return;
                  const speechMotionGen = currentSpeechMotionGeneration ?? 0;
                  void ensureSpeechBackgroundMotion(currentSpeechGeneration, speechMotionGen);
                });
              }).catch(e => console.warn('[avatar] motion:play failed:', e));
            }
          }
          break;
      }
    } catch (e) {
      console.warn('[avatar] onMotionCommand handler failed:', e);
    }
  });

  // 测试模式下默认不加载 PMX（保持现有 window-switch.spec.ts 行为）
  const identity = await startupIdentityPromise;
  document.documentElement.dataset.buildId = BUILD_ID;
  (window as any).__CHATX2_BUILD_ID__ = BUILD_ID;
  (getRuntime() as any).__debugBuildIdentity = () => ({
    compiledBuildId: BUILD_ID,
    runtimeBuildId: identity.buildId,
    appPath: identity.appPath,
    resourcesPath: identity.resourcesPath,
    pageUrl: window.location.href
  });
  if (identity.isTest && !identity.pmxRenderInTest) {
    if (statusLabel) statusLabel.textContent = '[Placeholder - test mode]';
    drawPlaceholder(canvas);
    api.signalAvatarReady();

    // Phase 5.1 P0-A/B/C：测试模式也需要清理 AudioContext + 取消订阅 + 停止表演
    // 测试模式下 Avatar 仍负责音频播放（decodeAudioData + sourceNode.start），只是没有 PMX 渲染
    const testModeOnBeforeUnload = (): void => {
      stopPerformance('interrupted');
      try { unsubscribePlay(); } catch { /* ignore */ }
      try { unsubscribeStopPlay(); } catch { /* ignore */ }
      if (audioCtx && audioCtx.state !== 'closed') {
        try { audioCtx.close(); } catch { /* ignore */ }
        audioCtx = null;
      }
    };
    window.addEventListener('beforeunload', testModeOnBeforeUnload);
    return;
  }

  // 尝试加载真实 PMX 模型
  try {
    if (statusLabel) statusLabel.textContent = '[Loading PMX...]';
    const loadTimingStart = performance.now();
    const loadTiming = (label: string) => {
      console.log(`[avatar] load-timing ${label}: ${Math.round(performance.now() - loadTimingStart)}ms`);
    };

    // 物理世界在模型加载时创建，因此先读取持久化档位；切档后的渲染和
    // Planner 预算立即生效，Bullet 求解参数在下次模型加载时生效。
    const [, pmxArrayBuffer] =
      await Promise.all([startupComputeLevelPromise, api.loadPmxModel()]);
    loadTiming('pmx-bytes');

    // 通过 IPC 获取 PMX 文件字节
    const pmxBytes = new Uint8Array(pmxArrayBuffer);
    // Start Bullet initialization as soon as the PMX bytes are available so
    // WASM compilation overlaps the synchronous PMX audit and SHA calculation.
    // This keeps startup latency shared across every model instead of making
    // the avatar wait through three strictly serial phases.
    const physicsLoadPromise = startupPhysicsLoadPromise;
    // Phase 3 Integration Closure：计算实际 PMX SHA-256 用于材质兼容规则绑定
    // applyMmdMaterialCompatibility 会比对 manifest.model.sha256，不匹配则 fail-closed（不应用任何规则）
    //
    // 2026-08 启动性能：SHA-256（大 PMX 实测 ~311ms）的结果只在 loadModel
    // 之后的路径使用（每帧材质兼容 hook / 性能 profile 匹配），而 loadModel
    // 本身耗时 ~1.7s。这里不 await，让它与 loadModel 完全并行、被完全
    // 掩盖；loadModel 完成后再取结果（那时必然已就绪）。
    const pmxSha256Promise = computeSha256Hex(pmxBytes);
    let actualPmxSha256 = '';
    const performanceProfiles = [
      selenaPerformanceProfileJson,
      yangyangPerformanceProfileJson
    ] as unknown as AvatarPerformanceProfile[];
    // SHA 结果延后到 loadModel 之后取（见上方 pmxSha256Promise 注释）。
    const resolvePmxSha256 = async (): Promise<void> => {
      actualPmxSha256 = await pmxSha256Promise;
      loadTiming('sha256');
      shaMatchedPerformanceProfile = performanceProfiles.find(profile =>
        profile.avatarSha256.toUpperCase() === actualPmxSha256.toUpperCase());
      if (!shaMatchedPerformanceProfile) {
        console.warn('[avatar] no SHA-matched facial performance profile; using legacy expression path');
      }
    };
    let shaMatchedPerformanceProfile: AvatarPerformanceProfile | undefined;

    // 物理引擎审计：检查 PMX 是否包含刚体和 Joint
    const pmxPhysicsAudit: PmxPhysicsAudit = auditPmxPhysics(pmxBytes);
    const modelHasPhysics = pmxPhysicsAudit.hasRigidBodies;
    let physicsEnabled = false;
    let physicsBackend: ReturnType<typeof getBulletBackend> = null;

    if (modelHasPhysics) {
      if (statusLabel) statusLabel.textContent = '[Loading physics engine...]';
      try {
        physicsBackend = await physicsLoadPromise;
        loadTiming('physics-backend');
        if (physicsBackend) {
          physicsEnabled = true;
          speechPhysicsBackendRef = physicsBackend;
          console.log(
            `[avatar] physics enabled: ${pmxPhysicsAudit.rigidBodyCount} rigid bodies, ` +
            `${pmxPhysicsAudit.jointCount} joints, ${pmxPhysicsAudit.dynamicBoneCount} dynamic bones`
          );
        } else {
          console.warn('[avatar] physics available in PMX but Bullet backend failed to load');
        }
      } catch (e) {
        console.warn('[avatar] Bullet physics load failed:', e);
      }
    } else {
      console.log('[avatar] physics disabled: PMX has no rigid bodies or joints');
    }

    // 创建纹理解析器：通过 IPC 加载纹理文件
    // Bug 3 修复：纹理加载由 loadModel() 内部管理，resolve 后纹理已加载
    // Task 6 Step 4：收集 objectUrls 用于 cleanup 时 revokeObjectURL
    const objectUrls: string[] = [];
    // 计时统计：贴图 IPC 累计耗时（串行瓶颈诊断用）
    let textureIpcTotalMs = 0;
    let textureIpcCount = 0;
    let textureFirstResolveAt = 0;
    let textureLastResolveAt = 0;
    const textureResolver = {
      async resolve(path: string): Promise<string | undefined> {
        const normalized = normalizeMmdTexturePath(path);
        if (textureFirstResolveAt === 0) textureFirstResolveAt = performance.now();
        const t0 = performance.now();
        const buffer = await api.loadTexture(normalized);
        textureIpcTotalMs += performance.now() - t0;
        textureIpcCount += 1;
        textureLastResolveAt = performance.now();
        if (!buffer) {
          console.warn(`[avatar] texture not found: ${normalized}`);
          return undefined;
        }
        const blob = new Blob([buffer]);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return url;
      }
    };

    // 创建 MMD 加载器（@yohawing/three-mmd-loader）
    // 该库正确处理 PMX 坐标系转换、骨骼/IK/Morph
    // Phase 3 Integration Closure：geometryAwareAlpha=true 让加载器根据 UV 实际采样的 alpha
    // 判断材质透明模式，避免 Face_2+ 等 RGBA 透明贴花被当成不透明材质（导致黑底）
    // 物理引擎：当 PMX 包含刚体和 Joint 且 Bullet 后端加载成功时，启用 external 物理
    const loader = new ThreeMmdLoader({
      textureResolver,
      geometryAwareAlpha: true,
      runtime: physicsBackend ? {
        physics: 'external' as const,
        physicsBackend
      } : undefined
    });

    if (statusLabel) statusLabel.textContent = '[Parsing PMX + loading textures...]';

    // 加载模型（async，resolve 后纹理已加载完成 — Bug 3 修复）
    // outline/materialRenderOrder 禁用：@yohawing 的 outline 代理 mesh 使用原始 MeshToonMaterial
    // 会导致 shader 编译失败（与本模型的 SDEF 数据冲突），暂不启用
    const model = await loader.loadModel(pmxBytes, {
      outline: false,
      materialRenderOrder: false
    });
    loadTiming('load-model(pmx-parse+textures+physics-build)');
    // loadModel 已完成（~1.7s > SHA ~0.3s），此刻取 SHA 结果必然已就绪，
    // 该 await 实际零等待（见 pmxSha256Promise 注释）。
    await resolvePmxSha256();
    console.log(
      `[avatar] load-timing texture-ipc: ${textureIpcCount} 次, 累计 ${Math.round(textureIpcTotalMs)}ms, `
      + `贴图阶段墙钟 ${Math.round(textureLastResolveAt - textureFirstResolveAt)}ms, `
      + `首请求前(≈PMX解析) ${Math.round(textureFirstResolveAt - loadTimingStart)}ms`
    );

    const currentPackAtLoad = await startupModelPackPromise;
    const configuredDisabledDynamicBones = currentPackAtLoad.success && 'physics' in currentPackAtLoad
      ? currentPackAtLoad.physics?.disabledDynamicBones ?? []
      : [];
    const disabledDynamicBones = [
      ...new Set([
        ...resolveUnifiedDynamicBonePolicy(configuredDisabledDynamicBones),
        ...resolveModelSpecificDisabledDynamicBones({
          packId: currentPackAtLoad.success && 'packId' in currentPackAtLoad
            ? currentPackAtLoad.packId
            : undefined,
          pmxSha256: actualPmxSha256,
          dynamicBoneNames: pmxPhysicsAudit.dynamicBoneNames
        })
      ])
    ];
    physicsBackend?.setDisabledBoneNames(disabledDynamicBones);
    if (physicsBackend && configuredDisabledDynamicBones.length > 0
      && resolveUnifiedDynamicBonePolicy(configuredDisabledDynamicBones).length === 0) {
      console.log('[avatar] ignored legacy model-specific dynamic-bone disables; unified physics policy is active');
    }
    if (disabledDynamicBones.length > 0) {
      console.log(`[avatar] model-specific dynamic-bone stability guard: ${disabledDynamicBones.length} bones`);
    }
    const profileSelection = selectValidatedProfile(
      performanceProfiles,
      actualPmxSha256,
      new Set(Object.keys(model.mesh.morphTargetDictionary ?? {})),
      new Set(model.mesh.skeleton.bones.map(bone => bone.name)),
      currentPackAtLoad.success && 'packId' in currentPackAtLoad
        ? (currentPackAtLoad.packId ?? '')
        : ''
    );
    const runtimeManifest = buildRuntimeAvatarManifest(currentPackAtLoad);
    // Material compatibility must follow the active model pack.  Using the
    // built-in Selena manifest here made imported PMX rules fail closed by SHA
    // and was the reason Face_2+ nose overlays remained as white triangles.
    const materialCompatibilityManifest = runtimeManifest as unknown as MmdMaterialCompatibilityManifest;
    const selectedPerformanceProfile = profileSelection.profile
      ?? buildImportedPerformanceProfile(
        currentPackAtLoad,
        actualPmxSha256,
        new Set(Object.keys(model.mesh.morphTargetDictionary ?? {}))
      );
    performanceSession.setFacialPersonality(selectedPerformanceProfile?.facialPersonality);
    getRuntime().getFacialProfileValidation = () => profileSelection.validation;
    if (!profileSelection.validation.valid) {
      console.warn('[avatar] facial performance profile rejected:', profileSelection.validation.reasons);
    } else {
      console.log(`[avatar] facial performance profile validated: ${selectedPerformanceProfile!.modelId}`);
    }

    // 替换 MeshToonMaterial 为 MeshStandardMaterial
    // 原因：@yohawing/three-mmd-loader 的 MeshToonMaterial + SDEF shader hooks 与 three@0.185.1
    // 不兼容（shader 编译失败，VALIDATE_STATUS false），导致渲染全透明。
    // MeshStandardMaterial 不附加 SDEF shader hooks，可正常编译。
    // Phase 3 Integration Closure：改用 mmd-material-conversion.ts 的实现，
    // 保留纹理/alpha/颜色和安全的 MMD transparencyMode 元数据（runtime sync 需要）。
    replaceMmdMaterialsWithStandard(model.mesh);
    for (const outlineMesh of model.outlineMeshes ?? []) {
      replaceMmdMaterialsWithStandard(outlineMesh);
    }
    loadTiming('material-conversion');
    // User-imported PMX atlases are not guaranteed to use one consistent
    // winding order.  Selena Q in particular authors limb faces opposite to
    // the torso; FrontSide culling therefore made both arms and parts of both
    // legs disappear after the shared StandardMaterial conversion.  Imported
    // packs use DoubleSide as a compatibility fallback, while audited built-in
    // packs retain their authored side/culling settings.
    const importedModelPack = currentPackAtLoad.success
      && typeof currentPackAtLoad.packId === 'string'
      && currentPackAtLoad.packId.startsWith('imported-');
    if (importedModelPack) {
      const makeDoubleSided = (mesh: THREE.SkinnedMesh): void => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          material.side = THREE.DoubleSide;
          material.needsUpdate = true;
        }
      };
      makeDoubleSided(model.mesh);
      for (const bodyMesh of (model.mesh.userData as { mmdMorphSplitBodyMeshes?: THREE.SkinnedMesh[] }).mmdMorphSplitBodyMeshes ?? []) {
        makeDoubleSided(bodyMesh);
      }
    }

    if (statusLabel) {
      const vertCount = (model.mesh.geometry.getAttribute('position') as THREE.BufferAttribute)?.count ?? '?';
      statusLabel.textContent = `[PMX loaded: ${vertCount} verts]`;
    }

    // 设置 Canvas 尺寸
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 创建 Three.js 渲染器
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // Prefer the discrete/high-performance GPU when available; this keeps
      // model switching responsive without changing animation or physics.
      powerPreference: 'high-performance',
      precision: 'highp',
      // 首帧像素检查在 render() 后立即执行，不需要保留 framebuffer。
      // 生产环境关闭该选项可避免每帧额外的 GPU 保留/同步成本；调试和
      // PMX 证据测试仍保留，方便截图与像素验收。
      preserveDrawingBuffer: isDebugMode || (identity.isTest && identity.pmxRenderInTest)
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 限制最大像素比，避免高 DPI 屏性能压力
    renderer.setSize(canvas.width, canvas.height);
    renderer.setClearColor(0x000000, 0);
    // 色调映射：ACESFilmic 提升高光与暗部层次，避免过曝与死黑
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1; // 略微提亮整体画面
    // 输出色彩空间：sRGB（Three.js r152+ 默认，显式设置确保一致性）
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Improve texture fidelity on oblique/large surfaces (hair, ribbons and
    // clothing) without changing model geometry or material compatibility.
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    if (maxAnisotropy > 1) {
      model.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : (mesh.material ? [mesh.material] : []);
        for (const material of materials) {
          const map = (material as THREE.MeshStandardMaterial).map;
          if (map) {
            map.anisotropy = maxAnisotropy;
            map.needsUpdate = true;
          }
        }
      });
    }

    // 创建场景
    const scene = new THREE.Scene();
    scene.add(model.root);

    // 计算包围盒（@yohawing 已处理坐标系转换，直接使用 Three.js 坐标）
    const bbox = new THREE.Box3().setFromObject(model.root);
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    // 相机：根据模型包围盒 + 窗口宽高比自动定位，确保全身可见
    // 同时计算垂直和水平方向所需距离，取较大值避免裁切
    const vFovDeg = 30;
    const vFovRad = (vFovDeg * Math.PI) / 180;
    const aspect = canvas.width / canvas.height;
    const hFovRad = 2 * Math.atan(aspect * Math.tan(vFovRad / 2));
    const padding = 1.15; // 留 15% 边距，模型不贴边
    const distV = (size.y / 2) / Math.tan(vFovRad / 2) * padding;
    const distH = (size.x / 2) / Math.tan(hFovRad / 2) * padding;
    const distance = Math.max(distV, distH, 5);
    const camera = new THREE.PerspectiveCamera(vFovDeg, aspect, 0.1, 1000);
    camera.position.set(0, center.y, distance);
    camera.lookAt(0, center.y, 0);
    const userFacingController = new ModelUserFacingController(model.root.quaternion);
    userFacingControllerRef = userFacingController;

    // 灯光：三点布光 + 半球光，解决整体偏暗与面部阴影死区
    // 半球光：天空色（暖白）从上方照射，地面色（冷灰）从下方反射，提供柔和环境补光
    const hemisphereLight = new THREE.HemisphereLight(0xfff4e6, 0x4a4a5a, 0.9);
    scene.add(hemisphereLight);
    // 主光：右前上方，暖白色，强度充足，位置归一化避免方向偏差
    const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.2);
    keyLight.position.set(2, 3, 4); // 右前上方，归一化方向
    scene.add(keyLight);
    // 补光：左前侧，冷白色，强度较弱，填充主光产生的阴影
    const fillLight = new THREE.DirectionalLight(0xdce8ff, 0.7);
    fillLight.position.set(-3, 1.5, 2.5); // 左前侧
    scene.add(fillLight);
    // 轮廓光（背光）：后方上方，暖色，勾勒模型边缘，分离背景
    const rimLight = new THREE.DirectionalLight(0xffd9a8, 0.8);
    rimLight.position.set(-1, 2.5, -4); // 后方上方
    scene.add(rimLight);

    // 存储灯光引用，供打光预设切换使用
    const sceneLights = { hemisphereLight, keyLight, fillLight, rimLight };

    // 打光预设配置（默认值，会被 manifest.json 中的 lighting 覆盖）
    const defaultLightingPresets: Record<string, {
      name: string;
      hemi: { sky: number; ground: number; intensity: number };
      key: { color: number; intensity: number; x: number; y: number; z: number };
      fill: { color: number; intensity: number; x: number; y: number; z: number };
      rim: { color: number; intensity: number; x: number; y: number; z: number };
      toneMappingExposure: number;
    }> = {
      'warm-studio': {
        name: '暖色工作室',
        hemi: { sky: 0xfff4e6, ground: 0x4a4a5a, intensity: 0.9 },
        key: { color: 0xfff2e0, intensity: 2.2, x: 2, y: 3, z: 4 },
        fill: { color: 0xdce8ff, intensity: 0.7, x: -3, y: 1.5, z: 2.5 },
        rim: { color: 0xffd9a8, intensity: 0.8, x: -1, y: 2.5, z: -4 },
        toneMappingExposure: 1.1
      },
      'cool-daylight': {
        name: '冷色日光',
        hemi: { sky: 0xe8f0ff, ground: 0x3a4a5a, intensity: 1.0 },
        key: { color: 0xf0f4ff, intensity: 2.5, x: 1.5, y: 4, z: 3 },
        fill: { color: 0xc8d8f0, intensity: 0.8, x: -2.5, y: 1, z: 2 },
        rim: { color: 0xc0d8f0, intensity: 0.9, x: -0.5, y: 2, z: -3.5 },
        toneMappingExposure: 1.0
      },
      'dramatic': {
        name: '戏剧舞台',
        hemi: { sky: 0x3a3040, ground: 0x1a1a2a, intensity: 0.4 },
        key: { color: 0xffe8d0, intensity: 3.5, x: 3, y: 2.5, z: 2 },
        fill: { color: 0x8060a0, intensity: 0.3, x: -3, y: 0.5, z: 1.5 },
        rim: { color: 0xffa060, intensity: 1.5, x: -1, y: 3, z: -5 },
        toneMappingExposure: 1.2
      },
      'soft-portrait': {
        name: '柔和肖像',
        hemi: { sky: 0xfff8f0, ground: 0x5a5a6a, intensity: 1.1 },
        key: { color: 0xfff5ee, intensity: 1.8, x: 1, y: 2.5, z: 5 },
        fill: { color: 0xf0e8ff, intensity: 0.9, x: -2, y: 1.5, z: 3 },
        rim: { color: 0xffe8d8, intensity: 0.5, x: -0.5, y: 2, z: -3 },
        toneMappingExposure: 0.9
      },
      'night-mood': {
        name: '夜色氛围',
        hemi: { sky: 0x202840, ground: 0x101020, intensity: 0.5 },
        key: { color: 0xc0d0ff, intensity: 1.8, x: 1, y: 3, z: 3 },
        fill: { color: 0x304060, intensity: 0.5, x: -2, y: 1, z: 2 },
        rim: { color: 0x6080c0, intensity: 1.2, x: -1, y: 2, z: -4 },
        toneMappingExposure: 1.3
      }
    };
    // 从 manifest.json 读取角色专属打光预设（覆盖默认值）
    let lightingPresets = { ...defaultLightingPresets };
    let currentLightingPreset = 'warm-studio';
    let currentLightingDynamic: Record<string, number> = {};

    // 异步加载角色专属打光配置
    async function loadLightingFromManifest(): Promise<void> {
      try {
        const cur = await api.getCurrentModelPack();
        if (cur.success && cur.lighting) {
          // 合并 manifest 中的预设（覆盖默认值中同 key 的预设）。
          const manifestPresets = cur.lighting.presets ?? {};
          for (const key of Object.keys(manifestPresets)) {
            const p = manifestPresets[key];
            lightingPresets[key] = {
              name: p.name || key,
              hemi: { sky: p.hemi?.sky ?? 0xfff4e6, ground: p.hemi?.ground ?? 0x4a4a5a, intensity: p.hemi?.intensity ?? 0.9 },
              key: { color: p.key?.color ?? 0xfff2e0, intensity: p.key?.intensity ?? 2.2, x: p.key?.x ?? 2, y: p.key?.y ?? 3, z: p.key?.z ?? 4 },
              fill: { color: p.fill?.color ?? 0xdce8ff, intensity: p.fill?.intensity ?? 0.7, x: p.fill?.x ?? -3, y: p.fill?.y ?? 1.5, z: p.fill?.z ?? 2.5 },
              rim: { color: p.rim?.color ?? 0xffd9a8, intensity: p.rim?.intensity ?? 0.8, x: p.rim?.x ?? -1, y: p.rim?.y ?? 2.5, z: p.rim?.z ?? -4 },
              toneMappingExposure: p.toneMappingExposure ?? 1.1
            };
          }
          // 应用角色保存的当前预设
          if (cur.lighting.currentPreset && lightingPresets[cur.lighting.currentPreset]) {
            currentLightingPreset = cur.lighting.currentPreset;
          }
          // 角色级动态参数在预设应用后覆盖，保证重启后仍恢复用户微调。
          const dynamic = cur.lighting.dynamic;
          currentLightingDynamic = dynamic && typeof dynamic === 'object'
            ? { ...dynamic }
            : {};
        }
      } catch (e) {
        console.warn('[avatar] load lighting from manifest failed, using defaults:', e);
      }
    }

    function applyLightingDynamic(dynamic: Record<string, unknown>): void {
      try {
            if (typeof dynamic.keyX === 'number' && typeof dynamic.keyY === 'number' && typeof dynamic.keyZ === 'number') {
              keyLight.position.set(dynamic.keyX, dynamic.keyY, dynamic.keyZ);
            }
            if (typeof dynamic.keyIntensity === 'number') keyLight.intensity = dynamic.keyIntensity;
            if (typeof dynamic.fillIntensity === 'number') fillLight.intensity = dynamic.fillIntensity;
            if (typeof dynamic.rimIntensity === 'number') rimLight.intensity = dynamic.rimIntensity;
            if (typeof dynamic.hemiIntensity === 'number') hemisphereLight.intensity = dynamic.hemiIntensity;
            // Missing legacy values are the neutral default and must clear a
            // previous character's canvas filter when the model changes.
            renderer.domElement.style.filter = lightingCanvasFilter(dynamic.contrast, dynamic.saturation);
      } catch (e) {
        console.warn('[avatar] apply lighting dynamic failed:', e);
      }
    }

    /** 应用打光预设 */
    function applyLightingPreset(presetId: string): void {
      const preset = lightingPresets[presetId];
      if (!preset) return;
      currentLightingPreset = presetId;
      // 半球光
      hemisphereLight.color.set(preset.hemi.sky);
      hemisphereLight.groundColor.set(preset.hemi.ground);
      hemisphereLight.intensity = preset.hemi.intensity;
      // 主光
      keyLight.color.set(preset.key.color);
      keyLight.intensity = preset.key.intensity;
      keyLight.position.set(preset.key.x, preset.key.y, preset.key.z);
      // 补光
      fillLight.color.set(preset.fill.color);
      fillLight.intensity = preset.fill.intensity;
      fillLight.position.set(preset.fill.x, preset.fill.y, preset.fill.z);
      // 轮廓光
      rimLight.color.set(preset.rim.color);
      rimLight.intensity = preset.rim.intensity;
      rimLight.position.set(preset.rim.x, preset.rim.y, preset.rim.z);
      // 色调映射曝光
      renderer.toneMappingExposure = preset.toneMappingExposure;
      console.log('[avatar] lighting preset applied:', preset.name);
    }

    // 环境贴图：程序化生成柔和环境光，提升 MeshStandardMaterial 的 PBR 反射
    // 用简单场景（渐变背景 + 几个面光源）生成 cubemap，无需外部 HDRI 文件
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    // 上方暖白光（模拟天花板光源）
    const envTopLight = new THREE.Mesh(
      new THREE.SphereGeometry(10, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff5e8, side: THREE.BackSide })
    );
    envTopLight.position.set(0, 8, 0);
    envTopLight.scale.setScalar(2);
    envScene.add(envTopLight);
    // 下方冷灰光（模拟地面反射）
    const envBottomLight = new THREE.Mesh(
      new THREE.SphereGeometry(10, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x556070, side: THREE.BackSide })
    );
    envBottomLight.position.set(0, -8, 0);
    envBottomLight.scale.setScalar(2);
    envScene.add(envBottomLight);
    // 四周中性环境（模拟墙面）
    const envWalls = new THREE.Mesh(
      new THREE.SphereGeometry(20, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x8090a0, side: THREE.BackSide })
    );
    envScene.add(envWalls);
    const environmentTexture = pmremGenerator.fromScene(envScene, 0.04).texture;
    scene.environment = environmentTexture;
    pmremGenerator.dispose();
    loadTiming('env-map+renderer-setup');

    // 初始化 rest pose（骨骼/IK 初始化）
    model.update(0);
    loadTiming('model-update(rest pose)');

    // 闪烁修复：在 mesh.onBeforeRender 中应用材质兼容规则，
    // 确保在 renderer.render() 前最后一步覆盖 syncMmdMaterialStates 的 colorWrite 重置。
    // onBeforeRender 在每帧 render 前由 Three.js 自动调用，晚于 model.update() 内部的 sync。
    //
    // 需同时修复主 mesh、body meshes（morph split 子几何体）和 outline meshes 的材质，
    // 因为 syncMmdMaterialStates 通过 syncThreeMmdRuntimeToMeshInternal 会重置所有 mesh 的 colorWrite。
    model.mesh.onBeforeRender = () => {
      // Keep each mesh's material array flat. Compatibility indices are
      // PMX-local; wrapping an array-valued material in another array makes
      // Face_2+ lookups miss silently.
      const meshes: THREE.SkinnedMesh[] = [model.mesh];
      // body meshes（morph split 子几何体，存储在 userData 中）
      const bodyMeshes = (model.mesh.userData as { mmdMorphSplitBodyMeshes?: THREE.SkinnedMesh[] }).mmdMorphSplitBodyMeshes;
      if (bodyMeshes) {
        meshes.push(...bodyMeshes);
      }
      // outline meshes
      if (model.outlineMeshes) {
        meshes.push(...model.outlineMeshes);
      }
      for (const mesh of meshes) {
        applyMmdMaterialCompatibility(
          mesh.material,
          actualPmxSha256,
          materialCompatibilityManifest
        );
        // 隐形深度墙修复：loader 的 syncMmdMaterialStates 每帧把
        // colorWrite=false 的隐形材质（body+/后发渐变过渡等）重置为
        // depthWrite=true，弯臂/合拢时手臂被隐形墙深度遮挡 → 桌面透出。
        // 在 sync 之后统一关掉（详见 disableInvisibleMaterialDepthWrite）。
        disableInvisibleMaterialDepthWrite(mesh.material);
      }
    };

    // 渲染首帧
    loadTiming('scene-setup(相机/morph/灯光)');
    // 并行 shader 编译（KHR_parallel_shader_compile）：41 个材质的 PBR 程序
    // 在驱动线程并行编译，替代首帧 render 内的串行编译（实测省数百 ms）。
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(scene, camera);
    }
    loadTiming('shader-compile(并行)');
    renderer.render(scene, camera);

    // 首帧像素健康检查
    // Pixel readback is a diagnostic gate only. It synchronously flushes the
    // GPU and is unnecessary for normal users after the renderer has loaded;
    // keep it for debug/PMX evidence runs where screenshots are audited.
    const healthCheck = isDebugMode || (identity.isTest && identity.pmxRenderInTest)
      ? checkFirstFramePixels(canvas)
      : { ok: true };
    if (!healthCheck.ok) {
      throw new Error(`Pixel health check failed: ${healthCheck.reason}`);
    }

    // 首帧成功，通知主进程
    loadTiming('first-frame(含 shader 编译+首渲染)');
    if (statusLabel) {
      statusLabel.textContent = `[PMX rendered: ${model.mesh.morphTargetDictionary ? Object.keys(model.mesh.morphTargetDictionary).length : 0} morphs]`;
    }
    api.signalPmxFirstFrame(true);

    // 暴露 ActorRuntime + MorphControl API（Task 2：单一状态源）
    // - actorRuntime: 高层情绪/口型驱动（setEmotion/speak/...）
    // - morphControl: 面板 API，写入经过 MorphController，getRenderedWeight 用于 E2E 验证
    const actorRuntime = exposeActorRuntime(
      model,
      () => renderer.render(scene, camera),
      selectedPerformanceProfile,
      runtimeManifest
    );

    // 暴露查看器控制 API（Task 4：相机视角/缩放/纹理诊断/物理开关）
    exposeViewerControls(
      model, camera, bbox, () => renderer.render(scene, camera), canvas.height,
      modelHasPhysics,
      (enabled) => {
        physicsEnabled = enabled;
        lifeControllerRef?.setPhysicsEnabled(enabled);
        relaxedBasePoseRef?.setPhysicsEnabled(enabled);
        gazeControllerRef?.setPhysicsEnabled(enabled);
      }
    );

    // 共用配方和用户已接受的动态表情都进入同一表情池；未接受候选仍只做短时预览。
    let acceptedExpressions: readonly AcceptedExpressionRecord[] = [];
    try {
      acceptedExpressions = await api.getAcceptedExpressions();
    } catch (error) {
      console.warn('[avatar] accepted expression load failed:', error);
    }
    let expressionPresets = selectedPerformanceProfile
      ? buildSpeechExpressionPool(selectedPerformanceProfile, acceptedExpressions)
      : [];
    performanceSession.updateAcceptedExpressions(
      acceptedExpressions,
      selectedPerformanceProfile
        ? getSupportedSpeechExpressionChannels(selectedPerformanceProfile)
        : []
    );
    let currentExpression = 'neutral';
    let expressionPreviewTimer: number | null = null;
    let expressionPulseTimer: number | null = null;

    function previewSpeechExpression(expressionId: string, channel?: FacialChannel): boolean {
      const entry = expressionPresets.find(item => item.id === expressionId);
      const selectedChannel = channel
        ? entry?.channels.find(item => item.id === channel && item.supported)
        : undefined;
      if (
        !entry?.supported
        || (channel !== undefined && !selectedChannel)
        || performanceSession.getState() === 'performing'
        || actorRuntime.getState().speaking
      ) return false;
      if (expressionPreviewTimer !== null) window.clearTimeout(expressionPreviewTimer);
      if (expressionPulseTimer !== null) window.clearTimeout(expressionPulseTimer);
      currentExpression = channel ? `${expressionId}:${channel}` : expressionId;
      if (channel) {
        const acceptedRecord = acceptedExpressions.find(item => item.id === expressionId);
        if (acceptedRecord) {
          actorRuntime.previewCandidateExpression({
            durationSeconds: acceptedRecord.durationSeconds,
            channelCurves: { [channel]: acceptedRecord.channelCurves[channel] ?? [] }
          });
        } else {
          actorRuntime.previewExpressionChannel(expressionId, channel);
        }
        if (channel === 'eyeLidClose') {
          // The PMX blink morph is an event, not a sustainable emotion pose.
          // Holding it for the full preview reads as tired or helpless.
          expressionPulseTimer = window.setTimeout(() => {
            expressionPulseTimer = null;
            actorRuntime.clearExpressionPreview();
          }, 180);
        }
      } else {
        const acceptedRecord = acceptedExpressions.find(item => item.id === expressionId);
        if (acceptedRecord) {
          actorRuntime.previewCandidateExpression(acceptedRecord);
        } else {
          actorRuntime.previewExpression(expressionId);
        }
      }
      // Preview the complete facial idea, not only static morph weights.
      // Eye direction and pupil size are restored when the preview expires.
      gazeControllerRef?.setSemanticTarget(expressionId);
      pupilControllerRef?.startSpeaking(expressionId);
      expressionPreviewTimer = window.setTimeout(() => {
        expressionPreviewTimer = null;
        if (expressionPulseTimer !== null) {
          window.clearTimeout(expressionPulseTimer);
          expressionPulseTimer = null;
        }
        currentExpression = 'neutral';
        actorRuntime.clearExpressionPreview();
        gazeControllerRef?.stopSpeaking();
        pupilControllerRef?.stopSpeaking();
      }, 2200);
      console.log('[avatar] speech expression preview:', entry.name, selectedChannel?.name ?? 'all');
      return true;
    }

    // 暴露打光和表情 API 到 runtime
    getRuntime().applyLightingPreset = applyLightingPreset;
    getRuntime().previewSpeechExpression = previewSpeechExpression;
    getRuntime().applyIdleExpression = (expressionId) => { previewSpeechExpression(expressionId); };
    getRuntime().getLightingPresets = () => Object.keys(lightingPresets).map(k => ({ id: k, name: lightingPresets[k].name }));
    getRuntime().getExpressionPresets = () => expressionPresets;
    getRuntime().getCurrentLightingPreset = () => currentLightingPreset;
    getRuntime().getCurrentExpression = () => currentExpression;
    void loadLightingFromManifest().then(() => {
      applyLightingPreset(currentLightingPreset);
      applyLightingDynamic(currentLightingDynamic);
    });
    getRuntime().__debugSpeechExpression = () => {
      const cue = performanceSession.getCurrentPerformanceCue();
      const sample = performanceSession.getCurrentExpression();
      return {
        performanceState: performanceSession.getState(),
        currentTime: performanceSession.getCurrentTime(),
        cue: cue ? {
          index: cue.index,
          text: cue.text,
          emotion: cue.emotion,
          intent: cue.intent,
          facialEmotion: cue.facialEmotion,
          startSeconds: cue.startSeconds,
          endSeconds: cue.endSeconds
        } : null,
        expression: sample,
        automaticExpression: sample.automaticExpression ?? null,
        poolEntry: expressionPresets.find(entry =>
          entry.id === (sample.automaticExpression?.id ?? sample.emotion)
        ) ?? null,
        activeMorphs: actorRuntime.getMorphController().getActiveMorphs()
      };
    };

    // 鼠标滚轮缩放 + 拖拽平移
    // Electron 的 forward:true 只转发 mousemove，不会按模型像素自动恢复
    // mousedown。mousemove 必须根据真实射线命中同步切换窗口物理穿透；
    // 该瞬时状态不得改变 Composer 显示的手动模型穿透开关。
    const viewerCtrl = getRuntime().cameraControl as ViewerControls | undefined;
    const dragRootMotion = new ModelRootDragController(model.root.position);
    const isDynamicPhysicsBone = (bone: THREE.Bone): boolean => {
      const data = bone.userData as { mmdBoneName?: string; mmdEnglishBoneName?: string };
      return pmxPhysicsAudit.dynamicBoneNames.has(bone.name)
        || (typeof data.mmdBoneName === 'string' && pmxPhysicsAudit.dynamicBoneNames.has(data.mmdBoneName))
        || (typeof data.mmdEnglishBoneName === 'string'
          && pmxPhysicsAudit.dynamicBoneNames.has(data.mmdEnglishBoneName));
    };
    const dragAttachmentBones = selectRootDragAttachmentBones(
      model.mesh.skeleton?.bones ?? [],
      isDynamicPhysicsBone
    );
    // Only guard the first dynamic body of each secondary chain during a root
    // drag.  Guarding every hair descendant here makes the final-pose clamp
    // overwrite Bullet's independently simulated strand and leaves all hair
    // looking rigid.  Descendants must remain fully physics-owned so their
    // authored lag/follow-through is visible again.
    const guardedDragBones = dragAttachmentBones;
    getRuntime().__debugRootDragAttachmentBoneNames = () => dragAttachmentBones.map(bone => {
      const data = bone.userData as { mmdBoneName?: string; mmdEnglishBoneName?: string };
      return [bone.name, data.mmdBoneName, data.mmdEnglishBoneName]
        .find(name => typeof name === 'string' && pmxPhysicsAudit.dynamicBoneNames.has(name))
        ?? bone.name;
    });
    const dragSecondaryAttachment = new RootDragSecondaryAttachmentController(
      model.root,
      guardedDragBones,
      {
        getMaxRootLocalTranslation: () => 0.04,
        getMaxRootLocalRotation: () => 0.35
      }
    );
    getRuntime().__debugRootDragAttachmentFrame = () =>
      dragSecondaryAttachment.getLastFrameDiagnostics();
    // 同名骨骼解析探针：guard 持有的 Bone 对象 vs 测试侧 findBone 线性匹配
    // （skeleton.bones 首个命中）是否落到同一对象。若模型中存在多个骨骼在
    // name / mmdBoneName / mmdEnglishBoneName 任一字段撞名，二者会解析到
    // 不同 Bone，导致 guard 保护了正确链根而测试却测量到被甩开的另一条。
    getRuntime().__debugRootDragBoneResolution = (boneNames: string[]) => {
      const skeleton = model.mesh.skeleton?.bones ?? [];
      const isNameMatch = (bone: THREE.Bone, name: string): boolean =>
        bone.name === name
        || (bone.userData as { mmdBoneName?: string }).mmdBoneName === name
        || (bone.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name;
      const result: Record<string, {
        findBoneIndex: number | null;
        guardedSkeletonIndex: number | null;
        candidateIndices: number[];
      }> = {};
      for (const name of boneNames) {
        const findBoneIdx = skeleton.findIndex(b => isNameMatch(b, name));
        const guardedBone = dragAttachmentBones.find(b => isNameMatch(b, name));
        const guardedSkeletonIndex = guardedBone
          ? skeleton.findIndex(b => b === guardedBone)
          : -1;
        const candidateIndices = skeleton
          .map((_, i) => i)
          .filter(i => isNameMatch(skeleton[i], name));
        result[name] = {
          findBoneIndex: findBoneIdx,
          guardedSkeletonIndex: guardedSkeletonIndex >= 0 ? guardedSkeletonIndex : null,
          candidateIndices
        };
      }
      return result;
    };
    // 拖拽后的恢复性物理重置：快速拖动仍可能让多段裙摆链在 Bullet 里
    // 交叉折叠成 Z 形并卡住（每个关节角度局部合法，解算无法自愈）。
    // settle 尾巴（2 秒）期间链段自然回摆；尾巴结束后按当前动画姿态重建
    // Bullet 世界——静止时无感，卡住时清除折叠。语音中跳过，避免打断
    // 发丝/服饰的连续动量。
    let pendingDragKinkRecovery = false;
    let dragSessionMovedModel = false;
    // 拖拽 settle 尾巴期间累积守卫诊断，用于判定是否真的发生了裙摆折叠
    // （Z 形卡住）。折叠时物理持续把链推越界：clamped 骨骼比例高、postClamp
    // 钉在守卫包络边缘。正常回摆时链条会自然回落，clamped 很快归零。
    // 仅当累积折叠强度超过阈值才触发 hardReset，避免不必要的重置在释放后
    // 重新建立 Bullet 世界（那会清零长发动量，把长发甩动峰值推迟到 >1s）。
    let kinkSampleFrames = 0;
    let kinkFoldedBoneSamples = 0;
    let kinkSampleBoneCount = 0;
    if (viewerCtrl) {
      let isDraggingModel = false;
      let dragStartMouseX = 0;
      let dragStartMouseY = 0;
      const dragStartModelPos = new THREE.Vector3();
      let isCurrentlyOnModel = false;           // 鼠标是否命中模型（仅用于cursor）
      let manualModelPassThrough = false;       // 用户手动模型穿透（仅右键菜单/按钮可改）
      const raycaster = new THREE.Raycaster();
      const ndcVec = new THREE.Vector2();

      const mousePolicy = new AvatarMousePolicyController((effectiveIgnoreMouse) => {
        void api.applyAvatarMousePolicy?.(effectiveIgnoreMouse).catch(() => {});
      });

      function setManualPassThrough(manual: boolean): void {
        if (manualModelPassThrough === manual) return;
        manualModelPassThrough = manual;
        mousePolicy.setManualModelPassThrough(manual);
        if (manual) {
          isCurrentlyOnModel = false;
          canvas!.style.cursor = 'default';
        } else {
          canvas!.style.cursor = 'default';
        }
        void api.notifyModelPassThroughChanged?.({ manual }).catch(() => {});
      }

      const bodyMeshes = (model.mesh.userData as { mmdMorphSplitBodyMeshes?: THREE.SkinnedMesh[] }).mmdMorphSplitBodyMeshes;
      const interactiveMeshes: THREE.Object3D[] =
        Array.isArray(bodyMeshes) && bodyMeshes.length > 0
          ? bodyMeshes
          : [model.root];

      // chatX2 性能补丁：主进程 32ms 光标探测（executeJavaScript 轮询）与
      // mousemove 命中测试都会走 isPointOnModel 的全蒙皮网格 raycast
      // （~13ms/次），鼠标在桌宠窗口内时主线程 40% 耗在 raycast，帧率
      // 从 ~54fps 掉到 ~15fps。这里加两层快速路径，命中语义保持不变：
      //   1) 同坐标 TTL 缓存：鼠标静止时 96ms 内直接复用上次结果。
      //   2) 骨骼包络球预过滤：射线未命中“骨骼世界位置包络 ⊕ 蒙皮最大
      //      偏移”的保守球时直接判 false。蒙皮顶点（含混合权重顶点，
      //      由凸组合保界）不会超出该包络，因此无假阴性；命中球时仍走
      //      原精确 raycast。
      const hitTestCache = { x: -1, y: -1, at: 0, hit: false };
      const HIT_TEST_CACHE_TTL_MS = 96;
      const hitEnvelope = new THREE.Sphere();
      const hitEnvelopeBox = new THREE.Box3();
      const hitEnvelopeVec = new THREE.Vector3();
      let maxSkinOffset = -1; // <0 表示未计算（退化为不预过滤）

      function computeMaxSkinOffsetOnce(): void {
        const skeleton = model.mesh.skeleton;
        if (!skeleton || !Array.isArray(skeleton.bones) || skeleton.bones.length === 0) return;
        try {
          const invMeshWorld = model.mesh.matrixWorld.clone().invert();
          const boneLocalPos = skeleton.bones.map(bone =>
            bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(invMeshWorld)
          );
          let maxOffset = 0;
          let sampled = false;
          for (const object of interactiveMeshes) {
            const skinned = object as THREE.SkinnedMesh;
            const geometry = skinned?.geometry;
            const pos = geometry?.getAttribute?.('position');
            const skinIndex = geometry?.getAttribute?.('skinIndex');
            const skinWeight = geometry?.getAttribute?.('skinWeight');
            if (!pos || !skinIndex || !skinWeight) continue;
            sampled = true;
            for (let i = 0; i < pos.count; i += 1) {
              let bestBone = -1;
              let bestWeight = -1;
              for (let k = 0; k < 4; k += 1) {
                const w = skinWeight.getComponent(i, k);
                if (w > bestWeight) { bestWeight = w; bestBone = skinIndex.getComponent(i, k); }
              }
              if (bestBone < 0 || bestBone >= boneLocalPos.length) continue;
              const b = boneLocalPos[bestBone];
              const dx = pos.getX(i) - b.x;
              const dy = pos.getY(i) - b.y;
              const dz = pos.getZ(i) - b.z;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (dist > maxOffset) maxOffset = dist;
            }
          }
          if (!sampled) return;
          // 1.5 倍安全系数覆盖混合权重顶点（凸组合不超出各骨骼偏移的最大值，
          // 但顶点到“主骨骼”的距离可略超其自身偏移），再加少量余量。
          const worldScale = model.mesh.getWorldScale(new THREE.Vector3());
          const scale = Math.max(worldScale.x, worldScale.y, worldScale.z, 1e-6);
          maxSkinOffset = maxOffset * 1.5 * scale + 0.02;
        } catch {
          maxSkinOffset = -1;
        }
      }
      computeMaxSkinOffsetOnce();

      function updateHitEnvelope(): boolean {
        const bones = model.mesh.skeleton?.bones;
        if (maxSkinOffset < 0 || !bones || bones.length === 0) return false;
        hitEnvelopeBox.makeEmpty();
        for (const bone of bones) {
          const e = bone.matrixWorld.elements;
          hitEnvelopeVec.set(e[12], e[13], e[14]);
          hitEnvelopeBox.expandByPoint(hitEnvelopeVec);
        }
        if (hitEnvelopeBox.isEmpty()) return false;
        hitEnvelopeBox.getBoundingSphere(hitEnvelope);
        hitEnvelope.radius += maxSkinOffset;
        return true;
      }

      function isPointOnModel(clientX: number, clientY: number): boolean {
        const now = performance.now();
        if (
          clientX === hitTestCache.x &&
          clientY === hitTestCache.y &&
          now - hitTestCache.at < HIT_TEST_CACHE_TTL_MS
        ) {
          return hitTestCache.hit;
        }
        const rect = canvas!.getBoundingClientRect();
        ndcVec.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndcVec.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndcVec, camera);
        let result = false;
        // 骨骼包络球预过滤：射线未命中保守包络时必然未命中模型。
        if (!updateHitEnvelope() || raycaster.ray.intersectsSphere(hitEnvelope)) {
          // Imported PMX files may wrap their SkinnedMesh in one or more group
          // nodes.  Recursive raycasting keeps click-through and root dragging
          // consistent with the established model packs.
          const hits = raycaster.intersectObjects(interactiveMeshes, true);
          result = hits.some((hit) => {
            const mesh = hit.object as THREE.Mesh;
            if (!mesh.visible) return false;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            return materials.some((mat) => mat && mat.visible !== false && (mat.opacity ?? 1) > 0.001);
          });
        }
        hitTestCache.x = clientX;
        hitTestCache.y = clientY;
        hitTestCache.at = now;
        hitTestCache.hit = result;
        return result;
      }

      // Read-only diagnostics used by the real-PMX click-through regression.
      // They expose computed state only and never mutate the model or policy.
      getRuntime().__testIsPointOnModel = (x: number, y: number): boolean => isPointOnModel(x, y);
      getRuntime().__testGetAvatarMousePolicy = () => mousePolicy.getState();

      // 保存最后一次鼠标位置，供 mouseup 后重算 cursor
      let lastMouseX = -1;
      let lastMouseY = -1;

      const applyDragPosition = (clientX: number, clientY: number): void => {
        const dx = clientX - dragStartMouseX;
        const dy = clientY - dragStartMouseY;
        const wpp = viewerCtrl.getWorldPerPixel();
        dragRootMotion.setTarget(
          dragStartModelPos.x + dx * wpp,
          dragStartModelPos.y - dy * wpp,
          dragStartModelPos.z
        );
      };

      document.addEventListener('mousemove', (e) => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (isDraggingModel) {
          // Update the pointer target immediately. The frame loop advances the
          // actual root continuously so Bullet sees the same smooth trajectory.
          dragSessionMovedModel = true;
          applyDragPosition(e.clientX, e.clientY);
          return;
        }
        if (manualModelPassThrough) return;
        const onModel = isPointOnModel(e.clientX, e.clientY);
        mousePolicy.setPointerOnModel(onModel);
        if (onModel && !isCurrentlyOnModel) {
          isCurrentlyOnModel = true;
          canvas.style.cursor = 'grab';
        } else if (!onModel && isCurrentlyOnModel) {
          isCurrentlyOnModel = false;
          canvas.style.cursor = 'default';
        }
      });

      canvas.addEventListener('mousedown', (e) => {
        if (manualModelPassThrough) return;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if ((e.button === 0 || e.button === 1) && isPointOnModel(e.clientX, e.clientY)) {
          // 只有先前转发的 mousemove 命中模型并显式取消物理穿透后，
          // mousedown 才能到达这里；forward 模式本身不会做像素命中。
          isDraggingModel = true;
          dragSecondaryAttachment.begin();
          isCurrentlyOnModel = true;
          mousePolicy.setPointerOnModel(true);
          mousePolicy.setDraggingModel(true);
          api.setAvatarDragging?.(true);
          dragStartMouseX = e.clientX;
          dragStartMouseY = e.clientY;
          dragStartModelPos.copy(model.root.position);
          dragRootMotion.setTarget(
            dragStartModelPos.x,
            dragStartModelPos.y,
            dragStartModelPos.z
          );
          canvas.style.cursor = 'grabbing';
          e.preventDefault();
          e.stopPropagation();
        }
      });

      document.addEventListener('mouseup', (_e) => {
        if (isDraggingModel) {
          // Apply the final mouse position before calculating the post-drag hit.
          if (lastMouseX >= 0 && lastMouseY >= 0) {
            applyDragPosition(lastMouseX, lastMouseY);
          }
          isDraggingModel = false;
          dragSecondaryAttachment.end();
          if (dragSessionMovedModel) {
            pendingDragKinkRecovery = true;
            dragSessionMovedModel = false;
          }
          if (lastMouseX >= 0 && lastMouseY >= 0) {
            isCurrentlyOnModel = isPointOnModel(lastMouseX, lastMouseY);
          }
          mousePolicy.setPointerOnModel(isCurrentlyOnModel);
          mousePolicy.setDraggingModel(false);
          api.setAvatarDragging?.(false);
          if (isCurrentlyOnModel) {
            canvas.style.cursor = 'grab';
          } else {
            canvas.style.cursor = 'default';
          }
          updateGazeToScreenCenter();
        }
      });

      let isAlwaysOnTop = true;
      function showContextMenu(): void {
        const ctrl = viewerCtrl!; // narrowed by outer if block

        // 原生菜单：把「id → 动作」暂存，主进程 native Menu.popup() 点击后回传 id，
        // 由持久订阅 onAvatarContextMenuSelected 统一分发。原生菜单由 OS 渲染，
        // 保证在透明 + 鼠标穿透的桌宠窗口上一定可见、且必然显示全部内容。
        const actions = new Map<string, () => void>();
        const define = (
          id: string,
          label: string,
          action: () => void,
          opts?: { disabled?: boolean }
        ): AvatarContextMenuItem => {
          actions.set(id, action);
          return { id, label, type: 'normal', disabled: opts?.disabled };
        };
        const checkbox = (id: string, label: string, checked: boolean, action: () => void): AvatarContextMenuItem => {
          actions.set(id, action);
          return { id, label, type: 'checkbox', checked };
        };
        const separator = (id: string): AvatarContextMenuItem => ({ id, type: 'separator' });
        const submenu = (id: string, label: string, children: AvatarContextMenuItem[]): AvatarContextMenuItem =>
          ({ id, label, type: 'submenu', submenu: children });

        const idleSlotNodes = buildIdleQuickSlots(enabledIdleVmdPool).map((slot, i) => define(
          `idle:${i}`,
          `★ 播放待机动作 ${slot.slot}`,
          () => {
            if (!slot.path) return;
            stopIdleRotation();
            lastIdlePackId = slot.path;
            // 手动右键播放必须独立于“自动待机”开关。暂停只代表不自动
            // 轮换，不能阻止用户明确点选的待机动作；仍沿用待机池原有
            // 的根位移过滤、骨骼兼容和播放结束回收流程。
            void playOneShotPoolIdle(slot.path, true).catch(error => {
              console.warn('[avatar] context idle preview failed:', slot.path, error);
            });
          },
          { disabled: !slot.path || Boolean((window as any).__avatarSpeaking) || poseLockedState }
        ));

        const menuItems: AvatarContextMenuItem[] = [
          define('reset-camera', '重置视角', () => { ctrl.resetCamera(); }),
          define('angle-front', '半身视角', () => { ctrl.setAngle('front'); }),
          define('angle-full', '全身视角', () => { ctrl.setAngle('full'); }),
          separator('sep-1'),
          define('always-top', isAlwaysOnTop ? '取消置顶' : '置于最上层', () => {
            isAlwaysOnTop = !isAlwaysOnTop;
            void api.toggleAlwaysOnTop(isAlwaysOnTop);
          }),
          define('pass-through', manualModelPassThrough ? '取消穿透' : '鼠标穿透', () => {
            void api.setModelPassThrough?.(!manualModelPassThrough).catch(() => {});
          }),
          define('pose-lock',
            (window as any).__avatarSpeaking ? '语音中不可切换锁定'
              : poseLockedState ? '解锁当前姿势' : '锁定当前姿势',
            () => { void api.setPoseLock(!poseLockedState).catch(() => {}); },
            { disabled: Boolean((window as any).__avatarSpeaking) }),
          separator('sep-2'),
          ...idleSlotNodes,
          separator('sep-3'),
          submenu('default-expression', `默认表情：${selectedExpressionLabel(defaultIdleExpression)}`,
            DEFAULT_EXPRESSION_OPTIONS.map(opt =>
              checkbox(`default-expression:${opt.key}`, opt.label, opt.key === defaultIdleExpression, () => {
                applyDefaultExpression(opt.key);
                void api.setDefaultExpression(opt.key).catch(e => console.warn('[avatar] setDefaultExpression failed:', e));
              })
            )
          ),
          define('zoom-in', '放大模型', () => {
            const zoomCtrl = getRuntime().cameraControl as ViewerControls | undefined;
            if (zoomCtrl) zoomCtrl.setScale(zoomCtrl.getScale() + 0.1);
          }),
          define('zoom-out', '缩小模型', () => {
            const zoomCtrl = getRuntime().cameraControl as ViewerControls | undefined;
            if (zoomCtrl) zoomCtrl.setScale(zoomCtrl.getScale() - 0.1);
          }),
          separator('sep-4'),
          define('exit-desktop', '退出桌宠', () => { void api.exitDesktop(); }),
        ];

        pendingContextMenuActions = actions;
        api.openAvatarContextMenu(menuItems);
      }

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        viewerCtrl.handleWheel(e.deltaY);
      }, { passive: false });

      // 右键菜单——在 canvas 上触发（关闭穿透时可用）；原生菜单在主进程弹出。
      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu();
      });

      // 启动时鼠标尚未命中模型，因此先进入 forward 模式；收到转发的
      // mousemove 后，命中模型会同步取消物理穿透，使下一次点击可拖拽。
      canvas!.style.cursor = 'default';
      requestAnimationFrame(() => {
        mousePolicy.sync();
        if (canvas) canvas.style.cursor = 'default';
      });

      // 订阅 Composer 转发的手动模型穿透请求（规格 1.6.4：Avatar renderer 是唯一事实源）
      // 收到后更新 manualModelPassThrough、广播变化、重算窗口物理穿透。
      api.onSetModelPassThrough?.((manual: boolean) => {
        setManualPassThrough(manual);
      });

      // The native cursor probe is the authority while this transparent window
      // ignores mouse input.  Apply its hover result immediately so Windows
      // does not need a second mousemove before showing the grab cursor.
      api.onNativeAvatarHover?.((onModel: boolean) => {
        if (manualModelPassThrough || isDraggingModel) return;
        isCurrentlyOnModel = onModel;
        mousePolicy.setPointerOnModel(onModel);
        canvas!.style.cursor = onModel ? 'grab' : 'default';
      });
    }

    // Phase 5.2B：创建骨骼/morph 所有权注册表 + MotionPlayer 实例
    // - BoneOwnershipRegistry：VMD claim 骨骼后，ProceduralLifeController 通过 canApplyProcedural 跳过写入
    // - MorphOwnershipRegistry：VMD 含 まばたき 轨道时 claim，procedural 让出眨眼
    // - MotionPlayer：封装 VMD 加载 → setAnimation → 每帧 update → stop/clear 的完整生命周期
    //
    // Phase 5.2 修正（2026-07-19）：
    // - MotionPlayer 注入 PerformanceClock（speaking motion 时间源）和 AudioContext 状态提供者
    // - idle 使用 local-clock（performance.now() / 1000）
    // - speaking 使用 performance-clock（PerformanceClock.now()），AudioContext 必须 running + clock 必须 aligned
    // - 真实 fade：进入/退出 ≥0.5s，动作切换不先 reset 到 Base Pose
    // - Cooldown：同一 idle accent 至少 30 秒不重复
    const boneOwnershipRegistry = new BoneOwnershipRegistry();
    const morphOwnershipRegistry = new MorphOwnershipRegistry();

    // Phase 5.2B.3 Closeout Task 3：先创建 RelaxedBasePoseController，
    // 因为 MotionPlayer constructor 需要 getBasePose provider。
    // 必须在 MotionPlayer 之前。
    const armBones = findArmBones(model.mesh);
    const relaxedBasePoseController = new RelaxedBasePoseController(
      armBones,
      { boneOwnership: boneOwnershipRegistry, physicsEnabled }
    );
    getRuntime().relaxedBasePose = relaxedBasePoseController;
    relaxedBasePoseRef = relaxedBasePoseController;

    const motionPlayer = new MotionPlayer(
      model,
      boneOwnershipRegistry,
      morphOwnershipRegistry,
      {
        // speaking motion 时间源：PerformanceClock 由 AvatarPerformanceSession 持有
        performanceClock: performanceSession.getClock(),
        // speaking motion 启动校验：AudioContext 必须 running
        getAudioContextState: () => {
          if (currentPlaybackMute && performanceSession.getState() === 'performing') {
            return 'running' as const;
          }
          if (!audioCtx || audioCtx.state === 'closed') return 'unknown' as const;
          return audioCtx.state as 'running' | 'suspended' | 'closed';
        },
        // Phase 5.2B.3 Closeout Task 3：additive-from-base 模式的 base pose provider。
        // 由 RelaxedBasePoseController.getBasePoseSnapshot() 实现。
        // 返回某个骨骼的 (quaternion, position) 副本，或 undefined（未管理该骨骼）。
        getBasePose: (boneName: string) => relaxedBasePoseController.getBasePoseSnapshot(boneName)
      }
    );
    getRuntime().boneOwnershipRegistry = boneOwnershipRegistry;
    getRuntime().morphOwnershipRegistry = morphOwnershipRegistry;
    getRuntime().motionPlayer = motionPlayer;
    getRuntime().__debugHeadOverlay = () => {
      const neckDelta = headOverlayController.deltaFor('首');
      const headDelta = headOverlayController.deltaFor('頭');
      return {
        activeId: headOverlayController.getActiveId(),
        weight: headOverlayController.getWeight(),
        currentBodyPackId: motionPlayer.getCurrentPackId(),
        neckDelta: neckDelta.toArray(),
        headDelta: headDelta.toArray(),
        neckAngle: 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(neckDelta.w), 0, 1)),
        headAngle: 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(headDelta.w), 0, 1))
      };
    };
    getRuntime().__debugVmdParseCacheStats = () => getVmdParseCacheStats();
    const applyPoseLockState = (locked: boolean): void => {
      const acceptedState = motionArbiter.setPoseLocked(locked);
      if (acceptedState !== locked) {
        void api.setPoseLock(acceptedState).catch(() => {});
        return;
      }
      poseLockedState = acceptedState;
      motionPlayer.setPoseLocked(acceptedState);
      if (acceptedState) {
        stopIdleRotationRef?.();
      } else if (isDesktopModeRef && motionArbiter.getMode() === 'idle') {
        scheduleIdleRotationRef?.();
      }
      console.log('[avatar] pose locked:', acceptedState);
    };
    const unsubscribePoseLockChanged = api.onPoseLockChanged(payload => {
      applyPoseLockState(payload.locked);
    });
    void api.getPoseLock()
      .then(payload => applyPoseLockState(payload.locked))
      .catch(error => console.warn('[avatar] getPoseLock failed:', error));

    // 全局默认表情：主进程权威，启动时读取并订阅变更（跨模型统一）。
    const unsubscribeDefaultExpressionChanged = api.onDefaultExpressionChanged(expression => {
      applyDefaultExpression(expression);
    });
    void api.getDefaultExpression()
      .then(payload => applyDefaultExpression(payload.expression))
      .catch(error => console.warn('[avatar] getDefaultExpression failed:', error));

    // 原生右键菜单：主进程点击后回传 item id，执行对应动作（动作在 openContextMenu 时暂存）。
    const unsubscribeAvatarContextMenuSelected = api.onAvatarContextMenuSelected((id) => {
      const action = pendingContextMenuActions?.get(id);
      pendingContextMenuActions = null;
      if (action) action();
    });

    api.onTransitionSpeedChanged((multiplier) => motionPlayer.setTransitionSpeed(multiplier));
    void api.getTransitionSpeed()
      .then(({ value }) => motionPlayer.setTransitionSpeed(value))
      .catch(error => console.warn('[avatar] transition speed unavailable:', error));

    // 物理引擎启用时：VMD 剥离动态骨骼轨道，避免动画和物理同时抢头发骨骼
    if (physicsEnabled && pmxPhysicsAudit.dynamicBoneNames.size > 0) {
      const dynamicBoneFilter = new Set(pmxPhysicsAudit.dynamicBoneNames);
      // Bones disabled by the model-specific physics guard remain available to
      // authored VMD tracks; they must not be blocked by the generic dynamic
      // filter after Bullet has relinquished ownership.
      for (const boneName of disabledDynamicBones) dynamicBoneFilter.delete(boneName);
      motionPlayer.setDynamicBoneFilter(dynamicBoneFilter);
      console.log(`[avatar] stripped ${dynamicBoneFilter.size} dynamic bones from VMD`);
    }

    // Phase 5.2B 扩展：创建链式多段 VMD 播放器（MotionSequence）
    const motionSequence = new MotionSequence(motionPlayer);
    getRuntime().motionSequence = motionSequence;

    // Phase 5.2 诊断（2026-07-19）：追踪 idle 启动状态，用于排查 flaky E2E。
    // 记录 startDefaultIdlePack 调用次数、成功/失败、最后一次错误、motionPlayer 状态。
    const idleStartDebug = {
      motionPlayerCreated: true,
      startCalledCount: 0,
      startSucceededCount: 0,
      startFailedCount: 0,
      lastError: '' as string,
      lastAttemptAt: 0,
      modeChangeHandled: false,
      initialModeCheckRan: false,
      initialMode: '' as string,
      isStartingIdle: false,
      motionPlayerState: 'idle' as string,
      motionPlayerPackId: '' as string | null,
      motionPlayerIsPlaying: false
    };
    (window as any).__idleStartDebug = idleStartDebug;

    // Phase 5.2B：暴露骨骼状态读取 API 供 E2E 真实 PMX 动作验收
    // __getBoneState(name) 返回 { quaternion, position } 或 null（骨骼未找到）
    // __getBoneStates(names) 批量返回，避免多次 IPC 往返
    // 直接从 SkinnedMesh.skeleton.bones 读取，证明 VMD 真的被采样并写入骨骼变换
    //
    // 骨骼查找顺序与 @yohawing/three-mmd-loader 的 findBoneTrack 一致：
    //   userData.mmdBoneName → userData.mmdEnglishBoneName → bone.name
    // 这样 VMD 中的日文骨骼名（如 '左肩'）能匹配模型的英文名（如 'LeftShoulder'），
    // 前提是 PMX 加载器在 bone.userData 上设置了 mmdBoneName。
    const skeletonBones = model.mesh.skeleton?.bones ?? [];
    getRuntime().__debugDynamicBoneNames = () => [...pmxPhysicsAudit.dynamicBoneNames];
    const findBone = (name: string): THREE.Bone | undefined =>
      skeletonBones.find(b =>
        b.name === name ||
        (b.userData as { mmdBoneName?: string }).mmdBoneName === name ||
        (b.userData as { mmdEnglishBoneName?: string }).mmdEnglishBoneName === name
      ) as THREE.Bone | undefined;
    getRuntime().__getBoneState = (boneName: string) => {
      const bone = findBone(boneName);
      if (!bone) return null;
      const q = bone.quaternion;
      const p = bone.position;
      return {
        quaternion: [q.x, q.y, q.z, q.w],
        position: [p.x, p.y, p.z]
      };
    };
    getRuntime().__getBoneStates = (boneNames: string[]) => {
      const result: Record<string, { quaternion: [number, number, number, number]; position: [number, number, number] } | null> = {};
      for (const name of boneNames) {
        const bone = findBone(name);
        if (!bone) {
          result[name] = null;
        } else {
          const q = bone.quaternion;
          const p = bone.position;
          result[name] = {
            quaternion: [q.x, q.y, q.z, q.w],
            position: [p.x, p.y, p.z]
          };
        }
      }
      return result;
    };
    /**
     * Phase 5.2 修正（2026-07-19）：批量返回多个骨骼的 WORLD position。
     * 用户要求：E2E 必须直接采样左右脚踝/足IK 世界坐标检查脚滑。
     * 使用 THREE.Object3D.getWorldPosition 读取世界坐标（包含父级变换）。
     * 必须在 model.update() 之后调用，确保世界坐标已更新。
     */
    getRuntime().__getBoneWorldPositions = (boneNames: string[]): Record<string, [number, number, number] | null> => {
      const result: Record<string, [number, number, number] | null> = {};
      const target = new THREE.Vector3();
      for (const name of boneNames) {
        const bone = findBone(name);
        if (!bone) {
          result[name] = null;
        } else {
          bone.getWorldPosition(target);
          result[name] = [target.x, target.y, target.z];
        }
      }
      return result;
    };
    getRuntime().__getBoneRootLocalPositions = (boneNames: string[]): Record<string, [number, number, number] | null> => {
      const result: Record<string, [number, number, number] | null> = {};
      const target = new THREE.Vector3();
      const inverseRootWorld = new THREE.Matrix4();
      model.root.updateWorldMatrix(true, true);
      inverseRootWorld.copy(model.root.matrixWorld).invert();
      for (const name of boneNames) {
        const bone = findBone(name);
        if (!bone) {
          result[name] = null;
        } else {
          bone.getWorldPosition(target).applyMatrix4(inverseRootWorld);
          result[name] = [target.x, target.y, target.z];
        }
      }
      return result;
    };
    getRuntime().__debugUserFacing = () => {
      const gaze = gazeControllerRef?.getFocusTarget() ?? { yaw: 0, pitch: 0 };
      return {
        currentYaw: userFacingController.getCurrentYaw(),
        targetYaw: userFacingController.getTargetYaw(),
        gazeYaw: gaze.yaw,
        gazePitch: gaze.pitch
      };
    };

    // Phase 5.2B debug：暴露 MotionPlayer + runtime frame state 供 E2E 调试
    getRuntime().__debugMotionPlayerState = () => {
      const mp = motionPlayer;
      const upperBody = findBone('上半身');
      const frameState = (model as any).runtime?.frameState?.() ?? null;
      return {
        state: (mp as any).state ?? 'unknown',
        currentPackId: mp.getCurrentPackId(),
        isPlaying: mp.isPlaying(),
        animationDurationSec: mp.getAnimationDuration(),
        currentAnimationTime: mp.getCurrentAnimationTime(),
        currentModelUpdateTime: mp.getCurrentModelUpdateTime(),
        playbackRate: mp.getPlaybackRate(),
        animationStartedAt: (mp as any).animationStartedAt ?? 0,
        nowSeconds: performance.now() / 1000,
        currentBoneNames: mp.getCurrentBoneNames(),
        currentMorphNames: mp.getCurrentMorphNames(),
        hasBlinkTrack: mp.hasBlinkTrack(),
        runtimeFrame: frameState?.frame ?? null,
        runtimeSeconds: frameState?.seconds ?? null,
        runtimeFrameRate: frameState?.frameRate ?? null,
        upperBodyOwner: boneOwnershipRegistry.getOwner('上半身'),
        upperBodyQuaternion: upperBody
          ? [upperBody.quaternion.x, upperBody.quaternion.y, upperBody.quaternion.z, upperBody.quaternion.w]
          : null,
        skeletonBoneCount: skeletonBones.length,
        skeletonBoneNames: skeletonBones.slice(0, 50).map(b => b.name).filter(n => n.length > 0),
        runtimeType: (model as any).runtime?.constructor?.name ?? 'unknown',
        parsedPreparedIkChainCount: (model as any).runtime?.parsedTrackRuntime?.preparedIkChains?.length ?? 0,
        parsedDisabledIkBoneNames: [...((model as any).runtime?.parsedTrackRuntime?.disabledIkBoneNames ?? [])]
      };
    };

    // Phase 5.2B.3 Closeout Task 3：测试专用 gesture 播放钩子（仅用于 E2E）
    // 不依赖 TTS/IPC，直接调用 motionPlayer.play() 验证 additive-from-base 组合模式
    getRuntime().__testPlayGesture = async (packId: string): Promise<boolean> => {
      const manifest = getGesturePackManifest(packId);
      if (!manifest) {
        console.warn(`[avatar] __testPlayGesture: pack not found: ${packId}`);
        return false;
      }
      const bytes = getGesturePackBytes(packId);
      try {
        await motionPlayer.play(packId, bytes, {
          boneMapping: manifest.boneMapping,
          amplitudeLimits: manifest.amplitudeLimits ?? DEFAULT_AMPLITUDE_LIMITS,
          looping: false,
          // 测试不依赖 AudioContext 对齐，使用 local-clock
          timeSource: 'local-clock',
          fadeInSeconds: Math.max(0.5, manifest.fadeInSeconds ?? 0.5),
          fadeOutSeconds: Math.max(0.5, manifest.fadeOutSeconds ?? 0.5),
          // cooldown=0 便于重复测试
          cooldownSeconds: 0,
          force: true,
          // 从 manifest 读取 compositionMode（不允许测试覆盖）
          compositionMode: manifest.compositionMode ?? 'absolute'
        });
        return true;
      } catch (e) {
        console.warn(`[avatar] __testPlayGesture: play failed for ${packId}:`, e);
        return false;
      }
    };
    getRuntime().__testStopGesture = (): void => {
      try {
        motionPlayer.stopImmediate();
      } catch (e) {
        console.warn('[avatar] __testStopGesture failed:', e);
      }
    };

    // Task 6 Step 3：创建生命层（眨眼/呼吸/头肩小动作）
    // 从 mesh.skeleton.bones 找到头/上半身/左肩/右肩骨骼
    // blinkName 来自 manifest.morphs.blink（まばたき）
    // Phase 5.2B：传入 ownership registries，VMD claim 骨骼/morph 时 procedural 跳过写入
    // Phase 5.2B.3 Closeout Task 4：左肩/右肩 由 RelaxedBasePoseController 每帧重置为 base pose，
    // ProceduralLifeController 对这两块骨骼使用 multiply-on-top，保留 base pose 不被覆盖。
    // 頭/上半身 不在 RelaxedBasePoseController 管理范围，仍使用 copy(rest)+multiply 自重置。
    const lifeBones = findLifeBones(model.mesh);
    const lifeController = new ProceduralLifeController(
      lifeBones,
      {
        setWeight: (name, weight) => actorRuntime.setAuxiliaryMorphWeight('blink', name, weight)
      },
      selectedPerformanceProfile?.blinkMorph ?? buildRuntimeAvatarManifest(currentPackAtLoad).morphs.blink,
      {
        boneOwnership: boneOwnershipRegistry,
        morphOwnership: morphOwnershipRegistry,
        managedBoneNames: ['左肩', '右肩'],
        physicsEnabled
      }
    );
    lifeControllerRef = lifeController;
    const gazeController = new GazeController(findGazeBones(model.mesh), boneOwnershipRegistry);
    gazeController.setPhysicsEnabled(physicsEnabled);
    gazeControllerRef = gazeController;
    const unsubscribeGazeLock = api.onGazeLockChanged(({ locked }) => {
      gazeController.setFocusLocked(locked);
      updateGazeToScreenCenter();
    });
    void api.getGazeLock().then(({ locked }) => {
      gazeController.setFocusLocked(locked);
      updateGazeToScreenCenter();
    }).catch(e => console.warn('[avatar] getGazeLock failed:', e));
    const pupilController = new PupilController({
      getKnownMorphs: () => actorRuntime.getMorphController().getKnownMorphs(),
      setWeight: (name, weight) => actorRuntime.setAuxiliaryMorphWeight('pupil', name, weight)
    });
    pupilControllerRef = pupilController;

    // Phase 5.2B.1 Task 2：放松基础姿态控制器已在 MotionPlayer 之前创建（上方）。
    // Phase 5.2B.3 Closeout Task 3：重排顺序以提供 getBasePose provider。

    // Phase 5.2B：初始化 idle packs 的 SHA-256 哈希（异步，不阻塞 renderer 初始化）
    // 异步初始化确保 getIdlePackManifest 返回的 hash 与字节匹配（Web Crypto API）
    // 失败不阻塞渲染：hash fallback 已经在 idle-packs.ts 中处理（同步 hash）
    void initializeIdlePackHashes().catch(e => {
      console.warn('[avatar] initializeIdlePackHashes failed:', e);
    });

    // Phase 5.2 修正（2026-07-19）：初始化 gesture packs 的 SHA-256 哈希
    // 与 idle packs 一致：异步初始化，失败不阻塞渲染
    void initializeGesturePackHashes().catch(e => {
      console.warn('[avatar] initializeGesturePackHashes failed:', e);
    });

    // Phase 5.2B：默认 idle pack ID。
    // 进入 desktop 模式时自动播放，语音结束后回到此 idle，模式切换时停止。
    // 兜底为用户在动作库中设置的共享默认待机文件。
    const FALLBACK_IDLE_PACK_ID = '../shared/motions/待机 女性的.vmd';

    // 从当前模型包 manifest 读取启用的 idle/gesture pack 列表（用户可在 UI 中开关）
    await startupDefaultIdlePreloadPromise;
    try {
      const cur = currentPackAtLoad;
      if (cur.success && cur.motions) {
        enabledIdlePackIds = Array.isArray(cur.motions.idlePacks) ? [...cur.motions.idlePacks] : [];
        if (cur.motions.gesturePacks && cur.motions.gesturePacks.length > 0) {
          enabledGesturePackIds = cur.motions.gesturePacks;
        }
        currentDefaultIdle = typeof cur.motions.defaultIdle === 'string'
          ? cur.motions.defaultIdle
          : FALLBACK_IDLE_PACK_ID;
        // Phase 6: 初始化共享语音动作池。它是 Planner 的真实候选源，
        // 即使用户刚添加的路径尚未写入旧 manifest customVmd，也必须可用。
        enabledIdleVmdPool = Array.isArray((cur.motions as any).idleVmdPool)
          ? [...(cur.motions as any).idleVmdPool]
          : [];
        // Phase 6: 初始化 VMD 情绪映射表
        const vmdMap = (cur.motions as any).vmdEmotionMap;
        currentVmdEmotionMap = vmdMap && Array.isArray(vmdMap) ? vmdMap : [];
        enabledVmdPaths = mergeEnabledVmdPaths((cur.motions as any).customVmd, currentVmdEmotionMap);
        performanceSession.updateVmdEmotionMap(currentVmdEmotionMap);
        // 模型专属动作手感微调（manifest.motionTuning，缺省回落全局默认）
        currentModelMotionTuning = resolveModelMotionTuning(
          (cur.manifest as { motionTuning?: ModelPackMotionTuning } | undefined)?.motionTuning ?? null
        );
      }
    } catch (e) {
      console.warn('[avatar] failed to load current model pack motions, using defaults:', e);
    }

    // 可用 idle pack 列表（用于随机轮换，避免长时间只有一个动作显得机械）
    // 注意：enabledIdlePackIds 可能在运行时被 UI 开关更新，因此不缓存为 const。
    let lastIdlePackId: string | null = null;
    let idleRotationTimer: ReturnType<typeof setTimeout> | null = null;

    const currentIdleSources = () => ({
      enabledDefaultIds: currentDefaultIdle.trim().length > 0 ? [currentDefaultIdle] : [],
      poolIds: Array.from(new Set([
        ...(currentDefaultIdle.trim().length > 0 ? [currentDefaultIdle] : []),
        ...enabledIdleVmdPool
      ]))
    });

    const applyIdleLifecycleDecision = async (
      decision: IdleLifecycleDecision,
      transitionProfile?: TransitionBridgeProfile
    ): Promise<void> => {
      if (decision.clearTimer) stopIdleRotation();
      else if (decision.clearCallback) {
        try { motionPlayer.setOnStop(null); } catch { /* ignore */ }
      }
      if (decision.stopCurrent
        && motionArbiter.getMode() === 'idle'
        && motionPlayer.isPlaying()) motionPlayer.stop();
      if (decision.startDefaultId && motionArbiter.canRunDefaultIdle() && isDesktopModeRef) {
        await startDefaultIdlePack(true, transitionProfile);
      }
        if (decision.scheduleNext && motionArbiter.canRunIdle() && isDesktopModeRef) {
        scheduleIdleRotation();
      }
    };

    /**
     * 热更新当前模型包动作配置。
     * UI 中开关动作或设置默认 idle 后，主进程广播 chatx2:model-pack-changed，
     * Avatar 渲染器调用此函数重新读取 manifest 并应用变更。
     */
    async function refreshModelPackMotions(): Promise<void> {
      try {
        const cur = await api.getCurrentModelPack();
        if (!cur.success || !cur.motions) return;
        // 模型包变化时清空 VMD 字节缓存，避免使用旧模型的 VMD 字节
        vmdBytesCache.clear();
        enabledIdlePackIds = Array.isArray(cur.motions.idlePacks) ? [...cur.motions.idlePacks] : [];
        enabledGesturePackIds = Array.isArray(cur.motions.gesturePacks) ? [...cur.motions.gesturePacks] : [];
        currentDefaultIdle = typeof cur.motions.defaultIdle === 'string'
          ? cur.motions.defaultIdle
          : FALLBACK_IDLE_PACK_ID;

        // 更新待机轮换池（idleVmdPool）
        enabledIdleVmdPool = Array.isArray((cur.motions as any).idleVmdPool)
          ? [...(cur.motions as any).idleVmdPool]
          : [];

        // Phase 6: 更新 VMD 情绪映射表到 PerformancePlanner
        const vmdMap = (cur.motions as any).vmdEmotionMap;
        currentVmdEmotionMap = vmdMap && Array.isArray(vmdMap) ? vmdMap : [];
        enabledVmdPaths = mergeEnabledVmdPaths((cur.motions as any).customVmd, currentVmdEmotionMap);
        performanceSession.updateVmdEmotionMap(currentVmdEmotionMap);
        // 模型专属动作手感微调热更新（manifest.motionTuning）
        currentModelMotionTuning = resolveModelMotionTuning(
          (cur.manifest as { motionTuning?: ModelPackMotionTuning } | undefined)?.motionTuning ?? null
        );

        const decision = idleLifecycle.refresh(currentIdleSources());
        if (decision.stopCurrent) lastIdlePackId = null;
        console.log(`[avatar] model pack motions updated: defaultIdle=${currentDefaultIdle}, idleCount=${enabledIdlePackIds.length}, gestureCount=${enabledGesturePackIds.length}, idleVmdPool=${enabledIdleVmdPool.length}, idlePhase=${idleLifecycle.snapshot().phase}`);
        await applyIdleLifecycleDecision(decision);
      } catch (e) {
        console.warn('[avatar] refreshModelPackMotions failed:', e);
      }
    }

    /**
     * 从待机轮换池中随机选一个 VMD（排除上次播放的，避免连续重复）。
     * 池为空时返回 null。
     */
    function pickRandomPoolIdle(): string | null {
      return pickNextIdleId(
        idleLifecycle.snapshot().enabledPoolIds,
        lastIdlePackId
      );
    }

    /**
     * 播放待机池中的一次性动作（不循环，播完自动回到默认 idle）。
     * 使用 motionPlayer.setOnStop 回调在动作结束后恢复默认。
     */
    async function playOneShotPoolIdle(packId: string, manual = false): Promise<void> {
      const idleAllowed = manual
        ? motionArbiter.getMode() === 'idle' && !motionArbiter.isPoseLocked()
        : motionArbiter.canRunIdle();
      if (!idleAllowed || (window as any).__avatarSpeaking) {
        return;
      }
      const lifecycleGeneration = idleLifecycle.currentGeneration();

      let bytes: Uint8Array;
      let cached = vmdBytesCache.get(packId);
      if (!cached) {
        try {
          const buf = await api.loadCustomVmdBytes(packId);
          cached = new Uint8Array(buf);
          vmdBytesCache.set(packId, cached);
        } catch (e) {
          console.warn(`[avatar] playOneShotPoolIdle: failed to load ${packId}:`, e);
          scheduleIdleRotation();
          return;
        }
      }
      bytes = cached;

      // Loading a user VMD crosses an IPC/async boundary. Idle may have been
      // disabled, desktop mode may have closed, or speech may have started in
      // the meantime. Never let that stale request seize MotionPlayer after
      // the owner has changed.
      const stillIdleAllowed = manual
        ? motionArbiter.getMode() === 'idle' && !motionArbiter.isPoseLocked()
        : motionArbiter.canRunIdle();
      if (lifecycleGeneration !== idleLifecycle.currentGeneration()
        || !stillIdleAllowed
        || (window as any).__avatarSpeaking) return;

      try {
        console.log(`[avatar] idle pool shot: playing ${packId} (one-shot, will return to default)`);
        await motionPlayer.play(packId, bytes, {
          boneMapping: {},
          amplitudeLimits: DEFAULT_AMPLITUDE_LIMITS,
          looping: false, // 不循环，播完即停
          timeSource: 'local-clock' as const,
          fadeInSeconds: 1.0,
          fadeOutSeconds: 1.0,
          cooldownSeconds: 30,
          force: true,
          compositionMode: 'absolute' as const,
        });

        idleLifecycle.started(packId, 'pool-shot');
        const completionGeneration = idleLifecycle.currentGeneration();

        // 设置 onStop 回调：播完后先重新绑定默认待机，避免动作末帧
        // 释放后腿部落到基础姿态；默认待机启动成功后再安排下一次轮换。
        motionPlayer.setOnStop(() => {
          if (!idleLifecycle.acceptCompletion(completionGeneration, packId)) return;
          idleLifecycle.finished(packId);
          console.log(`[avatar] episodic idle finished: ${packId}; restoring default idle`);
          lastIdlePackId = packId;
          if (startDefaultIdlePackRef && isDesktopModeRef && motionArbiter.canRunDefaultIdle()) {
            void startDefaultIdlePackRef(true, 'speech-to-idle-recovery').catch(error => {
              console.warn('[avatar] episodic idle default recovery failed:', error);
              scheduleIdleRotation();
            });
          } else {
            scheduleIdleRotation();
          }
        });
      } catch (e) {
        console.warn(`[avatar] playOneShotPoolIdle failed for ${packId}:`, e);
        scheduleIdleRotation();
      }
    }

    /**
     * 启动 idle 轮换定时器：默认 idle 每 ~30 秒后插入一个待机池动作。
     *
     * 新行为（2026-07-27）：
     * - 默认 idle 循环播放（looping），作为基底
     * - 每 28-36 秒从待机池随机选一个动作播放一次（non-looping）
     * - 播完后自动回到默认 idle，再等 28-36 秒播下一个
     * - 待机池为空时仅播放默认 idle，不轮换
     */
    function scheduleIdleRotation(): void {
      if (idleRotationTimer) clearTimeout(idleRotationTimer);
      idleRotationTimer = null;
      idleLifecycle.setTimerArmed(false);

      const lifecycleSnapshot = idleLifecycle.snapshot();
      if (lifecycleSnapshot.enabledPoolIds.length === 0
        || !lifecycleSnapshot.inDesktop
        || lifecycleSnapshot.paused
        || lifecycleSnapshot.speechActive) return;

      const delay = Math.max(
        lifecycleSnapshot.cooldownRemainingMs,
        28000 + Math.floor(Math.random() * 8000)
      ); // 真实冷却 + 28-36s 自然间隔
      const lifecycleGeneration = idleLifecycle.currentGeneration();
      idleLifecycle.setTimerArmed(true);
      idleRotationTimer = setTimeout(() => {
        idleRotationTimer = null;
        idleLifecycle.setTimerArmed(false);
        if (lifecycleGeneration !== idleLifecycle.currentGeneration()) return;
        if (isDesktopModeRef
          && motionArbiter.canRunIdle()
          && !(window as any).__avatarSpeaking
          && idleLifecycle.canScheduleAt(Date.now())) {
          const nextPack = pickRandomPoolIdle();
          if (nextPack) {
            console.log(`[avatar] idle rotation: scheduling pool action ${nextPack}`);
            lastIdlePackId = nextPack;
            void playOneShotPoolIdle(nextPack).catch(() => {});
          }
        }
      }, delay);
    }

    function stopIdleRotation(): void {
      if (idleRotationTimer) {
        clearTimeout(idleRotationTimer);
        idleRotationTimer = null;
      }
      idleLifecycle.setTimerArmed(false);
      // 清除可能残留的 onStop 回调，防止切换模式后误触发
      try { motionPlayer.setOnStop(null); } catch { /* ignore */ }
    }
    stopIdleRotationRef = stopIdleRotation;
    scheduleIdleRotationRef = scheduleIdleRotation;

    /**
     * Phase 5.2B：启动默认 idle pack（如未在播放中）。
     * - 如果 motionPlayer 已在播放任何 pack，不重复启动
     * - 如果 motionPlayer 空闲，启动随机选择的 idle pack（首次用 currentDefaultIdle）
     * - 启动失败仅警告，不阻塞渲染
     * - 返回 Promise 供调用方等待（可选）
     *
     * Phase 5.2 修正（2026-07-19）：
     * - idle 使用 local-clock 时间源（performance.now() / 1000）
     * - 真实 fade：进入/退出 ≥0.5s
     * - Cooldown：30s 内不重复启动同一 idle accent
     */
    // Phase 5.2 修正（2026-07-19）：防止并发 startDefaultIdlePack 调用 + 失败重试。
    let idleStartGeneration = 0;
    let pendingIdleStarts = 0;
    let pendingDefaultIdleStartId: string | null = null;
    // VMD 字节缓存已提前到 handleAvatarPlay 之前声明
    const startDefaultIdlePack = async (
      force = false,
      transitionProfile?: TransitionBridgeProfile
    ): Promise<void> => {
      const requestGeneration = ++idleStartGeneration;
      idleStartDebug.startCalledCount++;
      idleStartDebug.lastAttemptAt = Date.now();
      if (!motionArbiter.canRunDefaultIdle()) {
        console.log(`[avatar] startDefaultIdlePack: rejected (motion owner=${motionArbiter.getMode()})`);
        return;
      }
      if (currentDefaultIdle.trim().length === 0) {
        console.log('[avatar] startDefaultIdlePack: skipped (no configured default idle)');
        return;
      }
      const packId = currentDefaultIdle;
      if (!shouldStartDefaultIdle({
        inDesktop: isDesktopModeRef,
        speechActive: motionArbiter.getMode() === 'speech',
        requestedId: packId,
        currentPackId: motionPlayer.getCurrentPackId(),
        motionPlaying: motionPlayer.isPlaying(),
        startPendingForId: pendingDefaultIdleStartId
      })) {
        if (motionPlayer.isPlaying() && motionPlayer.getCurrentPackId() === packId) {
          idleLifecycle.started(packId, 'default-loop');
          scheduleIdleRotation();
        }
        console.log(`[avatar] startDefaultIdlePack: skipped (already visible or pending ${packId})`);
        return;
      }
      pendingDefaultIdleStartId = packId;
      pendingIdleStarts++;
      idleStartDebug.isStartingIdle = true;
      try {
        // force=true 时强制使用 currentDefaultIdle（用户配置的默认待机），
        // 而非 lastIdlePackId（可能被 idle 轮换池覆盖为随机 VMD 路径）。
        // 语音没有选中动作时，背景仍然是用户当前的默认待机。
        // 此时语音结束不应把同一动作重新绑定一次，否则会生成一段看似模型默认姿势的过渡。
        if (motionPlayer.getCurrentPackId() === packId && motionPlayer.isPlaying()) {
          idleLifecycle.started(packId, 'default-loop');
          scheduleIdleRotation();
          idleStartDebug.startSucceededCount++;
          console.log(`[avatar] startDefaultIdlePack: skipped (already playing ${packId})`);
          return;
        }
        // 判断是否为 VMD 路径（以 "motions/" 开头，或以 "../" 开头且包含 "/motions/"）
        const isVmdPath = packId.startsWith('motions/') || (packId.startsWith('../') && packId.includes('/motions/'));
        let bytes: Uint8Array;
        let manifest: { boneMapping: any; amplitudeLimits: any; fadeInSeconds?: number; fadeOutSeconds?: number; cooldownSeconds?: number; compositionMode?: any };
        if (isVmdPath) {
          // 僵硬修复：优先使用缓存的 VMD 字节，避免每次 IPC 加载导致的 async 空窗
          let cached = vmdBytesCache.get(packId);
          if (!cached) {
            const buf = await api.loadCustomVmdBytes(packId);
            cached = new Uint8Array(buf);
            vmdBytesCache.set(packId, cached);
          }
          if (requestGeneration !== idleStartGeneration) {
            console.log('[avatar] startDefaultIdlePack: superseded while loading VMD');
            return;
          }
          bytes = cached;
          manifest = {
            boneMapping: {},
            amplitudeLimits: DEFAULT_AMPLITUDE_LIMITS,
            // 模型专属手感微调：待机/待机轮换 fade 由该模型 manifest.motionTuning 决定
            fadeInSeconds: currentModelMotionTuning.idleFadeInSeconds,
            fadeOutSeconds: currentModelMotionTuning.idleFadeOutSeconds,
            cooldownSeconds: 30,
            compositionMode: 'absolute'
          };
        } else {
          bytes = getIdlePackBytes(packId);
          const m = getIdlePackManifest(packId);
          if (!m) {
            console.warn(`[avatar] idle pack manifest not found: ${packId}`);
            idleStartDebug.lastError = `manifest not found: ${packId}`;
            idleStartDebug.startFailedCount++;
            return;
          }
          manifest = m;
        }
        lastIdlePackId = packId;
        const isInitialIdleBind = !motionPlayer.isPlaying() && transitionProfile === undefined;
        const playOptions = {
          boneMapping: manifest.boneMapping,
          amplitudeLimits: manifest.amplitudeLimits ?? DEFAULT_AMPLITUDE_LIMITS,
          looping: true,
          timeSource: 'local-clock' as const,
          // Cross-fade 过渡：idle 轮换时使用更长的 fade 时间（≥1.0s），避免突然回正
          fadeInSeconds: isInitialIdleBind ? 0 : Math.max(1.0, manifest.fadeInSeconds ?? 1.0),
          fadeOutSeconds: Math.max(1.0, manifest.fadeOutSeconds ?? 1.0),
          cooldownSeconds: Math.max(30, manifest.cooldownSeconds ?? 30),
          force,
          compositionMode: manifest.compositionMode ?? 'absolute',
          transitionProfile
        };
        // 重试机制：覆盖瞬时故障
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (requestGeneration !== idleStartGeneration) {
              console.log('[avatar] startDefaultIdlePack: superseded before play');
              return;
            }
            if (!motionArbiter.canRunDefaultIdle()) {
              console.log('[avatar] startDefaultIdlePack: cancelled before play (idle no longer allowed)');
              return;
            }
            if (motionPlayer.isPlaying() && !force) {
              console.log(`[avatar] startDefaultIdlePack: attempt ${attempt+1} skipped (already playing)`);
              idleStartDebug.startSucceededCount++;
              return;
            }
            console.log(`[avatar] startDefaultIdlePack: attempt ${attempt+1}/3 pack=${packId}`);
            await motionPlayer.play(packId, bytes, playOptions);
            idleLifecycle.started(packId, 'default-loop');
            scheduleIdleRotation();
            console.log(`[avatar] startDefaultIdlePack: attempt ${attempt+1} succeeded pack=${packId}`);
            idleStartDebug.startSucceededCount++;
            return;
          } catch (e) {
            lastError = e;
            idleStartDebug.lastError = (e as Error)?.message ?? String(e);
            console.warn(`[avatar] startDefaultIdlePack: attempt ${attempt+1} failed:`, e);
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
        idleStartDebug.startFailedCount++;
        console.warn(`[avatar] startDefaultIdlePack failed after 3 attempts:`, lastError);
      } catch (e) {
        idleStartDebug.startFailedCount++;
        idleStartDebug.lastError = (e as Error)?.message ?? String(e);
        console.warn(`[avatar] startDefaultIdlePack failed:`, e);
      } finally {
        if (pendingDefaultIdleStartId === packId) pendingDefaultIdleStartId = null;
        pendingIdleStarts = Math.max(0, pendingIdleStarts - 1);
        idleStartDebug.isStartingIdle = pendingIdleStarts > 0;
        // 更新 motionPlayer 状态快照
        try {
          idleStartDebug.motionPlayerState = (motionPlayer as any).state ?? 'unknown';
          idleStartDebug.motionPlayerPackId = motionPlayer.getCurrentPackId();
          idleStartDebug.motionPlayerIsPlaying = motionPlayer.isPlaying();
        } catch { /* ignore */ }
      }
    };

    // Phase 5.2B：将 startDefaultIdlePack 赋值给 stopPerformance 的闭包引用
    // 这样 stopPerformance('ended') 可以在语音自然结束后回到 idle pack
    startDefaultIdlePackRef = startDefaultIdlePack;

    // 预览动作包：模型管理面板点击「预览」时调用
    // - idle：循环播放，停止 idle 轮换，预览结束后恢复默认 idle
    // - gesture：播放一次（约 1.5-2.5 秒），不影响当前 idle
    async function playPreviewMotionPack(packId: string, type: 'idle' | 'gesture'): Promise<void> {
      const mp = getRuntime().motionPlayer;
      if (!mp) {
        console.warn('[avatar] preview: motionPlayer not available');
        return;
      }
      const decision = motionArbiter.requestPreview();
      if (!decision.accepted) {
        console.warn(`[avatar] preview pack rejected: ${decision.reason}`);
        return;
      }
      try {
        if (!motionArbiter.isCurrentPreview(decision.requestId)) return;
        if (type === 'idle') {
          const manifest = getIdlePackManifest(packId);
          if (!manifest) {
            console.warn('[avatar] preview idle: manifest not found for', packId);
            return;
          }
          const bytes = getIdlePackBytes(packId);
          lastIdlePackId = packId;
          await mp.play(packId, bytes, {
            boneMapping: manifest.boneMapping,
            amplitudeLimits: manifest.amplitudeLimits ?? DEFAULT_AMPLITUDE_LIMITS,
            looping: true,
            timeSource: 'local-clock',
            fadeInSeconds: Math.max(0.5, manifest.fadeInSeconds ?? 0.5),
            fadeOutSeconds: Math.max(0.5, manifest.fadeOutSeconds ?? 0.5),
            cooldownSeconds: 0,
            force: true,
           compositionMode: manifest.compositionMode ?? 'absolute'
          });
          console.log('[avatar] preview idle started:', packId);
        } else {
          const manifest = getGesturePackManifest(packId);
          if (!manifest) {
            console.warn('[avatar] preview gesture: manifest not found for', packId);
            return;
          }
          const bytes = getGesturePackBytes(packId);
          await mp.play(packId, bytes, {
            boneMapping: manifest.boneMapping,
            amplitudeLimits: manifest.amplitudeLimits ?? DEFAULT_AMPLITUDE_LIMITS,
            looping: false,
            timeSource: 'local-clock',
            fadeInSeconds: Math.max(0.5, manifest.fadeInSeconds ?? 0.5),
            fadeOutSeconds: Math.max(0.5, manifest.fadeOutSeconds ?? 0.5),
            cooldownSeconds: 0,
            force: true,
            compositionMode: manifest.compositionMode ?? 'absolute'
          });
          console.log('[avatar] preview gesture started:', packId);
          monitorPreviewCompletion(decision.requestId, packId);
        }
      } catch (e) {
        console.warn('[avatar] preview failed:', packId, type, e);
      }
    }

    async function waitForPreviewStart(
      previewRequestId: number,
      packId: string,
      timeoutMs = 12_000
    ): Promise<'started' | 'superseded' | 'speech-active' | 'timeout'> {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        if (motionArbiter.getMode() === 'speech') return 'speech-active';
        if (!motionArbiter.isCurrentPreview(previewRequestId)) return 'superseded';
        const mp = getRuntime().motionPlayer;
        if (mp?.getCurrentPackId() === packId && mp.isPlaying()) return 'started';
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      return 'timeout';
    }

    function restoreDefaultAfterPreview(): void {
      if (performanceSession.getState() === 'performing' || (window as any).__avatarSpeaking) return;
      if (startDefaultIdlePackRef && isDesktopModeRef && motionArbiter.canRunDefaultIdle()) {
        // Preview recovery uses the same grounded bridge as speech return so
        // root/center/foot-IK calibration cannot turn the avatar on exit.
        void startDefaultIdlePackRef(true, 'speech-to-idle-recovery').catch(error => {
          console.warn('[avatar] preview default-idle recovery failed:', error);
        });
      }
    }

    function monitorPreviewCompletion(previewRequestId: number, packId: string, restoreDefault = true): void {
      void (async () => {
        let observedPlaying = false;
        while (motionArbiter.isCurrentPreview(previewRequestId)) {
          const mp = getRuntime().motionPlayer;
          if (mp?.getCurrentPackId() === packId && mp.isPlaying()) {
            observedPlaying = true;
          } else if (observedPlaying) {
            motionArbiter.finishPreview(previewRequestId);
            if (restoreDefault) restoreDefaultAfterPreview();
            return;
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 100));
        }
      })();
    }

    function monitorHeadOverlayPreview(previewRequestId: number): void {
      void (async () => {
        let observedActive = false;
        while (motionArbiter.isCurrentPreview(previewRequestId)) {
          if (headOverlayController.isActive()) observedActive = true;
          else if (observedActive) {
            motionArbiter.finishPreview(previewRequestId);
            restoreDefaultAfterPreview();
            return;
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 100));
        }
      })();
    }

    // Unified latest-request-wins preview. Short, medium, and long motions all
    // play once and use MotionPlayer's normal pending switch instead of a hard reset.
    async function playPreviewVmd(payload: { requestId: string; relativePath: string }): Promise<void> {
      const mp = getRuntime().motionPlayer;
      if (!mp) {
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: 'motion-player-not-ready' });
        return;
      }
      const decision = motionArbiter.requestPreview();
      if (!decision.accepted) {
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: decision.reason });
        return;
      }
      let previewRequestId = decision.requestId;
      const relativePath = payload.relativePath;
      const packId = `manual-vmd:${relativePath.replace(/[\\/]/g, '_')}`;
      try {
        const protectedAction = getProtectedHeadVoiceAction(relativePath);
        const protectedEntry = protectedAction
          ? currentVmdEmotionMap.find(entry => entry.vmdPath === relativePath || entry.vmdPath.endsWith(relativePath) || relativePath.endsWith(entry.vmdPath))
          : null;
        const headOverlayId = resolveHeadOverlayId(protectedEntry ?? protectedAction);
        if (headOverlayId) {
          // Head-only previews never load the authored VMD into MotionPlayer;
          // doing so would overwrite the user's selected default body.
          if (motionPlayer.getCurrentPackId() !== currentDefaultIdle
            && startDefaultIdlePackRef
            && isDesktopModeRef
            && motionArbiter.getMode() !== 'speech') {
            motionPlayer.stop();
            motionArbiter.reset();
            await startDefaultIdlePackRef(true, 'default');
            const refreshed = motionArbiter.requestPreview();
            if (!refreshed.accepted) {
              api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: refreshed.reason });
              return;
            }
            previewRequestId = refreshed.requestId;
          }
          headOverlayController.start(headOverlayId, {
            rotationScale: protectedAction?.headTuning?.rotationScale,
            inwardDirection: resolveCurrentDisplayInwardDirection()
          });
          api.sendPreviewVmdResult({ requestId: payload.requestId, success: true, packId: `head-overlay:${headOverlayId}` });
          monitorHeadOverlayPreview(previewRequestId);
          return;
        }
        let bytes = vmdBytesCache.get(relativePath);
        if (!bytes) {
          const buf = await api.loadCustomVmdBytes(relativePath);
          bytes = new Uint8Array(buf);
          vmdBytesCache.set(relativePath, bytes);
        }
        if (!motionArbiter.isCurrentPreview(previewRequestId)) {
          api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: 'superseded' });
          return;
        }
        await mp.play(packId, bytes, {
          boneMapping: {},
          amplitudeLimits: DEFAULT_AMPLITUDE_LIMITS,
          looping: false,
          timeSource: 'local-clock',
          // 模型专属手感微调：一次性动作 fade 由该模型 manifest.motionTuning 决定
          fadeInSeconds: currentModelMotionTuning.actionFadeInSeconds,
          fadeOutSeconds: currentModelMotionTuning.actionFadeOutSeconds,
          cooldownSeconds: 0,
          force: true,
          compositionMode: 'absolute'
        });
        const startResult = await waitForPreviewStart(previewRequestId, packId);
        if (startResult !== 'started') {
          api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: startResult });
          return;
        }
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: true, packId });
        monitorPreviewCompletion(previewRequestId, packId);
        console.log('[avatar] preview VMD started:', relativePath);
      } catch (e) {
        const reason = e instanceof MotionRequestSupersededError
          ? 'superseded'
          : `play-failed:${(e as Error)?.message ?? String(e)}`;
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason });
        console.warn('[avatar] preview VMD failed:', relativePath, e);
      }
    }

    async function playPreviewRawVmd(payload: {
      requestId: string;
      displayName: string;
      bytes: ArrayBuffer;
    }): Promise<void> {
      const mp = getRuntime().motionPlayer;
      if (!mp) {
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: 'motion-player-not-ready' });
        return;
      }
      const decision = motionArbiter.requestPreview();
      if (!decision.accepted) {
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: decision.reason });
        return;
      }
      const previewRequestId = decision.requestId;
      const packId = `external-vmd:${payload.requestId}`;
      try {
        if (!motionArbiter.isCurrentPreview(previewRequestId)) {
          api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: 'superseded' });
          return;
        }
        await mp.play(packId, new Uint8Array(payload.bytes), {
          boneMapping: {},
          amplitudeLimits: DEFAULT_AMPLITUDE_LIMITS,
          looping: false,
          timeSource: 'local-clock',
          // 模型专属手感微调：一次性动作 fade 由该模型 manifest.motionTuning 决定
          fadeInSeconds: currentModelMotionTuning.actionFadeInSeconds,
          fadeOutSeconds: currentModelMotionTuning.actionFadeOutSeconds,
          cooldownSeconds: 0,
          force: true,
          compositionMode: 'absolute'
        });
        const startResult = await waitForPreviewStart(previewRequestId, packId);
        if (startResult !== 'started') {
          api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason: startResult });
          return;
        }
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: true, packId });
        monitorPreviewCompletion(previewRequestId, packId);
        console.log('[avatar] preview external VMD started:', payload.displayName);
      } catch (e) {
        const reason = e instanceof MotionRequestSupersededError
          ? 'superseded'
          : `play-failed:${(e as Error)?.message ?? String(e)}`;
        api.sendPreviewVmdResult({ requestId: payload.requestId, success: false, reason });
        console.warn('[avatar] preview external VMD failed:', payload.displayName, e);
      }
    }

    async function playDailyMotionCandidate(
      record: MotionCandidateRecord,
      bytes: ArrayBuffer
    ): Promise<void> {
      const mp = getRuntime().motionPlayer;
      if (!mp || record.kind !== 'motion' || record.dialogueSafe !== false) return;
      const decision = motionArbiter.requestPreview();
      if (!decision.accepted || performanceSession.getState() === 'performing') return;
      const style = resolveSpeechMotionStyle(record.emotion, 0.65);
      const packId = `daily-candidate:${record.id}`;
      try {
        await mp.play(packId, new Uint8Array(bytes), {
          boneMapping: {},
          amplitudeLimits: style.amplitudeLimits,
          looping: false,
          timeSource: 'local-clock',
          fadeInSeconds: 0.8,
          fadeOutSeconds: 1,
          cooldownSeconds: 0,
          force: true,
          compositionMode: 'absolute',
          candidateTrackPolicy: 'trusted-voice-full-body',
          candidateExpressionPolicy: 'separate',
          playbackRate: style.playbackRate
        });
        monitorPreviewCompletion(decision.requestId, packId);
      } catch (error) {
        motionArbiter.finishPreview(decision.requestId);
        console.warn('[avatar] daily motion candidate preview failed:', record.id, error);
      }
    }

    function playDailyExpressionCandidate(record: ExpressionCandidateRecord): void {
      if (record.kind !== 'expression'
        || record.automatic !== false
        || performanceSession.getState() === 'performing'
        || actorRuntime.getState().speaking) return;
      actorRuntime.previewCandidateExpression(record);
    }

    // Phase 5.2B：暴露 playIdlePack API 供 E2E 测试和后续表演规划器切换 idle pack。
    // 仅允许白名单中的三个 idle pack ID（getAllIdlePackIds），其他 ID 直接返回 false。
    // 内部使用 getIdlePackBytes + getIdlePackManifest + motionPlayer.play。
    //
    // Phase 5.2 修正（2026-07-19）：
    // - 强制使用 local-clock 时间源（idle pack 不应使用 performance-clock）
    // - 真实 fade ≥0.5s + cooldown ≥30s
    getRuntime().playIdlePack = async (packId: string): Promise<boolean> => {
      try {
        if (!getAllIdlePackIds().includes(packId)) {
          console.warn(`[avatar] playIdlePack rejected: ${packId} not in idle pack whitelist`);
          return false;
        }
        const bytes = getIdlePackBytes(packId);
        const manifest = getIdlePackManifest(packId);
        if (!manifest) {
          console.warn(`[avatar] playIdlePack: manifest not found for ${packId}`);
          return false;
        }
        await motionPlayer.play(packId, bytes, {
          boneMapping: manifest.boneMapping,
          amplitudeLimits: manifest.amplitudeLimits ?? DEFAULT_AMPLITUDE_LIMITS,
          looping: true,
          // idle pack 强制 local-clock
          timeSource: 'local-clock',
          fadeInSeconds: Math.max(0.5, manifest.fadeInSeconds ?? 0.5),
          fadeOutSeconds: Math.max(0.5, manifest.fadeOutSeconds ?? 0.5),
          cooldownSeconds: Math.max(30, manifest.cooldownSeconds ?? 30),
          // Phase 5.2B.3 Closeout Task 3：内部程序化 pack 使用 additive-from-base
          compositionMode: manifest.compositionMode ?? 'absolute'
        });
        return true;
      } catch (e) {
        console.warn(`[avatar] playIdlePack failed for ${packId}:`, e);
        return false;
      }
    };

    // 初始化 morph 面板 UI（仅在 debug 模式下显示，发布包默认隐藏）
    // debug 模式触发条件：URL 参数 ?debugAvatar=1 或 localStorage.debugAvatar === '1'
    // 发布包用户不会看到这个调试面板，桌宠窗口干净显示模型
    const morphPanelDebugAvatarViaUrl = new URLSearchParams(window.location.search).get('debugAvatar') === '1';
    const morphPanelDebugAvatarViaStorage = (() => {
      try { return localStorage.getItem('debugAvatar') === '1'; } catch { return false; }
    })();
    const morphPanelDebugEnabled = morphPanelDebugAvatarViaUrl || morphPanelDebugAvatarViaStorage
      || (identity.isTest && identity.pmxRenderInTest);
    if (morphPanelDebugEnabled) {
      try {
        initMorphPanel();
      } catch (panelErr) {
        console.error('[avatar] morph panel init failed:', panelErr);
      }
    }

    // Task 6 Step 2：持续动画循环（Phase 3 Step 6.1 改用 AvatarLoopController）
    // AvatarLoopController 提供：
    // - 幂等 start/stop（避免重复循环）
    // - 恢复时重置 previous timestamp（避免巨大 delta）
    // - cleanup 后永久停止（窗口关闭）
    // - frame count 计数（用于 E2E 验证循环是否运行）

    const framePorts: AvatarFramePorts = {
      updateOrientation: (dt) => {
        dragRootMotion.advance(model.root.position, dt);
        userFacingController.setUserWorldPosition(model.root.position, camera.position);
        userFacingController.advance(model.root.quaternion, dt);
        physicsBackend?.setModelWorldTransform(
          model.root.position.x,
          model.root.position.y,
          model.root.position.z,
          userFacingController.getCurrentWorldYaw()
        );
        updateGazeToScreenCenter();
      },
      advancePhysics: (dt) => {
        headOverlayController.advance(dt);
        const rotationOverlays = new Map<string, [number, number, number, number]>();
        if (headOverlayController.isActive()) {
          for (const boneName of ['首', '頭'] as const) {
            rotationOverlays.set(boneName, headOverlayController.deltaForPhysics(boneName).toArray());
          }
        }
        physicsBackend?.setBoneRotationOverlays(rotationOverlays);
        physicsBackend?.setTransitionActive(motionPlayer.isInertializing());
        physicsBackend?.advance(dt);
      },
      updateModel: (seconds, options) => {
        // Phase 5.2B：MotionPlayer playing 时使用动画时间（循环 wrap），
        // 这样 model.update(seconds) 会从 VMD 采样正确的骨骼 quaternion + morph weight。
        // 否则使用 wall-clock elapsed（procedural-only 状态）。
        const animTime = motionPlayer.isPlaying()
          ? motionPlayer.getCurrentModelUpdateTime()
          : seconds;
        model.update(animTime, options);
        // 次级骨骼守卫的钳制已移到 finalizePoseBeforeRender（render 前最后一步），
        // 见该端口注释：此处执行会被后续物理步 / updateLife 覆盖，导致渲染出的
        // 骨骼仍超出守卫包络。拖动 settle 尾巴结束后的恢复性重置也在那边执行。
        // Phase 5.2B.3 Closeout Task 3：additive-from-base 姿态组合。
        // 在 model.update() 之后、applyFadeBlend() 之前调用。
        // - absolute 模式：no-op（VMD 采样直接生效）
        // - additive-from-base 模式：把 VMD 采样的绝对姿态转为 base * inverse(rest) * sampled，
        //   使内部程序化 VMD 叠加在 relaxed base pose 上，避免回闪 PMX rest pose。
        try {
          motionPlayer.applyPoseComposition();
        } catch (e) {
          console.warn('[avatar] motionPlayer.applyPoseComposition failed:', e);
        }
        // Phase 5.2 修正（2026-07-19）：调用 applyFadeBlend() 推进 fade 状态机
        // - fading-in：lerp(restPose, vmdSampledPose, t) 覆盖骨骼
        // - fading-out：lerp(vmdSampledPose, restPose, t) 覆盖骨骼，完成后 clearAnimation + 切换 pending pack
        // - playing/idle：no-op
        // 必须在 model.update() 之后调用（此时骨骼是 VMD-sampled 值），但在 morph 恢复之前
        try {
          motionPlayer.applyFadeBlend();
        } catch (e) {
          console.warn('[avatar] motionPlayer.applyFadeBlend failed:', e);
        }
        if (headOverlayController.isActive()) {
          for (const boneName of ['首', '頭'] as const) {
            const bone = model.mesh.skeleton.bones.find(candidate => candidate.name === boneName);
            if (bone) bone.quaternion.copy(headOverlayController.compose(boneName, bone.quaternion));
          }
        }
        // Phase 5.2B 修复：VMD applyMmdAnimation 每帧执行 morphTargetInfluences.fill(0) 清除所有 morph，
        // 然后只设置 VMD 中有轨道的 morph。这会清除 ActorRuntime.setEmotion 设置的情绪 morph
        //（怒り/照れ/FaceRed 等）和其他非 VMD 拥有的 morph（如 まばたき 在无 blink 轨道的 idle pack 下）。
        // 修复：model.update() 后，从 MorphController 读取非 VMD 拥有的 morph 权重并恢复到 mesh.morphTargetInfluences。
        // onBeforeRender 钩子（@yohawing attachMorphSplitInfluenceSync）会在 renderer.render() 时
        // 自动同步 mesh.morphTargetInfluences 到 morph split body meshes，无需手动调用 syncMorphSplitTargetInfluences。
        // 注意：updateLife 随后会写入 まばたき（如 procedural 拥有），覆盖此处的恢复值，行为正确。
        if (motionPlayer.isPlaying()) {
          const dict = model.mesh.morphTargetDictionary;
          const infl = model.mesh.morphTargetInfluences;
          if (dict && infl) {
            const activeMorphs = actorRuntime.getMorphController().getActiveMorphs();
            for (const { name, weight } of activeMorphs) {
              // 只恢复非 VMD 拥有的 morph（procedural / performance-planner）
              // VMD 拥有的 morph 已由 applyMmdAnimation 从 VMD 轨道采样设置，不应覆盖
              if (morphOwnershipRegistry.getOwner(name) !== 'vmd') {
                const idx = dict[name];
                if (idx !== undefined) {
                  infl[idx] = weight;
                }
              }
            }
          }
        }
        // VMD sampling clears every mesh morph before applying authored tracks.
        // During speech and explicit expression previews, the user-facing
        // facial pool is authoritative, including channels also present in a
        // VMD (notably blink/eyelids). Reapply the complete layered face every
        // frame so unchanged semantic weights do not disappear after one tick.
        if (performanceSession.getState() === 'performing' || currentExpression !== 'neutral') {
          actorRuntime.reapplyPerformanceMorphs();
        }
        // 闪烁修复：applyMmdMaterialCompatibility 移到 mesh.onBeforeRender 中执行，
        // 确保在 renderer.render() 前最后一步覆盖 syncMmdMaterialStates 的 colorWrite 重置。
        // 此处不再调用，避免 updateModel 与 onBeforeRender 之间的时序竞态导致闪烁。
      },
      updateActor: (dt) => {
        actorRuntime.update(dt);
        if (performanceSession.getState() === 'performing') {
          const cue = performanceSession.getCurrentPerformanceCue();
          const expr = performanceSession.getCurrentExpression();
          if (cue && speechCueDispatch.enter(cue)) {
            const facialEmotion = cue.facialEmotion;
            gazeController.setSpeakingSemantic(resolveSpeechGazeSemantic(cue));
            pupilController.setSemantic(facialEmotion);
            if (currentSpeechGeneration !== null
              && currentSpeechMotionGeneration !== null
              && motionArbiter.canRunSpeechMotion()) {
              const generation = currentSpeechGeneration;
              const motionGeneration = currentSpeechMotionGeneration;
              const forceStanding = shouldUseSpeechBackgroundForCue(cue)
                && currentSpeechCueOwnerGeneration === null;
              if (forceStanding) {
                void ensureSpeechBackgroundMotion(generation, motionGeneration, true);
              } else {
                void playSpeechCueGesture(cue, generation, motionGeneration, facialEmotion).then(started => {
                  if (!started && isSpeechCueWaitingForMotionHandoff(cue, generation)) {
                    // The cue was observed at the boundary while the previous
                    // one-shot was still settling. Release the dispatch latch;
                    // the next audio frame retries instead of losing the turn.
                    speechCueDispatch.release(cue);
                  } else if (!started) {
                    void ensureSpeechBackgroundMotion(generation, motionGeneration);
                  }
                }).catch(error => {
                  console.warn('[avatar] speech cue failed; restoring speech background:', error);
                  speechCueDispatch.release(cue);
                  void ensureSpeechBackgroundMotion(generation, motionGeneration);
                });
              }
            }
          }
          actorRuntime.applyPerformanceSample(expr, performanceSession.getCurrentVisemeWeights());
        } else if (currentExpression === 'neutral') {
          // Default face is the selected global idle expression (default a
          // tender, affectionate smile: smiling eyes, soft brow, gaze at the
          // user). Switchable via right-click "默认表情" — loving/serious/sad/
          // shy/angry — uniform across builtin and imported models. Injected in
          // every neutral state — idle VMD playback included — because the
          // per-frame morph restore above already defers to VMD ownership: an
          // idle VMD with authored facial tracks keeps its own face; one
          // without facial tracks shows this default expression.
          actorRuntime.previewExpression(defaultIdleExpression as Emotion, 0.62);
        }
        // idle 状态下不额外操作：setEmotion 已在语音结束时调用，
        // morph 恢复逻辑会在每帧恢复 weight>0 的情绪 morph
      },
      // Phase 5.2B.1 Task 2：先应用放松基础姿态（手臂），再叠加呼吸/摇摆（上半身/頭/肩）
      // 顺序很重要：放松姿态是静态基础层，呼吸/摇摆叠加在上半身/頭/肩上
      // 两者通过 BoneOwnershipRegistry 协调，VMD claim 后两者都跳过
      updateRelaxedBasePose: () => relaxedBasePoseController.apply(),
      updateLife: (seconds, dt) => {
        // 2026-07-29 关键修复（用户反馈"模型完全动不了，呼吸看不见"）：
        // 之前 isSpeakingMotion 只看 motionPlayer.getCurrentTimeSource() === 'performance-clock'，
        // 但 idle VMD 某些情况下 timeSource 也会被错误置为 performance-clock，
        // 或者 motionPlayer.isPlaying() 短暂为 false 时被错误读取。
        // 修复：使用 motionArbiter 状态机作为唯一事实源：
        //   - arbiter.mode === 'speech'  → speaking
        //   - 其他所有情况（idle/preview/无播放）→ 释放 procedural 写入
        // 这样绝对不会被卡死，且与 motionArbiter.canRunIdle() 一致。
        const arbiterMode = motionArbiter.getMode();
        const isSpeakingMotion = arbiterMode === 'speech' && !poseLockedState;
        if (physicsBackend?.diagnosticsState().speechContinuityActive && !isSpeakingMotion) {
          const currentMotionPackId = String(motionPlayer.getCurrentPackId() ?? '');
          // The audio clock is handed to the local clock as part of
          // stopPerformance('ended') before the selected idle bind finishes.
          // A speech cue is therefore briefly local-clock driven while it is
          // still the visible owner. Ending Bullet continuity at that moment
          // forwards the next setAnimation reset and lets the leg/IK chain be
          // solved once from a fresh world, which is the post-speech snap.
          // Keep continuity until a non-speech pack (the selected idle or a
          // natural base) is actually visible.
          const speechPackStillVisible = currentMotionPackId.startsWith('speech-');
          const settledLocalMotion = motionPlayer.isPlaying()
            && motionPlayer.getCurrentTimeSource() === 'local-clock'
            && motionPlayer.getState() === 'playing'
            && !speechPackStillVisible;
          const settledNaturalBase = !motionPlayer.isPlaying()
            && motionPlayer.getState() === 'idle';
          // Before episodic-idle restoration, speech always handed directly
          // to another local-clock VMD. Now a head-only speech body fades to
          // the natural base pose. End the continuity lease there as well;
          // otherwise the next reply inherits the old clip-local timestamp,
          // is misread as a loop wrap, and can launch Bullet hair/clothing.
          if (settledLocalMotion || settledNaturalBase) {
            physicsBackend.endSpeechContinuity();
          }
        }
        // Speech owns only the tracks actually admitted by MotionPlayer.
        // Keeping the whole procedural life layer suppressed made replies
        // with a head-only or missing gesture freeze the avatar completely.
        // Bone ownership already prevents breathing/sway from overwriting any
        // authored speech track, so the unclaimed body can remain alive and
        // Bullet hair/clothing continues to receive moving parent transforms.
        lifeController.setSuppressed(false);
        // 如果 motionPlayer 不在播放（idle gap），强制取消抑制
        if (!motionPlayer.isPlaying()) {
          lifeController.setSuppressed(false);
        }
        // The inertial bridge owns the upper torso during an idle/speech
        // handoff. Fade breathing away instead of adding a second body source.
        const inertializing = motionPlayer.isInertializing();
        lifeController.setBodyMotionSuppressed(inertializing);
        const idleBreathOverlay = shouldOverlayIdleBreathing({
          arbiterMode,
          motionPlaying: motionPlayer.isPlaying(),
          speakingMotion: isSpeakingMotion,
          inertializing
        });
        lifeController.setPoseLocked(
          (poseLockedState && motionPlayer.isPlaying()) || idleBreathOverlay
        );
        // 2026-07-29 Watchdog：每帧检查 __avatarSpeaking 是否与实际状态一致
        // 之前 __avatarSpeaking 在音频异常结束时偶尔卡在 true（sourceNode.onended 未触发），
        // 导致 idle 启动被拒绝、模型完全静止。
        if ((window as any).__avatarSpeaking) {
          // audioContext 已结束（currentSource=null）但标志仍是 true → 强制清零
          if (!currentSource && arbiterMode !== 'speech') {
            console.warn('[avatar] watchdog: __avatarSpeaking stuck but no source, clearing');
            (window as any).__avatarSpeaking = false;
            if ((window as any).__avatarSpeakingSafetyTimeout) {
              clearTimeout((window as any).__avatarSpeakingSafetyTimeout);
              (window as any).__avatarSpeakingSafetyTimeout = null;
            }
          }
        }
        // Intentionally no per-frame automatic VMD restart. The previous
        // post-04:31 fallback could reclaim the skeleton immediately after a
        // preview, speech, or a failed transition.
        lifeController.update(seconds, dt);
        gazeController.update(dt);
        pupilController.update(dt);
      },
      // 渲染前最后一帧姿态守卫：次级骨骼拖动钳制在此执行，保证对外可见骨骼
      // 停在守卫包络内（updateModel 内的 apply 会被后续物理步 / updateLife 覆盖）。
      finalizePoseBeforeRender: () => {
        dragSecondaryAttachment.apply(
          physicsBackend?.diagnosticsState().lastStepDeltaSeconds ?? 1 / 60
        );
        if (pendingDragKinkRecovery) {
          if (!dragSecondaryAttachment.isActive()) {
            // settle 尾巴结束：根据累积的折叠强度决定是否重建 Bullet 世界。
            // 折叠（Z 形卡住）时物理持续把链推越界，clamped 骨骼占比高；
            // 正常回摆时链条自然回落，样本里 clamped 骨骼基本归零。
            pendingDragKinkRecovery = false;
            const folded = kinkSampleFrames > 0
              && kinkFoldedBoneSamples / Math.max(1, kinkSampleBoneCount)
                >= KINK_FOLD_RATIO_THRESHOLD;
            const reason = folded ? 'root-drag-kink-fold-detected' : null;
            // eslint-disable-next-line no-console
            console.log(`[kink] frames=${kinkSampleFrames} foldedRatio=${
              kinkSampleBoneCount > 0
                ? (kinkFoldedBoneSamples / kinkSampleBoneCount).toFixed(3)
                : 'n/a'
            } ${reason ?? 'no-reset'}`);
            if (folded && !(window as any).__avatarSpeaking) {
              physicsBackend?.requestHardReset(reason as string);
              physicsBackend?.reset?.();
            }
            kinkSampleFrames = 0;
            kinkFoldedBoneSamples = 0;
            kinkSampleBoneCount = 0;
          } else {
            // 仍在 settle 尾巴：累积守卫诊断样本。当前帧被钳制的骨骼视为
            // "被物理推越界"，计入折叠强度。
            const frame = dragSecondaryAttachment.getLastFrameDiagnostics();
            if (frame && frame.length > 0) {
              kinkSampleFrames += 1;
              kinkSampleBoneCount += frame.length;
              kinkFoldedBoneSamples += frame.filter(bone => bone.clamped).length;
            }
          }
        }
      },
      render: () => renderer.render(scene, camera)
    };

    const loopController = new AvatarLoopController({
      setAnimationLoop: (cb) => renderer.setAnimationLoop(cb),
      onFrame: (delta, elapsed) => stepAvatarFrame(framePorts, elapsed, delta, physicsEnabled),
      // stop() 后手动渲染一帧：同步 morph split + render()。
      // 关键：必须调用 syncMorphSplitTargetInfluences(mesh) 将 mesh.morphTargetInfluences
      // 同步到 morph split 子几何体（@yohawing 把稀疏顶点 morph 拆分到 per-material body meshes，
      // 实际渲染的是这些子几何体，不同步则像素无变化）。
      // 不调用 model.update()：那会通过 runtime.evaluate() 用动画采样的 morph 权重覆盖
      // mesh.morphTargetInfluences（无动画时清零），擦除 setWeight 的值。
      renderOneFrame: () => {
        syncMorphSplitTargetInfluences(model.mesh);
        framePorts.render();
      }
    });

    // Phase 3 Step 6.1 + 6.2：暴露 loopController 到 __chatx2Runtime.avatarLoop
    // E2E 测试和 mode-change 订阅都会通过此接口控制循环。
    getRuntime().avatarLoop = loopController;

    // Phase 3 Step 6.2：订阅 mode-change 事件，自动 start/stop 循环
    // - 进入 desktop：start（幂等，已运行则 no-op）
    // - 进入 chat/loading：stop（幂等，已停止则 no-op）+ P1-E 调用 stopPerformance() 清零口型
    //   + Phase 5.2B：调用 motionPlayer.stop() 清除 VMD 动画绑定 + 释放骨骼/morph lease
    // - 不 dispose 模型；beforeunload/窗口关闭才完整 cleanup
    // - 不依赖 Electron 隐藏窗口自动节流
    const handleModeChange = (event: ModeChangeEvent): void => {
      if (event.to === 'desktop') {
        idleStartDebug.modeChangeHandled = true;
        isDesktopModeRef = true;
        const idleDecision = idleLifecycle.enterDesktop(currentIdleSources());
        // 加载角色专属打光配置
        void loadLightingFromManifest().then(() => {
          applyLightingPreset(currentLightingPreset);
          applyLightingDynamic(currentLightingDynamic);
        });
        // Entering desktop only arms the delayed one-shot scheduler. The
        // configured default is not a permanent loop.
        // Bind the saved default idle before starting the animation loop. This
        // prevents the first visible frames from showing the procedural/rest
        // pose as an unintended "initial action".
        void applyIdleLifecycleDecision(idleDecision).then(() => {
          if (isDesktopModeRef) loopController.start();
        }).catch(e => {
          console.warn('[avatar] start default idle on desktop transition failed:', e);
          if (isDesktopModeRef) loopController.start();
        });
        // 进入桌面后眼神看向屏幕中心
        updateGazeToScreenCenter();
      } else {
        // chat / loading / scene 都停止循环
        // scene 暂未实现，按 chat 处理
        loopController.stop();
        idleLifecycle.leaveDesktop();
        // 停止 idle 轮换定时器
        stopIdleRotation();
        // Phase 5.2B：标记当前非 desktop 模式
        isDesktopModeRef = false;
        // Phase 5.2B 扩展：离开 desktop 时停止链式多段 VMD 播放
        try {
          if (motionSequence.getIsRunning()) {
            motionSequence.stopImmediate();
          }
        } catch (e) {
          console.warn('[avatar] motionSequence.stopImmediate on mode-change failed:', e);
        }
        // Phase 5.2 修正（2026-07-19）：离开 desktop 时使用 stopImmediate() 紧急停止 VMD 动作
        // 理由：模式切换是紧急情况，不应等待 fade-out 0.5s 才停止；立即 clearAnimation + resetPose + release lease
        // 必须在 stopPerformance 之前调用，确保骨骼 owner 恢复 none，procedural 写入不会冲突
        try {
          if (motionPlayer.isPlaying()) {
            motionPlayer.stopImmediate();
          }
        } catch (e) {
          console.warn('[avatar] motionPlayer.stopImmediate on mode-change failed:', e);
        }
        // Phase 5.2B.1 Task 2（2026-08 修正）：离开 desktop 时不再把手臂
        // 重置到 PMX rest pose。chat 模式下 Avatar 窗口隐藏，重置没有视觉
        // 必要；而快速开关桌宠时它反而有害——重进后 idle 从 A-pose
        // （手臂张开 0°）经弹簧/惯性过渡回到待机姿态（实测 0→76→11→43°
        // 振荡 ~0.7s），表现为"模型刚出现无缘无故抬手放下"。
        // 保留骨骼在离开前的姿态，重进时 fadeIn=0 瞬切回同一姿态，不可见。
        // 真正的窗口卸载（beforeunload cleanup）仍会完整重置（见 cleanup 路径）。
        gazeController.reset();
        // P1-E：离开 desktop 时停止表演（清零 viseme + 停止 sourceNode）
        // 主进程也会发送 avatar:stop-play('mode-change')，但这里直接调用确保即时清理
        stopPerformance('interrupted');
      }
    };
    const unsubscribeModeChange = api.onModeChange(handleModeChange);

    // Phase 5.2 Task 5.2.x：订阅模型包切换，热重载 PMX + 纹理
    // 主进程在更新 selectedModel 后通过 webContents.reload() 重载 Avatar 窗口
    const unsubscribeModelPackChanged = api.onModelPackChanged(() => {
      void refreshModelPackMotions();
    });

    // 动作配置变更（设为默认/加入待机/删除/动作包开关）— 仅刷新动作列表，不重载模型
    const unsubscribeMotionConfigChanged = api.onMotionConfigChanged(() => {
      void refreshModelPackMotions();
    });

    // 预览动作包：模型管理面板点击「预览」时，Avatar 窗口即时播放该动作
    const unsubscribePreviewMotionPack = api.onPreviewMotionPack((payload) => {
      void playPreviewMotionPack(payload.packId, payload.type);
    });

    // Unified VMD preview request for all library durations.
    const unsubscribePreviewVmd = api.onPreviewVmd((payload) => {
      void playPreviewVmd(payload);
    });
    const unsubscribePreviewRawVmd = api.onPreviewRawVmd((payload) => {
      void playPreviewRawVmd(payload);
    });

    const unsubscribePreviewMotionCandidate = api.onPreviewMotionCandidate((record, bytes) => {
      void playDailyMotionCandidate(record, bytes);
    });
    const unsubscribePreviewExpressionCandidate = api.onPreviewExpressionCandidate((record) => {
      playDailyExpressionCandidate(record);
    });
    const unsubscribeAcceptedExpressionsChanged = api.onAcceptedExpressionsChanged((entries) => {
      acceptedExpressions = entries;
      expressionPresets = selectedPerformanceProfile
        ? buildSpeechExpressionPool(selectedPerformanceProfile, acceptedExpressions)
        : [];
      performanceSession.updateAcceptedExpressions(
        acceptedExpressions,
        selectedPerformanceProfile
          ? getSupportedSpeechExpressionChannels(selectedPerformanceProfile)
          : []
      );
    });

    // 待机动作暂停/恢复
    const unsubscribeToggleIdlePaused = api.onToggleIdlePaused((payload) => {
      motionArbiter.setIdlePaused(payload.paused);
      const decision = idleLifecycle.setPaused(payload.paused);
      console.log('[avatar] idle paused:', payload.paused);
      void applyIdleLifecycleDecision(decision).catch(e => {
        console.warn('[avatar] apply idle pause lifecycle failed:', e);
      });
    });

    // 打光预设切换：模型管理面板选择打光时
    const unsubscribeSetLighting = api.onSetLighting((payload) => {
      try {
        const rt = getRuntime();
        if (rt.applyLightingPreset) {
          rt.applyLightingPreset(payload.presetId);
          applyLightingDynamic(currentLightingDynamic);
        }
      } catch (e) {
        console.warn('[avatar] applyLightingPreset failed:', e);
      }
    });

    // 表情池手动预览只允许在非语音状态下执行，不写入待机表情；
    // 自动语音期间由 AvatarPerformanceSession 按已接受条目和语义时间轴采样。
    const unsubscribeSetExpression = api.onSetExpression((payload) => {
      try {
        const rt = getRuntime();
        if (rt.previewSpeechExpression) {
          rt.previewSpeechExpression(payload.expressionId, payload.channel);
        }
      } catch (e) {
        console.warn('[avatar] previewSpeechExpression failed:', e);
      }
    });

    // 动态打光调节：实时调节灯光方向/强度
    const unsubscribeSetLightingDynamic = api.onSetLightingDynamic((params) => {
      try {
        if (params.keyX !== undefined && params.keyY !== undefined && params.keyZ !== undefined) {
          keyLight.position.set(params.keyX, params.keyY, params.keyZ);
        }
        if (params.keyIntensity !== undefined) {
          keyLight.intensity = params.keyIntensity;
        }
        if (params.fillIntensity !== undefined) {
          fillLight.intensity = params.fillIntensity;
        }
        if (params.rimIntensity !== undefined) {
          rimLight.intensity = params.rimIntensity;
        }
        if (params.hemiIntensity !== undefined) {
          hemisphereLight.intensity = params.hemiIntensity;
        }
        currentLightingDynamic = { ...currentLightingDynamic, ...params };
        renderer.domElement.style.filter = lightingCanvasFilter(
          currentLightingDynamic.contrast,
          currentLightingDynamic.saturation
        );
      } catch (e) {
        console.warn('[avatar] setLightingDynamic failed:', e);
      }
    });

    const applyAvatarComputeLevel = (level: AvatarComputeLevel): void => {
      try {
        const profile = getAvatarComputeProfile(level);
        console.log('[avatar] applying compute profile:', profile.level);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.render.pixelRatioCap));
        renderer.shadowMap.enabled = profile.render.shadows !== 'off';
        if (profile.render.shadows === 'soft') renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        if (profile.render.shadows === 'vsm') renderer.shadowMap.type = THREE.VSMShadowMap;
        renderer.toneMappingExposure = profile.render.exposure;
        performanceSession.setComputeLevel(profile.level);
        speechMotionDirector.configure({
          leadInMs: profile.speech.leadInMs,
          longReplySeconds: profile.speech.longReplySeconds,
          recentReplyWindow: profile.speech.recentReplyWindow,
          shortReplyAccentLimit: profile.speech.shortReplyAccentLimit,
          longReplyAccentLimit: profile.speech.longReplyAccentLimit
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        console.log('[avatar] compute profile applied:', profile.level,
          'pixelRatio=', renderer.getPixelRatio(),
          'lipStepMs=', Math.round(profile.speech.lipFrameSeconds * 1000),
          'semanticBeatSeconds=', profile.speech.semanticBeatSeconds,
          'longAccentLimit=', profile.speech.longReplyAccentLimit);
      } catch (e) {
        console.warn('[avatar] applyAvatarComputeLevel failed:', e);
      }
    };
    const unsubscribeSetRenderQuality = api.onSetRenderQuality((payload) => {
      applyAvatarComputeLevel(payload.level);
    });
    void api.getRenderQuality()
      .then(({ level }) => applyAvatarComputeLevel(level))
      .catch(e => console.warn('[avatar] getRenderQuality failed:', e));

    // 视角模式切换：从 Composer 窗口转发过来（全身/半身）
    let currentViewMode: 'full' | 'half' = 'full';
    const unsubscribeSetCameraView = api.onSetCameraView((mode) => {
      const viewerCtrl = getRuntime().cameraControl as ViewerControls | undefined;
      if (!viewerCtrl) {
        console.warn('[avatar] setCameraView: viewerCtrl not available');
        return;
      }
      currentViewMode = mode;
      const ok = viewerCtrl.setViewMode(mode);
      if (!ok) {
        console.warn('[avatar] setCameraView failed:', mode);
      }
      // 视角切换后模型默认位置变化，重新看向屏幕中心
      updateGazeToScreenCenter();
    });

    const unsubscribeSetModelRotation = api.onSetModelRotation(({ yaw, pitch }) => {
      userFacingController.setManualRotation(
        THREE.MathUtils.degToRad(Number.isFinite(yaw) ? yaw : 0),
        THREE.MathUtils.degToRad(Number.isFinite(pitch) ? pitch : 0)
      );
    });

    // Composer 的 +/- 与滚轮使用同一相机 zoom。绝不能缩放 PMX 根节点，
    // 否则 MMD 的物理骨骼、服饰和发型会在缩放后产生失真。
    const unsubscribeSetModelScale = api.onSetModelScale((delta) => {
      const viewerCtrl = getRuntime().cameraControl as ViewerControls | undefined;
      if (!viewerCtrl) {
        console.warn('[avatar] setModelScale: viewerCtrl not available');
        return;
      }
      const currentZoom = viewerCtrl.getZoom();
      const newZoom = viewerCtrl.setZoom(currentZoom + delta);
      console.log('[avatar] camera zoom:', currentZoom.toFixed(2), '->', newZoom.toFixed(2));
    });

    // Phase 3 Step 6.2：初始化时根据当前模式决定是否启动循环
    // transition(desktop) 已经在主进程完成，但 avatar renderer 可能在 mode-change 之后才注册
    // 所以需要主动查询当前模式
    try {
      const currentMode = await api.getMode();
      idleStartDebug.initialModeCheckRan = true;
      idleStartDebug.initialMode = currentMode;
      if (currentMode === 'desktop') {
        isDesktopModeRef = true;
        const idleDecision = idleLifecycle.enterDesktop(currentIdleSources());
        void applyIdleLifecycleDecision(idleDecision).then(() => {
          if (isDesktopModeRef) loopController.start();
        }).catch(e => {
          console.warn('[avatar] start default idle on initial desktop state failed:', e);
          if (isDesktopModeRef) loopController.start();
        });
      } else {
        loopController.stop();
        isDesktopModeRef = false;
        idleLifecycle.leaveDesktop();
      }
    } catch (modeErr) {
      console.warn('[avatar] getMode failed, defaulting to desktop start:', modeErr);
      loopController.start();
      isDesktopModeRef = true;
    }

    // 处理窗口大小变化：重新计算相机距离
    // 窗口全屏且不可调整大小，resize 仅在初始加载或显示变化时触发
    const onResize = (): void => {
      const newWidth = window.innerWidth;
      const newHeight = window.innerHeight;
      // 尺寸未变化时跳过（窗口移动触发），避免重置视角
      // 使用 2px 容差防止 DPI 缩放导致的微小波动
      if (Math.abs(newWidth - canvas.width) <= 2 && Math.abs(newHeight - canvas.height) <= 2) return;
      const savedZoom = viewerCtrl ? viewerCtrl.getZoom() : 1;
      const savedPan = viewerCtrl ? viewerCtrl.getPanOffset() : { x: 0, y: 0 };
      canvas.width = newWidth;
      canvas.height = newHeight;
      renderer.setSize(canvas.width, canvas.height);
      const newAspect = canvas.width / canvas.height;
      const newHFovRad = 2 * Math.atan(newAspect * Math.tan(vFovRad / 2));
      const newDistV = (size.y / 2) / Math.tan(vFovRad / 2) * padding;
      const newDistH = (size.x / 2) / Math.tan(newHFovRad / 2) * padding;
      const newDistance = Math.max(newDistV, newDistH, 5);
      camera.aspect = newAspect;
      camera.updateProjectionMatrix();

      // 通过 viewerCtrl 更新基准距离，保持当前缩放和平移状态
      if (viewerCtrl) {
        viewerCtrl.setBaseDistance(newDistance);
        // 恢复 zoom 和 pan（setBaseDistance 会重置它们）
        viewerCtrl.setZoom(savedZoom);
        viewerCtrl.setPanOffset(savedPan.x, savedPan.y);
        // 重新应用当前视角模式（窗口 resize 可能重置相机到全身视角）
        // preservePosition=true 避免覆盖用户拖动位置
        viewerCtrl.setViewMode(currentViewMode, true);
      } else {
        camera.position.set(0, center.y, newDistance);
        camera.lookAt(0, center.y, 0);
      }

      renderer.render(scene, camera);
    };
    window.addEventListener('resize', onResize);

    // Task 6 Step 4 + P1-E：beforeunload 时清理，避免窗口关闭后循环仍运行 + 停止表演
    const onBeforeUnload = (): void => {
      // P1-E：先停止表演（清零 viseme + 停止 sourceNode + 通知主进程）
      stopPerformance('interrupted');
      if (rendererInstance) {
        rendererInstance.cleanup();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Task 6 Step 4：生命周期清理
    // 必须按顺序：取消订阅 → 停止 VMD 动作 → 停止表演 → 停止循环 → 解除 sink → 释放模型 → 释放纹理 URL → 释放渲染器
    rendererInstance = {
      cleanup: (): void => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('beforeunload', onBeforeUnload);
        // Phase 3 Step 6.2：cleanup 必须取消 mode-change 订阅
        try {
          unsubscribeModeChange();
        } catch (unsubErr) {
          console.warn('[avatar] unsubscribeModeChange failed:', unsubErr);
        }
        // Phase 5.1 P0-A/B/C：取消 play/stop-play 订阅
        try { unsubscribePlay(); } catch { /* ignore */ }
        try { unsubscribeStopPlay(); } catch { /* ignore */ }
        // 停止 idle 轮换定时器
        stopIdleRotation();
        // Phase 5.2 修正（2026-07-19）：取消 emotion/motion 订阅
        try { unsubscribeMotionEmotionUpdate(); } catch { /* ignore */ }
        try { unsubscribeMotionCommand(); } catch { /* ignore */ }
        // Phase 5.2 Task 5.2.x：取消模型包配置变更订阅
        try { unsubscribeModelPackChanged(); } catch { /* ignore */ }
        try { unsubscribeMotionConfigChanged(); } catch { /* ignore */ }
        // 取消动作预览订阅
        try { unsubscribePreviewMotionPack(); } catch { /* ignore */ }
        try { unsubscribePreviewVmd(); } catch { /* ignore */ }
        try { unsubscribePreviewRawVmd(); } catch { /* ignore */ }
        try { unsubscribePreviewMotionCandidate(); } catch { /* ignore */ }
        try { unsubscribePreviewExpressionCandidate(); } catch { /* ignore */ }
        try { unsubscribeAcceptedExpressionsChanged(); } catch { /* ignore */ }
        try { unsubscribeToggleIdlePaused(); } catch { /* ignore */ }
        try { unsubscribePoseLockChanged(); } catch { /* ignore */ }
        try { unsubscribeGazeLock(); } catch { /* ignore */ }
        // 取消打光/表情订阅
        try { unsubscribeSetLighting(); } catch { /* ignore */ }
        try { unsubscribeSetExpression(); } catch { /* ignore */ }
        // 动态打光 + 长时间动作预览订阅
        try { unsubscribeSetLightingDynamic(); } catch { /* ignore */ }
        try { unsubscribeSetRenderQuality(); } catch { /* ignore */ }
        try { unsubscribeSetModelRotation(); } catch { /* ignore */ }
        try { unsubscribeSetCameraView(); } catch { /* ignore */ }
        try { unsubscribeSetModelScale(); } catch { /* ignore */ }
        // Phase 5.2 修正（2026-07-19）：cleanup 时使用 stopImmediate() 紧急停止 VMD 动作
        // 理由：cleanup 是窗口关闭前的最后清理，不应等待 fade-out
        // 必须在 stopPerformance 之前调用，确保骨骼 owner 恢复 none
        // Phase 5.2B 扩展：先停止链式多段 VMD 播放
        try {
          if (motionSequence.getIsRunning()) {
            motionSequence.stopImmediate();
          }
        } catch (e) {
          console.warn('[avatar] motionSequence.stopImmediate on cleanup failed:', e);
        }
        try {
          if (motionPlayer.isPlaying()) {
            motionPlayer.stopImmediate();
          }
        } catch (e) {
          console.warn('[avatar] motionPlayer.stopImmediate on cleanup failed:', e);
        }
        // Phase 5.2B.1 Task 2：cleanup 时恢复手臂到 PMX rest pose
        try {
          relaxedBasePoseController.reset();
        } catch (e) {
          console.warn('[avatar] relaxedBasePoseController.reset on cleanup failed:', e);
        }
        gazeController.reset();
        // P1-E：停止任何正在进行的表演
        stopPerformance('interrupted');
        // 关闭 AudioContext
        if (audioCtx && audioCtx.state !== 'closed') {
          try { audioCtx.close(); } catch { /* ignore */ }
          audioCtx = null;
        }
        (window as any).__avatarSpeaking = false;
        loopController.cleanup();
        actorRuntime.bindMorphSink(undefined);
        try {
          disposeMmdModel(model);
        } catch (disposeErr) {
          console.warn('[avatar] disposeMmdModel failed:', disposeErr);
        }
        // 释放 Bullet 物理引擎
        try {
          speechPhysicsBackendRef?.endSpeechContinuity();
          speechPhysicsBackendRef = null;
          disposeBulletPhysics();
        } catch (physicsErr) {
          console.warn('[avatar] disposeBulletPhysics failed:', physicsErr);
        }
        for (const url of objectUrls) {
          URL.revokeObjectURL(url);
        }
        objectUrls.length = 0;
        renderer.dispose();
      }
    };

  } catch (err) {
    // PMX 加载/渲染失败，回退到 placeholder-canvas
    console.error('[avatar] PMX render failed, falling back to placeholder:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    if (statusLabel) {
      statusLabel.textContent = `[PMX failed: ${errMsg}]`;
    }
    drawPlaceholder(canvas);
    // 不调用 signalPmxFirstFrame(false) —— 它会清除 avatar-ready 证据，
    // 导致用户永远无法切换到桌宠模式。改为仅通知 placeholder 就绪。
    api.signalAvatarReady();
  }
}

/**
 * 首帧像素健康检查：非全透明、非全黑、非全白
 */
function checkFirstFramePixels(canvas: HTMLCanvasElement): { ok: boolean; reason?: string } {
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) {
    return { ok: false, reason: 'WebGL context not available' };
  }

  // The avatar is framed around the canvas center. Reading the entire
  // fullscreen framebuffer here forced a multi-megapixel GPU->CPU sync on
  // the first desktop click (especially expensive on high-DPI displays).
  // A bounded center window preserves the failure check while keeping the
  // synchronous read below roughly 64K pixels.
  const sampleWidth = Math.min(256, Math.max(1, canvas.width));
  const sampleHeight = Math.min(256, Math.max(1, canvas.height));
  const originX = Math.max(0, Math.floor((canvas.width - sampleWidth) / 2));
  const originY = Math.max(0, Math.floor((canvas.height - sampleHeight) / 2));
  const pixels = new Uint8Array(sampleWidth * sampleHeight * 4);

  try {
    gl.readPixels(originX, originY, sampleWidth, sampleHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } catch (e) {
    return { ok: false, reason: `readPixels failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const totalPixels = sampleWidth * sampleHeight;
  const sampleStep = Math.max(1, Math.floor(totalPixels / 2000));
  let hasNonZeroAlpha = false;
  let hasNonZeroRGB = false;
  let hasNonMaxRGB = false;
  let sampledCount = 0;

  for (let i = 0; i < pixels.length; i += 4 * sampleStep) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    sampledCount++;
    if (a > 0) hasNonZeroAlpha = true;
    if (r + g + b > 0) hasNonZeroRGB = true;
    if (r < 255 || g < 255 || b < 255) hasNonMaxRGB = true;
    if (hasNonZeroAlpha && hasNonZeroRGB && hasNonMaxRGB) break;
  }

  if (sampledCount === 0) {
    return { ok: false, reason: 'no pixels sampled' };
  }
  if (!hasNonZeroAlpha) {
    return { ok: false, reason: 'all transparent (alpha=0)' };
  }
  if (!hasNonZeroRGB) {
    return { ok: false, reason: 'all black (RGB=0,0,0)' };
  }
  if (!hasNonMaxRGB) {
    return { ok: false, reason: 'all white (RGB=255,255,255)' };
  }

  return { ok: true };
}

/**
 * 绘制占位 Canvas（PMX 失败时回退）
 */
function drawPlaceholder(canvas: HTMLCanvasElement): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(120, 180, 255, 0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = 'rgba(200, 200, 200, 0.4)';
  ctx.font = '14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('[Avatar Placeholder - PMX failed]', canvas.width / 2, canvas.height / 2);
}

initAvatarRenderer().catch(err => {
  console.error('[avatar] init failed:', err);
});
