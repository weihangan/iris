import type { ChatAdapter, VoiceAdapter } from './conversation-types';
import { Chat5PerformanceAdapter } from './chat5-performance-adapter';
import { Chat5VoiceAdapter } from './chat5-voice-adapter';
import { MockChatAdapter } from './mock-chat-adapter';
import { MockVoiceAdapter } from './mock-voice-adapter';

export interface ConversationAdapterFactoryOptions {
  readonly useReal: boolean;
  readonly baseUrl?: string;
  readonly characterId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly healthTimeoutMs?: number;
}

export interface ConversationAdapterSelection {
  readonly mode: 'real' | 'mock';
  readonly baseUrl: string;
  readonly chatAdapter: ChatAdapter;
  readonly voiceAdapter: VoiceAdapter;
  readonly fallbackReason?: string;
}

function createMockSelection(baseUrl: string, fallbackReason?: string): ConversationAdapterSelection {
  return {
    mode: 'mock',
    baseUrl,
    chatAdapter: new MockChatAdapter(300),
    voiceAdapter: new MockVoiceAdapter(200),
    fallbackReason
  };
}

export async function createConversationAdapters(
  options: ConversationAdapterFactoryOptions
): Promise<ConversationAdapterSelection> {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3002').replace(/\/$/, '');
  if (!options.useReal) {
    return createMockSelection(baseUrl);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.healthTimeoutMs ?? 2500);
  timeout.unref?.();

  try {
    const response = await fetchImpl(`${baseUrl}/api/runtime`, { signal: controller.signal });
    const data = await response.json() as { success?: boolean; owner?: string };
    if (!response.ok || data.success === false) {
      return createMockSelection(baseUrl, `Chat5 runtime unhealthy: HTTP ${response.status}`);
    }

    const voiceAdapter = new Chat5VoiceAdapter({
      baseUrl,
      characterId: options.characterId,
      fetchImpl
    });
    return {
      mode: 'real',
      baseUrl,
      chatAdapter: new Chat5PerformanceAdapter({
        baseUrl,
        characterId: options.characterId,
        fetchImpl,
        voiceAdapter
      }),
      voiceAdapter
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return createMockSelection(baseUrl, `Chat5 runtime health check failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}
