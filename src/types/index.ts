export interface User {
  id: string;
  nickname: string;
}

export interface AvatarUpdate {
  ext: string | null;
  updatedAt: number | null;
}

export interface ProfileInfo {
  id: string;
  nickname: string;
  avatar: AvatarUpdate | null;
  createdAt: number;
  online: boolean;
  isMe: boolean;
isBlockedByMe: boolean;
  isBanned: boolean;
  /**
   * The long-lived public half of this account's ratchet identity.
   *
   * A safety number is computed from it on both sides. It is here rather than fetched separately so
   * verification costs no round trip and cannot be quietly skipped.
   */
  identityKey?: string | null;
}

export interface Message {
  id: string;
  senderId: string;
  senderNickname: string;
  text: string;
  timestamp: number;
  isOwn: boolean;
  channel?: string;
  fileKey?: Record<string, string>;
  reactions?: Record<string, string[]>;
  quotedMessageId?: string;
  quotedMessageText?: string;
  quotedMessageSender?: string;
  editedAt?: number;
  expiresAt?: number;
  /**
   * The sealed body, for a private message.
   *
   * Carried on the message rather than only on the server row because a correction arrives as a new
   * ciphertext: the reducer swaps it in, and the bubble opens it again. Without it a corrected private
   * message had no text to show and rendered blank until the page was reloaded.
   */
  encrypted?: any;
  /** The sender's own stamp on an outgoing direct message, used to match the local copy of the text. */
  clientId?: string;
}

export interface Contact {
  id: string;
  nickname: string;
  lastMessage: number;
  online?: boolean;
}

export interface Session {
  id: string;
  nickname: string;
  name: string;
  lastActive: number;
  current: boolean;
  online?: boolean;
}

export interface BannedUser {
  userId: string;
  nickname: string;
  bannedAt: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type ActiveChannel = 'general' | string;

export type AccentColor = 'purple' | 'blue' | 'green' | 'red' | 'orange' | 'pink' | 'teal' | 'indigo';

export interface AppSettings {
  theme: 'dark' | 'light';
  accentColor: AccentColor;
  language: 'en' | 'ru';
  notifications: boolean;
  soundEnabled: boolean;
  /**
   * Whether a notification shows the words of the message.
   *
   * Off means a notification says who wrote and nothing else. Worth having as a setting rather than a
   * default: a notification is one of the few places a private message leaves the app, and it is rendered
   * by the operating system, where anything else running may be able to read it.
   */
  notificationPreview: boolean;
  fontSize: 'small' | 'normal' | 'large';
  compactMode: boolean;
  disappearingTTL: 'off' | '24h' | '7d' | '30d';
  screenshotProtection: boolean;
  /**
   * Whether a passcode is asked for before the conversation is shown.
   *
   * About the device, not the account: it is for an unattended machine, it re-encrypts nothing, and it is
   * forgotten by removing it in Settings, which takes the account password.
   */
  appLockEnabled: boolean;
  /** Milliseconds of doing nothing before the app covers itself. Zero means only on launch. */
  appLockAutoLockMs: number;
  /** Milliseconds between echoes of a conversation being read, if the reader ever looks away. */
  readReceiptsDelayMs: number;
}


declare global {
  interface Window {
    Capacitor?: {
      Plugins?: {
        App?: {
          exitApp?: () => void;
          addListener?: (event: string, callback: () => void) => Promise<{ remove: () => void }>;
        };
      };
    };
    __wnDesktop?: boolean;
  }
}
