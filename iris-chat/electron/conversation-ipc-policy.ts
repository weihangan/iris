import type { ConversationInputSource } from '../src/conversation/conversation-types';

export interface ConversationSenderIds {
  readonly chatSenderId: number | null;
  readonly composerSenderId: number | null;
}

/** Renderer 不能声明自己的来源；来源只能由主进程按 webContents.id 派生。 */
export function resolveConversationSource(
  senderId: number,
  senders: ConversationSenderIds
): ConversationInputSource {
  if (senders.chatSenderId !== null && senderId === senders.chatSenderId) {
    return 'chat';
  }
  if (senders.composerSenderId !== null && senderId === senders.composerSenderId) {
    return 'desktop';
  }
  throw new Error('Unauthorized conversation sender');
}

/** IPC 只接受纯文本，拒绝 renderer 注入 source 或其他控制字段。 */
export function parseConversationText(payload: unknown): string {
  if (typeof payload !== 'string') {
    throw new TypeError('Conversation text must be a string');
  }
  return payload;
}
