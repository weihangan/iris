import * as THREE from 'three';

// Keep the body-connected chain roots guarded while Bullet sheds the velocity
// from a fast drag. Descendants remain fully simulated during this tail, so a
// longer root envelope prevents separation without making the strand rigid.
const DEFAULT_SETTLE_SECONDS = 2.0;
const DEFAULT_MAX_ROOT_LOCAL_TRANSLATION = 0.04;
const DEFAULT_MAX_ROOT_LOCAL_ROTATION = 0.35;

export interface RootDragSecondaryAttachmentOptions {
  readonly settleSeconds?: number;
  readonly maxRootLocalTranslation?: number;
  readonly maxRootLocalRotation?: number;
  readonly getMaxRootLocalTranslation?: (bone?: THREE.Bone) => number;
  readonly getMaxRootLocalRotation?: (bone?: THREE.Bone) => number;
}

/** Per-bone guard state for one frame (drag diagnostics). */
export interface RootDragAttachmentBoneDiagnostics {
  readonly boneName: string;
  readonly rawPositionOffset: number;
  readonly rawRotationOffset: number;
  readonly clamped: boolean;
  /** Root-local offset measured AFTER the clamp write-back (diagnostics). */
  readonly postClampPositionOffset: number;
}

/**
 * Keep only the first dynamic bone of each secondary-motion chain.
 *
 * Attachment protection belongs at the body-connected chain root. Applying
 * the same envelope to every descendant freezes authored hair/skirt swing and
 * makes a healthy Bullet simulation look rigid.
 */
export function selectRootDragAttachmentBones(
  bones: readonly THREE.Bone[],
  isDynamic: (bone: THREE.Bone) => boolean
): THREE.Bone[] {
  const dynamicBones = new Set(bones.filter(isDynamic));
  return bones.filter(bone => {
    if (!dynamicBones.has(bone)) return false;
    let parent: THREE.Object3D | null = bone.parent;
    while (parent && !(parent instanceof THREE.Bone)) parent = parent.parent;
    return !(parent instanceof THREE.Bone) || !dynamicBones.has(parent);
  });
}

/**
 * Hair descendants need a wider, depth-dependent envelope during a desktop
 * root drag.  Keeping them in the same controller preserves Bullet ownership
 * and follow-through, while preventing a long imported strand from being left
 * several model widths behind its head.  The caller supplies the semantic
 * hair predicate so this helper never captures clothing or ribbons.
 */
export function selectRootDragHairAttachmentBones(
  bones: readonly THREE.Bone[],
  isDynamic: (bone: THREE.Bone) => boolean,
  isHair: (bone: THREE.Bone) => boolean
): THREE.Bone[] {
  return bones.filter(bone => isDynamic(bone) && isHair(bone));
}

/**
 * Final-pose guard for desktop root dragging.
 *
 * Bullet still owns and advances every dynamic bone. This guard runs only
 * while the user translates the complete model root (plus a short release
 * tail) and prevents the rendered chain from remaining in its old scene-space
 * position. References and limits are expressed relative to the model root,
 * so normal root translation and user-facing yaw never count as detachment.
 */
export class RootDragSecondaryAttachmentController {
  private readonly bones: readonly THREE.Bone[];
  private readonly references = new Map<THREE.Bone, THREE.Matrix4>();
  private readonly settleSeconds: number;
  private readonly maxRootLocalTranslation: number;
  private readonly maxRootLocalRotation: number;
  private readonly getMaxRootLocalTranslation?: (bone?: THREE.Bone) => number;
  private readonly getMaxRootLocalRotation?: (bone?: THREE.Bone) => number;
  private dragging = false;
  private settleRemainingSeconds = 0;
  private lastFrameDiagnostics: readonly RootDragAttachmentBoneDiagnostics[] = [];

  private readonly inverseRootWorld = new THREE.Matrix4();
  private readonly currentRootLocal = new THREE.Matrix4();
  private readonly desiredRootLocal = new THREE.Matrix4();
  private readonly desiredWorld = new THREE.Matrix4();
  private readonly inverseParentWorld = new THREE.Matrix4();
  private readonly desiredLocal = new THREE.Matrix4();
  private readonly currentPosition = new THREE.Vector3();
  private readonly currentRotation = new THREE.Quaternion();
  private readonly currentScale = new THREE.Vector3();
  private readonly referencePosition = new THREE.Vector3();
  private readonly referenceRotation = new THREE.Quaternion();
  private readonly referenceScale = new THREE.Vector3();
  private readonly localPosition = new THREE.Vector3();
  private readonly localRotation = new THREE.Quaternion();
  private readonly localScale = new THREE.Vector3();

  constructor(
    private readonly modelRoot: THREE.Object3D,
    bones: readonly THREE.Bone[],
    options: RootDragSecondaryAttachmentOptions = {}
  ) {
    this.bones = [...new Set(bones)].sort((left, right) => boneDepth(left) - boneDepth(right));
    this.settleSeconds = finitePositive(options.settleSeconds, DEFAULT_SETTLE_SECONDS);
    this.maxRootLocalTranslation = finitePositive(
      options.maxRootLocalTranslation,
      DEFAULT_MAX_ROOT_LOCAL_TRANSLATION
    );
    this.maxRootLocalRotation = finitePositive(
      options.maxRootLocalRotation,
      DEFAULT_MAX_ROOT_LOCAL_ROTATION
    );
    this.getMaxRootLocalTranslation = options.getMaxRootLocalTranslation;
    this.getMaxRootLocalRotation = options.getMaxRootLocalRotation;
  }

  begin(): void {
    this.dragging = true;
    this.settleRemainingSeconds = this.settleSeconds;
    this.captureReferences();
  }

  end(): void {
    if (!this.dragging && this.references.size === 0) return;
    this.dragging = false;
    this.settleRemainingSeconds = this.settleSeconds;
  }

  releaseImmediately(): void {
    this.dragging = false;
    this.settleRemainingSeconds = 0;
    this.references.clear();
  }

  apply(deltaSeconds: number): boolean {
    if (!this.dragging && this.settleRemainingSeconds <= 0) {
      this.lastFrameDiagnostics = [];
      return false;
    }
    if (this.references.size === 0) this.captureReferences();
    if (this.references.size === 0) return false;

    if (!this.dragging) {
      const dt = THREE.MathUtils.clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
      this.settleRemainingSeconds = Math.max(0, this.settleRemainingSeconds - dt);
    }

    this.modelRoot.updateWorldMatrix(true, true);
    this.inverseRootWorld.copy(this.modelRoot.matrixWorld).invert();
    let changed = false;
    const frameDiagnostics: RootDragAttachmentBoneDiagnostics[] = [];
    this.lastFrameDiagnostics = frameDiagnostics;
    for (const bone of this.bones) {
      const reference = this.references.get(bone);
      if (!reference || !bone.parent) continue;
      bone.updateWorldMatrix(true, false);
      this.currentRootLocal.copy(this.inverseRootWorld).multiply(bone.matrixWorld);
      this.currentRootLocal.decompose(
        this.currentPosition,
        this.currentRotation,
        this.currentScale
      );
      reference.decompose(
        this.referencePosition,
        this.referenceRotation,
        this.referenceScale
      );

      const positionOffset = this.currentPosition.clone().sub(this.referencePosition);
      const rawPositionOffset = positionOffset.length();
      let boneChanged = false;
      const maxRootLocalTranslation = finitePositive(
        this.getMaxRootLocalTranslation?.(bone),
        this.maxRootLocalTranslation
      );
      if (rawPositionOffset > maxRootLocalTranslation) {
        positionOffset.setLength(maxRootLocalTranslation);
        this.currentPosition.copy(this.referencePosition).add(positionOffset);
        boneChanged = true;
      }
      const rotationOffset = this.referenceRotation.angleTo(this.currentRotation);
      const maxRootLocalRotation = finitePositive(
        this.getMaxRootLocalRotation?.(bone),
        this.maxRootLocalRotation
      );
      if (rotationOffset > maxRootLocalRotation) {
        this.referenceRotation.slerp(
          this.currentRotation,
          maxRootLocalRotation / rotationOffset
        );
        this.currentRotation.copy(this.referenceRotation);
        boneChanged = true;
      }
      if (!boneChanged) {
        frameDiagnostics.push({
          boneName: bone.name,
          rawPositionOffset,
          rawRotationOffset: rotationOffset,
          clamped: false,
          postClampPositionOffset: rawPositionOffset
        });
        continue;
      }

      this.desiredRootLocal.compose(
        this.currentPosition,
        this.currentRotation,
        this.currentScale
      );
      this.desiredWorld.copy(this.modelRoot.matrixWorld).multiply(this.desiredRootLocal);
      bone.parent.updateWorldMatrix(true, false);
      this.inverseParentWorld.copy(bone.parent.matrixWorld).invert();
      this.desiredLocal.copy(this.inverseParentWorld).multiply(this.desiredWorld);
      this.desiredLocal.decompose(this.localPosition, this.localRotation, this.localScale);
      bone.position.copy(this.localPosition);
      bone.quaternion.copy(this.localRotation);
      bone.scale.copy(this.localScale);
      bone.updateMatrix();
      bone.updateWorldMatrix(false, false);
      // Re-measure the root-local offset after the write-back so drag
      // diagnostics can tell a math bug (post > limit) from a later overwrite
      // by the next physics step (post <= limit while the measured lag grows).
      this.currentRootLocal.copy(this.inverseRootWorld).multiply(bone.matrixWorld);
      this.currentRootLocal.decompose(
        this.currentPosition,
        this.currentRotation,
        this.currentScale
      );
      const postClampPositionOffset = this.currentPosition
        .clone()
        .sub(this.referencePosition)
        .length();
      frameDiagnostics.push({
        boneName: bone.name,
        rawPositionOffset,
        rawRotationOffset: rotationOffset,
        clamped: true,
        postClampPositionOffset
      });
      changed = true;
    }
    if (changed) this.modelRoot.updateWorldMatrix(true, true);

    if (!this.dragging && this.settleRemainingSeconds <= 0) this.references.clear();
    return changed;
  }

  isActive(): boolean {
    return this.dragging || this.settleRemainingSeconds > 0;
  }

  /** Guard state as observed by the most recent apply() call (diagnostics). */
  getLastFrameDiagnostics(): readonly RootDragAttachmentBoneDiagnostics[] {
    return this.lastFrameDiagnostics;
  }

  private captureReferences(): void {
    this.references.clear();
    this.modelRoot.updateWorldMatrix(true, true);
    this.inverseRootWorld.copy(this.modelRoot.matrixWorld).invert();
    for (const bone of this.bones) {
      bone.updateWorldMatrix(true, false);
      this.references.set(
        bone,
        new THREE.Matrix4().copy(this.inverseRootWorld).multiply(bone.matrixWorld)
      );
    }
  }
}

function boneDepth(bone: THREE.Bone): number {
  let depth = 0;
  let parent: THREE.Object3D | null = bone.parent;
  while (parent) {
    depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}
