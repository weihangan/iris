export interface RecoverableWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
}

/**
 * Returns the existing live window or creates a replacement. Every replacement
 * owns its close handler, so repeated close -> tray restore cycles cannot leave
 * a destroyed BrowserWindow reference behind.
 */
export function ensureLiveWindow<T extends RecoverableWindow>(input: {
  readonly getCurrent: () => T | null;
  readonly setCurrent: (window: T | null) => void;
  readonly create: () => T;
}): T {
  const current = input.getCurrent();
  if (current && !current.isDestroyed()) return current;

  const created = input.create();
  input.setCurrent(created);
  created.once('closed', () => {
    if (input.getCurrent() === created) input.setCurrent(null);
  });
  return created;
}

/**
 * Shell/tray restoration is visibility-only. It must never participate in a
 * mode transition: even a transient `loading` observation could otherwise
 * hide the avatar for a frame before it is shown again.
 */
export async function restoreChatFromTray(input: {
  readonly ensureChatWindow: () => void;
  /** Shows only Chat; this callback must not change Avatar/Composer visibility. */
  readonly showChatWindow: () => Promise<void>;
}): Promise<void> {
  input.ensureChatWindow();
  await input.showChatWindow();
}
