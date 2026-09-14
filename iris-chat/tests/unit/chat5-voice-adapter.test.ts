import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat5VoiceAdapter } from '../../src/conversation/chat5-voice-adapter';
import type { VoiceAdapter } from '../../src/conversation/conversation-types';

describe('Chat5VoiceAdapter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
  });

  it('调用 Chat5 /api/voice/speak，并下载返回的 WAV 与实际 emotion', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]).buffer;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, audioUrl: '/api/voice/audio/a.wav', emotion: 'comfort' })
      })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => wav });

    const adapter = new Chat5VoiceAdapter({ baseUrl: 'http://127.0.0.1:3002', characterId: '2' });
    const contract: VoiceAdapter = adapter;
    const result = await adapter.synthesizeDetailed('别担心，我会陪着你');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3002/api/voice/speak',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('别担心') })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3002/api/voice/audio/a.wav');
    expect(result.emotion).toBe('comfort');
    expect(new Uint8Array(result.wavBytes)).toEqual(new Uint8Array(wav));
    expect(contract.synthesizeDetailed).toBeTypeOf('function');
  });

  it('Chat5 返回失败时抛出可诊断错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, errorCode: 'TTS_NOT_RUNNING', error: '语音服务未启动' })
    });

    const adapter = new Chat5VoiceAdapter({ baseUrl: 'http://127.0.0.1:3002' });
    await expect(adapter.synthesizeDetailed('测试语音')).rejects.toThrow('TTS_NOT_RUNNING');
  });

  it('passes the chat model performance root signal to TTS instead of requesting auto detection', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]).buffer;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, audioUrl: '/api/voice/audio/a.wav', emotion: 'strong' })
      })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => wav });

    const adapter = new Chat5VoiceAdapter({ baseUrl: 'http://127.0.0.1:3002', fetchImpl: mockFetch as any });
    await adapter.synthesizeDetailed('我会陪你把下一步做好。', undefined, {
      userMessage: '我有些不敢继续了',
      performance: {
        emotion: 'confident', intent: 'encouraging', intensity: 0.58, gaze: 'user',
        voiceEmotion: 'strong', source: 'model',
        emphasis: [{ text: '下一步', tone: '坚定', strength: 0.55 }]
      }
    });

    const request = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(request).toMatchObject({
      emotion: 'strong',
      userMessage: '我有些不敢继续了',
      emphasis: [{ text: '下一步', tone: '坚定', strength: 0.55 }]
    });
  });
});
