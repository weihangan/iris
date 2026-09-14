// Phase 5.2 Task 5.2.3A: 骨骼仲裁硬门（BoneOwnershipRegistry）
//
// 解决结构性冲突：ProceduralLifeController 每帧从 rest pose 覆盖 頭/上半身/肩，
// 会覆盖 VMD 写入的姿态。引入"骨骼所有权"机制。
//
// 5 项设计修正（用户要求）：
// 1. 显式优先级 + 抢占结果 + lease/token：claim() 返回 lease（含 token），
//    release() 必须验证 token，防止旧动作停止时错误释放新动作的骨骼。
// 2. 不假设 animation.getTrackNames() 存在：通过 extractBoneNames(animation)
//    使用 Object.keys(animation.boneTracks) 提取骨骼名。
// 3. 测试证明 4 个场景：VMD 控制时 ProceduralLifeController 不覆盖 / VMD 停止后恢复 /
//    旧 owner 不能释放新 owner / 模式切换和 stopPerformance 后全部恢复安全 Base Pose。
// 4. 眨眼属于 Morph 所有权，独立于骨骼所有权：MorphOwnershipRegistry 单独管理。
// 5. 正式 Phase 5 审计仍诚实失败：此模块是 Phase 5.2 子阶段审计 audit:phase5.2 的一部分，
//    不降低完整 Phase 5 门禁。

/**
 * 骨骼所有者类型。
 * - none: 无所有者（安全 Base Pose）
 * - procedural: ProceduralLifeController（呼吸/眨眼/视线/倾头）
 * - vmd: VMD 动作播放器
 * - performance-planner: Performance Planner（最高优先级，主动选择动作）
 */
export type BoneOwner = 'none' | 'procedural' | 'vmd' | 'performance-planner';

/**
 * 显式优先级表。数值越大优先级越高。
 * none < procedural < vmd < performance-planner
 */
export const BONE_OWNER_PRIORITY: Record<BoneOwner, number> = {
  none: 0,
  procedural: 1,
  vmd: 2,
  'performance-planner': 3
};

/**
 * 所有权租约。claim() 成功后返回，release() 必须提供有效的 lease（含 token）。
 * token 是不可预测的字符串，防止旧 owner 伪造 lease 释放新 owner 的骨骼。
 */
export interface OwnershipLease {
  readonly boneName: string;
  readonly owner: BoneOwner;
  readonly token: string;
  readonly acquiredAt: number;
}

/**
 * 生成不可预测的 token。
 * 使用 crypto.randomUUID()（Node.js 和浏览器都支持）。
 */
function generateToken(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // fallback：时间戳 + 随机数
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 骨骼所有权注册表。
 * 每个骨骼在任何时刻只有一个所有者，通过优先级和 lease token 管理抢占和释放。
 *
 * 设计原则：
 * - claim() 成功返回 lease（含 token），失败返回 null
 * - 高优先级可以抢占低优先级，返回新 lease
 * - 低优先级不能抢占高优先级，返回 null
 * - release() 必须验证 token，旧 lease 的 token 在抢占后失效
 * - releaseAll() 清空所有 lease（模式切换 / stopPerformance 调用）
 * - canApplyProcedural() 是 ProceduralLifeController 专用查询
 */
export class BoneOwnershipRegistry {
  private readonly owners = new Map<string, { owner: BoneOwner; token: string; acquiredAt: number }>();

  /**
   * 声明骨骼所有权。
   * - 首次 claim（当前 owner 为 none 或相同 owner）：成功，返回新 lease
   * - 高优先级抢占低优先级：成功，返回新 lease（旧 lease 的 token 失效）
   * - 低优先级尝试抢占高优先级：失败，返回 null
   * - 同优先级尝试抢占：失败，返回 null
   * - 相同 owner 重复 claim：失败，返回 null（不允许多 lease）
   */
  claim(boneName: string, owner: BoneOwner): OwnershipLease | null {
    if (owner === 'none') {
      return null; // none 不能 claim，只能通过 release 达到
    }
    const current = this.owners.get(boneName);
    if (current) {
      if (current.owner === owner) {
        // 相同 owner 重复 claim，拒绝
        return null;
      }
      // 检查优先级
      if (BONE_OWNER_PRIORITY[owner] <= BONE_OWNER_PRIORITY[current.owner]) {
        // 优先级不够，不能抢占
        return null;
      }
      // 高优先级抢占低优先级
    }
    const token = generateToken();
    const acquiredAt = Date.now();
    this.owners.set(boneName, { owner, token, acquiredAt });
    return { boneName, owner, token, acquiredAt };
  }

  /**
   * 释放骨骼所有权。
   * 必须提供有效的 lease（含 token）。token 不匹配则释放失败。
   * 这防止旧 owner 在被抢占后错误释放新 owner 的骨骼。
   */
  release(lease: OwnershipLease): boolean {
    const current = this.owners.get(lease.boneName);
    if (!current) {
      // 已经是 none，释放无效
      return false;
    }
    if (current.token !== lease.token) {
      // token 不匹配（lease 已失效，可能被抢占）
      return false;
    }
    if (current.owner !== lease.owner) {
      // owner 不匹配（防御性检查）
      return false;
    }
    this.owners.delete(lease.boneName);
    return true;
  }

  /**
   * 批量释放某个 owner 的所有 lease。
   * 返回释放的骨骼数量。
   */
  releaseAllForOwner(owner: BoneOwner): number {
    let count = 0;
    for (const [boneName, record] of this.owners.entries()) {
      if (record.owner === owner) {
        this.owners.delete(boneName);
        count++;
      }
    }
    return count;
  }

  /**
   * 释放所有 lease（模式切换 / stopPerformance 调用）。
   * 所有骨骼恢复 none（安全 Base Pose）。
   * 返回释放的骨骼数量。
   */
  releaseAll(): number {
    const count = this.owners.size;
    this.owners.clear();
    return count;
  }

  /**
   * 查询骨骼当前所有者。
   * 不存在记录时返回 'none'。
   */
  getOwner(boneName: string): BoneOwner {
    return this.owners.get(boneName)?.owner ?? 'none';
  }

  /**
   * ProceduralLifeController 专用查询：是否可以应用程序化 offset。
   * - owner 为 none 或 procedural 时返回 true
   * - owner 为 vmd 或 performance-planner 时返回 false
   */
  canApplyProcedural(boneName: string): boolean {
    const owner = this.getOwner(boneName);
    return owner === 'none' || owner === 'procedural';
  }
}

/**
 * Morph 所有权注册表。
 * 独立于骨骼所有权，管理 morph 权重（眨眼 まばたき / viseme あいueお / 表情）。
 *
 * 设计原则：
 * - まばたき（眨眼）默认 procedural 持有（ProceduralLifeController 程序化眨眼）
 * - VMD 含 まばたき 轨道时 claim，procedural 让出
 * - VMD 停止时 release，procedural 恢复
 * - viseme（あ/い/う/え/お）LipTimeline 优先级 > VMD morph 轨道
 * - releaseAll 后恢复 procedural 默认（安全 Base Pose）
 */
export class MorphOwnershipRegistry {
  private readonly owners = new Map<string, { owner: BoneOwner; token: string; acquiredAt: number }>();

  /**
   * 获取 morph 当前所有者。
   * 不存在记录时返回 'procedural'（morph 默认 procedural 持有，与骨骼默认 none 不同）。
   */
  getOwner(morphName: string): BoneOwner {
    return this.owners.get(morphName)?.owner ?? 'procedural';
  }

  /**
   * 声明 morph 所有权。语义同 BoneOwnershipRegistry.claim()。
   * 但默认 owner 是 procedural（而不是 none）。
   */
  claim(morphName: string, owner: BoneOwner): OwnershipLease | null {
    if (owner === 'none') {
      return null;
    }
    const current = this.owners.get(morphName);
    const currentOwner = current?.owner ?? 'procedural';
    if (currentOwner === owner) {
      return null; // 相同 owner 重复 claim
    }
    if (BONE_OWNER_PRIORITY[owner] <= BONE_OWNER_PRIORITY[currentOwner]) {
      return null; // 优先级不够
    }
    const token = generateToken();
    const acquiredAt = Date.now();
    this.owners.set(morphName, { owner, token, acquiredAt });
    return { boneName: morphName, owner, token, acquiredAt };
  }

  /**
   * 释放 morph 所有权。释放后恢复 procedural 默认。
   */
  release(lease: OwnershipLease): boolean {
    const current = this.owners.get(lease.boneName);
    if (!current) {
      return false;
    }
    if (current.token !== lease.token || current.owner !== lease.owner) {
      return false;
    }
    this.owners.delete(lease.boneName);
    return true; // 恢复 procedural 默认
  }

  /**
   * 释放所有 morph lease。恢复 procedural 默认。
   */
  releaseAll(): number {
    const count = this.owners.size;
    this.owners.clear();
    return count;
  }

  /**
   * ProceduralLifeController 专用查询：是否可以应用程序化 morph（如眨眼）。
   * - owner 为 procedural 时返回 true
   * - owner 为 vmd 或 performance-planner 时返回 false
   */
  canApplyProcedural(morphName: string): boolean {
    return this.getOwner(morphName) === 'procedural';
  }
}

/**
 * 从 MmdAnimation 提取骨骼名（不假设 getTrackNames() 存在）。
 * 使用 Object.keys(animation.boneTracks) 提取。
 */
export function extractBoneNamesFromAnimation(animation: { boneTracks: Record<string, unknown> }): string[] {
  return Object.keys(animation.boneTracks);
}

/**
 * 从 MmdAnimation 提取 morph 名。
 */
export function extractMorphNamesFromAnimation(animation: { morphTracks: Record<string, unknown> }): string[] {
  return Object.keys(animation.morphTracks);
}
