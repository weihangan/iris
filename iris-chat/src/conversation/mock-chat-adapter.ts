import type { AdapterResponse, ChatAdapter } from './conversation-types';
import { generateMockWav } from './mock-wav-generator';

/**
 * 明确标注的确定性 Mock 对话后端。
 * Phase 5.1：每次回复都附带确定性生成的 WAV 字节，用于证明音频优先硬门。
 * 生成的 WAV 必须通过 wav-validator.ts 的 12 项校验。
 */
export class MockChatAdapter implements ChatAdapter {
  readonly isMock = true;
  private readonly activeRequests = new Map<string, { cancelled: boolean; timer: NodeJS.Timeout | null }>();

  constructor(private readonly delayMs = 200) {}

  submit(taskId: string, userText: string): Promise<AdapterResponse> {
    return new Promise<AdapterResponse>((resolve, reject) => {
      const requestState = { cancelled: false, timer: null as NodeJS.Timeout | null };
      this.activeRequests.set(taskId, requestState);
      requestState.timer = setTimeout(() => {
        this.activeRequests.delete(taskId);
        if (requestState.cancelled) {
          reject(new Error('Mock request cancelled'));
          return;
        }
        const wavBytes = generateMockWav({ taskId, userText });
        resolve({ taskId, text: `收到：${userText}`, wavBytes });
      }, this.delayMs);
    });
  }

  cancel(taskId: string): void {
    const request = this.activeRequests.get(taskId);
    if (request) {
      request.cancelled = true;
    }
  }

  _testHasActiveRequest(taskId: string): boolean {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testHasActiveRequest only available in test mode');
    }
    return this.activeRequests.has(taskId);
  }
}
