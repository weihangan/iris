import { describe, expect, it } from 'vitest';
import { MockChatAdapter } from '../../src/conversation/mock-chat-adapter';
import { validateWav } from '../../src/conversation/wav-validator';

describe('MockChatAdapter', () => {
  it('用 isMock 标记身份，回复正文不重复嵌入 MOCK 前缀', async () => {
    const adapter = new MockChatAdapter(0);
    const response = await adapter.submit('task-1', '测试消息');

    expect(adapter.isMock).toBe(true);
    expect(response.taskId).toBe('task-1');
    expect(response.text).toBe('收到：测试消息');
  });

  it('Phase 5.1：回复附带确定性 WAV 字节，且通过 12 项格式校验', async () => {
    const adapter = new MockChatAdapter(0);
    const response = await adapter.submit('task-1', '测试消息');

    expect(response.wavBytes).toBeInstanceOf(ArrayBuffer);
    expect(response.wavBytes!.byteLength).toBeGreaterThan(44);

    const result = validateWav(response.wavBytes!);
    expect(result.valid).toBe(true);
  });

  it('Phase 5.1：相同 taskId + userText 生成完全相同的 WAV 字节', async () => {
    const adapter = new MockChatAdapter(0);
    const a = await adapter.submit('task-1', '测试消息');
    const b = await adapter.submit('task-1', '测试消息');

    expect(a.wavBytes!.byteLength).toBe(b.wavBytes!.byteLength);
    const aView = new Uint8Array(a.wavBytes!);
    const bView = new Uint8Array(b.wavBytes!);
    for (let i = 0; i < aView.length; i++) {
      expect(aView[i]).toBe(bView[i]);
    }
  });
});
