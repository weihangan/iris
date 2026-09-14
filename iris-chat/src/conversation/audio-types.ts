// Phase 5.1：音频优先硬门类型定义（P0-A/B/C/D + P1-E/F 修复后）
// 职责：
// - 定义 WAV 校验结果类型（Controller 层硬门）
// - 定义 Mock WAV 生成参数（确定性生成器输入）
// - 定义 WAV 缓存条目（主进程 Map<taskId, WavCacheEntry>，含 TTL）
// - 定义表演结束原因（Avatar → 主进程 → Composer）
//
// 约束（P0 修复后）：
// - WAV 字节只在主进程生成和校验，Avatar 通过主进程转发的 avatar:play(taskId, wavBytes) 收到
// - WAV 校验失败 / 缺失 wavBytes 时仍写 assistant 消息（audioReady=false, audioError, 正文保留），
//   task 标记 completed（项目硬规则：TTS 失败时保留正文但禁止音频/口型/说话动作）
// - WAV 缓存按 taskId 绑定，TTL 5 分钟兜底；releaseWav / releaseAllWav / cleanupExpiredWav 统一管理

/**
 * WAV 校验结果（discriminated union）
 * - { valid: true }：校验通过，Controller 写入 assistant 消息(audioReady=true) 并缓存 wavBytes
 * - { valid: false, reason }：校验失败，Controller 仍写 assistant 消息(audioReady=false, audioError, 正文保留)
 */
export type WavValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Mock WAV 生成参数
 * - taskId：任务 ID（用于确定性 hash）
 * - userText：用户输入文本（用于确定时长）
 */
export interface MockWavParams {
  readonly taskId: string;
  readonly userText: string;
}

/**
 * WAV 缓存条目（主进程内存）
 * - taskId：任务 ID（索引键）
 * - wavBytes：WAV 字节（主进程转发给 Avatar 用于 decodeAudioData）
 * - assistantText：assistant 回复正文（P0-D 修复后：用于 regenerateAudio 重新合成语音，不存 userText/adapter）
 * - createdAt：创建时间戳（用于 TTL 过期清理，默认 5 分钟）
 * - messageId：对应的 assistant 消息 ID（用于校验一致性）
 */
export interface WavCacheEntry {
  readonly taskId: string;
  readonly wavBytes: ArrayBuffer;
  readonly assistantText: string;
  readonly createdAt: number;
  readonly messageId: string;
}

/**
 * 表演结束原因（Avatar → 主进程 → Composer，P0-A/B/C 修复后）
 * - 'ended'：自然播放结束（sourceNode.onended 触发）
 * - 'failed'：解码或播放失败（包括 AudioContext suspended 无法恢复）
 * - 'interrupted'：被新消息打断、模式切换、用户取消、窗口隐藏、crash 等
 *
 * Avatar 在所有这些路径上统一调用 stopPerformance(reason) 并发送 performance:ended(taskId, reason)。
 * Composer 收到后隐藏字幕 + 清除 __composerSpeaking。
 * 主进程收到后调用 releaseWav(taskId) 释放缓存。
 */
export type PerformanceEndReason = 'ended' | 'failed' | 'interrupted';
