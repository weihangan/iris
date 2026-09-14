import { describe, expect, it } from 'vitest';
import { shouldHideChatWindowOnClose } from '../../electron/chat-window-lifecycle';

describe('chat window lifecycle', () => {
  it('hides instead of destroying the production chat window', () => {
    expect(shouldHideChatWindowOnClose({ isQuitting: false, isTest: false })).toBe(true);
  });

  it('allows destruction during real quit and tests', () => {
    expect(shouldHideChatWindowOnClose({ isQuitting: true, isTest: false })).toBe(false);
    expect(shouldHideChatWindowOnClose({ isQuitting: false, isTest: true })).toBe(false);
  });
});
