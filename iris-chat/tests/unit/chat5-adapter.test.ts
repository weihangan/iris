import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chat5Adapter } from '../../src/conversation/chat5-adapter';

// Phase 1 Task 1.2: Chat5Adapter 单元测试
// Mock HTTP 调用，验证 adapter 正确封装 Chat5 兼容服务

describe('Chat5Adapter', () => {
  let adapter: Chat5Adapter;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
    adapter = new Chat5Adapter({ baseUrl: 'http://127.0.0.1:3003' });
  });

  it('submit 发送 POST /api/chat 并返回回复', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        reply: '你好，我是赛琳娜。',
        emotion: 'happy',
        usage: { total_tokens: 50 }
      })
    });

    const result = await adapter.submit({
      text: '你好',
      characterId: '1',
      history: []
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3003/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    );
    expect(result.success).toBe(true);
    expect(result.reply).toBe('你好，我是赛琳娜。');
    expect(result.emotion).toBe('happy');
  });

  it('服务返回 success:false 时 adapter 传递错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        error: '模型不可用'
      })
    });

    const result = await adapter.submit({
      text: '测试',
      characterId: '1',
      history: []
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('模型不可用');
  });

  it('网络错误时返回 success:false 和错误信息', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await adapter.submit({
      text: '测试',
      characterId: '1',
      history: []
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('healthCheck 调用 /api/runtime 端点（非 /api/health）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        owner: 'wha1999',
        flavor: 'cpu',
        expectedDevice: 'cpu'
      })
    });

    const health = await adapter.healthCheck();

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:3003/api/runtime');
    expect(health.ok).toBe(true);
    expect(health.flavor).toBe('cpu');
    expect(health.owner).toBe('wha1999');
  });

  it('baseUrl 默认为 127.0.0.1:3003（非 3002/3001）', () => {
    const defaultAdapter = new Chat5Adapter();
    expect(defaultAdapter.baseUrl).toBe('http://127.0.0.1:3003');
    expect(defaultAdapter.baseUrl).not.toContain('3002');
    expect(defaultAdapter.baseUrl).not.toContain('3001');
  });
});
