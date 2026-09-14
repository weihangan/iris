import { describe, expect, it } from 'vitest';
import { ExpressionCandidateRegistry } from '../../src/performance/expression-candidate-registry';
import type {
  AcceptedExpressionRecord,
  ExpressionCandidateRecord
} from '../../src/performance/daily-candidate-types';

const source = {
  sourceType: 'generated' as const,
  sourceUrl: 'generated://daily/gentle',
  author: 'ChatX2',
  statedTerms: 'original local candidate',
  downloadedAt: '2026-08-15T00:00:00.000Z',
  sha256: 'A'.repeat(64),
  sourceRelativePath: 'generated/gentle.json'
};

const candidate: ExpressionCandidateRecord = {
  kind: 'expression',
  id: 'expression-gentle-01',
  displayName: '温柔表情 01',
  emotion: 'gentle',
  durationSeconds: 2,
  source,
  status: 'candidate',
  automatic: false,
  channelCurves: { eyeSmile: [{ timeSeconds: 0.5, value: 0.2 }] }
};

const accepted: AcceptedExpressionRecord = {
  ...candidate,
  id: 'expression-gentle-accepted',
  status: 'accepted',
  automatic: true,
  acceptedAt: '2026-08-15T01:00:00.000Z'
};

describe('ExpressionCandidateRegistry', () => {
  it('keeps isolated candidates and accepted automatic expressions in separate maps', () => {
    const registry = new ExpressionCandidateRegistry();
    registry.installCandidates([candidate]);
    registry.installAccepted([accepted]);

    expect(registry.getCandidate(candidate.id)).toEqual(candidate);
    expect(registry.listAccepted()).toEqual([accepted]);
    expect(registry.listCandidates().every(entry => entry.automatic === false)).toBe(true);
    expect(registry.listAccepted().every(entry => entry.automatic === true)).toBe(true);
  });

  it('returns defensive copies and rejects an automatic candidate', () => {
    const registry = new ExpressionCandidateRegistry();
    expect(() => registry.installCandidates([{ ...candidate, automatic: true } as any]))
      .toThrow('automatic=false');
    registry.installCandidates([candidate]);

    const first = registry.getCandidate(candidate.id)! as any;
    first.channelCurves.eyeSmile[0].value = 1;
    expect(registry.getCandidate(candidate.id)?.channelCurves.eyeSmile?.[0].value).toBe(0.2);
  });
});
