import { useState, useEffect, useCallback, useRef } from 'react';
import { useReducer, ReactNode } from 'react';
import type { User, AppSettings, Message, Session, BannedUser, AvatarUpdate, ProfileInfo } from './types';
import { generateKeyPair, encryptMessage, decryptMessage } from './crypto';
import { encryptPrivateKey, decryptPrivateKey, isEncryptedBundle, isKeyBackup, type KeyBackup } from './crypto-keys';
import { storePassword, readStoredAuth, clearStoredAuth, retireLegacyFingerprint } from './device-crypto';
import { uploadFile, uploadStream, MediaError, setUploadToken, mediaProxyUrl } from './upload';
import {
  encryptFileStream, buildFileKeyMap, unwrapAndDecrypt, unwrapAndDecryptChannel,
  sealFileKeyInText, openFileKeyFromText, openAttachmentWithKey, parseMediaTag,
} from './media-crypto';
import { newClientMessageId, rememberOwnMessageText, recallOwnMessageText, forgetOwnMessages, setOwnMessageCachePassword, flushOwnMessageCache } from './ownMessageCache'
import { changeAccountPassword } from './changePassword'
import { getDeviceId, adoptServerDeviceId } from './deviceId'
import {
  startRatchet, publishBundle, rememberBundles, rememberBundle,
  sealForDevices, openFor, isDmBody, flushRatchet, hasBundlesFor, forgetBundle,
  rememberOwnBundles, accountIdentityKeyBase64,
  peerIdentityChanged, clearIdentityChanged,
} from './dmCrypto';;
import { ConnectionContext, useConnection, type ConnectionState, type ConnectionAction, type ReplyTarget, type AdminReport } from './context';
import { loadSettings, defaultSettings, translations, cn, formatTime, getDeviceLabel } from './utils';
import { loadReadUpTo, saveReadUpTo, noteTyping, noteRead, TYPING_THROTTLE_MS } from './presence';

declare const __APP_VERSION__: string;

/** How many decrypted media blobs stay cached; anything beyond that is re-decrypted on demand. */
const MEDIA_CACHE_LIMIT = 100;

import { LoginScreen } from './components/LoginScreen';
import { UpdateOverlay } from './components/UpdateOverlay';
import { ChatArea } from './components/ChatArea';
import { ChatList } from './components/ChatList';
import { AppLockGate, useAutoLock } from './components/AppLock';
import { isAppLockSet } from './appLock';
import { SettingsPanel } from './components/SettingsPanel';
import { ProfileModal } from './components/ProfileModal';
import { ReportModal } from './components/ReportModal';
import { Avatar } from './components/Avatar';
import { useEscapeKey } from './useEscapeKey';
import { runTopEscapeLayer, hasEscapeLayerAtLeast, isTypingTarget } from './escapeStack';
import { resolveBackAction } from './backNavigation';
import { App as CapacitorApp } from '@capacitor/app';

const WS_URL = import.meta.env.VITE_WS_URL || (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
})();





function loadDmNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem('wn_dm_names');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const initialState: ConnectionState = {
  status: 'disconnected',
  messages: [],
  users: [],
  nickname: '',
  userId: null,
  settings: defaultSettings,
  ws: null,
  reconnectAttempts: 0,
  authError: null,
  e2eeReady: false,
  needsKeySetup: false,
  activeChannel: 'general',
  contacts: [],
  dmNames: {},
  dmMessages: {},
  generalHistory: { hasMore: true, oldest: null },
  dmHistory: {},
  searchResults: [],
  messageSearchResults: [],
  replyTo: null,
  avatars: {},
  profile: null,
  reportTarget: null,
  reportStatus: 'idle',
  typingUntil: {},
  readUpTo: {},
  identityChangedPeer: null,
  unreachableDevices: {},
  peerIdentityKeys: {},
  searchOpen: false,
  searchQuery: '',
  searchLoading: false,
  jumpToMessageId: null,
  unreadByChannel: {},
  pinned: {},
};

function loadReadUpToSafe(): Record<string, number> {
  try { return loadReadUpTo(); } catch { return {}; }
}

/** Pins are a per-device reading convenience, kept beside the settings rather than on the server. */
function loadPinned(): Record<string, Message[]> {
  try {
    const raw = localStorage.getItem('wn_pinned');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, Message[]> = {};
    for (const [channel, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out[channel] = list.filter((m: any) => m && typeof m.id === 'string' && typeof m.text === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function applyAddReaction(msg: Message, emoji: string, userId: string): Message {
  const reactions = { ...(msg.reactions || {}) };
  for (const e of Object.keys(reactions)) {
    reactions[e] = (reactions[e] as string[]).filter(u => u !== userId);
  }
  reactions[emoji] = [...(reactions[emoji] || []), userId];
  return { ...msg, reactions };
}

function applyRemoveReaction(msg: Message, emoji: string, userId: string): Message {
  const reactions = { ...(msg.reactions || {}) };
  const next = (reactions[emoji] || []).filter(u => u !== userId);
  if (next.length === 0) delete reactions[emoji];
  else reactions[emoji] = next;
  return { ...msg, reactions };
}

function normalizeReactions(fromServer: any): Record<string, string[]> | undefined {
  if (!fromServer) return undefined;
  if (Array.isArray(fromServer)) {
    const out: Record<string, string[]> = {};
    for (const r of fromServer) {
      if (r && typeof r.emoji === 'string') (out[r.emoji] = out[r.emoji] || []).push(r.userId);
    }
    return out;
  }
  return fromServer as Record<string, string[]>;
}

function avatarMapFromMessages(msgs: any[]): Record<string, AvatarUpdate> {
  const out: Record<string, AvatarUpdate> = {};
  for (const m of msgs || []) {
    if (m && typeof m.senderId === 'string' && m.senderAvatar && m.senderAvatar.ext) {
      out[m.senderId] = m.senderAvatar;
    }
  }
  return out;
}

function avatarMapFromUsers(list: Array<{ id?: string; avatar?: any }>): Record<string, AvatarUpdate> {
  const out: Record<string, AvatarUpdate> = {};
  for (const u of list || []) {
    if (u && u.id && u.avatar && u.avatar.ext) out[u.id] = u.avatar;
  }
  return out;
}

function avatarFromSender(senderId: string | null | undefined, avatar: any): Record<string, AvatarUpdate> {
  if (!senderId || !avatar || !avatar.ext) return {};
  return { [senderId]: avatar };
}

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };
    case 'PREPEND_MESSAGES':
      return { ...state, messages: [...action.messages, ...state.messages] };
    case 'SET_HISTORY_STATE':
      return { ...state, generalHistory: { hasMore: action.hasMore, oldest: action.oldest } };
    case 'CLEAR_GENERAL':
      return { ...state, messages: [], generalHistory: { hasMore: true, oldest: null } };
    case 'SET_DM_MESSAGES':
      return { ...state, dmMessages: { ...state.dmMessages, [action.channel]: action.messages } };
    case 'PREPEND_DM_MESSAGES':
      return { ...state, dmMessages: { ...state.dmMessages, [action.channel]: [...action.messages, ...(state.dmMessages[action.channel] || [])] } };
    case 'SET_DM_HISTORY_STATE':
      return { ...state, dmHistory: { ...state.dmHistory, [action.channel]: { hasMore: action.hasMore, oldest: action.oldest } } };
    case 'ADD_DM_MESSAGE': {
      const existing = state.dmMessages[action.channel] || [];
      // A message arrives live and again in the history that follows it, so the same id can be added
      // twice. Appending it again would show it repeated under itself.
      if (existing.some((m: Message) => m.id === action.message.id)) return state;
      return { ...state, dmMessages: { ...state.dmMessages, [action.channel]: [...existing, action.message] } };
    }
    case 'SET_PEER_IDENTITY_KEYS':
      // The account-level keys safety numbers are computed from. Merged rather than replaced so a fetch
      // for one contact cannot drop what another fetch already established.
      return { ...state, peerIdentityKeys: { ...state.peerIdentityKeys, ...action.keys } };
    case 'SET_USERS':
      return { ...state, users: action.users };
    case 'ADD_USER':
      return { ...state, users: [...state.users.filter(u => u.id !== action.user.id), action.user] };
    case 'REMOVE_USER':
      return { ...state, users: state.users.filter(u => u.id !== action.userId) };
    case 'SET_USER':
      return { ...state, userId: action.userId, nickname: action.nickname };
    case 'SET_WS':
      return { ...state, ws: action.ws };
    case 'SET_RECONNECT_ATTEMPTS':
      return { ...state, reconnectAttempts: action.attempts };
    case 'SET_AUTH_ERROR':
      return { ...state, authError: action.error };
    case 'UPDATE_SETTINGS': {
      const newSettings = { ...state.settings, ...action.settings };
      localStorage.setItem('wn_settings', JSON.stringify(newSettings));
      return { ...state, settings: newSettings };
    }
    case 'SET_TYPING': {
      const typingUntil = noteTyping(state.typingUntil, action.channel);
      return { ...state, typingUntil };
    }
    case 'CLEAR_TYPING': {
      if (!(action.channel in state.typingUntil)) return state;
      const typingUntil = { ...state.typingUntil };
      delete typingUntil[action.channel];
      return { ...state, typingUntil };
    }
    case 'SET_READ': {
      const readUpTo = noteRead(state.readUpTo, action.channel, action.upTo);
      saveReadUpTo(readUpTo);
      return { ...state, readUpTo };
    }
    case 'SET_IDENTITY_CHANGED':
      return { ...state, identityChangedPeer: action.peerId };
    case 'SET_UNREACHABLE_DEVICES': {
      const next = { ...(state.unreachableDevices || {}) };
      if (action.devices.length === 0) delete next[action.peerId];
      else next[action.peerId] = action.devices;
      return { ...state, unreachableDevices: next };
    }
    case 'SET_SEARCH_OPEN':
      // opening the panel starts a clean search: last time's results belong to another conversation
      return action.open
        ? { ...state, searchOpen: true, searchQuery: '', messageSearchResults: [], searchLoading: false }
        : { ...state, searchOpen: false, searchQuery: '', messageSearchResults: [], searchLoading: false };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query };
    case 'SET_SEARCH_LOADING':
      return { ...state, searchLoading: action.loading };
    case 'JUMP_TO':
      return { ...state, jumpToMessageId: action.messageId, searchOpen: false };
    case 'BUMP_UNREAD': {
      const next = Math.max(0, (state.unreadByChannel[action.channel] || 0) + action.delta);
      const unreadByChannel = { ...state.unreadByChannel, [action.channel]: next };
      return { ...state, unreadByChannel };
    }
    case 'CLEAR_UNREAD': {
      if (!state.unreadByChannel[action.channel]) return state;
      const unreadByChannel = { ...state.unreadByChannel };
      delete unreadByChannel[action.channel];
      return { ...state, unreadByChannel };
    }
    case 'SET_PINNED':
      return { ...state, pinned: { ...state.pinned, [action.channel]: action.messages } };
    case 'RESET':
      return { ...initialState, settings: state.settings };
    case 'SET_E2EE_READY':
      return { ...state, e2eeReady: action.ready };
    case 'SET_REPLY':
      return { ...state, replyTo: action.reply };
    case 'SET_AVATARS':
      return { ...state, avatars: { ...state.avatars, ...action.avatars } };
    case 'SET_PROFILE':
      return { ...state, profile: action.profile };
    case 'SET_REPORT_TARGET':
      return { ...state, reportTarget: action.target, reportStatus: 'idle' };
      case 'SET_REPORT_STATUS':
      return { ...state, reportStatus: action.status };
    case 'SET_KEY_SETUP_NEEDED':
      return { ...state, needsKeySetup: action.needed };
    case 'SET_ACTIVE_CHANNEL':
      return { ...state, activeChannel: action.channel, replyTo: null };
    case 'SET_CONTACTS':
      return { ...state, contacts: action.contacts };
    case 'SET_DM_NAME': {
      const dmNames = { ...state.dmNames, [action.userId]: action.nickname };
      try { localStorage.setItem('wn_dm_names', JSON.stringify(dmNames)); } catch {}
      return { ...state, dmNames };
    }
    case 'SET_SEARCH_RESULTS':
      return { ...state, searchResults: action.results };
    case 'SET_MESSAGE_SEARCH_RESULTS':
      return { ...state, messageSearchResults: action.results };
    case 'DELETE_MESSAGE':
      return {
        ...state,
        messages: state.messages.filter(m => m.id !== action.messageId),
        dmMessages: Object.fromEntries(
          Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.filter(m => m.id !== action.messageId)])
        ),
      };
    case 'SET_MESSAGE_TEXT': {
      const applyTo = (m: Message): Message => (m.id === action.messageId ? { ...m, text: action.text } : m);
      return {
        ...state,
        messages: state.messages.map(applyTo),
        dmMessages: Object.fromEntries(
          Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.map(applyTo)])
        ),
      };
    }
    case 'UPDATE_MESSAGE': {
      if (action.encrypted) {
        const withBody = { encrypted: action.encrypted, editedAt: action.editedAt };
        const applyTo = (m: Message): Message => (m.id === action.messageId ? { ...m, ...withBody } : m);
        return {
          ...state,
          messages: state.messages.map(applyTo),
          dmMessages: Object.fromEntries(
            Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.map(applyTo)])
          ),
        };
      }
      const patch = { text: action.text, editedAt: action.editedAt };
      const applyTo = (m: Message): Message => (m.id === action.messageId ? { ...m, ...patch } : m);
      return {
        ...state,
        messages: state.messages.map(applyTo),
        dmMessages: Object.fromEntries(
          Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.map(applyTo)])
        ),
      };
    }
    case 'ADD_REACTION':
      return {
        ...state,
        messages: state.messages.map(m => m.id === action.messageId ? applyAddReaction(m, action.emoji, action.userId) : m),
        dmMessages: Object.fromEntries(
          Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.map(m => m.id === action.messageId ? applyAddReaction(m, action.emoji, action.userId) : m)])
        ),
      };
    case 'REMOVE_REACTION':
      return {
        ...state,
        messages: state.messages.map(m => m.id === action.messageId ? applyRemoveReaction(m, action.emoji, action.userId) : m),
        dmMessages: Object.fromEntries(
          Object.entries(state.dmMessages).map(([ch, msgs]) => [ch, msgs.map(m => m.id === action.messageId ? applyRemoveReaction(m, action.emoji, action.userId) : m)])
        ),
      };
    default:
      return state;
  }
}

/**
 * Who the other party in a private message is.
 *
 * A row carries both participants joined by a colon, and for our own message the other end is the peer,
 * while for theirs it is the sender. Reading a message needs the peer's identity because the ratchet
 * session is keyed by the pair, so picking the wrong end picks the wrong session.
 */
function peerOf(m: any): string {
  const channel = typeof m?.channel === 'string' ? m.channel : '';
  if (channel.includes(':')) {
    const [a, b] = channel.split(':');
    if (m?.isOwn) return a === currentAccountId() ? b : a;
    return b === currentAccountId() ? a : b;
  }
  return m?.senderId || channel;
}

/** The signed-in account id, readable from anywhere rather than threaded through every callback. */
let accountId = '';
function currentAccountId(): string {
  return accountId;
}

function findMessage(state: ConnectionState, id: string): any {
  const general = state.messages.find((m) => m.id === id);
  if (general) return general;
  for (const msgs of Object.values(state.dmMessages)) {
    const hit = msgs.find((m) => m.id === id);
    if (hit) return hit;
  }
  return null;
}

/** Which conversation a message belongs to, which is what picking the ratchet session needs. */
function findDmChannelOf(state: ConnectionState, id: string): string | null {
  const msg = findMessage(state, id);
  if (!msg) return null;
  return msg.channel || null;
}

function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(connectionReducer, initialState, (init) => ({
    ...init,
    settings: loadSettings(),
    dmNames: loadDmNames(),
    readUpTo: loadReadUpToSafe(),
    pinned: loadPinned(),
  }));
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatWsRef = useRef<WebSocket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const authRef = useRef<{ nickname: string; password: string; isRegister: boolean } | null>(null);
  
  
  const credentialsRef = useRef<{ nickname: string; password: string; isRegister: boolean } | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const userIdRef = useRef<string | null>(null);
const uploadTokenRef = useRef<string>('');
try { uploadTokenRef.current = localStorage.getItem('wn_upload_token') || ''; } catch { uploadTokenRef.current = ''; }
  const privateKeyRef = useRef<JsonWebKey | null>(null);
  const publicKeyRef = useRef<JsonWebKey | null>(null);
  const publicKeysRef = useRef<Record<string, JsonWebKey>>({});
  const nicknameRef = useRef<string | null>(null);
  const settingsRef = useRef<AppSettings>(defaultSettings);
  const reportTargetRef = useRef<ProfileInfo | null>(null);
  const requestedProfileIdRef = useRef<string | null>(null);
  const stateRef = useRef<ConnectionState>(initialState);
  /** Set once `markRead` exists, so the effect above can be declared before it without reordering. */
  const markReadRef = useRef<(channel: string, upTo: number) => void>(() => {});
  const unreadCountRef = useRef(0);
  const titleRef = useRef(document.title);
  const notifSoundRef = useRef<HTMLAudioElement | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<{ id: string; nickname: string }[]>([]);
  const [importModal, setImportModal] = useState<{ data: any; mode: 'setup' | 'settings' } | null>(null);
  const [editingTarget, setEditingTarget] = useState<Message | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [adminError, setAdminError] = useState<string | null>(null);

  
  
  
  const fetchKeyBackup = (): Promise<string | null> => {
    return new Promise((resolve) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
      const handler = (ev: MessageEvent) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'key_backup') {
            ws.removeEventListener('message', handler);
            resolve((m.payload && m.payload.blob) || null);
          }
        } catch {  }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ type: 'key_backup_fetch', payload: {} }));
      setTimeout(() => { try { ws.removeEventListener('message', handler); } catch {  } resolve(null); }, 5000);
    });
  };

  useEffect(() => { userIdRef.current = state.userId; }, [state.userId]);
  useEffect(() => { nicknameRef.current = state.nickname; }, [state.nickname]);
useEffect(() => { reportTargetRef.current = state.reportTarget; }, [state.reportTarget]);
useEffect(() => { settingsRef.current = state.settings; }, [state.settings]);
useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => { setEditingTarget(null); }, [state.activeChannel]);

  useEffect(() => {
    const root = document.documentElement;
    if (state.settings.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    const accentClasses = ['accent-blue', 'accent-green', 'accent-red', 'accent-orange', 'accent-pink', 'accent-teal', 'accent-indigo'];
    accentClasses.forEach(c => root.classList.remove(c));
    if (state.settings.accentColor && state.settings.accentColor !== 'purple') {
      root.classList.add(`accent-${state.settings.accentColor}`);
    }
    const accent = getComputedStyle(root).getPropertyValue('--color-accent-primary').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && accent) meta.setAttribute('content', `rgb(${accent})`);
  }, [state.settings.theme, state.settings.accentColor]);

  /**
   * Looks a string up in the active language.
   *
   * `params` substitutes `{name}` placeholders, which is how a string that depends on a count says so
   * in the grammar of the language rather than in the grammar of English. A `{count}` left unsubstituted
   * would be worse than no plural at all - it looks like a bug in the string rather than a missing form.
   */
  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    const text = translations[state.settings.language as keyof typeof translations]?.[key as keyof typeof translations.en];
    if (typeof text !== 'string') return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name];
      return value === undefined ? whole : String(value);
    });
  }, [state.settings.language]);

  /**
   * The window title names the account, never the conversation.
   *
   * It used to follow the open chat, so the same window read "WhisperNet @admin" while you were
   * talking to admin and "WhisperNet @123" the moment you went back to the global chat. That made
   * the title look like it was identifying the person on screen rather than the person at the
   * keyboard, which is the one thing a title bar is for.
   */
  const updateTitle = useCallback(() => {
    const count = unreadCountRef.current;
    const me = nicknameRef.current;
    const base = me ? `WhisperNet @${me}` : 'WhisperNet';
    const newTitle = count > 0 ? `${base} (${count})` : base;
    document.title = newTitle;
    titleRef.current = newTitle;
  }, []);

  const fireNotification = useCallback((title: string, body: string) => {
    if (!settingsRef.current.notifications) return;
    if (!document.hidden) return;
    if (Notification.permission !== 'granted') return;
    // A notification is drawn by the operating system, outside this app, and is one of the few places a
    // private message leaves it. With the preview turned off, only who wrote is said.
    const shown = settingsRef.current.notificationPreview ? body : t('new_message');
    try {
      const n = new Notification(title, { body: shown, icon: '/icons/icon-192.png', tag: 'whispernet' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }, [t]);

  const playNotifSound = useCallback(() => {
    if (!settingsRef.current.soundEnabled) return;
    try {
      if (!notifSoundRef.current) {
        notifSoundRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2JkZqRiX1waXOAjZaQiH1waXOGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZw==');
        notifSoundRef.current.volume = 0.3;
      }
      notifSoundRef.current.currentTime = 0;
      notifSoundRef.current.play().catch(() => {});
    } catch {}
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => { if (!document.hidden) { unreadCountRef.current = 0; updateTitle(); } };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [updateTitle]);

  const updateSettings = useCallback((settings: Partial<AppSettings>) => {
    dispatch({ type: 'UPDATE_SETTINGS', settings });
  }, []);

  const openGeneral = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_CHANNEL', channel: 'general' });
    dispatch({ type: 'CLEAR_UNREAD', channel: 'general' });
    dispatch({ type: 'SET_SEARCH_OPEN', open: false });
    unreadCountRef.current = 0;
    updateTitle();
  }, [updateTitle]);

  
  const openDm = useCallback((userId: string, nickname?: string) => {
    if (nickname) dispatch({ type: 'SET_DM_NAME', userId, nickname });
    dispatch({ type: 'SET_ACTIVE_CHANNEL', channel: userId });
    dispatch({ type: 'CLEAR_UNREAD', channel: userId });
    dispatch({ type: 'SET_SEARCH_OPEN', open: false });
    unreadCountRef.current = 0;
    updateTitle();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'dm_history', payload: { with: userId } }));
      wsRef.current.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
    }
  }, [updateTitle]);

  /**
   * Marks a conversation read when it is actually on screen and the window has it.
   *
   * Only then. A receipt sent for a chat nobody is looking at would be a claim about attention that was
   * never given, which is the one thing a tick must not be.
   */
  useEffect(() => {
    const channel = state.activeChannel;
    if (!state.userId || channel === 'general') return;
    if (typeof document === 'undefined' || document.hidden) return;
    const msgs = stateRef.current.dmMessages[channel] || [];
    const newest = msgs.length ? msgs[msgs.length - 1] : null;
    if (!newest || newest.senderId === state.userId) return;
    markReadRef.current(channel, newest.timestamp);
  }, [state.activeChannel, state.dmMessages, state.userId]);

  /**
   * The same for the public chat: opening it counts as having looked.
   *
   * Counted separately from the per-conversation count because there is no conversation list entry for
   * it, so nowhere else would clear it.
   */
  useEffect(() => {
    if (state.activeChannel !== 'general' || !state.userId) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    dispatch({ type: 'CLEAR_UNREAD', channel: 'general' });
  }, [state.activeChannel, state.userId, state.messages.length]);

  const refreshContacts = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
  }, []);

  const contactsRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One in-flight refresh at a time, so a burst of messages costs one round trip, not twenty. */
  const scheduleContactsRefresh = useCallback(() => {
    if (contactsRefreshRef.current) return;
    contactsRefreshRef.current = setTimeout(() => {
      contactsRefreshRef.current = null;
      refreshContacts();
    }, 400);
  }, [refreshContacts]);

  const mergePublicKeys = useCallback((incoming?: Record<string, JsonWebKey>) => {
    if (!incoming) return;
    publicKeysRef.current = { ...publicKeysRef.current, ...incoming };
    if (userIdRef.current && publicKeyRef.current) publicKeysRef.current[userIdRef.current] = publicKeyRef.current;
  }, []);

  /**
   * Turns a stored direct-message row into text. One decoder, because there used to be three.
   *
   * The live push, the history load and the paged history each had their own copy, and they drifted:
   * they preferred the ratchet branch and ignored the RSA payload, so a message written by an older
   * client rendered as [encrypted] in a conversation where everything else read fine, and nothing said
   * why. A direct message now has exactly one body, and one place that knows how to open it.
   *
   * A sender cannot decrypt its own message, so its own rows fall back to the local copy of the text
   * it just sent. That is the only reason [encrypted] ever appears for your own messages.
   */
  const readDmText = useCallback(async (m: any): Promise<string> => {
    let text = m.text || '';
    const peerId = peerOf(m);
    if (isDmBody(m.encrypted)) {
      try {
        const opened = await openFor(peerId, m.encrypted, privateKeyRef.current);
        if (opened !== null) text = opened;
        else if (!text) text = '[encrypted]';
      } catch {
        if (!text) text = '[encrypted]';
      }
    } else if (m.encrypted && privateKeyRef.current && userIdRef.current) {
      try {
        text = await decryptMessage(m.encrypted, userIdRef.current, privateKeyRef.current);
      } catch {
        if (!text) text = '[encrypted]';
      }
    }
    if (m.isOwn && (!text || text === '[encrypted]')) text = recallOwnMessageText(m.clientId) || text || '[encrypted]';
    // A private attachment carries its key inside the sealed text. It has to come off before anything is
    // shown, quoted, searched or copied - a key in a quote bubble would be a key pasted into somebody
    // else's chat. `decryptMedia` reads it from the stored text, which is left untouched.
    return openFileKeyFromText(text).text;
  }, []);

  const requestSessions = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
  }, []);

  const revokeSession = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'revoke_session', payload: { sessionId } }));
  }, []);

  const adminGetBanned = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_banned', payload: {} }));
  }, []);

  const dismissAdminError = useCallback(() => setAdminError(null), []);

  const refreshBlocked = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_blocked', payload: {} }));
  }, []);

  const blockUser = useCallback((userId: string, nickname?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'block_user', payload: nickname ? { nickname } : { userId } }));
  }, []);

  const unblockUser = useCallback((userId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'unblock_user', payload: { userId } }));
  }, []);

  /** Reports whether the request actually left, so the modal never sits on "Sending…" forever. */
  const reportUser = useCallback((targetId: string, reason: string, messageId?: string, source: 'profile' | 'message' = 'message'): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify({ type: 'report_user', payload: { targetId, reason, source, ...(messageId ? { messageId } : {}) } }));
    return true;
  }, []);

  const openProfile = useCallback((userId: string) => {
    requestedProfileIdRef.current = userId;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'profile_get', payload: { userId } }));
    }
  }, []);

  const closeProfile = useCallback(() => {
    requestedProfileIdRef.current = null;
    dispatch({ type: 'SET_PROFILE', profile: null });
  }, []);

  const openReport = useCallback((target: ProfileInfo) => {
    dispatch({ type: 'SET_REPORT_TARGET', target });
    dispatch({ type: 'SET_PROFILE', profile: null });
  }, []);

  const closeReport = useCallback(() => dispatch({ type: 'SET_REPORT_TARGET', target: null }), []);

  const backToProfile = useCallback(() => {
    const target = reportTargetRef.current;
    dispatch({ type: 'SET_REPORT_TARGET', target: null });
    if (target) dispatch({ type: 'SET_PROFILE', profile: target });
  }, []);

  const setMyAvatar = useCallback(async (dataUrl: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'avatar_set', payload: { dataUrl } }));
    }
  }, []);

  const removeMyAvatar = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'avatar_remove', payload: {} }));
    }
  }, []);

  const adminReports = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'admin_reports', payload: {} }));
  }, []);

  const adminBan = useCallback((nickname: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'admin_ban', payload: { nickname } }));
  }, []);

  const adminUnban = useCallback((nickname: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'admin_unban', payload: { nickname } }));
  }, []);

  const searchUsers = useCallback((query: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'search_users', payload: { query } }));
  }, []);

  const setSearchOpen = useCallback((open: boolean) => {
    dispatch({ type: 'SET_SEARCH_OPEN', open });
  }, []);

  const jumpTo = useCallback((messageId: string) => {
    dispatch({ type: 'JUMP_TO', messageId });
  }, []);

  /**
   * Search inside the conversation that is open.
   *
   * The server holds plaintext only for the public channel - a private message is stored as ciphertext
   * and there is nothing there to match against - so it is asked with the channel named, and the panel
   * says so rather than returning an empty list that looks like "no matches".
   */
  /**
   * Pins or unpins a message.
   *
   * Held per device rather than on the server, and that is deliberate. A pin is a personal reading
   * convenience - one person wants a link kept at the top of their view - and putting it on the server
   * would mean every account carries a list of which messages each reader thought worth keeping, which
   * is a record of what people find interesting in conversations they are only a bystander to.
   */
  const togglePin = useCallback((messageId: string, channel: string) => {
    const current = stateRef.current.pinned[channel] || [];
    const exists = current.some((m) => m.id === messageId);
    const source = findMessage(stateRef.current, messageId);
    if (!source) return;
    const next = exists
      ? current.filter((m) => m.id !== messageId)
      : [{ ...source, channel }, ...current].slice(0, 20);
    const pinned = { ...stateRef.current.pinned, [channel]: next };
    dispatch({ type: 'SET_PINNED', channel, messages: next });
    try {
      localStorage.setItem('wn_pinned', JSON.stringify(pinned));
    } catch { /* private mode: the pin just will not survive a reload */ }
  }, []);

  /**
   * Writes this account's keys out as a file.
   *
   * The private key goes in encrypted, under the account password, which is the same shape the backup
   * import already takes. A file that held the key in the clear would be a password-protected message
   * sitting in a downloads folder.
   */
  const exportKeys = useCallback(async () => {
    const nick = (nicknameRef.current || '').toLowerCase();
    const password = authRef.current?.password;
    const privateKey = privateKeyRef.current;
    const publicKey = publicKeyRef.current;
    if (!nick || !password || !privateKey || !publicKey) throw new Error('keys are not available');
    const bundle = await encryptPrivateKey(privateKey, password);
    bundle.publicKey = publicKey;
    const backup: KeyBackup = {
      version: 1,
      type: 'whispernet-key-backup',
      createdAt: new Date().toISOString(),
      nickname: nicknameRef.current || '',
      publicKey,
      encryptedPrivateKey: bundle,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whispernet-keys-${nick}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  /**
   * Moves the account onto a new password without touching the identity keys.
   *
   * The one thing that has to happen here and not deeper is updating what this tab believes the password
   * is: the ratchet stores, the own-message cache and the encrypted legacy key blob all take it from
   * authRef, and leaving it stale would have the next send written under a key nothing can open.
   *
   * The RSA public key is republished because the legacy envelope blob is sealed to it, so it has to be
   * readable under the new password too - otherwise incoming legacy messages stop decrypting the moment
   * the password changes.
   */
  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    const nick = nicknameRef.current || '';
    const privateKey = privateKeyRef.current;
    const publicKey = publicKeyRef.current;
    if (!nick || !privateKey || !publicKey) throw new Error('keys are not available');

    await changeAccountPassword({ nickname: nick, oldPassword, newPassword });

    // from here the material is already under the new password; only the bookkeeping is left
    authRef.current = authRef.current ? { ...authRef.current, password: newPassword } : null;
    setOwnMessageCachePassword(newPassword);
    const bundle = await encryptPrivateKey(privateKey, newPassword);
    bundle.publicKey = publicKey;
    localStorage.setItem(`wn_pk_${nick.toLowerCase()}`, JSON.stringify(bundle));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey, deviceId: getDeviceId(), identityKey: accountIdentityKeyBase64() } }));
    }
  }, []);

  const searchInChannel = useCallback((query: string, channel: string | null) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    dispatch({ type: 'SET_SEARCH_LOADING', loading: true });
    wsRef.current.send(JSON.stringify({
      type: 'search_messages',
      payload: { query: query.trim(), ...(channel ? { channel } : {}) },
    }));
  }, []);

  const copyMessageText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // a browser that will not hand over the clipboard still deserves an attempt through the old path
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }
  }, []);

  /**
   * Forwards a message as a new one of the sender's own.
   *
   * A forward is a new message, not a reference to the original: the recipient gets it in their own
   * conversation, under the sender's name, which is what "forward" has to mean once the original could be
   * deleted by somebody else. For the global chat it is posted there as an ordinary message.
   */
  const forwardMessage = useCallback(async (messageId: string, to: string) => {
    const source = findMessage(stateRef.current, messageId);
    if (!source) return;
    const text = (source.text || '').trim();
    if (!text) throw new Error('nothing to forward');
    if (to === 'general') {
      // Into the public channel, an attachment has to be re-uploaded and re-wrapped for the channel key,
      // which is a different operation from quoting the words somewhere else. Refused rather than half
      // done: a marker without its key would arrive as an attachment nobody can open, in a room where
      // every other attachment opens.
      if (parseMediaTag(text)) throw new Error('forward_media_to_channel_unsupported');
      sendMessageRef.current(text);
      return;
    }
    // The stored text has already had the attachment key stripped, so a forwarded photo arrives as a
    // marker with no key behind it — an image the recipient cannot open, in a conversation where every
    // other image opens. Refusing is the honest outcome; a forward that silently breaks is worse than one
    // that says it cannot.
    if (parseMediaTag(text)) throw new Error('forward_media_unsupported');
    await sendDmRef.current(to, text);
  }, []);

  /**
   * Tells the other end that this device is being typed into.
   *
   * Throttled, because a keystroke is not an event worth relaying: one signal every few seconds is
   * enough to keep the indicator alive, and the receiver expires it on its own if the typing stops.
   */
  const lastTypingSentRef = useRef<Record<string, number>>({});
  const notifyTyping = useCallback((channel: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const last = lastTypingSentRef.current[channel] || 0;
    if (now - last < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current[channel] = now;
    ws.send(JSON.stringify({ type: 'typing', payload: { channel } }));
  }, []);

  /** Says how far this device has read, at most once a couple of seconds. */
  const lastReadSentRef = useRef<Record<string, number>>({});
  const markRead = useCallback((channel: string, upTo: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!Number.isFinite(upTo) || upTo <= 0) return;
    const now = Date.now();
    const last = lastReadSentRef.current[channel] || 0;
    if (upTo <= (stateRef.current.readUpTo[channel] || 0)) return;
    if (now - last < 2000) return;
    lastReadSentRef.current[channel] = now;
    ws.send(JSON.stringify({ type: 'dm_read', payload: { channel, upTo } }));
    dispatch({ type: 'SET_READ', channel, upTo });
  }, []);
  markReadRef.current = markRead;

  const searchMessages = useCallback((query: string, channel?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'search_messages', payload: { query, channel } }));
  }, []);

  /**
   * The two keys a private message is ever wrapped to: the recipient's, and ours.
   *
   * This used to spread the whole directory the server hands out at sign-in, so every private message
   * carried a copy of its content key wrapped for every account on the server - which is to say that
   * every registered user could unwrap every direct message anybody had ever sent. Our own key is in
   * the list because a ratchet session belongs to one device and the copy is what lets this account's
   * other devices read what it sends; the recipient is the only other party that can ever open it.
   *
   * The same rule governs an attachment: `buildFileKeyMap` is already called with an explicit recipient
   * list, and the fix here keeps the two paths from drifting apart again.
   */
  const buildEncryptKeys = useCallback((peerId: string, peerKey: JsonWebKey): Record<string, JsonWebKey> => {
    const keys: Record<string, JsonWebKey> = {};
    if (userIdRef.current && publicKeyRef.current) keys[userIdRef.current] = publicKeyRef.current;
    if (peerId) keys[peerId] = peerKey;
    return keys;
  }, []);

  const ttlSecondsRef = (): number | undefined => {
    const ttl = stateRef.current.settings.disappearingTTL;
    if (ttl === '24h') return 86400;
    if (ttl === '7d') return 604800;
    if (ttl === '30d') return 2592000;
    return undefined;
  };
  const ttlSeconds = useCallback(ttlSecondsRef, []);

  const deleteMessage = useCallback((messageId: string) => {
    // The server records who wrote a message, so it can refuse anybody else's and remove this one
    // everywhere at once — every device, and after a reload, which is what sealed sender made
    // impossible for the sender of an anonymous message.
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'delete_message', payload: { messageId } }));
  }, []);

  const addReaction = useCallback((messageId: string, emoji: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'add_reaction', payload: { messageId, emoji } }));
  }, []);

  const removeReaction = useCallback((messageId: string, emoji: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'remove_reaction', payload: { messageId, emoji } }));
  }, []);

  /**
   * Corrects a message this account wrote.
   *
   * The server only ever holds ciphertext for a private chat, so it cannot rewrite the words. What it
   * can do is swap the ciphertext: the corrected text is encrypted again to the recipient's key here
   * and the server puts the new blob in place of the old one. Every device then decrypts it the same
   * way it decrypts any other message, and the correction reaches the recipient as well as the sender
   * — which is what could not happen while a message was anonymous.
   */
  const editMessage = useCallback((messageId: string, text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const general = stateRef.current.messages.find((m) => m.id === messageId);
    if (general) {
      ws.send(JSON.stringify({ type: 'edit_message', payload: { messageId, text } }));
      return;
    }
    const target = Object.values(stateRef.current.dmMessages)
      .flat()
      .find((m) => m.id === messageId);
    if (!target) return;
    const peerId = target.channel || target.senderId;
    if (!privateKeyRef.current) return;
    void (async () => {
      try {
        // The peer's bundles, if they are not already held. Without this a correction would go out as a
        // stateless envelope for want of a bundle it never asked for — the same downgrade the ratchet
        // path exists to avoid, reached by a side door.
        if (!hasBundlesFor(peerId)) await requestPeerBundleRef.current(peerId);
        const peerKey: JsonWebKey | undefined = publicKeysRef.current[peerId]
          ?? (await requestRecipientKeyRef.current(peerId))
          ?? undefined;
        if (!peerKey) return;

        // Sealed under the ratchet like any other message, one body per device. This used to go out as
        // a stateless envelope, which meant the *corrected* text was the one copy of it in the whole
        // system that a seized server could open — so editing a message was a way to downgrade it.
        const { payload: encrypted } = await sealForDevices(peerId, text.trim(), () =>
          encryptMessage(text.trim(), buildEncryptKeys(peerId, peerKey as JsonWebKey)));
        const ttl = ttlSeconds();
        // Only the ciphertext goes out. Sending the words alongside it would undo the whole point of
        // the message being private, and the server has no use for them: it swaps one body for another.
        ws.send(JSON.stringify({ type: 'edit_message', payload: { messageId, encrypted, ttl } }));
      } catch (e) {
        console.error('Could not re-encrypt an edited message:', e);
      }
    })();
  }, [buildEncryptKeys, ttlSeconds]);

  /**
 * The send path, reachable from callbacks declared above it.
 *
 * A correction has to fetch the peer's bundles the same way an ordinary send does, and those helpers are
 * declared further down. Going through a ref rather than closing over them directly is what lets `edit`
 * stay above them in the file without a temporal-dead-zone error at module scope — and it is the same
 * trick `sendDmRef` uses, for the same reason.
 */
const requestPeerBundleRef = useRef<(to: string) => Promise<boolean>>(async () => false);
const requestRecipientKeyRef = useRef<(to: string) => Promise<JsonWebKey | null>>(async () => null);

const connect = useCallback((nickname: string, password: string, isRegister: boolean) => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    authRef.current = { nickname, password, isRegister };
    credentialsRef.current = { nickname, password, isRegister };
    reconnectAttemptsRef.current = 0;
    dispatch({ type: 'SET_STATUS', status: 'connecting' });
    dispatch({ type: 'SET_AUTH_ERROR', error: null });
    dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      dispatch({ type: 'SET_WS', ws });

      ws.onopen = async () => {
        const auth = authRef.current;
            const deviceInfo = await getDeviceLabel();
        if (auth) {
          const nick = auth.nickname.toLowerCase();
          if (auth.isRegister) {
            const keys = await generateKeyPair();
            const bundle = await encryptPrivateKey(keys.privateKey, auth.password);
            bundle.publicKey = keys.publicKey;
            localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(bundle));
            localStorage.setItem(`wn_pub_${nick}`, JSON.stringify(keys.publicKey));
            privateKeyRef.current = keys.privateKey;
            publicKeyRef.current = keys.publicKey;
            ws.send(JSON.stringify({ type: 'auth_register', payload: { nickname: auth.nickname, password: auth.password, publicKey: keys.publicKey, deviceId: getDeviceId(), deviceInfo } }));
          } else {
            let savedKey = localStorage.getItem(`wn_pk_${nick}`);
            let savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
            if (!savedKey || !savedPubKey) {
              savedKey = localStorage.getItem('wn_private_key');
              savedPubKey = localStorage.getItem('wn_public_key');
              if (savedKey && savedPubKey) {
                localStorage.setItem(`wn_pk_${nick}`, savedKey);
                localStorage.setItem(`wn_pub_${nick}`, savedPubKey);
              }
            }
            if (savedKey && savedPubKey) {
              try {
                const parsed = JSON.parse(savedKey);
                if (isEncryptedBundle(parsed)) {
                  privateKeyRef.current = await decryptPrivateKey(parsed, auth.password);
                } else {
                  privateKeyRef.current = parsed;
                  const bundle = await encryptPrivateKey(parsed, auth.password);
                  bundle.publicKey = JSON.parse(savedPubKey);
                  localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(bundle));
                }
                publicKeyRef.current = JSON.parse(savedPubKey);
              } catch { privateKeyRef.current = null; publicKeyRef.current = null; }
            }
            ws.send(JSON.stringify({ type: 'auth_login', payload: { nickname: auth.nickname, password: auth.password, deviceId: getDeviceId(), deviceInfo } }));
          }
        }
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          switch (message.type) {
            case 'auth_success':
              adoptServerDeviceId(message.payload.deviceId);
    if (message.payload.uploadToken) {
      uploadTokenRef.current = message.payload.uploadToken;
      setUploadToken(message.payload.uploadToken);
      try { localStorage.setItem('wn_upload_token', message.payload.uploadToken); } catch { /* private mode */ }
    }
              setIsAdmin(message.payload.role === 'admin');
              accountId = message.payload.userId || '';
              dispatch({ type: 'SET_USER', userId: message.payload.userId, nickname: message.payload.nickname });
              dispatch({ type: 'SET_STATUS', status: 'connected' });
              dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });
              dispatch({ type: 'SET_AUTH_ERROR', error: null });
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'get_blocked', payload: {} }));
                wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
              }
              // The ratchet needs the account password to unlock its key material, and it publishes a
              // bundle so strangers can start a conversation. Both happen after sign-in rather than at
              // load because there is no password before it.
              if (authRef.current?.password) {
                void (async () => {
                  try {
                    await startRatchet(message.payload.userId, authRef.current!.password!);
                    // This account's own devices, kept so each outgoing message can be sealed to the
                    // other ones too. Without that list a second screen of the same account has no way to
                    // read anything, and the alternative used to be a copy wrapped to a long-lived key.
                    rememberOwnBundles(message.payload.preKeyBundles || {});
                    const bundle = await publishBundle();
                    if (bundle && ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'prekey_upload', payload: { bundle, deviceId: getDeviceId(), identityKey: accountIdentityKeyBase64() } }));
                    }
                  } catch (e) {
                    // A failure here is not fatal: without any prekey material a message falls back to
                    // the stateless envelope, which is less safe but always readable.
                    console.warn('[ratchet] could not start:', (e as Error).message);
                  }
                })();
              }
              publicKeysRef.current = message.payload.publicKeys || {};
              channelMediaKeyRef.current = typeof message.payload.channelMediaKey === 'string' ? message.payload.channelMediaKey : null;
              {
                const myId = message.payload.userId;
                const nick = message.payload.nickname.toLowerCase();
                const myPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (myId && myPubKey) { publicKeysRef.current[myId] = JSON.parse(myPubKey); publicKeyRef.current = JSON.parse(myPubKey); }
                else if (myId && message.payload.publicKeys?.[myId]) publicKeyRef.current = message.payload.publicKeys[myId];
              }
              {
                const nick = message.payload.nickname.toLowerCase();
                const pw = authRef.current?.password;
                const localBundle = localStorage.getItem(`wn_pk_${nick}`);
                const serverBlob = await fetchKeyBackup();
                if (serverBlob && pw) {
                  try {
                    const bundle = JSON.parse(serverBlob);
                    const restored = await decryptPrivateKey(bundle, pw);
                    privateKeyRef.current = restored;
                    if (bundle.publicKey) {
                      publicKeyRef.current = bundle.publicKey;
                      localStorage.setItem(`wn_pub_${nick}`, JSON.stringify(bundle.publicKey));
                    }
                    localStorage.setItem(`wn_pk_${nick}`, serverBlob);
                  } catch {  }
                }
                if (privateKeyRef.current && pw && !serverBlob && localBundle) {
                  ws.send(JSON.stringify({ type: 'key_backup_upload', payload: { blob: localBundle } }));
                }
              }
              if (!privateKeyRef.current) dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: true });
              dispatch({ type: 'SET_E2EE_READY', ready: !!privateKeyRef.current });
              if (message.payload.onlineUsers) dispatch({ type: 'SET_USERS', users: message.payload.onlineUsers.filter((u: User) => u.id !== message.payload.userId) });
              dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromUsers(message.payload.onlineUsers) });
               // The title is the account, not the open conversation, so it is derived from the
               // nickname the server just confirmed rather than from whatever channel is on screen.
               nicknameRef.current = message.payload.nickname;
               unreadCountRef.current = 0;
               updateTitle();

              if (authRef.current) {
                // under a non-extractable key that belongs to this browser profile, so the blob left in
                // storage is not the password with a thin disguise over it
                await storePassword(authRef.current.nickname, authRef.current.password);
                void retireLegacyFingerprint();
              }
              // the cache of this account's own outgoing messages is written as an encrypted box under
              // the password, so signing in is what unlocks it
              if (authRef.current?.password) setOwnMessageCachePassword(authRef.current.password);
              if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
              {
                const nick = message.payload.nickname.toLowerCase();
                const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (savedPubKey) ws.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: JSON.parse(savedPubKey) } }));
              }
              heartbeatWsRef.current = ws;
              heartbeatIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', payload: {} }));
              }, 15000);
              ws.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
              // messages that arrived while this device was closed, so they are not only ever seen live
              break;
            case 'auth_failure':
              dispatch({ type: 'SET_AUTH_ERROR', error: message.payload.reason });
              dispatch({ type: 'SET_STATUS', status: 'disconnected' });
              ws.close();
              break;
            case 'chat_history':
              dispatch({ type: 'SET_MESSAGES', messages: message.payload.messages.map((m: any) => ({ id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text: m.text || '', timestamp: m.timestamp, isOwn: m.isOwn, fileKey: m.fileKey, expiresAt: m.expiresAt || undefined, quotedMessageId: m.quotedMessageId ?? undefined, quotedMessageText: m.quotedMessageText ?? undefined, quotedMessageSender: m.quotedMessageSender ?? undefined, reactions: normalizeReactions(m.reactions) })) });
              dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromMessages(message.payload.messages) });
              dispatch({ type: 'SET_HISTORY_STATE', hasMore: message.payload.hasMore !== false, oldest: message.payload.messages.length ? message.payload.messages[0].timestamp : null });
              break;
            case 'chat_history_page': {
              const older = message.payload.messages.map((m: any) => ({ id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text: m.text || '', timestamp: m.timestamp, isOwn: m.isOwn, fileKey: m.fileKey, expiresAt: m.expiresAt || undefined, quotedMessageId: m.quotedMessageId ?? undefined, quotedMessageText: m.quotedMessageText ?? undefined, quotedMessageSender: m.quotedMessageSender ?? undefined, reactions: normalizeReactions(m.reactions) }));
              dispatch({ type: 'PREPEND_MESSAGES', messages: older });
              dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromMessages(message.payload.messages) });
              dispatch({ type: 'SET_HISTORY_STATE', hasMore: message.payload.hasMore !== false, oldest: older.length ? older[0].timestamp : null });
              break;
            }
             case 'dm_history': {
               mergePublicKeys(message.payload.publicKeys);
               const ch = message.payload.channel;
               const parts = ch.split(':');
               const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
               const msgs = await Promise.all(message.payload.messages.map(async (m: any) => {
                 const text = await readDmText(m);
                 return { id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text, timestamp: m.timestamp, isOwn: m.senderId === userIdRef.current, channel: otherId, fileKey: m.fileKey, expiresAt: m.expiresAt || undefined, quotedMessageId: m.quotedMessageId ?? undefined, quotedMessageText: m.quotedMessageText ?? undefined, quotedMessageSender: m.quotedMessageSender ?? undefined, reactions: normalizeReactions(m.reactions), encrypted: m.encrypted, clientId: m.clientId ?? undefined };
               }));
               // the whole conversation this time, so a message sent from another device is here too
                dispatch({ type: 'SET_DM_MESSAGES', channel: otherId, messages: msgs });
                dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromMessages(message.payload.messages) });
                dispatch({ type: 'SET_DM_HISTORY_STATE', channel: otherId, hasMore: message.payload.hasMore !== false, oldest: msgs.length ? msgs[0].timestamp : null });
                break;
              }
              case 'dm_history_page': {
                const ch = message.payload.channel;
                const parts = ch.split(':');
                const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
                const older = await Promise.all(message.payload.messages.map(async (m: any) => {
                  const text = await readDmText(m);
                  return { id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text, timestamp: m.timestamp, isOwn: m.senderId === userIdRef.current, channel: otherId, fileKey: m.fileKey, expiresAt: m.expiresAt || undefined, quotedMessageId: m.quotedMessageId ?? undefined, quotedMessageText: m.quotedMessageText ?? undefined, quotedMessageSender: m.quotedMessageSender ?? undefined, reactions: normalizeReactions(m.reactions), encrypted: m.encrypted, clientId: m.clientId ?? undefined };
                }));
dispatch({ type: 'PREPEND_DM_MESSAGES', channel: otherId, messages: older });
                dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromMessages(message.payload.messages) });
                dispatch({ type: 'SET_DM_HISTORY_STATE', channel: otherId, hasMore: message.payload.hasMore !== false, oldest: older.length ? older[0].timestamp : null });
                break;
              }

            case 'dm_message': {
              let msgText = message.payload.text || '';
              const ch = message.payload.channel || '';
              const parts = typeof ch === 'string' ? ch.split(':') : [];
              const otherId = userIdRef.current && parts.length === 2
                ? (parts[0] === userIdRef.current ? parts[1] : parts[0])
                : message.payload.senderId || '';
              if (message.payload.encrypted) msgText = await readDmText(message.payload);
              // A message that reached this conversation but carried no body for this device. The server
              // says so by sending the frame with nothing in it rather than dropping it, because a
              // conversation that silently skips messages is indistinguishable from a server hiding them.
              // Shown as unreadable rather than blank: an empty bubble reads as a rendering fault and
              // invites a reload that will not help.
              if (!msgText && !message.payload.isOwn) msgText = t('not_for_this_device');
              dispatch({ type: 'ADD_DM_MESSAGE', channel: otherId, message: { id: message.payload.id, senderId: message.payload.senderId, senderNickname: message.payload.senderNickname, text: msgText, timestamp: message.payload.timestamp, isOwn: message.payload.isOwn, channel: otherId, fileKey: message.payload.fileKey, expiresAt: message.payload.expiresAt || undefined, quotedMessageId: message.payload.quotedMessageId ?? undefined, quotedMessageText: message.payload.quotedMessageText ?? undefined, quotedMessageSender: message.payload.quotedMessageSender ?? undefined, reactions: normalizeReactions(message.payload.reactions), encrypted: message.payload.encrypted, clientId: message.payload.clientId ?? undefined } });
              dispatch({ type: 'SET_AVATARS', avatars: avatarFromSender(message.payload.senderId, message.payload.senderAvatar) });
              dispatch({ type: 'SET_DM_NAME', userId: otherId, nickname: message.payload.senderNickname });
              // the list is refreshed on the next tick rather than emptied here, which used to flash
              // "No chats yet" on every incoming message
              scheduleContactsRefresh();
              if (!message.payload.isOwn) {
                // a message that arrives while the conversation is open and the window is in front of
                // the reader has been read, so the tick on their side is not a lie
                const visible = otherId === stateRef.current.activeChannel && !document.hidden;
                if (visible && message.payload.timestamp > (stateRef.current.readUpTo[otherId] || 0)) {
                  markReadRef.current(otherId, message.payload.timestamp);
                } else {
                  dispatch({ type: 'BUMP_UNREAD', channel: otherId, delta: 1 });
                }
                unreadCountRef.current++; updateTitle(); fireNotification(`@${message.payload.senderNickname}`, msgText); playNotifSound();
              }
              break;
            }
            case 'chat_message':
              dispatch({ type: 'ADD_MESSAGE', message: { id: message.payload.id, senderId: message.payload.senderId, senderNickname: message.payload.senderNickname, text: message.payload.text || '', timestamp: message.payload.timestamp, isOwn: message.payload.isOwn, fileKey: message.payload.fileKey, expiresAt: message.payload.expiresAt || undefined, quotedMessageId: message.payload.quotedMessageId ?? undefined, quotedMessageText: message.payload.quotedMessageText ?? undefined, quotedMessageSender: message.payload.quotedMessageSender ?? undefined, reactions: normalizeReactions(message.payload.reactions) } });
              dispatch({ type: 'SET_AVATARS', avatars: avatarFromSender(message.payload.senderId, message.payload.senderAvatar) });
              if (!message.payload.isOwn) {
                if (stateRef.current.activeChannel !== 'general' || document.hidden) {
                  dispatch({ type: 'BUMP_UNREAD', channel: 'general', delta: 1 });
                }
                unreadCountRef.current++; updateTitle(); fireNotification(`@${message.payload.senderNickname}`, message.payload.text || ''); playNotifSound();
              }
              break;
            case 'chat_cleared':
              if (message.payload?.channel === 'general') {
                dispatch({ type: 'CLEAR_GENERAL' });
              }
              break;
            case 'dm_contacts':
              mergePublicKeys(message.payload.publicKeys);
              dispatch({ type: 'SET_CONTACTS', contacts: message.payload.contacts });
              dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromUsers(message.payload.contacts) });
              for (const c of message.payload.contacts || []) {
                if (c.id && c.nickname) dispatch({ type: 'SET_DM_NAME', userId: c.id, nickname: c.nickname });
              }
              break;
            case 'prekeys_changed': {
              // Somebody's ratchet keys moved - a new device, or one that reinstalled. The bundles held
              // for them are now stale, and keeping them means the next message is sealed to material
              // nobody holds any more, which arrives as a message nobody can read. Dropped, so the next
              // send fetches what is current and starts a session against it.
              const changed = message.payload?.userId;
              if (typeof changed === 'string') {
                forgetBundle(changed);
                bundleWaitersRef.current[changed] = false;
              }
              break;
            }
            case 'prekey_bundles': {
              // A peer we had no session with turns up here; remembering their bundles is what lets the
              // next message to them go under the ratchet instead of the envelope. One entry per device
              // they have signed in, so a message can be sealed for a phone and a laptop separately.
              const ids = Object.keys(message.payload.bundles || {});
              for (const id of ids) {
                if (Array.isArray(message.payload.bundles[id])) rememberBundles({ [id]: message.payload.bundles[id] });
                else rememberBundle(id, message.payload.bundles[id]);
                bundleWaitersRef.current[id] = true;
              }
              // The account-level identity keys a safety number is computed from, so verification does
              // not need a second round trip and cannot be quietly skipped.
              if (message.payload.identityKeys && typeof message.payload.identityKeys === 'object') {
                dispatch({ type: 'SET_PEER_IDENTITY_KEYS', keys: message.payload.identityKeys });
              }
              break;
            }
            case 'prekey_uploaded':
              break;
            case 'search_results':
              dispatch({ type: 'SET_SEARCH_RESULTS', results: message.payload.results });
              dispatch({ type: 'SET_AVATARS', avatars: avatarMapFromUsers(message.payload.results) });
              break;
             case 'message_search_results':
               dispatch({ type: 'SET_MESSAGE_SEARCH_RESULTS', results: message.payload.results });
               dispatch({ type: 'SET_SEARCH_LOADING', loading: false });
               break;
            case 'message_deleted':
              dispatch({ type: 'DELETE_MESSAGE', messageId: message.payload.messageId });
              break;
            case 'reaction_update': {
              const { messageId, emoji, userId, action } = message.payload;
              if (action === 'add') dispatch({ type: 'ADD_REACTION', messageId, emoji, userId });
              else if (action === 'remove') dispatch({ type: 'REMOVE_REACTION', messageId, emoji, userId });
              break;
            }
            case 'message_edited': {
              // A corrected private message arrives as ciphertext. It is opened here and the words are
              // filled in, rather than leaving the bubble holding a body nothing had read yet.
              const editedId = message.payload.messageId;
              if (message.payload.encrypted) {
                const channel = findDmChannelOf(stateRef.current, editedId);
                const opened = channel ? await readDmText({ ...findMessage(stateRef.current, editedId), encrypted: message.payload.encrypted }) : null;
                dispatch({ type: 'SET_MESSAGE_TEXT', messageId: editedId, text: opened || '' });
              }
              dispatch({
                type: 'UPDATE_MESSAGE',
                messageId: editedId,
                text: message.payload.text,
                encrypted: message.payload.encrypted,
                editedAt: message.payload.editedAt,
              });
              break;
            }
            case 'sessions_list':
              setSessions(message.payload.sessions);
              break;
             case 'typing':
               // relayed, never stored: a signal that arrives out of order or twice is harmless, and the
               // receiver expires it on its own clock
               if (message.payload?.channel) {
                 dispatch({ type: 'SET_TYPING', channel: message.payload.channel, until: Date.now() });
               }
               break;
             case 'dm_read':
               if (message.payload?.channel && typeof message.payload.upTo === 'number') {
                 dispatch({ type: 'SET_READ', channel: message.payload.channel, upTo: message.payload.upTo });
               }
               break;
             case 'session_revoked':
              if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
              break;
            case 'admin_reports':
              setReports(message.payload?.reports || []);
              break;
            case 'banned_list':
              setBannedUsers(message.payload?.banned || []);
              break;
            case 'admin_action':
              if (message.payload?.ok) {
                adminReports();
                adminGetBanned();
              }
              break;
            case 'blocked_list':
              setBlockedUsers((message.payload.users || []));
              break;
            case 'user_joined':
              dispatch({ type: 'ADD_USER', user: { id: message.payload.userId, nickname: message.payload.nickname } });
              dispatch({ type: 'SET_AVATARS', avatars: avatarFromSender(message.payload.userId, message.payload.avatar) });
              break;
            case 'user_left':
              dispatch({ type: 'REMOVE_USER', userId: message.payload.userId });
              break;
            case 'system_message':
              dispatch({ type: 'ADD_MESSAGE', message: { id: crypto.randomUUID(), senderId: 'system', senderNickname: '', text: message.payload.text, timestamp: Date.now(), isOwn: false } });
              break;
            case 'error':
              if (message.payload?.code === 'AVATAR_RATE_LIMITED' || message.payload?.code === 'INVALID_AVATAR') {
                alert(message.payload?.message || 'Error');
              }
              if (message.payload?.code === 'INVALID_PAYLOAD' || message.payload?.code === 'RATE_LIMITED' || message.payload?.code === 'INTERNAL') {
                if (stateRef.current.reportStatus === 'pending') {
                  dispatch({ type: 'SET_REPORT_STATUS', status: 'failed' });
                }
              }
              if (message.payload?.code === 'USER_NOT_FOUND' || message.payload?.code === 'FORBIDDEN') {
                setAdminError(message.payload?.message || message.payload?.code || 'Error');
              }
              console.error('Server error:', message.payload);
              break;
            case 'key_updated': {
              const nick = nicknameRef.current?.toLowerCase();
              if (nick) { const savedPubKey = localStorage.getItem(`wn_pub_${nick}`); if (savedPubKey && userIdRef.current) publicKeysRef.current = { ...publicKeysRef.current, [userIdRef.current]: JSON.parse(savedPubKey) }; }
              break;
            }
            case 'public_key_updated': {
              const { userId, publicKey } = message.payload;
              if (userId && publicKey) publicKeysRef.current = { ...publicKeysRef.current, [userId]: publicKey };
              break;
            }
            case 'heartbeat_ack':
              break;
            case 'report_received':
              dispatch({ type: 'SET_REPORT_STATUS', status: 'sent' });
              break;
            case 'report_failed':
              dispatch({ type: 'SET_REPORT_STATUS', status: 'failed' });
              break;
            case 'profile':
              if (message.payload?.profile) {
                const p = message.payload.profile;
                const requested = requestedProfileIdRef.current;
                if (requested && p.id !== requested) break;
                if (!requested && stateRef.current.profile) break;
                dispatch({
                  type: 'SET_PROFILE',
                  profile: {
                    ...p,
                    // The identity key is what a safety number is computed from, and it arrives with the
                    // profile so verification costs no extra round trip and cannot be skipped by a server
                    // that simply never sends it.
                    identityKey: typeof p.identityKey === 'string' ? p.identityKey : null,
                  },
                });
                if (p.avatar && p.avatar.ext) {
                  dispatch({ type: 'SET_AVATARS', avatars: { [p.id]: p.avatar } });
                } else if (p.id) {
                  dispatch({ type: 'SET_AVATARS', avatars: { [p.id]: { ext: null, updatedAt: null } } });
                }
              }
              break;
            case 'user_avatar':
              if (typeof message.payload?.userId === 'string') {
                const incoming = message.payload.avatar && message.payload.avatar.ext
                  ? message.payload.avatar
                  : { ext: null, updatedAt: null };
                const uid = message.payload.userId;
                const current = stateRef.current.avatars[uid];
                if (current && incoming.updatedAt !== null && current.updatedAt !== null && incoming.updatedAt < current.updatedAt) break;
                dispatch({ type: 'SET_AVATARS', avatars: { [uid]: incoming } });
              }
              break;
          }
        } catch (e) { console.error('Message parse error:', e); }
      };

      ws.onclose = () => {
        if (heartbeatWsRef.current === ws) {
          if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
          heartbeatWsRef.current = null;
        }
        if (wsRef.current === ws) {
          wsRef.current = null;
          dispatch({ type: 'SET_WS', ws: null });
        } else {
          return; 
        }
        const creds = credentialsRef.current;
        if (userIdRef.current && creds) {
          const attempts = reconnectAttemptsRef.current;
          if (attempts < 10) {
            dispatch({ type: 'SET_STATUS', status: 'reconnecting' });
            const delay = Math.min(2000 * Math.pow(2, attempts), 30000);
            reconnectAttemptsRef.current = attempts + 1;
            dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: attempts + 1 });
            reconnectTimeoutRef.current = setTimeout(() => {
              const c = credentialsRef.current;
              if (c && userIdRef.current) connect(c.nickname, c.password, c.isRegister);
            }, delay);
          } else {
            dispatch({ type: 'SET_STATUS', status: 'disconnected' });
          }
        } else {
          dispatch({ type: 'SET_STATUS', status: 'disconnected' });
        }
      };

      ws.onerror = () => {};
    } catch {
      dispatch({ type: 'SET_STATUS', status: 'disconnected' });
    }
    // readDmText, mergePublicKeys and scheduleContactsRefresh are stable callbacks declared further
    // down. They are named here because the frame handler calls them, and a stale copy would decrypt
    // with a key the user has since replaced. So are the notification helpers and the two admin calls
    // the frame handler reaches for, and `t` — which changes with the language and names the string a
    // message this device cannot read is shown under.
  }, [readDmText, mergePublicKeys, scheduleContactsRefresh, updateTitle, adminGetBanned, adminReports, fireNotification, playNotifSound, t]);

  
  
  
  useEffect(() => {
    const kick = () => {
      if (document.hidden) return;
      if (!userIdRef.current || !credentialsRef.current) return;
      if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.CONNECTING) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'heartbeat', payload: {} })); } catch {}
        return;
      }
      const c = credentialsRef.current;
      dispatch({ type: 'SET_STATUS', status: 'connecting' });
      reconnectAttemptsRef.current = 0;
      dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });
      connect(c.nickname, c.password, c.isRegister);
    };
    const onVis = () => { if (!document.hidden) kick(); };
    const onOnline = () => kick();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
    };
  }, [connect]);

  const disconnect = useCallback(() => {
    // Both managers debounce their writes, so signing out inside that window would drop the session and
    // the identity key. Neither loss is recoverable: the messages already sent under the discarded keys
    // could never be opened again by this device.
    flushRatchet();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = null;
    heartbeatWsRef.current = null;
    authRef.current = null;
    credentialsRef.current = null;
    reconnectAttemptsRef.current = 0;
    userIdRef.current = null;
    // an acknowledgement can only arrive on the socket that carried the request, so anything still
    // waiting will never be drawn and is dropped rather than kept for the life of the tab
    if (wsRef.current) { wsRef.current.close(1000, 'User disconnected'); wsRef.current = null; dispatch({ type: 'SET_WS', ws: null }); }
    dispatch({ type: 'SET_STATUS', status: 'disconnected' });
  }, []);

  const reconnect = useCallback(() => {
    const creds = credentialsRef.current;
    if (creds) { dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 }); reconnectAttemptsRef.current = 0; connect(creds.nickname, creds.password, creds.isRegister); }
  }, [connect]);

  const logout = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'revoke_session', payload: {} }));
    }
    disconnect();

    for (const url of decryptedMediaCacheRef.current.values()) { try { URL.revokeObjectURL(url); } catch {} }
    decryptedMediaCacheRef.current.clear();
    decryptedMediaRefsRef.current.clear();
    dispatch({ type: 'RESET' });
    clearStoredAuth();
    // The device id stays. Signing out used to delete it, so the next sign-in arrived with a new one and
    // spent another of the three session slots the account is allowed - three sign-out-and-back-in cycles
    // and the owner was locked out of their own account with no device left to revoke one from. Signing out
    // revokes the session, which frees the slot; the device keeps its identity.
    //
    // Settings stay too. Theme, language, font size and disappearing-message defaults belong to the
    // browser, not to the account, and losing them on every sign-out was pure annoyance.
    forgetOwnMessages();
    setOwnMessageCachePassword('');
    // and the write that may still be in flight is waited on, so a debounced store cannot land after
    // the clear and put the words back
    void flushOwnMessageCache();
    // the decrypted key material does not outlive the session that unlocked it
    privateKeyRef.current = null;
    publicKeyRef.current = null;
    publicKeysRef.current = {};
    accountId = '';
    nicknameRef.current = null;
    unreadCountRef.current = 0;
    updateTitle();
  }, [disconnect, updateTitle]);

  const getMyPublicKey = useCallback((): JsonWebKey | null => publicKeyRef.current, []);
  const getPublicKey = useCallback((userId: string): JsonWebKey | null => publicKeysRef.current[userId] || null, []);

  const decryptedMediaCacheRef = useRef<Map<string, string>>(new Map());
  const decryptedMediaRefsRef = useRef<Map<string, number>>(new Map());
  const channelMediaKeyRef = useRef<string | null>(null);

  const decryptMedia = useCallback(async (message: { id: string; text: string; fileKey?: Record<string, string> }): Promise<string | null> => {
    const cached = decryptedMediaCacheRef.current.get(message.id);
    if (cached) return cached;

    // The key may be inside the sealed text, which is where a private attachment has carried it since
    // the wrapped-key map was retired, or in that map, which is where a public-channel attachment has
    // it and where every attachment sent before the change still has it. Both are tried, in that order,
    // because a message in somebody's history is not re-sendable and a key that stops being readable
    // takes the photo with it.
    const { text: withoutKey, entry: inlineEntry } = openFileKeyFromText(message.text);
    const source = withoutKey || message.text;
    if (!inlineEntry && !message.fileKey) return null;
    const mediaMatch = source.match(/^\[(image|video)\]([\s\S]*?)\[\/\1\]/);
    if (!mediaMatch) return null;
    let url = mediaMatch[2];
    url = mediaProxyUrl(url);
    let blob: Blob | null = null;

    if (inlineEntry) {
      try { blob = await openAttachmentWithKey(inlineEntry, url); } catch (e) { console.error('Failed to open media from the sealed key:', e); }
    }

    if (!blob && privateKeyRef.current) {
      const entry = message.fileKey?.[userIdRef.current || ''];
      if (entry) {
        try { blob = await unwrapAndDecrypt(entry, url, privateKeyRef.current); } catch (e) { console.error('Failed to decrypt media with own key:', e); }
      }
    }
    if (!blob && message.fileKey) {
      const entry = message.fileKey['channel'];
      if (entry && channelMediaKeyRef.current) {
        try { blob = await unwrapAndDecryptChannel(entry, url, channelMediaKeyRef.current); } catch (e) { console.error('Failed to decrypt channel media:', e); }
      }
    }
    if (!blob) return null;
    try {
      const objectUrl = URL.createObjectURL(blob);
      decryptedMediaCacheRef.current.set(message.id, objectUrl);
      evictDecryptedMedia();
      return objectUrl;
    } catch (e) {
      console.error('Failed to create object URL:', (e as Error).message);
      return null;
    }
  }, []);

  /**
   * Object URLs are reference counted by the bubbles that show them. Dropping the oldest entry
   * unconditionally blanked an image that was still on screen the moment the hundred-and-first media
   * message arrived.
   */
  function retainMedia(id: string): void {
    decryptedMediaRefsRef.current.set(id, (decryptedMediaRefsRef.current.get(id) ?? 0) + 1);
  }

  function releaseMedia(id: string): void {
    const refs = decryptedMediaRefsRef.current.get(id);
    if (refs === undefined) return;
    // leave the entry at zero rather than removing it: a bubble whose effect re-runs releases and
    // immediately retains, and a missing entry read as "nobody wants this" let the cache revoke a url
    // that was still on screen
    if (refs <= 1) decryptedMediaRefsRef.current.set(id, 0);
    else decryptedMediaRefsRef.current.set(id, refs - 1);
  }

  function evictDecryptedMedia(): void {
    if (decryptedMediaCacheRef.current.size <= MEDIA_CACHE_LIMIT) return;
    // only entries nothing points at any more
    for (const [id, url] of decryptedMediaCacheRef.current) {
      if ((decryptedMediaRefsRef.current.get(id) ?? 0) > 0) continue;
      decryptedMediaCacheRef.current.delete(id);
      try { URL.revokeObjectURL(url); } catch { /* already gone */ }
      if (decryptedMediaCacheRef.current.size <= MEDIA_CACHE_LIMIT) return;
    }
  }

  /** Asks the server for the page of messages older than the oldest one we hold. */
  const loadOlderMessages = useCallback(async (channel: string | null, before: number | null) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (channel) {
      const existing = stateRef.current.dmMessages[channel] || [];
      const oldest = before ?? (existing.length ? existing[0].timestamp : null);
      if (!oldest) return;
      ws.send(JSON.stringify({ type: 'dm_history', payload: { with: channel, before: oldest, limit: 50 } }));
      return;
    }
    const existing = stateRef.current.messages;
    const oldest = before ?? (existing.length ? existing[0].timestamp : null);
    if (!oldest) return;
    ws.send(JSON.stringify({ type: 'chat_history', payload: { before: oldest, limit: 50 } }));
  }, []);

  const sendMessage = useCallback(async (text: string, quoted?: ReplyTarget) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;
    const payload: any = { text: text.trim(), ttl: ttlSeconds() };
    if (quoted) payload.quoted = { id: quoted.id, text: quoted.text, sender: quoted.senderNickname };
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload }));
  }, [ttlSeconds]);

  /** The public-chat send path, reachable from callbacks declared above it. */
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const keyWaitersRef = useRef<Record<string, Promise<JsonWebKey | null>>>({});
  /** Peers whose bundle has arrived, so a send knows it can build a session without asking again. */
  const bundleWaitersRef = useRef<Record<string, boolean>>({});
  /** The recipient key can be missing right after a reconnect; ask for it once and wait briefly. */
  const requestRecipientKey = useCallback((to: string): Promise<JsonWebKey | null> => {
    const pending = keyWaitersRef.current[to];
    if (pending) return pending;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const wait = (async () => {
      ws.send(JSON.stringify({ type: 'dm_history', payload: { with: to } }));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const key = publicKeysRef.current[to];
        if (key) return key;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    })().finally(() => { delete keyWaitersRef.current[to]; });
    keyWaitersRef.current[to] = wait;
    return wait;
  }, []);

  /** Fetches the peer's published bundle, without which no session can be started. */
  const requestPeerBundle = useCallback(async (to: string): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'prekey_fetch', payload: { userIds: [to] } }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (bundleWaitersRef.current[to]) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }, []);

  const sendDmPackage = useCallback(async (
    to: string,
    options: { text: string; fileKey?: Record<string, string>; quoted?: ReplyTarget }
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new MediaError('offline');
    let recipientKey: JsonWebKey | undefined = publicKeysRef.current[to];
    if (!recipientKey) recipientKey = (await requestRecipientKey(to)) ?? undefined;
    if (!privateKeyRef.current || !recipientKey) throw new MediaError('keys');
    const content = options.text.trim();
    if (!content && !options.fileKey) return;
    const clientId = newClientMessageId();
    // The recipient is named by id and the key is sent alongside it rather than instead of it. The
    // server then has one row to look up and can check the two agree, so a message cannot be steered
    // at whichever account happens to hold a key the sender used to have.
    const payload: any = { to, toKey: recipientKey, text: '', ttl: ttlSeconds(), clientId };
    if (options.fileKey) payload.fileKey = options.fileKey;
    if (options.quoted) payload.quoted = { id: options.quoted.id, text: options.quoted.text, sender: options.quoted.senderNickname };
    if (!bundleWaitersRef.current[to] && !hasBundlesFor(to)) await requestPeerBundle(to);
    // One sealed body per device that should read this: each of the recipient's, plus each of this
    // account's other devices so a second screen is not left out of its own conversation. Nothing here
    // shares key material between devices, so taking one phone does not open the laptop.
    //
    // The stateless envelope is built only as a floor, for a peer who has published no bundle at all -
    // it is no longer attached to every message, because a copy under a long-lived key meant seizing
    // the server opened the whole history regardless of what the ratchet had achieved.
    const { payload: body, failedDevices } = await sealForDevices(to, content, () =>
      encryptMessage(content, buildEncryptKeys(to, recipientKey)));
    payload.encrypted = body;
    if (failedDevices.length > 0) {
      // Recorded on the message rather than left in a console nobody reads. A device that could not be
      // reached is a fact about the conversation, and the alternative - a message that looks delivered
      // everywhere and is readable nowhere - is the failure this whole change exists to remove.
      dispatch({ type: 'SET_UNREACHABLE_DEVICES', peerId: to, devices: failedDevices });
    }

    // A fresh conversation had to be started because one of the peer's devices is no longer publishing
    // the key this conversation was built on - a reinstall, or a server handing out a key nobody asked
    // for. Worth saying out loud: their account identity key is unchanged, so their safety number still
    // matches, and it is this device's key that moved.
    if (peerIdentityChanged(to)) {
      dispatch({ type: 'SET_IDENTITY_CHANGED', peerId: to });
      clearIdentityChanged(to);
    }

    // Sent the ordinary way, with the sender recorded. Anonymity here used to mean the server filed
    // the message under an addressee-only channel, which meant it could never return it: the sender
    // could not see their own message on another device, and neither could the recipient after a
    // reload. Being able to edit, delete and read your own history everywhere is worth more here than
    // the relay not knowing, and the text itself is still only ever readable by the two of you.
    ws.send(JSON.stringify({ type: 'dm_send', payload }));
    // the sender cannot decrypt its own ciphertext, so keep the plaintext to render our own message later
    rememberOwnMessageText(clientId, content);
  }, [buildEncryptKeys, ttlSeconds, requestRecipientKey, requestPeerBundle]);

  const sendDm = useCallback(async (to: string, text: string, quoted?: ReplyTarget) => {
    if (!text.trim()) return;
    await sendDmPackage(to, { text, quoted });
  }, [sendDmPackage]);

  /** The send path, reachable from callbacks declared above it. */
  const sendDmRef = useRef(sendDm);
  sendDmRef.current = sendDm;

  requestPeerBundleRef.current = requestPeerBundle;
  requestRecipientKeyRef.current = requestRecipientKey;

  const getMediaTag = (type: string): string => type.startsWith('video/') ? 'video' : 'image';

  /**
 * Encrypts an attachment and produces the text that will carry it.
 *
 * The file key is folded into that text rather than put in the payload beside it. That is the whole
 * point: the payload is what the server stores, so a key there is a key on the server, and wrapping it
 * to a long-lived RSA key meant seizing the server opened every attachment ever sent in every private
 * chat. Folded in, the key is sealed under the ratchet exactly like the words are - one copy per device,
 * forward secrecy, and nothing on the server that opens it.
 *
 * The public channel keeps the old wrapped map, because a room with no members to encrypt to has no
 * other option; `channelMediaKeyB64` being present is what decides which of the two shapes comes back.
 */
const prepareEncryptedMedia = useCallback(async (
    file: File,
    recipientIds: string[],
    channelMediaKeyB64?: string | null
  ): Promise<{ text: string; fileKey?: Record<string, string> }> => {
    // encrypted a chunk at a time and posted as it is produced, so a large attachment never has to
    // exist whole in memory on either side
    const enc = await encryptFileStream(file);
    const url = await uploadStream(enc.stream, 'media.png', 'image/png');
    const tag = getMediaTag(file.type);
    const plain = `[${tag}]${url}[/${tag}]`;

    if (!channelMediaKeyB64) {
      return { text: sealFileKeyInText(plain, enc.rawKey, enc.ivB64) };
    }

    const fileKey = await buildFileKeyMap(
      enc.rawKey,
      recipientIds,
      (id) => publicKeysRef.current[id],
      userIdRef.current || '',
      publicKeyRef.current,
      enc.ivB64,
      channelMediaKeyB64
    );
    return { text: plain, fileKey: Object.keys(fileKey).length > 0 ? fileKey : undefined };
  }, []);

  const sendImage = useCallback(async (file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) throw new MediaError('offline');
    const tag = file.type.startsWith('video/') ? 'video' : 'image';
    let url: string;
    try {
      url = await uploadFile(file, file.name || 'media.png');
    } catch (e) {
      if (e instanceof MediaError) throw e;
      throw new MediaError('upload');
    }
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: `[${tag}]${url}[/${tag}]`, ttl: ttlSeconds() } }));
  }, [ttlSeconds]);

  const sendDmImage = useCallback(async (to: string, file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) throw new MediaError('offline');
    if (!publicKeysRef.current[to] || !privateKeyRef.current) throw new MediaError('keys');
    let text: string;
    let fileKey: Record<string, string> | undefined;
    try {
      // no channel key, so the attachment key is folded into the sealed text rather than sent beside it
      ({ text, fileKey } = await prepareEncryptedMedia(file, [to], null));
    } catch {
      throw new MediaError('upload');
    }
    await sendDmPackage(to, { text, fileKey });
  }, [prepareEncryptedMedia, sendDmPackage]);

  useEffect(() => {
    const saved = localStorage.getItem('wn_auth');
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const stored = await readStoredAuth();
        if (cancelled || !stored || !stored.nickname || !stored.password) return;
        // the nickname inside the blob is only a convenience: the one typed is what the account is, and
        // the server is the authority on which is right
        connect(stored.nickname, stored.password, false);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [connect]);

  return (
    <>
      {state.needsKeySetup && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
          <div className="bg-bg-secondary rounded-3xl border border-border-default p-6 max-w-sm w-full space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/15 flex items-center justify-center mx-auto">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary text-center">{t('key_setup_title')}</h2>
            <p className="text-[13px] text-fg-muted text-center leading-relaxed">{t('key_setup_desc')}</p>
            <div className="space-y-2">
              <label className="block">
                <input type="file" accept=".json" className="hidden" id="key-setup-import" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!isKeyBackup(data)) { alert(t('key_import_err')); return; }
                    setImportModal({ data, mode: 'setup' });
                  } catch { alert(t('key_import_err')); }
                  e.target.value = '';
                }} />
                <span className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 transition-all cursor-pointer">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  {t('import_keys')}
                </span>
              </label>
              <button onClick={async () => {
                if (!confirm(t('key_setup_new_confirm'))) return;
                const keys = await generateKeyPair();
                const nick = authRef.current?.nickname.toLowerCase() || '';
                if (authRef.current) {
                  const bundle = await encryptPrivateKey(keys.privateKey, authRef.current.password);
                  bundle.publicKey = keys.publicKey;
                  localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(bundle));
                  if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'key_backup_upload', payload: { blob: JSON.stringify(bundle) } }));
                } else {
                  localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(keys.privateKey));
                }
                dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: false });
                dispatch({ type: 'SET_E2EE_READY', ready: true });
              }} className="w-full py-3 rounded-2xl border border-border-default text-fg-primary font-medium hover:bg-bg-tertiary transition-all">
                {t('key_setup_new')}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConnectionContext.Provider value={{
        state, dispatch, connect, reconnect, disconnect, logout,
        sendMessage, sendDm, sendDmImage, sendImage,
        openDm, openGeneral, refreshContacts,
        searchUsers, searchMessages, deleteMessage,
        addReaction, removeReaction, editMessage,
        setReply:
          (reply) => dispatch({ type: 'SET_REPLY', reply }),
        editingTarget, setEditing: setEditingTarget,
        isAdmin, reports, adminReports, adminBan, adminUnban,
        t, updateSettings, getMyPublicKey, getPublicKey, decryptMedia, retainMedia, releaseMedia, loadOlderMessages,
        
        sessions, requestSessions, revokeSession,
        bannedUsers, adminGetBanned, adminError, dismissAdminError,
        blockedUsers, refreshBlocked, blockUser, unblockUser, reportUser,
        notifyTyping, markRead,
        setSearchOpen, jumpTo, togglePin, copyMessageText, forwardMessage, exportKeys, changePassword,
        searchInChannel,
        showImportModal: (data: any, mode: 'setup' | 'settings') => setImportModal({ data, mode }),
        openProfile, closeProfile, openReport, closeReport, backToProfile, setMyAvatar, removeMyAvatar,
      }}>
        {children}
        <ProfileOverlay />
      </ConnectionContext.Provider>      {importModal && (
        <div className="fixed inset-0 z-[70]">
          <PasswordModalInline title={t('enter_backup_password')} cancelLabel={t('cancel')} onCancel={() => setImportModal(null)} onConfirm={async (pass) => {
            try {
              const data = importModal.data;
              const privKey = await decryptPrivateKey(data.encryptedPrivateKey, pass);
              const pubKey = data.publicKey;
              const nick = data.nickname.toLowerCase();
              const bundle = await encryptPrivateKey(privKey, authRef.current?.password || pass);
              bundle.publicKey = pubKey;
              localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(bundle));
              localStorage.setItem(`wn_pub_${nick}`, JSON.stringify(pubKey));
              privateKeyRef.current = privKey;
              publicKeyRef.current = pubKey;
              if (userIdRef.current) publicKeysRef.current[userIdRef.current] = pubKey;
              if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: pubKey, deviceId: getDeviceId(), identityKey: accountIdentityKeyBase64() } }));
              if (importModal.mode === 'setup') dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: false });
              dispatch({ type: 'SET_E2EE_READY', ready: true });
            } catch { alert(t('key_import_err')); }
            setImportModal(null);
          }} />
        </div>
      )}
    </>
  );
}

/** The count bubble on a conversation that has something new in it. */
function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-accent-primary text-accent-text text-[10px] font-bold flex items-center justify-center border-2 border-bg-secondary">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function ProfileOverlay() {  const { state, closeReport, backToProfile } = useConnection();
  if (state.reportTarget) {
    return (
      <ReportModal
        targetId={state.reportTarget.id}
        targetNickname={state.reportTarget.nickname}
        avatar={state.avatars[state.reportTarget.id] ?? state.reportTarget.avatar}
        onClose={closeReport}
        onBack={backToProfile}
      />
    );
  }
  if (!state.profile) return null;
  return <ProfileModal profile={state.profile} />;
}

function PasswordModalInline({ title, cancelLabel, onConfirm, onCancel }: { title: string; cancelLabel: string; onConfirm: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEscapeKey(onCancel, true, 61);
  return (
    <div className="fixed inset-0 z-[61] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60" />
        <div className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6"
          onClick={(e) => e.stopPropagation()}>
          <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-4">{title}</h3>
          <input ref={inputRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && password) onConfirm(password); }}
            className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-4"
            placeholder="Password" />
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">{cancelLabel}</button>
            <button onClick={() => password && onConfirm(password)} disabled={!password} className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40">OK</button>
          </div>
        </div>
    </div>
  );
}

function AppInner() {
  const { state, t, reconnect, openGeneral, openDm, openProfile, searchUsers } = useConnection();
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<'home' | 'settings'>('home');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const inDm = state.activeChannel !== 'general';
  useEscapeKey(() => {
    if (inDm) {
      openGeneral();
      if (isMobile) setMobileChatOpen(false);
    }
  }, inDm, 30, false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth >= 768) setMobileChatOpen(false); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Read from settings, which is where the toggle writes it. This used to read a `wn_screenshot_prot`
  // key that nothing ever set, so the switch in Settings moved and nothing happened at all.
  const screenshotOn = state.settings.screenshotProtection;
  useEffect(() => {
    const on = screenshotOn;
    document.body.classList.toggle('screenshot-protect', on);
    const syncBlur = () => document.body.classList.toggle('screenshot-hidden', on && typeof document.hidden === 'boolean' && document.hidden);
    const onBlur = () => { if (on) document.body.classList.add('screenshot-blurred'); };
    const onFocus = () => document.body.classList.remove('screenshot-blurred');
    const handler = (e: Event) => { if (on) e.preventDefault(); };
    if (on) { document.addEventListener('contextmenu', handler); document.addEventListener('selectstart', handler); }
    document.addEventListener('visibilitychange', syncBlur);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    syncBlur();
    return () => {
      document.removeEventListener('contextmenu', handler);
      document.removeEventListener('selectstart', handler);
      document.removeEventListener('visibilitychange', syncBlur);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      if (!on) {
        document.body.classList.remove('screenshot-protect', 'screenshot-blurred', 'screenshot-hidden');
      }
    };
  }, [screenshotOn]);

  const mobileChatOpenRef = useRef(mobileChatOpen);
  mobileChatOpenRef.current = mobileChatOpen;
  const mobileTabRef = useRef(mobileTab);
  mobileTabRef.current = mobileTab;
  const openGeneralRef = useRef(openGeneral);
  openGeneralRef.current = openGeneral;
  const inDmRef = useRef(state.activeChannel !== 'general');
  inDmRef.current = state.activeChannel !== 'general';
  useEffect(() => {
    const applyBack = (exitOnRoot: boolean) => {
      const action = resolveBackAction({
        typing: isTypingTarget(document.activeElement),
        modalOpen: hasEscapeLayerAtLeast(40),
        chatOpen: mobileChatOpenRef.current,
        settingsOpen: mobileTabRef.current === 'settings',
        inDm: inDmRef.current,
      });
      if (action === 'blur-input') { (document.activeElement as HTMLElement).blur(); return; }
      if (action === 'dismiss-modal') { runTopEscapeLayer(40); return; }
      if (action === 'close-chat') { setMobileChatOpen(false); setSearchQuery(''); return; }
      if (action === 'close-settings') { setMobileTab('home'); setSearchQuery(''); return; }
      if (action === 'open-general') { openGeneralRef.current(); return; }
      // only the home screen is left, and there the gesture may leave the app
      if (!exitOnRoot) return;
      try { CapacitorApp.exitApp(); } catch {}
    };

    // without the App plugin Capacitor closes the activity on back whenever the WebView has
    // no history to pop, so the listener has to be registered through the plugin itself
    let handler: { remove: () => Promise<void> } | undefined;
    CapacitorApp.addListener('backButton', () => applyBack(true)).then((h) => { handler = h; }).catch(() => {});
    const onPopstate = () => applyBack(false);
    window.addEventListener('popstate', onPopstate);
    return () => {
      window.removeEventListener('popstate', onPopstate);
      try { handler?.remove(); } catch {}
    };
  }, []);

  const pushView = useCallback((kind: 'chat' | 'settings') => {
    try { window.history.pushState({ wn: kind }, ''); } catch {}
  }, []);

  const popView = useCallback(() => {
    try { window.history.back(); } catch {}
  }, []);

  if (state.status !== 'connected' && state.userId) {
    const isDisconnected = state.status === 'disconnected';
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary p-4">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          {isDisconnected ? (
            <>
              <div className="w-16 h-16 rounded-2xl bg-status-error/15 flex items-center justify-center">
                <svg className="w-8 h-8 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 000-7.07m-4.243 2.121a1.5 1.5 0 012.121 2.121m-5.657 0l-2.12 2.12M5.636 5.636l12.728 12.728" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-fg-primary mb-1">{t('status_disconnected')}</h2>
                <p className="text-[13px] text-fg-muted">{state.status === 'reconnecting' ? t('reconnecting') : t('server_unreachable')}</p>
              </div>
              <button onClick={reconnect} className="px-6 py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 transition-all">{t('retry')}</button>
            </>
          ) : (
            <>
              <svg className="animate-spin h-8 w-8 text-accent-primary" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <div className="text-sm text-fg-muted">{t('connecting')}</div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!state.userId) return <LoginScreen />;

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) searchUsers(value.trim());
    }, 300);
  };

  const mobileContacts = state.contacts.filter(c =>
    !searchQuery.trim() || c.nickname.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-bg-primary">
        <div className="flex-1 min-h-0">
          {mobileTab === 'home' && !mobileChatOpen && (
            <div className="h-full flex flex-col">
              <div className="px-5 pt-6 pb-3">
                <div className="flex items-center gap-3.5 mb-4">
                  <img src="/logo.svg" alt="WhisperNet" className="w-12 h-12" />
                  <div>
                    <h1 className="text-[22px] font-bold text-fg-primary">WhisperNet</h1>
                    <p className="text-[12px] text-fg-muted">{state.status === 'connected' ? t('status_connected') : t('status_connecting')}</p>
                  </div>
                  <button
                    onClick={() => { if (state.userId) openProfile(state.userId); }}
                    className="ml-auto flex items-center gap-2 px-2.5 py-1.5 rounded-2xl bg-bg-tertiary border border-border-default hover:bg-bg-tertiary/80 transition-colors"
                    aria-label={t('my_profile')}
                  >
                    <Avatar userId={state.userId || ''} nickname={state.nickname} avatar={state.userId ? state.avatars[state.userId] : null} className="w-8 h-8 rounded-full" textClassName="text-[11px]" />
                    <span className="text-[13px] font-semibold text-fg-primary">@{state.nickname}</span>
                  </button>
                </div>
                <input type="text" value={searchQuery} onChange={(e) => handleSearch(e.target.value)}
                  placeholder={t('search_placeholder')}
                  className="w-full px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary" />
              </div>
              <div className="flex-1 overflow-y-auto">
                {searchQuery.trim().length === 0 && (
                  <>
                  <div className="px-3 pb-2">
                    <button onClick={() => { openGeneral(); setMobileChatOpen(true); pushView('chat'); }}
                      className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl transition-all text-left hover:bg-bg-tertiary">
                      <div className="relative flex-shrink-0">
                        <div className="w-14 h-14 rounded-2xl bg-accent-primary/20 flex items-center justify-center">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </div>
                        {(state.unreadByChannel['general'] || 0) > 0 && (
                          <UnreadBadge count={state.unreadByChannel['general']} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[16px] font-semibold text-fg-primary">{t('global_chat')}</span>
                        <span className="block text-[13px] text-fg-muted mt-0.5">{t('global_chat_desc')}</span>
                      </div>
                    </button>
                  </div>

                    {mobileContacts.length > 0 && (
                      <div className="px-3 pt-1 pb-2">
                        <div className="px-1 py-2">
                          <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('chats')}</span>
                        </div>
                        {mobileContacts.map(contact => {
                          const userOnline = state.users.some(u => u.id === contact.id);
                          const unread = state.unreadByChannel[contact.id] || 0;
                          return (
                            <button key={contact.id}
                              onClick={() => { openDm(contact.id, contact.nickname); setMobileChatOpen(true); pushView('chat'); }}
                              className="w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left cursor-pointer hover:bg-bg-tertiary text-fg-primary">
                              <div className="relative flex-shrink-0">
                                <Avatar userId={contact.id} nickname={contact.nickname} avatar={state.avatars[contact.id]} className="w-12 h-12 rounded-2xl" textClassName="text-[13px]" />
                                {userOnline && (
                                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                                )}
                                {unread > 0 && <UnreadBadge count={unread} />}
                              </div>
                              <div className="min-w-0 flex-1 flex items-center gap-2">
                                <span className={cn('text-[15px] block truncate', unread > 0 ? 'font-bold' : 'font-semibold')}>@{contact.nickname}</span>
                                <span className="text-[12px] text-fg-muted mt-0.5 ml-auto flex-shrink-0">{formatTime(contact.lastMessage)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {searchQuery.trim().length > 0 && state.searchResults.length > 0 && (
                  <div className="px-3 pb-2">
                    <div className="px-1 py-2">
                      <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('search_results')}</span>
                    </div>
                    {state.searchResults.map(user => (
                      <button key={user.id}
                        onClick={() => { openDm(user.id, user.nickname); setMobileChatOpen(true); setSearchQuery(''); pushView('chat'); }}
                        className="w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left cursor-pointer hover:bg-bg-tertiary text-fg-primary">
                        <div className="relative flex-shrink-0">
                          <Avatar userId={user.id} nickname={user.nickname} avatar={state.avatars[user.id]} className="w-12 h-12 rounded-2xl" textClassName="text-[13px]" />
                          {user.online && (
                            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                          )}
                        </div>
                        <div>
                          <span className="text-[15px] font-semibold">@{user.nickname}</span>
                          <span className={cn('block text-[12px] mt-0.5', user.online ? 'text-status-success' : 'text-fg-muted')}>
                            {user.online ? t('online') : t('offline')}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {searchQuery.trim().length > 0 && state.searchResults.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-[13px] text-fg-muted">{t('no_results')}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {mobileChatOpen && (
            <div className={cn('h-full flex flex-col', mobileTab === 'home' ? 'animate-slide-right' : 'hidden')}>
              <ChatArea showContacts={false} isMobile onBack={() => { setMobileChatOpen(false); if (window.history.state?.wn) popView(); }} />
            </div>
          )}

          {mobileTab === 'settings' && (
            <div className="h-full overflow-y-auto bg-bg-secondary">
              <SettingsPanel onClose={() => { setMobileTab('home'); if (window.history.state?.wn) popView(); }} inline />
            </div>
          )}
        </div>

        {!mobileChatOpen && (
          <nav className="flex items-center justify-around border-t border-border-default bg-bg-secondary px-2 pb-safe">
            <button onClick={() => { setMobileTab('home'); setMobileChatOpen(false); setSearchQuery(''); if (window.history.state?.wn) popView(); }}
              className={cn('flex flex-col items-center gap-0.5 py-2 px-6 rounded-xl transition-all duration-200', mobileTab === 'home' ? 'text-accent-primary' : 'text-fg-muted')}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span className="text-[10px] font-medium">{t('home')}</span>
            </button>
            <button onClick={() => { setMobileTab('settings'); setMobileChatOpen(false); pushView('settings'); }}
              className={cn('flex flex-col items-center gap-0.5 py-2 px-6 rounded-xl transition-all duration-200', mobileTab === 'settings' ? 'text-accent-primary' : 'text-fg-muted')}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span className="text-[10px] font-medium">{t('settings')}</span>
            </button>
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-bg-primary">
      <div className="w-80 flex-shrink-0">
        <ChatList />
      </div>
      <ChatArea showContacts={true} />
    </div>
  );
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

export default function App() {
  return (
    <ConnectionProvider>
      <UpdateOverlay />
      <AppInner />
      <AppLockHost />
    </ConnectionProvider>
  );
}

/**
 * The passcode gate, over everything.
 *
 * Deliberately outside the tree it protects rather than inside it: a curtain drawn inside the page still
 * leaves the conversation painted underneath it, and whatever captures the screen captures that too.
 */
function AppLockHost() {
  const { state } = useConnection();
  const [locked, setLocked] = useState(false);

  const enabled = state.settings.appLockEnabled && isAppLockSet();

  // the code is asked for on every fresh page load, and again whenever the tab is left
  useEffect(() => {
    if (enabled) setLocked(true);
  }, [enabled]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden && enabled) setLocked(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled]);

  useAutoLock(
    { enabled, autoLockMs: state.settings.appLockAutoLockMs },
    () => setLocked(true)
  );

  if (!enabled || !locked) return null;
  return <AppLockGate onUnlocked={() => setLocked(false)} />;
}
