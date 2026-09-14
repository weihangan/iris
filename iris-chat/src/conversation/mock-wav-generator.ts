// Phase 5.1：确定性 Mock WAV 生成器
// 职责：在主进程内生成完全确定性的 WAV 字节（相同 taskId + userText → 相同字节）
//
// 设计规则（见 docs/plans/phase-5-audio-first.md §确定性 Mock WAV 设计）：
// - 输入：taskId + userText
// - 输出：WAV ArrayBuffer（16-bit PCM mono 44100Hz）
// - 时长：max(500ms, userText.length * 80ms)
// - 频率：基于 taskId hash，150-400 Hz（模拟人声基频）
// - 波形：正弦波 + 50ms 淡入淡出包络（避免爆音）
// - 振幅：0.3（避免削波）
//
// 约束：
// - 此模块仅用于 Phase 5.1 硬门证明；Phase 5.5+ 接入真实 TTS 时不再使用
// - 生成的 WAV 必须通过 wav-validator.ts 的 12 项校验
// - 字节顺序严格按 WAV 规范（小端序）

import type { MockWavParams } from './audio-types';

const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const AMPLITUDE = 0.3;
const MIN_DURATION_MS = 500;
const MS_PER_CHAR = 80;
const FADE_MS = 50;
const MIN_FREQ = 150;
const MAX_FREQ = 400;
const FREQ_RANGE = MAX_FREQ - MIN_FREQ + 1; // 251

const HEADER_SIZE = 44;
const PCM_FORMAT = 1;
const FMT_CHUNK_SIZE = 16;
const BYTE_RATE = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
const BLOCK_ALIGN = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
const MAX_INT16 = 32767;
const MIN_INT16 = -32768;

/**
 * 基于字符串生成确定性 32 位无符号 hash（FNV-1a 变体）。
 * 相同输入 → 相同 hash。
 */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 基于 taskId hash 在 [150, 400] Hz 范围内确定正弦波频率。
 * 相同 taskId → 相同频率。
 */
export function pickFrequency(taskId: string): number {
  return MIN_FREQ + (hashString(taskId) % FREQ_RANGE);
}

/**
 * 基于 userText 长度确定时长（毫秒）。
 * - 空文本：500ms（最小值，避免零长度音频）
 * - 长文本：每字符 80ms（模拟自然说话节奏）
 */
export function computeDurationMs(userText: string): number {
  return Math.max(MIN_DURATION_MS, userText.length * MS_PER_CHAR);
}

/**
 * 计算样本 i 处的振幅包络系数（0-1）。
 * - 前 fadeSamples 个样本：线性淡入
 * - 后 fadeSamples 个样本：线性淡出
 * - 中间：1.0
 */
function envelope(sampleIndex: number, totalSamples: number, fadeSamples: number): number {
  if (sampleIndex < fadeSamples) {
    return sampleIndex / fadeSamples;
  }
  if (sampleIndex > totalSamples - fadeSamples) {
    return Math.max(0, (totalSamples - sampleIndex) / fadeSamples);
  }
  return 1;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 生成确定性 Mock WAV。
 * 相同 taskId + userText → 完全相同的 WAV 字节。
 *
 * WAV 格式：44 字节 header + 16-bit PCM mono 44100Hz data
 * - RIFF chunk: "RIFF" + chunkSize + "WAVE"
 * - fmt  chunk: "fmt " + 16 + PCM(1) + mono(1) + 44100 + 88200 + 2 + 16
 * - data chunk: "data" + dataSize + samples
 */
export function generateMockWav(params: MockWavParams): ArrayBuffer {
  const { taskId, userText } = params;
  const frequency = pickFrequency(taskId);
  const durationMs = computeDurationMs(userText);
  const totalSamples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const fadeSamples = Math.floor((FADE_MS / 1000) * SAMPLE_RATE);
  const dataSize = totalSamples * BLOCK_ALIGN;
  const bufferLength = HEADER_SIZE + dataSize;

  const buffer = new ArrayBuffer(bufferLength);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // chunkSize = 4 + (8 + 16) + (8 + dataSize)
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, FMT_CHUNK_SIZE, true); // sub-chunk size = 16
  view.setUint16(20, PCM_FORMAT, true);     // audio format = 1 (PCM)
  view.setUint16(22, NUM_CHANNELS, true);   // mono
  view.setUint32(24, SAMPLE_RATE, true);    // 44100 Hz
  view.setUint32(28, BYTE_RATE, true);      // 88200 bytes/sec
  view.setUint16(32, BLOCK_ALIGN, true);    // 2 bytes/sample
  view.setUint16(34, BITS_PER_SAMPLE, true);// 16 bits

  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM 样本：正弦波 × 振幅 × 包络，转 16-bit signed int（小端序）
  let offset = HEADER_SIZE;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = envelope(i, totalSamples, fadeSamples);
    const sample = Math.sin(2 * Math.PI * frequency * t) * AMPLITUDE * env;
    const intSample = Math.max(MIN_INT16, Math.min(MAX_INT16, Math.round(sample * MAX_INT16)));
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return buffer;
}
