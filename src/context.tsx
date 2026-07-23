import React from 'react';
import type { User, Message, Contact, ConnectionStatus, AppSettings, ActiveChannel, AccentColor } from './types';

export type { User, Message, Contact, ConnectionStatus, AppSettings, ActiveChannel, AccentColor };

export interface ConnectionState {
  status: ConnectionStatus;
  messages: Message[];
  users: User[];
  nickname: string;
  userId: string | null;
  settings: AppSettings;
  ws: WebSocket | null;
  reconnectAttempts: number;
  authError: string | null;
  e2eeReady: boolean;
  needsKeySetup: boolean;
  activeChannel: ActiveChannel;
  contacts: Contact[];
  dmMessages: Record<string, Message[]>;
  searchResults: { id: string; nickname: string; online: boolean }[];
  messageSearchResults: Message[];
}

export type ConnectionAction =
  | { type: 'SET_STATUS'; status: ConnectionStatus }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'SET_MESSAGES'; messages: Message[] }
  | { type: 'SET_DM_MESSAGES'; channel: string; messages: Message[] }
  | { type: 'ADD_DM_MESSAGE'; channel: string; message: Message }
  | { type: 'SET_USERS'; users: User[] }
  | { type: 'ADD_USER'; user: User }
  | { type: 'REMOVE_USER'; userId: string }
  | { type: 'SET_USER'; userId: string; nickname: string }
  | { type: 'SET_WS'; ws: WebSocket | null }
  | { type: 'SET_RECONNECT_ATTEMPTS'; attempts: number }
  | { type: 'SET_AUTH_ERROR'; error: string | null }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<AppSettings> }
  | { type: 'SET_E2EE_READY'; ready: boolean }
  | { type: 'SET_KEY_SETUP_NEEDED'; needed: boolean }
  | { type: 'SET_ACTIVE_CHANNEL'; channel: ActiveChannel }
  | { type: 'SET_CONTACTS'; contacts: Contact[] }
  | { type: 'SET_SEARCH_RESULTS'; results: { id: string; nickname: string; online: boolean }[] }
  | { type: 'SET_MESSAGE_SEARCH_RESULTS'; results: Message[] }
  | { type: 'DELETE_MESSAGE'; messageId: string }
  | { type: 'RESET' };

export interface ConnectionContextType {
  state: ConnectionState;
  dispatch: React.Dispatch<any>;
  connect: (nickname: string, password: string, isRegister: boolean) => void;
  reconnect: () => void;
  disconnect: () => void;
  logout: () => void;
  sendMessage: (text: string) => void;
  sendDm: (to: string, text: string) => void;
  sendDmImage: (to: string, file: File) => Promise<void>;
  sendImage: (file: File) => Promise<void>;
  openDm: (userId: string) => void;
  openGeneral: () => void;
  refreshContacts: () => void;
  searchUsers: (query: string) => void;
  searchMessages: (query: string, channel?: string) => void;
  deleteMessage: (messageId: string) => void;
  t: (key: string) => string;
  updateSettings: (settings: Partial<AppSettings>) => void;
  getMyPublicKey: () => JsonWebKey | null;
  getPublicKey: (userId: string) => JsonWebKey | null;
  sessions: { id: string; lastActive: number; current: boolean }[];
  requestSessions: () => void;
  revokeSession: (sessionId: string) => void;
  showImportModal: (data: any, mode: 'setup' | 'settings') => void;
}

export const ConnectionContext = React.createContext<ConnectionContextType | null>(null);

export function useConnection() {
  const ctx = React.useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
  return ctx;
}
