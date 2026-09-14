import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const projectRoot = resolve(__dirname, '..', '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(script: string, args: string[]): void {
  execFileSync(process.execPath, [resolve(projectRoot, 'scripts', script), ...args], {
    cwd: projectRoot,
    stdio: 'pipe'
  });
}

describe('daily performance candidate generators', () => {
  it('builds four independently paired motion/expression candidates per emotion and audits every source', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-generated-daily-'));
    roots.push(root);
    const sourceRoot = join(root, 'sources');
    const motions = join(root, 'motions.json');
    const expressions = join(root, 'expressions.json');
    const catalog = join(root, 'catalog.json');
    const audit = join(root, 'audit.json');

    run('generate-daily-motion-candidates.mjs', [
      '--source-root', sourceRoot, '--manifest', motions
    ]);
    run('generate-daily-expression-candidates.mjs', [
      '--source-root', sourceRoot, '--motion-manifest', motions, '--manifest', expressions
    ]);
    run('seed-daily-performance-candidates.mjs', [
      '--catalog', catalog,
      '--motion-manifest', motions,
      '--expression-manifest', expressions
    ]);
    run('audit-daily-performance-candidates.mjs', [
      '--catalog', catalog,
      '--source-root', sourceRoot,
      '--out', audit,
      '--write-catalog'
    ]);

    const records = JSON.parse(readFileSync(catalog, 'utf8')).entries as Array<Record<string, any>>;
    const report = JSON.parse(readFileSync(audit, 'utf8'));
    expect(records).toHaveLength(56);
    expect(report).toMatchObject({ candidateCount: 56, acceptedCount: 56, rejectedCount: 0 });
    for (const emotion of ['gentle', 'happy', 'explaining', 'curious', 'thinking', 'grateful', 'apologetic']) {
      expect(records.filter(record => record.kind === 'motion' && record.emotion === emotion)).toHaveLength(4);
      expect(records.filter(record => record.kind === 'expression' && record.emotion === emotion)).toHaveLength(4);
    }
    for (const record of records) {
      expect(record.status).toBe('candidate');
      expect(record.audit).toMatchObject({
        policyVersion: 'daily-performance-candidate-audit-v1',
        sourceSha256: record.source.sha256,
        accepted: true,
        reasons: []
      });
      const pair = records.find(candidate => candidate.id === record.pairId);
      expect(pair?.pairId).toBe(record.id);
      expect(pair?.kind).not.toBe(record.kind);
    }
    const motionAudits = report.candidates.filter((candidate: any) => candidate.kind === 'motion');
    expect(Math.min(...motionAudits.map((candidate: any) => candidate.audit.metrics.activeBoneTrackCount)))
      .toBeGreaterThanOrEqual(1);
    expect(Math.max(...motionAudits.map((candidate: any) => candidate.audit.metrics.rootTranslationMax))).toBe(0);
    expect(Math.max(...motionAudits.map((candidate: any) => candidate.audit.metrics.centerTranslationMax))).toBe(0);
    expect(Math.max(...motionAudits.map((candidate: any) => candidate.audit.metrics.maximumLegLift))).toBe(0);
    expect(Math.max(...motionAudits.map((candidate: any) => candidate.audit.metrics.maximumKneeBendDegrees))).toBe(0);
    expect(Math.max(...motionAudits.map((candidate: any) => candidate.audit.metrics.maximumBoneStep)))
      .toBeLessThanOrEqual(0.22);
  });
});
