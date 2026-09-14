import { describe, expect, it } from 'vitest';
import {
  generateMockWav,
  hashString,
  pickFrequency,
  computeDurationMs
} from '../../src/conversation/mock-wav-generator';
import { validateWav } from '../../src/conversation/wav-validator';

// Phase 5.1 RED：确定性 Mock WAV 生成器
// 不变量：
// 1. 相同 taskId + userText → 完全相同字节
// 2. 不同 taskId → 不同字节（频率不同）
// 3. 不同 userText → 不同字节或不同长度（时长不同）
// 4. 生成的 WAV 必须通过 validateWav 12 项校验
// 5. 频率在 [150, 400] Hz 范围内
// 6. 时长 ≥ 500ms，长文本按 len*80ms 计算
describe('mock-wav-generator（Phase 5.1 确定性 WAV）', () => {
  describe('generateMockWav', () => {
    it('生成合法 WAV（通过 12 项校验）', () => {
      const wav = generateMockWav({ taskId: 'task-1', userText: '测试' });
      const result = validateWav(wav);
      expect(result.valid).toBe(true);
    });

    it('相同 taskId + userText → 完全相同字节', () => {
      const a = generateMockWav({ taskId: 'task-1', userText: '相同输入' });
      const b = generateMockWav({ taskId: 'task-1', userText: '相同输入' });
      expect(a.byteLength).toBe(b.byteLength);
      const aView = new Uint8Array(a);
      const bView = new Uint8Array(b);
      for (let i = 0; i < aView.length; i++) {
        expect(aView[i]).toBe(bView[i]);
      }
    });

    it('不同 taskId → 不同字节（频率差异）', () => {
      const a = generateMockWav({ taskId: 'task-A', userText: '相同文本' });
      const b = generateMockWav({ taskId: 'task-B', userText: '相同文本' });
      // 长度相同（userText 相同 → 时长相同），但字节不同（频率不同）
      expect(a.byteLength).toBe(b.byteLength);
      const aView = new Uint8Array(a);
      const bView = new Uint8Array(b);
      let diff = 0;
      for (let i = 0; i < aView.length; i++) {
        if (aView[i] !== bView[i]) diff++;
      }
      expect(diff).toBeGreaterThan(0);
    });

    it('不同 userText 长度 → 不同字节数（时长差异）', () => {
      const short = generateMockWav({ taskId: 'task-1', userText: '短' });
      const long = generateMockWav({ taskId: 'task-1', userText: '这是一个比较长的输入文本用于测试时长差异' });
      expect(long.byteLength).toBeGreaterThan(short.byteLength);
    });

    it('WAV header 字段正确（16-bit PCM mono 44100Hz）', () => {
      const wav = generateMockWav({ taskId: 'task-1', userText: 'header 检查' });
      const view = new DataView(wav);
      const ascii = (offset: number) => {
        let s = '';
        for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
        return s;
      };
      expect(ascii(0)).toBe('RIFF');
      expect(ascii(8)).toBe('WAVE');
      expect(ascii(12)).toBe('fmt ');
      expect(view.getUint32(16, true)).toBe(16);
      expect(view.getUint16(20, true)).toBe(1); // PCM
      expect(view.getUint16(22, true)).toBe(1); // mono
      expect(view.getUint32(24, true)).toBe(44100);
      expect(view.getUint16(34, true)).toBe(16);
      expect(ascii(36)).toBe('data');
    });
  });

  describe('hashString（FNV-1a 变体）', () => {
    it('相同输入 → 相同 hash', () => {
      expect(hashString('task-1')).toBe(hashString('task-1'));
    });

    it('不同输入 → 不同 hash（大概率）', () => {
      expect(hashString('task-1')).not.toBe(hashString('task-2'));
    });

    it('返回 32 位无符号整数', () => {
      const h = hashString('any');
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
      expect(Number.isInteger(h)).toBe(true);
    });
  });

  describe('pickFrequency', () => {
    it('返回值在 [150, 400] Hz 范围内', () => {
      for (const taskId of ['a', 'b', 'c', 'task-1', 'task-999', 'long-task-id-xyz']) {
        const f = pickFrequency(taskId);
        expect(f).toBeGreaterThanOrEqual(150);
        expect(f).toBeLessThanOrEqual(400);
      }
    });

    it('相同 taskId → 相同频率', () => {
      expect(pickFrequency('task-1')).toBe(pickFrequency('task-1'));
    });
  });

  describe('computeDurationMs', () => {
    it('空文本 → 500ms（最小值）', () => {
      expect(computeDurationMs('')).toBe(500);
    });

    it('短文本（< 6 字符）→ 500ms（最小值）', () => {
      expect(computeDurationMs('短')).toBe(500);
      expect(computeDurationMs('测试')).toBe(500);
    });

    it('长文本 → len * 80ms', () => {
      const text = '这是一个比较长的文本用于测试时长计算';
      expect(computeDurationMs(text)).toBe(text.length * 80);
    });

    it('时长 ≥ 500ms 始终成立', () => {
      for (const text of ['', 'a', '短', '这是一个比较长的文本']) {
        expect(computeDurationMs(text)).toBeGreaterThanOrEqual(500);
      }
    });
  });
});
