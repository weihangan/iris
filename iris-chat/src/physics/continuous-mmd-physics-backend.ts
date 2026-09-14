import type {
  MmdDirectBufferPhysicsBackend,
  MmdPhysicsBackend,
  MmdPhysicsDiagnostic,
  MmdPhysicsMatrix4ColumnMajorTuple,
  MmdPhysicsResetContext,
  MmdPhysicsStepBufferLayout,
  MmdPhysicsStepBuffers,
  MmdPhysicsStepContext,
  MmdPhysicsStepResult
} from '@yohawing/three-mmd-loader/physics';
import * as THREE from 'three';
import { applySecondaryMaterialProfile } from './secondary-material-profile';

const MAX_FRAME_DELTA_SECONDS = 0.05;
const ROOT_INERTIA_LOOKAHEAD_SECONDS = 0.035;
const ROOT_INERTIA_RESPONSE_SECONDS = 0.05;
// Root-drag secondary motion is uniformly normalized to the Yangyang reference
// (rootInertiaScale === 1 for every rig, including future PMX packs): the user
// rejected the previous (reference/medianMass)^2.4 mass normalization because
// every newly imported rig (3-7 kg median dynamic mass vs the 0.405 kg
// reference) collapsed onto the 0.12 floor, which read as stiff/unresponsive
// dragging. Authored PMX mass, damping and spring values stay untouched; only
// the artificial root-inertia injection strength is now model-independent.
// MAX_ROOT_INERTIA_OFFSET plus the independent chain-root attachment guards
// still cap how far the synthetic lag can displace dynamic chains.
// Model-root drag already moves the complete rendered PMX. This is only the
// small additional Bullet lag that makes secondary motion readable. The old
// Chain-root attachment is guarded independently, so the common impulse can
// remain visibly readable without letting a light rig stay behind in scene
// space. Dynamic descendants remain fully Bullet-owned and settle according
// to the PMX-authored springs.
const MAX_ROOT_INERTIA_OFFSET = 0.3;
// Z 形裙摆折叠修复：限制惯性注入的每秒变化率。一帧内的大幅输入瞬移会让
// Bullet 的关节解算产生爆炸性冲量，多段裙摆链的刚体因此相互穿越、折叠成
// Z 形并永久卡住（折叠后每个关节角度仍在各自限制内，解算无法自愈）。
// 限速后同一个 0.3 上限约 0.2 秒才达到，链段可以跟随；持续拖动照样达到
// 满摆幅，只是起摆/收摆更柔和。松手泄压同样受限，避免反向瞬移二次折叠。
const MAX_ROOT_INERTIA_SLEW_PER_SECOND = 1.5;
// 待机裙摆抖动修复：渲染帧 delta 在 60fps 边缘的毫秒级波动（vsync 抖动、
// GPU 负载起伏）在 idle VMD 循环回卷后会原样成为 Bullet 的步进节奏
// （continuousContext.deltaSeconds = frameDeltaSeconds）。婚皮这类刚体
// 数量多、渲染重的模型帧耗时波动最大，固定步长累积器因此交替执行 1/0 个
// 子步——裙摆位置隔帧更新，待机时读作持续高频抖动。对小时间常数做低通
// 平滑后，Bullet 看到的步长稳定在渲染平均帧率附近，子步节奏均匀；EMA 的
// 均值≈输入均值，长期物理时间守恒，PMX 授权的刚体/关节参数完全不动。
const PHYSICS_DELTA_SMOOTHING_SECONDS = 0.1;
// A transition window remains observable for diagnostics, but it must never
// rewrite Bullet's hair/clothing output. Earlier transition clamps renewed
// this tail every time they fired, so ordinary idle could stay under an
// artificial per-frame limiter indefinitely and look springy or detached.
const TRANSITION_DYNAMIC_SETTLE_SECONDS = 0.55;
const ROOT_DRAG_DYNAMIC_SETTLE_SECONDS = 0.4;
const ROOT_DRAG_MOTION_EPSILON = 1e-5;
const TRANSITION_INPUT_BLEND_ALPHA = 0.24;
export interface ContinuousPhysicsDiagnostics {
  readonly forwardedResetCount: number;
  readonly suppressedResetCount: number;
  readonly loopWrapCount: number;
  readonly monotonicSeconds: number;
  readonly lastStepDeltaSeconds: number;
  readonly lastHardResetReason: string | null;
  readonly speechContinuityActive: boolean;
  readonly stabilizedModelIdentityCount: number;
  readonly clockContinuityActive: boolean;
  readonly lastDelegatedSeconds: number | null;
  readonly modelWorldOffset: readonly [number, number, number];
  readonly modelWorldYaw: number;
  readonly rootInertiaDriver: readonly [number, number, number];
  readonly authoredDynamicMedianMass: number | null;
  readonly effectiveDynamicMedianMass: number | null;
  readonly dynamicMassScale: number;
  readonly authoredAngularSpringMedian: number | null;
  readonly effectiveAngularSpringMedian: number | null;
  readonly angularSpringScale: number;
  readonly rootInertiaScale: number;
  readonly transitionStabilizationActive: boolean;
  readonly transitionSettleRemainingSeconds: number;
  readonly rootDragStabilizationActive: boolean;
  readonly rootDragSettleRemainingSeconds: number;
  readonly clampedDynamicOutputCount: number;
  readonly clampedRootDragOutputCount: number;
  readonly maxRawDynamicOutputStep: number;
  readonly maxAppliedDynamicOutputStep: number;
  readonly lastInputMatrixSpace: 'model-local' | 'scene-world' | 'unknown';
  readonly secondaryMaterialProfileActive: boolean;
  readonly secondaryMaterialAdjustedBodyCount: number;
  readonly decorativeCollisionDisabledBodyCount: number;
}

export interface BonePhysicsRigidBodySnapshot {
  readonly rigidBodyIndex: number;
  readonly rigidBodyName: string | null;
  readonly motionType: 'static' | 'dynamic' | 'dynamicWithBone';
  readonly worldMatrixColumnMajor: MmdPhysicsMatrix4ColumnMajorTuple | null;
}

export interface BonePhysicsPipelineSnapshot {
  readonly boneName: string;
  readonly boneIndex: number;
  readonly parentBoneIndex: number | null;
  readonly anchoredToAnimatedParent: boolean;
  readonly physicsEnabled: boolean;
  readonly rigidBodies: readonly BonePhysicsRigidBodySnapshot[];
  readonly inputWorldMatrixColumnMajor: MmdPhysicsMatrix4ColumnMajorTuple | null;
  readonly outputWorldMatrixColumnMajor: MmdPhysicsMatrix4ColumnMajorTuple | null;
  /** Bullet output minus the authored input for this bone, in model space. */
  readonly relativePhysicsDisplacement: readonly [number, number, number] | null;
}

export interface ContinuousMmdPhysicsBackend extends MmdPhysicsBackend {
  readonly acquireStepBuffers?: (layout: MmdPhysicsStepBufferLayout) => MmdPhysicsStepBuffers | undefined;
  beginSpeechContinuity(): void;
  endSpeechContinuity(): void;
  setDisabledBoneNames(names: readonly string[]): void;
  setBoneRotationOverlays(
    overlays: ReadonlyMap<string, readonly [number, number, number, number]>
  ): void;
  setModelWorldOffset(x: number, y: number, z: number): void;
  setModelWorldTransform(x: number, y: number, z: number, yaw: number): void;
  setTransitionActive(active: boolean): void;
  advance(deltaSeconds: number): void;
  requestHardReset(reason: string): void;
  diagnosticsState(): ContinuousPhysicsDiagnostics;
  debugBonePhysicsPipeline(boneNames: readonly string[]): readonly BonePhysicsPipelineSnapshot[];
}

class ContinuousMmdPhysicsBackendImpl implements ContinuousMmdPhysicsBackend {
  readonly name: string;
  readonly acquireStepBuffers?: (layout: MmdPhysicsStepBufferLayout) => MmdPhysicsStepBuffers | undefined;

  private monotonicSeconds = 0;
  private frameDeltaSeconds = 0;
  private smoothedFrameDeltaSeconds: number | null = null;
  private lastInputSeconds: number | null = null;
  private speechContinuityActive = false;
  /**
   * The first loader reset of a new speech session binds a freshly parsed VMD
   * runtime. Keep Bullet's world, but let the first post-bind step establish
   * that runtime's rigid-body/joint arrays as the canonical identity. Further
   * gesture/background switches inside the same reply keep that identity.
   */
  private rebaseIdentityOnNextSuppressedReset = false;
  private rebaseIdentityOnNextStep = false;
  private clockContinuityActive = false;
  private pendingHardResetReason: string | null = null;
  private forwardedResetCount = 0;
  private suppressedResetCount = 0;
  private loopWrapCount = 0;
  private lastHardResetReason: string | null = null;
  private lastStepContext: MmdPhysicsStepContext | null = null;
  private canonicalRigidBodies: MmdPhysicsStepContext['rigidBodies'];
  private canonicalJoints: MmdPhysicsStepContext['joints'];
  private stabilizedModelIdentityCount = 0;
  private modelWorldX = 0;
  private modelWorldY = 0;
  private modelWorldZ = 0;
  private modelWorldYaw = 0;
  private previousModelWorldX = 0;
  private previousModelWorldY = 0;
  private previousModelWorldZ = 0;
  private modelWorldInitialized = false;
  private inertiaDriverX = 0;
  private inertiaDriverY = 0;
  private inertiaDriverZ = 0;
  private shiftedInputWorldMatrices = new Float32Array(0);
  private previousPhysicsInputMatrices = new Float32Array(0);
  private overlaidInputWorldMatrices = new Float32Array(0);
  private readonly rootTransform = new THREE.Matrix4();
  private readonly inverseRootTransform = new THREE.Matrix4();
  private readonly inertiaTransform = new THREE.Matrix4();
  private readonly matrixScratch = new THREE.Matrix4();
  private disabledBoneNames = new Set<string>();
  private readonly boneRotationOverlays = new Map<string, THREE.Quaternion>();
  private readonly overlayParentWorldScratch = new THREE.Matrix4();
  private readonly overlayLocalScratch = new THREE.Matrix4();
  private readonly overlayWorldScratch = new THREE.Matrix4();
  private readonly overlayDeltaScratch = new THREE.Matrix4();
  private lastDelegatedSeconds: number | null = null;
  private normalizedRigidBodySource: MmdPhysicsStepContext['rigidBodies'] = undefined;
  private normalizedRigidBodies: MmdPhysicsStepContext['rigidBodies'] = undefined;
  private normalizedJointSource: MmdPhysicsStepContext['joints'] = undefined;
  private normalizedJoints: MmdPhysicsStepContext['joints'] = undefined;
  private normalizedMaterialJointSource: MmdPhysicsStepContext['joints'] = undefined;
  private normalizedMaterialSkeletonSource: MmdPhysicsStepContext['skeleton'] = undefined;
  private normalizedMaterialBodySource: MmdPhysicsStepContext['rigidBodies'] = undefined;
  private decorativeCollisionDisabledBodyCount = 0;
  private secondaryMaterialProfileActive = false;
  private secondaryMaterialAdjustedBodyCount = 0;
  private decorativeDisabledBoneCount = 0;
  private authoredDynamicMedianMass: number | null = null;
  private effectiveDynamicMedianMass: number | null = null;
  private dynamicMassScale = 1;
  private linearDampingScale = 1;
  private angularDampingScale = 1;
  private authoredAngularSpringMedian: number | null = null;
  private effectiveAngularSpringMedian: number | null = null;
  private angularSpringScale = 1;
  private rootInertiaScale = 1;
  private transitionActive = false;
  private transitionSettleSeconds = 0;
  private rootDragSettleSeconds = 0;
  private readonly previousDynamicOutputMatrices = new Map<number, THREE.Matrix4>();
  private clampedDynamicOutputCount = 0;
  private clampedRootDragOutputCount = 0;
  private maxRawDynamicOutputStep = 0;
  private maxAppliedDynamicOutputStep = 0;
  private readonly previousPositionScratch = new THREE.Vector3();
  private readonly observedPreviousPositionScratch = new THREE.Vector3();
  private readonly currentPositionScratch = new THREE.Vector3();
  private readonly previousRotationScratch = new THREE.Quaternion();
  private readonly currentRotationScratch = new THREE.Quaternion();
  private readonly previousScaleScratch = new THREE.Vector3();
  private readonly currentScaleScratch = new THREE.Vector3();
  private readonly appliedPositionScratch = new THREE.Vector3();
  private readonly appliedRotationScratch = new THREE.Quaternion();
  private readonly appliedScaleScratch = new THREE.Vector3();
  private readonly parentWorldScratch = new THREE.Matrix4();
  private readonly latestRelativePhysicsDisplacements = new Map<number, readonly [number, number, number]>();
  private lastInputMatrixSpace: ContinuousPhysicsDiagnostics['lastInputMatrixSpace'] = 'unknown';
  private readonly inputSpacePositionScratch = new THREE.Vector3();
  private readonly inputSpaceExpectedScratch = new THREE.Vector3();

  constructor(private readonly delegate: MmdPhysicsBackend) {
    this.name = `continuous:${delegate.name}`;
    const direct = delegate as Partial<MmdDirectBufferPhysicsBackend>;
    if (typeof direct.acquireStepBuffers === 'function') {
      this.acquireStepBuffers = direct.acquireStepBuffers.bind(delegate);
    }
  }

  get disabled(): boolean {
    return this.delegate.disabled;
  }

  get disposed(): boolean {
    return this.delegate.disposed;
  }

  beginSpeechContinuity(): void {
    if (this.speechContinuityActive) return;
    this.speechContinuityActive = true;
    this.rebaseIdentityOnNextSuppressedReset = true;
    this.clockContinuityActive = true;
    this.monotonicSeconds = Math.max(
      this.monotonicSeconds,
      this.lastInputSeconds ?? 0,
      this.lastDelegatedSeconds ?? 0
    );
    // The first speech clip normally starts near zero after an idle clip that
    // may have run for many seconds. That boundary is a clip replacement, not
    // a loop wrap, so establish a fresh input-time baseline for diagnostics.
    this.lastInputSeconds = null;
    this.canonicalRigidBodies = this.lastStepContext?.rigidBodies;
    this.canonicalJoints = this.lastStepContext?.joints;
  }

  endSpeechContinuity(): void {
    this.speechContinuityActive = false;
    this.rebaseIdentityOnNextSuppressedReset = false;
    // The local-clock idle uses the same PMX physics world. Keep the canonical
    // model identity across this handoff; replacing these arrays on the first
    // idle frame makes Bullet reinterpret an already-moving hair/skirt world
    // and produces a large one-frame impulse. A real reset/model bind clears
    // them in reset(), where changing identity is intentional.
  }

  setDisabledBoneNames(names: readonly string[]): void {
    this.disabledBoneNames = new Set(names.filter(name => name.length > 0));
  }

  setBoneRotationOverlays(
    overlays: ReadonlyMap<string, readonly [number, number, number, number]>
  ): void {
    this.boneRotationOverlays.clear();
    for (const boneName of ['首', '頭'] as const) {
      const values = overlays.get(boneName);
      if (!values || values.some(value => !Number.isFinite(value))) continue;
      const quaternion = new THREE.Quaternion(...values);
      if (quaternion.lengthSq() <= 1e-12) continue;
      this.boneRotationOverlays.set(boneName, quaternion.normalize());
    }
  }

  setModelWorldOffset(x: number, y: number, z: number): void {
    this.setModelWorldTransform(x, y, z, this.modelWorldYaw);
  }

  setModelWorldTransform(x: number, y: number, z: number, yaw: number): void {
    this.modelWorldX = Number.isFinite(x) ? x : 0;
    this.modelWorldY = Number.isFinite(y) ? y : 0;
    this.modelWorldZ = Number.isFinite(z) ? z : 0;
    this.modelWorldYaw = Number.isFinite(yaw) ? yaw : 0;
    if (!this.modelWorldInitialized) {
      this.previousModelWorldX = this.modelWorldX;
      this.previousModelWorldY = this.modelWorldY;
      this.previousModelWorldZ = this.modelWorldZ;
      this.modelWorldInitialized = true;
    }
  }

  setTransitionActive(active: boolean): void {
    if (active) {
      this.transitionActive = true;
      this.transitionSettleSeconds = TRANSITION_DYNAMIC_SETTLE_SECONDS;
      return;
    }
    if (this.transitionActive) this.transitionSettleSeconds = TRANSITION_DYNAMIC_SETTLE_SECONDS;
    this.transitionActive = false;
  }

  advance(deltaSeconds: number): void {
    const finiteDelta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
    const clampedDelta = Math.min(Math.max(finiteDelta, 0), MAX_FRAME_DELTA_SECONDS);
    if (this.smoothedFrameDeltaSeconds === null) {
      this.smoothedFrameDeltaSeconds = clampedDelta;
    } else {
      // 见 PHYSICS_DELTA_SMOOTHING_SECONDS 声明处注释：滤除 60fps 边缘的
      // 交替帧耗时，让 Bullet 的子步节奏均匀；首帧直接采用原值避免冷启动
      // 收敛尾巴。EMA 时间常数 0.1s（约 6 帧），真实掉帧时步长平滑跟随。
      const smoothingAlpha = 1 - Math.exp(-clampedDelta / PHYSICS_DELTA_SMOOTHING_SECONDS);
      this.smoothedFrameDeltaSeconds += (clampedDelta - this.smoothedFrameDeltaSeconds)
        * smoothingAlpha;
    }
    this.frameDeltaSeconds = this.smoothedFrameDeltaSeconds;
    if (!this.transitionActive && this.transitionSettleSeconds > 0) {
      this.transitionSettleSeconds = Math.max(0, this.transitionSettleSeconds - this.frameDeltaSeconds);
    }
    if (this.modelWorldInitialized && this.frameDeltaSeconds > 0) {
      const inverseDelta = 1 / this.frameDeltaSeconds;
      const rootMotionDelta = Math.hypot(
        this.modelWorldX - this.previousModelWorldX,
        this.modelWorldY - this.previousModelWorldY,
        this.modelWorldZ - this.previousModelWorldZ
      );
      if (rootMotionDelta > ROOT_DRAG_MOTION_EPSILON) {
        this.rootDragSettleSeconds = ROOT_DRAG_DYNAMIC_SETTLE_SECONDS;
      } else if (this.rootDragSettleSeconds > 0) {
        this.rootDragSettleSeconds = Math.max(
          0,
          this.rootDragSettleSeconds - this.frameDeltaSeconds
        );
      }
      // Clamp the common Yangyang-authored impulse first, then apply the rig
      // topology compensation. Applying the scale before the clamp made both
      // rigs hit the same drag cap during an ordinary 120 px mouse drag, so
      // Selena's shorter chains still swung more than twice as far despite a
      // nominal scale below one.
      const targetX = clampRootInertia(
        (this.modelWorldX - this.previousModelWorldX) * inverseDelta * ROOT_INERTIA_LOOKAHEAD_SECONDS
      ) * this.rootInertiaScale;
      const targetY = clampRootInertia(
        (this.modelWorldY - this.previousModelWorldY) * inverseDelta * ROOT_INERTIA_LOOKAHEAD_SECONDS
      ) * this.rootInertiaScale;
      const targetZ = clampRootInertia(
        (this.modelWorldZ - this.previousModelWorldZ) * inverseDelta * ROOT_INERTIA_LOOKAHEAD_SECONDS
      ) * this.rootInertiaScale;
      const alpha = 1 - Math.exp(-this.frameDeltaSeconds / ROOT_INERTIA_RESPONSE_SECONDS);
      const previousDriverX = this.inertiaDriverX;
      const previousDriverY = this.inertiaDriverY;
      const previousDriverZ = this.inertiaDriverZ;
      this.inertiaDriverX += (targetX - this.inertiaDriverX) * alpha;
      this.inertiaDriverY += (targetY - this.inertiaDriverY) * alpha;
      this.inertiaDriverZ += (targetZ - this.inertiaDriverZ) * alpha;
      // 三轴联合限速：对角拖动时保持方向，只截短变化矢量本身。
      const maxDriverStep = MAX_ROOT_INERTIA_SLEW_PER_SECOND * this.frameDeltaSeconds;
      const driverStepX = this.inertiaDriverX - previousDriverX;
      const driverStepY = this.inertiaDriverY - previousDriverY;
      const driverStepZ = this.inertiaDriverZ - previousDriverZ;
      const driverStepMagnitude = Math.hypot(driverStepX, driverStepY, driverStepZ);
      if (driverStepMagnitude > maxDriverStep && driverStepMagnitude > 1e-9) {
        const driverStepScale = maxDriverStep / driverStepMagnitude;
        this.inertiaDriverX = previousDriverX + driverStepX * driverStepScale;
        this.inertiaDriverY = previousDriverY + driverStepY * driverStepScale;
        this.inertiaDriverZ = previousDriverZ + driverStepZ * driverStepScale;
      }
      this.previousModelWorldX = this.modelWorldX;
      this.previousModelWorldY = this.modelWorldY;
      this.previousModelWorldZ = this.modelWorldZ;
    }
    this.monotonicSeconds += this.frameDeltaSeconds;
  }

  requestHardReset(reason: string): void {
    const normalized = reason.trim();
    this.pendingHardResetReason = normalized || 'explicit-recovery';
  }

  step(context: MmdPhysicsStepContext): MmdPhysicsStepResult {
    if (this.rebaseIdentityOnNextStep) {
      // Preserve the delegate's object identity while refreshing the parsed
      // descriptor values for the new VMD runtime. Replacing these arrays
      // makes Bullet rebuild equivalent chains; mutating the stable objects
      // keeps the existing world and its accumulated hair/clothing velocity.
      if (this.canonicalRigidBodies && context.rigidBodies
        && this.canonicalRigidBodies.length === context.rigidBodies.length) {
        for (let index = 0; index < context.rigidBodies.length; index += 1) {
          Object.assign(this.canonicalRigidBodies[index], context.rigidBodies[index]);
        }
      } else if (context.rigidBodies) {
        this.canonicalRigidBodies = context.rigidBodies;
      }
      if (this.canonicalJoints && context.joints
        && this.canonicalJoints.length === context.joints.length) {
        for (let index = 0; index < context.joints.length; index += 1) {
          Object.assign(this.canonicalJoints[index], context.joints[index]);
        }
      } else if (context.joints) {
        this.canonicalJoints = context.joints;
      }
      this.rebaseIdentityOnNextStep = false;
    }
    const previousInputSeconds = this.lastInputSeconds;
    const loopWrapped = previousInputSeconds !== null && context.seconds < previousInputSeconds;
    const timelineStalled = previousInputSeconds !== null
      && Math.abs(context.seconds - previousInputSeconds) <= 1e-7
      && this.frameDeltaSeconds > 0;
    if (loopWrapped) {
      this.loopWrapCount += 1;
      this.clockContinuityActive = true;
    }
    if (timelineStalled) this.clockContinuityActive = true;
    this.lastInputSeconds = context.seconds;

    if (!this.clockContinuityActive && !loopWrapped && !timelineStalled) {
      // Keep the adapter clock aligned with ordinary clip time so a later
      // loop boundary can continue from the visible clip's last timestamp.
      this.monotonicSeconds = Math.max(this.monotonicSeconds, context.seconds);
      return this.stepDelegateInModelSpace(context);
    }

    const canonicalRigidBodies = this.canonicalRigidBodies ?? context.rigidBodies;
    const canonicalJoints = this.canonicalJoints ?? context.joints;
    if (!this.canonicalRigidBodies) this.canonicalRigidBodies = canonicalRigidBodies;
    if (!this.canonicalJoints) this.canonicalJoints = canonicalJoints;
    if (canonicalRigidBodies !== context.rigidBodies || canonicalJoints !== context.joints) {
      this.stabilizedModelIdentityCount += 1;
    }
    const continuousContext: MmdPhysicsStepContext = {
      ...context,
      seconds: this.monotonicSeconds,
      deltaSeconds: this.frameDeltaSeconds,
      frame: this.monotonicSeconds * context.frameRate,
      rigidBodies: canonicalRigidBodies,
      joints: canonicalJoints,
      seeking: false
    };
    return this.stepDelegateInModelSpace(continuousContext);
  }

  private stepDelegateInModelSpace(context: MmdPhysicsStepContext): MmdPhysicsStepResult {
    const physicsContext = this.applyBoneRotationOverlays(
      this.applyDisabledBoneToggles(this.normalizePhysicsResponse(context))
    );
    const input = physicsContext.inputWorldMatricesColumnMajor;
    if (!this.modelWorldInitialized || !input || input.length === 0) {
      this.lastStepContext = physicsContext;
      this.lastDelegatedSeconds = physicsContext.seconds;
      const result = this.delegate.step(physicsContext);
      this.stabilizeDynamicOutput(physicsContext);
      return result;
    }

    if (this.shiftedInputWorldMatrices.length !== input.length) {
      this.shiftedInputWorldMatrices = new Float32Array(input.length);
    }
    this.shiftedInputWorldMatrices.set(input);
    const transitionSettling = this.transitionActive || this.transitionSettleSeconds > 0;
    const hadPreviousPhysicsInput = this.previousPhysicsInputMatrices.length === input.length
      && input.length > 0;
    if (this.previousPhysicsInputMatrices.length !== input.length) {
      this.previousPhysicsInputMatrices = new Float32Array(input.length);
    }
    if (transitionSettling && hadPreviousPhysicsInput) {
        // Smooth the parent matrices presented to Bullet for the short
        // speech/body handoff window. Rendered bones remain untouched; this
        // only prevents a freshly bound VMD pose from injecting a one-frame
        // velocity into attached hair and clothing rigid bodies.
        for (let index = 0; index < input.length; index += 1) {
          this.shiftedInputWorldMatrices[index] = this.previousPhysicsInputMatrices[index]
            + (this.shiftedInputWorldMatrices[index] - this.previousPhysicsInputMatrices[index])
              * TRANSITION_INPUT_BLEND_ALPHA;
        }
    }
    this.previousPhysicsInputMatrices.set(input);
    this.updateRootTransforms();
    const inputMatricesIncludeModelWorld = this.detectInputMatricesIncludeModelWorld(physicsContext);
    this.lastInputMatrixSpace = inputMatricesIncludeModelWorld ? 'scene-world' : 'model-local';
    for (let base = 0; base + 15 < this.shiftedInputWorldMatrices.length; base += 16) {
      this.matrixScratch.fromArray(this.shiftedInputWorldMatrices, base);
      if (inputMatricesIncludeModelWorld) {
        this.matrixScratch.premultiply(this.inverseRootTransform);
      }
      this.matrixScratch
        .premultiply(this.inertiaTransform)
        .toArray(this.shiftedInputWorldMatrices, base);
    }

    const localContext: MmdPhysicsStepContext = {
      ...physicsContext,
      inputWorldMatricesColumnMajor: this.shiftedInputWorldMatrices
    };
    const result = this.delegate.step(localContext);
    this.stabilizeDynamicOutput(localContext);
    this.lastDelegatedSeconds = localContext.seconds;
    if (inputMatricesIncludeModelWorld) {
      this.restoreSceneWorldOutput(context, result.updatedBoneCount);
    }
    this.lastStepContext = localContext;
    return result;
  }

  private applyBoneRotationOverlays(context: MmdPhysicsStepContext): MmdPhysicsStepContext {
    const input = context.inputWorldMatricesColumnMajor;
    const bones = context.skeleton?.bones;
    if (this.boneRotationOverlays.size === 0 || !input || !bones || input.length === 0) return context;
    if (this.overlaidInputWorldMatrices.length !== input.length) {
      this.overlaidInputWorldMatrices = new Float32Array(input.length);
    }
    this.overlaidInputWorldMatrices.set(input);

    const bonesByIndex = new Map(bones.map(bone => [bone.index, bone]));
    const applied = new Set<number>();
    const applyAt = (boneIndex: number): void => {
      if (applied.has(boneIndex)) return;
      const bone = bonesByIndex.get(boneIndex);
      if (!bone) return;
      const delta = typeof bone.name === 'string' ? this.boneRotationOverlays.get(bone.name) : undefined;
      if (!delta) return;
      const offset = boneIndex * 16;
      if (offset < 0 || input.length < offset + 16) return;
      const parentIndex = typeof bone.parentIndex === 'number' ? bone.parentIndex : -1;
      if (parentIndex >= 0) applyAt(parentIndex);
      this.overlayWorldScratch.fromArray(input, offset);
      this.overlayDeltaScratch.makeRotationFromQuaternion(delta);
      if (parentIndex >= 0 && input.length >= parentIndex * 16 + 16) {
        this.overlayParentWorldScratch.fromArray(input, parentIndex * 16).invert();
        this.overlayLocalScratch.copy(this.overlayParentWorldScratch).multiply(this.overlayWorldScratch);
        this.overlayParentWorldScratch.fromArray(this.overlaidInputWorldMatrices, parentIndex * 16);
        this.overlayWorldScratch.copy(this.overlayParentWorldScratch)
          .multiply(this.overlayLocalScratch)
          .multiply(this.overlayDeltaScratch);
      } else {
        this.overlayWorldScratch.multiply(this.overlayDeltaScratch);
      }
      this.overlayWorldScratch.toArray(this.overlaidInputWorldMatrices, offset);
      applied.add(boneIndex);
    };
    for (const bone of bones) applyAt(bone.index);
    return { ...context, inputWorldMatricesColumnMajor: this.overlaidInputWorldMatrices };
  }

  /**
   * ThreeMmdLoader normally supplies scene-world bone matrices, but its
   * transform-after-physics path composes a model-local pre-physics skeleton.
   * Removing the desktop root from that second form subtracts the drag twice
   * and leaves light hair/clothing chains behind in scene space.
   */
  private detectInputMatricesIncludeModelWorld(context: MmdPhysicsStepContext): boolean {
    const inputWorld = context.inputWorldMatricesColumnMajor;
    const inputTranslations = context.inputTranslations;
    const rootBone = context.skeleton?.bones.find(bone =>
      bone.index >= 0 && (bone.parentIndex === undefined || bone.parentIndex < 0));
    if (!inputWorld || !inputTranslations || !rootBone) return true;
    const matrixOffset = rootBone.index * 16;
    const translationOffset = rootBone.index * 3;
    if (inputWorld.length < matrixOffset + 16
      || inputTranslations.length < translationOffset + 3
      || Math.abs(inputWorld[matrixOffset + 15]) <= 1e-7) return true;

    this.inputSpacePositionScratch.set(
      inputWorld[matrixOffset + 12],
      inputWorld[matrixOffset + 13],
      inputWorld[matrixOffset + 14]
    );
    this.inputSpaceExpectedScratch.set(
      inputTranslations[translationOffset],
      inputTranslations[translationOffset + 1],
      inputTranslations[translationOffset + 2]
    );
    const modelLocalDistance = this.inputSpacePositionScratch.distanceTo(this.inputSpaceExpectedScratch);
    if (modelLocalDistance <= 1e-4) return false;

    this.inputSpaceExpectedScratch.applyMatrix4(this.rootTransform);
    const sceneWorldDistance = this.inputSpacePositionScratch.distanceTo(this.inputSpaceExpectedScratch);
    return sceneWorldDistance + 1e-4 < modelLocalDistance;
  }

  /** Record dynamic output for diagnostics without rewriting PMX/Bullet output. */
  private stabilizeDynamicOutput(context: MmdPhysicsStepContext): void {
    const output = context.output?.worldMatricesColumnMajor;
    const rigidBodies = context.rigidBodies;
    const inputWorld = context.inputWorldMatricesColumnMajor;
    if (!rigidBodies || !output || !inputWorld) return;
    const dynamicBoneIndices = new Set<number>();
    for (const body of rigidBodies) {
      if (body.motionType !== 'static'
        && typeof body.boneIndex === 'number'
        && body.boneIndex >= 0) {
        dynamicBoneIndices.add(body.boneIndex);
      }
    }
    for (const boneIndex of dynamicBoneIndices) {
      const offset = boneIndex * 16;
      if (offset < 0
        || output.length < offset + 16
        || inputWorld.length < offset + 16
        || Math.abs(output[offset + 15]) <= 1e-7
        || Math.abs(inputWorld[offset + 15]) <= 1e-7) continue;

      this.matrixScratch.fromArray(output, offset);
      this.matrixScratch.decompose(
        this.currentPositionScratch,
        this.currentRotationScratch,
        this.currentScaleScratch
      );
      const previous = this.previousDynamicOutputMatrices.get(boneIndex);
      if (previous) {
        previous.decompose(
          this.observedPreviousPositionScratch,
          this.previousRotationScratch,
          this.previousScaleScratch
        );
        const observedStep = this.observedPreviousPositionScratch.distanceTo(this.currentPositionScratch);
        this.maxRawDynamicOutputStep = Math.max(this.maxRawDynamicOutputStep, observedStep);
        this.maxAppliedDynamicOutputStep = Math.max(this.maxAppliedDynamicOutputStep, observedStep);
      }
      const stored = previous ?? new THREE.Matrix4();
      stored.copy(this.matrixScratch);
      this.previousDynamicOutputMatrices.set(boneIndex, stored);

      this.parentWorldScratch.fromArray(inputWorld, offset).decompose(
        this.previousPositionScratch,
        this.previousRotationScratch,
        this.previousScaleScratch
      );
      this.latestRelativePhysicsDisplacements.set(boneIndex, [
        this.currentPositionScratch.x - this.previousPositionScratch.x,
        this.currentPositionScratch.y - this.previousPositionScratch.y,
        this.currentPositionScratch.z - this.previousPositionScratch.z
      ]);
    }
  }

  private normalizePhysicsResponse(context: MmdPhysicsStepContext): MmdPhysicsStepContext {
    const source = context.rigidBodies;
    const jointSource = context.joints;
    // The runtime receives the profiled clone back on subsequent frames.
    // Treat that clone as the canonical normalized source; otherwise the
    // clothing profile is reclassified and recloned every frame, which can
    // stall startup and consume a full physics-frame budget continuously.
    const sourceIsProfiledClone = source !== undefined
      && source === this.normalizedRigidBodies
      && this.secondaryMaterialProfileActive;
    if (source && source !== this.normalizedRigidBodySource && !sourceIsProfiledClone) {
      this.normalizedRigidBodySource = source;
      const authoredMasses = source
        .filter(body => body.motionType !== 'static' && typeof body.mass === 'number' && body.mass > 0)
        .map(body => body.mass as number);
      this.authoredDynamicMedianMass = median(authoredMasses);
      // User decision: uniform Yangyang-reference dragging response for every
      // rig, present and future (see top-of-file comment).
      this.rootInertiaScale = 1;
      // Preserve each PMX author's rigid-body mass and damping. Earlier code
      // forced Selena's median mass from 6.7 to Yangyang's 0.405 and multiplied
      // authored springs by three; that changed the character's established
      // hair/clothing rig into a long elastic oscillator. Cross-model
      // consistency belongs in the shared clock/root-drag algorithm, not by
      // rewriting model material parameters.
      this.dynamicMassScale = 1;
      this.linearDampingScale = 1;
      this.angularDampingScale = 1;
      this.normalizedRigidBodies = source;
      this.previousDynamicOutputMatrices.clear();
      this.effectiveDynamicMedianMass = median(source
        .filter(body => body.motionType !== 'static' && typeof body.mass === 'number' && body.mass > 0)
        .map(body => body.mass as number));
    }

    if (jointSource && jointSource !== this.normalizedJointSource && !sourceIsProfiledClone) {
      this.normalizedJointSource = jointSource;
      const authoredSprings = jointSource.flatMap(joint =>
        [...(joint.spring?.angular ?? [])]
          .map(value => Math.abs(value))
          .filter(value => value > 0));
      this.authoredAngularSpringMedian = median(authoredSprings);
      this.angularSpringScale = 1;
      this.normalizedJoints = jointSource;
      this.effectiveAngularSpringMedian = median(jointSource
        .flatMap(joint => [...(joint.spring?.angular ?? [])]
          .map(value => Math.abs(value))
        .filter(value => value > 0)));
    }

    // Apply the shared topology profile at the exact boundary where the
    // parsed PMX descriptors enter Bullet. The source arrays remain untouched;
    // only selected non-root secondary bodies are cloned with bounded damping.
    if (source && !sourceIsProfiledClone && (source !== this.normalizedMaterialBodySource
      || jointSource !== this.normalizedMaterialJointSource
      || context.skeleton !== this.normalizedMaterialSkeletonSource)) {
      const profiled = applySecondaryMaterialProfile({
        skeleton: context.skeleton,
        rigidBodies: source,
        joints: jointSource
      });
      this.normalizedRigidBodies = profiled.rigidBodies ?? source;
      // The shared secondary profile may also materialize a small restoring
      // spring for imported hair joints whose PMX spring factors are all zero.
      // Keep the cloned joint array paired with the profiled rigid bodies so
      // Bullet receives both halves of the normalized topology.
      this.normalizedJoints = profiled.joints ?? jointSource;
      this.normalizedMaterialJointSource = jointSource;
      this.normalizedMaterialSkeletonSource = context.skeleton;
      this.normalizedMaterialBodySource = source;
      this.secondaryMaterialProfileActive = profiled.adjustedBodyIndices.length > 0
        || profiled.joints !== jointSource
        || profiled.decorativeCollisionBoneIndices.length > 0;
      this.secondaryMaterialAdjustedBodyCount = profiled.adjustedBodyIndices.length;
      this.decorativeCollisionDisabledBodyCount = profiled.decorativeCollisionBoneIndices.length;
    }

    const rigidBodies = source ? this.normalizedRigidBodies : source;
    const joints = jointSource ? this.normalizedJoints : jointSource;
    if (rigidBodies === source && joints === jointSource) return context;
    return { ...context, rigidBodies, joints };
  }

  private applyDisabledBoneToggles(context: MmdPhysicsStepContext): MmdPhysicsStepContext {
    if (this.disabledBoneNames.size === 0 || !context.skeleton) return context;

    const disabledIndices = context.skeleton.bones
      .filter(bone => typeof bone.name === 'string'
        && this.disabledBoneNames.has(bone.name)
        && bone.index >= 0)
      .map(bone => bone.index);
    if (disabledIndices.length === 0) return context;

    const incoming = context.bonePhysicsToggles;
    const requiredLength = Math.max(
      incoming?.length ?? 0,
      ...disabledIndices.map(index => index + 1)
    );
    const toggles = new Uint8Array(requiredLength);
    toggles.fill(1);
    if (incoming) {
      for (let index = 0; index < incoming.length; index += 1) {
        toggles[index] = incoming[index] ? 1 : 0;
      }
    }
    for (const index of disabledIndices) toggles[index] = 0;

    return { ...context, bonePhysicsToggles: toggles };
  }

  private restoreSceneWorldOutput(context: MmdPhysicsStepContext, updatedBoneCount?: number): void {
    const output = context.output?.worldMatricesColumnMajor;
    if (!output) return;
    const updatedIndices = context.output?.updatedBoneIndices;
    if (updatedIndices && updatedBoneCount && updatedBoneCount > 0) {
      const count = Math.min(updatedBoneCount, updatedIndices.length);
      for (let index = 0; index < count; index += 1) {
        this.addModelWorldOffset(output, updatedIndices[index] * 16);
      }
      return;
    }
    for (let base = 0; base + 15 < output.length; base += 16) {
      if (Math.abs(output[base + 15]) > 1e-6) this.addModelWorldOffset(output, base);
    }
  }

  private addModelWorldOffset(
    output: NonNullable<MmdPhysicsStepContext['output']>['worldMatricesColumnMajor'],
    base: number
  ): void {
    if (!output || base < 0 || base + 14 >= output.length) return;
    this.updateRootTransforms();
    this.matrixScratch.fromArray(output, base)
      .premultiply(this.rootTransform)
      .toArray(output, base);
  }

  private updateRootTransforms(): void {
    // Physics matrices use MMD's mirrored Z convention, so scene yaw changes sign.
    this.rootTransform.makeRotationY(-this.modelWorldYaw);
    this.rootTransform.setPosition(this.modelWorldX, this.modelWorldY, -this.modelWorldZ);
    this.inverseRootTransform.copy(this.rootTransform).invert();
    this.inertiaTransform.makeTranslation(
      this.inertiaDriverX,
      this.inertiaDriverY,
      -this.inertiaDriverZ
    );
  }

  reset(context?: MmdPhysicsResetContext): void {
    const resetInputSeconds = context?.seconds;
    const timelineRewind = this.pendingHardResetReason === null
      && this.lastInputSeconds !== null
      && typeof resetInputSeconds === 'number'
      && resetInputSeconds + 1e-7 < this.lastInputSeconds;
    const shouldForward = this.pendingHardResetReason !== null
      || (!this.speechContinuityActive && !timelineRewind);
    if (!shouldForward) {
      this.suppressedResetCount += 1;
      if (this.rebaseIdentityOnNextSuppressedReset) {
        // This is a clip bind, not a Bullet reset. Reusing the previous
        // speech session's metadata arrays here makes a newly parsed runtime
        // run against stale body/joint objects for its entire reply. Adopt
        // the arrays supplied by the next step while preserving Bullet state.
        this.rebaseIdentityOnNextStep = true;
        this.rebaseIdentityOnNextSuppressedReset = false;
      }
      if (timelineRewind) this.clockContinuityActive = true;
      return;
    }

    const reason = this.pendingHardResetReason
      ?? (this.forwardedResetCount === 0 ? 'initial-model-bind' : 'passthrough-reset');
    const keepContinuousClock = this.speechContinuityActive;
    const resetSeconds = keepContinuousClock
      ? this.monotonicSeconds
      : context?.seconds ?? this.monotonicSeconds;
    this.delegate.reset?.(context
      ? { ...context, seconds: resetSeconds }
      : undefined);
    // The next evaluate after a real reset/setAnimation is a new clip bind,
    // not a loop wrap. Preserve the delegate's normal first-frame seek path.
    this.lastInputSeconds = null;
    this.monotonicSeconds = resetSeconds;
    this.clockContinuityActive = keepContinuousClock;
    this.canonicalRigidBodies = undefined;
    this.canonicalJoints = undefined;
    // A hard reset is also the model/runtime identity boundary.  Do not let
    // the previous model's profiled rigid-body clone or decorative-collision
    // diagnostics leak into the next bind (especially when a loader reuses
    // descriptor-array instances).
    this.normalizedRigidBodySource = undefined;
    this.normalizedRigidBodies = undefined;
    this.normalizedJointSource = undefined;
    this.normalizedJoints = undefined;
    this.normalizedMaterialBodySource = undefined;
    this.normalizedMaterialJointSource = undefined;
    this.normalizedMaterialSkeletonSource = undefined;
    this.secondaryMaterialProfileActive = false;
    this.secondaryMaterialAdjustedBodyCount = 0;
    this.decorativeCollisionDisabledBodyCount = 0;
    this.previousDynamicOutputMatrices.clear();
    this.previousPhysicsInputMatrices = new Float32Array(0);
    this.latestRelativePhysicsDisplacements.clear();
    this.transitionActive = false;
    this.transitionSettleSeconds = 0;
    this.rootDragSettleSeconds = 0;
    this.pendingHardResetReason = null;
    this.rebaseIdentityOnNextSuppressedReset = false;
    this.rebaseIdentityOnNextStep = false;
    this.forwardedResetCount += 1;
    this.lastHardResetReason = reason;
  }

  diagnostics(): readonly MmdPhysicsDiagnostic[] {
    return this.delegate.diagnostics?.() ?? [];
  }

  debugRigidBodyWorldTransformsColumnMajor(): readonly MmdPhysicsMatrix4ColumnMajorTuple[] {
    return this.delegate.debugRigidBodyWorldTransformsColumnMajor?.() ?? [];
  }

  debugBonePhysicsPipeline(boneNames: readonly string[]): readonly BonePhysicsPipelineSnapshot[] {
    const context = this.lastStepContext;
    if (!context?.skeleton) return [];

    const bodyMatrices = this.delegate.debugRigidBodyWorldTransformsColumnMajor?.() ?? [];
    const dynamicBoneIndices = new Set((context.rigidBodies ?? [])
      .filter(body => body.motionType !== 'static' && typeof body.boneIndex === 'number')
      .map(body => body.boneIndex as number));
    const snapshots: BonePhysicsPipelineSnapshot[] = [];
    for (const requestedName of boneNames) {
      const namedBone: (typeof context.skeleton.bones)[number] | undefined =
        context.skeleton.bones.find(bone => bone.name === requestedName);
      const namedBody = (context.rigidBodies ?? []).find(body => body.name === requestedName);
      const boneIndex = namedBone?.index ?? namedBody?.boneIndex;
      if (boneIndex === undefined || boneIndex < 0) continue;
      const bone = context.skeleton.bones[boneIndex];
      if (!bone) continue;
      const parentBoneIndex = typeof bone.parentIndex === 'number' && bone.parentIndex >= 0
        ? bone.parentIndex
        : null;
      const rigidBodies = (context.rigidBodies ?? [])
        .filter(body => body.boneIndex === boneIndex)
        .map(body => ({
          rigidBodyIndex: body.index,
          rigidBodyName: body.name ?? null,
          motionType: body.motionType,
          worldMatrixColumnMajor: bodyMatrices[body.index] ?? null
        }));
      snapshots.push({
        boneName: requestedName,
        boneIndex,
        parentBoneIndex,
        anchoredToAnimatedParent: parentBoneIndex === null || !dynamicBoneIndices.has(parentBoneIndex),
        physicsEnabled: context.bonePhysicsToggles?.[boneIndex] !== 0,
        rigidBodies,
        inputWorldMatrixColumnMajor: readMatrix(context.inputWorldMatricesColumnMajor, boneIndex),
        outputWorldMatrixColumnMajor: readMatrix(context.output?.worldMatricesColumnMajor, boneIndex),
        relativePhysicsDisplacement: this.latestRelativePhysicsDisplacements.get(boneIndex) ?? null
      });
    }
    return snapshots;
  }

  diagnosticsState(): ContinuousPhysicsDiagnostics {
    return {
      forwardedResetCount: this.forwardedResetCount,
      suppressedResetCount: this.suppressedResetCount,
      loopWrapCount: this.loopWrapCount,
      monotonicSeconds: this.monotonicSeconds,
      lastStepDeltaSeconds: this.frameDeltaSeconds,
      lastHardResetReason: this.lastHardResetReason,
      speechContinuityActive: this.speechContinuityActive,
      stabilizedModelIdentityCount: this.stabilizedModelIdentityCount,
      clockContinuityActive: this.clockContinuityActive,
      lastDelegatedSeconds: this.lastDelegatedSeconds,
      modelWorldOffset: [this.modelWorldX, this.modelWorldY, this.modelWorldZ],
      modelWorldYaw: this.modelWorldYaw,
      rootInertiaDriver: [this.inertiaDriverX, this.inertiaDriverY, this.inertiaDriverZ],
      authoredDynamicMedianMass: this.authoredDynamicMedianMass,
      effectiveDynamicMedianMass: this.effectiveDynamicMedianMass,
      dynamicMassScale: this.dynamicMassScale,
      authoredAngularSpringMedian: this.authoredAngularSpringMedian,
      effectiveAngularSpringMedian: this.effectiveAngularSpringMedian,
      angularSpringScale: this.angularSpringScale,
      rootInertiaScale: this.rootInertiaScale,
      transitionStabilizationActive: this.transitionActive || this.transitionSettleSeconds > 0,
      transitionSettleRemainingSeconds: this.transitionSettleSeconds,
      rootDragStabilizationActive: this.rootDragSettleSeconds > 0,
      rootDragSettleRemainingSeconds: this.rootDragSettleSeconds,
      clampedDynamicOutputCount: this.clampedDynamicOutputCount,
      clampedRootDragOutputCount: this.clampedRootDragOutputCount,
      maxRawDynamicOutputStep: this.maxRawDynamicOutputStep,
      maxAppliedDynamicOutputStep: this.maxAppliedDynamicOutputStep,
      lastInputMatrixSpace: this.lastInputMatrixSpace,
      secondaryMaterialProfileActive: this.secondaryMaterialProfileActive,
      secondaryMaterialAdjustedBodyCount: this.secondaryMaterialAdjustedBodyCount,
      decorativeCollisionDisabledBodyCount: this.decorativeCollisionDisabledBodyCount
    };
  }

  dispose(): void {
    this.delegate.dispose?.();
  }
}

function clampRootInertia(value: number): number {
  return Math.max(-MAX_ROOT_INERTIA_OFFSET, Math.min(MAX_ROOT_INERTIA_OFFSET, value));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function createContinuousMmdPhysicsBackend(
  delegate: MmdPhysicsBackend
): ContinuousMmdPhysicsBackend {
  return new ContinuousMmdPhysicsBackendImpl(delegate);
}

function readMatrix(
  buffer: readonly number[] | Float32Array | Float64Array | undefined,
  index: number
): MmdPhysicsMatrix4ColumnMajorTuple | null {
  const offset = index * 16;
  if (!buffer || index < 0 || buffer.length < offset + 16) return null;
  return [
    buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3],
    buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7],
    buffer[offset + 8], buffer[offset + 9], buffer[offset + 10], buffer[offset + 11],
    buffer[offset + 12], buffer[offset + 13], buffer[offset + 14], buffer[offset + 15]
  ];
}
