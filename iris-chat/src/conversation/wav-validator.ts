// Phase 5.1：WAV 格式校验（Controller 层硬门）
// 职责：校验 ArrayBuffer 是否符合受控采样率的 16-bit PCM mono WAV 格式
//
// 设计原则：
// - 纯函数，无副作用，可在主进程和测试环境运行
// - 校验失败时返回具体原因，便于调试
// - 12 项校验全部通过才返回 valid: true
// - 此校验独立于 Mock WAV 生成器，未来真实 TTS 也用同一校验
//
// 校验规则（见 docs/plans/phase-5-audio-first.md §WAV 校验规则）：
// 1. 字节长度 ≥ 44（header 长度）
// 2. 偏移 0-3: "RIFF"
// 3. 偏移 8-11: "WAVE"
// 4. 偏移 12-15: "fmt "
// 5. 偏移 16-19: 16（PCM fmt chunk size）
// 6. 偏移 20-21: 1（PCM format）
// 7. 偏移 22-23: 1（mono）
// 8. 偏移 24-27: 常用语音采样率白名单（含 Chat5 GPT-SoVITS 的 32000Hz）
// 9. 偏移 34-35: 16（bits per sample）
// 10. 偏移 36-39: "data"
// 11. 偏移 40-43: data size（= bytes.length - 44）
// 12. data size > 0

import type { WavValidationResult } from './audio-types';

const HEADER_SIZE = 44;
const FMT_CHUNK_SIZE = 16;
const PCM_FORMAT = 1;
const MONO_CHANNELS = 1;
const SUPPORTED_SAMPLE_RATES = new Set([16000, 22050, 24000, 32000, 44100, 48000]);
const BITS_PER_SAMPLE = 16;

function readAscii(view: DataView, offset: number, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

/**
 * 校验 ArrayBuffer 是否为合法的 16-bit PCM mono WAV。
 * 校验通过返回 { valid: true }；任一失败返回 { valid: false, reason }。
 */
export function validateWav(bytes: ArrayBuffer): WavValidationResult {
  if (!bytes || bytes.byteLength < HEADER_SIZE) {
    return { valid: false, reason: `byteLength ${bytes?.byteLength ?? 0} < header size ${HEADER_SIZE}` };
  }

  const view = new DataView(bytes);

  // 1. RIFF marker
  if (readAscii(view, 0, 4) !== 'RIFF') {
    return { valid: false, reason: `offset 0: expected "RIFF", got "${readAscii(view, 0, 4)}"` };
  }

  // 2. WAVE marker
  if (readAscii(view, 8, 4) !== 'WAVE') {
    return { valid: false, reason: `offset 8: expected "WAVE", got "${readAscii(view, 8, 4)}"` };
  }

  // 3. fmt marker
  if (readAscii(view, 12, 4) !== 'fmt ') {
    return { valid: false, reason: `offset 12: expected "fmt ", got "${readAscii(view, 12, 4)}"` };
  }

  // 4. fmt chunk size = 16
  const fmtSize = view.getUint32(16, true);
  if (fmtSize !== FMT_CHUNK_SIZE) {
    return { valid: false, reason: `offset 16: fmt chunk size expected ${FMT_CHUNK_SIZE}, got ${fmtSize}` };
  }

  // 5. PCM format
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== PCM_FORMAT) {
    return { valid: false, reason: `offset 20: audio format expected PCM (${PCM_FORMAT}), got ${audioFormat}` };
  }

  // 6. mono
  const channels = view.getUint16(22, true);
  if (channels !== MONO_CHANNELS) {
    return { valid: false, reason: `offset 22: channels expected mono (${MONO_CHANNELS}), got ${channels}` };
  }

  // 7. 受控 sample rate（Electron AudioContext 会在解码时重采样）
  const sampleRate = view.getUint32(24, true);
  if (!SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
    return {
      valid: false,
      reason: `offset 24: unsupported sample rate ${sampleRate}; expected one of ${[...SUPPORTED_SAMPLE_RATES].join(', ')}`
    };
  }

  // 8. bits per sample = 16
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== BITS_PER_SAMPLE) {
    return { valid: false, reason: `offset 34: bits per sample expected ${BITS_PER_SAMPLE}, got ${bitsPerSample}` };
  }

  // 9. data marker
  if (readAscii(view, 36, 4) !== 'data') {
    return { valid: false, reason: `offset 36: expected "data", got "${readAscii(view, 36, 4)}"` };
  }

  // 10. data size 一致性
  const declaredDataSize = view.getUint32(40, true);
  const actualDataSize = bytes.byteLength - HEADER_SIZE;
  if (declaredDataSize !== actualDataSize) {
    return { valid: false, reason: `offset 40: declared data size ${declaredDataSize} != actual ${actualDataSize}` };
  }

  // 11. data size > 0
  if (declaredDataSize <= 0) {
    return { valid: false, reason: `data size must be > 0, got ${declaredDataSize}` };
  }

  return { valid: true };
}
