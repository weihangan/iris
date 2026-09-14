import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('user data atomic persistence', () => {
  it('re-reads and verifies the exact UTF-8 bytes after replacement', () => {
    const { writeUtf8Atomic, writeJsonAtomic } = require('../../chat5-compat/services/atomic-persistence.js');
    const root = mkdtempSync(join(tmpdir(), 'chatx2-persistence-'));
    const textPath = join(root, 'character.md');
    const jsonPath = join(root, 'profile.json');

    expect(writeUtf8Atomic(textPath, '用户修改后的角色设定\n')).toBe(true);
    expect(readFileSync(textPath).equals(Buffer.from('用户修改后的角色设定\n', 'utf8'))).toBe(true);
    expect(writeJsonAtomic(jsonPath, { name: '赛琳娜', user_title: '指挥' })).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual({ name: '赛琳娜', user_title: '指挥' });
    expect(readFileSync(jsonPath).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });
});
