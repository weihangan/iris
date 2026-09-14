import {
  loadCustomBulletMmdModule,
  createCustomBulletMmdPhysicsBackend,
  type CustomBulletMmdModule,
  type CustomBulletMmdPhysicsBackendOptions,
  type CustomBulletMmdLoaderOptions,
} from '@yohawing/three-mmd-loader/physics';
import type { MmdPhysicsBackend } from '@yohawing/three-mmd-loader/physics';
import { FallbackCore } from '@yohawing/three-mmd-loader';
import {
  createContinuousMmdPhysicsBackend,
  type ContinuousMmdPhysicsBackend
} from './continuous-mmd-physics-backend';

let bulletModule: CustomBulletMmdModule | null = null;
let bulletBackend: ContinuousMmdPhysicsBackend | null = null;

let bulletLoadPromise: Promise<void> | null = null;
let bulletLoadError: unknown = null;

export interface PmxPhysicsAudit {
  hasRigidBodies: boolean;
  hasJoints: boolean;
  rigidBodyCount: number;
  jointCount: number;
  dynamicBoneNames: Set<string>;
  dynamicBoneCount: number;
}

export interface AvatarPhysicsRuntimeOptions {
  readonly scriptUrl?: string;
  readonly backendOptions?: CustomBulletMmdPhysicsBackendOptions;
}

export interface ModelDynamicBonePolicyInput {
  readonly packId?: string;
  readonly pmxSha256?: string;
  readonly dynamicBoneNames?: Iterable<string>;
}

// The wedding Selena PMX has two rear skirt rings (スカート_11/12) whose
// authored rigid-body chains can oscillate while the model is otherwise
// standing still. Keep this exception narrow: it is selected by the exact
// imported PMX hashes and then intersected with bones actually present in the
// loaded model, so no other character or future similarly named rig is changed.
const WEDDING_SELENA_PMXS = new Set([
  '490875E333C2B3A3A09BA5D5D49580B10F04FF93532CEAFA2B7585F13FFCF9CD',
  '1FD678067B9B60448BDEA990A70BBA3F67A6C366488C1620369E56602EEA14BA'
]);
const WEDDING_REAR_SKIRT_BONE = /^(?:左后裙子|右后裙子|スカート_(?:11|12)_(?:[0-9]+))$/;

/**
 * Returns only the rear-skirt bones that need the wedding Selena stability
 * guard. The result is empty for every other model, preserving the shared
 * physics policy and the existing speech/action runtime.
 */
export function resolveModelSpecificDisabledDynamicBones(
  input: ModelDynamicBonePolicyInput
): readonly string[] {
  const sha = typeof input.pmxSha256 === 'string'
    ? input.pmxSha256.trim().toUpperCase()
    : '';
  const packId = typeof input.packId === 'string' ? input.packId : '';
  const isWeddingSelena = WEDDING_SELENA_PMXS.has(sha)
    || /^imported-赛琳娜婚皮-/i.test(packId);
  if (!isWeddingSelena) return [];
  return [...new Set(input.dynamicBoneNames ?? [])]
    .filter(name => WEDDING_REAR_SKIRT_BONE.test(name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** All current and future models use the same enabled-dynamic-bone policy. */
export function resolveUnifiedDynamicBonePolicy(_configured?: readonly string[]): readonly string[] {
  return [];
}

const BULLET_SCRIPT_PATH = './mmd/mmd_bullet.js';

export function getBulletBackend(): ContinuousMmdPhysicsBackend | null {
  return bulletBackend;
}

export function getBulletModule(): CustomBulletMmdModule | null {
  return bulletModule;
}

export function getBulletLoadError(): unknown {
  return bulletLoadError;
}

export async function loadBulletPhysics(
  options?: AvatarPhysicsRuntimeOptions
): Promise<ContinuousMmdPhysicsBackend | null> {
  if (bulletBackend) return bulletBackend;
  if (bulletLoadError) return null;

  if (bulletLoadPromise) {
    await bulletLoadPromise;
    return bulletBackend;
  }

  bulletLoadPromise = (async () => {
    try {
      const scriptUrl = options?.scriptUrl ?? BULLET_SCRIPT_PATH;
      bulletModule = await loadCustomBulletMmdModule({ scriptUrl });
      const rawBackend: MmdPhysicsBackend = createCustomBulletMmdPhysicsBackend(
        bulletModule,
        options?.backendOptions
      );
      bulletBackend = createContinuousMmdPhysicsBackend(rawBackend);
    } catch (e) {
      bulletLoadError = e;
      console.warn('[physics] Bullet load failed, physics disabled:', e);
      bulletModule = null;
      bulletBackend = null;
    }
  })();

  await bulletLoadPromise;
  return bulletBackend;
}

export function auditPmxPhysics(pmxBytes: Uint8Array): PmxPhysicsAudit {
  const result: PmxPhysicsAudit = {
    hasRigidBodies: false,
    hasJoints: false,
    rigidBodyCount: 0,
    jointCount: 0,
    dynamicBoneNames: new Set(),
    dynamicBoneCount: 0,
  };

  let model: ReturnType<FallbackCore['loadModel']> | undefined;
  try {
    model = new FallbackCore().loadModel(pmxBytes, { format: 'pmx' });
    const metadata = model.metadata();
    const bones = model.skeleton().bones;
    const rigidBodies = model.rigidBodies();
    const joints = model.joints();

    result.rigidBodyCount = metadata.counts.rigidBodies;
    result.jointCount = metadata.counts.joints;
    result.hasRigidBodies = rigidBodies.length > 0;
    result.hasJoints = joints.length > 0;

    for (const body of rigidBodies) {
      if (body.mode !== 'dynamic' && body.mode !== 'dynamicBone') continue;
      if (body.boneIndex < 0 || body.boneIndex >= bones.length) continue;
      result.dynamicBoneNames.add(bones[body.boneIndex].name);
    }
    result.dynamicBoneCount = result.dynamicBoneNames.size;
    console.log('[physics] PMX audit (FallbackCore): bones=', bones.length, 'rigidBodies=', result.rigidBodyCount, 'dynamicRBs=', rigidBodies.filter(b => b.mode === 'dynamic' || b.mode === 'dynamicBone').length, 'joints=', result.jointCount, 'dynamicBoneNames=', result.dynamicBoneCount);
    return result;
  } catch (e) {
    console.warn('[physics] PMX audit failed:', e);
    return result;
  } finally {
    model?.dispose?.();
  }
}

export function disposeBulletPhysics(): void {
  if (bulletBackend) {
    try { bulletBackend.dispose?.(); } catch { /* ignore */ }
    bulletBackend = null;
  }
  bulletModule = null;
  bulletLoadPromise = null;
  bulletLoadError = null;
}
