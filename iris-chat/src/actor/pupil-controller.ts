import type { MorphController } from './morph-controller';

export type PupilMorphPort = Pick<MorphController, 'getKnownMorphs' | 'setWeight'>;

export interface PupilState {
  readonly smallMorph?: string;
  readonly largeMorph?: string;
  readonly smallWeight: number;
  readonly largeWeight: number;
}

export class PupilController {
  private readonly smallMorph?: string;
  private readonly largeMorph?: string;
  private speaking = false;
  private semantic = 'neutral';
  private elapsed = 0;
  private smallWeight = 0;
  private largeWeight = 0;

  constructor(private readonly morphs: PupilMorphPort) {
    const known = new Set(morphs.getKnownMorphs());
    this.smallMorph = ['瞳小', '瞳縮小'].find(name => known.has(name));
    this.largeMorph = ['瞳大'].find(name => known.has(name));
  }

  startSpeaking(semantic = 'neutral'): void {
    this.speaking = true;
    this.elapsed = 0;
    this.setSemantic(semantic);
  }

  setSemantic(semantic: string): void {
    this.semantic = String(semantic || 'neutral').toLowerCase();
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(0.1, Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0));
    this.elapsed += dt;
    const idlePulse = (Math.sin(this.elapsed * 0.55) + 1) * 0.5;
    const speechPulse = (Math.sin(this.elapsed * 0.68 + 0.35) + 1) * 0.5;
    const shockPulse = (Math.sin(this.elapsed * 1.05) + 1) * 0.5;
    let smallTarget = 0;
    let largeTarget = 0;

    if (!this.speaking) {
      if (this.largeMorph) {
        largeTarget = 0.045 + idlePulse * 0.035;
      } else {
        smallTarget = 0.008 + (1 - idlePulse) * 0.012;
      }
    } else if (['surprised', 'shocked', 'fearful', 'terrified', 'panic'].includes(this.semantic)) {
      // Strong pupil changes are reserved for genuine shock/fear semantics.
      if (this.largeMorph) largeTarget = 0.43 + shockPulse * 0.12;
      else smallTarget = 0.002 + (1 - shockPulse) * 0.01;
    } else if (this.largeMorph) {
      // Ordinary speech stays close to the PMX neutral pupil size. Emotion is
      // carried by lids, brows, gaze and mouth rather than contraction.
      largeTarget = 0.035 + speechPulse * 0.03;
    } else {
      smallTarget = 0.008 + (1 - speechPulse) * 0.012;
    }

    const alpha = 1 - Math.exp(-dt / (this.speaking ? 0.22 : 0.34));
    this.smallWeight += (smallTarget - this.smallWeight) * alpha;
    this.largeWeight += (largeTarget - this.largeWeight) * alpha;
    this.apply();
  }

  stopSpeaking(): void {
    this.speaking = false;
    this.elapsed = 0;
    this.semantic = 'neutral';
  }

  getState(): PupilState {
    return {
      smallMorph: this.smallMorph,
      largeMorph: this.largeMorph,
      smallWeight: this.smallWeight,
      largeWeight: this.largeWeight
    };
  }

  private apply(): void {
    if (this.smallMorph) this.morphs.setWeight(this.smallMorph, this.smallWeight);
    if (this.largeMorph) this.morphs.setWeight(this.largeMorph, this.largeWeight);
  }
}
