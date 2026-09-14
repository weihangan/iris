import { describe, expect, it } from 'vitest';
import { validateWav } from '../../src/conversation/wav-validator';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

// Phase 5.1 RED：WAV 校验器 12 项检查
// 每项失败必须返回 valid:false + 具体 reason
// 全部通过才返回 valid:true
describe('validateWav（Phase 5.1 WAV 校验硬门）', () => {
  // 构造一个已知合法的 WAV（来自确定性生成器）
  const validWav = generateMockWav({ taskId: 'task-validator-1', userText: '校验测试' });

  it('合法 WAV 通过全部 12 项校验', () => {
    const result = validateWav(validWav);
    expect(result.valid).toBe(true);
  });

  it('字节长度 < 44 失败', () => {
    const short = new ArrayBuffer(10);
    const result = validateWav(short);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('byteLength');
    }
  });

  it('空 ArrayBuffer 失败', () => {
    const result = validateWav(new ArrayBuffer(0));
    expect(result.valid).toBe(false);
  });

  it('偏移 0 非 RIFF 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint8(0, 'X'.charCodeAt(0));
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('RIFF');
    }
  });

  it('偏移 8 非 WAVE 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint8(8, 'X'.charCodeAt(0));
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('WAVE');
    }
  });

  it('偏移 12 非 fmt 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint8(12, 'X'.charCodeAt(0));
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('fmt');
    }
  });

  it('fmt chunk size 非 16 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint32(16, 99, true);
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('fmt chunk size');
    }
  });

  it('audio format 非 PCM(1) 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint16(20, 3, true); // IEEE float
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('audio format');
    }
  });

  it('channels 非 mono(1) 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint16(22, 2, true); // stereo
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('channels');
    }
  });

  it('Chat5 GPT-SoVITS 的 32000Hz PCM WAV 通过', () => {
    const chat5Wav = validWav.slice(0);
    const view = new DataView(chat5Wav);
    view.setUint32(24, 32000, true);
    view.setUint32(28, 64000, true);
    expect(validateWav(chat5Wav)).toEqual({ valid: true });
  });

  it('不受支持的 8000Hz sample rate 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint32(24, 8000, true);
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('sample rate');
    }
  });

  it('bits per sample 非 16 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint16(34, 8, true);
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('bits per sample');
    }
  });

  it('偏移 36 非 data 失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint8(36, 'X'.charCodeAt(0));
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('data');
    }
  });

  it('declared data size 与实际不一致失败', () => {
    const broken = validWav.slice(0);
    const view = new DataView(broken);
    view.setUint32(40, 9999, true); // 错误的 data size
    const result = validateWav(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('data size');
    }
  });

  it('data size = 0 失败（仅有 header 的 WAV）', () => {
    // 构造一个 44 字节、字段全对但 data size=0 的 WAV
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };
    write(0, 'RIFF');
    view.setUint32(4, 36, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 88200, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, 0, true); // data size = 0

    const result = validateWav(buffer);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('> 0');
    }
  });
});
