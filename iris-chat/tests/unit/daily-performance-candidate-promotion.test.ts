import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptedSpeechExpressionStore } from '../../electron/accepted-speech-expression-store';
import { DailyPerformanceCandidatePromotionService } from '../../electron/daily-performance-candidate-promotion';
import { DailyPerformanceCandidateStore } from '../../electron/daily-performance-candidate-store';
import type {
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../../src/performance/daily-candidate-types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chatx2-candidate-promotion-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  const bytes = new Uint8Array([0x56, 0x4d, 0x44]);
  writeFileSync(join(sourceRoot, 'gentle.vmd'), bytes);
  const source = {
    sourceType: 'generated' as const,
    sourceUrl: 'generated://daily/gentle',
    author: 'ChatX2',
    statedTerms: 'original local candidate',
    downloadedAt: '2026-08-15T00:00:00.000Z',
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    sourceRelativePath: 'gentle.vmd'
  };
  const motion: MotionCandidateRecord = {
    kind: 'motion', id: 'motion-gentle-01', pairId: 'expression-gentle-01',
    displayName: '温柔动作 01', emotion: 'gentle', durationSeconds: 2,
    source, status: 'candidate', dialogueSafe: false
  };
  const expression: ExpressionCandidateRecord = {
    kind: 'expression', id: 'expression-gentle-01', pairId: 'motion-gentle-01',
    displayName: '温柔表情 01', emotion: 'gentle', durationSeconds: 2,
    source, status: 'candidate', automatic: false,
    channelCurves: { eyeSmile: [{ timeSeconds: 0.5, value: 0.2 }] }
  };
  const candidates = new DailyPerformanceCandidateStore({
    catalogPath: join(root, 'performance-candidates.json'),
    sourceRoot
  });
  candidates.replaceAll([motion, expression]);
  const expressions = new AcceptedSpeechExpressionStore(join(root, 'accepted-speech-expressions.json'));
  const addVoiceAction = vi.fn(() => true);
  const removeVoiceActionReference = vi.fn(() => true);
  const service = new DailyPerformanceCandidatePromotionService({
    candidates,
    expressions,
    installMotionSource: () => '../shared/motions/candidate-gentle.vmd',
    addVoiceAction,
    removeVoiceActionReference
  });
  return { candidates, expressions, motion, expression, addVoiceAction, removeVoiceActionReference, service };
}

describe('DailyPerformanceCandidatePromotionService', () => {
  it('accepts a motion without accepting its paired expression', async () => {
    const data = fixture();
    await data.service.acceptMotion(data.motion.id);

    expect(data.addVoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      vmdPath: '../shared/motions/candidate-gentle.vmd',
      type: 'voice',
      dialogueSafe: true,
      emotions: ['gentle']
    }));
    expect(data.expressions.list()).toEqual([]);
    expect(data.candidates.get(data.motion.id)?.status).toBe('accepted');
    expect(data.candidates.get(data.expression.id)?.status).toBe('candidate');
  });

  it('accepts an expression without accepting its paired motion', async () => {
    const data = fixture();
    await data.service.acceptExpression(data.expression.id, '2026-08-15T01:00:00.000Z');

    expect(data.expressions.list()).toEqual([
      expect.objectContaining({
        id: data.expression.id,
        status: 'accepted',
        automatic: true,
        acceptedAt: '2026-08-15T01:00:00.000Z'
      })
    ]);
    expect(data.addVoiceAction).not.toHaveBeenCalled();
    expect(data.candidates.get(data.motion.id)?.status).toBe('candidate');
    expect(data.candidates.get(data.expression.id)?.status).toBe('accepted');
  });

  it('does not mark a motion accepted when the formal voice action write fails', async () => {
    const data = fixture();
    data.addVoiceAction.mockReturnValue(false);

    await expect(data.service.acceptMotion(data.motion.id)).rejects.toThrow('voice action');
    expect(data.candidates.get(data.motion.id)?.status).toBe('candidate');
    expect(data.expressions.list()).toEqual([]);
  });
});
