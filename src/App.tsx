import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useReducer, ReactNode } from 'react';
import type { User, Message, AppSettings, AccentColor } from './types';
import { generateKeyPair, encryptMessage, decryptMessage, generateSafetyNumber } from './crypto';
import { encryptPrivateKey, decryptPrivateKey, isEncryptedBundle, createBackup, downloadBackup, isKeyBackup, type EncryptedKeyBundle } from './crypto-keys';
import { encryptPassword, decryptPassword } from './device-crypto';
import { uploadImage } from './upload';
import { ConnectionContext, useConnection, type ConnectionState, type ConnectionAction } from './context';
import { translations, cn, formatTime, getAvatarText, loadSettings, defaultSettings } from './utils';

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

  useEffect(() => {
    userIdRef.current = state.userId;
  }, [state.userId]);

  useEffect(() => {
    nicknameRef.current = state.nickname;
  }, [state.nickname]);

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
    try {
      new Notification(title, { body, icon: '/favicon.ico', tag: 'whispernet' });
    } catch {}
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
    const onVisibilityChange = () => {
      if (!document.hidden) {
        unreadCountRef.current = 0;
        updateTitle();
      }
    };
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
            pendingX3dhRef.current[userId] = {
              x3dhMessage: result.x3dhMessage,
              ratchetPublicKey: result.ratchetPublicKey,
            };
          }
        } catch (e) {
          console.error('Failed to create Signal session:', e);
        }
      }
    }
  }, []);

  const refreshContacts = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
    }
  }, []);

  const requestSessions = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
    }
  }, []);

  const revokeSession = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'revoke_session', payload: { sessionId } }));
    }
  }, []);

  const searchUsers = useCallback((query: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'search_users', payload: { query } }));
    }
  }, []);

  const searchMessages = useCallback((query: string, channel?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'search_messages', payload: { query, channel } }));
    }
  }, []);

  const deleteMessage = useCallback((messageId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete_message', payload: { messageId } }));
    }
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

            ws.send(JSON.stringify({
              type: 'auth_register',
              payload: {
                nickname: auth.nickname,
                password: auth.password,
                publicKey: keys.publicKey,
                preKeyBundle,
              },
            }));
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
              } catch {
                privateKeyRef.current = null;
                publicKeyRef.current = null;
              }
            }

            initializeSignal();
            await initSessionManager(auth.password);
            await initPreKeyManager(auth.password);
            signalInitializedRef.current = true;
            const preKeyBundle = getPreKeyBundleForServer();

            ws.send(JSON.stringify({
              type: 'auth_login',
              payload: {
                nickname: auth.nickname,
                password: auth.password,
                preKeyBundle,
              },
            }));
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
              if (message.payload.preKeyBundles) {
                preKeyBundlesRef.current = message.payload.preKeyBundles;
              }
              {
                const myId = message.payload.userId;
                const nick = message.payload.nickname.toLowerCase();
                const myPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (myId && myPubKey) {
                  publicKeysRef.current[myId] = JSON.parse(myPubKey);
                  publicKeyRef.current = JSON.parse(myPubKey);
                } else if (myId && message.payload.publicKeys?.[myId]) {
                  publicKeyRef.current = message.payload.publicKeys[myId];
                }
              }
              if (!privateKeyRef.current) {
                dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: true });
              }
              dispatch({ type: 'SET_E2EE_READY', ready: !!privateKeyRef.current });
              if (message.payload.onlineUsers) {
                dispatch({ type: 'SET_USERS', users: message.payload.onlineUsers.filter((u: User) => u.id !== message.payload.userId) });
              }
              window.electronAPI?.setTitle(`WhisperNet @${message.payload.nickname}`);
              document.title = `WhisperNet @${message.payload.nickname}`;
              titleRef.current = document.title;
              unreadCountRef.current = 0;

              if (authRef.current) {
                {
                  const enc = await encryptPassword(authRef.current.password);
                  localStorage.setItem('wn_auth', JSON.stringify({ nickname: authRef.current.nickname, enc }));
                }
              }

              if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
              }

              {
                const nick = message.payload.nickname.toLowerCase();
                const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (savedPubKey) {
                  ws.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: JSON.parse(savedPubKey) } }));
                }
              }

              heartbeatIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'heartbeat', payload: {} }));
                }
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
              dispatch({ type: 'SET_MESSAGES', messages: message.payload.messages.map((m: any) => ({
                id: m.id, senderId: m.senderId, senderNickname: m.senderNickname,
                text: m.text || '', timestamp: m.timestamp, isOwn: m.isOwn, fileKey: m.fileKey,
              })) });
              break;

            case 'dm_history': {
              if (message.payload.publicKeys) {
                publicKeysRef.current = { ...publicKeysRef.current, ...message.payload.publicKeys };
                if (userIdRef.current && publicKeyRef.current) {
                  publicKeysRef.current[userIdRef.current] = publicKeyRef.current;
                }
              }
              const ch = message.payload.channel;
              const parts = ch.split(':');
              const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
              const msgs = await Promise.all(message.payload.messages.map(async (m: any) => {
                let text = m.text || '';
                if (m.signalEncrypted && signalInitializedRef.current && userIdRef.current) {
                  try {
                    if (m.x3dhMessage && m.ratchetPublicKey && !hasSession(userIdRef.current, otherId)) {
                      const ratchetPubKey = new Uint8Array(m.ratchetPublicKey);
                      createResponderSession(userIdRef.current, otherId, m.x3dhMessage, ratchetPubKey);
                    }
                    const sessionId = getSessionId(userIdRef.current, otherId);
                    const { ciphertext, ratchetPublicKey, messageNumber } = m.signalEncrypted;
                    text = await decryptWithSignal(sessionId, ciphertext, ratchetPublicKey, messageNumber);
                  } catch (e) {
                    text = '[encrypted]';
                  }
                } else if (m.encrypted && privateKeyRef.current && userIdRef.current) {
                  try {
                    text = await decryptMessage(m.encrypted, userIdRef.current, privateKeyRef.current);
                  } catch (e) {
                    if (!text) text = '[encrypted]';
                  }
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
                    const ratchetPubKey = new Uint8Array(message.payload.ratchetPublicKey);
                    createResponderSession(userIdRef.current, otherId, message.payload.x3dhMessage, ratchetPubKey);
                  }

                  const sessionId = getSessionId(userIdRef.current, otherId);
                  const { ciphertext, ratchetPublicKey, messageNumber } = message.payload.signalEncrypted;
                  msgText = await decryptWithSignal(sessionId, ciphertext, ratchetPublicKey, messageNumber);
                } catch (e) {
                  console.error('Decryption failed');
                  msgText = '[encrypted]';
                }
              } else if (message.payload.encrypted && privateKeyRef.current && userIdRef.current) {
                try {
                  msgText = await decryptMessage(message.payload.encrypted, userIdRef.current, privateKeyRef.current);
                } catch (e) {
                  if (!msgText) msgText = '[encrypted]';
                }
              }
              const ch = message.payload.channel;
              const parts = ch.split(':');
              const otherId = parts[0] === userIdRef.current ? parts[1] : parts[0];
              dispatch({ type: 'ADD_DM_MESSAGE', channel: otherId, message: {
                id: message.payload.id,
                senderId: message.payload.senderId,
                senderNickname: message.payload.senderNickname,
                text: msgText,
                timestamp: message.payload.timestamp,
                isOwn: message.payload.isOwn,
                channel: otherId,
                fileKey: message.payload.fileKey,
              } });
              dispatch({ type: 'SET_CONTACTS', contacts: [] });
              ws.send(JSON.stringify({ type: 'dm_contacts', payload: {} }));
              if (!message.payload.isOwn) {
                unreadCountRef.current++;
                updateTitle();
                fireNotification(`@${message.payload.senderNickname}`, msgText);
                playNotifSound();
              }
              break;
            }

            case 'chat_message': {
              dispatch({ type: 'ADD_MESSAGE', message: {
                id: message.payload.id,
                senderId: message.payload.senderId,
                senderNickname: message.payload.senderNickname,
                text: message.payload.text || '',
                timestamp: message.payload.timestamp,
                isOwn: message.payload.isOwn,
                fileKey: message.payload.fileKey,
              } });
              if (!message.payload.isOwn) {
                unreadCountRef.current++;
                updateTitle();
                fireNotification(`@${message.payload.senderNickname}`, message.payload.text || '');
                playNotifSound();
              }
              break;
            }

            case 'dm_contacts':
              if (message.payload.publicKeys) {
                publicKeysRef.current = { ...publicKeysRef.current, ...message.payload.publicKeys };
                if (userIdRef.current && publicKeyRef.current) {
                  publicKeysRef.current[userIdRef.current] = publicKeyRef.current;
                }
              }
              dispatch({ type: 'SET_CONTACTS', contacts: message.payload.contacts });
              break;

            case 'prekey_bundles':
              if (message.payload.bundles) {
                preKeyBundlesRef.current = { ...preKeyBundlesRef.current, ...message.payload.bundles };
              }
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
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'get_sessions', payload: {} }));
              }
              break;

            case 'user_joined':
              dispatch({ type: 'ADD_USER', user: { id: message.payload.userId, nickname: message.payload.nickname } });
              break;

            case 'user_left':
              dispatch({ type: 'REMOVE_USER', userId: message.payload.userId });
              break;

            case 'system_message':
              dispatch({ type: 'ADD_MESSAGE', message: {
                id: crypto.randomUUID(),
                senderId: 'system',
                senderNickname: '',
                text: message.payload.text,
                timestamp: Date.now(),
                isOwn: false,
              }});
              break;

            case 'error':
              console.error('Server error:', message.payload);
              break;

            case 'key_updated': {
              const nick = nicknameRef.current?.toLowerCase();
              if (nick) {
                const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
                if (savedPubKey && userIdRef.current) {
                  publicKeysRef.current = { ...publicKeysRef.current, [userIdRef.current]: JSON.parse(savedPubKey) };
                }
              }
              break;
            }

            case 'public_key_updated': {
              const { userId, publicKey } = message.payload;
              if (userId && publicKey) {
                publicKeysRef.current = { ...publicKeysRef.current, [userId]: publicKey };
              }
              break;
            }

            case 'heartbeat_ack':
              break;
          }
        } catch (e) {
          console.error('Message parse error:', e);
        }
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
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
      dispatch({ type: 'SET_WS', ws: null });
    }
    dispatch({ type: 'SET_STATUS', status: 'disconnected' });
  }, []);

  const reconnect = useCallback(() => {
    const auth = authRef.current;
    if (auth) {
      dispatch({ type: 'SET_RECONNECT_ATTEMPTS', attempts: 0 });
      connect(auth.nickname, auth.password, auth.isRegister);
    }
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
    if (userIdRef.current && publicKeyRef.current) {
      keys[userIdRef.current] = publicKeyRef.current;
    }
    return keys;
  }, []);

  const getMyPublicKey = useCallback((): JsonWebKey | null => {
    return publicKeyRef.current;
  }, []);

  const getPublicKey = useCallback((userId: string): JsonWebKey | null => {
    return publicKeysRef.current[userId] || null;
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;
    const trimmed = text.trim();
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: trimmed } }));
  }, []);

  const sendDm = useCallback(async (to: string, text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;
    const trimmed = text.trim();
    const recipientKey = publicKeysRef.current[to];
    if (!privateKeyRef.current || !recipientKey) {
      console.error('Encryption keys not available');
      return;
    }
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
    } catch (e) {
      console.error('Encryption failed');
    }
  }, [buildEncryptKeys]);

  const getMediaTag = (type: string): string => {
    if (type.startsWith('video/')) return 'video';
    return 'image';
  };

  const sendImage = useCallback(async (file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const url = await uploadImage(file);
    const tag = getMediaTag(file.type);
    wsRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: `[${tag}]${url}[/${tag}]` } }));
  }, []);

  const sendDmImage = useCallback(async (to: string, file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const url = await uploadImage(file);
    const tag = getMediaTag(file.type);
    const text = `[${tag}]${url}[/${tag}]`;
    const recipientKey = publicKeysRef.current[to];
    if (!privateKeyRef.current || !recipientKey) {
      console.error('Encryption keys not available');
      return;
    }
    try {
      if (signalInitializedRef.current && hasSession(userIdRef.current || '', to)) {
        const sessionId = getSessionId(userIdRef.current || '', to);
        const encrypted = await encryptWithSignal(sessionId, text);
        wsRef.current.send(JSON.stringify({
          type: 'dm_send',
          payload: { to, text: '', signalEncrypted: encrypted },
        }));
      } else {
        const encrypted = await encryptMessage(text, buildEncryptKeys({ [to]: recipientKey }));
        wsRef.current.send(JSON.stringify({ type: 'dm_send', payload: { to, text: '', encrypted } }));
      }
    } catch (e) {
      console.error('Image encryption failed');
    }
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
                if (userIdRef.current) {
                  publicKeysRef.current[userIdRef.current] = keys.publicKey;
                }
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: keys.publicKey } }));
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
      state,
      dispatch,
      connect,
      reconnect,
      disconnect,
      logout,
      sendMessage,
      sendDm,
      sendDmImage,
      sendImage,
      openDm,
      openGeneral,
      refreshContacts,
      searchUsers,
      searchMessages,
      deleteMessage,
      t,
      updateSettings,
      getMyPublicKey,
      getPublicKey,
      sessions,
      requestSessions,
      revokeSession,
      showImportModal: (data: any, mode: 'setup' | 'settings') => setImportModal({ data, mode }),
    }}>
      {children}
    </ConnectionContext.Provider>
    {importModal && (
      <PasswordModal title={t('enter_backup_password')} onCancel={() => setImportModal(null)} onConfirm={async (pass) => {
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
          if (userIdRef.current) {
            publicKeysRef.current[userIdRef.current] = pubKey;
          }
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'auth_update_key', payload: { publicKey: pubKey } }));
          }
          if (importModal.mode === 'setup') {
            dispatch({ type: 'SET_KEY_SETUP_NEEDED', needed: false });
          }
          dispatch({ type: 'SET_E2EE_READY', ready: true });
        } catch { alert(t('key_import_err')); }
        setImportModal(null);
      }} />
    )}
    </>
  );
}

function MessageItem({ message, showAvatar = true }: { message: Message; showAvatar?: boolean }) {
  const { state, deleteMessage: deleteMsg, t } = useConnection();
  const isSystem = message.senderId === 'system';
  const isOwn = message.isOwn;

  const fontSizeClass = state.settings.fontSize === 'small' ? 'text-[13px]'
    : state.settings.fontSize === 'large' ? 'text-[17px]'
    : 'text-[15px]';

  if (isSystem) {
    return (
      <div className="flex items-center justify-center py-2">
        <span className="px-4 py-1.5 rounded-full bg-bg-tertiary/60 text-[12px] font-medium text-fg-muted">
          {message.text}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 px-4 animate-message ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && showAvatar && (
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-accent-primary/15 flex items-center justify-center mt-1">
          <span className="text-[11px] font-bold text-accent-primary">
            {getAvatarText(message.senderNickname)}
          </span>
        </div>
      )}
      {!isOwn && !showAvatar && <div className="w-9" />}

      <div className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showAvatar && (
          <span className="text-[12px] font-semibold text-accent-primary mb-1 px-1">
            {message.senderNickname}
          </span>
        )}

        <div className={cn(
          'px-3.5 py-2.5 leading-relaxed group relative',
          fontSizeClass,
          isOwn
            ? 'bg-bubble-mine text-bubble-mine-text rounded-2xl rounded-br-sm'
            : 'bg-bubble-other text-bubble-other-text border border-border-default rounded-2xl rounded-bl-sm'
        )}>
          {isOwn && (
            <button onClick={() => deleteMsg(message.id)}
              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-bg-tertiary border border-border-default flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-status-error/20"
              title={t('delete')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
          {(() => {
            const mediaMatch = message.text.match(/^\[(image|video)\]([\s\S]*?)\[\/\1\]/);
            if (mediaMatch) {
              const [, tag, url] = mediaMatch;
              const safeUrl = /^(https?:\/\/)/i.test(url) ? url : null;
              if (!safeUrl) {
                return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">Invalid URL</p>;
              }
              if (tag === 'video') {
                const proxyUrl = `/api/media?url=${encodeURIComponent(safeUrl)}`;
                return (
                  <video src={proxyUrl} controls
                    className="rounded-xl max-w-[340px] max-h-[340px] cursor-pointer" />
                );
              }
              return (
                <img src={safeUrl} alt=""
                  className="rounded-xl max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                  onClick={() => { window.open(safeUrl, '_blank', 'noopener,noreferrer'); }} />
              );
            }
            return <p className="whitespace-pre-wrap break-words">{message.text}</p>;
          })()}
        </div>

        <span className="text-[10px] text-fg-subtle mt-1 px-1">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
}

function MessageList({ messages }: { messages: Message[] }) {
  const { t } = useConnection();
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 120;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, []);

  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      if (isNearBottomRef.current) {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages]);

  const groupedMessages = messages.reduce((acc: Message[][], msg) => {
    const lastGroup = acc[acc.length - 1];
    const lastMsg = lastGroup?.[lastGroup.length - 1];
    if (lastMsg &&
        lastMsg.senderId === msg.senderId &&
        Math.abs(msg.timestamp - lastMsg.timestamp) < 300000) {
      lastGroup.push(msg);
    } else {
      acc.push([msg]);
    }
    return acc;
  }, []);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-fg-muted animate-in">
          <div className="w-16 h-16 rounded-2xl bg-bg-tertiary border border-border-default flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-subtle">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <p className="text-[15px] font-medium text-fg-muted">{t('no_messages')}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-2 py-3 space-y-2" role="log" aria-live="polite">
      {groupedMessages.map((group, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          {group.map((msg, j) => (
            <MessageItem
              key={msg.id}
              message={msg}
              showAvatar={j === 0}
            />
          ))}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageInput() {
  const { state, sendMessage, sendDm, sendImage, sendDmImage, t } = useConnection();
  const [hasText, setHasText] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isConnected = state.status === 'connected';
  const isDm = state.activeChannel !== 'general';
  const dmTarget = isDm ? state.activeChannel : null;

  const autoResize = () => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
  };

  useEffect(() => { autoResize(); }, [hasText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ta = textareaRef.current;
    const val = ta?.value?.trim();
    if (!val || !isConnected) return;
    if (isDm && dmTarget) {
      sendDm(dmTarget, val);
    } else {
      sendMessage(val);
    }
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
    }
    setHasText(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
    if (file.size > 1000 * 1024 * 1024) return;
    setUploading(true);
    try {
      if (isDm && dmTarget) {
        await sendDmImage(dmTarget, file);
      } else {
        await sendImage(file);
      }
    } catch (e) { console.error('Upload failed:', e); }
    setUploading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="px-3 py-2.5">
      <input ref={fileRef} type="file" hidden accept="image/*,video/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      <div className="flex items-end gap-2">
        <button type="button" disabled={!isConnected || uploading}
          onClick={() => fileRef.current?.click()}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 transition-all"
          aria-label="Attach file">
          {uploading ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
          )}
        </button>
        <textarea
          ref={textareaRef}
          onChange={(e) => setHasText(e.target.value.trim().length > 0)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? t('type_message') : t('not_connected')}
          disabled={!isConnected}
          className="flex-1 px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-fg-primary text-[15px] placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-transparent transition-all duration-200 resize-none"
          style={{ minHeight: '44px', maxHeight: '120px', overflow: 'hidden' }}
          rows={1}
          maxLength={4096}
          aria-label={t('send_message')}
        />
        <button
          type="submit"
          disabled={!isConnected || !hasText}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-accent-primary text-accent-text flex items-center justify-center hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          aria-label={t('send_message')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </form>
  );
}

function TopBar({ onSettingsClick, isMobile, onBack }: { onSettingsClick: () => void; isMobile?: boolean; onBack?: () => void }) {
  const { state, openGeneral, t } = useConnection();
  const [showUsers, setShowUsers] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const dmContact = isDm ? state.contacts.find(c => c.id === state.activeChannel) : null;
  const dmUser = isDm ? state.users.find(u => u.id === state.activeChannel) : null;
  const displayDm = dmContact || dmUser;
  const isOnline = isDm ? !!dmUser : false;

  return (
    <header className="sticky top-0 z-30 bg-bg-secondary/80 backdrop-blur-xl border-b border-border-default">
      <div className={isMobile ? "px-4" : "px-3"}>
        <div className={cn("flex items-center justify-between", isMobile ? "h-16" : "h-14")}>
          <div className="flex items-center gap-3">
            {isMobile && onBack && (
              <button onClick={onBack} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            {!isMobile && isDm && (
              <button onClick={openGeneral} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            <div className={cn(
              isMobile ? 'w-11 h-11 rounded-2xl' : 'w-10 h-10 rounded-2xl',
              'flex items-center justify-center flex-shrink-0 text-[13px] font-bold',
              isDm ? 'bg-accent-primary/15 text-accent-primary' : 'bg-accent-primary'
            )}>
              {isDm && displayDm ? (
                <span>{getAvatarText(displayDm.nickname)}</span>
              ) : (
                <svg width={isMobile ? "20" : "18"} height={isMobile ? "20" : "18"} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-text)" strokeWidth="2.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </div>
            <div>
              <h1 className={cn(isMobile ? "text-[17px]" : "text-[15px]", "font-bold text-fg-primary leading-tight")}>
                {isDm ? `@${displayDm?.nickname || '...'}` : t('global_chat')}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                {isDm ? (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', isOnline ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : 'bg-fg-subtle')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{isOnline ? t('online') : t('offline')}</span>
                  </>
                ) : (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', state.status === 'connected' ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : state.status === 'disconnected' ? 'bg-status-error' : 'bg-status-warning animate-pulse')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{state.status === 'connected' ? t('status_connected') : state.status === 'disconnected' ? t('status_disconnected') : t('status_connecting')}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {!isDm && state.users.length > 0 && (
              <button
                onClick={() => setShowUsers(!showUsers)}
                className="px-3 py-1.5 rounded-xl text-[12px] font-medium text-fg-muted hover:bg-bg-tertiary transition-colors"
              >
                {state.users.length + 1} {t('online_users')}
              </button>
            )}

            {!isMobile && (
              <button
                onClick={onSettingsClick}
                className="p-2 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted hover:text-fg-primary"
                aria-label={t('settings')}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {showUsers && !isDm && (
        <div className="border-t border-border-default px-4 py-2.5 bg-bg-secondary">
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2.5 py-1 text-[12px] font-medium bg-accent-primary/10 text-accent-primary rounded-lg">
              @{state.nickname} (you)
            </span>
            {state.users.map(u => (
              <button key={u.id} onClick={() => { setShowUsers(false); }}
                className="px-2.5 py-1 text-[12px] font-medium bg-bg-tertiary text-fg-muted rounded-lg hover:bg-accent-primary/10 hover:text-accent-primary transition-colors cursor-pointer">
                @{u.nickname}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function ContactsPanel({ onSelect }: { onSelect: () => void }) {
  const { state, openDm, openGeneral, refreshContacts, searchUsers, t } = useConnection();
  const isDm = state.activeChannel !== 'general';
  const [query, setQuery] = useState('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    refreshContacts();
  }, []);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchUsers(value);
    }, 300);
  };

  return (
    <div className="w-full h-full flex flex-col bg-bg-secondary border-r border-border-default">
      <div className="px-4 h-14 flex items-center border-b border-border-default">
        <h2 className="text-[15px] font-bold text-fg-primary">{t('chats')}</h2>
      </div>

      <div className="px-3 py-2.5">
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('search_placeholder')}
          className="w-full px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <button
            onClick={() => { openGeneral(); onSelect(); }}
            className={cn(
              'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
              !isDm ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-tertiary text-fg-primary'
            )}
          >
            <div className="w-12 h-12 rounded-2xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <span className="text-[15px] font-semibold">{t('general')}</span>
              <span className="block text-[12px] text-fg-muted mt-0.5">{t('chat')}</span>
            </div>
          </button>
        </div>

        {query.length > 0 && state.searchResults.length > 0 && (
          <>
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('search_results')}</span>
            </div>
            <div className="p-2 space-y-0.5">
              {state.searchResults.map(user => (
                <button
                  key={user.id}
                  onClick={() => { openDm(user.id); setQuery(''); onSelect(); }}
                  className="w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left hover:bg-bg-tertiary text-fg-primary"
                >
                  <div className="w-12 h-12 rounded-2xl bg-accent-primary/10 flex items-center justify-center flex-shrink-0 relative">
                    <span className="text-[13px] font-bold text-accent-primary">
                      {getAvatarText(user.nickname)}
                    </span>
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
          </>
        )}

        {query.length > 0 && state.searchResults.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-[13px] text-fg-muted">{t('no_results')}</p>
          </div>
        )}

        {query.length === 0 && (
          <>
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('contacts')}</span>
            </div>
            {state.contacts.length > 0 ? (
              <div className="p-2 space-y-0.5">
                {state.contacts.map(contact => {
                  const isActive = state.activeChannel === contact.id;
                  const userOnline = state.users.some(u => u.id === contact.id);
                  return (
                    <button
                      key={contact.id}
                      onClick={() => { openDm(contact.id); onSelect(); }}
                      className={cn(
                        'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
                        isActive ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-tertiary text-fg-primary'
                      )}
                    >
                      <div className="w-12 h-12 rounded-2xl bg-bg-tertiary flex items-center justify-center flex-shrink-0 relative">
                        <span className="text-[13px] font-bold text-fg-muted">
                          {getAvatarText(contact.nickname)}
                        </span>
                        {userOnline && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[15px] font-semibold block truncate">@{contact.nickname}</span>
                        <span className="text-[12px] text-fg-muted mt-0.5 block">{formatTime(contact.lastMessage)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-8 text-center">
                <p className="text-[13px] text-fg-muted">{t('no_contacts')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; cancelLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6" style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
          <div className={cn('w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5',
            danger ? 'bg-status-error/15' : 'bg-accent-primary/15'
          )}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={danger ? 'var(--color-status-error)' : 'var(--color-accent-primary)'} strokeWidth="2">
              {danger ? (
                <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
              ) : (
                <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
              )}
            </svg>
          </div>
          <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-2">{title}</h3>
          <p className="text-center text-[14px] text-fg-muted mb-6 leading-relaxed">{message}</p>
          <div className="flex gap-3">
            <button onClick={onCancel}
              className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
              {cancelLabel}
            </button>
            <button onClick={onConfirm}
              className={cn('flex-1 py-3 rounded-2xl text-[15px] font-semibold transition-colors',
                danger
                  ? 'bg-status-error text-white hover:opacity-90'
                  : 'bg-accent-primary text-accent-text hover:opacity-90'
              )}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function PasswordModal({ title, onConfirm, onCancel }: {
  title: string; onConfirm: (password: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6" style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
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
            <button onClick={onCancel}
              className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
              Cancel
            </button>
            <button onClick={() => password && onConfirm(password)} disabled={!password}
              className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40">
              OK
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsPanel({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const { state, updateSettings, logout, getMyPublicKey, getPublicKey, sessions, requestSessions, showImportModal, t } = useConnection();
  const [confirmAction, setConfirmAction] = useState<'logout' | 'clearData' | null>(null);
  const [exportModal, setExportModal] = useState(false);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
        checked ? 'bg-accent-primary' : 'bg-bg-tertiary border-border-default'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition duration-200',
        checked ? 'translate-x-5' : 'translate-x-0'
      )} />
    </button>
  );

  const Option = ({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) => (
    <div className="flex items-center justify-between py-3.5 px-4">
      <div className="flex items-center gap-3">
        {icon && <div className="w-9 h-9 rounded-xl bg-bg-tertiary flex items-center justify-center text-fg-muted flex-shrink-0">{icon}</div>}
        <span className="text-[15px] text-fg-primary">{label}</span>
      </div>
      {children}
    </div>
  );

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="space-y-0">
      <h3 className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider px-1 mb-2">{title}</h3>
      <div className="rounded-2xl border border-border-default divide-y divide-border-default overflow-hidden">
        {children}
      </div>
    </section>
  );

  const accentColors: AccentColor[] = ['purple', 'blue', 'green', 'red', 'orange', 'pink', 'teal', 'indigo'];
  const accentColorPreview: Record<AccentColor, string> = {
    purple: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', red: '#ef4444',
    orange: '#f97316', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
  };

  const SafetyNumberButton = () => {
    const [showSafety, setShowSafety] = useState(false);
    const [safetyNum, setSafetyNum] = useState('');
    const [copyOk, setCopyOk] = useState(false);

    const showNumber = async () => {
      try {
        const pubKey = getMyPublicKey();
        if (!pubKey) {
          setSafetyNum('KEY NOT FOUND — re-login required');
          setShowSafety(true);
          return;
        }
        const otherKey = state.activeChannel !== 'general' ? getPublicKey(state.activeChannel) : null;
        const num = await generateSafetyNumber(pubKey, otherKey || undefined);
        setSafetyNum(num);
        setShowSafety(true);
      } catch (e: any) {
        setSafetyNum('ERROR: ' + (e.message || 'unknown'));
        setShowSafety(true);
      }
    };

    const handleCopy = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(safetyNum);
        } else {
          const ta = document.createElement('textarea');
          ta.value = safetyNum;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setCopyOk(true);
        setTimeout(() => setCopyOk(false), 2000);
      } catch {}
    };

    return (
      <>
        <button onClick={showNumber}
          className="px-3 py-1.5 rounded-xl text-[13px] font-medium bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors">
          {t('safety_number')}
        </button>
        {showSafety && (
          <>
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" onClick={() => setShowSafety(false)} />
            <div className="fixed inset-0 flex items-center justify-center z-[61] p-4">
              <div className="bg-bg-secondary border border-border-default rounded-2xl w-full max-w-sm p-6 space-y-4 animate-in" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-[17px] font-semibold text-fg-primary">{t('safety_yours')}</h3>
                <p className="text-[13px] text-fg-muted">{t('safety_number_desc')}</p>
                <div className="p-4 rounded-xl bg-bg-tertiary font-mono text-[13px] text-fg-primary break-all text-center leading-relaxed">
                  {safetyNum}
                </div>
                <button onClick={handleCopy}
                  className="w-full py-3 rounded-xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium">
                  {copyOk ? '✓ Copied' : t('copy')}
                </button>
                <button onClick={() => setShowSafety(false)}
                  className="w-full py-3 rounded-xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity">
                  {t('done')}
                </button>
              </div>
            </div>
          </>
        )}
      </>
    );
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={onClose} style={{ animation: closing ? 'fadeOut 0.25s ease-in forwards' : 'fadeIn 0.2s ease-out' }} />

      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-bg-secondary border-l border-border-default z-50 flex flex-col" style={{ animation: closing ? 'slideOutToRight 0.25s ease-in forwards' : 'slideInFromRight 0.3s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="flex items-center justify-between px-4 h-14 border-b border-border-default">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <h2 className="text-[17px] font-semibold text-fg-primary">{t('settings')}</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-bg-tertiary text-fg-muted transition-colors" aria-label={t('close_settings')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <Section title={t('sec_appearance')}>
            <Option label={t('theme')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>}>
              <div className="flex gap-1.5">
                {(['dark', 'light'] as const).map((theme) => (
                  <button key={theme} onClick={() => updateSettings({ theme })}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap',
                      state.settings.theme === theme
                        ? 'bg-accent-primary text-accent-text'
                        : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                    )}>
                    {theme === 'dark' ? t('theme_dark') : t('theme_light')}
                  </button>
                ))}
              </div>
            </Option>
            <Option label={t('accent_color')} icon={<div className="w-4 h-4 rounded-full" style={{ backgroundColor: accentColorPreview[state.settings.accentColor || 'purple'] }} />}>
              <div className="flex gap-1.5 flex-wrap justify-end max-w-[180px]">
                {accentColors.map((color) => (
                  <button key={color} onClick={() => updateSettings({ accentColor: color })}
                    className={cn(
                      'w-7 h-7 rounded-full transition-all duration-200 border-2',
                      (state.settings.accentColor || 'purple') === color
                        ? 'border-fg-primary scale-110'
                        : 'border-transparent hover:scale-110'
                    )}
                    style={{ backgroundColor: accentColorPreview[color] }}
                    title={t(`accent_${color}`)}
                  />
                ))}
              </div>
            </Option>
            <Option label={t('language')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>}>
              <div className="flex gap-1.5">
                {(['en', 'ru'] as const).map((lang) => (
                  <button key={lang} onClick={() => updateSettings({ language: lang })}
                    className={cn(
                      'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                      state.settings.language === lang
                        ? 'bg-accent-primary text-accent-text'
                        : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                    )}>
                    {lang === 'en' ? 'English' : 'Русский'}
                  </button>
                ))}
              </div>
            </Option>
          </Section>

          <Section title={t('sec_text')}>
            <Option label={t('font_size')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>}>
              <div className="flex gap-1.5">
                {(['small', 'normal', 'large'] as const).map((size) => (
                  <button key={size} onClick={() => updateSettings({ fontSize: size })}
                    className={cn(
                      'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                      state.settings.fontSize === size
                        ? 'bg-accent-primary text-accent-text'
                        : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                    )}>
                    {t(`font_${size}`)}
                  </button>
                ))}
              </div>
            </Option>
            <Option label={t('compact_mode')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="21" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="21" y1="18" x2="3" y2="18" /></svg>}>
              <Toggle checked={state.settings.compactMode || false} onChange={(v) => updateSettings({ compactMode: v })} />
            </Option>
          </Section>

          <Section title={t('sec_notifications')}>
            <Option label={t('enable_notifications')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>}>
              <Toggle checked={state.settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />
            </Option>
            <Option label={t('message_sound')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>}>
              <Toggle checked={state.settings.soundEnabled} onChange={(v) => updateSettings({ soundEnabled: v })} />
            </Option>
          </Section>

          <Section title={t('sec_safety')}>
            <Option label={t('safety_number')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}>
              <SafetyNumberButton />
            </Option>
            <Option label={t('export_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>}>
              <button onClick={() => setExportModal(true)} className="text-[13px] text-accent-primary hover:underline">{t('export_keys')}</button>
            </Option>
            <Option label={t('import_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>}>
              <input type="file" accept=".json" className="hidden" id="import-keys-input-mobile" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const text = await file.text();
                  const data = JSON.parse(text);
                  if (!isKeyBackup(data)) { alert(t('key_import_err')); return; }
                  showImportModal(data, 'settings');
                } catch { alert(t('key_import_err')); }
                e.target.value = '';
              }} />
              <label htmlFor="import-keys-input-mobile" className="text-[13px] text-accent-primary hover:underline cursor-pointer">{t('import_keys')}</label>
            </Option>
            <Option label={t('screenshot_prot')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="3" x2="21" y2="21" /></svg>}>
              <Toggle checked={!!localStorage.getItem('wn_screenshot_prot')} onChange={(v) => {
                if (v) localStorage.setItem('wn_screenshot_prot', '1');
                else localStorage.removeItem('wn_screenshot_prot');
              }} />
            </Option>
          </Section>

          <Section title={t('sessions')}>
            <div className="px-4 py-3">
              <button onClick={requestSessions} className="text-[13px] text-accent-primary hover:underline mb-2">{t('sessions_desc')}</button>
              {sessions.length > 0 && (
                <div className="space-y-2 mt-2">
                  {sessions.map((s) => (
                    <div key={s.id} className="flex items-center justify-between py-2 px-3 rounded-xl bg-bg-tertiary">
                      <div>
                        <span className="text-[13px] text-fg-primary">{t('sessions')} (you)</span>
                        <span className="text-[11px] text-fg-muted block">{new Date(s.lastActive).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title={t('sec_account')}>
            <Option label={state.nickname ? `@${state.nickname}` : ''} icon={<div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center text-[13px] font-bold text-accent-primary">{state.nickname ? getAvatarText(state.nickname) : ''}</div>}>
              <span className="text-[12px] text-fg-muted">{t('version')} {__APP_VERSION__}</span>
            </Option>
          </Section>
        </div>

        <div className="p-4 border-t border-border-default space-y-2.5 pb-safe">
          <button onClick={() => setConfirmAction('logout')}
            className="w-full py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium flex items-center justify-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('logout')}
          </button>
          <button onClick={() => setConfirmAction('clearData')}
            className="w-full py-3 rounded-2xl text-status-error text-[13px] hover:bg-status-error/10 transition-colors font-medium">
            {t('clear_local_data')}
          </button>
        </div>
      </div>

      {confirmAction === 'logout' && (
        <ConfirmModal
          title={t('confirm_logout')}
          message={t('confirm_logout_desc')}
          confirmLabel={t('logout')}
          cancelLabel={t('cancel')}
          danger
          onConfirm={() => { logout(); onClose(); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'clearData' && (
        <ConfirmModal
          title={t('confirm_clear_data')}
          message={t('confirm_clear_data_desc')}
          confirmLabel={t('confirm_clear')}
          cancelLabel={t('cancel')}
          danger
          onConfirm={() => { (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('wn_')); keys.forEach(k => localStorage.removeItem(k)); })(); window.location.reload(); }}
          onCancel={() => setConfirmAction(null)}
        />
    )}
    {exportModal && (
      <PasswordModal title={t('enter_backup_password')} onCancel={() => setExportModal(false)} onConfirm={async (pass) => {
        try {
          const nick = state.nickname.toLowerCase();
          const savedKey = localStorage.getItem(`wn_pk_${nick}`);
          const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
          if (!savedKey || !savedPubKey) return;
          const parsed = JSON.parse(savedKey);
          let bundle: EncryptedKeyBundle;
          if (isEncryptedBundle(parsed)) {
            bundle = parsed;
          } else {
            bundle = await encryptPrivateKey(parsed, pass);
            bundle.publicKey = JSON.parse(savedPubKey);
          }
          const backup = createBackup(state.nickname, bundle.publicKey, bundle);
          downloadBackup(backup);
        } catch {}
        setExportModal(false);
      }} />
    )}
    </>
  );
}

function SettingsPanelInline() {
  const { state, updateSettings, logout, getMyPublicKey, getPublicKey, sessions, requestSessions, showImportModal, t } = useConnection();
  const [confirmAction, setConfirmAction] = useState<'logout' | 'clearData' | null>(null);
  const [exportModal, setExportModal] = useState(false);

  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
        checked ? 'bg-accent-primary' : 'bg-bg-tertiary border-border-default'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition duration-200',
        checked ? 'translate-x-5' : 'translate-x-0'
      )} />
    </button>
  );

  const Option = ({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) => (
    <div className="flex items-center justify-between py-3.5 px-4">
      <div className="flex items-center gap-3">
        {icon && <div className="w-9 h-9 rounded-xl bg-bg-tertiary flex items-center justify-center text-fg-muted flex-shrink-0">{icon}</div>}
        <span className="text-[15px] text-fg-primary">{label}</span>
      </div>
      {children}
    </div>
  );

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="space-y-0">
      <h3 className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider px-1 mb-2">{title}</h3>
      <div className="rounded-2xl border border-border-default divide-y divide-border-default overflow-hidden">
        {children}
      </div>
    </section>
  );

  const accentColors: AccentColor[] = ['purple', 'blue', 'green', 'red', 'orange', 'pink', 'teal', 'indigo'];
  const accentColorPreview: Record<AccentColor, string> = {
    purple: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', red: '#ef4444',
    orange: '#f97316', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
  };

  const SafetyNumberButton = () => {
    const [showSafety, setShowSafety] = useState(false);
    const [safetyNum, setSafetyNum] = useState('');
    const [copyOk, setCopyOk] = useState(false);

    const showNumber = async () => {
      try {
        const pubKey = getMyPublicKey();
        if (!pubKey) {
          setSafetyNum('KEY NOT FOUND — re-login required');
          setShowSafety(true);
          return;
        }
        const otherKey = state.activeChannel !== 'general' ? getPublicKey(state.activeChannel) : null;
        const num = await generateSafetyNumber(pubKey, otherKey || undefined);
        setSafetyNum(num);
        setShowSafety(true);
      } catch (e: any) {
        setSafetyNum('ERROR: ' + (e.message || 'unknown'));
        setShowSafety(true);
      }
    };

    const handleCopy = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(safetyNum);
        } else {
          const ta = document.createElement('textarea');
          ta.value = safetyNum;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setCopyOk(true);
        setTimeout(() => setCopyOk(false), 2000);
      } catch {}
    };

    return (
      <>
        <button onClick={showNumber}
          className="px-3 py-1.5 rounded-xl text-[13px] font-medium bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors">
          {t('safety_number')}
        </button>
        {showSafety && (
          <>
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" onClick={() => setShowSafety(false)} />
            <div className="fixed inset-0 flex items-center justify-center z-[61] p-4">
              <div className="bg-bg-secondary border border-border-default rounded-2xl w-full max-w-sm p-6 space-y-4 animate-in" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-[17px] font-semibold text-fg-primary">{t('safety_yours')}</h3>
                <p className="text-[13px] text-fg-muted">{t('safety_number_desc')}</p>
                <div className="p-4 rounded-xl bg-bg-tertiary font-mono text-[13px] text-fg-primary break-all text-center leading-relaxed">
                  {safetyNum}
                </div>
                <button onClick={handleCopy}
                  className="w-full py-3 rounded-xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium">
                  {copyOk ? '✓ Copied' : t('copy')}
                </button>
                <button onClick={() => setShowSafety(false)}
                  className="w-full py-3 rounded-xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity">
                  {t('done')}
                </button>
              </div>
            </div>
          </>
        )}
      </>
    );
  };

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="px-4 h-14 flex items-center border-b border-border-default">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <h2 className="text-[17px] font-semibold text-fg-primary">{t('settings')}</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <Section title={t('sec_appearance')}>
          <Option label={t('theme')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>}>
            <div className="flex gap-1.5">
              {(['dark', 'light'] as const).map((theme) => (
                <button key={theme} onClick={() => updateSettings({ theme })}
                  className={cn(
                    'flex-1 px-2 py-1.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap',
                    state.settings.theme === theme
                      ? 'bg-accent-primary text-accent-text'
                      : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                  )}>
                  {theme === 'dark' ? t('theme_dark') : t('theme_light')}
                </button>
              ))}
            </div>
          </Option>
          <Option label={t('accent_color')} icon={<div className="w-4 h-4 rounded-full" style={{ backgroundColor: accentColorPreview[state.settings.accentColor || 'purple'] }} />}>
            <div className="flex gap-1.5 flex-wrap justify-end max-w-[180px]">
              {accentColors.map((color) => (
                <button key={color} onClick={() => updateSettings({ accentColor: color })}
                  className={cn(
                    'w-7 h-7 rounded-full transition-all duration-200 border-2',
                    (state.settings.accentColor || 'purple') === color
                      ? 'border-fg-primary scale-110'
                      : 'border-transparent hover:scale-110'
                  )}
                  style={{ backgroundColor: accentColorPreview[color] }}
                  title={t(`accent_${color}`)}
                />
              ))}
            </div>
          </Option>
          <Option label={t('language')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>}>
            <div className="flex gap-1.5">
              {(['en', 'ru'] as const).map((lang) => (
                <button key={lang} onClick={() => updateSettings({ language: lang })}
                  className={cn(
                    'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                    state.settings.language === lang
                      ? 'bg-accent-primary text-accent-text'
                      : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                  )}>
                  {lang === 'en' ? 'English' : 'Русский'}
                </button>
              ))}
            </div>
          </Option>
        </Section>

        <Section title={t('sec_text')}>
          <Option label={t('font_size')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>}>
            <div className="flex gap-1.5">
              {(['small', 'normal', 'large'] as const).map((size) => (
                <button key={size} onClick={() => updateSettings({ fontSize: size })}
                  className={cn(
                    'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                    state.settings.fontSize === size
                      ? 'bg-accent-primary text-accent-text'
                      : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                  )}>
                  {t(`font_${size}`)}
                </button>
              ))}
            </div>
          </Option>
          <Option label={t('compact_mode')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="21" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="21" y1="18" x2="3" y2="18" /></svg>}>
            <Toggle checked={state.settings.compactMode || false} onChange={(v) => updateSettings({ compactMode: v })} />
          </Option>
        </Section>

        <Section title={t('sec_notifications')}>
          <Option label={t('enable_notifications')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>}>
            <Toggle checked={state.settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />
          </Option>
          <Option label={t('message_sound')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>}>
            <Toggle checked={state.settings.soundEnabled} onChange={(v) => updateSettings({ soundEnabled: v })} />
          </Option>
        </Section>

        <Section title={t('sec_safety')}>
          <Option label={t('safety_number')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}>
            <SafetyNumberButton />
          </Option>
          <Option label={t('export_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>}>
            <button onClick={() => setExportModal(true)} className="text-[13px] text-accent-primary hover:underline">{t('export_keys')}</button>
          </Option>
          <Option label={t('import_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>}>
            <input type="file" accept=".json" className="hidden" id="import-keys-input" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!isKeyBackup(data)) { alert(t('key_import_err')); return; }
                showImportModal(data, 'settings');
              } catch { alert(t('key_import_err')); }
              e.target.value = '';
            }} />
            <label htmlFor="import-keys-input" className="text-[13px] text-accent-primary hover:underline cursor-pointer">{t('import_keys')}</label>
          </Option>
          <Option label={t('screenshot_prot')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="3" x2="21" y2="21" /></svg>}>
            <Toggle checked={!!localStorage.getItem('wn_screenshot_prot')} onChange={(v) => {
              if (v) localStorage.setItem('wn_screenshot_prot', '1');
              else localStorage.removeItem('wn_screenshot_prot');
            }} />
          </Option>
        </Section>

        <Section title={t('sessions')}>
          <div className="px-4 py-3">
            <button onClick={requestSessions} className="text-[13px] text-accent-primary hover:underline mb-2">{t('sessions_desc')}</button>
            {sessions.length > 0 && (
              <div className="space-y-2 mt-2">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-2 px-3 rounded-xl bg-bg-tertiary">
                    <div>
                      <span className="text-[13px] text-fg-primary">{t('sessions')} (you)</span>
                      <span className="text-[11px] text-fg-muted block">{new Date(s.lastActive).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section title={t('sec_account')}>
          <Option label={state.nickname ? `@${state.nickname}` : ''} icon={<div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center text-[13px] font-bold text-accent-primary">{state.nickname ? getAvatarText(state.nickname) : ''}</div>}>
            <span className="text-[12px] text-fg-muted">{t('version')} {__APP_VERSION__}</span>
          </Option>
        </Section>
      </div>

      <div className="p-4 border-t border-border-default space-y-2.5 pb-safe">
        <button onClick={() => setConfirmAction('logout')}
          className="w-full py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium flex items-center justify-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {t('logout')}
        </button>
        <button onClick={() => setConfirmAction('clearData')}
          className="w-full py-3 rounded-2xl text-status-error text-[13px] hover:bg-status-error/10 transition-colors font-medium">
          {t('clear_local_data')}
        </button>
      </div>

      {confirmAction === 'logout' && (
        <ConfirmModal
          title={t('confirm_logout')}
          message={t('confirm_logout_desc')}
          confirmLabel={t('logout')}
          cancelLabel={t('cancel')}
          danger
          onConfirm={() => { logout(); window.location.reload(); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'clearData' && (
        <ConfirmModal
          title={t('confirm_clear_data')}
          message={t('confirm_clear_data_desc')}
          confirmLabel={t('confirm_clear')}
          cancelLabel={t('cancel')}
          danger
          onConfirm={() => { (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('wn_')); keys.forEach(k => localStorage.removeItem(k)); })(); window.location.reload(); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {exportModal && (
        <PasswordModal title={t('enter_backup_password')} onCancel={() => setExportModal(false)} onConfirm={async (pass) => {
          try {
            const nick = state.nickname.toLowerCase();
            const savedKey = localStorage.getItem(`wn_pk_${nick}`);
            const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
            if (!savedKey || !savedPubKey) return;
            const parsed = JSON.parse(savedKey);
            let bundle: EncryptedKeyBundle;
            if (isEncryptedBundle(parsed)) {
              bundle = parsed;
            } else {
              bundle = await encryptPrivateKey(parsed, pass);
              bundle.publicKey = JSON.parse(savedPubKey);
            }
            const backup = createBackup(state.nickname, bundle.publicKey, bundle);
            downloadBackup(backup);
          } catch {}
          setExportModal(false);
        }} />
      )}
    </div>
  );
}

function ChatArea({ showContacts: _showContacts, isMobile, onBack }: { showContacts: boolean; isMobile?: boolean; onBack?: () => void }) {
  const { state } = useConnection();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const currentMessages = isDm ? (state.dmMessages[state.activeChannel] || []) : state.messages;

  const handleCloseSettings = () => {
    setSettingsClosing(true);
    setTimeout(() => { setShowSettings(false); setSettingsClosing(false); }, 250);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopBar onSettingsClick={() => setShowSettings(true)} isMobile={isMobile} onBack={onBack} />
      <MessageList key={state.activeChannel} messages={currentMessages} />
      <div className="border-t border-border-default">
        <MessageInput />
      </div>
      {!isMobile && showSettings && <SettingsPanel onClose={handleCloseSettings} closing={settingsClosing} />}
    </div>
  );
}

function LoginScreen() {
  const { connect, state, t } = useConnection();
  const [isRegister, setIsRegister] = useState(false);
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const nicknameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nicknameRef.current?.focus(); }, []);

  useEffect(() => {
    document.title = 'WhisperNet';
    window.electronAPI?.setTitle('WhisperNet');
  }, []);

  useEffect(() => {
    if (state.status === 'connected' || state.authError) setLoading(false);
  }, [state.status, state.authError]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !password) return;
    setLoading(true);
    connect(nickname.trim(), password, isRegister);
  };

  return (
    <div className="flex h-full items-center justify-center p-4 bg-bg-primary">
      <div className="w-full max-w-sm" style={{ animation: 'fadeSlideIn 0.4s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="text-center mb-8">
          <img src="/logo.svg" alt="WhisperNet" className="w-20 h-20 mx-auto mb-5" />
          <h1 className="text-2xl font-bold text-fg-primary tracking-tight">WhisperNet</h1>
          <p className="text-sm text-fg-muted mt-1.5">{t('about_desc').split('.')[0]}</p>
        </div>

        <div className="flex gap-1 p-1 bg-bg-tertiary rounded-2xl mb-5">
          <button type="button" onClick={() => setIsRegister(false)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              !isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('login')}
          </button>
          <button type="button" onClick={() => setIsRegister(true)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('register')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('nickname')}</label>
            <input ref={nicknameRef} type="text" value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="input" placeholder={t('nickname_placeholder')}
              autoComplete="username" maxLength={16} disabled={loading} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('password')}</label>
            <input type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input" placeholder={isRegister ? t('password_create') : t('password_enter')}
              autoComplete={isRegister ? 'new-password' : 'current-password'} maxLength={32} disabled={loading} />
          </div>

          {state.authError && (
            <div className="p-3 rounded-xl bg-status-error/10 border border-status-error/20 text-status-error text-sm text-center">
              {state.authError}
            </div>
          )}

          <button type="submit" disabled={loading || !nickname.trim() || !password}
            className="btn-primary w-full py-3.5 text-[15px] mt-2">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {isRegister ? t('creating_account') : t('signing_in')}
              </span>
            ) : (isRegister ? t('create_account') : t('sign_in'))}
          </button>
        </form>

        <p className="text-center text-xs text-fg-subtle mt-5">{t('nickname_hint')}</p>
      </div>
    </div>
  );
}

function UpdateOverlay() {
  const [state, setState] = useState<'checking' | 'available' | 'downloading' | 'extracting' | 'ready' | 'error' | null>(null);
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onUpdateAvailable((_e: any, data: any) => {
        setVersion(data.version);
        setState('available');
      }),
      window.electronAPI.onUpdateProgress((_e: any, data: any) => {
        setState('downloading');
        setPercent(data.percent);
        if (data.status === 'extracting') setState('extracting');
      }),
      window.electronAPI.onUpdateReady((_e: any, data: any) => {
        setVersion(data.version);
        setState('ready');
      }),
      window.electronAPI.onUpdateError((_e: any, data: any) => {
        setErrorMsg(data.message);
        setState('error');
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  if (!state) return null;

  const handleRestart = () => {
    if (state === 'ready') window.electronAPI?.applyUpdate();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center animate-in">
        {state === 'available' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-primary/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">Update Available</h2>
            <p className="text-sm text-fg-secondary mb-6">Version {version} is ready to install.</p>
            <button onClick={() => setState('downloading')} className="w-full py-3 rounded-2xl bg-accent-primary hover:brightness-110 text-white font-medium transition-all">
              Update Now
            </button>
          </>
        )}
        {state === 'downloading' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">Downloading Update</h2>
            <p className="text-sm text-fg-secondary mb-4">Version {version}</p>
            <div className="w-full h-2.5 bg-bg-tertiary rounded-full overflow-hidden mb-2">
              <div className="h-full bg-accent-primary rounded-full transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-fg-muted">{percent}%</p>
          </>
        )}
        {state === 'extracting' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">Installing Update</h2>
            <p className="text-sm text-fg-secondary">Please wait...</p>
          </>
        )}
        {state === 'ready' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-green-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">Update Ready</h2>
            <p className="text-sm text-fg-secondary mb-6">Version {version} installed. Restart to apply.</p>
            <button onClick={handleRestart} className="w-full py-3 rounded-2xl bg-accent-primary hover:brightness-110 text-white font-medium transition-all">
              Restart Now
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">Update Failed</h2>
            <p className="text-sm text-fg-secondary mb-6">{errorMsg || 'An error occurred while updating.'}</p>
            <button onClick={() => setState(null)} className="w-full py-3 rounded-2xl bg-bg-tertiary hover:bg-bg-hover text-fg-primary font-medium transition-colors">
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AppInner() {
  const { state, openDm, openGeneral, searchUsers, reconnect, t } = useConnection();
  const [mobileTab, setMobileTab] = useState<'home' | 'settings'>('home');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setMobileChatOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const on = !!localStorage.getItem('wn_screenshot_prot');
    document.body.classList.toggle('screenshot-protect', on);
    const handler = (e: Event) => { if (on) e.preventDefault(); };
    if (on) {
      document.addEventListener('contextmenu', handler);
      document.addEventListener('selectstart', handler);
    }
    return () => {
      document.removeEventListener('contextmenu', handler);
      document.removeEventListener('selectstart', handler);
    };
  }, [mobileTab]);

  const mobileChatOpenRef = useRef(mobileChatOpen);
  mobileChatOpenRef.current = mobileChatOpen;
  const mobileTabRef = useRef(mobileTab);
  mobileTabRef.current = mobileTab;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.Capacitor?.Plugins?.App?.addListener) return;

    const handleBackButton = () => {
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      if (mobileChatOpenRef.current) {
        setMobileChatOpen(false);
        return;
      }
      if (mobileTabRef.current === 'settings') {
        setMobileTab('home');
        return;
      }
      try { window.Capacitor?.Plugins?.App?.exitApp?.(); } catch {}
    };

    let backHandler: any = null;
    window.Capacitor.Plugins.App.addListener('backButton', handleBackButton).then((h: any) => { backHandler = h; });

    return () => {
      try { backHandler?.remove?.(); } catch {}
    };
  }, []);

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchUsers(value);
    }, 300);
  };

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
              <button onClick={() => reconnect()}
                className="px-6 py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 transition-all">
                {t('retry')}
              </button>
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
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder={t('search_placeholder')}
                  className="w-full px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
                />
              </div>

              <div className="flex-1 overflow-y-auto">
                {searchQuery.length > 0 && state.searchResults.length > 0 && (
                  <>
                    <div className="px-5 py-2">
                      <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('search_results')}</span>
                    </div>
                    <div className="px-3 pb-2 space-y-0.5">
                      {state.searchResults.map(user => (
                        <button
                          key={user.id}
                          onClick={() => { openDm(user.id); setMobileChatOpen(true); setSearchQuery(''); }}
                          className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all text-left hover:bg-bg-tertiary"
                        >
                          <div className="w-12 h-12 rounded-2xl bg-accent-primary/10 flex items-center justify-center flex-shrink-0 relative">
                            <span className="text-[14px] font-bold text-accent-primary">{getAvatarText(user.nickname)}</span>
                            {user.online && (
                              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                            )}
                          </div>
                          <div>
                            <span className="text-[15px] font-semibold text-fg-primary">@{user.nickname}</span>
                            <span className={cn('block text-[12px] mt-0.5', user.online ? 'text-status-success' : 'text-fg-muted')}>
                              {user.online ? t('online') : t('offline')}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {searchQuery.length > 0 && state.searchResults.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-[13px] text-fg-muted">{t('no_results')}</p>
                  </div>
                )}

                {searchQuery.length === 0 && (
                  <>
                    <div className="px-3 pb-2">
                      <button
                        onClick={() => { openGeneral(); setMobileChatOpen(true); }}
                        className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl transition-all text-left hover:bg-bg-tertiary"
                      >
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

                    {state.contacts.length > 0 && (
                      <>
                        <div className="px-5 py-2.5">
                          <span className="text-[12px] font-semibold text-fg-muted uppercase tracking-wider">{t('contacts')}</span>
                        </div>
                        <div className="px-3 pb-2 space-y-0.5">
                          {state.contacts.map(contact => (
                            <button
                              key={contact.id}
                              onClick={() => { openDm(contact.id); setMobileChatOpen(true); }}
                              className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all text-left hover:bg-bg-tertiary"
                            >
                              <div className="w-12 h-12 rounded-2xl bg-accent-primary/10 flex items-center justify-center flex-shrink-0 relative">
                                <span className="text-[14px] font-bold text-accent-primary">{getAvatarText(contact.nickname)}</span>
                                {contact.online && (
                                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                                )}
                              </div>
                              <div>
                                <span className="text-[15px] font-semibold text-fg-primary">@{contact.nickname}</span>
                                <span className={cn('block text-[12px] mt-0.5', contact.online ? 'text-status-success' : 'text-fg-muted')}>
                                  {contact.online ? t('online') : t('offline')}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {state.contacts.length === 0 && (
                      <div className="px-4 py-8 text-center">
                        <p className="text-[13px] text-fg-muted">{t('no_contacts')}</p>
                      </div>
                    )}
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
              <SettingsPanelInline />
            </div>
          )}
        </div>

        {!mobileChatOpen && (
          <nav className="flex items-center justify-around border-t border-border-default bg-bg-secondary px-2 pb-safe">
            <button
              onClick={() => { setMobileTab('home'); setMobileChatOpen(false); setSearchQuery(''); }}
              className={cn(
                'flex flex-col items-center gap-0.5 py-2 px-6 rounded-xl transition-all duration-200',
                mobileTab === 'home' ? 'text-accent-primary' : 'text-fg-muted'
              )}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span className="text-[10px] font-medium">{t('home')}</span>
            </button>
            <button
              onClick={() => { setMobileTab('settings'); setMobileChatOpen(false); }}
              className={cn(
                'flex flex-col items-center gap-0.5 py-2 px-6 rounded-xl transition-all duration-200',
                mobileTab === 'settings' ? 'text-accent-primary' : 'text-fg-muted'
              )}
            >
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

function App() {
  return (
    <ConnectionProvider>
      <UpdateOverlay />
      <AppInner />
    </ConnectionProvider>
  );
}

export default App;
