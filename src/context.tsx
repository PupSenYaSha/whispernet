import React from 'react';
import type { User, Message, Contact, ConnectionStatus, AppSettings, ActiveChannel, AccentColor, Session, BannedUser, AvatarUpdate, ProfileInfo } from './types';

export type { User, Message, Contact, ConnectionStatus, AppSettings, ActiveChannel, AccentColor, Session, BannedUser, AvatarUpdate, ProfileInfo };

export type ReplyTarget = { id: string; senderNickname: string; text: string } | null;

export type AdminReport = {
  id: string;
  reporterNick?: string;
  targetId: string;
  targetNick?: string;
  channel: string;
  messageId?: string;
  messageText?: string;
  reason: string;
  source?: 'profile' | 'message';
  timestamp: number;
};


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
  dmNames: Record<string, string>;
  dmMessages: Record<string, Message[]>;
  generalHistory: HistoryWindow;
  dmHistory: Record<string, HistoryWindow>;
  searchResults: { id: string; nickname: string; online: boolean }[];
  messageSearchResults: Message[];
  replyTo: ReplyTarget;
  avatars: Record<string, AvatarUpdate>;
  profile: ProfileInfo | null;
  reportTarget: ProfileInfo | null;
  reportStatus: 'idle' | 'pending' | 'sent' | 'failed';
  }

export interface HistoryWindow {
  hasMore: boolean;
  oldest: number | null;
}

export type ConnectionAction =
  | { type: 'SET_STATUS'; status: ConnectionStatus }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'SET_MESSAGES'; messages: Message[] }
  | { type: 'PREPEND_MESSAGES'; messages: Message[] }
  | { type: 'SET_HISTORY_STATE'; hasMore: boolean; oldest: number | null }
  | { type: 'SET_DM_MESSAGES'; channel: string; messages: Message[] }
  | { type: 'PREPEND_DM_MESSAGES'; channel: string; messages: Message[] }
  | { type: 'SET_DM_HISTORY_STATE'; channel: string; hasMore: boolean; oldest: number | null }
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
  | { type: 'SET_DM_NAME'; userId: string; nickname: string }
  | { type: 'SET_SEARCH_RESULTS'; results: { id: string; nickname: string; online: boolean }[] }
  | { type: 'SET_MESSAGE_SEARCH_RESULTS'; results: Message[] }
  | { type: 'DELETE_MESSAGE'; messageId: string }
  | { type: 'ADD_REACTION'; messageId: string; emoji: string; userId: string }
  | { type: 'REMOVE_REACTION'; messageId: string; emoji: string; userId: string }
  | { type: 'UPDATE_MESSAGE'; messageId: string; text: string; encrypted?: any; editedAt: number }
  | { type: 'SET_REPLY'; reply: ReplyTarget }
  | { type: 'CLEAR_GENERAL' }
  | { type: 'SET_AVATARS'; avatars: Record<string, AvatarUpdate> }
  | { type: 'SET_PROFILE'; profile: ProfileInfo | null }
  | { type: 'SET_REPORT_TARGET'; target: ProfileInfo | null }
  | { type: 'SET_REPORT_STATUS'; status: 'idle' | 'pending' | 'sent' | 'failed' }
  | { type: 'RESET' };

export interface ConnectionContextType {
  state: ConnectionState;
  dispatch: React.Dispatch<any>;
  connect: (nickname: string, password: string, isRegister: boolean) => void;
  reconnect: () => void;
  disconnect: () => void;
  logout: () => void;
  sendMessage: (text: string, quoted?: ReplyTarget) => void;
  sendDm: (to: string, text: string, quoted?: ReplyTarget) => Promise<void>;

  sendDmImage: (to: string, file: File) => Promise<void>;
  sendImage: (file: File) => Promise<void>;
  openDm: (userId: string, nickname?: string) => void;
  openGeneral: () => void;
  refreshContacts: () => void;
  searchUsers: (query: string) => void;
  searchMessages: (query: string, channel?: string) => void;
  deleteMessage: (messageId: string) => void;
  addReaction: (messageId: string, emoji: string) => void;
  removeReaction: (messageId: string, emoji: string) => void;
  editMessage: (messageId: string, text: string) => void;
  setReply: (reply: ReplyTarget) => void;
  editingTarget: Message | null;
  setEditing: (msg: Message | null) => void;
  isAdmin: boolean;
  reports: AdminReport[];
  adminReports: () => void;
  adminBan: (nickname: string) => void;
  adminUnban: (nickname: string) => void;
  t: (key: string) => string;
  updateSettings: (settings: Partial<AppSettings>) => void;
getMyPublicKey: () => JsonWebKey | null;
  getPublicKey: (userId: string) => JsonWebKey | null;
  decryptMedia: (message: { id: string; text: string; fileKey?: Record<string, string> }) => Promise<string | null>;
  /** Keeps a decrypted media object URL alive while a bubble is showing it. */
  retainMedia: (id: string) => void;
  releaseMedia: (id: string) => void;
  loadOlderMessages: (channel: string | null, before: number | null) => Promise<void>;

  sessions: Session[];
  requestSessions: () => void;
  revokeSession: (sessionId: string) => void;
  bannedUsers: BannedUser[];
  adminGetBanned: () => void;
  adminError: string | null;
  dismissAdminError: () => void;
  blockedUsers: { id: string; nickname: string }[];
  refreshBlocked: () => void;
  blockUser: (userId: string, nickname?: string) => void;
  unblockUser: (userId: string) => void;
  reportUser: (targetId: string, reason: string, messageId?: string, source?: 'profile' | 'message') => boolean;

  showImportModal: (data: any, mode: 'setup' | 'settings') => void;
  openProfile: (userId: string) => void;
  closeProfile: () => void;
  openReport: (target: ProfileInfo) => void;
  closeReport: () => void;
  backToProfile: () => void;
  setMyAvatar: (dataUrl: string) => Promise<void>;
  removeMyAvatar: () => void;
}

export const ConnectionContext = React.createContext<ConnectionContextType | null>(null);

export function useConnection() {
  const ctx = React.useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
  return ctx;
}
