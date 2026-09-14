// Phase 5.2 Task 5.2.3: MotionPack 白名单注册表与主进程生命周期
//
// 职责：
// - 注册 / 查询 / 移除 MotionPackManifest
// - 8 阶段门校验（未通过的 manifest 拒绝注册）
// - releaseAll() 用于 Avatar crash/close / 模式切换离开 desktop / before-quit
// - 事件系统：registered / unregistered / release-all
//
// 主进程生命周期管理（与 wavCache 释放同路径）：
// - Avatar crash/close → releaseAll()
// - 模式切换离开 desktop → releaseAll()
// - before-quit → releaseAll()
// 主进程维护生命周期，不完全信任 Renderer 主动通知。

import type { MotionPackManifest } from './motion-pack-types';
import { validateMotionPackManifest, validateMotionPackManifestForCandidateReview } from './motion-pack-types';
import { isCandidateReviewMode, isProductionMode } from './motion-runtime-mode';
import type { MotionCompositionMode } from './pose-composition';

/**
 * 触发模式（来自 future-motion-asset-pipeline.md §7）：
 * - user-only: 用户显式触发（按钮/语音命令）
 * - conversation: ConversationController 根据对话内容触发
 * - idle: 空闲超时自动触发
 */
export type MotionPackTrigger = 'user-only' | 'conversation' | 'idle';

/**
 * 扩展的 MotionPackManifest，包含运行时元数据。
 * trigger 和 allowedStates 由 manifest 提供（可选字段）。
 */
export type RuntimeMotionPackManifest = MotionPackManifest & {
  trigger?: MotionPackTrigger;
  allowedStates?: string[];
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  cooldownSeconds?: number;
  movesRoot?: boolean;
  /**
   * Phase 5.2B.3 Closeout Task 2：动作组合模式。
   * - 'additive-from-base'：内部程序化 VMD pack，叠加在 relaxed base pose 上
   * - 'absolute'：外部 VMD 默认，直接覆盖
   * - undefined：默认 'absolute'（向后兼容）
   *
   * 不允许由 IPC 或 AI 传入，只能由本地注册的 manifest 提供。
   */
  compositionMode?: MotionCompositionMode;
};

/**
 * 注册结果。
 */
export interface RegisterResult {
  success: boolean;
  reason?: string;
  /**
   * 注册模式：production（8 阶段门全通过）或 candidate-review（阶段 1-5 通过，6-8 pending）。
   * 仅在 success=true 时有意义。
   */
  mode?: 'production' | 'candidate-review';
  /**
   * 候选模式下未完成的阶段（pending visual acceptance）。
   * 仅在 mode='candidate-review' 时有意义。
   */
  pendingStages?: string[];
}

/**
 * 事件类型。
 */
export const RegistryEvent = {
  Registered: 'registered',
  Unregistered: 'unregistered',
  ReleaseAll: 'release-all'
} as const;

export type RegistryEventType = typeof RegistryEvent[keyof typeof RegistryEvent];

export interface RegistryEventPayload {
  type: RegistryEventType;
  manifest?: RuntimeMotionPackManifest;
  packId?: string;
  packIds?: string[];
}

export type RegistryEventListener = (event: RegistryEventPayload) => void;

/**
 * MotionPack 白名单注册表。
 * 线程安全假设：Electron 主进程单线程，无需锁。
 *
 * 用户要求（2026-07-19）：
 *   - 生产模式只允许 8 阶段门全通过的 pack 注册
 *   - 候选评审模式（candidate-review）允许阶段 1-5 通过、6-8 待视频验收的 pack 注册
 *   - 候选模式仅测试/本地验收环境启用
 */
export class MotionPackRegistry {
  private readonly packs = new Map<string, RuntimeMotionPackManifest>();
  private readonly listeners = new Set<RegistryEventListener>();
  /**
   * 记录每个已注册 pack 的注册模式（production 或 candidate-review）。
   * 用于运行时加载校验：候选 pack 在生产模式运行时必须被拒绝。
   */
  private readonly packModes = new Map<string, 'production' | 'candidate-review'>();

  /**
   * 注册一个 MotionPack。
   *
   * 行为根据当前运行时模式：
   *   - production: 必须通过完整 8 阶段门
   *   - candidate-review: 阶段 1-5 必须通过；阶段 6-8 允许 pending
   *
   * 注：如果 manifest 通过完整 8 阶段门（生产级别），即使在 candidate-review 模式下
   * 也注册为 'production' 模式（这是为了支持白名单预加载与候选 pack 共存）。
   *
   * 显式 forceProduction=true 可强制生产校验（即使当前是 candidate-review 模式），
   * 用于主进程白名单预加载。
   */
  register(
    manifest: MotionPackManifest | RuntimeMotionPackManifest,
    options?: { forceProduction?: boolean }
  ): RegisterResult {
    const runtime = manifest as RuntimeMotionPackManifest;
    // 重复 packId 检查
    if (this.packs.has(runtime.packId)) {
      return { success: false, reason: `duplicate packId: ${runtime.packId}` };
    }

    // 优先检查 8 阶段门：全通过则注册为 production（即使当前在 candidate-review 模式下）
    const fullValidation = validateMotionPackManifest(runtime);
    if (fullValidation.valid) {
      this.packs.set(runtime.packId, runtime);
      this.packModes.set(runtime.packId, 'production');
      this.emit({ type: RegistryEvent.Registered, manifest: runtime });
      return { success: true, mode: 'production' };
    }

    // 8 阶段门未通过：检查是否在 candidate-review 模式下且阶段 1-5 通过
    const forceProduction = options?.forceProduction === true;
    const useCandidatePath = !forceProduction && isCandidateReviewMode();

    if (useCandidatePath) {
      const candidateValidation = validateMotionPackManifestForCandidateReview(runtime);
      if (!candidateValidation.valid) {
        return {
          success: false,
          reason: `incomplete manifest (candidate-review), missing stages: ${candidateValidation.missing.join(', ')}`
        };
      }
      this.packs.set(runtime.packId, runtime);
      this.packModes.set(runtime.packId, 'candidate-review');
      this.emit({ type: RegistryEvent.Registered, manifest: runtime });
      return {
        success: true,
        mode: 'candidate-review',
        pendingStages: candidateValidation.pending
      };
    }

    // 生产模式：8 阶段门未通过 → 拒绝
    return {
      success: false,
      reason: `incomplete manifest, missing stages: ${fullValidation.missing.join(', ')}`
    };
  }

  /**
   * 查询 packId 的注册模式。
   * 不存在返回 undefined。
   */
  getRegisterMode(packId: string): 'production' | 'candidate-review' | undefined {
    return this.packModes.get(packId);
  }

  /**
   * 列出所有候选模式注册的 pack（pending visual acceptance）。
   */
  listCandidateReviewPacks(): RuntimeMotionPackManifest[] {
    const result: RuntimeMotionPackManifest[] = [];
    for (const [packId, mode] of this.packModes.entries()) {
      if (mode === 'candidate-review') {
        const manifest = this.packs.get(packId);
        if (manifest) result.push(manifest);
      }
    }
    return result;
  }

  /**
   * 列出所有生产模式注册的 pack（8 阶段门全通过）。
   */
  listProductionPacks(): RuntimeMotionPackManifest[] {
    const result: RuntimeMotionPackManifest[] = [];
    for (const [packId, mode] of this.packModes.entries()) {
      if (mode === 'production') {
        const manifest = this.packs.get(packId);
        if (manifest) result.push(manifest);
      }
    }
    return result;
  }

  /**
   * 运行时加载门禁：在当前运行时模式下是否允许加载此 pack。
   *   - production 模式：只允许 production 注册的 pack
   *   - candidate-review 模式：允许 production + candidate-review 注册的 pack
   */
  isLoadable(packId: string): boolean {
    const mode = this.packModes.get(packId);
    if (!mode) return false;
    if (isProductionMode()) {
      return mode === 'production';
    }
    // candidate-review 模式：production 和 candidate-review 都允许
    return true;
  }

  /**
   * 查询 packId 是否已注册。
   */
  has(packId: string): boolean {
    return this.packs.has(packId);
  }

  /**
   * 获取 manifest。不存在返回 undefined。
   */
  get(packId: string): RuntimeMotionPackManifest | undefined {
    return this.packs.get(packId);
  }

  /**
   * 列出所有已注册 manifest。
   */
  list(): RuntimeMotionPackManifest[] {
    return Array.from(this.packs.values());
  }

  /**
   * 按 trigger 模式列出 manifest。
   */
  listByTrigger(trigger: MotionPackTrigger): RuntimeMotionPackManifest[] {
    return this.list().filter(m => (m.trigger ?? 'idle') === trigger);
  }

  /**
   * 移除已注册的 packId。
   * 返回是否成功移除。
   */
  unregister(packId: string): boolean {
    if (!this.packs.has(packId)) return false;
    this.packs.delete(packId);
    this.packModes.delete(packId);
    this.emit({ type: RegistryEvent.Unregistered, packId });
    return true;
  }

  /**
   * 释放所有已注册的 pack。
   * 用于 Avatar crash/close / 模式切换离开 desktop / before-quit。
   * 返回释放的 pack 数量。
   */
  releaseAll(): number {
    const count = this.packs.size;
    const packIds = Array.from(this.packs.keys());
    this.packs.clear();
    this.packModes.clear();
    if (count > 0) {
      this.emit({ type: RegistryEvent.ReleaseAll, packIds });
    }
    return count;
  }

  /**
   * 添加事件监听器。
   */
  addEventListener(listener: RegistryEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * 移除事件监听器。
   */
  removeEventListener(listener: RegistryEventListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: RegistryEventPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.warn('[motion-pack-registry] listener error:', e);
      }
    }
  }
}
