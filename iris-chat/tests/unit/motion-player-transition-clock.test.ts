import { describe, expect, it, vi } from 'vitest';
import {
  collectTransitionBoneNames,
  getLoopCycle,
  MotionPlayer,
  normalizePlayableAvatarDuration,
  resolvePlayableAvatarMaxFrame
} from '../../src/motion/motion-player';
import { BoneOwnershipRegistry, MorphOwnershipRegistry } from '../../src/actor/bone-ownership-registry';
import * as THREE from 'three';

function buildTestVmd(boneName: string, frame = 0): Uint8Array {
  const bytes = new Uint8Array(30 + 20 + 4 + 111 + 4 + 16);
  bytes.set(new TextEncoder().encode('Vocaloid Motion Data 0002'), 0);
  let offset = 50;
  new DataView(bytes.buffer).setUint32(offset, 1, true);
  offset += 4;
  const encodedBoneName = boneName === '下半身'
    ? new Uint8Array([0x89, 0xba, 0x94, 0xbc, 0x90, 0x67])
    : new TextEncoder().encode(boneName);
  bytes.set(encodedBoneName.slice(0, 15), offset);
  offset += 15;
  new DataView(bytes.buffer).setUint32(offset, frame, true);
  offset += 4 + 12;
  new DataView(bytes.buffer).setFloat32(offset + 12, 1, true);
  offset += 16 + 64;
  new DataView(bytes.buffer).setUint32(offset, 0, true);
  return bytes;
}

function buildTestMorphVmd(morphName: string): Uint8Array {
  const bytes = new Uint8Array(30 + 20 + 4 + 4 + 15 + 4 + 4 + 16);
  bytes.set(new TextEncoder().encode('Vocaloid Motion Data 0002'), 0);
  const view = new DataView(bytes.buffer);
  let offset = 50;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  bytes.set(new TextEncoder().encode(morphName).slice(0, 15), offset);
  offset += 15;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setFloat32(offset, 0.5, true);
  return bytes;
}

describe('MotionPlayer retained animation clock', () => {
  it('ignores malformed metadata sentinels and uses authored avatar-track duration', () => {
    const boneTrack = {
      packed: 'bone',
      frames: new Uint32Array([0, 46]),
      translations: new Float32Array(6),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      interpolations: new Float32Array(32),
      physicsToggles: new Int8Array([-1, -1])
    } as any;
    const loaded = {
      bytes: new Uint8Array(),
      animation: {
        kind: 'vmd',
        bytes: new Uint8Array(),
        metadata: {
          modelName: 'sentinel fixture',
          maxFrame: 0xFFFFFFFF,
          counts: { bones: 2, morphs: 0, cameras: 0, lights: 0, selfShadows: 0, properties: 1 }
        },
        boneTracks: { RightArm: boneTrack },
        morphTracks: {},
        cameraFrames: [],
        lightFrames: [],
        selfShadowFrames: [],
        propertyFrames: [{ frame: 0xFFFFFFFF }]
      },
      boneTracks: { RightArm: boneTrack },
      morphTracks: {}
    } as any;

    expect(resolvePlayableAvatarMaxFrame(loaded)).toBe(46);
    expect(normalizePlayableAvatarDuration(loaded).animation.metadata.maxFrame).toBe(46);
  });

  it('defaults to a restrained transition speed for natural dialogue handoffs', () => {
    const player = new MotionPlayer(
      { mesh: { skeleton: { bones: [] } } } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    expect(player.getTransitionSpeed()).toBe(0.7);
  });

  it('slows only model sampling while retaining wall-clock motion progress', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [] }, morphTargetDictionary: {} },
        runtime: { clearAnimation: vi.fn() },
        setAnimation: vi.fn()
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('slow-speech', buildTestVmd('UpperBody', 120), {
      looping: false,
      playbackRate: 0.84
    });
    nowMs = 1_000;

    expect(player.getCurrentAnimationTime()).toBeCloseTo(1, 6);
    expect(player.getCurrentModelUpdateTime()).toBeCloseTo(0.84, 6);
    expect(player.getAnimationDuration()).toBeCloseTo(4 / 0.84, 6);
  });

  it('keeps candidate motion preview from claiming its paired expression morphs', async () => {
    const model = {
      mesh: { skeleton: { bones: [] }, morphTargetDictionary: { Smile: 0 } },
      runtime: { clearAnimation: vi.fn() },
      setAnimation: vi.fn()
    } as any;
    const ordinary = new MotionPlayer(
      model,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    await ordinary.play('ordinary', buildTestMorphVmd('Smile'), { looping: false });
    expect(ordinary.getCurrentMorphNames()).toEqual(['Smile']);

    const candidate = new MotionPlayer(
      model,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    await candidate.play('candidate-motion-only', buildTestMorphVmd('Smile'), {
      looping: false,
      candidateExpressionPolicy: 'separate'
    });
    expect(candidate.getCurrentMorphNames()).toEqual([]);
  });

  it('keeps outgoing-only arm bones in the next transition snapshot', () => {
    const transitionBones = collectTransitionBoneNames(
      ['右腕'],
      ['上半身'],
      new Map([['右ひじ', {}]])
    );

    expect(transitionBones).toEqual(['右腕', '上半身', '右ひじ']);
  });

  it('keeps authored leg and IK controls in the bridge without taking ownership of PMX helper chains', () => {
    const transitionBones = collectTransitionBoneNames(
      ['右足', '右ひざ', '右足首', '右足ＩＫ', '右足D', '右ひざD', '右足首D', '右足先EX'],
      ['下半身', '左足', '左足ＩＫ', '左足D', '左足先EX'],
      new Map()
    );

    expect(transitionBones).toEqual([
      '右足', '右ひざ', '右足首', '右足ＩＫ',
      '下半身', '左足', '左足ＩＫ'
    ]);
  });

  it('reports a new loop cycle without wrapping the animation clock itself', () => {
    expect(getLoopCycle(1.99, 2)).toBe(0);
    expect(getLoopCycle(2, 2)).toBe(1);
    expect(getLoopCycle(6.1, 2)).toBe(3);
  });

  it('binds a pose-aware native bridge before the next VMD', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const bones = ['UpperBody', 'RightArm'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.userData.mmdBoneName = name;
      return bone;
    });
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('idle-a', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    await player.play('idle-b', buildTestVmd('RightArm'), {
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.2
    });
    expect(setAnimation).toHaveBeenCalledTimes(2);
    const boundAnimation = setAnimation.mock.calls[1][0];
    expect(boundAnimation.metadata.name).toBe('pose-aware-transition-bridge');
    expect(player.getState()).toBe('bridging');

    nowMs = 4_000;
    player.applyFadeBlend();
    expect(setAnimation).toHaveBeenCalledTimes(3);
    expect(player.getState()).toBe('playing');
    expect(player.getCurrentPackId()).toBe('idle-b');
  });

  it('binds a speech-entry bridge even when no outgoing VMD is loaded', async () => {
    // 上一个回复已淡出（head-only / 无出口 VMD）时，speech-entry 仍必须
    // 走 native 桥：否则目标 clip 帧 0 直接生效，身体/腿部一帧内跳变。
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const bones = ['UpperBody', 'RightArm'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.userData.mmdBoneName = name;
      return bone;
    });
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('first-speech', buildTestVmd('UpperBody'), {
      fadeInSeconds: 0.2,
      transitionProfile: 'speech-entry'
    });

    expect(setAnimation).toHaveBeenCalledTimes(1);
    expect(setAnimation.mock.calls[0][0].metadata.name).toBe('pose-aware-transition-bridge');
    expect(player.getState()).toBe('bridging');

    // 桥结束后正常进入目标 clip。
    nowMs = 4_000;
    player.applyFadeBlend();
    expect(setAnimation).toHaveBeenCalledTimes(2);
    expect(player.getState()).toBe('playing');
    expect(player.getCurrentPackId()).toBe('first-speech');
  });

  it('uses a bounded native recovery bridge and then binds the selected idle', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const upperBody = new THREE.Bone();
    upperBody.name = 'UpperBody';
    upperBody.userData.mmdBoneName = 'UpperBody';
    const rightArm = new THREE.Bone();
    rightArm.name = 'RightArm';
    rightArm.userData.mmdBoneName = 'RightArm';
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [upperBody, rightArm] }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('speech', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    upperBody.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(80)
    );

    await player.play('selected-idle', buildTestVmd('RightArm'), {
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.2,
      transitionProfile: 'speech-to-idle-recovery'
    });

    const boundBridge = setAnimation.mock.calls[1][0];
    expect(boundBridge.metadata.name).toBe('pose-aware-transition-bridge');
    expect(player.getCurrentPackId()).toBe('selected-idle');
    expect(player.getState()).toBe('bridging');
    const recoveryBridgeSeconds = (player as any).animationDurationSec as number;
    // 回收桥同样放宽到 0.95~1.3s：80° 上身回正需要更长的中段行程。
    expect(recoveryBridgeSeconds).toBeGreaterThanOrEqual(0.95 - 1 / 30);
    expect(recoveryBridgeSeconds).toBeLessThanOrEqual(1.3 + 1 / 30);
    nowMs += recoveryBridgeSeconds * 1_000 + 1;
    player.applyFadeBlend();
    expect(setAnimation.mock.calls[2][0].metadata.name).not.toBe('pose-aware-transition-bridge');
    expect(player.getState()).toBe('playing');
  });

  it('lands a full-body recovery bridge on the selected idle lower body before takeover', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const lowerBody = new THREE.Bone();
    lowerBody.name = '下半身';
    lowerBody.userData.mmdBoneName = '下半身';
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [lowerBody] }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn(),
          resetPose: vi.fn(),
          seek: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    await player.play('speech-cue:full-body', buildTestVmd('下半身'), {
      fadeInSeconds: 0.2,
      candidateTrackPolicy: 'trusted-voice-full-body'
    });
    nowMs = 800;
    player.applyFadeBlend();
    lowerBody.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(7)
    );
    const visibleAtBridgeEnd = lowerBody.quaternion.clone();

    await player.play('selected-default-idle', buildTestVmd('下半身'), {
      looping: true,
      fadeInSeconds: 1,
      fadeOutSeconds: 1,
      force: true,
      transitionProfile: 'speech-to-idle-recovery'
    });
    const bridgeTrack = setAnimation.mock.calls[1][0].boneTracks['下半身'];
    const finalRotationOffset = bridgeTrack.rotations.length - 4;
    const bridgeEnd = new THREE.Quaternion(
      bridgeTrack.rotations[finalRotationOffset],
      bridgeTrack.rotations[finalRotationOffset + 1],
      bridgeTrack.rotations[finalRotationOffset + 2],
      bridgeTrack.rotations[finalRotationOffset + 3]
    );
    expect(bridgeEnd.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);

    const bridgeSeconds = (player as any).animationDurationSec as number;
    // 全身回收（含下半身）的最短桥从 1.55s 提高到 1.7s，腿/裙摆链有更
    // 充分的时间回到 idle 站姿，避免收尾抢拍。
    expect(bridgeSeconds).toBeGreaterThanOrEqual(1.7);
    nowMs += bridgeSeconds * 1_000 + 1;
    player.applyFadeBlend();
    expect(player.getState()).toBe('playing');

    // Simulate the next runtime sample from the selected full-body idle. Since
    // the native bridge already landed on frame zero, no post-model leg hold
    // may overwrite the pre-physics target sample.
    lowerBody.quaternion.identity();
    nowMs += 50;
    player.applyFadeBlend();

    expect(lowerBody.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    expect(lowerBody.quaternion.angleTo(visibleAtBridgeEnd)).toBeGreaterThan(0.1);
  });

  it('keeps the selected idle lower-body pose during dialogue-only recovery', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const lowerBody = new THREE.Bone();
    lowerBody.name = '下半身';
    lowerBody.userData.mmdBoneName = '下半身';
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [lowerBody] }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn(),
          resetPose: vi.fn(),
          seek: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    const rebaseGroundedTracks = vi.spyOn(
      player as any,
      'rebaseStaticGroundedTracksAtBridgeFinish'
    );

    await player.play('speech-body', buildTestVmd('下半身'), {
      fadeInSeconds: 0.2,
      candidateTrackPolicy: 'trusted-voice-full-body'
    });
    nowMs = 800;
    player.applyFadeBlend();
    lowerBody.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(10)
    );
    const visiblePose = lowerBody.quaternion.clone();

    await player.play('selected-default-idle', buildTestVmd('下半身'), {
      looping: true,
      timeSource: 'local-clock',
      fadeInSeconds: 1,
      fadeOutSeconds: 1,
      force: true,
      candidateTrackPolicy: 'dialogue-body-only',
      transitionProfile: 'speech-to-idle-recovery'
    });

    const bridgeTrack = setAnimation.mock.calls[1][0].boneTracks['下半身'];
    const finalRotationOffset = bridgeTrack.rotations.length - 4;
    const bridgeEnd = new THREE.Quaternion(
      bridgeTrack.rotations[finalRotationOffset],
      bridgeTrack.rotations[finalRotationOffset + 1],
      bridgeTrack.rotations[finalRotationOffset + 2],
      bridgeTrack.rotations[finalRotationOffset + 3]
    );
    expect(bridgeEnd.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);

    const bridgeSeconds = (player as any).animationDurationSec as number;
    nowMs += bridgeSeconds * 1_000 + 1;
    player.applyFadeBlend();
    expect(rebaseGroundedTracks).not.toHaveBeenCalled();
  });

  it('binds a short pre-physics bridge before the selected speech cue', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const bones = ['UpperBody', 'RightArm'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.userData.mmdBoneName = name;
      return bone;
    });
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('selected-idle', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    await player.play('speech-cue:user-selected', buildTestVmd('RightArm', 60), {
      fadeInSeconds: 0.24,
      fadeOutSeconds: 0.24,
      transitionProfile: 'speech-entry'
    });

    expect(setAnimation).toHaveBeenCalledTimes(2);
    expect(setAnimation.mock.calls[1][0].metadata.name).toBe('pose-aware-transition-bridge');
    expect(player.getCurrentPackId()).toBe('speech-cue:user-selected');
    expect(player.getState()).toBe('bridging');
    const bridgeSeconds = (player as any).animationDurationSec as number;
    // 语音动作入口需要留出完整的关节链跟随时间，不能把大位移压缩在一秒左右。
    expect(bridgeSeconds).toBeGreaterThanOrEqual(1.25);
    expect(bridgeSeconds).toBeLessThanOrEqual(1.5);
    nowMs += bridgeSeconds * 1_000 + 1;
    player.applyFadeBlend();
    expect(player.getState()).toBe('playing');
    expect(player.getCurrentAnimationTime()).toBeCloseTo(0, 6);
  });

  it('starts the complete selected speech action at frame zero after the short bridge', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const upperBody = new THREE.Bone();
    upperBody.name = 'UpperBody';
    upperBody.userData.mmdBoneName = 'UpperBody';
    const rightArm = new THREE.Bone();
    rightArm.name = 'RightArm';
    rightArm.userData.mmdBoneName = 'RightArm';
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [upperBody, rightArm] }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation: vi.fn()
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('idle', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    await player.play('speech-cue:daily', buildTestVmd('RightArm', 90), {
      fadeInSeconds: 0.72,
      fadeOutSeconds: 0.72,
      transitionProfile: 'speech-entry'
    });

    const bridgeSeconds = (player as any).animationDurationSec as number;
    // 2026-08 二次放宽：speech-entry 桥下限 1.4s（用户反馈进入仍偏快）。
    expect(bridgeSeconds).toBeGreaterThanOrEqual(1.4 - 1 / 30);
    expect(bridgeSeconds).toBeLessThanOrEqual(1.75 + 1 / 30);
    nowMs += bridgeSeconds * 1_000 + 1;
    player.applyFadeBlend();
    expect(player.getState()).toBe('playing');
    expect(player.getCurrentAnimationTime()).toBeCloseTo(0, 6);
    nowMs += 100;
    expect(player.getCurrentAnimationTime()).toBeGreaterThan(0);
  });

  it('starts the native bridge from the currently rendered pose instead of the stale request-time VMD frame', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const upperBody = new THREE.Bone();
    upperBody.name = 'UpperBody';
    upperBody.userData.mmdBoneName = 'UpperBody';
    const rightArm = new THREE.Bone();
    rightArm.name = 'RightArm';
    rightArm.userData.mmdBoneName = 'RightArm';
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [upperBody, rightArm] }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('idle-a', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    upperBody.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(48));

    await player.play('gesture-b', buildTestVmd('RightArm'), {
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.2
    });
    nowMs = 1_200;
    player.applyFadeBlend();
    await vi.waitFor(() => expect(setAnimation).toHaveBeenCalledTimes(2));

    const bridgeTrack = setAnimation.mock.calls[1][0].boneTracks.UpperBody;
    const first = new THREE.Quaternion(
      bridgeTrack.rotations[0],
      bridgeTrack.rotations[1],
      bridgeTrack.rotations[2],
      bridgeTrack.rotations[3]
    );
    expect(THREE.MathUtils.radToDeg(first.angleTo(new THREE.Quaternion()))).toBeCloseTo(48, 3);
  });

  it('samples an ordinary bridge target from the incoming clip frame zero', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const bones = ['UpperBody', 'RightArm'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.userData.mmdBoneName = name;
      return bone;
    });
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          clearAnimation: vi.fn()
        },
        setAnimation: vi.fn()
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('idle-a', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    await player.play('idle-b', buildTestVmd('RightArm', 120), {
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.2
    });

    expect((player as any).nativeBridgeTarget.startOffsetSeconds).toBe(0);
  });

  it('rewinds the loader runtime before synchronously binding a generated bridge', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const bones = ['UpperBody', 'RightArm'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.userData.mmdBoneName = name;
      return bone;
    });
    const resetPose = vi.fn();
    const seek = vi.fn();
    const setAnimation = vi.fn();
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          resetPose,
          seek,
          clearAnimation: vi.fn()
        },
        setAnimation
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    await player.play('idle-a', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    await player.play('gesture-b', buildTestVmd('RightArm'), { fadeInSeconds: 0.2, fadeOutSeconds: 0.2 });
    nowMs = 1_200;
    player.applyFadeBlend();
    await vi.waitFor(() => expect(setAnimation).toHaveBeenCalledTimes(2));

    expect(resetPose).toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(0);
    const resetBeforeBridge = resetPose.mock.invocationCallOrder.find(order => order < setAnimation.mock.invocationCallOrder[1]);
    const seekBeforeBridge = seek.mock.invocationCallOrder.find(order => order < setAnimation.mock.invocationCallOrder[1]);
    expect(resetBeforeBridge).toBeDefined();
    expect(seekBeforeBridge).toBeDefined();
    expect(resetBeforeBridge!).toBeLessThan(seekBeforeBridge!);
  });

  it('preserves the rendered skeleton and Bullet-owned dynamic bones while binding a transition bridge', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const upperBody = new THREE.Bone();
    upperBody.name = 'UpperBody';
    upperBody.userData.mmdBoneName = 'UpperBody';
    const rightArm = new THREE.Bone();
    rightArm.name = 'RightArm';
    rightArm.userData.mmdBoneName = 'RightArm';
    const ribbon = new THREE.Bone();
    ribbon.name = 'RibbonDynamic';
    ribbon.userData.mmdBoneName = 'RibbonDynamic';
    const bones = [upperBody, rightArm, ribbon];
    const resetAllBones = () => {
      for (const bone of bones) {
        bone.position.set(0, 0, 0);
        bone.quaternion.identity();
      }
    };
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones }, morphTargetDictionary: {} },
        runtime: {
          frameState: () => ({ seconds: nowMs / 1000, frame: nowMs / 1000 * 30, frameRate: 30 }),
          resetPose: vi.fn(resetAllBones),
          seek: vi.fn(),
          clearAnimation: vi.fn()
        },
        setAnimation: vi.fn(resetAllBones)
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    player.setDynamicBoneFilter(new Set(['RibbonDynamic']));

    await player.play('idle-a', buildTestVmd('UpperBody'), { fadeInSeconds: 0.2 });
    nowMs = 800;
    player.applyFadeBlend();
    upperBody.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(22));
    ribbon.position.set(0.1, 0.2, -0.05);
    ribbon.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(35));
    const expectedUpperBodyRotation = upperBody.quaternion.clone();
    const expectedPosition = ribbon.position.clone();
    const expectedRotation = ribbon.quaternion.clone();

    await player.play('gesture-b', buildTestVmd('RightArm'), {
      fadeInSeconds: 0.8,
      fadeOutSeconds: 0.8
    });

    expect(upperBody.quaternion.angleTo(expectedUpperBodyRotation)).toBeLessThan(1e-8);
    expect(ribbon.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
    expect(ribbon.quaternion.angleTo(expectedRotation)).toBeLessThan(1e-8);
  });

  it('keeps sampling the outgoing VMD clock while an asynchronous replacement is loading', () => {
    vi.spyOn(performance, 'now').mockReturnValue(12_500);
    const player = new MotionPlayer(
      { mesh: { skeleton: { bones: [] } } } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );

    // This is the state immediately after the old VMD has been retained for a
    // cross-fade, but before the next VMD has finished loading.
    (player as any).retainedAnimationClock = {
      durationSeconds: 2,
      startedAt: 10,
      looping: true
    };

    expect(player.isPlaying()).toBe(true);
    // Animation sampling loops independently. ContinuousMmdPhysicsBackend
    // replaces the loop-local time with its own monotonic Bullet clock.
    expect(player.getCurrentAnimationTime()).toBeCloseTo(0.5, 6);
  });

  it('freezes the sampled pose while locked and resumes without a clock jump', () => {
    let nowMs = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const player = new MotionPlayer(
      { mesh: { skeleton: { bones: [] } } } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    (player as any).state = 'playing';
    (player as any).animationDurationSec = 20;
    (player as any).animationStartedAt = 0;

    expect(player.getCurrentAnimationTime()).toBeCloseTo(1, 6);
    player.setPoseLocked(true);
    nowMs = 6_000;
    expect(player.getCurrentAnimationTime()).toBeCloseTo(1, 6);

    player.setPoseLocked(false);
    expect(player.getCurrentAnimationTime()).toBeCloseTo(1, 6);
    nowMs = 7_000;
    expect(player.getCurrentAnimationTime()).toBeCloseTo(2, 6);
  });

  it('notifies one-shot completion before fading or clearing the visible pose', () => {
    let nowMs = 1_100;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const player = new MotionPlayer(
      { mesh: { skeleton: { bones: [] } } } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry()
    );
    (player as any).state = 'playing';
    (player as any).looping = false;
    (player as any).animationDurationSec = 1;
    (player as any).animationStartedAt = 0;
    const onNaturalEnd = vi.fn();
    player.setOnNaturalEnd(onNaturalEnd);

    player.applyFadeBlend();
    player.applyFadeBlend();

    expect(onNaturalEnd).toHaveBeenCalledTimes(1);
    expect(player.getState()).toBe('playing');
  });

  it('hands an ended performance-clock fade to local time without a clock jump', () => {
    let localNowMs = 2_000;
    vi.spyOn(performance, 'now').mockImplementation(() => localNowMs);
    let audioNow = 4;
    const clock = { now: () => audioNow, getAudioStartTime: () => 0 };
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [] }, morphTargetDictionary: {} },
        runtime: { clearAnimation: vi.fn() }
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry(),
      { performanceClock: clock as any }
    );

    (player as any).state = 'fading-out';
    (player as any).currentTimeSource = 'performance-clock';
    (player as any).animationDurationSec = 20;
    (player as any).animationStartedAt = 1;
    (player as any).fadeStartedAt = 3;

    player.handoffToLocalClock();
    expect(player.getCurrentTimeSource()).toBe('local-clock');
    expect((player as any).animationStartedAt).toBeCloseTo(-1, 6);
    expect((player as any).fadeStartedAt).toBeCloseTo(1, 6);

    localNowMs = 2_500;
    expect(player.getCurrentAnimationTime()).toBeCloseTo(3.5, 6);
  });

  it('settles an unfinished speech bridge when audio ends', () => {
    let localNowMs = 2_000;
    vi.spyOn(performance, 'now').mockImplementation(() => localNowMs);
    let speechNow = 0.4;
    const clock = { now: () => speechNow, getAudioStartTime: () => 240 };
    const player = new MotionPlayer(
      { mesh: { skeleton: { bones: [] } }, runtime: { clearAnimation: vi.fn() } } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry(),
      { performanceClock: clock as any }
    );
    (player as any).state = 'bridging';
    (player as any).currentTimeSource = 'performance-clock';
    (player as any).nativeBridgeTarget = { timeSource: 'performance-clock' };
    (player as any).animationStartedAt = 0;
    (player as any).fadeStartedAt = 0;

    player.handoffToLocalClock();
    expect(player.getState()).toBe('playing');
    expect(player.getCurrentTimeSource()).toBe('local-clock');
    expect((player as any).nativeBridgeTarget).toBeNull();
  });

  it('starts speech animation on the target performance clock instead of the previous local clock', async () => {
    let localNowMs = 240_000;
    vi.spyOn(performance, 'now').mockImplementation(() => localNowMs);
    let speechNow = 0;
    const upperBody = new THREE.Bone();
    upperBody.name = 'UpperBody';
    upperBody.userData.mmdBoneName = 'UpperBody';
    const clock = {
      now: () => speechNow,
      getAudioStartTime: () => 240
    };
    const player = new MotionPlayer(
      {
        mesh: { skeleton: { bones: [upperBody] }, morphTargetDictionary: {} },
        runtime: { clearAnimation: vi.fn() },
        setAnimation: vi.fn()
      } as any,
      new BoneOwnershipRegistry(),
      new MorphOwnershipRegistry(),
      {
        performanceClock: clock as any,
        getAudioContextState: () => 'running'
      }
    );

    await player.play('speech-cue:shared', buildTestVmd('UpperBody', 120), {
      looping: false,
      timeSource: 'performance-clock',
      fadeInSeconds: 0.2
    });

    expect(player.getCurrentTimeSource()).toBe('performance-clock');
    expect(player.getCurrentAnimationTime()).toBeCloseTo(0, 6);
    speechNow = 0.6;
    expect(player.getCurrentAnimationTime()).toBeCloseTo(0.6, 6);

    // The model root is outside the PMX skeleton and remains independently
    // draggable while speech VMD bones use the audio-aligned clock.
    const rootPosition = { x: 0, y: 0, z: 0 };
    const drag = new (await import('../../src/desktop-avatar/model-root-drag-controller')).ModelRootDragController(rootPosition);
    drag.setTarget(2, -1, 0);
    drag.advance(rootPosition, 1 / 60);
    expect(rootPosition.x).toBeGreaterThan(0);
    expect(rootPosition.y).toBeLessThan(0);
    void localNowMs;
  });
});
