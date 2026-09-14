import { describe, expect, it } from 'vitest';
import { MorphController } from '../../src/actor/morph-controller';
import { MorphLayerMixer } from '../../src/actor/morph-layer-mixer';
import type { AvatarPerformanceProfile } from '../../src/actor/avatar-performance-profile';
import { createEmptyFacialPose, type FacialPose } from '../../src/performance/facial-pose';

function pose(overrides: Partial<FacialPose>): FacialPose {
  return { ...createEmptyFacialPose(), ...overrides };
}

function profile(overrides: Partial<AvatarPerformanceProfile> = {}): AvatarPerformanceProfile {
  return {
    profileVersion: 2,
    avatarSha256: 'A'.repeat(64),
    modelId: 'test-avatar',
    visemes: { A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お' },
    blinkMorph: 'まばたき',
    expressions: {},
    mouthStyles: {},
    facialChannels: {
      mouthSmileLeft: {
        morphs: [{ name: '笑左', scale: 1 }], maxWeight: 0.4,
        opposingGroup: 'left-mouth-corner'
      },
      mouthSmileRight: {
        morphs: [{ name: '笑右', scale: 1 }], maxWeight: 0.4,
        opposingGroup: 'right-mouth-corner'
      },
      mouthFrownLeft: {
        morphs: [{ name: '悲左', scale: 1 }], maxWeight: 0.4,
        opposingGroup: 'left-mouth-corner'
      },
      mouthClose: {
        morphs: [{ name: '闭嘴', scale: 1 }], maxWeight: 0.3,
        opposingGroup: 'jaw'
      },
      browDownLeft: {
        morphs: [{ name: '怒眉左', scale: 1 }], maxWeight: 0.5,
        opposingGroup: 'left-brow'
      },
      browDownRight: {
        morphs: [{ name: '怒眉右', scale: 1 }], maxWeight: 0.5,
        opposingGroup: 'right-brow'
      },
      eyeLidClose: {
        morphs: [{ name: 'まばたき', scale: 1 }], maxWeight: 0.55,
        opposingGroup: 'eyelid'
      }
    },
    blushMorph: '脸红',
    tearsMorph: '眼泪',
    gaze: { supported: false },
    conversationMotionIds: [],
    ...overrides
  };
}

const KNOWN = ['あ', 'い', 'う', 'え', 'お', 'まばたき', '笑左', '笑右', '悲左', '闭嘴', '怒眉左', '怒眉右', '脸红', '眼泪', '瞳小'];

describe('MorphLayerMixer', () => {
  it('keeps expression and auxiliary layers when visemes update', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ browDownLeft: 0.8, blush: 0.2 }));
    mixer.setAuxiliaryMorphs({ 瞳小: 0.15, まばたき: 0.4 });
    mixer.setVisemes({ A: 0.6, I: 0.2, U: 0, E: 0, O: 0 });

    mixer.commit();

    expect(morphs.getWeight('怒眉左')).toBeCloseTo(0.5, 6);
    expect(morphs.getWeight('脸红')).toBeCloseTo(0.2, 6);
    expect(morphs.getWeight('瞳小')).toBeCloseTo(0.15, 6);
    expect(morphs.getWeight('まばたき')).toBeCloseTo(0.4, 6);
    expect(morphs.getWeight('あ')).toBeCloseTo(0.6, 6);
  });

  it('always drives paired brows, eyes and mouth corners together', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ browDownLeft: 0.7, mouthSmileRight: 0.6 }));

    mixer.commit();

    expect(morphs.getWeight('怒眉左')).toBeCloseTo(morphs.getWeight('怒眉右'), 6);
    expect(morphs.getWeight('笑左')).toBeCloseTo(morphs.getWeight('笑右'), 6);
    expect(morphs.getWeight('怒眉左')).toBeGreaterThan(0);
    expect(morphs.getWeight('笑左')).toBeGreaterThan(0);
  });

  it('normalizes A/I/U/E/O to a total no greater than one', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setVisemes({ A: 0.8, I: 0.8, U: 0.4, E: 0, O: 0 });
    mixer.commit();

    const sum = ['あ', 'い', 'う', 'え', 'お'].reduce((total, name) => total + morphs.getWeight(name), 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('retains 55 percent of configured mouth-corner style at full viseme', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthSmileLeft: 1 }));
    mixer.setVisemes({ A: 1, I: 0, U: 0, E: 0, O: 0 });
    mixer.commit();

    expect(morphs.getWeight('笑左')).toBeCloseTo(0.4 * 0.55, 6);
  });

  it('uses profile maxWeight as a safety cap instead of scaling semantic weight twice', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthSmileLeft: 0.3 }));

    mixer.commit();

    expect(morphs.getWeight('笑左')).toBeCloseTo(0.3, 6);
  });

  it('suppresses mouthClose while an open viseme is active', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthClose: 1 }));
    mixer.setVisemes({ A: 1, I: 0, U: 0, E: 0, O: 0 });
    mixer.commit();

    expect(morphs.getWeight('闭嘴')).toBe(0);
  });

  it('selects the stronger channel in an opposing group', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthSmileLeft: 0.7, mouthFrownLeft: 0.2 }));
    mixer.commit();

    expect(morphs.getWeight('笑左')).toBeGreaterThan(0);
    expect(morphs.getWeight('悲左')).toBe(0);
  });

  it('fails closed when a profile binding names an unavailable morph', () => {
    const badProfile = profile({
      facialChannels: {
        browDownLeft: { morphs: [{ name: '不存在', scale: 1 }], maxWeight: 1 }
      }
    });
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(badProfile, morphs);
    mixer.setExpressionPose(pose({ browDownLeft: 1 }));

    expect(() => mixer.commit()).not.toThrow();
    expect(morphs.getActiveMorphs()).toEqual([]);
  });

  it('reset clears only morphs previously owned by the mixer', () => {
    const morphs = new MorphController([...KNOWN, '服装']);
    morphs.setWeight('服装', 0.7);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthSmileLeft: 1 }));
    mixer.commit();

    mixer.reset();

    expect(morphs.getWeight('笑左')).toBe(0);
    expect(morphs.getWeight('服装')).toBe(0.7);
  });

  it('clears speech expression and visemes while preserving blink and pupil lanes', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ browDownLeft: 0.8, mouthSmileLeft: 0.3 }));
    mixer.setVisemes({ A: 0.6, I: 0.2, U: 0, E: 0, O: 0 });
    mixer.setAuxiliaryMorphLane('blink', { まばたき: 0.45 });
    mixer.setAuxiliaryMorphLane('pupil', { 瞳小: 0.12 });
    mixer.commit();

    mixer.clearSpeechLayers();

    expect(morphs.getWeight('怒眉左')).toBe(0);
    expect(morphs.getWeight('笑左')).toBe(0);
    expect(morphs.getWeight('あ')).toBe(0);
    expect(morphs.getWeight('い')).toBe(0);
    expect(morphs.getWeight('まばたき')).toBeCloseTo(0.45, 6);
    expect(morphs.getWeight('瞳小')).toBeCloseTo(0.12, 6);
  });

  it('combines emotional eyelid closure with the procedural blink lane', () => {
    const morphs = new MorphController(KNOWN);
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ eyeLidClose: 0.3 }));
    mixer.setAuxiliaryMorphLane('blink', { まばたき: 0.4 });
    mixer.commit();

    expect(morphs.getWeight('まばたき')).toBeCloseTo(0.7, 6);
  });

  it('does not rewrite unchanged morph weights on repeated commits', () => {
    const morphs = new MorphController(KNOWN);
    const writes: Array<{ name: string; weight: number }> = [];
    morphs.bindSink({
      setWeight: (name, weight) => writes.push({ name, weight }),
      resetAll: () => undefined
    });
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ mouthSmileLeft: 0.3 }));
    mixer.setVisemes({ A: 0.4, I: 0, U: 0, E: 0, O: 0 });
    mixer.commit();
    expect(writes.length).toBeGreaterThan(0);

    writes.length = 0;
    mixer.commit();
    expect(writes).toEqual([]);
  });

  it('can explicitly reapply unchanged layers after a VMD frame resets the mesh', () => {
    const morphs = new MorphController(KNOWN);
    const rendered = new Map<string, number>();
    morphs.bindSink({
      setWeight: (name, weight) => rendered.set(name, weight),
      resetAll: () => rendered.clear()
    });
    const mixer = new MorphLayerMixer(profile(), morphs);
    mixer.setExpressionPose(pose({ eyeLidClose: 0.3, mouthSmileLeft: 0.35 }));
    mixer.commit();
    rendered.clear(); // simulate applyMmdAnimation().morphTargetInfluences.fill(0)

    mixer.reapply();

    expect(rendered.get('まばたき')).toBeCloseTo(0.3, 6);
    expect(rendered.get('笑左')).toBeCloseTo(0.35, 6);
  });
});
