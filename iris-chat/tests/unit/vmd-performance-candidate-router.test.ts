import { describe, expect, it } from 'vitest';
import type { AvatarPerformanceProfile } from '../../src/actor/avatar-performance-profile';
import type { LoadedVmd } from '../../src/motion/motion-pack-loader';
import {
  routeVmdPerformanceCandidate,
  stripCandidateMorphTracks
} from '../../src/motion/vmd-performance-candidate-router';

function boneTrack() {
  return {
    packed: 'bone' as const,
    frames: new Uint32Array([0, 30]),
    translations: new Float32Array(6),
    rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0.2, 0.98]),
    interpolations: new Float32Array(32),
    physicsToggles: new Int8Array([-1, -1])
  };
}

function morphTrack(frames: number[], weights: number[]) {
  return {
    packed: 'morph' as const,
    frames: new Uint32Array(frames),
    weights: new Float32Array(weights)
  };
}

function loadedVmd(morphTracks: LoadedVmd['morphTracks']): LoadedVmd {
  const boneTracks = { '右腕': boneTrack() };
  return {
    bytes: new Uint8Array([1, 2, 3]),
    animation: {
      kind: 'vmd',
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { maxFrame: 30, counts: { bones: 2, morphs: 3 } },
      boneTracks,
      morphTracks
    } as any,
    boneTracks,
    morphTracks
  };
}

const profile = {
  profileVersion: 2,
  avatarSha256: 'A'.repeat(64),
  modelId: 'fixture',
  visemes: {},
  expressions: {},
  mouthStyles: {},
  facialChannels: {
    mouthSmileLeft: {
      morphs: [{ name: '笑い', scale: 0.5 }],
      maxWeight: 0.55
    }
  },
  blushMorph: 'FaceRed',
  tearsMorph: '涙',
  gaze: { supported: false },
  conversationMotionIds: []
} satisfies AvatarPerformanceProfile;

describe('VMD performance candidate routing', () => {
  it('keeps the source intact while creating independent bone and expression views', () => {
    const source = loadedVmd({
      '笑い': morphTrack([0, 15, 30], [0.2, 1.2, -0.2]),
      FaceRed: morphTrack([0, 30], [0, 0.8])
    });

    const routed = routeVmdPerformanceCandidate(source, profile);

    expect(routed.source).toBe(source);
    expect(Object.keys(routed.motion.boneTracks)).toEqual(['右腕']);
    expect(Object.keys(routed.motion.morphTracks)).toEqual([]);
    expect(routed.motion.bytes).toHaveLength(0);
    expect(routed.expression.durationSeconds).toBe(1);
    expect(routed.expression.channelCurves.mouthSmileLeft).toEqual([
      { timeSeconds: 0, value: expect.closeTo(0.1, 6) },
      { timeSeconds: 0.5, value: 0.55 },
      { timeSeconds: 1, value: 0 }
    ]);
    expect(routed.expression.channelCurves.blush).toEqual([
      { timeSeconds: 0, value: 0 },
      { timeSeconds: 1, value: 0.35 }
    ]);
    expect(source.morphTracks['笑い']).toBeDefined();
    expect(source.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reports unknown morphs instead of guessing a facial channel', () => {
    const source = loadedVmd({
      'unknown-face': morphTrack([0, 30], [0, 1])
    });

    const routed = routeVmdPerformanceCandidate(source, profile);

    expect(routed.expression.channelCurves).toEqual({});
    expect(routed.expression.unmappedMorphNames).toEqual(['unknown-face']);
  });

  it('samples all explicitly bound native morphs on their union of key frames', () => {
    const multiProfile = {
      ...profile,
      facialChannels: {
        browInnerUp: {
          morphs: [
            { name: 'brow-left', scale: 0.5 },
            { name: 'brow-right', scale: 0.5 }
          ],
          maxWeight: 0.6
        }
      }
    } satisfies AvatarPerformanceProfile;
    const source = loadedVmd({
      'brow-left': morphTrack([0, 30], [0, 1]),
      'brow-right': morphTrack([0, 15, 30], [0, 0.6, 0])
    });

    const keys = routeVmdPerformanceCandidate(source, multiProfile)
      .expression.channelCurves.browInnerUp;

    expect(keys).toEqual([
      { timeSeconds: 0, value: 0 },
      { timeSeconds: 0.5, value: expect.closeTo(0.55, 6) },
      { timeSeconds: 1, value: 0.5 }
    ]);
  });

  it('strips only the routed preview copy and never mutates the source VMD', () => {
    const source = loadedVmd({ '笑い': morphTrack([0], [0.4]) });
    const motion = stripCandidateMorphTracks(source);

    expect(motion.morphTracks).toEqual({});
    expect(motion.animation.morphTracks).toEqual({});
    expect(source.morphTracks['笑い'].weights[0]).toBeCloseTo(0.4, 6);
  });
});
