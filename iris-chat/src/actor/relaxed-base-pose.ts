// Phase 5.2B.1 Task 2: 赛琳娜放松基础姿态（2026-07-20）
//
// 用户要求：
// - 建立共享的、安全的放松上半身姿态层
// - 优先采用程序化低优先级基础姿态，使 idle/VMD gesture 可以通过 BoneOwnershipRegistry 抢占
// - 停止后自动恢复
// - 不要在三个 idle 中复制三套相互漂移的姿态常量
// - 候选骨骼：左肩、右肩、左腕、右腕、左ひじ、右ひじ、左手首、右手首
// - 不驱动 全ての親、センター、腰、下半身、腿、足 IK
// - 左右手臂应自然下垂，保留轻微不对称，避免完全镜像
// - 手腕和肘部只做很小的自然弯曲
// - 所有具体角度必须在真实赛琳娜 PMX 上逐步校准，禁止凭通用骨架一次写死
//
// 设计：
// - RelaxedBasePoseOffsets：相对于 PMX rest pose 的 euler XYZ offset（弧度）
// - DEFAULT_RELAXED_POSE_OFFSETS：初始校准值（基于 MMD 标准骨架常识）
//   必须在真实赛琳娜 PMX 上逐步校准；通过自定义 offsets 参数覆盖
// - RelaxedBasePoseController：
//   - constructor 保存 PMX rest pose
//   - apply() 每帧从 rest pose × offset quaternion
//   - 通过 BoneOwnershipRegistry.canApplyProcedural 检查
//   - VMD/performance-planner 持有时跳过
//   - lease 释放后自动恢复放松姿态（不闪回 PMX 原始 T Pose）
// - 不集成到 ProceduralLifeController（LifeBones 已不含手臂骨骼）
//   由独立的 controller 在每帧动画循环中调用 apply()

import * as THREE from 'three';
import type { BoneOwnershipRegistry } from './bone-ownership-registry';

/**
 * 放松基础姿态的骨骼偏移（相对于 PMX rest pose 的 euler XYZ offset，弧度）。
 *
 * 设计原则：
 * - 只驱动手臂骨骼：左肩、右肩、左腕、右腕、左ひじ、右ひじ、左手首、右手首
 * - 不驱动 全ての親、センター、腰、下半身、腿、足 IK
 * - 左右手臂轻微不对称（避免完全镜像）
 * - 偏移幅度小（< 0.15 rad ≈ 8.6°），避免穿模
 *
 * 校准状态（2026-07-20 Phase 5.2B.1）：
 * - 初始值基于 MMD 标准骨架常识（手臂自然下垂 + 轻微弯曲）
 * - 必须在真实赛琳娜 PMX 上逐步校准
 * - 通过 RelaxedBasePoseController constructor 的 offsets 参数覆盖
 * - 校准流程：运行时调整 offset → 视觉验收 → 写入新的默认值
 */
export interface RelaxedBasePoseOffsets {
  /** 左肩：轻微下沉（Z 轴旋转，让肩膀不那么架） */
  readonly leftShoulder: readonly [number, number, number];
  /** 右肩：镜像 + 不对称 */
  readonly rightShoulder: readonly [number, number, number];
  /** 左腕：自然下垂（Z 轴旋转，让手臂贴近身体） */
  readonly leftArm: readonly [number, number, number];
  /** 右腕：镜像 + 不对称 */
  readonly rightArm: readonly [number, number, number];
  /** 左ひじ：轻微弯曲（Y 轴旋转，让前臂略微前伸） */
  readonly leftElbow: readonly [number, number, number];
  /** 右ひじ：镜像 + 不对称 */
  readonly rightElbow: readonly [number, number, number];
  /** 左手首：自然放松（Z 轴轻微旋转，避免手腕僵直） */
  readonly leftWrist: readonly [number, number, number];
  /** 右手首：镜像 + 不对称 */
  readonly rightWrist: readonly [number, number, number];
}

/**
 * 初始校准值（基于 MMD 标准骨架，2026-07-23 ChatX2 修正）。
 *
 * MMD 坐标系（关键修正）：
 * - 左腕 Z 轴：负値 = 向身体内侧收（下垂），正値 = 向外侧展（张开）
 * - 右腕 Z 轴：正値 = 向身体内侧收（下垂），负値 = 向外侧展（张开）
 * - 肩膀 Z 轴：左肩正値 = 下沉，右肩负値 = 下沉
 * - 肘部 Y 轴：左肘负値 = 前伸，右肘正値 = 前伸
 * - 手腕 Z 轴：轻微旋转避免僵直
 *
 * 之前版本 Z 方向写反导致手臂张开，已修正。
 *
 * 不对称设计：
 * - 右臂内收略多于左臂（右撇子习惯）
 * - 右肘弯曲略多于左肘
 */
export const DEFAULT_RELAXED_POSE_OFFSETS: RelaxedBasePoseOffsets = {
  // 肩膀：轻微下沉（加大幅度让肩膀更自然）
  leftShoulder: [0, 0, 0.05],      // ~2.9°（原 0.03）
  rightShoulder: [0, 0, -0.06],    // ~-3.4°（原 -0.04）

  // 上臂：自然下垂（Z 轴内收，加大幅度让手臂真正贴近身体）
  // ChatX2 修正（2026-07-25）：进一步加大内收幅度，解决说话时手臂张开问题
  leftArm: [0, 0, -0.35],          // ~-20°（原 -0.28）
  rightArm: [0, 0, 0.38],          // ~21.8°（原 0.30）

  // 肘部：自然弯曲（Y 轴前伸，加大弯曲让手臂更自然）
  // ChatX2 校准（2026-07-25）：加大弯曲角度
  leftElbow: [0, -0.20, 0],        // ~-11.5°（原 -0.15）
  rightElbow: [0, 0.22, 0],        // ~12.6°（原 0.18）

  // 手腕：自然放松（Z 轴轻微旋转避免僵直）
  leftWrist: [0, 0, -0.08],        // ~-4.6°（原 -0.05）
  rightWrist: [0, 0, 0.09]         // ~5.1°（原 0.06）
};

/**
 * 放松基础姿态所需的骨骼。缺失的骨骼会被跳过（不抛错）。
 */
export interface RelaxedBasePoseBones {
  leftShoulder?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  leftArm?: THREE.Bone;
  rightArm?: THREE.Bone;
  leftElbow?: THREE.Bone;
  rightElbow?: THREE.Bone;
  leftWrist?: THREE.Bone;
  rightWrist?: THREE.Bone;
}

/**
 * 骨骼名常量（用于 ownership 注册和查询）。
 */
const MANAGED_BONE_NAMES = [
  '左肩', '右肩',
  '左腕', '右腕',
  '左ひじ', '右ひじ',
  '左手首', '右手首'
] as const;

/**
 * 骨骼配置条目：骨骼名 + offset。
 */
interface BoneConfigEntry {
  readonly boneName: string;
  readonly bone: THREE.Bone | undefined;
  readonly offset: readonly [number, number, number];
}

/**
 * 程序化放松基础姿态控制器。
 *
 * 职责：
 * - 每帧从 PMX rest pose × offset quaternion 应用放松姿态
 * - 通过 BoneOwnershipRegistry 检查每根骨骼是否允许 procedural 写入
 * - VMD/performance-planner 持有的骨骼跳过（不覆盖）
 * - lease 释放后自动恢复放松姿态（不闪回 PMX 原始 T Pose）
 *
 * 使用方式：
 * - 在桌面模式动画循环中每帧调用 apply()
 * - 模式切换/cleanup 时调用 reset() 恢复 PMX rest pose
 * - 不与 ProceduralLifeController 冲突（LifeBones 已不含手臂骨骼）
 *
 * 与 MotionPlayer 的协作：
 * - MotionPlayer.play() claim 手臂骨骼后，apply() 跳过这些骨骼
 * - MotionPlayer.stop() release lease 后，apply() 自动恢复放松姿态
 * - MotionPlayer fade-out 期间 lease 仍持有，apply() 跳过
 * - fade-out 完成后 lease 释放，apply() 恢复放松姿态
 */
export class RelaxedBasePoseController {
  /** PMX rest pose 快照（constructor 时保存） */
  private readonly restQuaternions = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly restPositions = new Map<THREE.Bone, THREE.Vector3>();
  /** 骨骼 → 骨骼名映射（用于 ownership 查询） */
  private readonly boneToName = new Map<THREE.Bone, string>();
  /** 骨骼配置条目（apply 时遍历） */
  private readonly entries: BoneConfigEntry[] = [];
  private readonly offsets: RelaxedBasePoseOffsets;
  private readonly boneOwnership?: BoneOwnershipRegistry;
  /**
   * 物理引擎启用时，跳过对左肩/右肩的写入。
   * 这些骨骼是 Bullet 碰撞体，在物理后修改会导致碰撞体与画面错位。
   */
  private physicsEnabled = false;

  constructor(
    bones: RelaxedBasePoseBones,
    options?: {
      offsets?: RelaxedBasePoseOffsets;
      boneOwnership?: BoneOwnershipRegistry;
      physicsEnabled?: boolean;
    }
  ) {
    this.offsets = options?.offsets ?? DEFAULT_RELAXED_POSE_OFFSETS;
    this.boneOwnership = options?.boneOwnership;
    this.physicsEnabled = options?.physicsEnabled ?? false;

    // 构建配置条目（骨骼名 + 骨骼对象 + offset）
    const config: BoneConfigEntry[] = [
      { boneName: '左肩', bone: bones.leftShoulder, offset: this.offsets.leftShoulder },
      { boneName: '右肩', bone: bones.rightShoulder, offset: this.offsets.rightShoulder },
      { boneName: '左腕', bone: bones.leftArm, offset: this.offsets.leftArm },
      { boneName: '右腕', bone: bones.rightArm, offset: this.offsets.rightArm },
      { boneName: '左ひじ', bone: bones.leftElbow, offset: this.offsets.leftElbow },
      { boneName: '右ひじ', bone: bones.rightElbow, offset: this.offsets.rightElbow },
      { boneName: '左手首', bone: bones.leftWrist, offset: this.offsets.leftWrist },
      { boneName: '右手首', bone: bones.rightWrist, offset: this.offsets.rightWrist }
    ];

    // 只保存存在的骨骼
    for (const entry of config) {
      if (entry.bone) {
        this.restQuaternions.set(entry.bone, entry.bone.quaternion.clone());
        this.restPositions.set(entry.bone, entry.bone.position.clone());
        this.boneToName.set(entry.bone, entry.boneName);
        this.entries.push(entry);
      }
    }
  }

  /**
   * 每帧调用：应用放松基础姿态。
   *
   * - 从 PMX rest pose 开始（避免累积漂移）
   * - 乘以 offset quaternion 得到放松姿态
   * - 通过 BoneOwnershipRegistry 检查每根骨骼
   * - VMD/performance-planner 持有的骨骼跳过
   *
   * 不依赖 elapsed time（放松姿态是静态的，不随时间变化）。
   * 呼吸/摇摆由 ProceduralLifeController 单独处理（上半身/頭/肩）。
   */
  apply(): void {
    // Bullet 已基于本帧骨骼姿态完成碰撞求解后，不能再修改任何带碰撞体的
    // 手臂链。否则画面骨骼与刚体世界错一帧，长发会穿过肩臂。
    if (this.physicsEnabled) return;

    for (const entry of this.entries) {
      const { bone, offset, boneName } = entry;
      if (!bone) continue;

      // 通过 ownership 检查是否允许 procedural 写入
      if (!this.canApplyBone(boneName)) continue;

      const rest = this.restQuaternions.get(bone);
      if (!rest) continue;

      // rest pose × offset quaternion
      const offsetQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(offset[0], offset[1], offset[2], 'XYZ')
      );
      bone.quaternion.copy(rest).multiply(offsetQuat);
    }
  }

  /**
   * 恢复所有管理的手臂骨骼到 PMX 原始 rest pose。
   *
   * 使用场景：
   * - 模式切换（desktop → chat）
   * - cleanup
   * - 紧急停止
   *
   * 注意：reset 不查 ownership（由调用方确保安全）。
   */
  reset(): void {
    for (const [bone, rest] of this.restQuaternions) {
      bone.quaternion.copy(rest);
    }
  }

  /**
   * 设置物理引擎启用状态。启用时不再进行任何 post-physics 手臂写入。
   */
  setPhysicsEnabled(enabled: boolean): void {
    this.physicsEnabled = enabled;
  }

  /**
   * 返回此 controller 管理的骨骼名列表。
   * 用于 ownership 注册和 E2E 验证。
   */
  getManagedBoneNames(): string[] {
    return [...MANAGED_BONE_NAMES];
  }

  /**
   * Phase 5.2B.3 Closeout Task 3：返回某块骨骼的 base pose 快照（rest * offset）。
   *
   * 用于 additive-from-base 模式的 base pose 参考。
   * 返回的是副本（不共享内部引用），调用方可安全使用。
   *
   * @param boneName 骨骼名（日文 MMD 标准名）
   * @returns {quaternion, position} 副本，或 undefined（未管理该骨骼）
   */
  getBasePoseSnapshot(boneName: string): {
    quaternion: [number, number, number, number];
    position: [number, number, number];
  } | undefined {
    // 找到对应 entry
    const entry = this.entries.find(e => e.boneName === boneName);
    if (!entry || !entry.bone) return undefined;
    const rest = this.restQuaternions.get(entry.bone);
    const restPosition = this.restPositions.get(entry.bone);
    if (!rest || !restPosition) return undefined;

    // 计算 base = rest * offset
    const offsetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(entry.offset[0], entry.offset[1], entry.offset[2], 'XYZ')
    );
    const baseQ = rest.clone().multiply(offsetQuat);

    return {
      quaternion: [baseQ.x, baseQ.y, baseQ.z, baseQ.w],
      position: [restPosition.x, restPosition.y, restPosition.z]
    };
  }

  /**
   * 检查骨骼是否允许 procedural 写入。
   * - 无 registry 时返回 true（向后兼容）
   * - owner 为 none 或 procedural 时返回 true
   * - owner 为 vmd 或 performance-planner 时返回 false
   */
  private canApplyBone(boneName: string): boolean {
    if (!this.boneOwnership) return true;
    return this.boneOwnership.canApplyProcedural(boneName);
  }
}
