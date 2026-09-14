import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DailyPerformanceCandidateStore } from '../../electron/daily-performance-candidate-store';
import type {
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../../src/performance/daily-candidate-types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chatx2-daily-candidates-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  const bytes = new Uint8Array([0x56, 0x6f, 0x63, 0x61, 0x6c]);
  writeFileSync(join(sourceRoot, 'gentle.vmd'), bytes);
  const source = {
    sourceType: 'online' as const,
    sourceUrl: 'https://example.test/gentle',
    author: 'fixture author',
    statedTerms: 'personal test only',
    downloadedAt: '2026-08-15T00:00:00.000Z',
    sha256: sha256(bytes),
    sourceRelativePath: 'gentle.vmd'
  };
  const audit = {
    policyVersion: 'daily-performance-candidate-audit-v1',
    sourceSha256: source.sha256,
    accepted: true,
    reasons: [],
    auditedAt: '2026-08-15T00:05:00.000Z',
    metrics: { durationSeconds: 2.4 }
  } as const;
  const motion: MotionCandidateRecord = {
    kind: 'motion',
    id: 'motion-gentle-01',
    pairId: 'expression-gentle-01',
    displayName: '温柔动作 01',
    emotion: 'gentle',
    durationSeconds: 2.4,
    source,
    audit,
    status: 'candidate',
    dialogueSafe: false
  };
  const expression: ExpressionCandidateRecord = {
    kind: 'expression',
    id: 'expression-gentle-01',
    pairId: 'motion-gentle-01',
    displayName: '温柔表情 01',
    emotion: 'gentle',
    durationSeconds: 2.4,
    source,
    audit,
    status: 'candidate',
    automatic: false,
    channelCurves: {
      mouthSmileLeft: [
        { timeSeconds: 0, value: 0 },
        { timeSeconds: 0.4, value: 0.25 },
        { timeSeconds: 2.4, value: 0 }
      ]
    }
  };
  return {
    root,
    sourceRoot,
    catalogPath: join(root, 'performance-candidates.json'),
    bytes,
    motion,
    expression
  };
}

describe('DailyPerformanceCandidateStore', () => {
  it('persists motion and expression records separately while preserving their pair', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });

    store.replaceAll([data.motion, data.expression]);

    expect(store.resolveVerifiedSourcePath(data.motion.id)).toBe(join(data.sourceRoot, 'gentle.vmd'));

    const reloaded = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });
    expect(reloaded.list('motion')).toEqual([data.motion]);
    expect(reloaded.list('expression')).toEqual([data.expression]);
    expect(reloaded.getPair(data.motion.id)).toEqual(data.expression);
    expect(reloaded.getPair(data.expression.id)).toEqual(data.motion);
  });

  it('writes strict UTF-8 without BOM and reads the exact schema back', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });
    store.replaceAll([{ ...data.motion, pairId: undefined }]);

    const bytes = readFileSync(data.catalogPath);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
      schemaVersion: 1,
      entries: [{ id: data.motion.id, dialogueSafe: false }]
    });
  });

  it('rejects traversal paths and changed source bytes', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });

    expect(() => store.replaceAll([{
      ...data.motion,
      source: { ...data.motion.source, sourceRelativePath: '../outside.vmd' }
    }])).toThrow('outside candidate source root');

    store.replaceAll([{ ...data.motion, pairId: undefined }]);
    writeFileSync(join(data.sourceRoot, 'gentle.vmd'), new Uint8Array([9]));
    expect(() => store.verifySource(data.motion.id)).toThrow('SHA-256 mismatch');
  });

  it('rejects duplicate IDs and one-sided or inconsistent pair links', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });

    expect(() => store.replaceAll([data.motion, data.motion])).toThrow('duplicate candidate ID');
    expect(() => store.replaceAll([data.motion])).toThrow('missing paired candidate');
    expect(() => store.replaceAll([
      data.motion,
      { ...data.expression, pairId: 'another-motion' }
    ])).toThrow('pair link mismatch');
  });

  it('updates or removes only the selected candidate while preserving its pair', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });
    store.replaceAll([data.motion, data.expression]);

    store.setStatus(data.motion.id, 'accepted');
    expect(store.get(data.motion.id)?.status).toBe('accepted');
    expect(store.get(data.expression.id)?.status).toBe('candidate');

    expect(store.remove(data.motion.id)).toBe(true);
    expect(store.get(data.motion.id)).toBeUndefined();
    expect(store.get(data.expression.id)?.pairId).toBeUndefined();
  });

  it('lists only candidate records with an accepted audit bound to the unchanged source SHA', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });
    const { audit: _missingAudit, ...motionWithoutAudit } = data.motion;
    const missingAudit: MotionCandidateRecord = {
      ...motionWithoutAudit,
      id: 'motion-missing-audit',
      pairId: undefined
    };
    store.replaceAll([
      { ...data.motion, pairId: undefined },
      missingAudit,
      {
        ...data.motion,
        id: 'motion-rejected-audit',
        pairId: undefined,
        audit: { ...data.motion.audit!, accepted: false, reasons: ['large-leg-lift'] }
      },
      {
        ...data.motion,
        id: 'motion-wrong-audit-sha',
        pairId: undefined,
        audit: { ...data.motion.audit!, sourceSha256: 'F'.repeat(64) }
      },
      { ...data.expression, pairId: undefined, status: 'accepted' }
    ]);

    expect(store.listReviewable().map(record => record.id)).toEqual([data.motion.id]);
    expect(store.listReviewable('expression')).toEqual([]);
    expect(store.getReviewable(data.motion.id)?.id).toBe(data.motion.id);
    expect(store.getReviewable('motion-rejected-audit')).toBeUndefined();

    writeFileSync(join(data.sourceRoot, 'gentle.vmd'), new Uint8Array([9]));
    expect(store.listReviewable()).toEqual([]);
    expect(store.getReviewable(data.motion.id)).toBeUndefined();
  });

  it('removes only generated daily candidates by source URL prefix', () => {
    const data = fixture();
    const store = new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    });
    const generated = {
      ...data.motion,
      id: 'motion-generated-daily',
      pairId: undefined,
      source: { ...data.motion.source, sourceUrl: 'generated://chatx2-restrained-daily-motion-v1/motion-generated-daily' }
    };
    const unrelated = {
      ...data.motion,
      id: 'motion-unrelated',
      pairId: undefined,
      source: { ...data.motion.source, sourceUrl: 'https://example.test/unrelated' }
    };
    store.replaceAll([generated, unrelated]);

    expect(store.removeBySourceUrlPrefix('generated://chatx2-restrained-daily-')).toBe(1);
    expect(store.get(generated.id)).toBeUndefined();
    expect(store.get(unrelated.id)).toEqual(unrelated);
    expect(new DailyPerformanceCandidateStore({
      catalogPath: data.catalogPath,
      sourceRoot: data.sourceRoot
    }).get(unrelated.id)).toEqual(unrelated);
  });
});
