/** Production close hides Chat so tray restore cannot recreate the renderer. */
export function shouldHideChatWindowOnClose(input: {
  readonly isQuitting: boolean;
  readonly isTest: boolean;
}): boolean {
  return !input.isQuitting && !input.isTest;
}
