import type { AvatarPerformanceProfile, FacialChannelBinding } from './avatar-performance-profile';
import type { MorphController } from './morph-controller';
import { FACIAL_CHANNELS, clampFacialWeight, createEmptyFacialPose, type FacialChannel, type FacialPose } from '../performance/facial-pose';
import { emptyVisemeWeights, type VisemeWeights } from '../performance/lip-timeline';

const MOUTH_STYLE_CHANNELS = new Set<FacialChannel>([
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthPucker'
]);

const SYMMETRIC_CHANNEL_PAIRS: readonly (readonly [FacialChannel, FacialChannel])[] = [
  ['browOuterUpLeft', 'browOuterUpRight'],
  ['browDownLeft', 'browDownRight'],
  ['eyeWideLeft', 'eyeWideRight'],
  ['eyeSquintLeft', 'eyeSquintRight'],
  ['cheekRaiseLeft', 'cheekRaiseRight'],
  ['mouthSmileLeft', 'mouthSmileRight'],
  ['mouthFrownLeft', 'mouthFrownRight'],
  ['mouthStretchLeft', 'mouthStretchRight']
] as const;

export class MorphLayerMixer {
  private expressionPose: FacialPose = createEmptyFacialPose();
  private visemes: VisemeWeights = emptyVisemeWeights();
  private readonly auxiliaryLanes = new Map<string, Record<string, number>>();
  private readonly knownMorphs: ReadonlySet<string>;
  private readonly ownedMorphNames = new Set<string>();
  private lastCommitted = new Map<string, number>();

  constructor(
    private readonly profile: AvatarPerformanceProfile,
    private readonly morphs: MorphController
  ) {
    this.knownMorphs = new Set(morphs.getKnownMorphs());
    for (const binding of Object.values(profile.facialChannels ?? {})) {
      for (const morph of binding?.morphs ?? []) {
        if (this.knownMorphs.has(morph.name)) this.ownedMorphNames.add(morph.name);
      }
    }
    for (const name of Object.values(profile.visemes)) {
      if (name && this.knownMorphs.has(name)) this.ownedMorphNames.add(name);
    }
    for (const name of [profile.blushMorph, profile.tearsMorph]) {
      if (name && this.knownMorphs.has(name)) this.ownedMorphNames.add(name);
    }
  }

  setExpressionPose(pose: FacialPose): void {
    const synchronized = Object.fromEntries(FACIAL_CHANNELS.map(channel => [
      channel,
      clampFacialWeight(pose[channel])
    ])) as unknown as FacialPose;
    const mutable = { ...synchronized } as Record<FacialChannel, number>;
    for (const [left, right] of SYMMETRIC_CHANNEL_PAIRS) {
      const pairedWeight = Math.max(mutable[left], mutable[right]);
      mutable[left] = pairedWeight;
      mutable[right] = pairedWeight;
    }
    this.expressionPose = mutable;
  }

  setVisemes(weights: VisemeWeights): void {
    const clamped = {
      A: clampFacialWeight(weights.A), I: clampFacialWeight(weights.I),
      U: clampFacialWeight(weights.U), E: clampFacialWeight(weights.E),
      O: clampFacialWeight(weights.O)
    };
    const total = Object.values(clamped).reduce((sum, value) => sum + value, 0);
    const scale = total > 1 ? 1 / total : 1;
    this.visemes = {
      A: clamped.A * scale, I: clamped.I * scale, U: clamped.U * scale,
      E: clamped.E * scale, O: clamped.O * scale
    };
  }

  setAuxiliaryMorphs(weights: Readonly<Record<string, number>>): void {
    this.setAuxiliaryMorphLane('default', weights);
  }

  setAuxiliaryMorphLane(lane: string, weights: Readonly<Record<string, number>>): void {
    const admitted = Object.fromEntries(Object.entries(weights)
      .filter(([name]) => this.knownMorphs.has(name))
      .map(([name, weight]) => [name, clampFacialWeight(weight)]));
    for (const name of Object.keys(admitted)) this.ownedMorphNames.add(name);
    this.auxiliaryLanes.set(lane, admitted);
  }

  setAuxiliaryMorphWeight(lane: string, name: string, weight: number): void {
    if (!this.knownMorphs.has(name)) return;
    this.ownedMorphNames.add(name);
    const current = this.auxiliaryLanes.get(lane) ?? {};
    this.auxiliaryLanes.set(lane, { ...current, [name]: clampFacialWeight(weight) });
  }

  commit(): Readonly<Record<string, number>> {
    const output: Record<string, number> = {};
    const dominantViseme = Math.max(...Object.values(this.visemes));
    const winningGroups = this.resolveOpposingGroups();

    for (const channel of FACIAL_CHANNELS) {
      if (channel === 'blush' || channel === 'tears') continue;
      const binding = this.profile.facialChannels?.[channel];
      if (!binding || !this.bindingAvailable(binding)) continue;
      if (binding.opposingGroup && winningGroups.get(binding.opposingGroup) !== channel) continue;

      const semanticWeight = this.expressionPose[channel];
      let layerScale = 1;
      if (MOUTH_STYLE_CHANNELS.has(channel)) {
        // Keep the emotional mouth arc readable while A/I/U/E/O is open.
        // At a full viseme, 55% of the configured corner style remains.
        layerScale = 1 - 0.45 * dominantViseme;
      } else if (channel === 'mouthClose' || channel === 'jawOpen') {
        layerScale = 1 - dominantViseme;
      }
      const channelWeight = Math.min(binding.maxWeight, semanticWeight) * layerScale;
      for (const morph of binding.morphs) {
        this.addWeight(output, morph.name, channelWeight * morph.scale);
      }
    }

    this.addOptionalAttachment(output, this.profile.blushMorph, this.expressionPose.blush);
    this.addOptionalAttachment(output, this.profile.tearsMorph, this.expressionPose.tears);

    for (const [viseme, weight] of Object.entries(this.visemes) as [keyof VisemeWeights, number][]) {
      const name = this.profile.visemes[viseme];
      if (name && this.knownMorphs.has(name)) this.addWeight(output, name, weight);
    }
    for (const weights of this.auxiliaryLanes.values()) {
      for (const [name, weight] of Object.entries(weights)) {
        this.addWeight(output, name, weight);
      }
    }

    const next = new Map(Object.entries(output).map(([name, weight]) => [name, clampFacialWeight(weight)]));
    const batch: Record<string, number> = {};
    const names = new Set([...this.lastCommitted.keys(), ...next.keys()]);
    for (const name of names) {
      const previousWeight = this.lastCommitted.get(name) ?? 0;
      const nextWeight = next.get(name) ?? 0;
      if (Math.abs(previousWeight - nextWeight) > 0.000001) batch[name] = nextWeight;
    }
    if (Object.keys(batch).length > 0) this.morphs.applyBatch(batch);
    this.lastCommitted = next;
    return { ...output };
  }

  /** Reapply the complete facial state after a VMD frame cleared mesh morphs. */
  reapply(): void {
    if (this.ownedMorphNames.size === 0) return;
    this.morphs.applyBatch(Object.fromEntries(Array.from(this.ownedMorphNames, name => [
      name,
      this.lastCommitted.get(name) ?? 0
    ])));
  }

  reset(): void {
    if (this.lastCommitted.size > 0) {
      this.morphs.applyBatch(Object.fromEntries(Array.from(this.lastCommitted.keys(), name => [name, 0])));
    }
    this.expressionPose = createEmptyFacialPose();
    this.visemes = emptyVisemeWeights();
    this.auxiliaryLanes.clear();
    this.lastCommitted.clear();
  }

  clearSpeechLayers(): void {
    this.expressionPose = createEmptyFacialPose();
    this.visemes = emptyVisemeWeights();
    this.commit();
  }

  clearVisemes(): void {
    this.visemes = emptyVisemeWeights();
    this.commit();
  }

  private resolveOpposingGroups(): Map<string, FacialChannel> {
    const winners = new Map<string, { channel: FacialChannel; weight: number }>();
    for (const channel of FACIAL_CHANNELS) {
      const binding = this.profile.facialChannels?.[channel];
      if (!binding?.opposingGroup) continue;
      const weight = this.expressionPose[channel] * binding.maxWeight;
      const current = winners.get(binding.opposingGroup);
      if (!current || weight > current.weight) winners.set(binding.opposingGroup, { channel, weight });
    }
    return new Map(Array.from(winners, ([group, winner]) => [group, winner.channel]));
  }

  private bindingAvailable(binding: FacialChannelBinding): boolean {
    return binding.morphs.length > 0
      && binding.morphs.every(morph => this.knownMorphs.has(morph.name));
  }

  private addOptionalAttachment(output: Record<string, number>, name: string | undefined, weight: number): void {
    if (name && this.knownMorphs.has(name)) this.addWeight(output, name, weight);
  }

  private addWeight(output: Record<string, number>, name: string, weight: number): void {
    output[name] = clampFacialWeight((output[name] ?? 0) + weight);
  }
}
// provenance: wha9917/private-optimizations — expression layering marker; inert.
