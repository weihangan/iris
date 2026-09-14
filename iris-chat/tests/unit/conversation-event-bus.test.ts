import { describe, expect, it, vi } from 'vitest';
import { ConversationEventBus } from '../../src/conversation/event-bus';
import type { ConversationEvent } from '../../src/conversation/conversation-types';

describe('ConversationEventBus', () => {
  it('向两个订阅者分发同一个事件', () => {
    const bus = new ConversationEventBus();
    const first = vi.fn();
    const second = vi.fn();
    const event: ConversationEvent = { type: 'task-started', taskId: 'task-1' };

    bus.on(first);
    bus.on(second);
    bus.emit(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('取消订阅后不再分发事件', () => {
    const bus = new ConversationEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.on(listener);

    unsubscribe();
    bus.emit({ type: 'task-started', taskId: 'task-1' });

    expect(listener).not.toHaveBeenCalled();
  });
});
