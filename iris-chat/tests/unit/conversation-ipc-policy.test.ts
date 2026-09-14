import { describe, expect, it } from 'vitest';
import {
  parseConversationText,
  resolveConversationSource
} from '../../electron/conversation-ipc-policy';

describe('conversation IPC trust policy', () => {
  const senders = { chatSenderId: 10, composerSenderId: 20 };

  it('由 Chat webContents 派生 chat 来源', () => {
    expect(resolveConversationSource(10, senders)).toBe('chat');
  });

  it('由 Composer webContents 派生 desktop 来源', () => {
    expect(resolveConversationSource(20, senders)).toBe('desktop');
  });

  it('拒绝 Avatar 或未知 webContents', () => {
    expect(() => resolveConversationSource(30, senders)).toThrow('Unauthorized conversation sender');
  });

  it.each([null, undefined, 1, {}, { text: '伪造对象' }, ['文本']])(
    '拒绝非字符串输入 %j',
    (payload) => {
      expect(() => parseConversationText(payload)).toThrow('Conversation text must be a string');
    }
  );

  it('保留字符串原值，由 Controller 统一 trim/空文本判断', () => {
    expect(parseConversationText('  文本  ')).toBe('  文本  ');
    expect(parseConversationText('   ')).toBe('   ');
  });
});
