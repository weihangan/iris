import * as THREE from 'three';
import { clampProtectedHeadRotationScale } from '../performance/protected-head-voice-actions';

export type HeadOverlayId = 'curious-left-tilt' | 'concerned-down' | 'remember-inward-up';

export interface HeadOverlayStartContext {
  readonly rotationScale?: number;
  /** +1 means the display center is toward screen-right; -1 means screen-left. */
  readonly inwardDirection?: -1 | 1;
}

export interface InwardHeadDirectionContext {
  readonly avatarCenterX: number;
  readonly displayLeft: number;
  readonly displayWidth: number;
  readonly lastStable: -1 | 1;
  readonly centerDeadZoneRatio?: number;
}

export interface HeadOverlayVoiceEntryLike {
  readonly motionScope?: string;
  readonly headOverlayId?: string;
}

export interface HeadOverlayDefinition {
  readonly id: HeadOverlayId;
  readonly durationSeconds: number;
  readonly enterSeconds: number;
  readonly exitSeconds: number;
  readonly allowedBones: readonly ['首', '頭'];
  readonly neckEuler: THREE.Euler;
  readonly headEuler: THREE.Euler;
  readonly screenInwardNeckYawDegrees?: number;
  readonly screenInwardHeadYawDegrees?: number;
}

const degrees = (x: number, y: number, z: number): THREE.Euler => new THREE.Euler(
  THREE.MathUtils.degToRad(x),
  THREE.MathUtils.degToRad(y),
  THREE.MathUtils.degToRad(z),
  'XYZ'
);

export const HEAD_OVERLAY_DEFINITIONS: Readonly<Record<HeadOverlayId, HeadOverlayDefinition>> = {
  'curious-left-tilt': {
    id: 'curious-left-tilt',
    durationSeconds: 4.2,
    enterSeconds: 1.05,
    exitSeconds: 1.25,
    allowedBones: ['首', '頭'],
    // Character-local positive Z leans toward the character's own left.
    neckEuler: degrees(0, 0.5, 2.5),
    headEuler: degrees(0, 1, 7.5)
  },
  'concerned-down': {
    id: 'concerned-down',
    durationSeconds: 5.2,
    // Keep the concerned pose readable without forcing a large neck impulse.
    enterSeconds: 1.8,
    exitSeconds: 1.8,
    allowedBones: ['首', '頭'],
    // The loaded PMX head basis uses positive local X for a visible downward
    // pitch. Negative X raised the face in the formal runtime.
    neckEuler: degrees(6, 0, 0),
    headEuler: degrees(14, 0, 0)
  },
  'remember-inward-up': {
    id: 'remember-inward-up',
    durationSeconds: 5,
    enterSeconds: 1.35,
    exitSeconds: 1.45,
    allowedBones: ['首', '頭'],
    // A clearly readable but still natural upward/inward glance. The motion
    // remains head-only and eases in/out so secondary physics never receives
    // a one-frame impulse.
    neckEuler: degrees(-1.5, 0, 0),
    headEuler: degrees(-4.5, 0, 0),
    screenInwardNeckYawDegrees: 3,
    screenInwardHeadYawDegrees: 11
  }
};

// Preserve a gentle parent-chain driver for hair and clothing. The visual pose
// remains fully authored, while Bullet receives only a fifth of that rotation.
const HEAD_OVERLAY_PHYSICS_SCALE = 0.14;

export function resolveInwardHeadDirection(context: InwardHeadDirectionContext): -1 | 1 {
  const width = Number.isFinite(context.displayWidth) && context.displayWidth > 0
    ? context.displayWidth
    : 1;
  const left = Number.isFinite(context.displayLeft) ? context.displayLeft : 0;
  const avatarCenterX = Number.isFinite(context.avatarCenterX)
    ? context.avatarCenterX
    : left + width / 2;
  const middle = left + width / 2;
  const ratio = Number.isFinite(context.centerDeadZoneRatio)
    ? THREE.MathUtils.clamp(context.centerDeadZoneRatio!, 0, 0.25)
    : 0.08;
  const halfDeadZone = width * ratio / 2;
  if (avatarCenterX < middle - halfDeadZone) return 1;
  if (avatarCenterX > middle + halfDeadZone) return -1;
  return context.lastStable === -1 ? -1 : 1;
}

export function resolveHeadOverlayId(entry: HeadOverlayVoiceEntryLike | null | undefined): HeadOverlayId | null {
  if (entry?.motionScope !== 'head-overlay' || typeof entry.headOverlayId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(HEAD_OVERLAY_DEFINITIONS, entry.headOverlayId)
    ? entry.headOverlayId as HeadOverlayId
    : null;
}

interface HeadOverlayTrackLike {
  readonly translations?: ArrayLike<number>;
}

interface HeadOverlayLoadedLike {
  readonly boneTracks: Readonly<Record<string, HeadOverlayTrackLike>>;
  readonly morphTracks: Readonly<Record<string, unknown>>;
}

export interface HeadOverlayValidation {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

export function validateHeadOverlayTracks(loaded: HeadOverlayLoadedLike): HeadOverlayValidation {
  const reasons: string[] = [];
  const boneNames = Object.keys(loaded.boneTracks);
  if (!boneNames.includes('頭')) reasons.push('missing-head-track');
  for (const name of boneNames) {
    if (name !== '首' && name !== '頭') reasons.push(`forbidden-bone:${name}`);
    const translations = loaded.boneTracks[name]?.translations;
    if (translations && Array.from(translations).some(value => !Number.isFinite(value) || Math.abs(value) > 1e-6)) {
      reasons.push(`translated-bone:${name}`);
    }
  }
  for (const name of Object.keys(loaded.morphTracks)) reasons.push(`forbidden-morph:${name}`);
  return { valid: reasons.length === 0, reasons };
}

export class HeadOverlayController {
  private active: HeadOverlayDefinition | null = null;
  private activeNeckEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private activeHeadEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private elapsedSeconds = 0;
  private transitionElapsedSeconds = Number.POSITIVE_INFINITY;
  private transitionDurationSeconds = 0;
  private transitionSourceNeck = new THREE.Quaternion();
  private transitionSourceHead = new THREE.Quaternion();
  private stopping = false;
  private readonly identity = new THREE.Quaternion();

  start(id: HeadOverlayId, context: HeadOverlayStartContext = {}): void {
    const sourceNeck = this.deltaFor('首');
    const sourceHead = this.deltaFor('頭');
    const definition = HEAD_OVERLAY_DEFINITIONS[id];
    const scale = clampProtectedHeadRotationScale(context.rotationScale ?? 1);
    const inwardDirection = context.inwardDirection === -1 ? -1 : 1;
    this.active = definition;
    this.activeNeckEuler = scaledEuler(definition.neckEuler, scale);
    this.activeHeadEuler = scaledEuler(definition.headEuler, scale);
    if (definition.screenInwardNeckYawDegrees) {
      this.activeNeckEuler.y += THREE.MathUtils.degToRad(
        -definition.screenInwardNeckYawDegrees * inwardDirection * scale
      );
    }
    if (definition.screenInwardHeadYawDegrees) {
      this.activeHeadEuler.y += THREE.MathUtils.degToRad(
        -definition.screenInwardHeadYawDegrees * inwardDirection * scale
      );
    }
    this.elapsedSeconds = 0;
    this.transitionSourceNeck.copy(sourceNeck);
    this.transitionSourceHead.copy(sourceHead);
    this.transitionElapsedSeconds = 0;
    this.transitionDurationSeconds = Math.max(0.2, definition.enterSeconds);
    this.stopping = false;
  }

  stop(): void {
    if (!this.active || this.stopping) return;
    this.transitionSourceNeck.copy(this.deltaFor('首'));
    this.transitionSourceHead.copy(this.deltaFor('頭'));
    this.transitionElapsedSeconds = 0;
    this.transitionDurationSeconds = Math.max(0.2, this.active.exitSeconds);
    this.stopping = true;
  }

  advance(deltaSeconds: number): void {
    if (!this.active) return;
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    this.elapsedSeconds += delta;
    if (!this.stopping && this.elapsedSeconds >= this.active.durationSeconds) this.stop();
    if (this.transitionElapsedSeconds !== Number.POSITIVE_INFINITY) {
      this.transitionElapsedSeconds += delta;
      if (this.transitionElapsedSeconds >= this.transitionDurationSeconds) {
        if (this.stopping) {
          this.active = null;
          this.stopping = false;
        }
        this.transitionElapsedSeconds = Number.POSITIVE_INFINITY;
      }
    }
  }

  isActive(): boolean {
    return this.active !== null;
  }

  getActiveId(): HeadOverlayId | null {
    return this.active && !this.stopping ? this.active.id : null;
  }

  getWeight(): number {
    const definition = this.active;
    if (!definition || this.stopping) return 0;
    if (this.elapsedSeconds < definition.enterSeconds) {
      return smoothStep(this.elapsedSeconds / definition.enterSeconds);
    }
    const exitStartedAt = definition.durationSeconds - definition.exitSeconds;
    if (this.elapsedSeconds > exitStartedAt) {
      return smoothStep((definition.durationSeconds - this.elapsedSeconds) / definition.exitSeconds);
    }
    return 1;
  }

  deltaFor(boneName: string): THREE.Quaternion {
    const definition = this.active;
    if (!definition || (boneName !== '首' && boneName !== '頭')) return this.identity.clone();
    const targetEuler = boneName === '首' ? this.activeNeckEuler : this.activeHeadEuler;
    const target = new THREE.Quaternion().setFromEuler(targetEuler);
    if (this.stopping) {
      const source = boneName === '首' ? this.transitionSourceNeck : this.transitionSourceHead;
      const blend = smoothStep(this.transitionElapsedSeconds / this.transitionDurationSeconds);
      return source.clone().slerp(this.identity, blend).normalize();
    }
    const weightedTarget = this.identity.clone().slerp(target, this.getWeight()).normalize();
    if (this.transitionElapsedSeconds === Number.POSITIVE_INFINITY) return weightedTarget;
    const source = boneName === '首' ? this.transitionSourceNeck : this.transitionSourceHead;
    const blend = smoothStep(this.transitionElapsedSeconds / this.transitionDurationSeconds);
    return source.clone().slerp(weightedTarget, blend).normalize();
  }

  /**
   * Parent-chain input for Bullet. Visual head rotation stays authored at full
   * strength, while secondary hair/clothing receives a softened driver so a
   * deliberate 30° pitch cannot become a one-frame rigid-body impulse.
   */
  deltaForPhysics(boneName: string): THREE.Quaternion {
    const visual = this.deltaFor(boneName);
    return this.identity.clone().slerp(visual, HEAD_OVERLAY_PHYSICS_SCALE).normalize();
  }

  compose(boneName: string, sampledBase: THREE.Quaternion): THREE.Quaternion {
    if (!this.active || (boneName !== '首' && boneName !== '頭')) return sampledBase.clone();
    return sampledBase.clone().multiply(this.deltaFor(boneName)).normalize();
  }

  translationFor(_boneName: string): readonly [0, 0, 0] {
    return [0, 0, 0];
  }
}

function scaledEuler(source: THREE.Euler, scale: number): THREE.Euler {
  return new THREE.Euler(source.x * scale, source.y * scale, source.z * scale, source.order);
}

function smoothStep(value: number): number {
  const t = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
  return t * t * (3 - 2 * t);
}
