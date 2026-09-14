import { describe, expect, it, vi } from 'vitest';
import { startConversationHistorySync } from '../../src/conversation/history-sync';
import type {
  ConversationEvent,
  ConversationHistory,
  ConversationMessage
} from '../../src/conversation/conversation-types';

function message(id: string, text: string): ConversationMessage {
  return {
    id,
    role: 'user',
    text,
    source: 'chat',
    timestamp: 1,
    isMock: false,
    audioReady: false
  };
}

describe('startConversationHistorySync', () => {
  it('快照返回前收到的消息会在快照后按序重放', async () => {
    let resolveHistory!: (history: ConversationHistory) => void;
    let listener!: (event: ConversationEvent) => void;
    const calls: string[] = [];
    const snapshotMessage = message('msg-1', '快照消息');
    const bufferedMessage = message('msg-2', '并发消息');

    const sync = startConversationHistorySync({
      loadHistory: () => new Promise(resolve => { resolveHistory = resolve; }),
      subscribe: callback => {
        listener = callback;
        return vi.fn();
      },
      applyHistory: history => calls.push(`snapshot:${history.messages.map(item => item.id).join(',')}`),
      applyMessage: item => calls.push(`event:${item.id}`),
      onError: vi.fn()
    });

    listener({ type: 'message-added', message: bufferedMessage });
    resolveHistory({ messages: [snapshotMessage], activeTask: null });
    await sync.ready;

    expect(calls).toEqual(['snapshot:msg-1', 'event:msg-2']);
  });

  it('dispose 立即取消订阅并忽略后续事件', async () => {
    let listener!: (event: ConversationEvent) => void;
    const unsubscribe = vi.fn();
    const applyMessage = vi.fn();
    const sync = startConversationHistorySync({
      loadHistory: async () => ({ messages: [], activeTask: null }),
      subscribe: callback => {
        listener = callback;
        return unsubscribe;
      },
      applyHistory: vi.fn(),
      applyMessage,
      onError: vi.fn()
    });

    sync.dispose();
    listener({ type: 'message-added', message: message('msg-1', '不应渲染') });
    await sync.ready;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(applyMessage).not.toHaveBeenCalled();
  });
});
