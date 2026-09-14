import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createTransitionBridgeAnimation,
  isInertialTransitionBone,
  shouldInertializeTranslation,
  stabilizeGroundedRootTrack,
  type VmdLocalPose
} from '../../src/motion/motion-transition-bridge';

function pose(
  degrees: number,
  translation: readonly [number, number, number] = [0, 0, 0]
): VmdLocalPose {
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(degrees)
  );
  return {
    translation: [...translation],
    rotation: [q.x, q.y, q.z, q.w]
  };
}

describe('motion transition bridge', () => {
  it('inertializes animated parents and enables translation only on controller bones', () => {
    for (const safe of [
      '全ての親', 'センター', 'グルーブ', '腰', '下半身',
      '左足', '右足', '左ひざ', '右ひざ', '左足ＩＫ',
      '左足IK親', '右足ＩＫ親', '左足D', '右ひざD', '左足首D', '右足先EX'
    ]) {
      expect(isInertialTransitionBone(safe)).toBe(true);
    }
    for (const unsafe of ['Bhair_1', 'Dress_0_3', '左目']) {
      expect(isInertialTransitionBone(unsafe)).toBe(false);
    }
    for (const translated of ['センター', 'グルーブ', '腰', '左足ＩＫ', '右つま先ＩＫ', '左足IK親', '右足ＩＫ親']) {
      expect(shouldInertializeTranslation(translated)).toBe(true);
    }
    for (const rotationOnly of ['全ての親', '上半身', '下半身', '左足', '右腕']) {
      expect(shouldInertializeTranslation(rotationOnly)).toBe(false);
    }
  });
  it('builds one native MMD transition containing torso, arms, legs, center and foot IK', () => {
    const source = new Map<string, VmdLocalPose>([
      ['上半身', pose(-8)],
      ['右腕', pose(45)],
      ['左足', pose(10)],
      ['右足ＩＫ', pose(0, [0.2, 0, 0])],
      ['センター', pose(0, [0.1, 0.15, 0])]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['上半身', pose(12)],
      ['右腕', pose(-20)],
      ['右足', pose(-6)],
      ['左足ＩＫ', pose(0, [-0.2, 0, 0])],
      ['センター', pose(0, [-0.1, 0.05, 0])]
    ]);

    const result = createTransitionBridgeAnimation(source, target, { speedMultiplier: 1 });

    expect(Object.keys(result.animation.boneTracks)).toEqual(expect.arrayContaining([
      '上半身', '右腕', '左足', '右足', '左足ＩＫ', '右足ＩＫ', 'センター'
    ]));
    expect(result.durationSeconds).toBeGreaterThan(0.5);
    expect(result.animation.boneTracks['右腕'].frames[1])
      .toBeGreaterThan(result.animation.boneTracks['上半身'].frames[1]);
  });

  it('eases root changes without overshoot inside the bridge', () => {
    const source = new Map([['全ての親', pose(0, [1, 2, 3])]]);
    const target = new Map([['全ての親', pose(30, [9, 8, 7])]]);

    const { animation } = createTransitionBridgeAnimation(source, target, { speedMultiplier: 1 });
    const track = animation.boneTracks['全ての親'];
    const finalOffset = track.translations.length - 3;
    const finalRotationOffset = track.rotations.length - 4;

    expect(Array.from(track.translations.slice(finalOffset))).toEqual([1, 2, 3]);
    expect(Array.from(track.rotations.slice(finalRotationOffset))[2]).toBeCloseTo(0.258819, 5);
  });

  it('removes root translation and tilt while preserving vertical-axis facing', () => {
    const source = new Map([['全ての親', pose(0, [2, 4, 6])]]);
    const target = new Map<string, VmdLocalPose>();
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
    target.set('全ての親', {
      translation: [8, 10, 12],
      rotation: [yaw.x, yaw.y, yaw.z, yaw.w]
    });
    const rootTrack = createTransitionBridgeAnimation(source, target, { speedMultiplier: 1 })
      .animation.boneTracks['全ての親'];

    const stabilized = stabilizeGroundedRootTrack(rootTrack);

    expect(Array.from(stabilized.translations)).toEqual(new Array(stabilized.translations.length).fill(0));
    expect(stabilized.rotations[0]).toBeCloseTo(0, 6);
    expect(stabilized.rotations[2]).toBeCloseTo(0, 6);
    expect(stabilized.rotations[stabilized.rotations.length - 3]).toBeCloseTo(yaw.y, 5);
  });

  it('pins lower-body translations while preserving authored joint rotations', () => {
    const source = new Map<string, VmdLocalPose>([
      ['センター', pose(0, [0.1, 0.2, 0.3])],
      ['左足', pose(5, [0.01, 0.02, 0.03])],
      ['右足ＩＫ', pose(0, [0.04, 0.05, 0.06])]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['センター', pose(12, [0.9, 0.8, 0.7])],
      ['左足', pose(-18, [0.5, 0.4, 0.3])],
      ['右足ＩＫ', pose(7, [0.6, 0.5, 0.4])]
    ]);
    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      profile: 'speech-entry',
      frameRate: 30
    });

    for (const name of source.keys()) {
      const track = animation.boneTracks[name];
      const expected = source.get(name)!.translation;
      expect(track.translations[track.translations.length - 3]).toBeCloseTo(expected[0], 5);
      expect(track.translations[track.translations.length - 2]).toBeCloseTo(expected[1], 5);
      expect(track.translations[track.translations.length - 1]).toBeCloseTo(expected[2], 5);
    }
    const leg = animation.boneTracks['左足'];
    expect(Math.abs(leg.rotations[leg.rotations.length - 4 + 2])).toBeGreaterThan(0.1);
  });

  it('uses pose distance and the user speed multiplier to choose pair-specific duration', () => {
    const neutral = new Map([['右腕', pose(0)]]);
    const small = new Map([['右腕', pose(8)]]);
    const large = new Map([['右腕', pose(100)]]);

    const smallDuration = createTransitionBridgeAnimation(neutral, small, { speedMultiplier: 1 }).durationSeconds;
    const largeDuration = createTransitionBridgeAnimation(neutral, large, { speedMultiplier: 1 }).durationSeconds;
    const slowDuration = createTransitionBridgeAnimation(neutral, large, { speedMultiplier: 0.5 }).durationSeconds;

    expect(largeDuration).toBeGreaterThan(smallDuration);
    expect(slowDuration).toBeGreaterThanOrEqual(largeDuration);
    expect(slowDuration).toBeLessThanOrEqual(1.45 + 1 / 30);
  });

  it('gives distal wrist motion a broad delayed window and lets it settle after the neck', () => {
    const source = new Map<string, VmdLocalPose>([
      ['首', pose(-12)],
      ['右手首', pose(-45)]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['首', pose(15)],
      ['右手首', pose(35)]
    ]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30
    });
    const neckFrames = animation.boneTracks['首'].frames;
    const wristFrames = animation.boneTracks['右手首'].frames;
    const bridgeEnd = animation.metadata.maxFrame;

    expect(wristFrames[1]).toBeGreaterThan(neckFrames[1]);
    expect(wristFrames[wristFrames.length - 1]).toBeGreaterThan(neckFrames[neckFrames.length - 1]);
    expect(wristFrames[wristFrames.length - 1] - wristFrames[1]).toBeGreaterThanOrEqual(
      Math.floor(bridgeEnd * 0.8)
    );
  });

  it('stores bridge quaternion endpoints on the same hemisphere for a short arc', () => {
    const source = new Map([['首', pose(170)]]);
    const target = new Map([['首', pose(-170)]]);

    const track = createTransitionBridgeAnimation(source, target, { speedMultiplier: 1 })
      .animation.boneTracks['首'];
    const first = new THREE.Quaternion(
      track.rotations[0],
      track.rotations[1],
      track.rotations[2],
      track.rotations[3]
    );
    const finalOffset = track.rotations.length - 4;
    const last = new THREE.Quaternion(
      track.rotations[finalOffset],
      track.rotations[finalOffset + 1],
      track.rotations[finalOffset + 2],
      track.rotations[finalOffset + 3]
    );

    expect(first.dot(last)).toBeGreaterThanOrEqual(0);
  });

  it('keeps speech bridges brief and settles head and neck after the arms', () => {
    const source = new Map<string, VmdLocalPose>([
      ['上半身', pose(-10)],
      ['首', pose(28)],
      ['頭', pose(24)],
      ['右腕', pose(70)],
      ['左腕', pose(-65)]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['上半身', pose(0)],
      ['首', pose(0)],
      ['頭', pose(0)],
      ['右腕', pose(0)],
      ['左腕', pose(0)]
    ]);

    const normal = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30
    });
    const recovery = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-to-idle-recovery'
    });
    const entry = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-entry'
    });
    const lastFrame = (name: string): number => {
      const frames = recovery.animation.boneTracks[name].frames;
      return frames[frames.length - 1];
    };

    // 更从容的语音桥：入场/回收都给完整关节链留出跟随时间，避免手臂和腿部突变。
    // 2026-08 二次放宽：用户反馈语音动作进入仍偏快，speech-entry 下限 1.4s。
    expect(entry.durationSeconds).toBeGreaterThanOrEqual(1.4 - 1 / 30);
    expect(entry.durationSeconds).toBeLessThanOrEqual(1.8 + 1 / 30);
    expect(recovery.durationSeconds).toBeGreaterThanOrEqual(1.25 - 1 / 30);
    expect(recovery.durationSeconds).toBeLessThanOrEqual(1.8 + 1 / 30);
    expect(lastFrame('首')).toBeGreaterThan(lastFrame('右腕'));
    expect(lastFrame('頭')).toBeGreaterThan(lastFrame('左腕'));
    expect(lastFrame('上半身')).toBeLessThan(lastFrame('首'));
  });

  it('eases bridge keyframes along a pronounced natural S-curve instead of near-linear blending', () => {
    const source = new Map<string, VmdLocalPose>([['右腕', pose(70)]]);
    const target = new Map<string, VmdLocalPose>([['右腕', pose(0)]]);
    const bridge = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-entry'
    });
    const track = bridge.animation.boneTracks['右腕'];

    // 每个关键帧段的 4 个通道（X/Y/Z/旋转）都携带更强的 ease-in-out 控制点。
    // 旧的 (0.25, 0, 0.75, 1) 曲线在 1/4 时间处已完成约 18.5% 的变化，接近
    // 线性；(0.36, 0, 0.64, 1) 把同一位置压到约 14.8%，起步与收尾更柔。
    for (let frameIndex = 1; frameIndex < track.frames.length; frameIndex += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        const offset = frameIndex * 16 + channel * 4;
        expect(track.interpolations[offset]).toBeCloseTo(0.36, 5);
        expect(track.interpolations[offset + 1]).toBeCloseTo(0, 5);
        expect(track.interpolations[offset + 2]).toBeCloseTo(0.64, 5);
        expect(track.interpolations[offset + 3]).toBeCloseTo(1, 5);
      }
    }

    // 行为验证：用控制点求值贝塞尔——1/4 时间完成 <17%，3/4 时间完成 >83%，
    // 中点恰好 50%。旧曲线 (18.5%/81.5%) 无法通过。
    const evaluate = (x: number): number => {
      let low = 0;
      let high = 1;
      for (let step = 0; step < 48; step += 1) {
        const t = (low + high) / 2;
        const tX = 3 * (1 - t) * (1 - t) * t * 0.36
          + 3 * (1 - t) * t * t * 0.64
          + t * t * t;
        if (tX < x) low = t; else high = t;
      }
      const t = (low + high) / 2;
      return 3 * t * t - 2 * t * t * t;
    };
    expect(evaluate(0.25)).toBeLessThan(0.17);
    expect(evaluate(0.75)).toBeGreaterThan(0.83);
    expect(evaluate(0.5)).toBeCloseTo(0.5, 5);
  });

  it('moves the complete lower-body chain on one bridge window', () => {
    const pose = (angle: number) => ({
      translation: [0, 0, 0] as const,
      rotation: [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)] as const
    });
    const names = [
      '全ての親', 'センター', 'グルーブ', '腰', '下半身',
      '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首',
      '左足IK親', '右足ＩＫ親', '左足ＩＫ', '右足ＩＫ',
      '左つま先ＩＫ', '右つま先ＩＫ',
      '左足D', '右足D', '左ひざD', '右ひざD',
      '左足首D', '右足首D', '左足先EX', '右足先EX'
    ];
    const source = new Map(names.map(name => [name, pose(0)]));
    const target = new Map(names.map(name => [name, pose(0.25)]));
    const result = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      profile: 'speech-entry',
      frameRate: 30
    });
    const windows = names.map(name => [...result.animation.boneTracks[name].frames]);
    expect(new Set(windows.map(window => window.join(':'))).size).toBe(1);
  });

  it('routes a rear-held arm through clearance and relaxed side waypoints', () => {
    const source = new Map<string, VmdLocalPose>([['左腕', pose(105)]]);
    const target = new Map<string, VmdLocalPose>([['左腕', pose(-40)]]);
    const clearance = pose(35);
    const relaxedSide = pose(-18);
    const entry = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-entry',
      waypointSequences: new Map([['左腕', [clearance, relaxedSide]]])
    });
    const track = entry.animation.boneTracks['左腕'];

    expect(track.frames.length).toBe(5);
    expect(track.frames[2]).toBeLessThan(track.frames[3]);
    expect(track.frames[3]).toBeLessThan(track.frames[4]);
    const readRotation = (index: number) => new THREE.Quaternion(
      track.rotations[index * 4],
      track.rotations[index * 4 + 1],
      track.rotations[index * 4 + 2],
      track.rotations[index * 4 + 3]
    );
    expect(readRotation(2).angleTo(new THREE.Quaternion(...clearance.rotation).normalize())).toBeLessThan(1e-3);
    expect(readRotation(3).angleTo(new THREE.Quaternion(...relaxedSide.rotation).normalize())).toBeLessThan(1e-3);
  });

  it('allocates a restrained speech bridge for a staged rear-arm side route', () => {
    const source = new Map<string, VmdLocalPose>([['左腕', pose(105)]]);
    const target = new Map<string, VmdLocalPose>([['左腕', pose(-40)]]);
    const staged = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-entry',
      waypointSequences: new Map([['左腕', [pose(-18), pose(-18)]]])
    });

    // 2026-08 二次放宽：带 waypoint 的 speech-entry 路线下限 1.5s。
    expect(staged.durationSeconds).toBeGreaterThanOrEqual(1.5 - 1 / 30);
    expect(staged.durationSeconds).toBeLessThanOrEqual(1.9 + 1 / 30);
    expect(staged.animation.boneTracks['左腕'].frames.length).toBe(5);
  });

  it('caps a speech-entry bridge so a very short user action remains visible', () => {
    const source = new Map<string, VmdLocalPose>([['左腕', pose(105)]]);
    const target = new Map<string, VmdLocalPose>([['左腕', pose(-40)]]);
    const shortEntry = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 0.7,
      frameRate: 30,
      profile: 'speech-entry',
      maximumDurationSeconds: 0.5,
      waypointSequences: new Map([['左腕', [pose(-18), pose(-18)]]])
    });

    expect(shortEntry.durationSeconds).toBeGreaterThanOrEqual(0.45);
    expect(shortEntry.durationSeconds).toBeLessThanOrEqual(0.5 + 1 / 30);
    expect(shortEntry.animation.boneTracks['左腕'].frames.length).toBe(5);
  });

  it('keeps velocity continuous through intermediate waypoints instead of stopping', () => {
    // 多段 waypoint 路线（如背后手）此前每段都是 ease-in-out：中间关键帧处
    // 速度归零，观感"走走停停"（2026-08 用户反馈"动作连贯性差"）。现在
    // 中间关键帧的到达/离开斜率按相邻段平均角速度匹配，段边界非零速。
    const source = new Map<string, VmdLocalPose>([['左腕', pose(105)]]);
    const target = new Map<string, VmdLocalPose>([['左腕', pose(-40)]]);
    const staged = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      profile: 'speech-entry',
      waypointSequences: new Map([['左腕', [pose(35), pose(-18)]]])
    });
    const track = staged.animation.boneTracks['左腕'];
    expect(track.frames.length).toBe(5);

    // 旋转通道（channel 3）：每个真实运动的中间关键帧（桥首 hold 段
    // source→source 静止，被有意跳过）前段终点 y2 与后段起点 y1 不再是
    // ease-in-out 的 1 / 0（速度衰减到零），速度连续可导。
    const rotationChannel = 3;
    const readRotation = (index: number) => new THREE.Quaternion(
      track.rotations[index * 4],
      track.rotations[index * 4 + 1],
      track.rotations[index * 4 + 2],
      track.rotations[index * 4 + 3]
    );
    for (let keyIndex = 1; keyIndex < track.frames.length - 1; keyIndex += 1) {
      const previousSegmentAngle = readRotation(keyIndex - 1).angleTo(readRotation(keyIndex));
      const nextSegmentAngle = readRotation(keyIndex).angleTo(readRotation(keyIndex + 1));
      // Float32Array 精度损失会让静止段残余 ~5e-4 rad，放宽到 1e-3。
      if (previousSegmentAngle < 1e-3 || nextSegmentAngle < 1e-3) continue;
      const arriveOffset = keyIndex * 16 + rotationChannel * 4;
      const leaveOffset = (keyIndex + 1) * 16 + rotationChannel * 4;
      const arriveY2 = track.interpolations[arriveOffset + 3];
      const leaveY1 = track.interpolations[leaveOffset + 1];
      expect(arriveY2).toBeLessThan(1);
      expect(leaveY1).toBeGreaterThan(0);
    }

    // 行为验证：等角速度的匀称路线（每段转角接近）在中间关键帧处接近
    // 匀速通过（斜率≈1，受 clamp 上限 0.85 约束）：y2 接近 0.69、y1 接近
    // 0.31，与 ease-in-out 的 1/0（速度归零）明显区分。
    const balanced = createTransitionBridgeAnimation(
      new Map<string, VmdLocalPose>([['左腕', pose(60)]]),
      new Map<string, VmdLocalPose>([['左腕', pose(0)]]),
      {
        speedMultiplier: 1,
        frameRate: 30,
        profile: 'speech-entry',
        waypointSequences: new Map([['左腕', [pose(40), pose(20)]]])
      }
    );
    const balancedTrack = balanced.animation.boneTracks['左腕'];
    const midArriveOffset = 2 * 16 + rotationChannel * 4;
    const midLeaveOffset = 3 * 16 + rotationChannel * 4;
    expect(balancedTrack.interpolations[midArriveOffset + 3]).toBeGreaterThan(0.6);
    expect(balancedTrack.interpolations[midArriveOffset + 3]).toBeLessThan(0.75);
    expect(balancedTrack.interpolations[midLeaveOffset + 1]).toBeGreaterThan(0.25);
    expect(balancedTrack.interpolations[midLeaveOffset + 1]).toBeLessThan(0.4);
  });

  // ============================================================
  // P1: 速度连续桥（C1）与 P3: 角度自适应时间窗
  // ============================================================

  it('continues mid-motion handoffs at the outgoing angular speed (C1)', () => {
    const source = new Map<string, VmdLocalPose>([['右腕', pose(0)]]);
    const target = new Map<string, VmdLocalPose>([['右腕', pose(-30)]]);
    // 0.1s 内运动 10° => 1.75 rad/s，属于真实手势中段速度。
    const velocity = new Map<string, VmdLocalPose>([['右腕', pose(10)]]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      sourceVelocityPoses: velocity,
      sourceVelocityLookaheadSeconds: 0.1
    });
    const track = animation.boneTracks['右腕'];

    // [source, 外推保持帧, 外推 waypoint, target]：不再冻结后重新起步。
    expect(track.frames.length).toBe(4);
    expect(track.frames[1]).toBeLessThan(track.frames[2]);
    expect(track.frames[2]).toBeLessThan(track.frames[3]);
    const waypointRotation = new THREE.Quaternion(
      track.rotations[8],
      track.rotations[9],
      track.rotations[10],
      track.rotations[11]
    );
    expect(waypointRotation.angleTo(new THREE.Quaternion(...pose(10).rotation).normalize()))
      .toBeLessThan(1e-3);
    // 速度段（含穿过原 hold 段）使用线性控制点，斜率恒定。
    for (const keyIndex of [1, 2]) {
      for (let channel = 0; channel < 4; channel += 1) {
        const offset = keyIndex * 16 + channel * 4;
        expect(track.interpolations[offset]).toBeCloseTo(0.2, 5);
        expect(track.interpolations[offset + 1]).toBeCloseTo(0.2, 5);
        expect(track.interpolations[offset + 2]).toBeCloseTo(0.8, 5);
        expect(track.interpolations[offset + 3]).toBeCloseTo(0.8, 5);
      }
    }
    // 最后一段旋转通道起始斜率 > 0：桥尾不减速到零再让目标动作突起步。
    const lastRotationOffset = 3 * 16 + 3 * 4;
    expect(track.interpolations[lastRotationOffset + 1]).toBeGreaterThan(0);
    expect(track.interpolations[lastRotationOffset + 1]).toBeLessThanOrEqual(0.85);
  });

  it('skips the velocity waypoint for negligible outgoing motion', () => {
    const source = new Map<string, VmdLocalPose>([['右腕', pose(0)]]);
    const target = new Map<string, VmdLocalPose>([['右腕', pose(-30)]]);
    // 0.1s 内仅 0.5°（< 0.18 rad/s），外推无意义。
    const velocity = new Map<string, VmdLocalPose>([['右腕', pose(0.5)]]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      sourceVelocityPoses: velocity,
      sourceVelocityLookaheadSeconds: 0.1
    });

    expect(animation.boneTracks['右腕'].frames.length).toBe(3);
  });

  it('never extrapolates lower-body bones even when velocity is provided', () => {
    const source = new Map<string, VmdLocalPose>([['左足', pose(0)]]);
    const target = new Map<string, VmdLocalPose>([['左足', pose(10)]]);
    const velocity = new Map<string, VmdLocalPose>([['左足', pose(8)]]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      sourceVelocityPoses: velocity,
      sourceVelocityLookaheadSeconds: 0.1
    });

    // 下半身保持原有的三关键帧 eased 轨道与同一时钟策略。
    expect(animation.boneTracks['左足'].frames.length).toBe(3);
  });

  it('damps a strong away-from-target extrapolation before it becomes visible', () => {
    const source = new Map<string, VmdLocalPose>([['右腕', pose(0)]]);
    const target = new Map<string, VmdLocalPose>([['右腕', pose(-5)]]);
    // 0.1s 内 70°（12 rad/s）：外推方向严重远离目标，应被衰减到小幅 follow-through。
    const velocity = new Map<string, VmdLocalPose>([['右腕', pose(70)]]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      sourceVelocityPoses: velocity,
      sourceVelocityLookaheadSeconds: 0.1
    });
    const track = animation.boneTracks['右腕'];

    expect(track.frames.length).toBe(4);
    const waypointRotation = new THREE.Quaternion(
      track.rotations[8],
      track.rotations[9],
      track.rotations[10],
      track.rotations[11]
    );
    const sourceRotation = new THREE.Quaternion(...pose(0).rotation).normalize();
    // 衰减后外推角 < 0.1 rad（原始外推约 0.3 rad）。
    expect(waypointRotation.angleTo(sourceRotation)).toBeLessThan(0.1);
    expect(waypointRotation.angleTo(sourceRotation)).toBeGreaterThan(0.02);
  });

  it('lets the bridge tail carry the target clip opening speed', () => {
    const source = new Map<string, VmdLocalPose>([['右腕', pose(0)]]);
    const target = new Map<string, VmdLocalPose>([['右腕', pose(-30)]]);
    // 目标 clip 开场 0.1s 内继续转 15°（2.6 rad/s）。
    const targetVelocity = new Map<string, VmdLocalPose>([['右腕', pose(-45)]]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30,
      targetVelocityPoses: targetVelocity,
      targetVelocityLookaheadSeconds: 0.1
    });
    const track = animation.boneTracks['右腕'];

    // 无 sourceVelocity：仍是普通三关键帧轨道。
    expect(track.frames.length).toBe(3);
    const lastRotationOffset = 2 * 16 + 3 * 4;
    // 旋转通道结束斜率被放宽（y2 < 1），平移通道保持默认 S 曲线。
    expect(track.interpolations[lastRotationOffset + 3]).toBeLessThan(1);
    expect(track.interpolations[lastRotationOffset + 3]).toBeGreaterThanOrEqual(0.15);
    const lastTranslationOffset = 2 * 16 + 0 * 4;
    expect(track.interpolations[lastTranslationOffset]).toBeCloseTo(0.36, 5);
    expect(track.interpolations[lastTranslationOffset + 3]).toBeCloseTo(1, 5);
  });

  it('starts large-swing upper-body bones earlier than small-swing peers (P3)', () => {
    const source = new Map<string, VmdLocalPose>([
      ['左腕', pose(0)],
      ['右腕', pose(0)]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['左腕', pose(5)],
      ['右腕', pose(90)]
    ]);

    const { animation } = createTransitionBridgeAnimation(source, target, {
      speedMultiplier: 1,
      frameRate: 30
    });

    // 同组骨骼：转角大的右腕更早启动，不再等到桥尾仓促赶位。
    expect(animation.boneTracks['右腕'].frames[1])
      .toBeLessThan(animation.boneTracks['左腕'].frames[1]);
    // 下半身不受角度自适应影响（同一时钟）。
    const lowerSource = new Map<string, VmdLocalPose>([['左足', pose(0)], ['右足', pose(0)]]);
    const lowerTarget = new Map<string, VmdLocalPose>([['左足', pose(2)], ['右足', pose(40)]]);
    const lower = createTransitionBridgeAnimation(lowerSource, lowerTarget, {
      speedMultiplier: 1,
      frameRate: 30
    });
    expect(lower.animation.boneTracks['左足'].frames.join(':'))
      .toBe(lower.animation.boneTracks['右足'].frames.join(':'));
  });
});
