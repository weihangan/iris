import * as THREE from 'three';

export interface LocalBonePose {
  readonly quaternion: readonly [number, number, number, number];
  readonly position: readonly [number, number, number];
}

export interface PoseInertializerOptions {
  readonly allowTranslation?: boolean;
}

class ScalarInertializer {
  private elapsed = 0;
  private duration = 0;
  private a = 0;
  private b = 0;
  private c = 0;
  private initialAcceleration = 0;
  private initialVelocity = 0;
  private initialValue = 0;

  get active(): boolean {
    return this.duration > 0;
  }

  clear(): void {
    this.elapsed = 0;
    this.duration = 0;
  }

  begin(initialValue: number, initialVelocity: number, durationSeconds: number): void {
    if (!Number.isFinite(initialValue) || Math.abs(initialValue) < 1e-7) {
      this.clear();
      return;
    }

    const duration = Math.max(1e-4, durationSeconds);
    // Preserve measured velocity without allowing a one-frame stall to create an
    // arbitrarily large polynomial overshoot.
    const velocityLimit = Math.max(0.01, Math.abs(initialValue) * 8 / duration);
    const velocity = THREE.MathUtils.clamp(
      Number.isFinite(initialVelocity) ? initialVelocity : 0,
      -velocityLimit,
      velocityLimit
    );
    const acceleration = 0;
    const t2 = duration * duration;
    const t3 = t2 * duration;
    const t4 = t3 * duration;
    const t5 = t4 * duration;

    this.a = -(acceleration * t2 + 6 * velocity * duration + 12 * initialValue) / (2 * t5);
    this.b = (3 * acceleration * t2 + 16 * velocity * duration + 30 * initialValue) / (2 * t4);
    this.c = -(3 * acceleration * t2 + 12 * velocity * duration + 20 * initialValue) / (2 * t3);
    this.initialAcceleration = acceleration;
    this.initialVelocity = velocity;
    this.initialValue = initialValue;
    this.elapsed = 0;
    this.duration = duration;
  }

  sample(deltaSeconds: number): number {
    if (!this.active) return 0;
    this.elapsed += Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
    if (this.elapsed >= this.duration) {
      this.clear();
      return 0;
    }

    const t = this.elapsed;
    return this.a * t ** 5
      + this.b * t ** 4
      + this.c * t ** 3
      + 0.5 * this.initialAcceleration * t * t
      + this.initialVelocity * t
      + this.initialValue;
  }
}

function toQuaternion(pose: LocalBonePose): THREE.Quaternion {
  return new THREE.Quaternion(...pose.quaternion).normalize();
}

function toPosition(pose: LocalBonePose): THREE.Vector3 {
  return new THREE.Vector3(...pose.position);
}

function shortestAxisAngle(quaternion: THREE.Quaternion): { axis: THREE.Vector3; angle: number } {
  const q = quaternion.clone().normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
  const sine = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  const axis = sine > 1e-6
    ? new THREE.Vector3(q.x / sine, q.y / sine, q.z / sine)
    : new THREE.Vector3(1, 0, 0);
  return { axis, angle };
}

/**
 * Decays the difference between a captured visible local pose and a newly
 * sampled target pose. The output is safe to apply before IK: it contains only
 * local bone transforms and does not write world-space/root motion.
 */
export class PoseInertializer {
  private readonly rotation = new ScalarInertializer();
  private readonly translation = new ScalarInertializer();
  private rotationAxis = new THREE.Vector3(1, 0, 0);
  private translationAxis = new THREE.Vector3(1, 0, 0);
  private translationEnabled = false;

  get active(): boolean {
    return this.rotation.active || this.translation.active;
  }

  clear(): void {
    this.rotation.clear();
    this.translation.clear();
    this.translationEnabled = false;
  }

  begin(
    current: LocalBonePose,
    previous: LocalBonePose,
    target: LocalBonePose,
    previousDeltaSeconds: number,
    durationSeconds: number,
    options: PoseInertializerOptions = {}
  ): void {
    const targetRotation = toQuaternion(target);
    const currentOffset = toQuaternion(current).multiply(targetRotation.clone().invert());
    const previousOffset = toQuaternion(previous).multiply(targetRotation.clone().invert());
    const currentAxisAngle = shortestAxisAngle(currentOffset);
    const previousAxisAngle = shortestAxisAngle(previousOffset);
    const previousAngle = previousAxisAngle.axis.dot(currentAxisAngle.axis) < 0
      ? -previousAxisAngle.angle
      : previousAxisAngle.angle;
    const safeDelta = Math.max(1e-5, Number.isFinite(previousDeltaSeconds) ? previousDeltaSeconds : 1 / 60);

    this.rotationAxis.copy(currentAxisAngle.axis);
    this.rotation.begin(
      currentAxisAngle.angle,
      (currentAxisAngle.angle - previousAngle) / safeDelta,
      durationSeconds
    );

    this.translationEnabled = options.allowTranslation === true;
    if (!this.translationEnabled) {
      this.translation.clear();
      return;
    }

    const offset = toPosition(current).sub(toPosition(target));
    const distance = offset.length();
    if (distance < 1e-7) {
      this.translation.clear();
      return;
    }
    this.translationAxis.copy(offset).normalize();
    const previousDistance = toPosition(previous)
      .sub(toPosition(target))
      .dot(this.translationAxis);
    this.translation.begin(distance, (distance - previousDistance) / safeDelta, durationSeconds);
  }

  sample(target: LocalBonePose, deltaSeconds: number): LocalBonePose {
    const targetRotation = toQuaternion(target);
    const angle = this.rotation.sample(deltaSeconds);
    const rotation = angle === 0
      ? targetRotation
      : new THREE.Quaternion().setFromAxisAngle(this.rotationAxis, angle).multiply(targetRotation).normalize();

    const position = toPosition(target);
    if (this.translationEnabled) {
      position.addScaledVector(this.translationAxis, this.translation.sample(deltaSeconds));
    }

    return {
      quaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
      position: [position.x, position.y, position.z]
    };
  }
}
// provenance: wha9917/private-optimizations — transition smoothing marker; inert.
