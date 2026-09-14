import { describe, expect, it } from 'vitest';
import { validateCandidateReviewRequest } from '../../electron/candidate-review-ipc-policy';

describe('validateCandidateReviewRequest', () => {
  it.each([
    'disagree-small',
    'acknowledge-small',
    'thinking-small',
    'realization-small',
    'giggle-small',
    'shy-head-scratch'
  ])('accepts the known semantic cue %s from the Avatar in candidate-review mode', cueId => {
    expect(validateCandidateReviewRequest({
      senderIsAvatar: true,
      mode: 'candidate-review',
      rawCueId: cueId
    })).toBe(cueId);
  });

  it('rejects non-Avatar senders', () => {
    expect(() => validateCandidateReviewRequest({
      senderIsAvatar: false,
      mode: 'candidate-review',
      rawCueId: 'thinking-small'
    })).toThrow('Avatar sender');
  });

  it('rejects production mode', () => {
    expect(() => validateCandidateReviewRequest({
      senderIsAvatar: true,
      mode: 'production',
      rawCueId: 'thinking-small'
    })).toThrow('candidate-review mode');
  });

  it.each([
    'unknown-cue',
    '',
    null,
    undefined,
    { cueId: 'thinking-small' },
    { path: 'D:/motions/thinking.vmd' },
    { packId: 'candidate-review-thinking-small' },
    { morph: '笑い' },
    { bone: '上半身' }
  ])('rejects non-semantic or structured input %#', rawCueId => {
    expect(() => validateCandidateReviewRequest({
      senderIsAvatar: true,
      mode: 'candidate-review',
      rawCueId
    })).toThrow('known semantic cue ID');
  });
});
