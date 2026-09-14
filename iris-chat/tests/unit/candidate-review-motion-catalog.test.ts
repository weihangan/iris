import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_REVIEW_MOTION_ENTRIES,
  CandidateReviewMotionCatalog,
  type CandidateReviewMotionDefinition
} from '../../electron/candidate-review-motion-catalog';

const expectedHashes = {
  'disagree-small': 'EFAC4ADDEE2E6118426867F8E6573BD4510508CDED6825A3684850CD902156F0',
  'acknowledge-small': '372F8B475CB476BC9CF03DCEF36DBE049015DF1F1B7F9E6ECC51CB0DD65BE2E4',
  'thinking-small': '8ED4D4F0248CA685A6B3F968A17C7429DAD257AD946612B020ACAFA046E18FDD',
  'realization-small': '84FE33F8AD5AEE81930DC1692E57471A6B6D3743E99F54F1CF78E5F95C5B6B46',
  'giggle-small': '208E3E0F1199EB4C6716CF5A7126AA07E954A314582AD1A401E3BBF49CE81C0F',
  'shy-head-scratch': 'DF517D1BFC0F93C9C8C2822FC9F83562B38EFB9350125A657A7C050FE553C8DA'
  , 'thinking-deep': '5BFA1CED0645320AAD8AFB29D37F85E3F7CD855507C30900447C0054DF91C39E'
  , 'shy-glance': 'B2BD1D890D7658B105D3FF54D70DF6BCD6FD2197FF4B587CDCE119AA21A7A73B'
  , 'inviting-gesture': '234FA649067AB69A762F9F7DB1C6C9A2FA69E3B3792B3EF4F6BA9E8165CEBDE9'
  , 'thanks-sincere': '886EFF4FD26FB7B8E08786675EB07EBA7D7FCF67EEE8E488E27E6AE272A5DE65'
  , 'explaining-gesture': 'F61BFE6259DC38DA7A6372355DAA0AE1DA05FAF86ACCDFF008CA16DD95E5C7BA'
  , 'explaining-emphasis': 'B8994CEFA7AF12D3E08C63750C94E00C7E1825A993CDA418E236159F7C5FF594'
  , 'depressed-low': '26C09225BF53ADD72B756BFB498319FBB20E7DC9B802CEB0A67D64D3E60D3603'
  , 'surprised-gasp': 'FFEDDDC1AF2AE618F3AA4F199BB02575562F6062A886F1125D58D8EF926E2C84'
  , 'rejection-block': '35DBD125EEBF5C37CF74FD7888183E74DA794BC659AA23F4AC0AF964C9F43946'
} as const;

const tempRoots: string[] = [];

afterEach(() => {
  tempRoots.length = 0;
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function createFixture(options?: {
  mode?: 'production' | 'candidate-review';
  bytes?: Uint8Array;
  sha?: string;
  assetPath?: string;
  writeAsset?: boolean;
}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'chatx2-candidate-catalog-'));
  tempRoots.push(projectRoot);
  const allowedRoot = join(projectRoot, 'temp', 'motion-candidates', 'fixture');
  const bytes = options?.bytes ?? new Uint8Array([1, 2, 3, 4]);
  const assetPath = options?.assetPath ?? join(allowedRoot, 'motion.vmd');
  if (options?.writeAsset !== false) {
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, bytes);
  }
  const definition: CandidateReviewMotionDefinition = {
    cueId: 'thinking-small',
    packId: 'candidate-review-thinking-small',
    absolutePath: assetPath,
    sha256: options?.sha ?? sha256(bytes),
    durationSeconds: 1.567,
    candidateTrackPolicy: 'dialogue-body-only',
    looping: false,
    fadeInSeconds: 0.35,
    fadeOutSeconds: 0.55
  };
  const warn = vi.fn();
  const catalog = new CandidateReviewMotionCatalog({
    mode: options?.mode ?? 'candidate-review',
    allowedRoots: [allowedRoot],
    definitions: [definition],
    warn
  });
  return { catalog, definition, warn, bytes, allowedRoot, projectRoot };
}

describe('CandidateReviewMotionCatalog', () => {
  it('locks all approved semantic cues to the audited SHA-256 values', () => {
    expect(CANDIDATE_REVIEW_MOTION_ENTRIES).toHaveLength(15);
    expect(Object.fromEntries(CANDIDATE_REVIEW_MOTION_ENTRIES.map(entry => [entry.cueId, entry.sha256])))
      .toEqual(expectedHashes);
    expect(CANDIDATE_REVIEW_MOTION_ENTRIES.every(entry =>
      entry.candidateTrackPolicy === 'dialogue-body-only'
      && entry.looping === false
      && entry.fadeInSeconds >= 0.35
      && entry.fadeOutSeconds >= 0.35
    )).toBe(true);
  });

  it('loads and returns defensive copies of a SHA-valid candidate', async () => {
    const { catalog, bytes } = createFixture();
    const first = await catalog.load('thinking-small');
    expect(first).toMatchObject({
      cueId: 'thinking-small',
      looping: false,
      candidateTrackPolicy: 'dialogue-body-only',
      fadeInSeconds: 0.35,
      fadeOutSeconds: 0.55
    });
    expect(Array.from(first?.bytes ?? [])).toEqual(Array.from(bytes));
    if (!first) throw new Error('fixture candidate did not load');
    first.bytes[0] = 255;
    const second = await catalog.load('thinking-small');
    expect(second?.bytes[0]).toBe(bytes[0]);
  });

  it('rejects production mode before reading a candidate file', async () => {
    const readFile = vi.fn(() => { throw new Error('must not read'); });
    const { definition, allowedRoot } = createFixture({ mode: 'production' });
    const catalog = new CandidateReviewMotionCatalog({
      mode: 'production',
      allowedRoots: [allowedRoot],
      definitions: [definition],
      readFile
    });
    await expect(catalog.load('thinking-small')).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects an unknown semantic cue without scanning for a fallback', async () => {
    const { catalog, warn } = createFixture();
    await expect(catalog.load('not-a-cue' as never)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails closed and logs once when SHA verification fails', async () => {
    const { catalog, warn } = createFixture({ sha: '0'.repeat(64) });
    await expect(catalog.load('thinking-small')).resolves.toBeNull();
    await expect(catalog.load('thinking-small')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SHA-256 mismatch');
  });

  it('fails closed when the candidate file is missing', async () => {
    const { catalog, warn } = createFixture({ writeAsset: false });
    await expect(catalog.load('thinking-small')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a definition whose path escapes all allowed roots', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'chatx2-candidate-outside-'));
    tempRoots.push(projectRoot);
    const allowedRoot = join(projectRoot, 'allowed');
    const outside = join(projectRoot, 'outside.vmd');
    const bytes = new Uint8Array([8, 9, 10]);
    mkdirSync(allowedRoot, { recursive: true });
    writeFileSync(outside, bytes);
    const warn = vi.fn();
    const catalog = new CandidateReviewMotionCatalog({
      mode: 'candidate-review',
      allowedRoots: [allowedRoot],
      definitions: [{
        cueId: 'thinking-small',
        packId: 'candidate-review-thinking-small',
        absolutePath: outside,
        sha256: sha256(bytes),
        durationSeconds: 1,
        candidateTrackPolicy: 'dialogue-body-only',
        looping: false,
        fadeInSeconds: 0.35,
        fadeOutSeconds: 0.55
      }],
      warn
    });
    await expect(catalog.load('thinking-small')).resolves.toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('outside allowed motion roots');
  });
});
