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
  /**
   * When the far end of each conversation was last seen typing, as an absolute timestamp.
   *
   * Held as a time rather than a flag because the signal is relayed and nothing expires it: whoever
   * receives one shows it until the clock runs out, which is how a person who closed the window
   * mid-sentence stops looking like they are still writing.
   */
  typingUntil: Record<string, number>;
  /**
   * The newest message the far end has said it has read in each conversation.
   *
   * The server keeps no record of this at all - it is relayed and forgotten - so it is what this device
   * was told, which is also the honest reading of a receipt: somebody looked, on a device of theirs.
   */
  readUpTo: Record<string, number>;
  /**
   * Whether the search panel is open over the current conversation.
   */
  searchOpen: boolean;
  searchQuery: string;
  searchLoading: boolean;
  /**
   * The message the reader asked to be taken to.
   *
   * Set by picking a search result or following a quote. The list scrolls to it and marks it, because
   * arriving in a conversation and being told nothing about where you are is how you end up replying to
   * the wrong thing.
   */
  jumpToMessageId: string | null;
  /**
   * The peer whose published identity key stopped matching the one a conversation was built on.
   *
   * That happens on a reinstall, and it is also what a server substituting keys looks like from here.
   * Either way the old session could never be used again, so a fresh one was started - and the one thing
   * worth telling the person is that the number they should be comparing with that contact has changed.
   */
  identityChangedPeer: string | null;
  /**
   * Devices of a contact that no body could be sealed for on the last send.
   *
   * Worth surfacing rather than logging. A message that reached some of somebody's screens and not
   * others is a real situation - a device that has been offline long enough for its signed prekey to
   * have aged out, usually - and the person writing it is the only one who can decide whether that
   * matters. Silence would let them assume everyone saw it.
   */
  unreachableDevices: Record<string, string[]>;
  /**
   * The account-level identity key of each contact, which is what a safety number is derived from.
   *
   * Account-level rather than per-device, and deliberately so: a number that came out differently on a
   * phone and a laptop could not be compared by voice, which would leave the one check that does not
   * depend on the server honest only in the single-device case.
   */
  peerIdentityKeys: Record<string, string>;
  /**
   * Unread counts per conversation, and how many of the global chat's messages have not been looked at.
   *
   * Held per conversation rather than as one number because a list that cannot tell you which of forty
   * chats has something new in it is a list you have to open one by one.
   */
  unreadByChannel: Record<string, number>;
  /**
   * Pinned messages per conversation, newest pin first.
   */
  pinned: Record<string, Message[]>;
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
  | { type: 'SET_MESSAGE_TEXT'; messageId: string; text: string }
  | { type: 'SET_REPLY'; reply: ReplyTarget }
  | { type: 'CLEAR_GENERAL' }
  | { type: 'SET_AVATARS'; avatars: Record<string, AvatarUpdate> }
  | { type: 'SET_PROFILE'; profile: ProfileInfo | null }
  | { type: 'SET_REPORT_TARGET'; target: ProfileInfo | null }
  | { type: 'SET_REPORT_STATUS'; status: 'idle' | 'pending' | 'sent' | 'failed' }
  | { type: 'SET_TYPING'; channel: string; until: number }
  | { type: 'CLEAR_TYPING'; channel: string }
  | { type: 'SET_READ'; channel: string; upTo: number }
  | { type: 'SET_IDENTITY_CHANGED'; peerId: string | null }
  /** Devices of a contact that could not be sealed for, so the interface can say so. */
  | { type: 'SET_UNREACHABLE_DEVICES'; peerId: string; devices: string[] }
  /** Merged into the existing map, so a fetch for one contact cannot drop another's key. */
  | { type: 'SET_PEER_IDENTITY_KEYS'; keys: Record<string, string> }
  | { type: 'SET_SEARCH_OPEN'; open: boolean }
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_SEARCH_LOADING'; loading: boolean }
  | { type: 'JUMP_TO'; messageId: string | null }
  | { type: 'BUMP_UNREAD'; channel: string; delta: number }
  | { type: 'CLEAR_UNREAD'; channel: string }
  | { type: 'SET_PINNED'; channel: string; messages: Message[] }
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
  t: (key: string, params?: Record<string, string | number>) => string;
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
  /** Tells the other end of the open conversation that this one is being typed into. */
  notifyTyping: (channel: string) => void;
  /** Tells the other end how far this device has read the conversation. */
  markRead: (channel: string, upTo: number) => void;
  /** Opens or closes the search panel over the current conversation. */
  setSearchOpen: (open: boolean) => void;
  /** Runs a search inside the current conversation. */
  searchInChannel: (query: string, channel: string | null) => void;
  /** Takes the reader to a message inside the conversation they are already in. */
  jumpTo: (messageId: string) => void;
  /** Pins a message to the top of a conversation, or unpins it. */
  togglePin: (messageId: string, channel: string) => void;
  /** Copies a message's text to the clipboard. */
  copyMessageText: (text: string) => Promise<boolean>;
  /** Forwards a message to another conversation, as a new message of one's own. */
  forwardMessage: (messageId: string, to: string) => Promise<void>;
  /** Exports this account's keys as a file the user can keep. */
  exportKeys: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;

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
