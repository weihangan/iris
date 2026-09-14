import type { ConversationEvent } from './conversation-types';

export type ConversationEventListener = (event: ConversationEvent) => void;

/** 主进程内唯一对话控制器使用的类型化事件总线。 */
export class ConversationEventBus {
  private readonly listeners = new Set<ConversationEventListener>();

  on(listener: ConversationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[conversation] event listener error:', error);
      }
    }
  }
}
