import { describe, expect, it } from 'vitest';
import type { VmdLocalPose } from '../../src/motion/motion-transition-bridge';
import {
  requiresParsedTrackExecution,
  resolveEffectiveCandidateTrackPolicy,
  isGroundedDialogueBoneAllowed,
  injectRelaxedArmFallbackTracks,
  injectSpeechLowerBodyHoldTracks,
  isSpeechRecoveryHoldTrack,
  rebaseTrustedVoiceControllerTranslations,
  createSpeechEntryArmWaypointSequences,
  createSpeechToIdleArmWaypointSequences,
  selectSpeechEntryStartFrame,
  repairSpeechEntryNeutralArmLeadIn
  , isBridgeCalibrationBone,
  resolveTransitionSourcePose,
  shouldPreserveSpeechRecoveryTargetBody,
  resolveSpeechRecoveryLegTargetPose
  , filterUnsafeOneShotLowerBodyTracks
  , shouldApplyOneShotLowerBodyGate
} from '../../src/motion/motion-player';

function rotationTrack(frames: number[], angles: number[]) {
  const rotations = new Float32Array(frames.length * 4);
  angles.forEach((angle, index) => {
    rotations[index * 4 + 2] = Math.sin(angle / 2);
    rotations[index * 4 + 3] = Math.cos(angle / 2);
  });
  return {
    packed: 'bone' as const,
    frames: new Uint32Array(frames),
    translations: new Float32Array(frames.length * 3),
    rotations,
    interpolations: new Float32Array(frames.length * 16),
    physicsToggles: new Int8Array(frames.length).fill(-1)
  };
}

describe('MotionPlayer candidate track execution policy', () => {
  it('keeps the selected idle lower-body target during local speech recovery', () => {
    expect(shouldPreserveSpeechRecoveryTargetBody(
      'local-clock',
      'speech-to-idle-recovery',
      'dialogue-body-only'
    )).toBe(true);
    expect(shouldPreserveSpeechRecoveryTargetBody(
      'performance-clock',
      'speech-to-idle-recovery',
      'dialogue-body-only'
    )).toBe(false);
  });

  it('uses the outgoing authored leg input but keeps visible controller poses at bridge entry', () => {
    const rightKnee = rotationTrack([0, 30], [0.12, 0.5]);
    const visible: VmdLocalPose = {
      translation: [0, 0, 0],
      rotation: [0.34, 0, 0, 0.9404]
    };

    const leg = resolveTransitionSourcePose('右ひざ', visible, rightKnee, 0);
    const ik = resolveTransitionSourcePose('右足ＩＫ', visible, rightKnee, 0);

    expect(leg.rotation[2]).toBeCloseTo(Math.sin(0.12 / 2), 5);
    expect(ik).toBe(visible);
  });

  it('uses the currently visible leg pose when recovering speech to the selected idle', () => {
    const outgoing = rotationTrack([0, 30], [0.12, 0.5]);
    const visible: VmdLocalPose = {
      translation: [0, 0, 0],
      rotation: [0, 0.62, 0, 0.784]
    };

    const recovered = resolveTransitionSourcePose('右足', visible, outgoing, 0, true);

    expect(recovered).toBe(visible);
  });

  it('returns the voice VMD start pose as the recovery endpoint for authored legs', () => {
    const outgoing = rotationTrack([0, 30], [0.42, 0.9]);
    const defaultPose: VmdLocalPose = {
      translation: [0, 0, 0],
      rotation: [0, -0.35, 0, 0.94]
    };

    const endpoint = resolveSpeechRecoveryLegTargetPose('右足', defaultPose, outgoing);

    expect(endpoint).toBeDefined();
    expect(endpoint!.rotation[2]).toBeCloseTo(Math.sin(0.42 / 2), 5);
    expect(resolveSpeechRecoveryLegTargetPose('右足D', defaultPose, outgoing)).toBeUndefined();
  });

  it('keeps authored lower-body rotations on one-shot tracks; only pins their translation to avoid foot skating', () => {
    const safeLeg = rotationTrack([0, 30], [0, 0.12]);
    const largeSwingLeg = rotationTrack([0, 30], [0, 0.8]);
    const legWithTranslation = rotationTrack([0, 30], [0, 0.3]);
    legWithTranslation.translations.set([0.1, 0.2, 0.3, 0.4, 0.1, -0.2]);
    const loaded: any = {
      bytes: new Uint8Array([1]),
      animation: { kind: 'vmd', bytes: new Uint8Array([1]), metadata: { maxFrame: 30, counts: { bones: 3, morphs: 0 } }, boneTracks: {}, morphTracks: {} },
      boneTracks: {
        '左足': safeLeg,
        '右ひざ': largeSwingLeg, // 大摆动腿骨：保留旋转，不再整体删除
        '右足首': legWithTranslation,
        '全ての親': rotationTrack([0, 30], [0, 0.1]), // root 仍 fail-closed
        '左足ＩＫ': rotationTrack([0, 30], [0, 0.1]), // foot IK 仍 fail-closed
        '左腕': rotationTrack([0, 30], [0, 0.3])
      },
      morphTracks: {}
    };
    const result = filterUnsafeOneShotLowerBodyTracks(loaded);
    // 真实腿骨保留旋转
    expect(result.boneTracks['左足']).toBeDefined();
    expect(result.boneTracks['右ひざ']).toBeDefined();
    expect(result.boneTracks['右ひざ'].rotations[6]).toBeCloseTo(Math.sin(0.8 / 2), 5);
    // 腿部位移被 pin 为 0（防脚滑兜底）
    expect(Math.max(...[...result.boneTracks['右足首'].translations].map(Math.abs))).toBeCloseTo(0, 5);
    // root / foot IK 仍 fail-closed
    expect(result.boneTracks['全ての親']).toBeUndefined();
    expect(result.boneTracks['左足ＩＫ']).toBeUndefined();
    expect(result.boneTracks['左腕']).toBeDefined();
  });

  it('applies the one-shot lower-body gate only to speech-synced dialogue clips', () => {
    // 语音同步（performance-clock + dialogue-body-only）：保持落地过滤
    expect(shouldApplyOneShotLowerBodyGate(false, 'performance-clock', 'dialogue-body-only')).toBe(true);
    // 循环语音不受一次性门影响
    expect(shouldApplyOneShotLowerBodyGate(true, 'performance-clock', 'dialogue-body-only')).toBe(false);
    // trusted-voice-full-body 已由 rebase 锚定位移，保留 authored 轨道
    expect(shouldApplyOneShotLowerBodyGate(false, 'performance-clock', 'trusted-voice-full-body')).toBe(false);
    // local-clock：待机 / 待机轮换动作 / 手动动作 / 长 VMD 舞蹈完全不过滤
    expect(shouldApplyOneShotLowerBodyGate(false, 'local-clock', undefined)).toBe(false);
    expect(shouldApplyOneShotLowerBodyGate(true, 'local-clock', undefined)).toBe(false);
    expect(shouldApplyOneShotLowerBodyGate(false, 'local-clock', 'grounded-full-body')).toBe(false);
  });

  it('retains bridge-end poses over single-key leg calibration tracks', () => {
    expect(isBridgeCalibrationBone('右足先EX', { frames: new Uint32Array([0]) })).toBe(true);
    expect(isBridgeCalibrationBone('右足ＩＫ', { frames: new Uint32Array([0]) })).toBe(true);
    expect(isBridgeCalibrationBone('右足先EX', { frames: new Uint32Array([0, 30]) })).toBe(false);
    expect(isBridgeCalibrationBone('右足', { frames: new Uint32Array([0]) })).toBe(false);
  });

  it('holds the visible lower-body chain when speech recovery filters the idle body', () => {
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 1, morphs: 0 } },
        boneTracks: { '上半身': rotationTrack([0, 30], [0, 0]) },
        morphTracks: {}
      } as any,
      boneTracks: { '上半身': rotationTrack([0, 30], [0, 0]) },
      morphTracks: {}
    };
    const result = injectSpeechLowerBodyHoldTracks(
      loaded,
      new Set(['上半身', '下半身', '左足', '右足', '左足ＩＫ', '右足ＩＫ']),
      boneName => ({
        translation: boneName.endsWith('ＩＫ') ? [0.02, 0, -0.01] : [0, 0, 0],
        rotation: [0, 0, 0.1, 0.995]
      })
    );

    expect(result.boneTracks['上半身']).toBe(loaded.boneTracks['上半身']);
    expect(result.boneTracks['下半身'].frames).toEqual(new Uint32Array([0, 30]));
    expect([...result.boneTracks['左足ＩＫ'].translations]).toHaveLength(6);
    expect(result.boneTracks['左足ＩＫ'].translations[0]).toBeCloseTo(0.02, 5);
    expect(result.boneTracks['左足ＩＫ'].translations[2]).toBeCloseTo(-0.01, 5);
    expect(result.animation.bytes).toHaveLength(0);
    expect(result.animation.metadata.counts.bones).toBe(11);
  });

  it('marks generated grounded holds so authored idle leg tracks remain the recovery target', () => {
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 1, morphs: 0 } },
        boneTracks: {},
        morphTracks: {}
      } as any,
      boneTracks: {},
      morphTracks: {}
    };
    const result = injectSpeechLowerBodyHoldTracks(
      loaded,
      new Set(['左足']),
      () => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] })
    );
    expect(isSpeechRecoveryHoldTrack(result.boneTracks['左足'])).toBe(true);
  });
  it('forces parsed-track execution when a candidate safety filter is active', () => {
    expect(requiresParsedTrackExecution('standard-upper-body')).toBe(true);
    expect(requiresParsedTrackExecution('dialogue-body-only')).toBe(true);
    expect(requiresParsedTrackExecution('trusted-voice-full-body')).toBe(true);
    expect(requiresParsedTrackExecution(undefined)).toBe(false);
  });

  it('grounds ordinary performance-clock VMDs but preserves the internal trusted voice policy', () => {
    expect(resolveEffectiveCandidateTrackPolicy('performance-clock', undefined))
      .toBe('dialogue-body-only');
    expect(resolveEffectiveCandidateTrackPolicy('performance-clock', 'standard-upper-body'))
      .toBe('dialogue-body-only');
    expect(resolveEffectiveCandidateTrackPolicy('performance-clock', 'trusted-voice-full-body'))
      .toBe('trusted-voice-full-body');
    expect(resolveEffectiveCandidateTrackPolicy('local-clock', undefined)).toBeUndefined();
    expect(resolveEffectiveCandidateTrackPolicy('local-clock', 'standard-upper-body'))
      .toBe('standard-upper-body');
  });

  it('keeps root, center, waist, lower body, foot IK out of dialogue motion but admits authored leg rotations', () => {
    const forbiddenAnchor = [
      '全ての親', 'センター', 'グルーブ', '腰', '下半身',
      '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ',
      '左足D', '右足D', '右足先EX'
    ];
    // 真实腿骨（足/ひざ/膝/足首）允许保留作者书写的旋转，让语行动作能驱动腿部。
    const allowedLegs = ['左足', '右足', '左ひざ', '右ひざ', '左膝', '右膝', '左足首', '右足首'];
    for (const boneName of forbiddenAnchor) expect(isGroundedDialogueBoneAllowed(boneName)).toBe(false);
    for (const boneName of allowedLegs) expect(isGroundedDialogueBoneAllowed(boneName)).toBe(true);
    for (const boneName of ['上半身', '上半身2', '首', '頭', '左肩', '右腕', '左ひじ', '右手首']) {
      expect(isGroundedDialogueBoneAllowed(boneName)).toBe(true);
    }
  });

  it('fills only missing arm tracks with the relaxed pose before runtime binding', () => {
    const authoredLeftArm = {
      packed: 'bone' as const,
      frames: new Uint32Array([0]),
      translations: new Float32Array(3),
      rotations: new Float32Array([0, 0, 0, 1]),
      interpolations: new Float32Array(16),
      physicsToggles: new Int8Array([-1])
    };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 1, morphs: 0 } },
        boneTracks: { '左腕': authoredLeftArm },
        morphTracks: {}
      } as any,
      boneTracks: { '左腕': authoredLeftArm },
      morphTracks: {}
    };

    const result = injectRelaxedArmFallbackTracks(
      loaded,
      new Set(['左腕', '右腕', '左ひじ']),
      () => ({ translation: [0, 0, 0], rotation: [0, 0, 0.25, 0.9682458] })
    );

    expect(result.boneTracks['左腕']).toBe(authoredLeftArm);
    expect(result.boneTracks['右腕'].frames).toEqual(new Uint32Array([0, 30]));
    expect(result.boneTracks['左ひじ'].rotations[2]).toBeCloseTo(0.25, 6);
    expect(result.animation.bytes).toHaveLength(0);
    expect(result.animation.metadata.counts.bones).toBe(5);
  });

  it('pins source-model foot IK translation while retaining rotations', () => {
    const ikTrack = {
      packed: 'bone' as const,
      frames: new Uint32Array([0, 30]),
      translations: new Float32Array([1.15, -0.04, -0.84, 0.8, 0, -0.4]),
      rotations: new Float32Array([0, 0.17, 0.05, 0.98, 0, 0.1, 0, 0.995]),
      interpolations: new Float32Array(32),
      physicsToggles: new Int8Array([-1, -1])
    };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 1, morphs: 0 } },
        boneTracks: { '左足ＩＫ': ikTrack },
        morphTracks: {}
      } as any,
      boneTracks: { '左足ＩＫ': ikTrack },
      morphTracks: {}
    };

    const result = rebaseTrustedVoiceControllerTranslations(loaded, () => ({
      translation: [0.18, 0, -0.17],
      rotation: [0, 0, 0, 1]
    }));
    expect([...result.boneTracks['左足ＩＫ'].translations]).toEqual([
      expect.closeTo(0.18, 5), 0, expect.closeTo(-0.17, 5),
      expect.closeTo(0.18, 5), 0, expect.closeTo(-0.17, 5)
    ]);
    expect(result.boneTracks['左足ＩＫ'].rotations[0]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足ＩＫ'].rotations[1]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足ＩＫ'].rotations[2]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足ＩＫ'].rotations[3]).toBeCloseTo(1, 5);
    expect(Math.abs(result.boneTracks['左足ＩＫ'].rotations[4])).toBeLessThan(0.01);
    expect(result.boneTracks['左足ＩＫ'].rotations[5]).toBeCloseTo(-0.07, 2);
    expect(result.boneTracks['左足ＩＫ'].rotations[6]).toBeCloseTo(-0.05, 2);
    expect(result.boneTracks['左足ＩＫ'].rotations[7]).toBeCloseTo(0.997, 2);
    expect(result.boneTracks['左足ＩＫ'].frames).toBe(ikTrack.frames);
    expect(result.animation.bytes).toHaveLength(0);
  });

  it('pins trusted lower-body controller translations while retaining authored rotation changes', () => {
    const ikTrack = {
      packed: 'bone' as const,
      frames: new Uint32Array([0, 30]),
      translations: new Float32Array([0.1, 0.2, 0.3, 0.6, 0.5, 0.4]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0.2, 0, 0.98]),
      interpolations: new Float32Array(32),
      physicsToggles: new Int8Array([-1, -1])
    };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 1, morphs: 0 } },
        boneTracks: { '左足ＩＫ': ikTrack },
        morphTracks: {}
      } as any,
      boneTracks: { '左足ＩＫ': ikTrack },
      morphTracks: {}
    };

    const result = rebaseTrustedVoiceControllerTranslations(loaded, () => ({
      translation: [0.18, 0, -0.17],
      rotation: [0, 0, 0, 1]
    }));
    expect(result.boneTracks['左足ＩＫ'].translations[0]).toBeCloseTo(0.18, 5);
    expect(result.boneTracks['左足ＩＫ'].translations[2]).toBeCloseTo(-0.17, 5);
    expect(result.boneTracks['左足ＩＫ'].translations[3]).toBeCloseTo(0.18, 5);
    expect(result.boneTracks['左足ＩＫ'].translations[5]).toBeCloseTo(-0.17, 5);
    expect(result.boneTracks['左足ＩＫ'].rotations[4]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足ＩＫ'].rotations[5]).toBeCloseTo(0.2, 3);
    expect(result.boneTracks['左足ＩＫ'].rotations[7]).toBeCloseTo(0.98, 3);
  });

  it('anchors a single-key authored leg pose to the visible stance so cue handoffs do not kick the skirt', () => {
    // 手势 VMD 里单 key 的腿部轨道是 authored 静态腿姿。过渡桥的终点刻意
    // 保持当前可见腿姿（见 createTargetTransitionPoses），但旧实现绑定后
    // 单 key 轨道立即采样 authored 值——桥尾到绑定第一帧之间发生一帧跳变，
    // 不同手势的静态腿姿互不相同，表现为语音 cue 间腿部来回变化、裙摆被
    // 突变掀起。锚定后桥终点与绑定姿态一致，腿部在手势间保持稳定。
    const staticLeg = rotationTrack([0], [0.55]);
    const boneTracks = { '右足': staticLeg };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 45, counts: { bones: 1, morphs: 0 } },
        boneTracks,
        morphTracks: {}
      } as any,
      boneTracks,
      morphTracks: {}
    };

    const result = rebaseTrustedVoiceControllerTranslations(loaded, () => ({
      translation: [0, 0, 0],
      rotation: [0, 0.08, 0, 0.9968]
    }));

    expect([...result.boneTracks['右足'].rotations]).toEqual([
      0, expect.closeTo(0.08, 5), 0, expect.closeTo(0.9968, 5)
    ]);
  });

  it('anchors a single source-model foot IK calibration key without removing authored leg motion', () => {
    const staticIk = {
      packed: 'bone' as const,
      frames: new Uint32Array([0]),
      translations: new Float32Array([0, 0, 0]),
      rotations: new Float32Array([-0.37, 0, 0, 0.929]),
      interpolations: new Float32Array(16),
      physicsToggles: new Int8Array([-1])
    };
    const rightLeg = rotationTrack([0], [0.26]);
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 135, counts: { bones: 2, morphs: 0 } },
        boneTracks: { '右足ＩＫ': staticIk, '右足': rightLeg },
        morphTracks: {}
      } as any,
      boneTracks: { '右足ＩＫ': staticIk, '右足': rightLeg },
      morphTracks: {}
    };

    const result = rebaseTrustedVoiceControllerTranslations(loaded, () => ({
      translation: [0.1, 0, -0.05],
      rotation: [0, 0.08, 0, 0.9968]
    }));

    expect([...result.boneTracks['右足ＩＫ'].rotations]).toEqual([
      0, expect.closeTo(0.08, 5), 0, expect.closeTo(0.9968, 5)
    ]);
    // 单 key 腿骨与单 key 足 IK 一样是 authored 静态腿姿（源模型校准），
    // 统一锚定到可见姿态，避免 cue 间腿部跳变。
    expect([...result.boneTracks['右足'].rotations]).toEqual([
      0, expect.closeTo(0.08, 5), 0, expect.closeTo(0.9968, 5)
    ]);
  });

  it('removes single-key semi-standard leg helpers but preserves authored helper and leg motion', () => {
    const staticFootD = rotationTrack([0], [0.42]);
    staticFootD.translations.set([0.4, 0.65, 1.05]);
    const staticToeEx = rotationTrack([0], [0.67]);
    const authoredToeEx = rotationTrack([0, 15], [0.2, 0.55]);
    authoredToeEx.translations.set([0.4, 0.65, 1.05, 0.05, 0.65, 1.05]);
    const authoredLeg = rotationTrack([0], [0.26]);
    const boneTracks = {
      '右足D': staticFootD,
      '右足先EX': staticToeEx,
      '左足先EX': authoredToeEx,
      '右足': authoredLeg
    };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 15, counts: { bones: 5, morphs: 0 } },
        boneTracks,
        morphTracks: {}
      } as any,
      boneTracks,
      morphTracks: {}
    };
    const currentPoses: Record<string, VmdLocalPose> = {
      '右足D': { translation: [0.03, -0.02, 0.01], rotation: [0, 0.08, 0, 0.9968] },
      '右足先EX': { translation: [-0.01, 0.02, 0.04], rotation: [0.04, 0, 0, 0.9992] }
    };

    const result = rebaseTrustedVoiceControllerTranslations(
      loaded,
      boneName => currentPoses[boneName] ?? { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }
    );

    expect(result.boneTracks['右足D']).toBeUndefined();
    expect(result.boneTracks['右足先EX']).toBeUndefined();
    expect(result.boneTracks['左足先EX']).not.toBe(authoredToeEx);
    expect(result.boneTracks['左足先EX'].translations[0]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足先EX'].translations[1]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足先EX'].translations[2]).toBeCloseTo(0, 5);
    expect(result.boneTracks['左足先EX'].rotations[0]).toBeCloseTo(0, 2);
    expect(result.boneTracks['左足先EX'].rotations[1]).toBeCloseTo(0, 2);
    // 右足是单 key authored 静态腿姿：锚定到可见姿态（此处 fallback 为
    // identity），不再保留源模型的静态腿姿。
    expect(result.boneTracks['右足']).not.toBe(authoredLeg);
    expect(result.boneTracks['右足'].rotations[3]).toBeCloseTo(1, 5);
    expect(result.animation.bytes).toHaveLength(0);
  });

  it('pins a source-model center lunge without changing authored joint rotations', () => {
    const centerTrack = {
      packed: 'bone' as const,
      frames: new Uint32Array([0, 15, 30]),
      translations: new Float32Array([
        0, 0, 0,
        0.2, -0.1, 0.12,
        1.6, 0.7, -0.9
      ]),
      rotations: new Float32Array([
        0, 0, 0, 1,
        0, 0.1, 0, 0.995,
        0, 0.2, 0, 0.98
      ]),
      interpolations: new Float32Array(48),
      physicsToggles: new Int8Array([-1, -1, -1])
    };
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 30, counts: { bones: 3, morphs: 0 } },
        boneTracks: { 'センター': centerTrack },
        morphTracks: {}
      } as any,
      boneTracks: { 'センター': centerTrack },
      morphTracks: {}
    };

    const result = rebaseTrustedVoiceControllerTranslations(loaded, () => ({
      translation: [0.05, 0.02, -0.03],
      rotation: [0, 0, 0, 1]
    }));
    const values = [...result.boneTracks['センター'].translations];

    expect(values.slice(0, 6)).toEqual([
      expect.closeTo(0.05, 5), expect.closeTo(0.02, 5), expect.closeTo(-0.03, 5),
      expect.closeTo(0.05, 5), expect.closeTo(0.02, 5), expect.closeTo(-0.03, 5)
    ]);
    expect(values.slice(6)).toEqual([
      expect.closeTo(0.05, 5), expect.closeTo(0.02, 5), expect.closeTo(-0.03, 5)
    ]);
    expect(result.boneTracks['センター'].rotations).not.toBe(centerTrack.rotations);
    expect(result.boneTracks['センター'].rotations[0]).toBeCloseTo(0, 5);
    expect(result.boneTracks['センター'].rotations[1]).toBeCloseTo(0, 5);
    expect(result.boneTracks['センター'].rotations[2]).toBeCloseTo(0, 5);
    expect(result.boneTracks['センター'].rotations[3]).toBeCloseTo(1, 5);
  });

  it('routes a displaced arm chain through the relaxed side pose for speech entry', () => {
    const behind = { translation: [0, 0, 0] as const, rotation: [0, 0.75, 0, 0.6614378] as const };
    const nearSide = { translation: [0, 0, 0] as const, rotation: [0, 0, 0.05, 0.9987492] as const };
    const side = { translation: [0, 0, 0] as const, rotation: [0, 0, -0.35, 0.9367497] as const };
    const speech = { translation: [0, 0, 0] as const, rotation: [0.25, 0, -0.15, 0.9565563] as const };
    const rearTwist = { translation: [0, 0, 0] as const, rotation: [0.7, 0.2, 0, 0.6855655] as const };
    const source = new Map<string, VmdLocalPose>([
      ['左肩', behind],
      ['左腕', behind],
      ['左腕捩', rearTwist],
      ['左ひじ', nearSide],
      ['右腕', nearSide]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['左肩', speech], ['左腕', speech], ['左腕捩', speech], ['左ひじ', speech], ['右腕', nearSide]
    ]);

    const waypoints = createSpeechEntryArmWaypointSequences(source, target, boneName =>
      boneName.startsWith('左') ? side : nearSide);

    const shoulderRoute = waypoints.get('左肩');
    const armRoute = waypoints.get('左腕');
    const twistRoute = waypoints.get('左腕捩');
    const elbowRoute = waypoints.get('左ひじ');
    expect(shoulderRoute?.[0]).toEqual(side);
    expect(shoulderRoute).toHaveLength(2);
    expect(armRoute?.[0]).toEqual(side);
    expect(armRoute).toHaveLength(2);
    expect(armRoute?.[1]).not.toEqual(side);
    expect(armRoute?.[1]).not.toEqual(speech);
    expect(twistRoute).toHaveLength(3);
    expect(twistRoute?.[0]).toEqual(rearTwist);
    expect(twistRoute?.[1]).not.toEqual(rearTwist);
    expect(twistRoute?.[1]).not.toEqual(side);
    expect(twistRoute?.[2]).toEqual(side);
    expect(elbowRoute).toHaveLength(3);
    expect(elbowRoute?.[0]).toEqual(nearSide);
    expect(elbowRoute?.[1]).not.toEqual(nearSide);
    expect(elbowRoute?.[1]).not.toEqual(side);
    expect(elbowRoute?.[2]).toEqual(side);
    expect(waypoints.has('右腕')).toBe(false);
  });

  it('routes front-held arms through the body sides before a rear-held idle', () => {
    const front = { translation: [0, 0, 0] as const, rotation: [0.6, 0.1, 0, 0.7937254] as const };
    const side = { translation: [0, 0, 0] as const, rotation: [0, 0, -0.35, 0.9367497] as const };
    const behind = { translation: [0, 0, 0] as const, rotation: [0, 0.75, 0, 0.6614378] as const };
    const source = new Map<string, VmdLocalPose>([
      ['左腕', front], ['左腕捩', front], ['左ひじ', front], ['左手首', front]
    ]);
    const target = new Map<string, VmdLocalPose>([
      ['左腕', behind], ['左腕捩', behind], ['左ひじ', behind], ['左手首', behind]
    ]);

    const waypoints = createSpeechToIdleArmWaypointSequences(source, target, () => side);

    const armRoute = waypoints.get('左腕');
    expect(armRoute?.[0]).toEqual(side);
    expect(armRoute).toHaveLength(3);
    expect(armRoute?.[1]).not.toEqual(side);
    expect(armRoute?.[1]).not.toEqual(behind);
    expect(armRoute?.[2]).toEqual(behind);
    expect(waypoints.get('左腕捩')).toEqual([side, side, side]);
    expect(waypoints.get('左ひじ')).toEqual([side, side, side]);
    expect(waypoints.get('左手首')).toEqual([side, side, side]);
  });

  it('skips a neutral export lead-in before bridging to a speech action', () => {
    const boneTracks = Object.fromEntries([
      ['左腕', [0.36, 0.58]], ['右腕', [0.36, 0.55]],
      ['左腕捩', [0.002, 1.1]], ['右腕捩', [0.002, 1.2]],
      ['左ひじ', [0.17, 0.9]], ['右ひじ', [0.17, 0.95]],
      ['左手捩', [0.002, 0.9]], ['右手捩', [0.002, 0.8]],
      ['左手首', [0.24, 0.55]], ['右手首', [0.24, 0.5]]
    ].map(([name, angles]) => [name, rotationTrack([0, 11], angles as number[])]));

    expect(selectSpeechEntryStartFrame(boneTracks, 206, 30)).toBe(11);
  });

  it('keeps frame zero when the authored speech pose is already active', () => {
    const boneTracks = Object.fromEntries([
      ['左腕', [0.97, 0.75]], ['右腕', [0.97, 0.75]],
      ['左腕捩', [1.12, 0.2]], ['右腕捩', [1.24, 0.2]],
      ['左ひじ', [0.46, 1.95]], ['右ひじ', [0.46, 1.95]],
      ['左手捩', [0.002, 0.73]], ['右手捩', [0.002, 0.73]],
      ['左手首', [0.29, 0.4]], ['右手首', [0.37, 0.4]]
    ].map(([name, angles]) => [name, rotationTrack([0, 15], angles as number[])]));

    expect(selectSpeechEntryStartFrame(boneTracks, 135, 30)).toBe(0);
  });

  it('keeps frame zero for an active static or looping arm pose', () => {
    const boneTracks = Object.fromEntries([
      ['左腕', 0.97], ['右腕', 1.04], ['左腕捩', 1.36], ['右腕捩', 0.88],
      ['左ひじ', 1.68], ['右ひじ', 2.41], ['左手捩', 0.39], ['右手捩', 0.93]
    ].map(([name, angle]) => [name, rotationTrack([0], [angle as number])]));

    expect(selectSpeechEntryStartFrame(boneTracks, 100, 30)).toBe(0);
  });

  it('repairs only the neutral arm lead-in while preserving full body timing', () => {
    const leftArm = rotationTrack([0, 11, 21], [0.1, 0.9, 1.1]);
    const upperBody = rotationTrack([0, 28], [0.05, 0.4]);
    const loaded = {
      bytes: new Uint8Array([1]),
      animation: {
        kind: 'vmd' as const,
        bytes: new Uint8Array([1]),
        metadata: { maxFrame: 100, counts: { bones: 2, morphs: 0 } },
        boneTracks: { '左腕': leftArm, '上半身': upperBody },
        morphTracks: {}
      } as any,
      boneTracks: { '左腕': leftArm, '上半身': upperBody },
      morphTracks: {}
    };

    const repaired = repairSpeechEntryNeutralArmLeadIn(loaded, 11);

    expect(repaired.boneTracks['左腕'].rotations.slice(0, 4))
      .toEqual(leftArm.rotations.slice(4, 8));
    expect(repaired.boneTracks['左腕'].frames).toBe(leftArm.frames);
    expect(repaired.boneTracks['上半身']).toBe(upperBody);
    expect(repaired.animation.bytes).toHaveLength(0);
    expect(leftArm.rotations[2]).toBeCloseTo(Math.sin(0.05), 6);
  });
});
