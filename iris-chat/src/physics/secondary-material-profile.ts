import type {
  MmdPhysicsJoint,
  MmdPhysicsRigidBody,
  MmdPhysicsSkeleton
} from '@yohawing/three-mmd-loader/physics';

/** Shared material limits for PMX secondary motion. */
export const DEFAULT_SECONDARY_MATERIAL_PROFILE = Object.freeze({
  // A moderate reduction is enough to wake imported chains whose PMX damping
  // is near one. Keeping the floor/high ceiling conservative preserves the
  // existing fast-drag distinction and prevents a long strand from launching.
  minimumResponsiveLinearDamping: 0.88,
  minimumResponsiveAngularDamping: 0.89,
  linearDampingScale: 0.96,
  angularDampingScale: 0.96,
  maximumLinearDamping: 0.96,
  maximumAngularDamping: 0.96,
  // Some imported PMX rigs omit all joint springs for hair/clothing. Their
  // chain roots are still dynamic, but the authored damping (often 0.9~1)
  // makes gravity almost invisible. Wake only those springless components;
  // spring-authored rigs keep the conservative profile above.
  //
  // 2026-08 调优（婚皮/Q 实测）：无弹簧 6DOF 关节没有恢复力，阻尼是唯一
  // 的振动抑制。此前 0.82/0.68~0.84 一刀切（含链根）带来三类回归——
  // 布条/裙摆持续高频抖动、袖根跟不上手臂动作、快速拖动链根甩出
  // （maxAttachmentLag 超标）。改为按锚点拓扑分三档：
  // 1) 手臂/腿锚定的组件（振袖、袖飘带）——"服装随肢体"语义，整链保持
  //    authored 阻尼（模型作者本就按跟手调参），完全不进入唤醒；
  // 2) 躯干/头锚定的链根——温和唤醒（裙摆/头发能下垂，但根部稳定）；
  // 3) 自由段（链中后段）——唤醒档收紧下限（0.78）：仍显著低于 authored
  //    （可飘可垂），但不再落到 0.68 引发无弹簧链的持续抖动。
  noSpringLinearDampingScale: 0.86,
  noSpringAngularDampingScale: 0.86,
  noSpringMinimumResponsiveLinearDamping: 0.78,
  noSpringMinimumResponsiveAngularDamping: 0.78,
  noSpringMaximumLinearDamping: 0.9,
  noSpringMaximumAngularDamping: 0.9,
  noSpringRootLinearDampingScale: 0.92,
  noSpringRootAngularDampingScale: 0.92,
  noSpringRootMinimumResponsiveLinearDamping: 0.86,
  noSpringRootMinimumResponsiveAngularDamping: 0.86,
  noSpringRootMaximumLinearDamping: 0.92,
  noSpringRootMaximumAngularDamping: 0.92,
  // Long-hair descendants in spring-authored rigs get a small, separate
  // response boost. Chain roots remain under the authored/attachment guard.
  hairLinearDampingScale: 0.95,
  hairAngularDampingScale: 0.95,
  hairMinimumResponsiveLinearDamping: 0.93,
  hairMinimumResponsiveAngularDamping: 0.98,
  // Keep the spring-authored legacy rigs restrained after their loader
  // skeletons gain correct parent-topology selection.  The no-spring light
  // band below remains the visible-response path for imported 汐光曳影 hair.
  hairMaximumLinearDamping: 0.97,
  hairMaximumAngularDamping: 1,
  // Heavy Chinese hair chains (for example 后发总) carry most of the
  // inertia. Do not lower their authored 0.9 damping; only the light
  // mid/tip bodies receive the airy response boost.
  hairHeavyMassThreshold: 4,
  hairHeavyMinimumResponsiveLinearDamping: 0.9,
  // Heavy hair still needs a visible rotational response during drag.  The
  // authored 0.999 values in several long-hair chains were previously forced
  // to 0.99 below, which made the hair look pinned while clothing remained
  // responsive.  Keep a conservative floor, but leave room for inertia.
  hairHeavyMinimumResponsiveAngularDamping: 0.9,
  // Some long-hair PMX chains (notably imported 汐光曳影 rigs) have no
  // authored springs and use tiny masses.  Once topology selects those
  // descendants, this light-only band makes drag speed visible without
  // loosening heavy roots or clothing chains.
  hairNoSpringLinearDampingScale: 0.88,
  hairNoSpringAngularDampingScale: 0.88,
  hairNoSpringMinimumResponsiveLinearDamping: 0.72,
  hairNoSpringMinimumResponsiveAngularDamping: 0.72,
  hairNoSpringMaximumLinearDamping: 0.9,
  hairNoSpringMaximumAngularDamping: 0.9,
  // Rear long-hair roots in the imported models have zero authored springs.
  // Give only the body-side anchor a light recovery force; the hair-to-hair
  // tail joints stay unsprung so the tips retain their natural swing.
  rearHairNoSpringAngularSpring: 2.5,
  rearHairNoSpringHeavyAngularSpring: 5,
  // Decorative ribbon/tassel tails should remain dynamic and gravity-driven,
  // but their tiny masses and zero-spring joints otherwise form a perpetual
  // numerical oscillator.  A narrow high-damping band absorbs that chatter
  // without freezing the chain or disabling physics altogether.
  ribbonMinimumLinearDamping: 0.94,
  ribbonMinimumAngularDamping: 0.96,
  ribbonMaximumLinearDamping: 0.985,
  ribbonMaximumAngularDamping: 0.99,
  // Sleeves are large cloth sheets anchored to fast-moving arms.  2026-08
  // 实测（婚皮振袖）：authored 阻尼 0.90~0.99+ 且此前被抬高到 0.94/0.96
  // 下限，重质量（15.5）+ 无弹簧关节让袖子看起来像刚性板。改为收窄到
  // 中等阻尼带（0.80~0.90）：保留足够的跟手性，同时让布料有惯性飘逸感。
  // 卡顿的真正来源是关节窄限制（振袖 Y 轴仅 ±5°），由
  // sleeveJointMinimumAngularLimitRadians 放宽解决。
  sleeveLinearDampingScale: 1.04,
  sleeveAngularDampingScale: 1.06,
  sleeveMinimumResponsiveLinearDamping: 0.80,
  sleeveMinimumResponsiveAngularDamping: 0.80,
  sleeveMaximumLinearDamping: 0.90,
  sleeveMaximumAngularDamping: 0.90,
  // 大袖布片 authored 质量普遍 8~16，远超头发/飘带（<4）。重质量让袖子
  // 在关节 solver 中呈现刚性惯量，调低后布料更容易被手臂带动且不易
  // 在限制边界挣扎。
  sleeveMassScale: 0.25,
  // 振袖关节 authored 限制在 Y 轴（布片弯扭方向）只有 ±5°。手臂合拢时
  // 袖链在该窄限制上挣扎，是"袖子卡顿/抖动"的直接来源。把每轴旋转
  // 限制对称放宽到至少 ±0.5236 rad（±30°），authored 更宽的轴不动。
  sleeveJointMinimumAngularLimitRadians: 0.5236,
  // 振袖关节全部无弹簧（spring=0），放宽限制后需要一点回正力防止布片
  // 长时间歪斜。参考后发链根部恢复力（2.5/5），袖子取中档。
  sleeveAngularSpring: 6
} as const);

export interface SecondaryMaterialProfileInput {
  readonly skeleton?: MmdPhysicsSkeleton;
  readonly rigidBodies?: readonly MmdPhysicsRigidBody[];
  readonly joints?: readonly MmdPhysicsJoint[];
}

export interface SecondaryMaterialProfileOptions {
  readonly minimumResponsiveLinearDamping?: number;
  readonly minimumResponsiveAngularDamping?: number;
  readonly linearDampingScale?: number;
  readonly angularDampingScale?: number;
  readonly maximumLinearDamping?: number;
  readonly maximumAngularDamping?: number;
  readonly noSpringLinearDampingScale?: number;
  readonly noSpringAngularDampingScale?: number;
  readonly noSpringMinimumResponsiveLinearDamping?: number;
  readonly noSpringMinimumResponsiveAngularDamping?: number;
  readonly noSpringMaximumLinearDamping?: number;
  readonly noSpringMaximumAngularDamping?: number;
  readonly noSpringRootLinearDampingScale?: number;
  readonly noSpringRootAngularDampingScale?: number;
  readonly noSpringRootMinimumResponsiveLinearDamping?: number;
  readonly noSpringRootMinimumResponsiveAngularDamping?: number;
  readonly noSpringRootMaximumLinearDamping?: number;
  readonly noSpringRootMaximumAngularDamping?: number;
  readonly hairLinearDampingScale?: number;
  readonly hairAngularDampingScale?: number;
  readonly hairMinimumResponsiveLinearDamping?: number;
  readonly hairMinimumResponsiveAngularDamping?: number;
  readonly hairMaximumLinearDamping?: number;
  readonly hairMaximumAngularDamping?: number;
  readonly hairHeavyMassThreshold?: number;
  readonly hairHeavyMinimumResponsiveLinearDamping?: number;
  readonly hairHeavyMinimumResponsiveAngularDamping?: number;
  readonly hairNoSpringLinearDampingScale?: number;
  readonly hairNoSpringAngularDampingScale?: number;
  readonly hairNoSpringMinimumResponsiveLinearDamping?: number;
  readonly hairNoSpringMinimumResponsiveAngularDamping?: number;
  readonly hairNoSpringMaximumLinearDamping?: number;
  readonly hairNoSpringMaximumAngularDamping?: number;
  readonly rearHairNoSpringAngularSpring?: number;
  readonly rearHairNoSpringHeavyAngularSpring?: number;
  readonly ribbonMinimumLinearDamping?: number;
  readonly ribbonMinimumAngularDamping?: number;
  readonly ribbonMaximumLinearDamping?: number;
  readonly ribbonMaximumAngularDamping?: number;
  readonly sleeveLinearDampingScale?: number;
  readonly sleeveAngularDampingScale?: number;
  readonly sleeveMinimumResponsiveLinearDamping?: number;
  readonly sleeveMinimumResponsiveAngularDamping?: number;
  readonly sleeveMaximumLinearDamping?: number;
  readonly sleeveMaximumAngularDamping?: number;
  readonly sleeveMassScale?: number;
  readonly sleeveJointMinimumAngularLimitRadians?: number;
  readonly sleeveAngularSpring?: number;
  /**
   * Some imported PMX files expose spring-authored hair with a loader
   * skeleton that does not carry numeric bone indices.  In that case the
   * conservative legacy classifier cannot prove the parent topology and
   * leaves the whole chain at its authored (often ~1.0) damping.  Opt in only
   * for a model family whose hair naming has been positively identified.
   */
  readonly selectSpringAuthoredHairWithoutNumericIndices?: boolean;
  /** Convert a PMX dynamic-with-bone hair chain to full dynamic output. */
  readonly dynamicWithBoneHairToDynamic?: boolean;
}

export interface SecondaryMaterialProfileResult {
  readonly rigidBodies: readonly MmdPhysicsRigidBody[] | undefined;
  readonly joints: readonly MmdPhysicsJoint[] | undefined;
  readonly adjustedBodyIndices: readonly number[];
  /** Bone indices whose small decorative rigid bodies have collisions disabled. */
  readonly decorativeCollisionBoneIndices: readonly number[];
}

// PMX hair rigs are not consistent about naming.  In particular the front
// fringe chains in the wedding and 汐光曳影 models are named BangsBoneL/M/R
// (or BangsBone##) instead of containing "hair"/"刘海".  Keep this token in
// the shared secondary classifier so those chains receive the same physics
// treatment as every other hair strand, without broadening the match to all
// dynamic bones.
const SECONDARY_NAME = /(?:hair|fur|shair|bhair|bangs?bone|bangs|jewel|jew|ribbon|tassel|sash|strap|tail|dress|cloth|skirt|cape|coat|frill|sleeve|缎带|细带|花带|飘带|带子|挂件|穗|绳|丝带|头发|发丝|刘海|前发|鬓|辫|发饰|发|饰|装饰|髪|毛|発|リボン|スカート|フリル|尾|衣摆|袖|裙摆|裙|衣装)/i;
const EXCLUDED_NAME = /(?:^|[-_\s])(?:leg|foot|toe|ik|body|center|hip|pelvis|spine|neck|head|face|eye|arm|hand|elbow|knee)(?:$|[-_\s])|(?:センター|上半身|下半身|腰|胴|腿|脚|足|膝|首|頭|顔|目|腕|手|肩|胸|背中)/i;
// 手臂/腿锚定的链根（振袖←左腕、袖飘带←袖子亲）：这些肢体在 VMD 动作中
// 快速大幅运动，组件是"服装随肢体"语义，authored 阻尼就是为跟手调的。
// 匹配锚点 static 碰撞体的刚体名或其骨骼名。
const LIMB_ANCHOR_NAME = /(?:^|[-_\s])(?:arm|elbow|hand|wrist|sleeve|leg|foot|knee|toe)(?:$|[-_\s])|(?:腕|ひじ|肘|手首|臂|袖|足|ひざ|膝|脚|腿)/i;
// 飘带类挂件（缎带/带子/リボン/ribbon）：多挂在小质量链末端且常无关节弹簧，
// 唤醒后无恢复力的小质量链在待机时会持续高频抖动。用户决策：宁可不要飘带
// 的真实物理效果也不允许抖动——名称命中的刚体整链进入窄带阻尼，仍保留
// 动态模式、重力和骨骼输出；手臂/腿锚定的链在上面的拓扑判断中排除。
const RIBBON_TRAIL_NAME = /(?:缎带|飘带|细带|花带|带子|リボン|ribbon|sash)/i;
const SMALL_DECORATIVE_TRAIL_NAME = /(?:挂件|穗|穗穗|饰品|装饰|pendant|ornament|accessory)/i;
// Decorative tails that are not part of the main garment. This is deliberately
// narrower than SECONDARY_NAME so a main skirt or long hair is never disabled.
const DECORATIVE_TRAIL_NAME = /(?:ribbon|ribbonbone|sash|strap|tassel|band|belt|tie|cord|lace|ornament|accessory|piao|缎带|飘带|细带|花带|带子|带|穗|穗穗|风铃|绳|丝带|花饰|饰品|装饰|挂件|リボン|帯|飾り|房)/i;
const HAIR_NAME = /(?:hair|fur|shair|bhair|bangs?bone|bangs|头发|发丝|发|刘海|前发|鬓|辫|髪|毛|発|发饰|髮)/i;
// This narrower classifier is intentionally used only for the synthetic
// recovery force. It targets the long strands behind the body and excludes
// bangs/front hair, clothing and ribbons.
const REAR_HAIR_NAME = /(?:后发|后髪|後髪|後ろ髪|hairbone|backhair|rearhair|hair[_ -]?back)/i;
const BANDAGE_NAME = /(?:bandage|绷带|包帯)/i;

function normalized(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boneNameByIndex(skeleton: MmdPhysicsSkeleton | undefined, index: number | undefined): string {
  if (!skeleton || typeof index !== 'number') return '';
  // Callers classify many rigid bodies; avoid a full skeleton scan for every
  // body/joint by using the parser's stable numeric index directly.
  const bone = skeleton.bones[index] ?? skeleton.bones.find(candidate => candidate.index === index);
  return normalized(bone?.name);
}

function isDynamic(body: MmdPhysicsRigidBody): boolean {
  return body.motionType !== 'static';
}

function isExcluded(body: MmdPhysicsRigidBody, skeleton: MmdPhysicsSkeleton | undefined): boolean {
  const bodyName = normalized(body.name);
  const boneName = boneNameByIndex(skeleton, body.boneIndex);
  // PMX authors often prefix rear waist ornaments with 腰/后.  Those names
  // are not body/hip colliders when the same component is a small decorative
  // chain, so let the dedicated anti-chatter classifier handle them.
  if (typeof body.mass === 'number' && body.mass <= 1.5
    && SMALL_DECORATIVE_TRAIL_NAME.test(`${bodyName} ${boneName}`)) return false;
  return EXCLUDED_NAME.test(bodyName) || EXCLUDED_NAME.test(boneName);
}

function isSecondary(body: MmdPhysicsRigidBody, skeleton: MmdPhysicsSkeleton | undefined): boolean {
  const bodyName = normalized(body.name);
  const boneName = boneNameByIndex(skeleton, body.boneIndex);
  return SECONDARY_NAME.test(bodyName) || SECONDARY_NAME.test(boneName);
}

function bodyAndBoneName(body: MmdPhysicsRigidBody, skeleton: MmdPhysicsSkeleton | undefined): string {
  return `${normalized(body.name)} ${boneNameByIndex(skeleton, body.boneIndex)}`;
}

function isSmallDecorativeTrail(body: MmdPhysicsRigidBody, skeleton: MmdPhysicsSkeleton | undefined): boolean {
  if (!isDynamic(body) || typeof body.mass !== 'number' || body.mass > 1.5) return false;
  const name = bodyAndBoneName(body, skeleton);
  return SMALL_DECORATIVE_TRAIL_NAME.test(name)
    && !HAIR_NAME.test(name)
    && !BANDAGE_NAME.test(name);
}

function isSleeveBody(body: MmdPhysicsRigidBody, skeleton: MmdPhysicsSkeleton | undefined): boolean {
  if (!isDynamic(body)) return false;
  return /(?:sleeve|袖)/i.test(bodyAndBoneName(body, skeleton));
}

function hasDynamicParentBody(
  body: MmdPhysicsRigidBody,
  bodiesByBone: ReadonlyMap<number, readonly MmdPhysicsRigidBody[]>,
  skeleton: MmdPhysicsSkeleton | undefined
): boolean {
  if (!skeleton || typeof body.boneIndex !== 'number') return false;
  const bone = skeleton.bones[body.boneIndex]
    ?? skeleton.bones.find(candidate => candidate.index === body.boneIndex);
  const parentIndex = bone?.parentIndex;
  if (typeof parentIndex !== 'number' || parentIndex < 0) return false;
  return (bodiesByBone.get(parentIndex) ?? []).some(candidate => isDynamic(candidate));
}

function adjacencyFor(
  rigidBodies: readonly MmdPhysicsRigidBody[],
  joints: readonly MmdPhysicsJoint[] | undefined
): Map<number, Set<number>> {
  const graph = new Map<number, Set<number>>();
  for (const body of rigidBodies) graph.set(body.index, new Set());
  for (const joint of joints ?? []) {
    if (!graph.has(joint.rigidBodyIndexA) || !graph.has(joint.rigidBodyIndexB)) continue;
    graph.get(joint.rigidBodyIndexA)?.add(joint.rigidBodyIndexB);
    graph.get(joint.rigidBodyIndexB)?.add(joint.rigidBodyIndexA);
  }
  return graph;
}

/**
 * Finds decorative ribbon/tassel bones without selecting hair or the main
 * skirt. The returned set is consumed as bone-physics toggles by the shared
 * backend; PMX bodies and authored motion data remain untouched.
 */
export function classifyDecorativeRigidBodyBoneIndices(
  input: SecondaryMaterialProfileInput
): ReadonlySet<number> {
  const bodies = input.rigidBodies ?? [];
  const graph = adjacencyFor(bodies, input.joints);
  const byIndex = new Map(bodies.map(body => [body.index, body]));
  const visited = new Set<number>();
  const disabled = new Set<number>();

  for (const body of bodies) {
    if (visited.has(body.index)) continue;
    const component: number[] = [];
    const queue = [body.index];
    visited.add(body.index);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const current = queue[queueIndex];
      component.push(current);
      for (const next of graph.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    // Arm/leg-followed components must retain collision and physics. This
    // keeps sleeve bands and arm bandages hanging naturally during gestures.
    const limbAnchored = component.some(index => {
      const candidate = byIndex.get(index);
      if (!candidate || !isDynamic(candidate)) return false;
      return [...(graph.get(index) ?? [])].some(neighbor => {
        const anchor = byIndex.get(neighbor);
        if (!anchor || anchor.motionType !== 'static') return false;
        const anchorName = bodyAndBoneName(anchor, input.skeleton);
        return LIMB_ANCHOR_NAME.test(anchorName);
      });
    });
    const hasSmallDecorativeTrail = component.some(index => {
      const candidate = byIndex.get(index);
      return candidate ? isSmallDecorativeTrail(candidate, input.skeleton) : false;
    });
    const sleeveComponent = component.some(index => {
      const candidate = byIndex.get(index);
      return candidate ? isSleeveBody(candidate, input.skeleton) : false;
    });
    // Tiny rear tassels/pendants may be authored against an arm collider but
    // are still independent ornaments. Removing only their mutual collision
    // prevents a perpetual Bullet impulse while gravity and bone output stay
    // enabled. Sleeves, bandages, and larger arm-followed cloth remain guarded.
    if (limbAnchored && !hasSmallDecorativeTrail && !sleeveComponent) continue;

    for (const index of component) {
      const candidate = byIndex.get(index);
      if (!candidate || !isDynamic(candidate) || typeof candidate.boneIndex !== 'number') continue;
      const name = bodyAndBoneName(candidate, input.skeleton);
      // Sleeve chains (振袖/袖) are large cloth sheets that collide with each
      // other and with arm ornaments during fast gestures, producing high-
      // frequency Bullet impulses the damping band cannot fully absorb. As the
      // second layer, remove only their collision (collisionMask=0); gravity,
      // bone output and the sleeve damping band stay enabled.
      const isSleeveMember = sleeveComponent && isSleeveBody(candidate, input.skeleton);
      if (HAIR_NAME.test(name)
        || BANDAGE_NAME.test(name)
        || (!DECORATIVE_TRAIL_NAME.test(name) && !isSleeveMember)) continue;
      disabled.add(candidate.boneIndex);
    }
  }
  return disabled;
}

function hasAuthoredSpring(
  component: readonly number[],
  joints: readonly MmdPhysicsJoint[] | undefined
): boolean {
  if (!joints || joints.length === 0) return false;
  const members = new Set(component);
  return joints.some(joint => {
    if (!members.has(joint.rigidBodyIndexA) || !members.has(joint.rigidBodyIndexB)) return false;
    const values = [
      ...(joint.spring?.linear ?? []),
      ...(joint.spring?.angular ?? [])
    ];
    return values.some(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) > 1e-6);
  });
}

/** Returns only dynamic bodies belonging to a topology-backed secondary chain. */
export function classifySecondaryRigidBodies(
  input: SecondaryMaterialProfileInput,
  options: Pick<SecondaryMaterialProfileOptions, 'selectSpringAuthoredHairWithoutNumericIndices'> = {}
): ReadonlySet<number> {
  const bodies = input.rigidBodies ?? [];
  const byIndex = new Map(bodies.map(body => [body.index, body]));
  const bodiesByBone = new Map<number, MmdPhysicsRigidBody[]>();
  for (const body of bodies) {
    if (typeof body.boneIndex !== 'number') continue;
    const list = bodiesByBone.get(body.boneIndex) ?? [];
    list.push(body);
    bodiesByBone.set(body.boneIndex, list);
  }
  const graph = adjacencyFor(bodies, input.joints);
  const visited = new Set<number>();
  const selected = new Set<number>();

  for (const body of bodies) {
    if (visited.has(body.index)) continue;
    const component: number[] = [];
    const queue = [body.index];
    visited.add(body.index);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const current = queue[queueIndex];
      component.push(current);
      for (const next of graph.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    const hasSecondarySeed = component.some(index => {
      const candidate = byIndex.get(index);
      return Boolean(candidate && isDynamic(candidate)
        && !isExcluded(candidate, input.skeleton)
        && isSecondary(candidate, input.skeleton));
    });
    if (!hasSecondarySeed || component.length < 2) continue;

    // 手臂/腿锚定的组件（振袖、袖飘带）整链保持 authored：低阻尼会让袖根
    // 滞后于快速运动的手臂（动作时不自然），无弹簧链还会持续抖动。
    const limbAnchored = component.some(index => {
      const candidate = byIndex.get(index);
      if (!candidate || !isDynamic(candidate)) return false;
      for (const neighbor of graph.get(index) ?? []) {
        const anchor = byIndex.get(neighbor);
        if (!anchor || anchor.motionType !== 'static') continue;
        const anchorBoneName = boneNameByIndex(input.skeleton, anchor.boneIndex);
        if (LIMB_ANCHOR_NAME.test(normalized(anchor.name))
          || LIMB_ANCHOR_NAME.test(anchorBoneName)) return true;
      }
      return false;
    });
    const hasSmallDecorativeTrail = component.some(index => {
      const candidate = byIndex.get(index);
      return candidate ? isSmallDecorativeTrail(candidate, input.skeleton) : false;
    });
    // 袖子组件不再整链排除：语音/手势动作时大袖子刚体相互碰撞产生高频
    // 振动，authored 阻尼不足以吸收。让袖子进入 selected，在 apply 阶段
    // 走 sleeve 高阻尼带（阻尼上调而非下调，见 sleeve* 参数注释）。
    const sleeveComponent = component.some(index => {
      const candidate = byIndex.get(index);
      return candidate ? isSleeveBody(candidate, input.skeleton) : false;
    });
    // Small rear ornaments can be attached to an arm collider in authored
    // PMX data. They still need the anti-chatter damping band; the separate
    // decorative-collision pass removes only their mutual collision impulse.
    if (limbAnchored && !hasSmallDecorativeTrail && !sleeveComponent) continue;

    const springAuthored = hasAuthoredSpring(component, input.joints);
    const hairComponent = component.some(index => {
      const candidate = byIndex.get(index);
      return candidate ? HAIR_NAME.test(bodyAndBoneName(candidate, input.skeleton)) : false;
    });
    const skeletonHasNumericBoneIndices = Boolean(input.skeleton?.bones.some(
      bone => typeof bone.index === 'number'
    ));
    // Legacy spring-authored hair chains already receive Bullet response from
    // their authored roots.  Do not newly wake every descendant in a large
    // spring component just because a loader skeleton omits numeric indices;
    // the fallback parent walk is intended for the light, springless chains
    // that were previously completely pinned. Small unit/topology chains and
    // non-hair spring components retain the existing animated-parent path.
    const allowAnimatedParentSelection = !springAuthored || !hairComponent || skeletonHasNumericBoneIndices
      || options.selectSpringAuthoredHairWithoutNumericIndices === true;

    for (const index of component) {
      const candidate = byIndex.get(index);
      if (!candidate || !isDynamic(candidate) || isExcluded(candidate, input.skeleton)) continue;
      const trailBodyName = normalized(candidate.name);
      const trailBoneName = boneNameByIndex(input.skeleton, candidate.boneIndex);
      const isRibbonTrail = RIBBON_TRAIL_NAME.test(trailBodyName)
        || RIBBON_TRAIL_NAME.test(trailBoneName);
      const isSmallDecorative = isSmallDecorativeTrail(candidate, input.skeleton);
      // Ribbon/tassel components are usually authored as a complete chain.
      // Profile every dynamic member so the light end receives the same
      // anti-chatter floor as the root; the limb-anchor guard above still
      // keeps sleeves and arm-followed ornaments untouched.
      if (isRibbonTrail || isSmallDecorative) {
        selected.add(index);
        continue;
      }
      // Keep the first body attached directly to a static collider under its
      // authored damping. Its attachment behavior is governed by the shared
      // drag/root path and must not be turned into a loose hinge.
      const attachedToStatic = [...(graph.get(index) ?? [])]
        .some(neighbor => byIndex.get(neighbor)?.motionType === 'static');
      // In a springless component the body-connected root is the only source
      // of gravity-driven motion. Keep it eligible for the responsive profile;
      // excluding it leaves the entire strand visually pinned to the torso.
      if (!springAuthored && attachedToStatic) {
        selected.add(index);
        continue;
      }
      const canDetermineParent = Boolean(input.skeleton && typeof candidate.boneIndex === 'number');
      const attachedToAnimatedParent = hasDynamicParentBody(candidate, bodiesByBone, input.skeleton);
      if (!attachedToStatic && (!canDetermineParent
        || (allowAnimatedParentSelection && attachedToAnimatedParent))) {
        selected.add(index);
      }
    }
  }
  return selected;
}

function boundedDamping(
  value: number | undefined,
  scale: number,
  minimum: number,
  maximum: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return value;
  if (value <= minimum) return value;
  return Math.min(maximum, Math.max(minimum, value * scale));
}

function clampDampingBand(value: number | undefined, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return value;
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Return model-family overrides only when the PMX skeleton is unmistakable.
 *
 * 汐光曳影/婚皮 use many BangsBone* chains and dynamic-with-bone rigid
 * bodies.  Their default feedback is intentionally conservative for ordinary
 * rigs, which makes these imported strands appear frozen.  曜弦游吟 uses the
 * FHair/R_Shair/L_Shair family with a much smaller 468-bone skeleton; its
 * authored spring chains swing too freely unless their damping is raised.
 */
function inferImportedHairProfile(
  skeleton: MmdPhysicsSkeleton | undefined
): Partial<SecondaryMaterialProfileOptions> {
  const names = (skeleton?.bones ?? []).map(bone => normalized(bone.name));
  const hasBangsFamily = names.some(name => /bangs?bone/i.test(name));
  const isLargeBangsRig = hasBangsFamily && names.length >= 800;
  if (isLargeBangsRig) {
    return {
      selectSpringAuthoredHairWithoutNumericIndices: true,
      dynamicWithBoneHairToDynamic: true,
      // Wake springless rear strands without touching clothing/ribbons.
      hairNoSpringLinearDampingScale: 0.78,
      hairNoSpringAngularDampingScale: 0.78,
      hairNoSpringMinimumResponsiveLinearDamping: 0.65,
      hairNoSpringMinimumResponsiveAngularDamping: 0.65,
      hairNoSpringMaximumLinearDamping: 0.88,
      hairNoSpringMaximumAngularDamping: 0.88,
      // Spring-authored BangsBone chains need a visible but restrained lag.
      hairLinearDampingScale: 0.88,
      hairAngularDampingScale: 0.88,
      hairMinimumResponsiveLinearDamping: 0.82,
      hairMinimumResponsiveAngularDamping: 0.82,
      hairMaximumLinearDamping: 0.94,
      hairMaximumAngularDamping: 0.94
    };
  }

  const hasYouyinRearHair = names.some(name => /R[_ ]?Shair[_ ]?A[_ ]?1/i.test(name))
    && names.some(name => /L[_ ]?Shair[_ ]?A[_ ]?1/i.test(name));
  if (hasYouyinRearHair && names.length >= 430 && names.length <= 520) {
    return {
      selectSpringAuthoredHairWithoutNumericIndices: true,
      // Keep the authored spring behavior but absorb the excessive swing.
      hairLinearDampingScale: 1.05,
      hairAngularDampingScale: 1.35,
      hairMinimumResponsiveLinearDamping: 0.98,
      hairMinimumResponsiveAngularDamping: 0.98,
      hairMaximumLinearDamping: 1.08,
      hairMaximumAngularDamping: 3
    };
  }
  return {};
}

/**
 * 婚皮（缘纺祈糸/大振袖）专属"润顺"档。骨架签名：≥800 根骨骼且 ≥60 根
 * 袖骨（实测 894/110；其它模型袖骨均远低于该阈值），签名不命中则完全
 * 走共享默认，不会把婚皮参数带给其它模型。
 *
 * 相对共享袖子档（阻尼带 0.80~0.90、质量 0.25、回弹 6）的差别：
 * - 阻尼带抬到 0.83~0.93：大袖刚体互撞的高频振动吸收更充分，settle
 *   更平滑；下限只抬 0.03，飘逸感保留。
 * - 回弹 6 → 4：关节限制已放宽到 ±30°，高阻尼下不再需要强回正力，
 *   弱一点回弹让布片回落更自然（不显"板"）。
 * - 质量 0.25 → 0.22：布片更轻，更容易被手臂带着流动，减少在关节
 *   限制边界上的挣扎。
 * - 无弹簧自由段（スカート 280 骨）下限 0.78 → 0.80、上限 0.90 →
 *   0.92：吸收裙摆残余高频抖动（仅婚皮，其它模型不受影响）。
 */
function inferWeddingGarmentProfile(
  skeleton: MmdPhysicsSkeleton | undefined
): Partial<SecondaryMaterialProfileOptions> {
  const bones = skeleton?.bones ?? [];
  if (bones.length < 800) return {};
  const sleeveBoneCount = bones.reduce(
    (count, bone) => count + (typeof bone.name === 'string' && /袖/u.test(bone.name) ? 1 : 0),
    0
  );
  if (sleeveBoneCount < 60) return {};
  return {
    sleeveMinimumResponsiveLinearDamping: 0.83,
    sleeveMinimumResponsiveAngularDamping: 0.83,
    sleeveMaximumLinearDamping: 0.93,
    sleeveMaximumAngularDamping: 0.93,
    sleeveMassScale: 0.22,
    sleeveAngularSpring: 4,
    noSpringMinimumResponsiveLinearDamping: 0.80,
    noSpringMinimumResponsiveAngularDamping: 0.80,
    noSpringMaximumLinearDamping: 0.92,
    noSpringMaximumAngularDamping: 0.92
  };
}

/** Clone only changed secondary bodies; parser-owned input remains untouched. */
export function applySecondaryMaterialProfile(
  input: SecondaryMaterialProfileInput,
  options: SecondaryMaterialProfileOptions = {}
): SecondaryMaterialProfileResult {
  const bodies = input.rigidBodies;
  const decorativeCollisionBoneIndices = [...classifyDecorativeRigidBodyBoneIndices(input)];
  if (!bodies || bodies.length === 0) {
    return {
      rigidBodies: bodies,
      joints: input.joints,
      adjustedBodyIndices: [],
      decorativeCollisionBoneIndices
    };
  }
  // Infer a narrow tuning profile for the two imported model families that
  // use non-standard hair rigs, plus the wedding-dress garment smoothing
  // profile.  Built-in Selena/Yangyang and future models retain the shared
  // defaults unless their bone naming/topology matches one of these
  // explicit signatures.
  const inferred = {
    ...inferImportedHairProfile(input.skeleton),
    ...inferWeddingGarmentProfile(input.skeleton)
  };
  const profile = { ...DEFAULT_SECONDARY_MATERIAL_PROFILE, ...inferred, ...options };
  const selected = classifySecondaryRigidBodies(input, profile);
  const componentSpringless = new Set<number>();
  const componentMembersByBody = new Map<number, readonly number[]>();
  const graph = adjacencyFor(bodies, input.joints);
  const visited = new Set<number>();
  for (const body of bodies) {
    if (visited.has(body.index)) continue;
    const component: number[] = [];
    const queue = [body.index];
    visited.add(body.index);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const current = queue[queueIndex];
      component.push(current);
      for (const next of graph.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (!hasAuthoredSpring(component, input.joints)) {
      for (const index of component) componentSpringless.add(index);
    }
    for (const index of component) componentMembersByBody.set(index, component);
  }
  const adjustedBodyIndices: number[] = [];
  const byIndex = new Map(bodies.map(body => [body.index, body]));
  const springlessHairJoints = new Set<MmdPhysicsJoint>();
  for (const joint of input.joints ?? []) {
    const members = componentMembersByBody.get(joint.rigidBodyIndexA);
    if (!members || !members.includes(joint.rigidBodyIndexB)) continue;
    const bodyA = byIndex.get(joint.rigidBodyIndexA);
    const bodyB = byIndex.get(joint.rigidBodyIndexB);
    const nameA = bodyA ? bodyAndBoneName(bodyA, input.skeleton) : '';
    const nameB = bodyB ? bodyAndBoneName(bodyB, input.skeleton) : '';
    // Only hair-to-hair joints and hair-to-static-anchor joints are eligible.
    // This prevents a springless component that happens to touch hair from
    // changing its skirt/ribbon joints at the branch boundary.
    const hairA = HAIR_NAME.test(nameA);
    const hairB = HAIR_NAME.test(nameB);
    const hairToStaticAnchor = (hairA && bodyB?.motionType === 'static')
      || (hairB && bodyA?.motionType === 'static');
    const rearHairJoint = REAR_HAIR_NAME.test(nameA) || REAR_HAIR_NAME.test(nameB);
    // Only the rear-hair root is recovered. Adding a spring to every tail
    // segment was numerically stable but made the visible ends look rigid.
    if (!rearHairJoint || !hairToStaticAnchor) continue;
    const angular = joint.spring?.angular ?? [];
    if (angular.some(value => Math.abs(value) > 1e-6)) continue;
    // A single Bullet component can contain several authored branches. Only
    // the rear-hair anchor is normalized; all descendant tail joints remain
    // free to swing under Bullet.
    springlessHairJoints.add(joint);
  }
  const decorativeCollisionBones = new Set(decorativeCollisionBoneIndices);
  const profiled = bodies.map(body => {
    const collisionProtected = typeof body.boneIndex === 'number'
      && decorativeCollisionBones.has(body.boneIndex);
    if (!selected.has(body.index)) {
      return collisionProtected ? { ...body, collisionMask: 0 } : body;
    }
    const springless = componentSpringless.has(body.index);
    const ribbonTrail = RIBBON_TRAIL_NAME.test(normalized(body.name))
      || RIBBON_TRAIL_NAME.test(boneNameByIndex(input.skeleton, body.boneIndex));
    const smallDecorativeTrail = isSmallDecorativeTrail(body, input.skeleton);
    const quietDecorativeTrail = ribbonTrail || smallDecorativeTrail;
    // 袖子：语音/手势动作时大袖刚体相互碰撞产生高频振动。只抬高阻尼
    // 下限（不降低 PMX 已写入的高阻尼），吸收 Bullet/VMD 交接振动而不
    // 把重布料的 authored settling 值改成更松的通用上限。
    const sleeveBody = isSleeveBody(body, input.skeleton);
    // 链根（直接连接 static 碰撞体的动态刚体）用温和档：躯干/头小幅动画
    // 下根部稳定，抑制抖动沿链传播；手臂/腿锚定的组件已在分类阶段整体
    // 排除，不会走到这里。
    const isChainRoot = [...(graph.get(body.index) ?? [])]
      .some(neighbor => byIndex.get(neighbor)?.motionType === 'static');
    const rootAndSpringless = springless && isChainRoot;
    const hairBody = HAIR_NAME.test(bodyAndBoneName(body, input.skeleton));
    const hairSpringAuthored = !springless && !rootAndSpringless && hairBody;
    const hairNoSpringLight = springless && !rootAndSpringless && hairBody
      && (typeof body.mass !== 'number'
        || body.mass < (profile.hairHeavyMassThreshold ?? Number.POSITIVE_INFINITY));
    const hairHeavy = hairSpringAuthored
      && typeof body.mass === 'number'
      && body.mass >= (profile.hairHeavyMassThreshold ?? Number.POSITIVE_INFINITY);
    const hairLinearMinimum = hairHeavy
      ? Math.max(
        profile.hairMinimumResponsiveLinearDamping,
        profile.hairHeavyMinimumResponsiveLinearDamping ?? profile.hairMinimumResponsiveLinearDamping
      )
      : profile.hairMinimumResponsiveLinearDamping;
    const hairAngularMinimum = hairHeavy
      ? Math.max(
        profile.hairMinimumResponsiveAngularDamping,
        profile.hairHeavyMinimumResponsiveAngularDamping ?? profile.hairMinimumResponsiveAngularDamping
      )
      : profile.hairMinimumResponsiveAngularDamping;
    // Heavy spring-authored hair segments are the inertia carriers in the
    // established Selena rig. Keep them close to authored damping after the
    // parent-topology fix; light tips retain the lower responsive floor.
    const effectiveHairAngularMinimum = hairSpringAuthored
      && typeof body.mass === 'number'
      && body.mass >= 1
      ? Math.max(hairAngularMinimum, 0.92)
      : hairAngularMinimum;
    const linearDamping = quietDecorativeTrail
      ? clampDampingBand(
        body.linearDamping,
        profile.ribbonMinimumLinearDamping ?? profile.noSpringMinimumResponsiveLinearDamping,
        profile.ribbonMaximumLinearDamping ?? profile.noSpringMaximumLinearDamping
      )
      : sleeveBody
        ? clampDampingBand(
          body.linearDamping,
          profile.sleeveMinimumResponsiveLinearDamping ?? 0.80,
          profile.sleeveMaximumLinearDamping ?? 0.90
        )
        : boundedDamping(
      body.linearDamping,
      hairSpringAuthored
        ? profile.hairLinearDampingScale
        : rootAndSpringless
        ? profile.noSpringRootLinearDampingScale
        : hairNoSpringLight
          ? profile.hairNoSpringLinearDampingScale
        : springless ? profile.noSpringLinearDampingScale : profile.linearDampingScale,
      hairSpringAuthored
        ? hairLinearMinimum
        : rootAndSpringless
        ? profile.noSpringRootMinimumResponsiveLinearDamping
        : hairNoSpringLight
          ? profile.hairNoSpringMinimumResponsiveLinearDamping
        : springless
          ? profile.noSpringMinimumResponsiveLinearDamping
          : profile.minimumResponsiveLinearDamping,
      hairSpringAuthored
        ? profile.hairMaximumLinearDamping
        : rootAndSpringless
        ? profile.noSpringRootMaximumLinearDamping
        : hairNoSpringLight
          ? profile.hairNoSpringMaximumLinearDamping
        : springless ? profile.noSpringMaximumLinearDamping : profile.maximumLinearDamping
    );
    const angularDamping = quietDecorativeTrail
      ? clampDampingBand(
        body.angularDamping,
        profile.ribbonMinimumAngularDamping ?? profile.noSpringMinimumResponsiveAngularDamping,
        profile.ribbonMaximumAngularDamping ?? profile.noSpringMaximumAngularDamping
      )
      : sleeveBody
        ? clampDampingBand(
          body.angularDamping,
          profile.sleeveMinimumResponsiveAngularDamping ?? 0.80,
          profile.sleeveMaximumAngularDamping ?? 0.90
        )
        : boundedDamping(
      body.angularDamping,
      hairSpringAuthored
        ? profile.hairAngularDampingScale
        : rootAndSpringless
        ? profile.noSpringRootAngularDampingScale
        : hairNoSpringLight
          ? profile.hairNoSpringAngularDampingScale
        : springless ? profile.noSpringAngularDampingScale : profile.angularDampingScale,
      hairSpringAuthored
        ? effectiveHairAngularMinimum
        : rootAndSpringless
        ? profile.noSpringRootMinimumResponsiveAngularDamping
        : hairNoSpringLight
          ? profile.hairNoSpringMinimumResponsiveAngularDamping
        : springless
          ? profile.noSpringMinimumResponsiveAngularDamping
          : profile.minimumResponsiveAngularDamping,
      hairSpringAuthored
        ? profile.hairMaximumAngularDamping
        : rootAndSpringless
        ? profile.noSpringRootMaximumAngularDamping
        : hairNoSpringLight
          ? profile.hairNoSpringMaximumAngularDamping
        : springless ? profile.noSpringMaximumAngularDamping : profile.maximumAngularDamping
    );
    const normalizedMotionType = profile.dynamicWithBoneHairToDynamic
      && hairBody
      && body.motionType === 'dynamicWithBone'
      ? 'dynamic' as const
      : body.motionType;
    // 袖子质量缩放：重质量（15.5）+ 窄关节限制是袖链在限制边界挣扎抖动、
    // 视觉刚硬的主因。链内质量比保持一致（整链统一缩放）。
    const sleeveMassScaled = sleeveBody
      && typeof body.mass === 'number'
      && Number.isFinite(body.mass)
      && body.mass > 0
      ? body.mass * (profile.sleeveMassScale ?? 1)
      : body.mass;
    if (linearDamping === body.linearDamping
      && angularDamping === body.angularDamping
      && normalizedMotionType === body.motionType
      && sleeveMassScaled === body.mass
      && !collisionProtected) return body;
    adjustedBodyIndices.push(body.index);
    return {
      ...body,
      motionType: normalizedMotionType,
      linearDamping,
      angularDamping,
      mass: sleeveMassScaled,
      ...(collisionProtected ? { collisionMask: 0 } : {})
    };
  });

  const profiledJoints = (input.joints ?? []).map(joint => {
    // 袖子关节软化：放宽每轴窄旋转限制（振袖 Y 轴 authored 仅 ±5°）并给
    // 无弹簧关节加回正力。手臂合拢时袖链不再在窄限制上挣扎卡顿。
    const sleeveJointBodyA = byIndex.get(joint.rigidBodyIndexA);
    const sleeveJointBodyB = byIndex.get(joint.rigidBodyIndexB);
    const isSleeveJoint = (sleeveJointBodyA && isSleeveBody(sleeveJointBodyA, input.skeleton))
      || (sleeveJointBodyB && isSleeveBody(sleeveJointBodyB, input.skeleton));
    if (isSleeveJoint) {
      const minimumLimit = profile.sleeveJointMinimumAngularLimitRadians ?? 0.5236;
      const lower = joint.angularLimit?.lower;
      const upper = joint.angularLimit?.upper;
      const canWiden = Array.isArray(lower) && Array.isArray(upper)
        && lower.length === 3 && upper.length === 3
        && lower.every(v => typeof v === 'number' && Number.isFinite(v))
        && upper.every(v => typeof v === 'number' && Number.isFinite(v));
      const widenedLimit = canWiden
        ? {
          lower: (lower as readonly number[]).map(
            value => Math.min(value, -minimumLimit)
          ) as [number, number, number],
          upper: (upper as readonly number[]).map(
            value => Math.max(value, minimumLimit)
          ) as [number, number, number]
        }
        : joint.angularLimit;
      const sleeveSpring = profile.sleeveAngularSpring ?? 6;
      const authoredAngular = joint.spring?.angular;
      const needsSleeveSpring = typeof sleeveSpring === 'number'
        && Number.isFinite(sleeveSpring)
        && sleeveSpring > 0
        && (!Array.isArray(authoredAngular)
          || authoredAngular.every(value => typeof value !== 'number'
            || Math.abs(value) <= 1e-6));
      const angular = needsSleeveSpring
        ? [sleeveSpring, sleeveSpring, sleeveSpring] as [number, number, number]
        : authoredAngular as [number, number, number] | undefined;
      const spring = angular ? { ...joint.spring, angular } : joint.spring;
      if (widenedLimit === joint.angularLimit && spring === joint.spring) return joint;
      return { ...joint, angularLimit: widenedLimit, spring };
    }
    if (!springlessHairJoints.has(joint)) return joint;
    const bodyA = byIndex.get(joint.rigidBodyIndexA);
    const bodyB = byIndex.get(joint.rigidBodyIndexB);
    const maxMass = Math.max(
      typeof bodyA?.mass === 'number' ? bodyA.mass : 0,
      typeof bodyB?.mass === 'number' ? bodyB.mass : 0
    );
    const spring = maxMass >= (profile.hairHeavyMassThreshold ?? 4)
      ? profile.rearHairNoSpringHeavyAngularSpring
      : profile.rearHairNoSpringAngularSpring;
    if (typeof spring !== 'number' || !Number.isFinite(spring) || spring <= 0) return joint;
    const angular = [spring, spring, spring] as const;
    return { ...joint, spring: { ...joint.spring, angular } };
  });
  const jointsChanged = profiledJoints.some((joint, index) => joint !== input.joints?.[index]);
  const outputBodies = adjustedBodyIndices.length > 0
    || profiled.some((body, index) => body !== bodies[index])
    ? profiled
    : bodies;
  return {
    rigidBodies: outputBodies,
    joints: jointsChanged ? profiledJoints : input.joints,
    adjustedBodyIndices,
    decorativeCollisionBoneIndices
  };
}
