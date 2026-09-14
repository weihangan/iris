import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  isPathInside,
  selectVerifiedModel,
  resolveModelAsset,
  type SelectedModel
} from '../../electron/model-selection';

const EXPECTED_SHA256 = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';
// 对应真实模型前 64 字节的伪 SHA（测试用，selectVerifiedModel 用真实模型测）

describe('model-selection（Task 5）', () => {
  describe('isPathInside', () => {
    it('子路径返回 true', () => {
      const base = 'D:\\models\\selena';
      const child = 'D:\\models\\selena\\texture.png';
      expect(isPathInside(base, child)).toBe(true);
    });

    it('等于 base 返回 true', () => {
      const base = 'D:\\models\\selena';
      expect(isPathInside(base, base)).toBe(true);
    });

    it('父目录返回 false', () => {
      const base = 'D:\\models\\selena';
      const parent = 'D:\\models';
      expect(isPathInside(base, parent)).toBe(false);
    });

    it('.. 路径返回 false', () => {
      const base = 'D:\\models\\selena';
      const outside = 'D:\\models\\selena\\..\\evil.png';
      expect(isPathInside(base, outside)).toBe(false);
    });

    it('Task 5 关键：字符串前缀相同但实际在外部返回 false', () => {
      // 旧 startsWith 实现会错误返回 true
      const base = 'D:\\models\\selena';
      const outside = 'D:\\models\\selena-evil\\texture.png';
      expect(isPathInside(base, outside)).toBe(false);
    });

    it('深层子目录返回 true', () => {
      const base = 'D:\\models\\selena';
      const deep = 'D:\\models\\selena\\sub1\\sub2\\texture.png';
      expect(isPathInside(base, deep)).toBe(true);
    });
  });

  describe('selectVerifiedModel', () => {
    let tempDir: string;
    let tempPmxPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'chat6-model-test-'));
      // 写一个假 pmx 文件（内容不影响哈希校验测试，因为我们会用错误哈希）
      tempPmxPath = join(tempDir, 'test.pmx');
      writeFileSync(tempPmxPath, Buffer.from('fake pmx content'));
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    });

    it('非 .pmx 扩展名抛错', () => {
      const txtPath = join(tempDir, 'model.txt');
      writeFileSync(txtPath, 'test');
      expect(() => selectVerifiedModel(txtPath, EXPECTED_SHA256)).toThrow(/\.pmx/i);
    });

    it('SHA-256 不匹配抛错', () => {
      expect(() =>
        selectVerifiedModel(tempPmxPath, EXPECTED_SHA256)
      ).toThrow(/unknown pmx sha-256/i);
    });

    it('SHA-256 匹配返回 SelectedModel', () => {
      // 计算真实哈希
      const { createHash } = require('node:crypto');
      const { readFileSync } = require('node:fs');
      const realHash = createHash('sha256')
        .update(readFileSync(tempPmxPath))
        .digest('hex')
        .toUpperCase();

      const result = selectVerifiedModel(tempPmxPath, realHash);
      expect(result.modelPath).toBe(tempPmxPath);
      expect(result.modelDir).toBe(tempDir);
      expect(result.sha256).toBe(realHash);
    });
  });

  describe('resolveModelAsset', () => {
    const selection: SelectedModel = {
      modelPath: 'D:\\models\\selena\\model.pmx',
      modelDir: 'D:\\models\\selena',
      sha256: 'FAKE'
    };

    it('合法相对路径返回绝对路径', () => {
      const result = resolveModelAsset(selection, 'textures\\face.png');
      expect(result).toBe('D:\\models\\selena\\textures\\face.png');
    });

    it('绝对路径返回 null', () => {
      expect(resolveModelAsset(selection, 'D:\\evil\\texture.png')).toBeNull();
    });

    it('.. 路径返回 null', () => {
      expect(resolveModelAsset(selection, '..\\evil.png')).toBeNull();
    });

    it('空字符串返回 null', () => {
      expect(resolveModelAsset(selection, '')).toBeNull();
    });

    it('空字节路径返回 null', () => {
      expect(resolveModelAsset(selection, 'te\0xt.png')).toBeNull();
    });

    it('selena-evil 前缀目录返回 null', () => {
      // 旧 startsWith 实现可能错误通过
      expect(resolveModelAsset(selection, '..\\selena-evil\\texture.png')).toBeNull();
    });
  });
});
