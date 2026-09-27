export type BackAction =
  | 'blur-input'
  | 'dismiss-modal'
  | 'close-chat'
  | 'close-settings'
  | 'open-general'
  | 'exit';

export interface BackContext {
  typing: boolean;
  modalOpen: boolean;
  chatOpen: boolean;
  settingsOpen: boolean;
  inDm: boolean;
}

/**
 * The Android back gesture must walk the app the same way Escape does: close the topmost
 * modal first, then step out of the chat, then out of settings, and only leave the app
 * from the home screen. Capacitor's default handler closes the activity whenever the
 * WebView has no history entry to pop, which threw the user out of a profile.
 */
export function resolveBackAction(ctx: BackContext): BackAction {
  if (ctx.typing) return 'blur-input';
  if (ctx.modalOpen) return 'dismiss-modal';
  if (ctx.chatOpen) return 'close-chat';
  if (ctx.settingsOpen) return 'close-settings';
  if (ctx.inDm) return 'open-general';
  return 'exit';
}
