import { describe, expect, it } from 'vitest';
import type { MmdAnimation, VmdBoneTrack } from '@yohawing/three-mmd-loader/parser';
import type { LoadedVmd } from '../../src/motion/motion-pack-loader';
import {
  applySpeechStanceTracks,
  SPEECH_BACKGROUND_STANCE_SOURCE_RETENTION,
  isRestrainedDialogueSourceBone,
  SPEECH_STANCE_SOURCE_RETENTION
} from '../../src/motion/speech-stance-tracks';
import type { SpeechStanceProfile } from '../../src/performance/speech-stance-director';

function identityTrack(translationX = 0): VmdBoneTrack {
  return {
    packed: 'bone',
    frames: new Uint32Array([0]),
    translations: new Float32Array([translationX, 0, 0]),
    rotations: new Float32Array([0, 0, 0, 1]),
    interpolations: new Float32Array(16),
    physicsToggles: new Int8Array([-1])
  };
}

function animatedRotationTrack(degrees: number): VmdBoneTrack {
  const radians = degrees * Math.PI / 180;
  return {
    packed: 'bone',
    frames: new Uint32Array([0, 30, 60]),
    translations: new Float32Array([0, 0, 0, 3, 0, 0, 0, 0, 0]),
    rotations: new Float32Array([
      0, 0, 0, 1,
      Math.sin(radians / 2), 0, 0, Math.cos(radians / 2),
      0, 0, 0, 1
    ]),
    interpolations: new Float32Array(48),
    physicsToggles: new Int8Array([-1, -1, -1])
  };
}

function loadedWithTracks(boneTracks: Record<string, VmdBoneTrack>): LoadedVmd {
  const animation: MmdAnimation = {
    kind: 'vmd',
    bytes: new Uint8Array(),
    metadata: {
      modelName: 'test',
      counts: { bones: 1, morphs: 0, cameras: 0, lights: 0, selfShadows: 0, properties: 0 },
      maxFrame: 60
    },
    boneTracks,
    morphTracks: {},
    cameraFrames: [],
    lightFrames: [],
    selfShadowFrames: [],
    propertyFrames: []
  };
  return { bytes: new Uint8Array(), animation, boneTracks, morphTracks: {} };
}

const stance: SpeechStanceProfile = {
  id: 'warm-left',
  pelvisPitchDegrees: 0.4,
  pelvisRollDegrees: 0.7,
  leftLegPitchDegrees: -0.2,
  rightLegPitchDegrees: 0.1,
  leftKneePitchDegrees: 0.3,
  rightKneePitchDegrees: 0.5
};

describe('applySpeechStanceTracks', () => {
  it('admits only rotation-safe lower-body source bones into the speech stance stage', () => {
    for (const safe of ['下半身', '左足', '右足', '左ひざ', '右ひざ']) {
      expect(isRestrainedDialogueSourceBone(safe)).toBe(true);
    }
    for (const unsafe of ['全ての親', 'センター', 'グルーブ', '腰', '左足首', '右足ＩＫ']) {
      expect(isRestrainedDialogueSourceBone(unsafe)).toBe(false);
    }
  });
  it('preserves upper body, replaces raw lower body and never adds root or center translation', () => {
    const loaded = loadedWithTracks({
      '上半身': identityTrack(),
      '下半身': identityTrack(12),
      'センター': identityTrack(8)
    });
    const modelBones = new Set(['上半身', '下半身', '左足', '右足', '左ひざ', '右ひざ', 'センター', '全ての親']);

    const result = applySpeechStanceTracks(loaded, stance, 0.75, modelBones);

    expect(result.boneTracks['上半身']).toBe(loaded.boneTracks['上半身']);
    expect(result.boneTracks['センター']).toBeUndefined();
    expect(result.boneTracks['全ての親']).toBeUndefined();
    for (const name of ['下半身', '左足', '右足', '左ひざ', '右ひざ']) {
      expect(result.boneTracks[name]).toBeDefined();
      expect([...result.boneTracks[name].translations].every(value => value === 0)).toBe(true);
    }
    expect(result.animation.bytes.byteLength).toBe(0);
  });

  it('adds only lower-body bones that exist in the selected PMX', () => {
    const result = applySpeechStanceTracks(
      loadedWithTracks({ '上半身': identityTrack() }),
      stance,
      1,
      new Set(['上半身', '下半身'])
    );

    expect(Object.keys(result.boneTracks).sort()).toEqual(['上半身', '下半身'].sort());
  });

  it('creates a visible multi-key balance curve even when the source has no lower-body motion or accent', () => {
    const result = applySpeechStanceTracks(
      loadedWithTracks({ '上半身': identityTrack() }),
      stance,
      0.75,
      new Set(['上半身', '下半身', '左足', '右足', '左ひざ', '右ひざ'])
    );
    const angularDistanceDegrees = (track: VmdBoneTrack, from: number, to: number): number => {
      const a = track.rotations.slice(from * 4, from * 4 + 4);
      const b = track.rotations.slice(to * 4, to * 4 + 4);
      const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
      return 2 * Math.acos(dot) * 180 / Math.PI;
    };

    for (const name of ['下半身', '左足', '右足', '左ひざ', '右ひざ']) {
      const track = result.boneTracks[name];
      expect(track.frames.length).toBe(5);
      expect([...track.translations].every(value => value === 0)).toBe(true);
      expect([...track.rotations.slice(0, 4)]).toEqual([...track.rotations.slice(-4)]);
    }
    expect(angularDistanceDegrees(result.boneTracks['下半身'], 0, 2)).toBeGreaterThan(0.7);
    expect(angularDistanceDegrees(result.boneTracks['左足'], 0, 2)).toBeGreaterThan(0.45);
    expect(angularDistanceDegrees(result.boneTracks['左ひざ'], 0, 2)).toBeGreaterThan(0.8);
  });

  it('retains a restrained rotation-only trace of each short action instead of welding the legs', () => {
    const loaded = loadedWithTracks({
      '下半身': animatedRotationTrack(18),
      '左足': animatedRotationTrack(14),
      '右足': animatedRotationTrack(-14),
      'センター': animatedRotationTrack(10),
      '左足ＩＫ': animatedRotationTrack(10)
    });
    const modelBones = new Set(['下半身', '左足', '右足', '左ひざ', '右ひざ', 'センター', '左足ＩＫ']);

    const result = applySpeechStanceTracks(loaded, stance, 0.75, modelBones);

    expect(result.boneTracks['下半身'].frames.length).toBe(3);
    expect(result.boneTracks['左足'].frames.length).toBe(3);
    expect([...result.boneTracks['左足'].translations].every(value => value === 0)).toBe(true);
    expect([...result.boneTracks['左足'].rotations.slice(4, 8)])
      .not.toEqual([...result.boneTracks['左足'].rotations.slice(0, 4)]);
    expect(result.boneTracks['センター']).toBeUndefined();
    expect(result.boneTracks['左足ＩＫ']).toBeUndefined();
    expect(SPEECH_STANCE_SOURCE_RETENTION).toBeGreaterThanOrEqual(0.7);
    expect(SPEECH_BACKGROUND_STANCE_SOURCE_RETENTION).toBeGreaterThanOrEqual(0.88);
  });

  it('lets the default speech background retain more safe lower-body rhythm than a short accent', () => {
    const source = loadedWithTracks({ '下半身': animatedRotationTrack(4) });
    const modelBones = new Set(['下半身']);
    const angularDistanceDegrees = (track: VmdBoneTrack): number => {
      const first = track.rotations.slice(0, 4);
      const middle = track.rotations.slice(4, 8);
      const dot = Math.min(1, Math.abs(
        first[0] * middle[0] + first[1] * middle[1]
        + first[2] * middle[2] + first[3] * middle[3]
      ));
      return 2 * Math.acos(dot) * 180 / Math.PI;
    };

    const accent = applySpeechStanceTracks(source, stance, 0.75, modelBones);
    const background = applySpeechStanceTracks(
      source,
      stance,
      0.75,
      modelBones,
      undefined,
      SPEECH_BACKGROUND_STANCE_SOURCE_RETENTION
    );

    expect(angularDistanceDegrees(background.boneTracks['下半身']))
      .toBeGreaterThan(angularDistanceDegrees(accent.boneTracks['下半身']));
    expect([...background.boneTracks['下半身'].translations].every(value => value === 0)).toBe(true);
  });

  it('builds a rotation-only stance accent that eases back to the exact base stance', () => {
    const loaded = loadedWithTracks({
      '上半身': identityTrack(),
      '下半身': identityTrack(12),
      '左足首': identityTrack(4),
      '右足ＩＫ': identityTrack(8),
      'センター': identityTrack(9),
      '全ての親': identityTrack(7)
    });
    const modelBones = new Set([
      '上半身', '下半身', '左足', '右足', '左ひざ', '右ひざ',
      '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', 'センター', '全ての親'
    ]);

    const result = applySpeechStanceTracks(
      loaded,
      stance,
      1,
      modelBones,
      { kind: 'weight-right', intensity: 0.8 }
    );

    for (const name of ['下半身', '左足', '右足', '左ひざ', '右ひざ']) {
      const track = result.boneTracks[name];
      expect(track.frames.length).toBeGreaterThanOrEqual(4);
      expect([...track.translations].every(value => value === 0)).toBe(true);
      expect([...track.rotations.slice(0, 4)]).toEqual([...track.rotations.slice(-4)]);
      expect([...track.rotations.slice(4, 8)]).not.toEqual([...track.rotations.slice(0, 4)]);
    }
    for (const unsafe of ['全ての親', 'センター', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ']) {
      expect(result.boneTracks[unsafe]).toBeUndefined();
    }

    const angularDistanceDegrees = (track: VmdBoneTrack, fromFrame: number, toFrame: number): number => {
      const a = track.rotations.slice(fromFrame * 4, fromFrame * 4 + 4);
      const b = track.rotations.slice(toFrame * 4, toFrame * 4 + 4);
      const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
      return 2 * Math.acos(dot) * 180 / Math.PI;
    };
    expect(angularDistanceDegrees(result.boneTracks['下半身'], 0, 1)).toBeGreaterThan(1.1);
    expect(angularDistanceDegrees(result.boneTracks['左足'], 0, 1)).toBeGreaterThan(0.65);
    expect(angularDistanceDegrees(result.boneTracks['左ひざ'], 0, 1)).toBeGreaterThan(1.0);
  });
});
