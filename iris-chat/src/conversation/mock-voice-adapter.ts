import type { VoiceAdapter } from './conversation-types';
import { generateMockWav } from './mock-wav-generator';

/**
 * Phase 5.1 修复（P0-D）：独立 Mock Voice Adapter。
 *
 * 仅负责 TTS 合成（assistantText → WAV 字节），不调用聊天 API、不触发记忆/RAG。
 * 用于 regenerateAudio() 重新生成语音：只接受已保存的 assistant 正文，不使用 userText。
 *
 * 与 MockChatAdapter 拆分的原因：
 * - MockChatAdapter.submit() 返回新的 assistant 文本 + WAV（模拟完整聊天往返）
 * - MockVoiceAdapter.synthesize() 只对已有 assistant 文本做 TTS（模拟纯 TTS 调用）
 * 真实实现中 VoiceAdapter 会调用 GPT-SoVITS / Edge-TTS，ChatAdapter 会调用 Chat5 API。
 */
export class MockVoiceAdapter implements VoiceAdapter {
  readonly isMock = true;
  private readonly delayMs: number;

  constructor(delayMs = 200) {
    this.delayMs = delayMs;
  }

  async synthesize(assistantText: string, _voiceId?: string): Promise<ArrayBuffer> {
    if (typeof assistantText !== 'string' || assistantText.trim().length === 0) {
      throw new Error('MockVoiceAdapter.synthesize requires non-empty assistantText');
    }
    // 模拟 TTS 网络往返延迟
    if (this.delayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, this.delayMs));
    }
    // 复用确定性 WAV 生成器：用 assistantText 决定时长和内容
    return generateMockWav({ taskId: `voice-${Date.now()}`, userText: assistantText });
  }
}
