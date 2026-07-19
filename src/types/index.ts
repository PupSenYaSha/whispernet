export interface User {
  id: string;
  nickname: string;
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
}

export interface Contact {
  id: string;
  nickname: string;
  lastMessage: number;
  online?: boolean;
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
    electronAPI?: {
      setTitle: (title: string) => void;
      onUpdateAvailable: (callback: (e: any, data: any) => void) => () => void;
      onUpdateProgress: (callback: (e: any, data: any) => void) => () => void;
      onUpdateReady: (callback: (e: any, data: any) => void) => () => void;
      onUpdateError: (callback: (e: any, data: any) => void) => () => void;
      applyUpdate: () => void;
    };
  }
}
