import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const catalogPath = join(root, 'shared-user-data', 'ChatX2Selena', 'voice-actions.json');
const motionsRoot = join(root, 'models', 'shared', 'motions');

describe('restored voice-action catalog', () => {
  it('keeps the original curated dialogue pool and materialized VMD files', () => {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      entries: Array<{ vmdPath: string }>;
    };
    const paths = new Set(catalog.entries.map(entry => entry.vmdPath));
    const fileNames = new Set(catalog.entries.map(entry => entry.vmdPath.split('/').at(-1)!));
    expect(catalog.entries.length).toBeGreaterThanOrEqual(41);
    for (const expected of [
      '../shared/motions/待机 调皮.vmd',
      '../shared/motions/哎呀呀.vmd',
      '../shared/motions/待机 双手后背.vmd',
      '../shared/motions/解释强调_左手轻摊两次后回正.vmd',
      'motions/前倾 锐利.vmd',
      'motions/思考B 循环.vmd'
    ]) {
      expect(paths.has(expected) || fileNames.has(expected.split('/').at(-1)!)).toBe(true);
      expect(existsSync(join(motionsRoot, expected.split('/').at(-1)!))).toBe(true);
    }
  });
});
