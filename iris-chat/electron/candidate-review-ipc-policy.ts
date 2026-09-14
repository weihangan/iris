import type { CandidateCueId } from '../src/performance/candidate-review-performance';
import type { MotionRuntimeMode } from '../src/motion/motion-runtime-mode';

const CANDIDATE_CUE_IDS = new Set<CandidateCueId>([
  'disagree-small',
  'acknowledge-small',
  'thinking-small',
  'realization-small',
  'giggle-small',
  'shy-head-scratch'
]);

interface CandidateReviewRequestInput {
  readonly senderIsAvatar: boolean;
  readonly mode: MotionRuntimeMode;
  readonly rawCueId: unknown;
}

export function validateCandidateReviewRequest(
  input: CandidateReviewRequestInput
): CandidateCueId {
  if (!input.senderIsAvatar) {
    throw new Error('candidate-review motion requires the trusted Avatar sender');
  }
  if (input.mode !== 'candidate-review') {
    throw new Error('candidate-review motion is available only in candidate-review mode');
  }
  if (typeof input.rawCueId !== 'string' || !CANDIDATE_CUE_IDS.has(input.rawCueId as CandidateCueId)) {
    throw new Error('candidate-review motion requires a known semantic cue ID');
  }
  return input.rawCueId as CandidateCueId;
}
