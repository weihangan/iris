// Phase 5.2 Task 5.2.5: LipTimeline（RED）
//
// LipTimeline 职责：
// - 从 WAV 字节提取 viseme 时间轴（Phase 5.2 用 Mock，真实提取在 Phase 5.5+）
// - 从 Adapter 返回的 visemes 直接构造时间轴（Phase 5.5+）
// - 输出 VisemeKeyframe[]，时间相对于音频开始
//
// Phase 5.2 Mock 策略：
// - 解析 WAV 获取时长（duration）
// - 每 100ms 生成一个 viseme keyframe
// - 循环 あ/い/う/え/お，权重 0.5-1.0
// - 第一帧和最后一帧权重为 0（避免突变）
//
// 硬规则：
// - 解码完成前不张嘴（Phase 5.1 硬门不变）
// - LipTimeline 优先级 > VMD morph 轨道（除非 VMD 显式包含 viseme 轨道）

import { describe, it, expect } from 'vitest';
import {
  LipTimeline,
  emptyVisemeWeights,
  type VisemeKeyframe
} from '../../src/performance/lip-timeline';
import { generateMockWav, computeDurationMs } from '../../src/conversation/mock-wav-generator';

// 辅助：生成指定时长的 Mock WAV
function generateWavWithDuration(durationSeconds: number): ArrayBuffer {
  // computeDurationMs: max(500, userText.length * 80)
  // 想要 durationSeconds 秒 → userText.length = ceil(durationSeconds * 1000 / 80)
  const charCount = Math.max(1, Math.ceil(durationSeconds * 1000 / 80));
  const userText = 'a'.repeat(charCount);
  return generateMockWav({ taskId: 'test-task', userText });
}

// 辅助：从 WAV 字节解析时长（秒）
function parseWavDuration(wav: ArrayBuffer): number {
  const view = new DataView(wav);
  // RIFF header: 4 bytes "RIFF" + 4 bytes size + 4 bytes "WAVE"
  // fmt chunk: 4 bytes "fmt " + 4 bytes size + ...
  // data chunk: 4 bytes "data" + 4 bytes size + ...
  // 简化：从字节 28 读取 sampleRate（u32 LE），从字节 22 读取 bitsPerSample（u16 LE），
  // 从字节 24 读取 channels（u16 LE）
  // 然后找 "data" chunk，读取其 size
  const sampleRate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  // 找 data chunk
  let offset = 12;
  while (offset < wav.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      const dataSize = chunkSize;
      const bytesPerSample = bitsPerSample / 8;
      const samples = dataSize / (bytesPerSample * channels);
      return samples / sampleRate;
    }
    offset += 8 + chunkSize;
  }
  return 0;
}

describe('LipTimeline', () => {
  describe('真实五口型时间轴', () => {
    it('使用 25ms 帧并输出 A/I/U/E/O/CLOSED 六状态', () => {
      const timeline = new LipTimeline();
      const frames = timeline.fromWav(generateWavWithDuration(1), '你好，欢迎回来');
      expect(frames.length).toBeGreaterThan(30);
      expect(frames[1].time - frames[0].time).toBeCloseTo(0.025, 3);
      expect(frames.every(frame => ['A', 'I', 'U', 'E', 'O', 'CLOSED'].includes(frame.viseme))).toBe(true);
    });

    it('supports compute-mode-specific analysis steps while preserving interpolation', () => {
      const timeline = new LipTimeline();
      const wav = generateWavWithDuration(1);
      const low = timeline.fromWav(wav, '啊咿呜诶哦', { frameSeconds: 0.04 });
      const ultra = timeline.fromWav(wav, '啊咿呜诶哦', { frameSeconds: 1 / 60 });

      expect(low[1].time - low[0].time).toBeCloseTo(0.04, 3);
      expect(ultra.length).toBeGreaterThan(low.length);
      const sampled = timeline.sampleAt(ultra, 0.215);
      expect(Object.values(sampled).every(Number.isFinite)).toBe(true);
    });

    it('每帧五口型总权重不超过 1，并在首尾闭嘴', () => {
      const frames = new LipTimeline().fromWav(generateWavWithDuration(1), '你好，欢迎回来');
      for (const frame of frames) {
        const total = Object.values(frame.weights).reduce((sum, value) => sum + value, 0);
        expect(total).toBeLessThanOrEqual(1.000001);
        expect(total).toBeGreaterThanOrEqual(0);
      }
      expect(frames[0].weights).toEqual(emptyVisemeWeights());
      expect(frames.at(-1)?.weights).toEqual(emptyVisemeWeights());
    });

    it('纯静音 WAV 全程 CLOSED', () => {
      const wav = generateWavWithDuration(0.8);
      const samples = new Int16Array(wav, 44);
      samples.fill(0);
      const frames = new LipTimeline().fromWav(wav, '啊咿呜诶哦');
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every(frame => frame.viseme === 'CLOSED')).toBe(true);
      expect(frames.every(frame => Object.values(frame.weights).every(value => value === 0))).toBe(true);
    });

    it('相邻口型交叉淡入，至少存在两个通道同时非零的帧', () => {
      const frames = new LipTimeline().fromWav(generateWavWithDuration(1), '啊咿呜诶哦');
      expect(frames.some(frame => Object.values(frame.weights).filter(value => value > 0.01).length >= 2)).toBe(true);
    });

    it('voiced speech reaches a clearly readable mouth-open peak', () => {
      const frames = new LipTimeline().fromWav(generateWavWithDuration(1), '啊咿呜诶哦');
      const peaks = frames.map(frame => Math.max(...Object.values(frame.weights)));
      expect(Math.max(...peaks)).toBeGreaterThanOrEqual(0.95);
      expect(peaks.filter(weight => weight > 0).every(weight => weight >= 0.24)).toBe(true);
    });

    it('sampleAt 对相邻帧做线性插值并保持归一化', () => {
      const timeline = new LipTimeline();
      const frames = timeline.fromAdapter([
        { time: 0, viseme: 'A', weights: { ...emptyVisemeWeights(), A: 1 }, morph: 'あ', weight: 1 },
        { time: 0.1, viseme: 'I', weights: { ...emptyVisemeWeights(), I: 1 }, morph: 'い', weight: 1 }
      ]);
      const sampled = timeline.sampleAt(frames, 0.05);
      expect(sampled.A).toBeCloseTo(0.5, 5);
      expect(sampled.I).toBeCloseTo(0.5, 5);
      expect(Object.values(sampled).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    });
  });

  describe('VisemeKeyframe 接口', () => {
    it('包含 time/morph/weight 字段', () => {
      const kf: VisemeKeyframe = {
        time: 0.1,
        viseme: 'A',
        weights: { ...emptyVisemeWeights(), A: 0.5 },
        morph: 'あ',
        weight: 0.5
      };
      expect(kf.time).toBe(0.1);
      expect(kf.morph).toBe('あ');
      expect(kf.weight).toBe(0.5);
    });
  });

  describe('fromWav()（Mock 实现）', () => {
    it('返回非空 VisemeKeyframe[]', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      expect(keyframes.length).toBeGreaterThan(0);
    });

    it('WAV 时长 ~1 秒 → 至少 5 个 keyframe（每 100ms 一个）', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      expect(keyframes.length).toBeGreaterThanOrEqual(5);
    });

    it('WAV 时长 ~2 秒 → 至少 15 个 keyframe', () => {
      const wav = generateWavWithDuration(2.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      expect(keyframes.length).toBeGreaterThanOrEqual(15);
    });

    it('所有 keyframe 的 morph 是 あ/い/う/え/お 之一', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      const validMorphs = ['あ', 'い', 'う', 'え', 'お'];
      for (const kf of keyframes) {
        expect(validMorphs).toContain(kf.morph);
      }
    });

    it('所有 keyframe 的 weight 在 [0, 1]', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      for (const kf of keyframes) {
        expect(kf.weight).toBeGreaterThanOrEqual(0);
        expect(kf.weight).toBeLessThanOrEqual(1);
      }
    });

    it('所有 keyframe 的 time ≥ 0', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      for (const kf of keyframes) {
        expect(kf.time).toBeGreaterThanOrEqual(0);
      }
    });

    it('keyframe 时间单调不减', () => {
      const wav = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      for (let i = 1; i < keyframes.length; i++) {
        expect(keyframes[i].time).toBeGreaterThanOrEqual(keyframes[i - 1].time);
      }
    });

    it('相同 WAV 字节 → 相同时间轴（确定性）', () => {
      const wav1 = generateWavWithDuration(1.0);
      const wav2 = generateWavWithDuration(1.0);
      const timeline = new LipTimeline();
      const kfs1 = timeline.fromWav(wav1);
      const kfs2 = timeline.fromWav(wav2);
      expect(kfs1.length).toBe(kfs2.length);
      for (let i = 0; i < kfs1.length; i++) {
        expect(kfs1[i].time).toBe(kfs2[i].time);
        expect(kfs1[i].morph).toBe(kfs2[i].morph);
        expect(kfs1[i].weight).toBe(kfs2[i].weight);
      }
    });

    it('最后一个 keyframe 的 time ≤ WAV 时长', () => {
      const wav = generateWavWithDuration(1.0);
      const duration = parseWavDuration(wav);
      const timeline = new LipTimeline();
      const keyframes = timeline.fromWav(wav);
      const last = keyframes[keyframes.length - 1];
      expect(last.time).toBeLessThanOrEqual(duration + 0.001);
    });

    it('空 WAV 字节 → 返回空数组或抛错（fail-closed）', () => {
      const timeline = new LipTimeline();
      const emptyWav = new ArrayBuffer(0);
      // 两种行为都接受：返回空数组或抛错
      try {
        const keyframes = timeline.fromWav(emptyWav);
        expect(keyframes.length).toBe(0);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    });
  });

  describe('fromAdapter()', () => {
    it('直接返回输入 visemes（Phase 5.5+ 透传）', () => {
      const timeline = new LipTimeline();
      const input: VisemeKeyframe[] = [
        { time: 0.0, viseme: 'CLOSED', weights: emptyVisemeWeights(), morph: 'あ', weight: 0.0 },
        { time: 0.1, viseme: 'A', weights: { ...emptyVisemeWeights(), A: 0.8 }, morph: 'あ', weight: 0.8 },
        { time: 0.2, viseme: 'I', weights: { ...emptyVisemeWeights(), I: 0.6 }, morph: 'い', weight: 0.6 },
        { time: 0.3, viseme: 'CLOSED', weights: emptyVisemeWeights(), morph: 'う', weight: 0.0 }
      ];
      const output = timeline.fromAdapter(input);
      expect(output.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        expect(output[i].time).toBe(input[i].time);
        expect(output[i].morph).toBe(input[i].morph);
        expect(output[i].weight).toBe(input[i].weight);
      }
    });

    it('空输入 → 空输出', () => {
      const timeline = new LipTimeline();
      const output = timeline.fromAdapter([]);
      expect(output.length).toBe(0);
    });

    it('返回新数组（不修改原数组）', () => {
      const timeline = new LipTimeline();
      const input: VisemeKeyframe[] = [
        { time: 0.0, viseme: 'A', weights: { ...emptyVisemeWeights(), A: 0.5 }, morph: 'あ', weight: 0.5 }
      ];
      const output = timeline.fromAdapter(input);
      expect(output).not.toBe(input);
      expect(input.length).toBe(1); // 原数组未变
    });
  });
});
