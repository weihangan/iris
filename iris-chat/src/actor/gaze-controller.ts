import * as THREE from 'three';
import type { BoneOwnershipRegistry } from './bone-ownership-registry';

export interface GazeBones {
  readonly bothEyes?: THREE.Bone;
  readonly leftEye?: THREE.Bone;
  readonly rightEye?: THREE.Bone;
  readonly head?: THREE.Bone;
  readonly neck?: THREE.Bone;
}

export interface GazeTarget {
  readonly yaw: number;
  readonly pitch: number;
}

export class GazeController {
  private target: GazeTarget = { yaw: 0, pitch: 0 };
  private eye: GazeTarget = { yaw: 0, pitch: 0 };
  private head: GazeTarget = { yaw: 0, pitch: 0 };
  private readonly rest = new Map<THREE.Bone, THREE.Quaternion>();

  private speaking = false;
  private physicsEnabled = false;
  private speakingElapsed = 0;
  private baseSemanticTarget: GazeTarget = { yaw: 0, pitch: 0 };
  private focusTarget: GazeTarget = { yaw: 0, pitch: 0 };
  private speakingSemantic = 'neutral';
  private focusLocked = false;

  constructor(
    private readonly bones: GazeBones,
    private readonly ownership?: BoneOwnershipRegistry
  ) {
    for (const bone of [bones.bothEyes, bones.leftEye, bones.rightEye, bones.head, bones.neck]) {
      if (bone) this.rest.set(bone, bone.quaternion.clone());
    }
  }

  /** 进入说话模式：启动动态眼神扫视 */
  startSpeaking(): void {
    this.speaking = true;
    this.speakingElapsed = 0;
  }

  /** 退出说话模式：回到基准视线 */
  stopSpeaking(): void {
    this.speaking = false;
    this.speakingElapsed = 0;
    this.speakingSemantic = 'neutral';
    this.baseSemanticTarget = { ...this.focusTarget };
    this.target = { ...this.focusTarget };
  }

  /**
   * Bullet 开启时，头和颈必须在物理求解前确定。当前控制器运行在
   * post-physics 生命层，因此只能继续驱动不参与碰撞的眼球。
   */
  setPhysicsEnabled(enabled: boolean): void {
    this.physicsEnabled = enabled;
  }

  setTarget(yaw: number, pitch: number): GazeTarget {
    this.baseSemanticTarget = {
      yaw: Math.min(0.28, Math.max(-0.28, Number.isFinite(yaw) ? yaw : 0)),
      pitch: Math.min(0.14, Math.max(-0.14, Number.isFinite(pitch) ? pitch : 0))
    };
    this.target = { ...this.baseSemanticTarget };
    return { ...this.target };
  }

  setSemanticTarget(semantic: string): GazeTarget {
    switch (semantic) {
      case 'thinking':
      case 'shy':
      case 'skeptical':
      case 'embarrassed': return this.setTarget(0.19, 0.12);
      case 'concerned':
      case 'heartbroken': return this.setTarget(-0.15, 0.09);
      case 'happy':
      case 'smile':
      case 'delighted': return this.setTarget(0, -0.03); // 开心时微微低头（眼角变化）
      case 'surprised':
      case 'shocked': return this.setTarget(0, -0.1);
      case 'angry':
      case 'furious': return this.setTarget(0, 0.02);
      default: return this.setTarget(0, 0);
    }
  }

  /** Keep the user focus point authoritative; semantics shape only glance events. */
  setSpeakingSemantic(semantic: string): GazeTarget {
    this.speakingSemantic = String(semantic || 'neutral').toLowerCase();
    this.baseSemanticTarget = { ...this.focusTarget };
    this.target = { ...this.focusTarget };
    return { ...this.focusTarget };
  }

  getFocusTarget(): GazeTarget {
    return { ...this.focusTarget };
  }

  setFocusLocked(locked: boolean): void {
    this.focusLocked = Boolean(locked);
    if (this.focusLocked) {
      this.baseSemanticTarget = { ...this.focusTarget };
      this.target = { ...this.focusTarget };
    }
  }

  isFocusLocked(): boolean {
    return this.focusLocked;
  }

  /**
   * 让眼神看向屏幕中心，模拟注视电脑使用者。
   * 根据模型当前在屏幕上的位置与屏幕中心的偏移，计算 yaw/pitch。
   * 模型在屏幕右下方时，会自然向左上方看。
   */
  setScreenCenterTarget(
    modelScreenX: number,
    modelScreenY: number,
    screenCenterX: number,
    screenCenterY: number,
    bodyYaw = 0
  ): GazeTarget {
    const dx = screenCenterX - modelScreenX;
    const dy = screenCenterY - modelScreenY;
    // 以半屏为基准归一化，中心在模型左侧时 dx<0 => yaw<0（向左看）
    const nx = dx / Math.max(1, screenCenterX);
    const ny = dy / Math.max(1, screenCenterY);
    // 经验增益：右下角模型看向中心时产生自然偏头， Clamp 在控制器安全范围内
    const yaw = Math.max(-0.28, Math.min(0.28, nx * 0.4 - bodyYaw));
    const pitch = Math.max(-0.14, Math.min(0.14, ny * 0.32));
    const focused = this.setTarget(yaw, pitch);
    this.focusTarget = { ...focused };
    return focused;
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));

    if (this.speaking) {
      this.speakingElapsed += dt;
      const beatPhase = this.speakingElapsed % 6.2;
      const beatCycle = Math.floor(this.speakingElapsed / 6.2);
      const beatDirection = beatCycle % 2 === 0 ? 1 : -1;
      const beatEnvelope = beatCycle >= 1 || beatPhase < 1.25
        ? 0
        : beatPhase < 2.0
          ? (beatPhase - 1.25) / 0.75
          : beatPhase < 2.9
            ? 1
            : beatPhase < 3.8
              ? 1 - (beatPhase - 2.9) / 0.9
              : 0;
      const semanticYaw = ['thinking', 'shy', 'skeptical', 'embarrassed'].includes(this.speakingSemantic)
        ? 0.035
        : ['concerned', 'heartbroken'].includes(this.speakingSemantic)
          ? -0.03
          : 0;
      const semanticPitch = ['thinking', 'shy', 'concerned', 'heartbroken', 'skeptical', 'embarrassed'].includes(this.speakingSemantic) ? 0.025 : 0;
      // Low-amplitude deterministic ocular micro-motion. It is intentionally
      // much smaller than a glance beat, adding life without visible jitter.
      const microYaw = Math.sin(this.speakingElapsed * 4.7 + 0.3) * 0.0015
        + Math.sin(this.speakingElapsed * 7.1) * 0.0007;
      const microPitch = Math.sin(this.speakingElapsed * 5.3 + 1.1) * 0.0011
        + Math.sin(this.speakingElapsed * 8.3 + 0.4) * 0.0005;
      const combined: GazeTarget = this.focusLocked ? {
        yaw: this.focusTarget.yaw + microYaw,
        pitch: this.focusTarget.pitch + microPitch
      } : {
        yaw: this.baseSemanticTarget.yaw
          + beatDirection * beatEnvelope * (0.14 + Math.abs(semanticYaw))
          + Math.sin(this.speakingElapsed * 0.73) * 0.006
          + microYaw,
        pitch: this.baseSemanticTarget.pitch
          + beatEnvelope * (0.055 + semanticPitch)
          + Math.sin(this.speakingElapsed * 0.47 + 0.8) * 0.004
          + microPitch
      };
      this.target = {
        yaw: Math.min(0.28, Math.max(-0.28, combined.yaw)),
        pitch: Math.min(0.14, Math.max(-0.14, combined.pitch))
      };
    }

    const eyeAlpha = 1 - Math.exp(-dt / 0.07);
    const headAlpha = 1 - Math.exp(-dt / 0.28);
    this.eye = this.approach(this.eye, this.target, eyeAlpha);
    this.head = this.approach(this.head, this.target, headAlpha);

    if (this.bones.bothEyes && this.canApply('両目')) {
      this.applyFromRest(this.bones.bothEyes, this.eye.pitch, this.eye.yaw, 0);
    } else {
      if (this.bones.leftEye && this.canApply('左目')) {
        this.applyFromRest(this.bones.leftEye, this.eye.pitch, this.eye.yaw, 0);
      }
      if (this.bones.rightEye && this.canApply('右目')) {
        this.applyFromRest(this.bones.rightEye, this.eye.pitch, this.eye.yaw, 0);
      }
    }
    if ((!this.physicsEnabled || this.focusLocked) && this.bones.head && this.canApply('頭')) {
      const scale = this.focusLocked && this.physicsEnabled ? 0.12 : 0.28;
      this.applyFromRest(this.bones.head, this.head.pitch * scale, this.head.yaw * scale, 0);
    }
    if ((!this.physicsEnabled || this.focusLocked) && this.bones.neck && this.canApply('首')) {
      const scale = this.focusLocked && this.physicsEnabled ? 0.06 : 0.16;
      this.applyFromRest(this.bones.neck, this.head.pitch * scale, this.head.yaw * scale, 0);
    }
  }

  reset(): void {
    this.speaking = false;
    this.target = { yaw: 0, pitch: 0 };
    this.eye = { yaw: 0, pitch: 0 };
    this.head = { yaw: 0, pitch: 0 };
    this.baseSemanticTarget = { yaw: 0, pitch: 0 };
    this.focusTarget = { yaw: 0, pitch: 0 };
    this.speakingSemantic = 'neutral';
    this.speakingElapsed = 0;
    this.focusLocked = false;
    for (const [bone, rest] of this.rest) bone.quaternion.copy(rest);
  }

  private approach(current: GazeTarget, target: GazeTarget, alpha: number): GazeTarget {
    return {
      yaw: current.yaw + (target.yaw - current.yaw) * alpha,
      pitch: current.pitch + (target.pitch - current.pitch) * alpha
    };
  }

  private canApply(name: string): boolean {
    return this.ownership?.canApplyProcedural(name) ?? true;
  }

  private applyFromRest(bone: THREE.Bone, x: number, y: number, z: number): void {
    const rest = this.rest.get(bone);
    if (!rest) return;
    const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
    bone.quaternion.copy(rest).multiply(offset);
  }
}
