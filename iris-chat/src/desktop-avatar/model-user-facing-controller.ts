import * as THREE from 'three';

const DEFAULT_MAX_YAW = THREE.MathUtils.degToRad(14);
const DEFAULT_RESPONSE_SECONDS = 0.34;
const MANUAL_RESPONSE_SECONDS = 0.18;
const MANUAL_MAX_YAW = THREE.MathUtils.degToRad(45);
const MANUAL_MAX_PITCH = THREE.MathUtils.degToRad(30);

/** Smoothly turns the complete model toward the viewer without touching VMD bones. */
export class ModelUserFacingController {
  private readonly baseQuaternion: THREE.Quaternion;
  private readonly yawOffset = new THREE.Quaternion();
  private readonly manualYawOffset = new THREE.Quaternion();
  private readonly manualPitchOffset = new THREE.Quaternion();
  private currentYaw = 0;
  private targetYaw = 0;
  private currentManualYaw = 0;
  private targetManualYaw = 0;
  private currentManualPitch = 0;
  private targetManualPitch = 0;

  constructor(
    baseQuaternion: THREE.Quaternion,
    private readonly maxYaw = DEFAULT_MAX_YAW,
    private readonly responseSeconds = DEFAULT_RESPONSE_SECONDS
  ) {
    this.baseQuaternion = baseQuaternion.clone();
  }

  setUserWorldPosition(modelPosition: THREE.Vector3, userPosition: THREE.Vector3): number {
    const yaw = Math.atan2(
      userPosition.x - modelPosition.x,
      userPosition.z - modelPosition.z
    );
    this.targetYaw = THREE.MathUtils.clamp(yaw, -this.maxYaw, this.maxYaw);
    return this.targetYaw;
  }

  /** Set the user-controlled model turn in radians. Values are bounded so UI
   * or IPC callers cannot produce an unstable pose. */
  setManualRotation(yawRadians: number, pitchRadians: number): void {
    this.targetManualYaw = THREE.MathUtils.clamp(
      Number.isFinite(yawRadians) ? yawRadians : 0,
      -MANUAL_MAX_YAW,
      MANUAL_MAX_YAW
    );
    this.targetManualPitch = THREE.MathUtils.clamp(
      Number.isFinite(pitchRadians) ? pitchRadians : 0,
      -MANUAL_MAX_PITCH,
      MANUAL_MAX_PITCH
    );
  }

  advance(rootQuaternion: THREE.Quaternion, deltaSeconds: number): boolean {
    const dt = THREE.MathUtils.clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
    const alpha = 1 - Math.exp(-dt / Math.max(0.001, this.responseSeconds));
    const previous = this.currentYaw;
    this.currentYaw += (this.targetYaw - this.currentYaw) * alpha;
    if (Math.abs(this.targetYaw - this.currentYaw) < 1e-5) this.currentYaw = this.targetYaw;

    const manualAlpha = 1 - Math.exp(-dt / MANUAL_RESPONSE_SECONDS);
    this.currentManualYaw += (this.targetManualYaw - this.currentManualYaw) * manualAlpha;
    this.currentManualPitch += (this.targetManualPitch - this.currentManualPitch) * manualAlpha;
    if (Math.abs(this.targetManualYaw - this.currentManualYaw) < 1e-5) {
      this.currentManualYaw = this.targetManualYaw;
    }
    if (Math.abs(this.targetManualPitch - this.currentManualPitch) < 1e-5) {
      this.currentManualPitch = this.targetManualPitch;
    }

    this.yawOffset.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.currentYaw);
    this.manualYawOffset.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.currentManualYaw);
    this.manualPitchOffset.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.currentManualPitch);
    rootQuaternion.copy(this.baseQuaternion)
      .multiply(this.yawOffset)
      .multiply(this.manualYawOffset)
      .multiply(this.manualPitchOffset);
    return Math.abs(this.currentYaw - previous) > 1e-7
      || Math.abs(this.currentManualYaw - this.targetManualYaw) > 1e-7
      || Math.abs(this.currentManualPitch - this.targetManualPitch) > 1e-7;
  }

  getCurrentYaw(): number {
    return this.currentYaw;
  }

  getTargetYaw(): number {
    return this.targetYaw;
  }

  /** Combined horizontal orientation used to align the physics world. */
  getCurrentWorldYaw(): number {
    return this.currentYaw + this.currentManualYaw;
  }

  getManualRotation(): { yaw: number; pitch: number } {
    return { yaw: this.currentManualYaw, pitch: this.currentManualPitch };
  }
}
