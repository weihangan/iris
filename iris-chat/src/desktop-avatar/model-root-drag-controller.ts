export interface MutablePosition3 {
  x: number;
  y: number;
  z: number;
}

const MAX_FRAME_DELTA_SECONDS = 0.05;
const POSITION_EPSILON = 1e-4;
const VELOCITY_EPSILON = 1e-3;

/**
 * Critically damped model-root follower. Keeping the root itself continuous
 * lets ThreeMmdLoader feed one coherent world transform to Bullet.
 */
export class ModelRootDragController {
  private targetX: number;
  private targetY: number;
  private targetZ: number;
  private velocityX = 0;
  private velocityY = 0;
  private velocityZ = 0;
  private readonly angularFrequency: number;

  constructor(initialPosition: Readonly<MutablePosition3>, smoothTimeSeconds = 0.055) {
    this.targetX = initialPosition.x;
    this.targetY = initialPosition.y;
    this.targetZ = initialPosition.z;
    const smoothTime = Number.isFinite(smoothTimeSeconds)
      ? Math.max(smoothTimeSeconds, 1e-3)
      : 0.08;
    this.angularFrequency = 2 / smoothTime;
  }

  setTarget(x: number, y: number, z: number): void {
    if (Number.isFinite(x)) this.targetX = x;
    if (Number.isFinite(y)) this.targetY = y;
    if (Number.isFinite(z)) this.targetZ = z;
  }

  advance(position: MutablePosition3, deltaSeconds: number): boolean {
    const dt = Math.min(Math.max(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0), MAX_FRAME_DELTA_SECONDS);
    if (dt === 0) return false;

    const x = this.advanceAxis(position.x, this.targetX, this.velocityX, dt);
    const y = this.advanceAxis(position.y, this.targetY, this.velocityY, dt);
    const z = this.advanceAxis(position.z, this.targetZ, this.velocityZ, dt);
    this.velocityX = x.velocity;
    this.velocityY = y.velocity;
    this.velocityZ = z.velocity;

    const changed = x.value !== position.x || y.value !== position.y || z.value !== position.z;
    position.x = x.value;
    position.y = y.value;
    position.z = z.value;
    return changed;
  }

  private advanceAxis(current: number, target: number, velocity: number, dt: number): { value: number; velocity: number } {
    const displacement = current - target;
    const decay = Math.exp(-this.angularFrequency * dt);
    const momentum = velocity + this.angularFrequency * displacement;
    let nextDisplacement = (displacement + momentum * dt) * decay;
    let nextVelocity = (velocity - this.angularFrequency * momentum * dt) * decay;

    if (Math.abs(nextDisplacement) < POSITION_EPSILON && Math.abs(nextVelocity) < VELOCITY_EPSILON) {
      nextDisplacement = 0;
      nextVelocity = 0;
    }
    return { value: target + nextDisplacement, velocity: nextVelocity };
  }
}
