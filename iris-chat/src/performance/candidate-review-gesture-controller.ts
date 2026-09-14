import type { CandidateMotionPayload } from '../../electron/candidate-review-motion-catalog';
import {
  selectCandidateReviewPerformance,
  type CandidateCueId,
  type CandidatePerformanceInput
} from './candidate-review-performance';

interface CandidateReviewGesturePorts {
  readonly load: (cueId: CandidateCueId) => Promise<CandidateMotionPayload | null>;
  readonly play: (candidate: CandidateMotionPayload) => Promise<void>;
  readonly isCurrentSpeech: (generation: number) => boolean;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export class CandidateReviewGestureController {
  private readonly ports: CandidateReviewGesturePorts;
  private startedGeneration: number | null = null;
  private resetEpoch = 0;

  constructor(ports: CandidateReviewGesturePorts) {
    this.ports = ports;
  }

  async startAfterAudio(
    input: CandidatePerformanceInput,
    speechGeneration: number,
    audioStarted: boolean
  ): Promise<boolean> {
    if (!audioStarted || this.startedGeneration === speechGeneration) return false;
    if (!this.ports.isCurrentSpeech(speechGeneration)) return false;

    const selection = selectCandidateReviewPerformance(input);
    if (!selection.cueId) return false;

    const startEpoch = this.resetEpoch;
    this.startedGeneration = speechGeneration;
    try {
      await this.ports.delay(180);
      if (startEpoch !== this.resetEpoch || !this.ports.isCurrentSpeech(speechGeneration)) {
        return false;
      }
      const candidate = await this.ports.load(selection.cueId);
      if (!candidate
        || startEpoch !== this.resetEpoch
        || !this.ports.isCurrentSpeech(speechGeneration)) {
        return false;
      }
      await this.ports.play(candidate);
      return startEpoch === this.resetEpoch && this.ports.isCurrentSpeech(speechGeneration);
    } catch (error) {
      this.ports.warn?.(`[candidate-review] gesture failed: ${(error as Error).message}`);
      return false;
    }
  }

  reset(): void {
    this.resetEpoch += 1;
    this.startedGeneration = null;
  }
}
