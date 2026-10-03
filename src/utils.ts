import type { AppSettings } from './types';

export const defaultSettings: AppSettings = {
  theme: 'light',
  accentColor: 'purple',
  language: 'en',
  notifications: true,
  soundEnabled: true,
  fontSize: 'normal',
  compactMode: false,
  disappearingTTL: 'off',
  screenshotProtection: false,
};

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface MessageControls { edit: boolean; remove: boolean; report: boolean }

/**
 * Who may correct, remove or report a message.
 *
* Authorship decides all three, and nothing else. These controls once hung off the sealed-sender
 * flag, which had the two halves of a private chat exactly backwards: the reader of an anonymous
 * message was handed the pencil and the bin, and the person who had actually written it could do
 * nothing but delete. Nobody can rewrite someone else's words.
 *
 * Reporting is a different question and is not about authorship at all: it is about who was on the
 * receiving end. Everyone can report what was sent to them, which is exactly why a report is refused
 * when the reporter is the author.
 *
 * Media is excluded from editing because there is no text to correct.
 */
export function messageControls(message: { isOwn: boolean }, isMedia = false): MessageControls {
  return {
    edit: message.isOwn && !isMedia,
    remove: message.isOwn,
    report: !message.isOwn,
  };
}

export async function getDeviceLabel(): Promise<string> {

  let high: any;
  try {
    const uad = (navigator as any).userAgentData;
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      high = await Promise.race([
        uad.getHighEntropyValues(['platformVersion', 'model', 'uaFullVersion', 'platform']),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 800)),
      ]);
    }
  } catch { high = undefined; }
  return deviceLabel(navigator.userAgent, high);
}

export function getDeviceName(ua: string = navigator.userAgent): string {
  return deviceLabel(ua, undefined);
}

function deviceLabel(ua: string, high?: any): string {
  const lower = ua.toLowerCase();

  let browser = 'Web';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/opr\/|opera/.test(lower)) browser = 'Opera';
  else if (/samsungbrowser\//.test(lower)) browser = 'Samsung Internet';
  else if (/chrome\//.test(lower) && !/chromium/.test(lower)) browser = 'Chrome';
  else if (/chromium/.test(lower)) browser = 'Chromium';
  else if (/firefox\//.test(lower)) browser = 'Firefox';
  else if (/safari\//.test(lower)) browser = 'Safari';
  const browserVer = (lower.match(/edg\/(\d+)|opr\/(\d+)|chrome\/(\d+)|firefox\/(\d+)/) || []);
  if (browserVer[1] || browserVer[2] || browserVer[3] || browserVer[4]) {
    browser += ' ' + (browserVer[1] || browserVer[2] || browserVer[3] || browserVer[4]);
  }

  let os = 'Desktop';
  const platform = (high && high.platform) || (navigator as any).userAgentData?.platform || '';

  if (/android/.test(lower) || platform === 'Android') {
    const ver = (lower.match(/android (\d+(?:\.\d+)?)/) || [])[1] || '';
    const m = ua.match(/Android[\d.]*[;\s]+([^;]+?)(?:\s+Build[^;)]*)?\)/i);
    let model = (m && m[1].trim()) || '';
    if (!model && high && typeof high.model === 'string' && high.model) model = high.model;
    model = model.replace(/_/g, ' ').trim();
    os = ver ? `Android ${ver}` : 'Android';
    if (model && !/build/i.test(model)) os += ` · ${model}`;
  } else if (/iphone|ipad|ipod/.test(lower) || platform === 'iPhone' || platform === 'iPad' || platform === 'iPod') {
    const vm = (lower.match(/os (\d+)(?:_(\d+))?/) || []);
    const ver = vm[1] ? ` ${vm[1]}` + (vm[2] ? `.${vm[2]}` : '') : '';
    let model = 'iPhone';
    if (platform === 'iPad' || /ipad/.test(lower)) model = 'iPad';
    else if (/ipod/.test(lower)) model = 'iPod';
    os = `${model} iOS${ver}`;
  } else if (/windows nt 10/.test(lower) || platform === 'Win32') {
    const pv = high && typeof high.platformVersion === 'string' ? high.platformVersion : '';
    const major = parseInt(pv.split('.')[0], 10);
    if (pv && major >= 15) os = 'Windows 11';
    else if (pv && major >= 13) os = 'Windows 10';
    else os = 'Windows 10/11';
  } else if (/windows nt/.test(lower) || /windows\s*win/.test(lower)) {
    os = 'Windows';
  } else if (/mac os x|macintosh/.test(lower) || platform === 'macOS') {
    const m = lower.match(/mac os x (\d+)[._](\d+)/);
    os = 'macOS' + (m ? ` ${m[1]}.${m[2]}` : '');
  } else if (/linux/.test(lower) || platform === 'Linux') {
    os = 'Linux';
  }

  if (window.__wnDesktop) {
    return os === 'Desktop' ? 'WhisperNet Desktop' : `WhisperNet Desktop · ${os}`;
  }
  return `${browser} · ${os}`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
           ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function getAvatarText(nickname: string): string {
  const words = (nickname || '').split(/[_\-\s]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return (words[0]?.charAt(0) || '?').toUpperCase();
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #7c3aed, #a78bfa)',
  'linear-gradient(135deg, #2563eb, #60a5fa)',
  'linear-gradient(135deg, #059669, #34d399)',
  'linear-gradient(135deg, #dc2626, #f87171)',
  'linear-gradient(135deg, #ea580c, #fb923c)',
  'linear-gradient(135deg, #db2777, #f472b6)',
  'linear-gradient(135deg, #0d9488, #2dd4bf)',
  'linear-gradient(135deg, #4f46e5, #818cf8)',
  'linear-gradient(135deg, #d97706, #fbbf24)',
  'linear-gradient(135deg, #0284c7, #38bdf8)',
];

export function getAvatarGradient(nickname: string): string {
  let hash = 5381;
  for (let i = 0; i < nickname.length; i++) {
    hash = ((hash << 5) + hash + nickname.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

export function avatarUrl(userId: string, ext: string | null | undefined, updatedAt: number | null | undefined): string | null {
  if (!userId || !ext) return null;
  return `${window.location.origin}/api/avatar/${userId}?v=${updatedAt || 0}`;
}

export function formatProfileDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem('wn_settings');
    if (saved) {
      const parsed: AppSettings = { ...defaultSettings, ...JSON.parse(saved) };
      // the flag used to live in its own key, so an existing installation keeps its choice
      if (typeof parsed.screenshotProtection !== 'boolean') {
        parsed.screenshotProtection = !!localStorage.getItem('wn_screenshot_prot');
      }
      return parsed;
    }
  } catch {}
  return defaultSettings;
}

export const translations = {
  en: {
    connected: 'Online',
    connecting: 'Connecting...',
    disconnected: 'Offline',
    reconnecting: 'Reconnecting...',
    status_connected: 'Connected',
    status_disconnected: 'No connection',
    server_unreachable: 'Server is unreachable. Check your connection.',
    retry: 'Retry',
    status_connecting: 'Connecting...',
    settings: 'Settings',
    general: 'Global Chat',
    theme: 'Theme',
    theme_dark: 'Dark',
    theme_light: 'Light',
    language: 'Language',
    lang_ru: 'Русский',
    enable_notifications: 'Enable notifications',
    message_sound: 'Message sound',
    data: 'Data',
    clear_local_data: 'Clear local data',
    confirm_clear: 'Clear',
    confirm_clear_data: 'Clear all local data?',
    confirm_clear_data_desc: 'All settings and encryption keys will be removed from this browser. This action is irreversible.',
    cancel: 'Cancel',
    back: 'Back',
    done: 'Done',
    copy: 'Copy',
    login: 'Login',
    register: 'Register',
    nickname: 'Nickname',
    password: 'Password',
    nickname_placeholder: 'Enter nickname (3-16 chars)',
    password_create: 'Create password (8-64 chars, letters + numbers)',
    password_enter: 'Enter password',
    create_account: 'Create Account',
    sign_in: 'Sign In',
    creating_account: 'Creating account...',
    signing_in: 'Signing in...',
    nickname_hint: 'Nickname: 3-16 chars, letters/numbers/_- only',
    type_message: 'Type a message...',
    not_connected: 'Not connected',
    send_message: 'Send message',
    close_settings: 'Close settings',
    logout: 'Log out',
    confirm_logout: 'Log out of account?',
    confirm_logout_desc: 'You will need to sign in again; this also frees this device\'s session slot.',
    online_users: 'Online',
    no_messages: 'No messages yet. Say hello!',
    delete: 'Delete',
    search_messages: 'Search messages',
    font_size: 'Font size',
    font_small: 'Small',
    font_normal: 'Normal',
    font_large: 'Large',
    compact_mode: 'Compact mode',
    chat: 'Chat',
    no_chats: 'No chats yet',
    search_placeholder: 'Search...',
    search_tab_users: 'People',
    search_tab_messages: 'Messages',
    search_messages_placeholder: 'Search in messages...',
    search_messages_hint: 'Type at least two characters',
    search_messages_none: 'No messages found',
    search_results: 'Results',
    no_results: 'Nothing found',
    chats: 'Chats',
    global_chat: 'Global Chat',
    global_chat_desc: 'Public chat for everyone',
    home: 'Home',
    about_desc: 'Minimalist messenger with end-to-end encryption. Private, self-hosted, lightweight and fast. Your data stays on your server.',
    online: 'Online',
    offline: 'Offline',
    banned: 'Banned',
    sec_appearance: 'Appearance',
    sec_text: 'Text',
    sec_notifications: 'Notifications',
    sec_safety: 'Security',
    safety_yours: 'Your safety number',
    import_keys: 'Import Keys',
    screenshot_prot: 'Screenshot Protection',
    sessions: 'Active Sessions',
    privacy_e2ee_title: 'End-to-end encrypted',
    privacy_e2ee_note: 'Nobody but the two of you can read a private message, this server included. It does record who was in the conversation and when, which is what lets a report or a block be acted on.',
    sessions_desc: 'Manage connected devices',
    sessions_note: 'Up to 3 active sessions. Logging in from a new device while at the limit is rejected until you revoke an older session.',
    current_session: 'This device',
    editing_message: 'Editing message',
    safety_number: 'Safety number',
    safety_number_show: 'Show',
    safety_number_hide: 'Hide',
    safety_number_hint: 'Compare this with the same number on their screen, in person or over a call you both recognise. If they match, no server in between has swapped your keys.',
    safety_number_unavailable: 'No key published yet. This person has to send a message first.',
    admin_section: 'Moderation',
    admin_reports: 'Reports',
    admin_no_reports: 'No reports yet',
    admin_ban: 'Ban',
    admin_unban: 'Unban',
    admin_ban_nick: 'Ban by nickname',
    admin_ban_hint: '@nickname',
    admin_confirm_ban: 'Ban this user?',
    admin_confirm_unban: 'Unban this user?',
    admin_blocked: 'Blocked users',
    admin_blocked_empty: 'No one is banned',
    admin_unblock: 'Unblock',
    admin_channel_general: 'General chat',
    admin_channel_dm: 'DM',
    block: 'Block',
    block_dialog_title: 'Block user',
    block_dialog_desc: 'Block this user? They will no longer be able to send you messages.',
    blocked_chat_hint: 'Blocked. Send messages after unblocking',
    unblock: 'Unblock',
    reply: 'Reply',
    edit_message: 'Edit',
    report: 'Report',
    report_title: 'Report user',
    report_desc: 'Tell us what this user did — a moderator will review it.',
    report_reason_scam: 'Scam',
    report_reason_harassment: 'Harassment',
    report_reason_inappropriate: 'Inappropriate content',
    report_reason_other: 'Other',
    report_send: 'Send report',
    report_sent: 'Report sent. Thank you for helping keep WhisperNet safe.',
    report_failed: 'Could not send the report. Please try again.',
    try_again: 'Try again',
    sending: 'Sending...',
    report_hint: 'Briefly describe the issue (optional)',
    report_from_profile: 'Profile',
    you: 'you',
    edited: 'edited',
    reactions: 'Reactions',
    close: 'Close',
    attach_file: 'Attach file',
    video_att: 'Video',
    photo_att: 'Photo',
    invalid_url: 'Invalid URL',
    update_available: 'Update Available',
    update_available_desc: 'Version {version} is ready to install.',
    update_version: 'Version ',
    update_downloading: 'Downloading Update',
    update_extracting: 'Installing Update',
    update_wait: 'Please wait...',
    update_ready: 'Update Ready',
    update_ready_desc: 'Version {version} installed. Restart to apply.',
    update_failed: 'Update Failed',
    update_error_default: 'An error occurred while updating.',
    update_dismiss: 'Dismiss',
    revoke: 'Revoke',
    key_import_err: 'Invalid backup file or wrong password',
    session_revoked: 'Session revoked',
    key_setup_title: 'No Encryption Keys Found',
    key_setup_desc: 'This device has no encryption keys. Import a backup to access your existing messages, or generate new keys (old messages will be unreadable).',
    key_setup_new: 'Generate New Keys',
    key_setup_new_confirm: 'Warning: old encrypted messages will be unreadable. Continue?',
    enter_backup_password: 'Enter backup password:',
    accent_color: 'Accent color',
    accent_purple: 'Purple',
    accent_blue: 'Blue',
    accent_green: 'Green',
    accent_red: 'Red',
    accent_orange: 'Orange',
    accent_pink: 'Pink',
    accent_teal: 'Teal',
    accent_indigo: 'Indigo',
    sec_privacy: 'Privacy',
    disappearing_messages: 'Disappearing Messages',
    disappearing_off: 'Off',
    disappearing_24h: '24 Hours',
    disappearing_7d: '7 Days',
    disappearing_30d: '30 Days',
    media_decrypt_error: 'Could not decrypt attachment',
    today: 'Today',
    yesterday: 'Yesterday',
    profile: 'Profile',
    edit_avatar: 'Change photo',
    remove_avatar: 'Remove photo',
    avatar_upload_failed: 'Could not process image',
    load_earlier: 'Load earlier messages',
    message_too_long: 'Message is longer than 2000 characters',
    upload_failed: 'Could not upload the file',
    upload_unsupported: 'Only images and videos can be sent',
    upload_too_large: 'The file is larger than 1 GB',
    upload_offline: 'No connection, try again when online',
    upload_keys_missing: 'Encryption keys are not ready yet, try again in a moment',
    upload_encrypt_failed: 'Could not encrypt, the session was reset, send again',
    avatar_saving: 'Saving…',
    change_photo_confirm: 'Change profile photo?',
    message_user: 'Message',
    blocked_profile: 'Blocked',
    unblock_profile: 'Unblock',
    my_profile: 'My Profile',
    my_profile_online: 'Online',
    my_profile_offline: 'Offline',
    registered: 'Registered',
  },  ru: {
    connected: 'В сети',
    connecting: 'Подключение...',
    disconnected: 'Не в сети',
    reconnecting: 'Переподключение...',
    status_connected: 'Подключено',
    status_disconnected: 'Нет соединения',
    server_unreachable: 'Сервер недоступен. Проверьте соединение.',
    retry: 'Повторить',
    status_connecting: 'Подключение...',
    settings: 'Настройки',
    general: 'Общий чат',
    theme: 'Тема',
    theme_dark: 'Тёмная',
    theme_light: 'Светлая',
    language: 'Язык',
    lang_ru: 'Русский',
    enable_notifications: 'Включить уведомления',
    message_sound: 'Звук сообщений',
    data: 'Данные',
    clear_local_data: 'Очистить локальные данные',
    confirm_clear: 'Очистить',
    confirm_clear_data: 'Очистить все локальные данные?',
    confirm_clear_data_desc: 'Все настройки и ключи шифрования будут удалены из этого браузера. Это действие необратимо.',
    cancel: 'Отмена',
    back: 'Назад',
    done: 'Готово',
    copy: 'Копировать',
    login: 'Войти',
    register: 'Регистрация',
    nickname: 'Никнейм',
    password: 'Пароль',
    nickname_placeholder: 'Введите никнейм (3–16 символов)',
    password_create: 'Создайте пароль (8–64 символа, буквы и цифры)',
    password_enter: 'Введите пароль',
    create_account: 'Создать аккаунт',
    sign_in: 'Войти',
    creating_account: 'Создание аккаунта...',
    signing_in: 'Вход...',
    nickname_hint: 'Никнейм: 3–16 символов, только буквы, цифры, _ и -',
    type_message: 'Напишите сообщение...',
    not_connected: 'Нет соединения',
    send_message: 'Отправить сообщение',
    close_settings: 'Закрыть настройки',
    logout: 'Выйти',
    confirm_logout: 'Выйти из аккаунта?',
    confirm_logout_desc: 'Вам придётся войти снова; это также освободит слот сессии на этом устройстве.',
    online_users: 'В сети',
    no_messages: 'Пока нет сообщений. Поздоровайтесь!',
    delete: 'Удалить',
    search_messages: 'Поиск по сообщениям',
    font_size: 'Размер шрифта',
    font_small: 'Мелкий',
    font_normal: 'Обычный',
    font_large: 'Крупный',
    compact_mode: 'Компактный режим',
    chat: 'Чат',
    no_chats: 'Пока нет чатов',
    search_placeholder: 'Поиск...',
    search_tab_users: 'Люди',
    search_tab_messages: 'Сообщения',
    search_messages_placeholder: 'Поиск по сообщениям...',
    search_messages_hint: 'Введите минимум два символа',
    search_messages_none: 'Сообщения не найдены',
    search_results: 'Результаты',
    no_results: 'Ничего не найдено',
    chats: 'Чаты',
    global_chat: 'Общий чат',
    global_chat_desc: 'Общий чат для всех',
    home: 'Главная',
    about_desc: 'Минималистичный мессенджер со сквозным шифрованием. Приватный, самостоятельно размещаемый, лёгкий и быстрый. Ваши данные остаются на вашем сервере.',
    online: 'В сети',
    offline: 'Не в сети',
    banned: 'Заблокирован',
    sec_appearance: 'Оформление',
    sec_text: 'Текст',
    sec_notifications: 'Уведомления',
    sec_safety: 'Безопасность',
    safety_yours: 'Ваш номер безопасности',
    import_keys: 'Импорт ключей',
    screenshot_prot: 'Защита от скриншотов',
    sessions: 'Активные сессии',
    privacy_e2ee_title: 'Сквозное шифрование',
    privacy_e2ee_note: 'Личное сообщение прочитаете только вы двое, этот сервер включительно. Он записывает, кто был в разговоре и когда, — именно это позволяет разобраться с жалобой или блокировкой.',
    sessions_desc: 'Управление подключёнными устройствами',
    sessions_note: 'До 3 активных сессий. Вход с нового устройства при достижении лимита отклоняется, пока не отозвать одну из старых сессий.',
    current_session: 'Это устройство',
    editing_message: 'Редактирование сообщения',
    safety_number: 'Номер безопасности',
    safety_number_show: 'Показать',
    safety_number_hide: 'Скрыть',
    safety_number_hint: 'Сравните его с таким же номером у него на экране — лично или в звонке, который вы оба узнаёте. Если совпало, сервер не подменил ваши ключи.',
    safety_number_unavailable: 'Ключ ещё не опубликован. Собеседник должен сначала отправить сообщение.',
    admin_section: 'Модерация',
    admin_reports: 'Жалобы',
    admin_no_reports: 'Жалоб пока нет',
    admin_ban: 'Заблокировать',
    admin_unban: 'Разблокировать',
    admin_ban_nick: 'Блокировка по никнейму',
    admin_ban_hint: '@никнейм',
    admin_confirm_ban: 'Заблокировать этого пользователя?',
    admin_confirm_unban: 'Разблокировать этого пользователя?',
    admin_blocked: 'Заблокированные пользователи',
    admin_blocked_empty: 'Никто не заблокирован',
    admin_unblock: 'Разблокировать',
    admin_channel_general: 'Общий чат',
    admin_channel_dm: 'Личный чат',
    block: 'Блокировать',
    block_dialog_title: 'Блокировка пользователя',
    block_dialog_desc: 'Заблокировать этого пользователя? Он больше не сможет отправлять вам сообщения.',
    blocked_chat_hint: 'Пользователь заблокирован. Разблокируйте, чтобы отправлять сообщения',
    unblock: 'Разблокировать',
    reply: 'Ответить',
    edit_message: 'Редактировать',
    report: 'Пожаловаться',
    report_title: 'Пожаловаться на пользователя',
    report_desc: 'Расскажите, что сделал этот пользователь, — модератор рассмотрит жалобу.',
    report_reason_scam: 'Мошенничество',
    report_reason_harassment: 'Травля',
    report_reason_inappropriate: 'Неприемлемое содержимое',
    report_reason_other: 'Другое',
    report_send: 'Отправить жалобу',
    report_sent: 'Жалоба отправлена. Спасибо, что помогаете сделать WhisperNet безопаснее.',
    report_failed: 'Не удалось отправить жалобу. Попробуйте ещё раз.',
    try_again: 'Попробовать снова',
    sending: 'Отправка...',
    report_hint: 'Кратко опишите проблему (необязательно)',
    report_from_profile: 'Профиль',
    you: 'вы',
    edited: 'изменено',
    reactions: 'Реакции',
    close: 'Закрыть',
    attach_file: 'Прикрепить файл',
    video_att: 'Видео',
    photo_att: 'Фото',
    invalid_url: 'Некорректная ссылка',
    update_available: 'Доступно обновление',
    update_available_desc: 'Версия {version} готова к установке.',
    update_version: 'Версия ',
    update_downloading: 'Загрузка обновления',
    update_extracting: 'Установка обновления',
    update_wait: 'Пожалуйста, подождите...',
    update_ready: 'Обновление готово',
    update_ready_desc: 'Версия {version} установлена. Перезапустите, чтобы применить.',
    update_failed: 'Не удалось обновить',
    update_error_default: 'При обновлении произошла ошибка.',
    update_dismiss: 'Закрыть',
    revoke: 'Отозвать',
    key_import_err: 'Неверный файл резервной копии или неправильный пароль',
    session_revoked: 'Сессия отозвана',
    key_setup_title: 'Ключи шифрования не найдены',
    key_setup_desc: 'На этом устройстве нет ключей шифрования. Импортируйте резервную копию, чтобы открыть свои сообщения, или создайте новые ключи (старые сообщения станут нечитаемыми).',
    key_setup_new: 'Создать новые ключи',
    key_setup_new_confirm: 'Внимание: старые зашифрованные сообщения станут нечитаемыми. Продолжить?',
    enter_backup_password: 'Введите пароль резервной копии:',
    accent_color: 'Акцентный цвет',
    accent_purple: 'Фиолетовый',
    accent_blue: 'Синий',
    accent_green: 'Зелёный',
    accent_red: 'Красный',
    accent_orange: 'Оранжевый',
    accent_pink: 'Розовый',
    accent_teal: 'Бирюзовый',
    accent_indigo: 'Индиго',
    sec_privacy: 'Приватность',
    disappearing_messages: 'Исчезающие сообщения',
    disappearing_off: 'Выкл.',
    disappearing_24h: '24 часа',
    disappearing_7d: '7 дней',
    disappearing_30d: '30 дней',
    media_decrypt_error: 'Не удалось расшифровать вложение',
    today: 'Сегодня',
    yesterday: 'Вчера',
    profile: 'Профиль',
    edit_avatar: 'Сменить фото',
    remove_avatar: 'Удалить фото',
    avatar_upload_failed: 'Не удалось обработать изображение',
    load_earlier: 'Загрузить более ранние сообщения',
    message_too_long: 'Сообщение длиннее 2000 символов',
    upload_failed: 'Не удалось загрузить файл',
    upload_unsupported: 'Можно отправлять только изображения и видео',
    upload_too_large: 'Файл больше 1 ГБ',
    upload_offline: 'Нет соединения, попробуйте в сети',
    upload_keys_missing: 'Ключи шифрования ещё не готовы, попробуйте через мгновение',
    upload_encrypt_failed: 'Не удалось зашифровать, сессия сброшена, отправьте снова',
    avatar_saving: 'Сохранение…',
    change_photo_confirm: 'Сменить фото профиля?',
    message_user: 'Написать',
    blocked_profile: 'Заблокирован',
    unblock_profile: 'Разблокировать',
    my_profile: 'Мой профиль',
    my_profile_online: 'В сети',
    my_profile_offline: 'Не в сети',
    registered: 'Зарегистрирован',
  },
} as const;


