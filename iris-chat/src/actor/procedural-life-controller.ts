// Task 6 Step 3: 低幅度生命层
// 职责：眨眼、呼吸、视线和头肩小动作，让模型在无语音时也有"活着"的感觉
//
// 设计原则：
// - 低幅度：单帧偏移 < 0.05 弧度（约 2.9 度），避免夸张
// - 从 rest pose 开始：每帧 copy(rest) 再 apply offset，避免累积漂移
// - speaking 时降低幅度（amplitude 0.7），避免说话时动作干扰
// - 只动头/上半身/肩，不动腿/手指/裙摆/根节点，避免脚滑、穿模、漂移
// - 眨眼通过 MorphController 写入，遵守 fail-closed（未知 morph 抛错）
//
// Phase 5.2B 修正：
// - 接入 BoneOwnershipRegistry：VMD claim 骨骼時，procedural 不覆盖
// - 接入 MorphOwnershipRegistry：VMD 含まばたき轨道時，procedural 不写眨眼
// - LifeBones 扩展：增加 腰/下半身/全ての親（VMD idle-shift-weight 需要观察）
//   注意：procedural 仍只写 頭/上半身/左肩/右肩，新骨骼只保存 rest pose 供 reset
//   真正的程序化腰部动画留给后续 Phase

import * as THREE from 'three';
import type { MorphController } from './morph-controller';

type ProceduralMorphPort = Pick<MorphController, 'setWeight'>;
import type { BoneOwnershipRegistry, MorphOwnershipRegistry } from './bone-ownership-registry';

export type LifeState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type BreathPhase = 'quiet' | 'inhale' | 'pause' | 'exhale';

export interface IdleBreathOverlayState {
  arbiterMode: string;
  motionPlaying: boolean;
  speakingMotion: boolean;
  inertializing: boolean;
}

export function shouldOverlayIdleBreathing(state: IdleBreathOverlayState): boolean {
  return state.arbiterMode === 'idle'
    && state.motionPlaying
    && !state.speakingMotion
    && !state.inertializing;
}

/**
 * 生命层所需的骨骼。缺失的骨骼会被跳过（不抛错）。
 * Phase 5.2B 扩展：增加 腰/下半身/全ての親 用于 VMD idle-shift-weight 观察。
 * procedural 只写 頭/上半身/左肩/右肩；扩展骨骼只保存 rest pose 供 reset。
 */
export interface LifeBones {
  head?: THREE.Bone;
  upperBody?: THREE.Bone;
  leftShoulder?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  /** Phase 5.2B：腰骨骼（idle-shift-weight 观察） */
  waist?: THREE.Bone;
  /** Phase 5.2B：下半身骨骼（idle-shift-weight 观察） */
  lowerBody?: THREE.Bone;
  /** Phase 5.2B：全ての親（根骨骼，idle-shift-weight 观察） */
  root?: THREE.Bone;
}

const BLINK_DURATION = 0.16; // 眨眼时长（秒）
const BLINK_INTERVAL_BASE = 3.2; // 眨眼间隔基数
const BLINK_INTERVAL_VARIANCE = 1.1; // 眨眼间隔变化幅度
const BREATH_QUIET_LEAD_SECONDS = 3.5;
const BREATH_INHALE_SECONDS = 0.9;
const BREATH_PAUSE_SECONDS = 0.15;
const BREATH_EXHALE_SECONDS = 1.5;
const BREATH_QUIET_TAIL_SECONDS = 4;
const BREATH_CYCLE_SECONDS = BREATH_QUIET_LEAD_SECONDS
  + BREATH_INHALE_SECONDS
  + BREATH_PAUSE_SECONDS
  + BREATH_EXHALE_SECONDS
  + BREATH_QUIET_TAIL_SECONDS;

/**
 * 程序化生命层：眨眼、呼吸、头肩小动作。
 *
 * 第一版只操作 head、upperBody、leftShoulder、rightShoulder 和 blink morph。
 * 不动腿、手指、裙摆和根节点，避免脚滑、手穿模和模型漂移。
 *
 * Phase 5.2B：接入 BoneOwnershipRegistry + MorphOwnershipRegistry
 * - 每帧写骨骼前查询 boneRegistry.canApplyProcedural(boneName)
 * - 每帧写眨眼前查询 morphRegistry.canApplyProcedural('まばたき')
 * - VMD claim 骨骼/morph 后，procedural 跳过，不覆盖 VMD 写入
 */
export class ProceduralLifeController {
  private state: LifeState = 'idle';
  private nextBlinkAt = 3.8; // 启动后 3.8 秒第一次眨眼
  private readonly rest = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly restPosition = new Map<THREE.Bone, THREE.Vector3>();
  private readonly boneToName = new Map<THREE.Bone, string>();
  private readonly boneOwnership?: BoneOwnershipRegistry;
  private readonly morphOwnership?: MorphOwnershipRegistry;
  /**
   * Managed bones：由外部 controller（如 RelaxedBasePoseController）每帧重置为 base pose。
   * ProceduralLifeController 对这些骨骼使用 multiply-on-top（不 copy rest），保留 base pose。
   * 非 managed bones 仍使用 copy(rest)+multiply（每帧自重置避免漂移）。
   */
  private readonly managedBoneNames: Set<string>;
  /**
   * 物理引擎启用时，跳过对头/颈/肩/上半身的写入。
   * 这些骨骼是 Bullet 物理的碰撞体，在物理后修改会导致碰撞体与画面错位。
   */
  private physicsEnabled = false;
  private bodyMotionSuppressed = false;
  private bodyMotionWeight = 1;
  private breathPhase: BreathPhase = 'quiet';

  constructor(
    private readonly bones: LifeBones,
    private readonly morphs: ProceduralMorphPort,
    private readonly blinkName: string,
    options?: {
      boneOwnership?: BoneOwnershipRegistry;
      morphOwnership?: MorphOwnershipRegistry;
      /**
       * Phase 5.2B.3 Closeout Task 4：声明由外部 controller 每帧重置的骨骼名。
       * 这些骨骼在 applyOffset 中使用 multiply-on-top，不覆盖 base pose。
       */
      managedBoneNames?: readonly string[];
      /**
       * 物理引擎是否启用。启用时跳过对头/颈/肩/上半身的写入。
       */
      physicsEnabled?: boolean;
    }
  ) {
    this.boneOwnership = options?.boneOwnership;
    this.morphOwnership = options?.morphOwnership;
    this.managedBoneNames = new Set(options?.managedBoneNames ?? []);
    this.physicsEnabled = options?.physicsEnabled ?? false;

    // 构建 bone → name 映射并保存 rest pose（quaternion + position）
    // 显式列出骨骼名，避免依赖 Object.keys(bones) 的字符串顺序
    const boneEntries: ReadonlyArray<readonly [string, THREE.Bone | undefined]> = [
      ['頭', bones.head],
      ['上半身', bones.upperBody],
      ['左肩', bones.leftShoulder],
      ['右肩', bones.rightShoulder],
      ['腰', bones.waist],
      ['下半身', bones.lowerBody],
      ['全ての親', bones.root]
    ];
    for (const [name, bone] of boneEntries) {
      if (bone) {
        this.boneToName.set(bone, name);
        this.rest.set(bone, bone.quaternion.clone());
        this.restPosition.set(bone, bone.position.clone());
      }
    }
  }

  /**
   * 设置生命状态。speaking 时降低幅度。
   */
  setState(state: LifeState): void {
    this.state = state;
  }

  /** 返回当前生命状态。 */
  getState(): LifeState {
    return this.state;
  }

  /**
   * 设置物理引擎启用状态。启用时跳过对头/颈/肩/上半身的写入。
   */
  setPhysicsEnabled(enabled: boolean): void {
    this.physicsEnabled = enabled;
  }

  /**
   * VMD 播放时抑制所有程序化呼吸/摇摆。
   * 当 VMD 控制手臂骨骼但不控制上半身时，上半身的呼吸会通过骨骼层级
   * 传播到手臂，导致 VMD 手势与呼吸摇摆冲突（手部抽搐/上下摆动）。
   *
   * 原理：VMD 播放时设置 suppressed=true，所有程序化偏移被跳过，
   * 仅保留 VMD 控制的骨骼姿态。VMD 停止后恢复 suppressed=false。
   */
  private suppressed = false;
  private poseLocked = false;

  setSuppressed(value: boolean): void {
    this.suppressed = value;
  }

  setPoseLocked(value: boolean): void {
    this.poseLocked = value;
  }

  /** Suppresses only generated breathing while a body transition settles. */
  setBodyMotionSuppressed(value: boolean): void {
    this.bodyMotionSuppressed = value;
  }

  getBreathPhase(): BreathPhase {
    return this.breathPhase;
  }

  /**
   * 每帧更新：呼吸、头肩小动作、眨眼。
   * 每帧从 rest pose 开始应用 offset，避免累积漂移。
   *
   * Phase 5.2B：通过 BoneOwnershipRegistry 检查每根骨骼是否允许 procedural 写入。
   * 如果 VMD 或 performance-planner 已 claim 该骨骼，procedural 跳过（不覆盖）。
   */
  update(elapsed: number, delta: number): void {
    // 2026-07-29 关键修复（用户反馈"模型完全动不了"）：
    // 之前 suppressed 被 idle VMD 错误地置为 true（getCurrentTimeSource 在某些边界情况返回错误值），
    // 导致呼吸完全不写。现在仅在明确 speaking VMD（performance-clock 且 arbiter.mode==='speech'）
    // 时才抑制，并通过 suppress() / unsuppress() 显式控制。
    // 这里我们**不主动抑制**，留给调用方决定（更安全）。
    // speaking 时降低幅度（0.7），避免说话时动作干扰
    const amplitude = this.state === 'speaking' ? 0.7 : 1;

    // 呼吸是带静止间隔的胸腔事件，不是永久正弦或身体摇摆。
    // 仅允许上半身 X 轴起伏；头、肩、手臂、根、中心、腰、下半身、腿和脚均不写入。
    const safeDelta = Math.max(0, Number.isFinite(delta) ? delta : 0);
    this.bodyMotionWeight = THREE.MathUtils.damp(
      this.bodyMotionWeight,
      this.bodyMotionSuppressed ? 0 : 1,
      12,
      safeDelta
    );
    const breathMag = this.physicsEnabled ? 0.012 : 0.02;
    const breath = this.getBreathEnvelope(elapsed) * breathMag * amplitude * this.bodyMotionWeight;

    if (!this.suppressed && this.poseLocked && this.bones.upperBody) {
      // The frozen VMD is sampled again before every life update, so this
      // multiplication is a non-accumulating breathing overlay on the locked pose.
      this.applyOffsetOnCurrent(this.bones.upperBody, breath, 0, 0);
    } else if (!this.suppressed && this.canApplyBone('上半身')) {
      this.applyOffset(this.bones.upperBody, breath, 0, 0);
    }

    // 眨眼：phase in [0, BLINK_DURATION] 时设置权重
    // Phase 5.2B：通过 MorphOwnershipRegistry 检查 まばたき 是否允许 procedural 写入
    if (this.poseLocked || this.canApplyMorph(this.blinkName)) {
      const blinkPhase = elapsed - this.nextBlinkAt;
      if (blinkPhase >= 0 && blinkPhase <= BLINK_DURATION) {
        // 三角形权重：0 → 1 → 0，峰值在 phase = BLINK_DURATION/2
        const normalized = blinkPhase / BLINK_DURATION;
        const weight = normalized < 0.5
          ? normalized * 2
          : (1 - normalized) * 2;
        this.morphs.setWeight(this.blinkName, weight);
      } else if (blinkPhase > BLINK_DURATION) {
        // 眨眼结束，清零并安排下次眨眼
        this.morphs.setWeight(this.blinkName, 0);
        // 下次眨眼间隔：3.2 + (sin+1)*1.1，范围 [3.2, 5.4] 秒
        this.nextBlinkAt = elapsed + BLINK_INTERVAL_BASE + (Math.sin(elapsed) + 1) * BLINK_INTERVAL_VARIANCE;
      }
    }
  }

  /**
   * 重置：恢复所有骨骼到 rest pose（quaternion + position），清零 blink morph。
   * Phase 5.2B：reset 不查 ownership（由调用方确保安全，如 clearAnimation 后）。
   */
  reset(): void {
    for (const [bone, rest] of this.rest) {
      bone.quaternion.copy(rest);
    }
    for (const [bone, restPos] of this.restPosition) {
      bone.position.copy(restPos);
    }
    if (this.canApplyMorph(this.blinkName)) {
      this.morphs.setWeight(this.blinkName, 0);
    }
    this.nextBlinkAt = 3.8;
    this.state = 'idle';
  }

  /**
   * 检查骨骼是否允许 procedural 写入。
   * 无 registry 时返回 true（向后兼容 Phase 3 行为）。
   */
  private canApplyBone(boneName: string): boolean {
    if (!this.boneOwnership) return true;
    return this.boneOwnership.canApplyProcedural(boneName);
  }

  /**
   * 检查 morph 是否允许 procedural 写入。
   * 无 registry 时返回 true（向后兼容 Phase 3 行为）。
   */
  private canApplyMorph(morphName: string): boolean {
    if (!this.morphOwnership) return true;
    return this.morphOwnership.canApplyProcedural(morphName);
  }

  private getBreathEnvelope(elapsed: number): number {
    const time = ((Math.max(0, elapsed) % BREATH_CYCLE_SECONDS) + BREATH_CYCLE_SECONDS) % BREATH_CYCLE_SECONDS;
    if (time < BREATH_QUIET_LEAD_SECONDS) {
      this.breathPhase = 'quiet';
      return 0;
    }
    const inhaleEnd = BREATH_QUIET_LEAD_SECONDS + BREATH_INHALE_SECONDS;
    if (time < inhaleEnd) {
      this.breathPhase = 'inhale';
      return THREE.MathUtils.smoothstep((time - BREATH_QUIET_LEAD_SECONDS) / BREATH_INHALE_SECONDS, 0, 1);
    }
    const pauseEnd = inhaleEnd + BREATH_PAUSE_SECONDS;
    if (time < pauseEnd) {
      this.breathPhase = 'pause';
      return 1;
    }
    const exhaleEnd = pauseEnd + BREATH_EXHALE_SECONDS;
    if (time < exhaleEnd) {
      this.breathPhase = 'exhale';
      return 1 - THREE.MathUtils.smoothstep((time - pauseEnd) / BREATH_EXHALE_SECONDS, 0, 1);
    }
    this.breathPhase = 'quiet';
    return 0;
  }

  /**
   * 对骨骼应用欧拉角偏移。
   *
   * Phase 5.2B.3 Closeout Task 4 修正：
   * - managed bones（如 左肩/右肩）：使用 multiply-on-top，保留 RelaxedBasePoseController
   *   写入的 base pose。依赖外部 controller 每帧重置 base pose 避免漂移。
   * - 非 managed bones（如 頭/上半身）：使用 copy(rest)+multiply，每帧自重置避免漂移。
   *   这些骨骼没有外部 controller 重置，必须自己从 rest pose 开始。
   */
  private applyOffset(
    bone: THREE.Bone | undefined,
    x: number,
    y: number,
    z: number
  ): void {
    if (!bone) return;
    const offsetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(x, y, z, 'XYZ')
    );
    const boneName = this.boneToName.get(bone);
    if (boneName && this.managedBoneNames.has(boneName)) {
      // managed bone：multiply on top，保留 base pose
      bone.quaternion.multiply(offsetQuat);
      return;
    }
    // 非 managed bone：copy(rest)+multiply，每帧自重置避免漂移
    const base = this.rest.get(bone);
    if (!base) return;
    bone.quaternion.copy(base).multiply(offsetQuat);
  }

  private applyOffsetOnCurrent(bone: THREE.Bone, x: number, y: number, z: number): void {
    bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')));
  }
}
