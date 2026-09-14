import { describe, expect, it, vi } from 'vitest';
import { ensureLiveWindow, restoreChatFromTray } from '../../electron/tray-chat-recovery';

function createFakeWindow() {
  let destroyed = false;
  let closed: (() => void) | undefined;
  return {
    isDestroyed: () => destroyed,
    once: (_event: 'closed', listener: () => void) => {
      closed = listener;
    },
    close: () => {
      destroyed = true;
      closed?.();
    }
  };
}

describe('restoreChatFromTray', () => {
  it('restores chat visibility without any mode transition capability', async () => {
    const order: string[] = [];

    await restoreChatFromTray({
      ensureChatWindow: () => order.push('ensure-window'),
      showChatWindow: async () => {
        order.push('show-window');
      }
    });

    expect(order).toEqual(['ensure-window', 'show-window']);
  });

  it('still shows the chat window when the controller is already in chat mode', async () => {
    const showChatWindow = vi.fn(async () => undefined);
    await restoreChatFromTray({
      ensureChatWindow: vi.fn(),
      showChatWindow
    });
    expect(showChatWindow).toHaveBeenCalledOnce();
  });

  it('keeps repeated icon restore requests visibility-only', async () => {
    const showChatWindow = vi.fn(async () => undefined);

    for (let index = 0; index < 3; index += 1) {
      await restoreChatFromTray({
        ensureChatWindow: vi.fn(),
        showChatWindow
      });
    }

    expect(showChatWindow).toHaveBeenCalledTimes(3);
  });

  it('recreates and tracks the chat window across repeated close and tray restore cycles', () => {
    let current: ReturnType<typeof createFakeWindow> | null = null;
    const create = vi.fn(createFakeWindow);
    const ensure = () => ensureLiveWindow({
      getCurrent: () => current,
      setCurrent: window => {
        current = window;
      },
      create
    });

    const first = ensure();
    expect(ensure()).toBe(first);
    first.close();
    expect(current).toBeNull();

    const second = ensure();
    expect(second).not.toBe(first);
    second.close();
    expect(current).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
