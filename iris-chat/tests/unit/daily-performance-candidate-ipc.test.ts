import { describe, expect, it, vi } from 'vitest';
import {
  DailyPerformanceCandidateController,
  validateCandidateCommand,
  validatePerformanceCandidateSender
} from '../../electron/daily-performance-candidate-ipc';
import type {
  DailyPerformanceCandidate,
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../../src/performance/daily-candidate-types';

const source = {
  sourceType: 'generated' as const,
  sourceUrl: 'generated://daily/gentle',
  author: 'ChatX2',
  statedTerms: 'original local candidate',
  downloadedAt: '2026-08-15T00:00:00.000Z',
  sha256: 'A'.repeat(64),
  sourceRelativePath: 'generated/gentle.vmd'
};

const motion: MotionCandidateRecord = {
  kind: 'motion',
  id: 'motion-gentle-01',
  pairId: 'expression-gentle-01',
  displayName: '温柔动作 01',
  emotion: 'gentle',
  durationSeconds: 2,
  source,
  status: 'candidate',
  dialogueSafe: false
};

const expression: ExpressionCandidateRecord = {
  kind: 'expression',
  id: 'expression-gentle-01',
  pairId: 'motion-gentle-01',
  displayName: '温柔表情 01',
  emotion: 'gentle',
  durationSeconds: 2,
  source,
  status: 'candidate',
  automatic: false,
  channelCurves: {}
};

function createController(overrides: { speechActive?: boolean } = {}) {
  const records = new Map<string, DailyPerformanceCandidate>([
    [motion.id, motion],
    [expression.id, expression]
  ]);
  const previewMotion = vi.fn();
  const previewExpression = vi.fn();
  const acceptMotion = vi.fn();
  const acceptExpression = vi.fn();
  const removeCandidate = vi.fn();
  return {
    previewMotion,
    previewExpression,
    acceptMotion,
    acceptExpression,
    removeCandidate,
    controller: new DailyPerformanceCandidateController({
      listCandidates: () => [...records.values()],
      getCandidate: id => records.get(id),
      getPair: id => {
        const pairId = records.get(id)?.pairId;
        return pairId ? records.get(pairId) : undefined;
      },
      verifySource: vi.fn(),
      isSpeechActive: () => overrides.speechActive === true,
      previewMotion,
      previewExpression,
      acceptMotion,
      acceptExpression,
      removeCandidate
    })
  };
}

describe('daily performance candidate IPC policy', () => {
  it('validates a bounded candidate ID and rejects kind mismatches', () => {
    expect(validateCandidateCommand(
      { command: 'preview-motion', id: motion.id },
      () => motion
    )).toEqual({ command: 'preview-motion', id: motion.id });
    expect(() => validateCandidateCommand(
      { command: 'accept-motion', id: expression.id },
      () => expression
    )).toThrow('candidate kind mismatch');
    expect(() => validateCandidateCommand(
      { command: 'preview-motion', id: '../outside.vmd' },
      () => motion
    )).toThrow('candidate ID');
  });

  it('accepts only the trusted chat sender', () => {
    expect(validatePerformanceCandidateSender(true)).toBeUndefined();
    expect(() => validatePerformanceCandidateSender(false)).toThrow('trusted Chat sender');
  });

  it('keeps motion, expression, and combined previews read-only', async () => {
    const fixture = createController();

    await fixture.controller.previewMotion(motion.id);
    await fixture.controller.previewExpression(expression.id);
    await fixture.controller.previewCombined(motion.id);

    expect(fixture.previewMotion).toHaveBeenCalledTimes(2);
    expect(fixture.previewExpression).toHaveBeenCalledTimes(2);
    expect(fixture.acceptMotion).not.toHaveBeenCalled();
    expect(fixture.acceptExpression).not.toHaveBeenCalled();
    expect(fixture.removeCandidate).not.toHaveBeenCalled();
  });

  it('rejects candidate previews during active speech', async () => {
    const fixture = createController({ speechActive: true });
    await expect(fixture.controller.previewMotion(motion.id)).rejects.toThrow('active speech');
    expect(fixture.previewMotion).not.toHaveBeenCalled();
  });

  it('keeps acceptance kind-specific', async () => {
    const fixture = createController();
    await fixture.controller.acceptMotion(motion.id);
    await fixture.controller.acceptExpression(expression.id);
    await expect(fixture.controller.acceptMotion(expression.id)).rejects.toThrow('candidate kind mismatch');
    expect(fixture.acceptMotion).toHaveBeenCalledTimes(1);
    expect(fixture.acceptExpression).toHaveBeenCalledTimes(1);
  });
});
