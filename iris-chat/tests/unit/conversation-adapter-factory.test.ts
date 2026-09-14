import { describe, expect, it, vi } from 'vitest';
import { createConversationAdapters } from '../../src/conversation/conversation-adapter-factory';

describe('createConversationAdapters', () => {
  it('未显式启用时保持 Mock，不探测 Chat5.2', async () => {
    const fetchImpl = vi.fn();
    const result = await createConversationAdapters({ useReal: false, fetchImpl: fetchImpl as any });

    expect(result.mode).toBe('mock');
    expect(result.chatAdapter.isMock).toBe(true);
    expect(result.voiceAdapter.isMock).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('显式启用且 3002 runtime 健康时选择真实聊天与语音适配器', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, owner: 'wha1999', flavor: 'cpu' })
    });
    const result = await createConversationAdapters({ useReal: true, fetchImpl: fetchImpl as any });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3002/api/runtime',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.mode).toBe('real');
    expect(result.baseUrl).toBe('http://127.0.0.1:3002');
    expect(result.chatAdapter.isMock).toBe(false);
    expect(result.voiceAdapter.isMock).toBe(false);
  });

  it('健康检查失败时安全回退 Mock 并保留原因', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await createConversationAdapters({
      useReal: true,
      baseUrl: 'http://127.0.0.1:39002/',
      fetchImpl: fetchImpl as any
    });

    expect(result.mode).toBe('mock');
    expect(result.chatAdapter.isMock).toBe(true);
    expect(result.voiceAdapter.isMock).toBe(true);
    expect(result.fallbackReason).toContain('ECONNREFUSED');
    expect(result.baseUrl).toBe('http://127.0.0.1:39002');
  });
});
