import type { AdapterResponse, ChatAdapter } from './conversation-types';
import { derivePerformanceSemantic, resolvePlaybackSemantic, type PerformanceSemantic } from '../performance/semantic-performance';
import { Chat5VoiceAdapter, type Chat5VoiceResult } from './chat5-voice-adapter';

export interface Chat5PerformanceAdapterOptions {
  baseUrl?: string;
  characterId?: string;
  fetchImpl?: typeof fetch;
  voiceAdapter?: Chat5VoiceAdapter;
  /** TTS 卡住不能阻塞文字回复；超时后保留正文并允许重新生成语音。 */
  voiceTimeoutMs?: number;
}

/**
 * Joins Chat5 text generation and Chat5.2 TTS into one ConversationController
 * adapter response. ChatX2 receives only text, WAV bytes, and semantic labels.
 */
export class Chat5PerformanceAdapter implements ChatAdapter {
  readonly isMock = false;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly voiceAdapter: Chat5VoiceAdapter;
  private readonly voiceTimeoutMs: number;
  private readonly cancelled = new Set<string>();

  constructor(options: Chat5PerformanceAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3002').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.voiceAdapter = options.voiceAdapter ?? new Chat5VoiceAdapter({
      baseUrl: this.baseUrl,
      characterId: options.characterId,
      fetchImpl: this.fetchImpl
    });
    // 文字回复优先：正常 TTS 通常在数秒内完成，超过 8 秒就先显示正文，
    // 让用户可以继续聊天并通过“重新生成语音”补音频。
    this.voiceTimeoutMs = Math.max(1000, options.voiceTimeoutMs ?? 8_000);
  }

  async submit(taskId: string, userText: string): Promise<AdapterResponse> {
    this.cancelled.delete(taskId);
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText })
    });
    const data = await response.json() as {
      success?: boolean;
      reply?: string;
      error?: string;
      performance?: Partial<PerformanceSemantic>;
    };
    this.throwIfCancelled(taskId);
    if (!response.ok || !data.success || typeof data.reply !== 'string') {
      throw new Error(`Chat5 chat failed: ${data.error ?? `HTTP ${response.status}`}`);
    }
    if (!data.reply.trim()) {
      throw new Error('Chat5 chat failed: empty reply');
    }

    const apiSemantic = resolvePlaybackSemantic(data.reply, data.performance);
    try {
      const voice: Chat5VoiceResult = await Promise.race([
        this.voiceAdapter.synthesizeDetailed(
          data.reply,
          undefined,
          { performance: apiSemantic, userMessage: userText },
        ),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`TTS timeout after ${this.voiceTimeoutMs}ms`)), this.voiceTimeoutMs);
        })
      ]);
      this.throwIfCancelled(taskId);
      // Prefer the plan returned with this exact WAV.  Older Chat5 servers do
      // not return it, so retain the previous compatibility fallback.
      const finalSemantic = voice.performance
        ? resolvePlaybackSemantic(data.reply, {
          ...apiSemantic,
          ...voice.performance,
          segments: voice.performance.segments ?? apiSemantic.segments,
        })
        : (apiSemantic.source === 'model'
          ? apiSemantic
          : (voice.emotion
            ? derivePerformanceSemantic(data.reply, voice.emotion)
            : apiSemantic));
      return {
        taskId,
        text: data.reply,
        wavBytes: voice.wavBytes,
        semantic: finalSemantic,
      };
    } catch (error) {
      this.throwIfCancelled(taskId);
      return {
        taskId,
        text: data.reply,
        semantic: apiSemantic ?? derivePerformanceSemantic(data.reply),
        audioError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  cancel(taskId: string): void {
    this.cancelled.add(taskId);
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelled.has(taskId)) {
      throw new Error(`Chat5 task ${taskId} cancelled`);
    }
  }
}
