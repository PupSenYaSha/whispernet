import { useState, useEffect, useCallback, useRef } from 'react';
import { useReducer, ReactNode } from 'react';
import type { User, AppSettings } from './types';
import { generateKeyPair, encryptMessage, decryptMessage } from './crypto';
import { encryptPrivateKey, decryptPrivateKey, isEncryptedBundle, isKeyBackup } from './crypto-keys';
import { encryptPassword, decryptPassword } from './device-crypto';
import { uploadImage } from './upload';
import { ConnectionContext, useConnection, type ConnectionState, type ConnectionAction } from './context';
import { loadSettings, defaultSettings, translations, cn } from './utils';

declare const __APP_VERSION__: string;
import {
  initializeSignal,
  initSessionManager,
  initPreKeyManager,
  getPreKeyBundleForServer,
  createSessionWithRemote,
  createResponderSession,
  getSessionId,
  encryptWithSignal,
  decryptWithSignal,
  hasSession,
} from './signal/integration';

import { LoginScreen } from './components/LoginScreen';
import { UpdateOverlay } from './components/UpdateOverlay';
import { ChatArea } from './components/ChatArea';
import { ContactsPanel } from './components/ContactsPanel';
import { SettingsPanel } from './components/SettingsPanel';

const WS_URL = import.meta.env.VITE_WS_URL || (() => {
  if (window.electronAPI) return 'ws://localhost:50025/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
})();

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
  dmMessages: {},
  searchResults: [],
  messageSearchResults: [],
};

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };
    case 'SET_DM_MESSAGES':
      return { ...state, dmMessages: { ...state.dmMessages, [action.channel]: action.messages } };
    case 'ADD_DM_MESSAGE':
      return { ...state, dmMessages: { ...state.dmMessages, [action.channel]: [...(state.dmMessages[action.channel] || []), action.message] } };
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
    case 'RESET':
      return { ...initialState, settings: state.settings };
    case 'SET_E2EE_READY':
      return { ...state, e2eeReady: action.ready };
    case 'SET_KEY_SETUP_NEEDED':
      return { ...state, needsKeySetup: action.needed };
    case 'SET_ACTIVE_CHANNEL':
      return { ...state, activeChannel: action.channel };
    case 'SET_CONTACTS':
      return { ...state, contacts: action.contacts };
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
    default:
      return state;
  }
}

function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(connectionReducer, initialState, (init) => ({
    ...init,
    settings: loadSettings(),
  }));
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const authRef = useRef<{ nickname: string; password: string; isRegister: boolean } | null>(null);
  const userIdRef = useRef<string | null>(null);
  const privateKeyRef = useRef<JsonWebKey | null>(null);
  const publicKeyRef = useRef<JsonWebKey | null>(null);
  const publicKeysRef = useRef<Record<string, JsonWebKey>>({});
  const nicknameRef = useRef<string | null>(null);
  const unreadCountRef = useRef(0);
  const titleRef = useRef(document.title);
  const notifSoundRef = useRef<HTMLAudioElement | null>(null);
  const signalInitializedRef = useRef(false);
  const preKeyBundlesRef = useRef<Record<string, any>>({});
  const pendingX3dhRef = useRef<Record<string, { x3dhMessage: any; ratchetPublicKey: Uint8Array }>>({});
  const [sessions, setSessions] = useState<{ id: string; lastActive: number; current: boolean }[]>([]);
  const [importModal, setImportModal] = useState<{ data: any; mode: 'setup' | 'settings' } | null>(null);

  useEffect(() => { userIdRef.current = state.userId; }, [state.userId]);
  useEffect(() => { nicknameRef.current = state.nickname; }, [state.nickname]);

  useEffect(() => {
    const root = document.documentElement;
    if (state.settings.theme === 'light') {
      root.classList.add('light');
    } else {
      root.classList.remove('light');
    }
    const accentClasses = ['accent-blue', 'accent-green', 'accent-red', 'accent-orange', 'accent-pink', 'accent-teal', 'accent-indigo'];
    accentClasses.forEach(c => root.classList.remove(c));
    if (state.settings.accentColor && state.settings.accentColor !== 'purple') {
      root.classList.add(`accent-${state.settings.accentColor}`);
    }
  }, [state.settings.theme, state.settings.accentColor]);

  const t = useCallback((key: string) => {
    return translations[state.settings.language as keyof typeof translations]?.[key as keyof typeof translations.en] || key;
  }, [state.settings.language]);

  const updateTitle = useCallback(() => {
    const count = unreadCountRef.current;
    const base = state.nickname ? `WhisperNet @${state.nickname}` : 'WhisperNet';
    const newTitle = count > 0 ? `${base} (${count})` : base;
    document.title = newTitle;
    titleRef.current = newTitle;
    window.electronAPI?.setTitle(newTitle);
  }, [state.nickname]);

  const fireNotification = useCallback((title: string, body: string) => {
    if (!state.settings.notifications) return;
    if (!document.hidden) return;
    if (Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: '/favicon.ico', tag: 'whispernet' }); } catch {}
  }, [state.settings.notifications]);

  const playNotifSound = useCallback(() => {
    if (!state.settings.soundEnabled) return;
    try {
      if (!notifSoundRef.current) {
        notifSoundRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2JkZqRiX1waXOAjZaQiH1waXOGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZ3KGkZuTiH1wZw==');
        notifSoundRef.current.volume = 0.3;
      }
      notifSoundRef.current.currentTime = 0;
      notifSoundRef.current.play().catch(() => {});
    } catch {}
  }, [state.settings.soundEnabled]);

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
    unreadCountRef.current = 0;
    updateTitle();
  }, [updateTitle]);

  const openDm = useCallback((userId: string) => {
    dispatch({ type: 'SET_ACTIVE_CHANNEL', channel: userId });
    unreadCountRef.current = 0;
    updateTitle();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'dm_history', payload: { with: userId } }));
      wsRef.current.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
      if (signalInitializedRef.current && !hasSession(userIdRef.current || '', userId) && preKeyBundlesRef.current[userId]) {
        try {
          const result = createSessionWithRemote(userIdRef.current || '', userId, preKeyBundlesRef.current[userId]);
          if (result) {
            pendingX3dhRef.current[userId] = { x3dhMessage: result.x3dhMessage, ratchetPublicKey: result.ratchetPublicKey };
          }
        } catch (e) { console.error('Failed to create Signal session:', e); }
      }
    }
  }, []);

  const refreshContacts = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
  }, []);

  const requestSessions = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
  }, []);

  const revokeSession = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'revoke_session', payload: { sessionId } }));
  }, []);

  const searchUsers = useCallback((query: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'search_users', payload: { query } }));
  }, []);

  const searchMessages = useCallback((query: string, channel?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'search_messages', payload: { query, channel } }));
  }, []);

  const deleteMessage = useCallback((messageId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'delete_message', payload: { messageId } }));
  }, []);

  const connect = useCallback((nickname: string, password: string, isRegister: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    authRef.current = { nickname, password, isRegister };
    dispatch({ type: 'SET_STATUS', status: 'connecting' });
    dispatch({ type: 'SET_AUTH_ERROR', error: null });
    dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      dispatch({ type: 'SET_WS', ws });

      ws.onopen = async () => {
        const auth = authRef.current;
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
            initializeSignal();
            await initSessionManager(auth.password);
            await initPreKeyManager(auth.password);
            signalInitializedRef.current = true;
            const preKeyBundle = getPreKeyBundleForServer();
            ws.send(JSON.stringify({ type: 'auth_register', payload: { nickname: auth.nickname, password: auth.password, publicKey: keys.publicKey, preKeyBundle } }));
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
            initializeSignal();
            await initSessionManager(auth.password);
            await initPreKeyManager(auth.password);
            signalInitializedRef.current = true;
            const preKeyBundle = getPreKeyBundleForServer();
            ws.send(JSON.stringify({ type: 'auth_login', payload: { nickname: auth.nickname, password: auth.password, preKeyBundle } }));
          }
        }
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          switch (message.type) {
            case 'auth_success':
              dispatch({ type: 'SET_USER', userId: message.payload.userId, nickname: message.payload.nickname });
              dispatch({ type: 'SET_STATUS', status: 'connected' });
              dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });
              dispatch({ type: 'SET_AUTH_ERROR', error: null });
              publicKeysRef.current = message.payload.publicKeys || {};
              if (message.payload.preKeyBundles) preKeyBundlesRef.current = message.payload.preKeyBundles;
              {
                const myId = message.payload.userId;
                const nick = message.payload.nickname.toLowerCase();
                const myPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (myId && myPubKey) { publicKeysRef.current[myId] = JSON.parse(myPubKey); publicKeyRef.current = JSON.parse(myPubKey); }
                else if (myId && message.payload.publicKeys?.[myId]) publicKeyRef.current = message.payload.publicKeys[myId];
              }
              if (!privateKeyRef.current) dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: true });
              dispatch({ type: 'SET_E2EE_READY', ready: !!privateKeyRef.current });
              if (message.payload.onlineUsers) dispatch({ type: 'SET_USERS', users: message.payload.onlineUsers.filter((u: User) => u.id !== message.payload.userId) });
              window.electronAPI?.setTitle(`WhisperNet @${message.payload.nickname}`);
              document.title = `WhisperNet @${message.payload.nickname}`;
              titleRef.current = document.title;
              unreadCountRef.current = 0;
              if (authRef.current) {
                const enc = await encryptPassword(authRef.current.password);
                localStorage.setItem('wn_auth', JSON.stringify({ nickname: authRef.current.nickname, enc }));
              }
              if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
              {
                const nick = message.payload.nickname.toLowerCase();
                const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (savedPubKey) ws.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: JSON.parse(savedPubKey) } }));
              }
              heartbeatIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', payload: {} }));
              }, 15000);
              authRef.current = null;
              ws.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
              break;
            case 'auth_failure':
              dispatch({ type: 'SET_AUTH_ERROR', error: message.payload.reason });
              dispatch({ type: 'SET_STATUS', status: 'disconnected' });
              ws.close();
              break;
            case 'chat_history':
              dispatch({ type: 'SET_MESSAGES', messages: message.payload.messages.map((m: any) => ({ id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text: m.text || '', timestamp: m.timestamp, isOwn: m.isOwn, fileKey: m.fileKey })) });
              break;
            case 'dm_history': {
              if (message.payload.publicKeys) {
                publicKeysRef.current = { ...publicKeysRef.current, ...message.payload.publicKeys };
                if (userIdRef.current && publicKeyRef.current) publicKeysRef.current[userIdRef.current] = publicKeyRef.current;
              }
              const ch = message.payload.channel;
              const parts = ch.split(':');
              const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
              const msgs = await Promise.all(message.payload.messages.map(async (m: any) => {
                let text = m.text || '';
                if (m.signalEncrypted && signalInitializedRef.current && userIdRef.current) {
                  try {
                    if (m.x3dhMessage && m.ratchetPublicKey && !hasSession(userIdRef.current, otherId)) {
                      createResponderSession(userIdRef.current, otherId, m.x3dhMessage, new Uint8Array(m.ratchetPublicKey));
                    }
                    const sessionId = getSessionId(userIdRef.current, otherId);
                    const { ciphertext, ratchetPublicKey, messageNumber } = m.signalEncrypted;
                    text = await decryptWithSignal(sessionId, ciphertext, ratchetPublicKey, messageNumber);
                  } catch { text = '[encrypted]'; }
                } else if (m.encrypted && privateKeyRef.current && userIdRef.current) {
                  try { text = await decryptMessage(m.encrypted, userIdRef.current, privateKeyRef.current); } catch { if (!text) text = '[encrypted]'; }
                }
                return { id: m.id, senderId: m.senderId, senderNickname: m.senderNickname, text, timestamp: m.timestamp, isOwn: m.senderId === userIdRef.current, channel: otherId, fileKey: m.fileKey };
              }));
              dispatch({ type: 'SET_DM_MESSAGES', channel: otherId, messages: msgs });
              break;
            }
            case 'dm_message': {
              let msgText = message.payload.text || '';
              if (message.payload.signalEncrypted && signalInitializedRef.current && userIdRef.current) {
                try {
                  const ch = message.payload.channel;
                  const parts = ch.split(':');
                  const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
                  if (message.payload.x3dhMessage && message.payload.ratchetPublicKey && !hasSession(userIdRef.current, otherId)) {
                    createResponderSession(userIdRef.current, otherId, message.payload.x3dhMessage, new Uint8Array(message.payload.ratchetPublicKey));
                  }
                  const sessionId = getSessionId(userIdRef.current, otherId);
                  const { ciphertext, ratchetPublicKey, messageNumber } = message.payload.signalEncrypted;
                  msgText = await decryptWithSignal(sessionId, ciphertext, ratchetPublicKey, messageNumber);
                } catch { console.error('Decryption failed'); msgText = '[encrypted]'; }
              } else if (message.payload.encrypted && privateKeyRef.current && userIdRef.current) {
                try { msgText = await decryptMessage(message.payload.encrypted, userIdRef.current, privateKeyRef.current); } catch { if (!msgText) msgText = '[encrypted]'; }
              }
              const ch = message.payload.channel;
              const parts = ch.split(':');
              const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
              dispatch({ type: 'ADD_DM_MESSAGE', channel: otherId, message: { id: message.payload.id, senderId: message.payload.senderId, senderNickname: message.payload.senderNickname, text: msgText, timestamp: message.payload.timestamp, isOwn: message.payload.isOwn, channel: otherId, fileKey: message.payload.fileKey } });
              dispatch({ type: 'SET_CONTACTS', contacts: [] });
              ws.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
              if (!message.payload.isOwn) { unreadCountRef.current++; updateTitle(); fireNotification(`@${message.payload.senderNickname}`, msgText); playNotifSound(); }
              break;
            }
            case 'chat_message':
              dispatch({ type: 'ADD_MESSAGE', message: { id: message.payload.id, senderId: message.payload.senderId, senderNickname: message.payload.senderNickname, text: message.payload.text || '', timestamp: message.payload.timestamp, isOwn: message.payload.isOwn, fileKey: message.payload.fileKey } });
              if (!message.payload.isOwn) { unreadCountRef.current++; updateTitle(); fireNotification(`@${message.payload.senderNickname}`, message.payload.text || ''); playNotifSound(); }
              break;
            case 'dm_contacts':
              if (message.payload.publicKeys) { publicKeysRef.current = { ...publicKeysRef.current, ...message.payload.publicKeys }; if (userIdRef.current && publicKeyRef.current) publicKeysRef.current[userIdRef.current] = publicKeyRef.current; }
              dispatch({ type: 'SET_CONTACTS', contacts: message.payload.contacts });
              break;
            case 'prekey_bundles':
              if (message.payload.bundles) preKeyBundlesRef.current = { ...preKeyBundlesRef.current, ...message.payload.bundles };
              break;
            case 'search_results':
              dispatch({ type: 'SET_SEARCH_RESULTS', results: message.payload.results });
              break;
            case 'message_search_results':
              dispatch({ type: 'SET_MESSAGE_SEARCH_RESULTS', results: message.payload.results });
              break;
            case 'message_deleted':
              dispatch({ type: 'DELETE_MESSAGE', messageId: message.payload.messageId });
              break;
            case 'sessions_list':
              setSessions(message.payload.sessions);
              break;
            case 'session_revoked':
              if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
              break;
            case 'user_joined':
              dispatch({ type: 'ADD_USER', user: { id: message.payload.userId, nickname: message.payload.nickname } });
              break;
            case 'user_left':
              dispatch({ type: 'REMOVE_USER', userId: message.payload.userId });
              break;
            case 'system_message':
              dispatch({ type: 'ADD_MESSAGE', message: { id: crypto.randomUUID(), senderId: 'system', senderNickname: '', text: message.payload.text, timestamp: Date.now(), isOwn: false } });
              break;
            case 'error':
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
          }
        } catch (e) { console.error('Message parse error:', e); }
      };

      ws.onclose = () => {
        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        wsRef.current = null;
        dispatch({ type: 'SET_WS', ws: null });
        if (userIdRef.current) {
          const attempts = state.reconnectAttempts;
          if (attempts < 10) {
            dispatch({ type: 'SET_STATUS', status: 'reconnecting' });
            const delay = Math.min(2000 * Math.pow(2, attempts), 30000);
            dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: attempts + 1 });
            reconnectTimeoutRef.current = setTimeout(() => {
              const auth = authRef.current;
              if (auth) connect(auth.nickname, auth.password, auth.isRegister);
            }, delay);
          } else {
            dispatch({ type: 'SET_STATUS', status: 'disconnected' });
          }
        } else {
          dispatch({ type: 'SET_STATUS', status: 'disconnected' });
        }
      };

      ws.onerror = () => {};
    } catch (e) {
      dispatch({ type: 'SET_STATUS', status: 'disconnected' });
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    authRef.current = null;
    userIdRef.current = null;
    if (wsRef.current) { wsRef.current.close(1000, 'User disconnected'); wsRef.current = null; dispatch({ type: 'SET_WS', ws: null }); }
    dispatch({ type: 'SET_STATUS', status: 'disconnected' });
  }, []);

  const reconnect = useCallback(() => {
    const auth = authRef.current;
    if (auth) { dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 }); connect(auth.nickname, auth.password, auth.isRegister); }
  }, [connect]);

  const logout = useCallback(() => {
    disconnect();
    dispatch({ type: 'RESET' });
    localStorage.removeItem('wn_auth');
    localStorage.removeItem('wn_settings');
    window.electronAPI?.setTitle('WhisperNet');
    document.title = 'WhisperNet';
  }, [disconnect]);

  const buildEncryptKeys = useCallback((extraKeys?: Record<string, JsonWebKey>): Record<string, JsonWebKey> => {
    const keys: Record<string, JsonWebKey> = { ...publicKeysRef.current, ...extraKeys };
    if (userIdRef.current && publicKeyRef.current) keys[userIdRef.current] = publicKeyRef.current;
    return keys;
  }, []);

  const getMyPublicKey = useCallback((): JsonWebKey | null => publicKeyRef.current, []);
  const getPublicKey = useCallback((userId: string): JsonWebKey | null => publicKeysRef.current[userId] || null, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: text.trim() } }));
  }, []);

  const sendDm = useCallback(async (to: string, text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;
    const trimmed = text.trim();
    const recipientKey = publicKeysRef.current[to];
    if (!privateKeyRef.current || !recipientKey) { console.error('Encryption keys not available'); return; }
    try {
      if (signalInitializedRef.current && hasSession(userIdRef.current || '', to)) {
        const sessionId = getSessionId(userIdRef.current || '', to);
        const encrypted = await encryptWithSignal(sessionId, trimmed);
        const payload: any = { to, text: '', signalEncrypted: encrypted };
        if (pendingX3dhRef.current[to]) {
          payload.x3dhMessage = pendingX3dhRef.current[to].x3dhMessage;
          payload.ratchetPublicKey = Array.from(pendingX3dhRef.current[to].ratchetPublicKey);
          delete pendingX3dhRef.current[to];
        }
        wsRef.current.send(JSON.stringify({ type: 'dm_send', payload }));
      } else {
        const encrypted = await encryptMessage(trimmed, buildEncryptKeys({ [to]: recipientKey }));
        wsRef.current.send(JSON.stringify({ type: 'dm_send', payload: { to, text: '', encrypted } }));
      }
    } catch (e) { console.error('Encryption failed'); }
  }, [buildEncryptKeys]);

  const getMediaTag = (type: string): string => type.startsWith('video/') ? 'video' : 'image';

  const sendImage = useCallback(async (file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const url = await uploadImage(file);
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: `[${getMediaTag(file.type)}]${url}[/${getMediaTag(file.type)}]` } }));
  }, []);

  const sendDmImage = useCallback(async (to: string, file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const url = await uploadImage(file);
    const tag = getMediaTag(file.type);
    const text = `[${tag}]${url}[/${tag}]`;
    const recipientKey = publicKeysRef.current[to];
    if (!privateKeyRef.current || !recipientKey) { console.error('Encryption keys not available'); return; }
    try {
      if (signalInitializedRef.current && hasSession(userIdRef.current || '', to)) {
        const sessionId = getSessionId(userIdRef.current || '', to);
        const encrypted = await encryptWithSignal(sessionId, text);
        wsRef.current.send(JSON.stringify({ type: 'dm_send', payload: { to, text: '', signalEncrypted: encrypted } }));
      } else {
        const encrypted = await encryptMessage(text, buildEncryptKeys({ [to]: recipientKey }));
        wsRef.current.send(JSON.stringify({ type: 'dm_send', payload: { to, text: '', encrypted } }));
      }
    } catch (e) { console.error('Image encryption failed'); }
  }, [buildEncryptKeys]);

  useEffect(() => {
    const saved = localStorage.getItem('wn_auth');
    if (saved) {
      (async () => {
        try {
          const { nickname, enc } = JSON.parse(saved);
          if (!nickname || !enc) return;
          const password = await decryptPassword(enc);
          if (password) connect(nickname, password, false);
        } catch {}
      })();
    }
  }, []);

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
                } else {
                  localStorage.setItem(`wn_pk_${nick}`, JSON.stringify(keys.privateKey));
                }
                localStorage.setItem(`wn_pub_${nick}`, JSON.stringify(keys.publicKey));
                privateKeyRef.current = keys.privateKey;
                publicKeyRef.current = keys.publicKey;
                if (userIdRef.current) publicKeysRef.current[userIdRef.current] = keys.publicKey;
                if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: keys.publicKey } }));
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
        t, updateSettings, getMyPublicKey, getPublicKey,
        sessions, requestSessions, revokeSession,
        showImportModal: (data: any, mode: 'setup' | 'settings') => setImportModal({ data, mode }),
      }}>
        {children}
      </ConnectionContext.Provider>
      {importModal && (
        <div className="fixed inset-0 z-[70]">
          <PasswordModalInline title={t('enter_backup_password')} onCancel={() => setImportModal(null)} onConfirm={async (pass) => {
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
              if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: pubKey } }));
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

function PasswordModalInline({ title, onConfirm, onCancel }: { title: string; onConfirm: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6">
          <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-4">{title}</h3>
          <input ref={inputRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && password) onConfirm(password); if (e.key === 'Escape') onCancel(); }}
            className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-4"
            placeholder="Password" />
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">Cancel</button>
            <button onClick={() => password && onConfirm(password)} disabled={!password} className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40">OK</button>
          </div>
        </div>
      </div>
    </>
  );
}

function AppInner() {
  const { state, t } = useConnection();
  const [mobileTab, setMobileTab] = useState<'home' | 'settings'>('home');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth >= 768) setMobileChatOpen(false); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const on = !!localStorage.getItem('wn_screenshot_prot');
    document.body.classList.toggle('screenshot-protect', on);
    const handler = (e: Event) => { if (on) e.preventDefault(); };
    if (on) { document.addEventListener('contextmenu', handler); document.addEventListener('selectstart', handler); }
    return () => { document.removeEventListener('contextmenu', handler); document.removeEventListener('selectstart', handler); };
  }, [mobileTab]);

  const mobileChatOpenRef = useRef(mobileChatOpen);
  mobileChatOpenRef.current = mobileChatOpen;
  const mobileTabRef = useRef(mobileTab);
  mobileTabRef.current = mobileTab;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.Capacitor?.Plugins?.App?.addListener) return;
    const handleBackButton = () => {
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) { (document.activeElement as HTMLElement).blur(); return; }
      if (mobileChatOpenRef.current) { setMobileChatOpen(false); return; }
      if (mobileTabRef.current === 'settings') { setMobileTab('home'); return; }
      try { window.Capacitor?.Plugins?.App?.exitApp?.(); } catch {}
    };
    let backHandler: any = null;
    window.Capacitor.Plugins.App.addListener('backButton', handleBackButton).then((h: any) => { backHandler = h; });
    return () => { try { backHandler?.remove?.(); } catch {} };
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
              <button onClick={() => {}} className="px-6 py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 transition-all">{t('retry')}</button>
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

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {}, 300);
  };

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
                </div>
                <input type="text" value={searchQuery} onChange={(e) => handleSearch(e.target.value)}
                  placeholder={t('search_placeholder')}
                  className="w-full px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary" />
              </div>
              <div className="flex-1 overflow-y-auto">
                {searchQuery.length === 0 && (
                  <>
                    <div className="px-3 pb-2">
                      <button onClick={() => { useConnection().openGeneral(); setMobileChatOpen(true); }}
                        className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl transition-all text-left hover:bg-bg-tertiary">
                        <div className="w-14 h-14 rounded-2xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </div>
                        <div>
                          <span className="text-[16px] font-semibold text-fg-primary">{t('global_chat')}</span>
                          <span className="block text-[13px] text-fg-muted mt-0.5">{t('global_chat_desc')}</span>
                        </div>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {mobileTab === 'home' && mobileChatOpen && (
            <div className="h-full flex flex-col animate-slide-right">
              <ChatArea showContacts={false} isMobile onBack={() => setMobileChatOpen(false)} />
            </div>
          )}

          {mobileTab === 'settings' && (
            <div className="h-full overflow-y-auto bg-bg-secondary">
              <SettingsPanel onClose={() => setMobileTab('home')} inline />
            </div>
          )}
        </div>

        {!mobileChatOpen && (
          <nav className="flex items-center justify-around border-t border-border-default bg-bg-secondary px-2 pb-safe">
            <button onClick={() => { setMobileTab('home'); setMobileChatOpen(false); setSearchQuery(''); }}
              className={cn('flex flex-col items-center gap-0.5 py-2 px-6 rounded-xl transition-all duration-200', mobileTab === 'home' ? 'text-accent-primary' : 'text-fg-muted')}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span className="text-[10px] font-medium">{t('home')}</span>
            </button>
            <button onClick={() => { setMobileTab('settings'); setMobileChatOpen(false); }}
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
        <ContactsPanel onSelect={() => {}} />
      </div>
      <ChatArea showContacts={true} />
    </div>
  );
}

export default function App() {
  return (
    <ConnectionProvider>
      <UpdateOverlay />
      <AppInner />
    </ConnectionProvider>
  );
}
