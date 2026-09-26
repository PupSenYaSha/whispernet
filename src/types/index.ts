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
  safetyNumber: string | null;
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
  sealedSender?: boolean;
  expiresAt?: number;
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
  fontSize: 'small' | 'normal' | 'large';
  compactMode: boolean;
  disappearingTTL: 'off' | '24h' | '7d' | '30d';
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
