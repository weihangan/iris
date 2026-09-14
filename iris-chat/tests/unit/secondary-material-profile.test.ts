import { describe, expect, it } from 'vitest';
import {
  applySecondaryMaterialProfile,
  classifyDecorativeRigidBodyBoneIndices,
  classifySecondaryRigidBodies,
  DEFAULT_SECONDARY_MATERIAL_PROFILE
} from '../../src/physics/secondary-material-profile';

const skeleton = {
  bones: [
    { index: 0, name: 'センター', parentIndex: -1 },
    { index: 1, name: '左足', parentIndex: 0 },
    { index: 2, name: 'Bone_Hair001', parentIndex: 0 },
    { index: 3, name: 'Bone_Hair002', parentIndex: 2 },
    { index: 4, name: 'スカート_0_0', parentIndex: 0 },
    { index: 5, name: 'スカート_0_1', parentIndex: 4 },
    { index: 6, name: '左后带子_0_1', parentIndex: 0 },
    { index: 7, name: '左后带子_0_2', parentIndex: 6 },
    { index: 8, name: '左腕', parentIndex: 0 },
    { index: 9, name: '左袖', parentIndex: 8 },
    { index: 10, name: '左袖_0_1', parentIndex: 9 },
    { index: 11, name: '上半身', parentIndex: 0 }
  ]
} as const;

const body = (index: number, name: string, boneIndex: number, motionType: 'static' | 'dynamic' = 'dynamic') => ({
  index,
  name,
  boneIndex,
  motionType,
  shape: { type: 'sphere' as const, size: [0.1, 0.1, 0.1] as const },
  mass: 2,
  linearDamping: 0.95,
  angularDamping: 0.95,
  restitution: 0.2,
  friction: 0.6,
  collisionGroup: 4,
  collisionMask: 7
});

describe('secondary material profile', () => {
  it('selects connected hair and skirt chains, keeps ribbon trails authored, excludes legs', () => {
    const rigidBodies = [
      body(0, 'body-collider', 0, 'static'),
      body(1, 'leg-chain', 1),
      body(2, 'hair-root', 2),
      body(3, 'hair-tip', 3),
      body(4, 'skirt-root', 4),
      body(5, 'skirt-tip', 5),
      body(6, 'ribbon-root', 6),
      body(7, 'ribbon-tip', 7)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 2, rigidBodyIndexB: 3 },
      { index: 1, rigidBodyIndexA: 4, rigidBodyIndexB: 5 },
      { index: 2, rigidBodyIndexA: 6, rigidBodyIndexB: 7 }
    ];

    // 非肢体锚定的飘带整链进入窄带阻尼，仍保留动态/重力；袖飘带则由
    // limb-anchor guard 排除，继续使用作者阻尼。
    expect(classifySecondaryRigidBodies({ skeleton, rigidBodies, joints })).toEqual(
      new Set([3, 5, 6, 7])
    );
  });

  it('selects BangsBone front-hair chains even when the PMX body names are generic', () => {
    const bangsSkeleton = {
      bones: [
        { index: 0, name: '頭', parentIndex: -1 },
        { index: 1, name: 'BangsBoneL00', parentIndex: 0 },
        { index: 2, name: 'BangsBoneL01', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      body(1, 'BangsBoneL00', 1),
      body(2, 'BangsBoneL01', 2)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    expect(classifySecondaryRigidBodies({
      skeleton: bangsSkeleton,
      rigidBodies,
      joints
    })).toEqual(new Set([1, 2]));
  });

  it('reduces only bounded near-locking damping without mutating PMX data', () => {
    const rigidBodies = [body(0, 'hair-root', 2), body(1, 'hair-tip', 3), body(2, 'leg', 1)];
    const joints = [{ index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 }];
    const before = JSON.stringify(rigidBodies);
    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1]);
    expect(profiled[0]).toBe(rigidBodies[0]);
    expect(profiled[1].linearDamping).toBeLessThan(0.95);
    expect(profiled[1].angularDamping).toBeLessThan(0.95);
    expect(profiled[1].mass).toBe(2);
    expect(profiled[1].collisionMask).toBe(7);
    expect(profiled[2]).toBe(rigidBodies[2]);
    expect(JSON.stringify(rigidBodies)).toBe(before);
  });

  it('does not change already responsive material or standalone bodies', () => {
    const responsive = { ...body(0, '裙摆', 4), linearDamping: 0.45, angularDamping: 0.55 };
    const result = applySecondaryMaterialProfile({
      skeleton,
      rigidBodies: [responsive],
      joints: []
    });

    expect(result.adjustedBodyIndices).toEqual([]);
    expect(result.rigidBodies).toBe(result.rigidBodies);
    expect(DEFAULT_SECONDARY_MATERIAL_PROFILE.minimumResponsiveLinearDamping).toBeGreaterThan(0);
  });

  it('wakes a static-attached chain root when the component has no authored springs', () => {
    const rigidBodies = [
      body(0, 'head-collider', 0, 'static'),
      body(1, 'hair-root', 2),
      body(2, 'hair-tip', 3)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    // 头部锚定的链根用温和档（0.86~0.92）：能下垂但不松。曾一刀切降到
    // ~0.74，无弹簧 6DOF 关节没有恢复力，碰撞后的振动不被吸收 → 抖动。
    expect(profiled[1].linearDamping).toBeGreaterThan(0.85);
    expect(profiled[1].linearDamping).toBeLessThanOrEqual(0.92);
    expect(profiled[1].angularDamping).toBeGreaterThan(0.85);
    expect(profiled[1].angularDamping).toBeLessThanOrEqual(0.92);
    // 自由段唤醒档收紧（下限 0.78）：仍显著低于 authored 0.95（可飘可垂），
    // 但不再落到 0.68 引发持续高频抖动。
    expect(profiled[2].linearDamping).toBeGreaterThanOrEqual(0.78);
    expect(profiled[2].linearDamping).toBeLessThan(0.9);
    expect(profiled[2].angularDamping).toBeGreaterThanOrEqual(0.78);
    expect(profiled[2].angularDamping).toBeLessThan(0.9);
  });

  it('adds a light restoring spring only at the rear-hair root', () => {
    const rigidBodies = [
      body(0, 'head-collider', 0, 'static'),
      { ...body(1, '后发根', 2), mass: 0.5 },
      { ...body(2, '后发尾', 3), mass: 0.05 },
      { ...body(3, 'skirt-tip', 5), mass: 0.05 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    expect(result.joints?.[0].spring?.angular).toEqual([2.5, 2.5, 2.5]);
    expect(result.joints?.[1].spring?.angular).toBeUndefined();
    expect(result.joints?.[2].spring?.angular).toBeUndefined();
    expect((joints[0] as { spring?: unknown }).spring).toBeUndefined();
  });

  it('leaves BangsBone/front-hair tail joints unsprung for free swing', () => {
    const bangsSkeleton = {
      bones: [
        { index: 0, name: '頭', parentIndex: -1 },
        { index: 1, name: 'BangsBoneM00', parentIndex: 0 },
        { index: 2, name: 'BangsBoneM01', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      { ...body(1, 'BangsBoneM00', 1), mass: 0.5 },
      { ...body(2, 'BangsBoneM01', 2), mass: 0.05 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({
      skeleton: bangsSkeleton,
      rigidBodies,
      joints
    });
    expect(result.joints?.[0].spring?.angular).toBeUndefined();
    expect(result.joints?.[1].spring?.angular).toBeUndefined();
    expect(result.adjustedBodyIndices).toEqual([1, 2]);
  });

  it('wakes a zero-spring hair branch inside a mixed authored component', () => {
    const mixedSkeleton = {
      bones: [
        { index: 0, name: '頭', parentIndex: -1 },
        { index: 1, name: '后发根', parentIndex: 0 },
        { index: 2, name: '后发尾', parentIndex: 1 },
        { index: 3, name: '裙摆', parentIndex: 2 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      { ...body(1, '后发根', 1), mass: 5 },
      { ...body(2, '后发尾', 2), mass: 0.2 },
      { ...body(3, '裙摆', 3), mass: 1 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3,
        spring: { angular: [20, 20, 20] as const } }
    ];

    const result = applySecondaryMaterialProfile({
      skeleton: mixedSkeleton,
      rigidBodies,
      joints
    });
    expect(result.joints?.[0].spring?.angular).toEqual([5, 5, 5]);
    expect(result.joints?.[1].spring?.angular).toBeUndefined();
    expect(result.joints?.[2].spring?.angular).toEqual([20, 20, 20]);
  });

  it('adds a restrained damping band to limb-anchored sleeve chains so sleeves do not chatter', () => {
    // 婚皮振袖链根锚定在左腕/右腕（手臂碰撞体）。2026-08 实测：authored
    // 阻尼 0.90~0.99+ 且重质量让袖子像刚性板。袖子现在进入 0.80~0.90
    // 柔软阻尼带 + 质量缩放（链内质量比一致），布料有惯性飘逸感。
    const rigidBodies = [
      body(0, '左腕', 8, 'static'),
      body(1, '左袖', 9),
      body(2, '左袖_0_1', 10)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    expect(profiled[0]).toBe(rigidBodies[0]);
    expect(profiled[1]).not.toBe(rigidBodies[1]);
    expect(profiled[2]).not.toBe(rigidBodies[2]);
    expect(profiled[1].linearDamping).toBeGreaterThanOrEqual(0.80);
    expect(profiled[1].linearDamping).toBeLessThanOrEqual(0.90);
    expect(profiled[1].angularDamping).toBeGreaterThanOrEqual(0.80);
    expect(profiled[1].angularDamping).toBeLessThanOrEqual(0.90);
    // 质量缩放：整链统一 ×0.25，重袖布片不再以刚性惯量对抗关节 solver。
    expect(profiled[1].mass).toBeCloseTo(2 * DEFAULT_SECONDARY_MATERIAL_PROFILE.sleeveMassScale, 8);
    expect(profiled[2].mass).toBeCloseTo(2 * DEFAULT_SECONDARY_MATERIAL_PROFILE.sleeveMassScale, 8);
    // 第二层：语音/手势动作时左右振袖刚体会相互碰撞产生高频冲量，阻尼带
    // 不足以完全吸收。整链去掉碰撞（collisionMask=0），重力/骨骼输出保留。
    expect(result.decorativeCollisionBoneIndices).toEqual([9, 10]);
    expect(profiled[1].collisionMask).toBe(0);
    expect(profiled[2].collisionMask).toBe(0);
  });

  it('softens authored near-locking damping on sleeve bodies into the airy band', () => {
    const rigidBodies = [
      body(0, '左腕', 8, 'static'),
      { ...body(1, '左袖', 9), linearDamping: 0.99999, angularDamping: 2 },
      { ...body(2, '左袖_0_1', 10), linearDamping: 0.99999, angularDamping: 2 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    // Wedding PMX sleeve tips use near-locking authored damping (0.99999/2).
    // 2026-08 用户反馈"袖子太硬"：这些值被收窄进 0.80~0.90 柔软带，
    // 重布料不再表现成刚性板。
    expect(profiled[1].linearDamping).toBe(0.90);
    expect(profiled[1].angularDamping).toBe(0.90);
    expect(profiled[2].linearDamping).toBe(0.90);
    expect(profiled[2].angularDamping).toBe(0.90);
  });

  it('widens narrow sleeve joint rotation limits and adds a restoring spring', () => {
    // 振袖关节 authored Y 轴限制仅 ±5°（0.087 rad）。手臂合拢时袖链在
    // 窄限制上挣扎，是袖子卡顿/抖动的直接来源。profile 把每轴对称放宽
    // 到至少 ±0.5236 rad（±30°），authored 更宽的轴不动；无弹簧关节加
    // 回正力防止布片长时间歪斜。非袖子关节不受影响。
    const rigidBodies = [
      body(0, '左腕', 8, 'static'),
      body(1, '左袖', 9),
      body(2, '左袖_0_1', 10),
      body(3, 'Bone_Hair001', 2),
      body(4, 'Bone_Hair002', 3)
    ];
    const hairJoint = {
      index: 2,
      rigidBodyIndexA: 3,
      rigidBodyIndexB: 4,
      angularLimit: {
        lower: [-0.0872664675116539, -0.0872664675116539, -0.0872664675116539] as const,
        upper: [0.0872664675116539, 0.0872664675116539, 0.0872664675116539] as const
      }
    };
    const sleeveLimit = {
      lower: [-0.5235987901687622, -0.0872664675116539, -2.094395160675049] as const,
      upper: [0.5235987901687622, 0.0872664675116539, 2.094395160675049] as const
    };
    const joints = [
      {
        index: 0,
        rigidBodyIndexA: 0,
        rigidBodyIndexB: 1,
        angularLimit: sleeveLimit
      },
      {
        index: 1,
        rigidBodyIndexA: 1,
        rigidBodyIndexB: 2,
        angularLimit: sleeveLimit
      },
      hairJoint
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiledJoints = result.joints ?? [];
    const minimumLimit = DEFAULT_SECONDARY_MATERIAL_PROFILE.sleeveJointMinimumAngularLimitRadians;

    for (const jointIndex of [0, 1]) {
      const limits = profiledJoints[jointIndex].angularLimit;
      // X 轴 authored ±30° 基本不变（可能放宽到 ±minimumLimit，差 <2e-6 rad）；
      // Y 轴 ±5° 放宽到 ±30°；Z 轴 ±120° 不变。
      expect(limits?.lower?.[0]).toBeCloseTo(-0.5235987901687622, 5);
      expect(limits?.upper?.[0]).toBeCloseTo(0.5235987901687622, 5);
      expect(limits?.lower?.[1]).toBeCloseTo(-minimumLimit, 8);
      expect(limits?.upper?.[1]).toBeCloseTo(minimumLimit, 8);
      expect(limits?.lower?.[2]).toBeCloseTo(-2.094395160675049, 8);
      expect(limits?.upper?.[2]).toBeCloseTo(2.094395160675049, 8);
      // 无弹簧袖子关节获得回正弹簧。
      expect(profiledJoints[jointIndex].spring?.angular)
        .toEqual([6, 6, 6]);
    }
    // 非袖子关节的限制与弹簧保持 authored（无弹簧不加）。
    expect(profiledJoints[2].angularLimit).toBe(hairJoint.angularLimit);
    expect(profiledJoints[2].spring?.angular).toBeUndefined();
  });

  it('applies the wedding-rig garment smoothing band only to large-sleeve skeletons', () => {
    // 婚皮骨架签名：≥800 骨骼且 ≥60 袖骨（实测 894/110）。命中后袖子
    // 走更润顺的 0.83~0.93 阻尼带、质量 0.22、回弹 4；普通骨架仍走共享
    // 默认 0.80~0.90 / 0.25 / 6。
    const weddingSkeleton = (() => {
      const bones: Array<{ index: number; name: string; parentIndex: number }> = [
        { index: 0, name: 'センター', parentIndex: -1 },
        { index: 1, name: '左腕', parentIndex: 0 },
        { index: 2, name: '左袖', parentIndex: 1 },
        { index: 3, name: '左袖_0_1', parentIndex: 2 }
      ];
      for (let i = 4; i < 800; i++) {
        bones.push({
          index: i,
          name: i < 64 ? `左振袖_${i}` : `bone_${i}`,
          parentIndex: i < 64 ? 2 : 0
        });
      }
      return { bones } as const;
    })();
    const rigidBodies = [
      body(0, '左腕', 1, 'static'),
      { ...body(1, '左袖', 2), linearDamping: 0.99999, angularDamping: 2, mass: 8 },
      { ...body(2, '左袖_0_1', 3), linearDamping: 0.99999, angularDamping: 2, mass: 8 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const wedding = applySecondaryMaterialProfile({
      skeleton: weddingSkeleton,
      rigidBodies,
      joints
    });
    const weddingBodies = wedding.rigidBodies ?? [];
    expect(weddingBodies[1].linearDamping).toBe(0.93);
    expect(weddingBodies[1].angularDamping).toBe(0.93);
    expect(weddingBodies[1].mass).toBeCloseTo(8 * 0.22, 8);
    expect((wedding.joints ?? [])[1].spring?.angular).toEqual([4, 4, 4]);

    // 同样的袖链在普通骨架上保持共享默认档。
    const ordinary = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const ordinaryBodies = ordinary.rigidBodies ?? [];
    expect(ordinaryBodies[1].linearDamping).toBe(
      DEFAULT_SECONDARY_MATERIAL_PROFILE.sleeveMaximumLinearDamping
    );
    expect(ordinaryBodies[1].mass).toBeCloseTo(
      8 * DEFAULT_SECONDARY_MATERIAL_PROFILE.sleeveMassScale,
      8
    );
    expect((ordinary.joints ?? [])[1].spring?.angular).toEqual([6, 6, 6]);
  });

  it('classifies limb-anchored sleeve chains for collision opt-out without touching hair/bandage', () => {
    // 振袖（婚皮 group 4）锚定在手腕 static 碰撞体上。分类器必须把链内
    // 动态刚体加入 decorativeCollisionBoneIndices（collisionMask=0），
    // 从而消除振袖与手臂饰物/另一侧振袖之间的 Bullet 冲量；但头发、绷带
    // 与飘带链不受影响。
    const sleeveSkeleton = {
      bones: [
        { index: 0, name: 'センター', parentIndex: -1 },
        { index: 1, name: '右腕', parentIndex: 0 },
        { index: 2, name: '右袖', parentIndex: 1 },
        { index: 3, name: '右袖_0_1', parentIndex: 2 },
        { index: 4, name: '头', parentIndex: 0 },
        { index: 5, name: '后发总_0', parentIndex: 4 },
        { index: 6, name: '绷带_0', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '右腕', 1, 'static'),
      body(1, '右袖', 2),
      body(2, '右袖_0_1', 3),
      body(3, '头', 4, 'static'),
      body(4, '后发总_0', 5),
      body(5, '绷带_0', 6)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 3, rigidBodyIndexB: 4 },
      { index: 3, rigidBodyIndexA: 0, rigidBodyIndexB: 5 }
    ];

    const disabled = classifyDecorativeRigidBodyBoneIndices({ skeleton: sleeveSkeleton, rigidBodies, joints });
    // 只禁碰袖子刚体；头发（后发总）与绷带保持原碰撞。
    expect([...disabled].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('keeps ribbon strands anchored to an arm-followed sleeve collider at authored damping', () => {
    // 袖飘带链根锚定"袖子亲"（跟手的 static 碰撞体，刚体名含"袖"）。
    // 根松了既会甩（手臂动作时）也会抖（无弹簧无恢复力）。
    const rigidBodies = [
      body(0, '左袖子亲', 9, 'static'),
      body(1, '左上飘带_0_1', 6),
      body(2, '左上飘带_0_2', 7)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });

    expect(result.adjustedBodyIndices).toEqual([]);
    expect(result.decorativeCollisionBoneIndices).toEqual([]);
    expect((result.rigidBodies ?? [])[1]).toBe(rigidBodies[1]);
  });

  it('classifies torso-anchored skirt roots as gentle and free segments as tightened wake', () => {
    // 裙摆链（婚皮スカート）：根锚上半身，无弹簧。
    const rigidBodies = [
      body(0, '上半身', 11, 'static'),
      body(1, 'スカート_0_0', 4),
      body(2, 'スカート_0_1', 5)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    // 根：0.95 → 温和档（≥0.86），躯干小幅动画下裙根稳定。
    expect(profiled[1].linearDamping).toBeGreaterThanOrEqual(0.86);
    expect(profiled[1].linearDamping).toBeLessThanOrEqual(0.92);
    // 自由段：0.95 → 收紧唤醒档（0.78~0.90），重力下垂保留、抖动受抑。
    expect(profiled[2].linearDamping).toBeGreaterThanOrEqual(0.78);
    expect(profiled[2].linearDamping).toBeLessThanOrEqual(0.9);
  });

  it('keeps ribbon trains collision-free while retaining gravity-driven physics', () => {
    // 婚皮后飘带（右后缎带_0_1~_14_1）：无弹簧链挂在动态裙子刚体上，末端
    // 质量仅 0.01。唤醒（降低阻尼）后无恢复力的小质量链在待机时持续高频
    // 抖动。飘带仍保留重力输出，但通过窄带阻尼吸收数值 chatter，并移除
    // 链内碰撞，避免互相冲量把尾端抬飞。
    const weddingSkeleton = {
      bones: [
        { index: 0, name: 'センター', parentIndex: -1 },
        { index: 1, name: '上半身2', parentIndex: 0 },
        { index: 2, name: 'スカート_8_0', parentIndex: 1 },
        { index: 3, name: 'スカート_8_1', parentIndex: 2 },
        { index: 4, name: '右后裙子', parentIndex: 3 },
        { index: 5, name: '右后缎带_0_1', parentIndex: 4 },
        { index: 6, name: '右后缎带_14_1', parentIndex: 5 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '上半身2', 1, 'static'),
      body(1, 'スカート_8_0', 2),
      body(2, 'スカート_8_1', 3),
      { ...body(3, '右后裙子', 4), linearDamping: 1.0, angularDamping: 1.0 },
      { ...body(4, '右后缎带_0_1', 5), mass: 0.1, linearDamping: 0.2, angularDamping: 0.9 },
      { ...body(5, '右后缎带_14_1', 6), mass: 0.1, linearDamping: 1.0, angularDamping: 0.9 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3 },
      { index: 3, rigidBodyIndexA: 3, rigidBodyIndexB: 4 },
      { index: 4, rigidBodyIndexA: 4, rigidBodyIndexB: 5 }
    ];

    const result = applySecondaryMaterialProfile({
      skeleton: weddingSkeleton as any,
      rigidBodies,
      joints
    });
    const profiled = result.rigidBodies ?? [];

    // 飘带段保持重力和骨骼物理，但去掉碰撞，避免互相冲量抖动/飞起。
    expect(result.adjustedBodyIndices).toContain(4);
    expect(result.adjustedBodyIndices).toContain(5);
    expect(profiled[4]).not.toBe(rigidBodies[4]);
    expect(profiled[5]).not.toBe(rigidBodies[5]);
    expect(profiled[4].collisionMask).toBe(0);
    expect(profiled[5].collisionMask).toBe(0);
    // 裙摆链照旧唤醒（下垂保留）。
    expect(result.adjustedBodyIndices).toContain(1);
    expect(result.adjustedBodyIndices).toContain(3);
  });

  it('identifies small decorative ribbon and tassel bones for collision opt-out without touching skirt bodies', () => {
    const decorativeSkeleton = {
      bones: [
        { index: 0, name: '上半身', parentIndex: -1 },
        { index: 1, name: 'スカート_0_0', parentIndex: 0 },
        { index: 2, name: '左后缎带_0_1', parentIndex: 1 },
        { index: 3, name: '左后缎带_1_1', parentIndex: 2 },
        { index: 4, name: '左穗穗A_0_1', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '上半身', 0, 'static'),
      body(1, 'スカート_0_0', 1),
      { ...body(2, '左后缎带_0_1', 2), mass: 0.1 },
      { ...body(3, '左后缎带_1_1', 3), mass: 0.1 },
      { ...body(4, '左穗穗A_0_1', 4), mass: 0.1 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3 },
      { index: 3, rigidBodyIndexA: 1, rigidBodyIndexB: 4 }
    ];

    expect(classifyDecorativeRigidBodyBoneIndices({
      skeleton: decorativeSkeleton,
      rigidBodies,
      joints
    })).toEqual(new Set([2, 3, 4]));
  });

  it('applies decorative collision opt-out even when no damping profile is selected', () => {
    const decorativeSkeleton = {
      bones: [
        { index: 0, name: '上半身', parentIndex: -1 },
        { index: 1, name: '缎带_0', parentIndex: 0 },
        { index: 2, name: '缎带_1', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '上半身', 0, 'static'),
      { ...body(1, '缎带_0', 1), linearDamping: 0.2, angularDamping: 0.2 },
      { ...body(2, '缎带_1', 2), linearDamping: 0.2, angularDamping: 0.2 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({
      skeleton: decorativeSkeleton,
      rigidBodies,
      joints
    });

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    expect(result.decorativeCollisionBoneIndices).toEqual([1, 2]);
    expect(result.rigidBodies?.[0]).toBe(rigidBodies[0]);
    expect(result.rigidBodies?.[1]).not.toBe(rigidBodies[1]);
    expect(result.rigidBodies?.[2]).not.toBe(rigidBodies[2]);
    expect(result.rigidBodies?.[1].collisionMask).toBe(0);
    expect(result.rigidBodies?.[2].collisionMask).toBe(0);
    expect(rigidBodies[1].collisionMask).toBe(7);
  });

  it('gives spring-authored long-hair descendants a separate light response profile', () => {
    const rigidBodies = [
      body(0, 'hair-root', 2),
      body(1, 'hair-tip', 3),
      body(2, 'skirt-tip', 5)
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1,
        spring: { angular: [20, 20, 20] as const } },
      { index: 1, rigidBodyIndexA: 2, rigidBodyIndexB: 2,
        spring: { angular: [20, 20, 20] as const } }
    ];

    const result = applySecondaryMaterialProfile({ skeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(profiled[1].linearDamping).toBeLessThan(0.94);
    expect(profiled[1].angularDamping).toBeGreaterThanOrEqual(0.95);
    expect(profiled[1].angularDamping).toBeLessThan(0.98);
    expect(profiled[2].linearDamping).toBeLessThan(0.96);
  });

  it('does not over-lighten heavy long-hair segments while keeping light tips responsive', () => {
    const hairSkeleton = {
      bones: [
        { index: 0, name: '頭', parentIndex: -1 },
        { index: 1, name: '髪アンカー', parentIndex: 0 },
        { index: 2, name: '后发总_0', parentIndex: 1 },
        { index: 3, name: '后发总_1', parentIndex: 2 },
        { index: 4, name: '后发总_2', parentIndex: 3 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      { ...body(1, '后发总_0', 2), mass: 10, linearDamping: 0.9, angularDamping: 0.9 },
      { ...body(2, '后发总_1', 3), mass: 4, linearDamping: 0.9, angularDamping: 0.9 },
      { ...body(3, '后发总_2', 4), mass: 0.05, linearDamping: 0.95, angularDamping: 0.999 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1,
        spring: { angular: [10, 10, 10] as const } },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2,
        spring: { angular: [10, 10, 10] as const } },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3,
        spring: { angular: [10, 10, 10] as const } }
    ];

    const result = applySecondaryMaterialProfile({ skeleton: hairSkeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    // Heavy long-hair segments carry the chain's inertia. They must not be
    // lowered below the authored 0.9 damping, otherwise the tail peaks long
    // after a drag has ended. Light tips retain the separate airy profile.
    expect(result.adjustedBodyIndices).toContain(3);
    expect(profiled[2]).toBe(rigidBodies[2]);
    expect(profiled[2].linearDamping).toBeGreaterThanOrEqual(0.9);
    expect(profiled[2].angularDamping).toBeGreaterThanOrEqual(0.9);
    expect(profiled[3].linearDamping).toBeGreaterThanOrEqual(0.93);
    expect(profiled[3].linearDamping).toBeLessThan(0.95);
    expect(profiled[3].angularDamping).toBeGreaterThanOrEqual(0.98);
    expect(profiled[3].angularDamping).toBeLessThan(0.999);
  });

  it('keeps heavy spring-authored long hair responsive instead of pinning it at 0.99 angular damping', () => {
    const hairSkeleton = {
      bones: [
        { index: 0, name: '頭', parentIndex: -1 },
        { index: 1, name: '后发根', parentIndex: 0 },
        { index: 2, name: '后发长段', parentIndex: 1 }
      ]
    } as const;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      { ...body(1, '后发根', 1), mass: 8, linearDamping: 0.9, angularDamping: 0.999 },
      { ...body(2, '后发长段', 2), mass: 5, linearDamping: 0.9, angularDamping: 0.999 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1,
        spring: { angular: [10, 10, 10] as const } },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2,
        spring: { angular: [10, 10, 10] as const } }
    ];

    const result = applySecondaryMaterialProfile({ skeleton: hairSkeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(profiled[2].angularDamping).toBeLessThan(0.99);
    expect(profiled[2].angularDamping).toBeGreaterThanOrEqual(0.9);
  });

  it('profiles a non-ribbon waist pendant instead of leaving it at authored chatter damping', () => {
    const pendantSkeleton = {
      bones: [
        { name: '上半身', parentIndex: -1 },
        { name: '腰后挂件_0', parentIndex: 0 },
        { name: '腰后挂件_1', parentIndex: 1 }
      ]
    } as any;
    const rigidBodies = [
      body(0, '上半身', 0, 'static'),
      { ...body(1, '腰后挂件_0', 1), mass: 0.2, linearDamping: 0.2, angularDamping: 0.2 },
      { ...body(2, '腰后挂件_1', 2), mass: 0.05, linearDamping: 0.2, angularDamping: 0.2 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton: pendantSkeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    expect(profiled[1].linearDamping).toBeGreaterThanOrEqual(0.94);
    expect(profiled[1].linearDamping).toBeLessThanOrEqual(0.985);
    expect(profiled[1].collisionMask).toBe(0);
    expect(profiled[2].collisionMask).toBe(0);
  });

  it('quietens a small rear tassel even when its authored anchor is an arm collider', () => {
    const tasselSkeleton = {
      bones: [
        { name: '右腕', parentIndex: -1 },
        { name: '腰后穗穗A_0', parentIndex: 0 },
        { name: '腰后穗穗A_1', parentIndex: 1 }
      ]
    } as any;
    const rigidBodies = [
      body(0, '右腕', 0, 'static'),
      { ...body(1, '腰后穗穗A_0', 1), mass: 0.1, linearDamping: 0.2, angularDamping: 0.2 },
      { ...body(2, '腰后穗穗A_1', 2), mass: 0.03, linearDamping: 0.2, angularDamping: 0.2 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton: tasselSkeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2]);
    expect(profiled[1].linearDamping).toBeGreaterThanOrEqual(0.94);
    // The small decorative tail also opts out of mutual collision impulses;
    // gravity and Bullet bone output remain enabled.
    expect(profiled[1].collisionMask).toBe(0);
  });

  it('uses array-position parent topology when a loader skeleton omits numeric bone indices', () => {
    const loaderSkeleton = {
      bones: [
        { name: '頭', parentIndex: -1 },
        { name: 'HairRoot', parentIndex: 0 },
        { name: '后发A1', parentIndex: 1 },
        { name: '后发A2', parentIndex: 2 }
      ]
    } as any;
    const rigidBodies = [
      body(0, '頭', 0, 'static'),
      { ...body(1, 'HairRoot', 1), mass: 0.5, linearDamping: 0.9, angularDamping: 0.9 },
      { ...body(2, '后发A1', 2), mass: 0.2, linearDamping: 0.9, angularDamping: 0.9 },
      { ...body(3, '后发A2', 3), mass: 0.05, linearDamping: 0.99, angularDamping: 0.99 }
    ];
    const joints = [
      { index: 0, rigidBodyIndexA: 0, rigidBodyIndexB: 1 },
      { index: 1, rigidBodyIndexA: 1, rigidBodyIndexB: 2 },
      { index: 2, rigidBodyIndexA: 2, rigidBodyIndexB: 3 }
    ];

    const result = applySecondaryMaterialProfile({ skeleton: loaderSkeleton, rigidBodies, joints });
    const profiled = result.rigidBodies ?? [];

    expect(result.adjustedBodyIndices).toEqual([1, 2, 3]);
    expect(profiled[2].linearDamping).toBeLessThan(0.9);
    expect(profiled[3].linearDamping).toBeLessThan(0.99);
    expect(profiled[2].mass).toBe(0.2);
    expect(profiled[3].collisionMask).toBe(7);
  });
});
