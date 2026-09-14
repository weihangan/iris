import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcceptedSpeechExpressionStore } from '../../electron/accepted-speech-expression-store';
import type { AcceptedExpressionRecord } from '../../src/performance/daily-candidate-types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const accepted: AcceptedExpressionRecord = {
  kind: 'expression',
  id: 'expression-gentle-01',
  displayName: '温柔表情 01',
  emotion: 'gentle',
  durationSeconds: 2,
  source: {
    sourceType: 'generated',
    sourceUrl: 'generated://daily/gentle',
    author: 'ChatX2',
    statedTerms: 'original local candidate',
    downloadedAt: '2026-08-15T00:00:00.000Z',
    sha256: 'A'.repeat(64),
    sourceRelativePath: 'generated/gentle.json'
  },
  status: 'accepted',
  automatic: true,
  acceptedAt: '2026-08-15T01:00:00.000Z',
  channelCurves: {
    eyeSmile: [{ timeSeconds: 0.5, value: 0.2 }]
  }
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chatx2-accepted-expression-'));
  roots.push(root);
  return {
    path: join(root, 'accepted-speech-expressions.json'),
    store: new AcceptedSpeechExpressionStore(join(root, 'accepted-speech-expressions.json'))
  };
}

describe('AcceptedSpeechExpressionStore', () => {
  it('atomically persists automatic expressions as strict UTF-8 without BOM', () => {
    const data = fixture();
    data.store.upsert(accepted);

    const bytes = readFileSync(data.path);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
      schemaVersion: 1,
      entries: [{ id: accepted.id, automatic: true }]
    });
    expect(new AcceptedSpeechExpressionStore(data.path).list()).toEqual([accepted]);
  });

  it('returns defensive copies and rejects non-automatic entries', () => {
    const data = fixture();
    expect(() => data.store.upsert({ ...accepted, automatic: false } as any))
      .toThrow('automatic=true');
    data.store.upsert(accepted);

    const first = data.store.list()[0] as any;
    first.channelCurves.eyeSmile[0].value = 1;
    expect(data.store.list()[0].channelCurves.eyeSmile?.[0].value).toBe(0.2);
  });

  it('removes automatic use without deleting any source asset', () => {
    const data = fixture();
    data.store.upsert(accepted);
    expect(data.store.remove(accepted.id)).toBe(true);
    expect(data.store.list()).toEqual([]);
    expect(new AcceptedSpeechExpressionStore(data.path).list()).toEqual([]);
  });

  it('removes only generated daily expressions by source URL prefix', () => {
    const data = fixture();
    const generated = {
      ...accepted,
      source: {
        ...accepted.source,
        sourceUrl: 'generated://chatx2-restrained-daily-expression-v1/expression-gentle-01'
      }
    };
    const unrelated = {
      ...accepted,
      id: 'expression-unrelated',
      source: { ...accepted.source, sourceUrl: 'https://example.test/expression' }
    };
    data.store.upsert(generated);
    data.store.upsert(unrelated);

    expect(data.store.removeBySourceUrlPrefix('generated://chatx2-restrained-daily-')).toBe(1);
    expect(data.store.list().map(entry => entry.id)).toEqual(['expression-unrelated']);
    expect(new AcceptedSpeechExpressionStore(data.path).list().map(entry => entry.id))
      .toEqual(['expression-unrelated']);
  });
});
