import type { ConversationJob } from './conversation-job';
import type { PerformanceSemantic } from '../performance/semantic-performance';

export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationInputSource = 'chat' | 'desktop';
export type ConversationSource = ConversationInputSource | 'controller';

export interface ConversationMessage {
  readonly id: string;
  readonly role: ConversationRole;
  readonly text: string;
  readonly source: ConversationSource;
  readonly timestamp: number;
  readonly isMock: boolean;
  /**
   * Phase 5.1：音频优先硬门标志。
   * - user/system 消息：始终 false（不涉及音频）
   * - assistant 消息：true 表示 Adapter 返回的 wavBytes 已通过 Controller 层 WAV 校验，
   *   renderer 可以通过 audio:get-wav IPC 获取 wavBytes 并解码；false 表示无音频或校验失败，
   *   renderer 不得触发张嘴或说话动作。
   *   Phase 5.1 修复（P0-1）：audioReady=false 时仍保留并显示 assistant 正文，但禁止音频/口型/说话动作。
   * 向后兼容 Phase 4：Phase 4 的消息序列化数据无此字段，反序列化时按 false 处理。
   */
  readonly audioReady: boolean;
  /**
   * Phase 5.1 修复（P0-1）：音频错误信息。
   * - assistant 消息：audioReady=false 时，audioError 描述失败原因（如 "WAV validation failed: ..."）。
   *   renderer 显示字幕文本 + 错误提示 + "重新生成语音"按钮，不张嘴、不说话。
   * - audioReady=true 时，audioError 为 undefined。
   * - user/system 消息：始终 undefined。
   */
  readonly audioError?: string;
  /**
   * Phase 5.1 修复（P0-2）：assistant 消息关联的 taskId。
   * renderer 通过此字段调用 audioGetWav(taskId) / audioSpeak(taskId) / audioRegenerate(taskId)。
   * user/system 消息无此字段（taskId 是任务级概念，不是消息级）。
   */
  readonly taskId?: string;
  readonly semantic?: PerformanceSemantic;
}

/** 仅由主进程在校验 sender 后构造。 */
export interface ConversationSubmit {
  readonly text: string;
  readonly source: ConversationInputSource;
}

export interface ConversationSubmitResult {
  readonly accepted: boolean;
  readonly taskId?: string;
  readonly reason?: 'busy' | 'empty-text';
  readonly userMessage?: ConversationMessage;
}

/**
 * Phase 5.1 修复（P0-1）：重新生成语音结果。
 * renderer 调用 audioRegenerate(taskId) 后，主进程返回此结构。
 * - success=true：audioReady=true，wavBytes 已重新校验并缓存，renderer 可走解码流程
 * - success=false：audioReady=false，audioError 描述失败原因
 */
export interface AudioRegenerateResult {
  readonly success: boolean;
  readonly taskId: string;
  readonly audioReady: boolean;
  readonly audioError?: string;
}

/**
 * Phase 5.1：Adapter 响应回调。
 * - taskId: 对应的任务 ID
 * - text: AI 回复文本
 * - wavBytes: 可选 WAV 音频字节。Phase 4 纯文本 Adapter 不返回此字段；
 *   Phase 5.1 MockChatAdapter 返回确定性生成的 WAV ArrayBuffer。
 *   Controller 会在写入 assistant 消息前校验 WAV，校验通过才设置 audioReady=true。
 *   Phase 5.1 修复（P0-1）：校验失败时仍保留 text 作为 assistant 正文，audioReady=false。
 */
export interface AdapterResponse {
  readonly taskId: string;
  readonly text: string;
  readonly wavBytes?: ArrayBuffer;
  /** Chat5/TTS semantic metadata; never contains pack IDs, morphs, or bones. */
  readonly semantic?: PerformanceSemantic;
  readonly audioError?: string;
}

export interface ChatAdapter {
  readonly isMock: boolean;
  submit(taskId: string, userText: string): Promise<AdapterResponse>;
  cancel?(taskId: string): void;
}

/**
 * Phase 5.1 修复（P0-D）：独立语音合成 Adapter。
 *
 * 拆分原因：原 ChatAdapter.submit() 同时负责"生成回复文本"和"合成语音"。
 * 重新生成语音时若再次调用 ChatAdapter.submit(userText)，会触发完整聊天流程
 * （再次请求聊天 API、可能生成不同回复、重复触发记忆/RAG），违反"语音重试只用原 assistant 正文"的硬规则。
 *
 * VoiceAdapter 只负责 TTS 合成：输入 assistant 正文，输出 WAV 字节。
 * 不调用聊天 API、不触发记忆/RAG、不改变 assistant 文本。
 *
 * 真实实现：包装 GPT-SoVITS / Edge-TTS 等 TTS 服务。
 * Mock 实现：复用 generateMockWav 确定性生成。
 */
export interface VoiceAdapter {
  readonly isMock: boolean;
  /**
   * 合成语音。
   * @param assistantText 已保存的 assistant 回复正文（不允许使用 userText）
   * @param voiceId 可选音色 ID（多角色场景）
   * @returns WAV 字节（必须通过 wav-validator 校验）
   */
  synthesize(assistantText: string, voiceId?: string, options?: VoiceSynthesisOptions): Promise<ArrayBuffer>;
  /**
   * Optional metadata-preserving path. The emotion belongs to the same TTS
   * request that produced wavBytes, so downstream performance must prefer it
   * over a second independent text-only guess.
   */
  synthesizeDetailed?(assistantText: string, voiceId?: string, options?: VoiceSynthesisOptions): Promise<VoiceSynthesisResult>;
}

export interface VoiceSynthesisOptions {
  readonly performance?: PerformanceSemantic;
  readonly userMessage?: string;
}

export interface VoiceSynthesisResult {
  readonly wavBytes: ArrayBuffer;
  readonly emotion?: string;
  readonly duration?: number;
  /** Canonical plan returned by the same TTS request that produced wavBytes. */
  readonly performance?: Partial<PerformanceSemantic>;
}

export type ConversationEventType =
  | 'message-added'
  | 'message-updated'
  | 'task-started'
  | 'task-completed'
  | 'task-cancelled'
  | 'task-failed';

export interface ConversationEvent {
  readonly type: ConversationEventType;
  readonly message?: ConversationMessage;
  readonly taskId?: string;
  readonly reason?: string;
}

export interface ConversationHistory {
  readonly messages: readonly ConversationMessage[];
  readonly activeTask: ConversationJob | null;
}

// 保留旧 UI 类型名，值语义已经升级为 ConversationJob。
export type ConversationTask = ConversationJob;
export type ConversationTaskStatus = ConversationJob['status'];

/**
 * Phase 5.1 修复（P0-3 / P0-A）：音频表演结束原因（Avatar → 主进程 → Composer）。
 * Avatar 是唯一 AudioContext/解码器/播放时钟所有者，在以下情况下发送 performance:ended：
 * - ended：播放自然结束（sourceNode.onended）
 * - failed：AudioContext suspended、decodeAudioData 失败、sourceNode.start 失败
 * - interrupted：被新消息打断（audio:stop）、模式切换（avatar:stop-play 'mode-change'）、cancel
 */
export type AudioPlaybackState = 'ended' | 'failed';
