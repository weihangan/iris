import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat5PerformanceAdapter } from '../../src/conversation/chat5-performance-adapter';
import { Chat5VoiceAdapter } from '../../src/conversation/chat5-voice-adapter';

describe('Chat5PerformanceAdapter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
  });

  it('用 message 请求 Chat5，并以 TTS emotion 自动生成 semantic', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]).buffer;
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, reply: '别担心，我会陪着你。' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, audioUrl: '/api/voice/audio/a.wav', emotion: 'comfort' }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => wav });

    const voice = new Chat5VoiceAdapter({ baseUrl: 'http://127.0.0.1:3002', fetchImpl: mockFetch as any });
    const adapter = new Chat5PerformanceAdapter({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImpl: mockFetch as any,
      voiceAdapter: voice
    });
    const result = await adapter.submit('task-1', '我有点不安');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3002/api/chat',
      expect.objectContaining({ body: JSON.stringify({ message: '我有点不安' }) })
    );
    expect(result).toMatchObject({
      taskId: 'task-1',
      text: '别担心，我会陪着你。',
      semantic: { emotion: 'concerned', intent: 'concerned' }
    });
    expect(result.wavBytes).toBe(wav);
  });

  it('取消后拒绝发布迟到的 TTS 结果', async () => {
    let finishChat!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(new Promise(resolve => { finishChat = resolve; }));
    const adapter = new Chat5PerformanceAdapter({ baseUrl: 'http://127.0.0.1:3002', fetchImpl: mockFetch as any });
    const pending = adapter.submit('task-cancelled', '测试');

    adapter.cancel('task-cancelled');
    finishChat({ ok: true, json: async () => ({ success: true, reply: '迟到回复' }) });

    await expect(pending).rejects.toThrow('cancelled');
  });

  it('TTS 失败时仍返回 assistant 正文，但不返回 WAV', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, reply: '正文仍然保留。' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, errorCode: 'TTS_NOT_RUNNING', error: '语音服务未启动' })
      });

    const adapter = new Chat5PerformanceAdapter({ baseUrl: 'http://127.0.0.1:3002', fetchImpl: mockFetch as any });
    const result = await adapter.submit('task-no-audio', '测试');

    expect(result.text).toBe('正文仍然保留。');
    expect(result.wavBytes).toBeUndefined();
    expect(result.audioError).toContain('TTS_NOT_RUNNING');
  });

  it('Chat5 返回 success:true 但 reply 为空时拒绝进入 TTS/表演', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, reply: '' })
    });
    const adapter = new Chat5PerformanceAdapter({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImpl: mockFetch as any
    });

    await expect(adapter.submit('task-empty', '测试')).rejects.toThrow('empty reply');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the API performance metadata as the shared voice and avatar semantic', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]).buffer;
    const performance = {
      emotion: 'confident', intent: 'encouraging', intensity: 0.58, gaze: 'user',
      voiceEmotion: 'strong', confidence: 0.65, source: 'model' as const,
      segments: [
        { text: '这件事确实不容易。', voiceEmotion: 'sad', emotion: 'concerned', intent: 'concerned', intensity: 0.45, gaze: 'side-down', confidence: 0.65 },
        { text: '可是我会陪你把下一步做好。', voiceEmotion: 'strong', emotion: 'confident', intent: 'encouraging', intensity: 0.58, gaze: 'user', confidence: 0.65 }
      ]
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, reply: '这件事确实不容易。可是我会陪你把下一步做好。', performance }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, audioUrl: '/api/voice/audio/a.wav', emotion: 'strong' }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => wav });

    const adapter = new Chat5PerformanceAdapter({ baseUrl: 'http://127.0.0.1:3002', fetchImpl: mockFetch as any });
    const result = await adapter.submit('task-performance', '我有些不敢继续了');

    expect(result.semantic).toMatchObject({ emotion: 'confident', intent: 'encouraging', voiceEmotion: 'strong' });
    expect(result.semantic?.segments).toHaveLength(2);
    const ttsRequest = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(ttsRequest).toMatchObject({ emotion: 'strong', segments: performance.segments });
  });
});
