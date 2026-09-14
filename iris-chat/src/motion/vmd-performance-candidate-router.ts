import type { VmdMorphTrack } from '@yohawing/three-mmd-loader/parser';
import type { AvatarPerformanceProfile } from '../actor/avatar-performance-profile';
import type {
  ExpressionCurveKey
} from '../performance/daily-candidate-types';
import type { FacialChannel } from '../performance/facial-pose';
import type { LoadedVmd } from './motion-pack-loader';

export interface RoutedVmdExpression {
  readonly durationSeconds: number;
  readonly channelCurves: Readonly<Partial<Record<FacialChannel, readonly ExpressionCurveKey[]>>>;
  readonly unmappedMorphNames: readonly string[];
}

export interface RoutedVmdCandidate {
  readonly source: LoadedVmd;
  readonly motion: LoadedVmd;
  readonly expression: RoutedVmdExpression;
}

interface ChannelMorphBinding {
  readonly name: string;
  readonly scale: number;
}

interface ChannelRoute {
  readonly maxWeight: number;
  readonly morphs: readonly ChannelMorphBinding[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function sampleMorphTrack(track: VmdMorphTrack, frame: number): number {
  if (track.frames.length === 0) return 0;
  if (frame <= track.frames[0]) return track.weights[0] ?? 0;
  const lastIndex = track.frames.length - 1;
  if (frame >= track.frames[lastIndex]) return track.weights[lastIndex] ?? 0;
  for (let index = 1; index < track.frames.length; index += 1) {
    const nextFrame = track.frames[index];
    if (frame > nextFrame) continue;
    const previousFrame = track.frames[index - 1];
    const span = Math.max(1, nextFrame - previousFrame);
    const t = (frame - previousFrame) / span;
    const previousWeight = track.weights[index - 1] ?? 0;
    const nextWeight = track.weights[index] ?? previousWeight;
    return previousWeight + (nextWeight - previousWeight) * t;
  }
  return track.weights[lastIndex] ?? 0;
}

function buildRoutes(profile: AvatarPerformanceProfile): Partial<Record<FacialChannel, ChannelRoute>> {
  const routes: Partial<Record<FacialChannel, ChannelRoute>> = {};
  for (const [channel, binding] of Object.entries(profile.facialChannels ?? {})) {
    if (!binding) continue;
    routes[channel as FacialChannel] = {
      maxWeight: clamp(binding.maxWeight, 0, 1),
      morphs: binding.morphs.map(morph => ({
        name: morph.name,
        scale: clamp(morph.scale, 0, 1)
      }))
    };
  }
  const installDirect = (channel: FacialChannel, name: string | undefined, maximum: number): void => {
    if (!name || routes[channel]?.morphs.some(morph => morph.name === name)) return;
    routes[channel] = {
      maxWeight: Math.min(routes[channel]?.maxWeight ?? 1, maximum),
      morphs: [...(routes[channel]?.morphs ?? []), { name, scale: 1 }]
    };
  };
  installDirect('eyeLidClose', profile.blinkMorph, 0.55);
  installDirect('blush', profile.blushMorph, 0.35);
  installDirect('tears', profile.tearsMorph, 1);
  return routes;
}

export function stripCandidateMorphTracks(loaded: LoadedVmd): LoadedVmd {
  const boneTracks = { ...loaded.boneTracks };
  return {
    ...loaded,
    bytes: new Uint8Array(),
    animation: {
      ...loaded.animation,
      bytes: new Uint8Array(),
      metadata: {
        ...loaded.animation.metadata,
        counts: {
          ...loaded.animation.metadata.counts,
          morphs: 0
        }
      },
      boneTracks,
      morphTracks: {}
    },
    boneTracks,
    morphTracks: {}
  };
}

export function routeVmdPerformanceCandidate(
  loaded: LoadedVmd,
  profile: AvatarPerformanceProfile
): RoutedVmdCandidate {
  const routes = buildRoutes(profile);
  const mappedMorphNames = new Set<string>();
  const channelCurves: Partial<Record<FacialChannel, readonly ExpressionCurveKey[]>> = {};
  let maximumFrame = Number(loaded.animation.metadata.maxFrame ?? 0);
  for (const track of Object.values(loaded.morphTracks)) {
    if (track.frames.length > 0) maximumFrame = Math.max(maximumFrame, track.frames[track.frames.length - 1]);
  }

  for (const [channel, route] of Object.entries(routes) as Array<[FacialChannel, ChannelRoute]>) {
    const activeBindings = route.morphs
      .map(binding => ({ binding, track: loaded.morphTracks[binding.name] }))
      .filter((entry): entry is { binding: ChannelMorphBinding; track: VmdMorphTrack } => Boolean(entry.track));
    if (activeBindings.length === 0) continue;
    const frames = Array.from(new Set(activeBindings.flatMap(entry => Array.from(entry.track.frames))))
      .sort((a, b) => a - b);
    for (const entry of activeBindings) mappedMorphNames.add(entry.binding.name);
    channelCurves[channel] = frames.map(frame => ({
      timeSeconds: frame / 30,
      value: clamp(activeBindings.reduce(
        (sum, entry) => sum + sampleMorphTrack(entry.track, frame) * entry.binding.scale,
        0
      ), 0, route.maxWeight)
    }));
  }

  return {
    source: loaded,
    motion: stripCandidateMorphTracks(loaded),
    expression: {
      durationSeconds: Math.max(0, maximumFrame) / 30,
      channelCurves,
      unmappedMorphNames: Object.keys(loaded.morphTracks)
        .filter(name => !mappedMorphNames.has(name))
    }
  };
}
