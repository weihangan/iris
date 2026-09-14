import type {
  ConversationEvent,
  ConversationHistory,
  ConversationMessage
} from './conversation-types';

export interface ConversationHistorySyncPorts {
  loadHistory(): Promise<ConversationHistory>;
  subscribe(listener: (event: ConversationEvent) => void): () => void;
  applyHistory(history: ConversationHistory): void;
  applyMessage(message: ConversationMessage): void;
  onError(error: unknown): void;
}

export interface ConversationHistorySync {
  readonly ready: Promise<void>;
  dispose(): void;
}

/**
 * 先订阅、再取快照；快照请求期间的事件会在快照后重放。
 * applyMessage 必须按 message.id 去重，以兼容快照已包含并发事件的情况。
 */
export function startConversationHistorySync(
  ports: ConversationHistorySyncPorts
): ConversationHistorySync {
  let hydrating = true;
  let disposed = false;
  const bufferedMessages: ConversationMessage[] = [];

  const unsubscribe = ports.subscribe(event => {
    if (disposed || event.type !== 'message-added' || !event.message) {
      return;
    }
    if (hydrating) {
      bufferedMessages.push(event.message);
      return;
    }
    ports.applyMessage(event.message);
  });

  const ready = (async (): Promise<void> => {
    try {
      const history = await ports.loadHistory();
      if (!disposed) {
        ports.applyHistory(history);
      }
    } catch (error) {
      if (!disposed) {
        ports.onError(error);
      }
    } finally {
      hydrating = false;
      if (!disposed) {
        for (const message of bufferedMessages) {
          ports.applyMessage(message);
        }
      }
      bufferedMessages.length = 0;
    }
  })();

  return {
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bufferedMessages.length = 0;
      unsubscribe();
    }
  };
}
