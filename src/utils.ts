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
};

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
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
  const words = nickname.split(/[_\-\s]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return nickname.charAt(0).toUpperCase();
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
    if (saved) return { ...defaultSettings, ...JSON.parse(saved) };
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
    notifications: 'Notifications',
    enable_notifications: 'Enable notifications',
    sound: 'Sound',
    message_sound: 'Message sound',
    data: 'Data',
    clear_local_data: 'Clear local data',
    confirm_clear: 'Clear',
    confirm_clear_data: 'Clear all local data?',
    confirm_clear_data_desc: 'All settings and encryption keys will be removed from this browser. This action is irreversible.',
    cancel: 'Cancel',
    done: 'Done',
    copy: 'Copy',
    login: 'Login',
    register: 'Register',
    nickname: 'Nickname',
    password: 'Password',
    nickname_placeholder: 'Enter nickname (3-16 chars)',
    password_create: 'Create password (8-32 chars, letters + numbers)',
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
    search_placeholder: 'Search users...',
    search_results: 'Results',
    no_results: 'No users found',
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
    safety_number: 'Safety Number',
    safety_number_desc: 'Compare this number with your contact to verify identity',
    safety_yours: 'Your safety number',
    import_keys: 'Import Keys',
    screenshot_prot: 'Screenshot Protection',
    sessions: 'Active Sessions',
    sessions_desc: 'Manage connected devices',
    sessions_note: 'Up to 3 active sessions. Logging in from a new device while at the limit is rejected until you revoke an older session.',
    current_session: 'This device',
    editing_message: 'Editing message',
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
    back: 'Back',
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
    update_now: 'Update Now',
    update_version: 'Version ',
    update_downloading: 'Downloading Update',
    update_extracting: 'Installing Update',
    update_wait: 'Please wait...',
    update_ready: 'Update Ready',
    update_ready_desc: 'Version {version} installed. Restart to apply.',
    update_restart: 'Restart Now',
    update_failed: 'Update Failed',
    update_error_default: 'An error occurred while updating.',
    update_dismiss: 'Dismiss',
    identity_warning: 'Identity key changed for @{nick} — verify the new safety number in Security Settings.',
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
    avatar_saving: 'Saving…',
    change_photo_confirm: 'Change profile photo?',
    safety_number_profile: 'Safety number',
    message_user: 'Message',
    blocked_profile: 'Blocked',
    unblock_profile: 'Unblock',
    my_profile: 'My Profile',
    my_profile_online: 'Online',
    my_profile_offline: 'Offline',
    registered: 'Registered',
  },
  ru: {
    connected: 'В сети',
    connecting: 'Подключение...',
    disconnected: 'Не в сети',
    reconnecting: 'Переподключение...',
    status_connected: 'Подключено',
    status_disconnected: 'Нет подключения',
    server_unreachable: 'Сервер недоступен. Проверьте подключение.',
    retry: 'Повторить',
    status_connecting: 'Подключение...',
    settings: 'Настройки',
    general: 'Общий чат',
    theme: 'Тема',
    theme_dark: 'Тёмная',
    theme_light: 'Светлая',
    language: 'Язык',
    lang_ru: 'Русский',
    notifications: 'Уведомления',
    enable_notifications: 'Включить уведомления',
    sound: 'Звук',
    message_sound: 'Звук сообщений',
    data: 'Данные',
    clear_local_data: 'Очистить локальные данные',
    confirm_clear: 'Очистить',
    confirm_clear_data: 'Очистить все локальные данные?',
    confirm_clear_data_desc: 'Все настройки и ключи шифрования будут удалены. Действие необратимо.',
    cancel: 'Отмена',
    done: 'Готово',
    copy: 'Копировать',
    login: 'Войти',
    register: 'Регистрация',
    nickname: 'Никнейм',
    password: 'Пароль',
    nickname_placeholder: 'Введите никнейм (3-16 символов)',
    password_create: 'Придумайте пароль (8-32 символа, буквы + цифры)',
    password_enter: 'Введите пароль',
    create_account: 'Создать аккаунт',
    sign_in: 'Войти',
    creating_account: 'Создание аккаунта...',
    signing_in: 'Вход...',
    nickname_hint: 'Никнейм: 3-16 символов, только буквы, цифры, _-',
    type_message: 'Введите сообщение...',
    not_connected: 'Нет подключения',
    send_message: 'Отправить сообщение',
    close_settings: 'Закрыть настройки',
    logout: 'Выйти',
    confirm_logout: 'Выйти из аккаунта?',
    confirm_logout_desc: 'Вам придётся войти снова — это также освободит слот сессии этого устройства.',
    online_users: 'В сети',
    no_messages: 'Пока нет сообщений. Скажите привет!',
    delete: 'Удалить',
    search_messages: 'Поиск сообщений',
    font_size: 'Размер шрифта',
    font_small: 'Маленький',
    font_normal: 'Обычный',
    font_large: 'Большой',
    compact_mode: 'Компактный режим',
    chat: 'Чат',
    no_chats: 'Пока нет чатов',
    search_placeholder: 'Поиск пользователей...',
    search_results: 'Результаты',
    no_results: 'Пользователи не найдены',
    chats: 'Чаты',
    global_chat: 'Глобальный чат',
    global_chat_desc: 'Публичный чат для всех',
    home: 'Главная',
    about_desc: 'Минималистичный мессенджер со сквозным шифрованием. Приватный, разворачивается на вашем сервере, лёгкий и быстрый. Ваши данные остаются у вас.',
    online: 'В сети',
    offline: 'Не в сети',
    banned: 'Забанен',
    sec_appearance: 'Внешний вид',
    sec_text: 'Текст',
    sec_notifications: 'Уведомления',
    sec_safety: 'Безопасность',
    safety_number: 'Номер безопасности',
    safety_number_desc: 'Сравните этот номер с контактом для подтверждения личности',
    safety_yours: 'Ваш номер безопасности',
    import_keys: 'Импорт ключей',
    screenshot_prot: 'Защита от скриншотов',
    sessions: 'Активные сессии',
    sessions_desc: 'Управление подключёнными устройствами',
    sessions_note: 'До 3 активных сессий. Новый вход при достижении лимита отклоняется, пока вы не отзовёте старую сессию.',
    current_session: 'Это устройство',
    editing_message: 'Редактирование сообщения',
    admin_section: 'Модерация',
    admin_reports: 'Жалобы',
    admin_no_reports: 'Жалоб пока нет',
    admin_ban: 'Заблокировать',
    admin_unban: 'Разблокировать',
    admin_ban_nick: 'Блокировка по нику',
    admin_ban_hint: '@никнейм',
    admin_confirm_ban: 'Заблокировать этого пользователя?',
    admin_confirm_unban: 'Разблокировать этого пользователя?',
    admin_blocked: 'Заблокированные пользователи',
    admin_blocked_empty: 'Пока никто не заблокирован',
    admin_unblock: 'Разблокировать',
    admin_channel_general: 'Общий чат',
    admin_channel_dm: 'ЛС',
    block: 'Заблокировать',
    block_dialog_title: 'Заблокировать пользователя',
    block_dialog_desc: 'Заблокировать этого пользователя? Он больше не сможет писать вам сообщения.',
    blocked_chat_hint: 'Вы заблокировали пользователя. Напишите после разблокировки',
    unblock: 'Разблокировать',
    reply: 'Ответить',
    edit_message: 'Изменить',
    report: 'Пожаловаться',
    report_title: 'Пожаловаться на пользователя',
    report_desc: 'Расскажите, что сделал этот пользователь — модератор рассмотрит жалобу.',
    report_reason_scam: 'Мошенничество',
    report_reason_harassment: 'Оскорбления',
    report_reason_inappropriate: 'Неприемлемый контент',
    report_reason_other: 'Другое',
    report_send: 'Отправить жалобу',
    report_sent: 'Жалоба отправлена. Спасибо, что помогаете делать WhisperNet безопасным.',
    report_failed: 'Не удалось отправить жалобу. Попробуйте ещё раз.',
    try_again: 'Попробовать снова',
    sending: 'Отправка...',
    report_hint: 'Кратко опишите проблему (необязательно)',
    report_from_profile: 'Профиль',
    back: 'Назад',
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
    update_now: 'Обновить сейчас',
    update_version: 'Версия ',
    update_downloading: 'Загрузка обновления',
    update_extracting: 'Установка обновления',
    update_wait: 'Подождите...',
    update_ready: 'Обновление готово',
    update_ready_desc: 'Версия {version} установлена. Перезапустите приложение.',
    update_restart: 'Перезапустить',
    update_failed: 'Ошибка обновления',
    update_error_default: 'Произошла ошибка при обновлении.',
    update_dismiss: 'Закрыть',
    identity_warning: 'Ключ идентификации изменён для @{nick} — проверьте новый номер безопасности в настройках безопасности.',
    revoke: 'Отозвать',
    key_import_err: 'Неверный файл бэкапа или пароль',
    session_revoked: 'Сессия отозвана',
    key_setup_title: 'Ключи шифрования не найдены',
    key_setup_desc: 'На этом устройстве нет ключей шифрования. Импортируйте бэкап для доступа к сообщениям, или сгенерируйте новые ключи (старые сообщения будут недоступны).',
    key_setup_new: 'Сгенерировать новые ключи',
    key_setup_new_confirm: 'Внимание: старые зашифрованные сообщения будут недоступны. Продолжить?',
    enter_backup_password: 'Введите пароль бэкапа:',
    accent_color: 'Цвет акцента',
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
    disappearing_off: 'Выкл',
    disappearing_24h: '24 Часа',
    disappearing_7d: '7 Дней',
    disappearing_30d: '30 Дней',
    media_decrypt_error: 'Не удалось расшифровать вложение',
    today: 'Сегодня',
    yesterday: 'Вчера',
    profile: 'Профиль',
    edit_avatar: 'Сменить фото',
    remove_avatar: 'Удалить фото',
    avatar_upload_failed: 'Не удалось обработать изображение',
    avatar_saving: 'Сохранение…',
    change_photo_confirm: 'Сменить фото профиля?',
    safety_number_profile: 'Номер безопасности',
    message_user: 'Написать',
    blocked_profile: 'Заблокирован',
    unblock_profile: 'Разблокировать',
    my_profile: 'Мой профиль',
    my_profile_online: 'В сети',
    my_profile_offline: 'Не в сети',
    registered: 'Регистрация',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
