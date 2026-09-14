import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PerformancePlanner, type VmdEmotionEntry } from '../../src/performance/performance-planner';

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

const sharedEntries = readJson('models/shared/voice-actions.json').entries as VmdEmotionEntry[];
const safeEntries = sharedEntries.filter(entry => entry.dialogueSafe === true);
const safePaths = new Set(safeEntries.map(entry => normalizePath(entry.vmdPath)));

describe('automatic dialogue motion admission', () => {
  it.each([
    'models/selena-xisheng/manifest.json',
    'models/yyxuanling/manifest.json'
  ])('%s enables every user-admitted shared dialogue action', manifestPath => {
    const manifest = readJson(manifestPath);
    const enabled = new Set<string>(manifest.motions.customVmd.map(normalizePath));

    expect(safeEntries.length).toBeGreaterThan(0);
    for (const entry of safeEntries) expect(enabled.has(normalizePath(entry.vmdPath))).toBe(true);
  });

  it.each([
    ['neutral', 'explaining'],
    ['thinking', 'thinking'],
    ['concerned', 'concerned'],
    ['happy', 'inviting'],
    ['shy', 'shy'],
    ['angry', 'rejecting'],
    ['surprised', 'surprised']
  ])('returns a shared voice-pool path for %s/%s', (emotion, intent) => {
    const manifest = readJson('models/selena-xisheng/manifest.json');
    const planner = new PerformancePlanner();
    planner.updateVmdEmotionMap(sharedEntries);
    const selected = planner.plan({
      emotion,
      intent,
      speaking: true,
      enabledVmdPaths: manifest.motions.customVmd
    }).speakingVmdPath;

    if (selected) {
      const selectedEntry = sharedEntries.find(entry => normalizePath(entry.vmdPath) === normalizePath(selected));
      expect(selectedEntry).toBeDefined();
      const safeMatches = safeEntries.filter(entry => {
        const aliases = new Set([entry.intent.toLowerCase(), ...(entry.emotions ?? []).map(value => value.toLowerCase())]);
        return aliases.has(intent.toLowerCase()) || aliases.has(emotion.toLowerCase());
      });
      if (safeMatches.length > 0) expect(safePaths.has(normalizePath(selected))).toBe(true);
    }
  });
});
