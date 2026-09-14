import type { ConversationInputSource } from './conversation-types';

export type ConversationJobStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/**
 * 模式无关的单轮对话任务。
 * Phase 5 会在同一个 Job 契约上扩展语音准备与表演状态。
 */
export interface ConversationJob {
  readonly taskId: string;
  status: ConversationJobStatus;
  readonly userMessageId: string;
  readonly source: ConversationInputSource;
  readonly inputText: string;
  readonly startedAt: number;
  finishedAt?: number;
}
