import { describe, it, expect } from 'vitest';
import { generateX3dhSafetyNumber } from '../../src/crypto';
import { getAvatarText, getAvatarGradient, avatarUrl, formatProfileDate, translations } from '../../src/utils';
import { pushEscapeLayer, topEscapeLayer, escapeStackSize, clearEscapeStack, isTypingTarget, runTopEscapeLayer, hasEscapeLayerAtLeast } from '../../src/escapeStack';
import { resolveBackAction } from '../../src/backNavigation';
import { newClientMessageId, isValidClientMessageId, rememberOwnMessageText, recallOwnMessageText, forgetOwnMessages } from '../../src/ownMessageCache';
import { MediaError, mediaErrorKey } from '../../src/upload';

const b64 = (seed: number, len = 32) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + seed * 13 + 11) % 256)).toString('base64');

describe('safety number', () => {
  it('is symmetric for both sides', async () => {
    const a = b64(1), b = b64(2);
    const ab = await generateX3dhSafetyNumber(a, b);
    const ba = await generateX3dhSafetyNumber(b, a);
    expect(ab).toBe(ba);
  });

  it('formats as 6 groups of 8 hex chars, upper case', async () => {
    const n = await generateX3dhSafetyNumber(b64(1), b64(2));
    expect(n).toMatch(/^[0-9A-F]{8}( [0-9A-F]{8}){5}$/);
  });

  it('derives from own identity only when no peer is given', async () => {
    const a = b64(3);
    const self = await generateX3dhSafetyNumber(a, null);
    const pair = await generateX3dhSafetyNumber(a, b64(4));
    expect(self).not.toBe(pair);
    expect(self).toBe(await generateX3dhSafetyNumber(a, null));
  });

  it('changes when the peer identity changes', async () => {
    const base = await generateX3dhSafetyNumber(b64(1), b64(2));
    const other = await generateX3dhSafetyNumber(b64(1), b64(5));
    expect(base).not.toBe(other);
  });
});

describe('avatar helpers', () => {
  it('keeps a stable gradient per nickname', () => {
    const a = getAvatarGradient('alice');
    expect(getAvatarGradient('alice')).toBe(a);
    expect(typeof a).toBe('string');
  });

  it('produces initials fallback', () => {
    expect(getAvatarText('alice').length).toBeGreaterThan(0);
    // empty nickname must not render a broken avatar
    expect(getAvatarText('').length).toBeGreaterThan(0);
  });

  it('builds url with cache-busting and returns null without ext', () => {
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = { location: { origin: 'https://app.test' } };
    try {
      expect(avatarUrl('u1', 'png', 123)).toBe('https://app.test/api/avatar/u1?v=123');
      expect(avatarUrl('u1', null, 123)).toBeNull();
      expect(avatarUrl('', 'png', 1)).toBeNull();
    } finally {
      (globalThis as any).window = previousWindow;
    }
  });
});

describe('formatProfileDate', () => {
  it('renders a non-empty date string', () => {
    const s = formatProfileDate(Date.now());
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});

describe('translations', () => {
  it('has the same keys in en and ru', () => {
    const en = Object.keys(translations.en).sort();
    const ru = Object.keys(translations.ru).sort();
    expect(ru).toEqual(en);
  });

  it('has no empty values', () => {
    for (const lang of ['en', 'ru'] as const) {
      for (const [k, v] of Object.entries(translations[lang])) {
        expect(v, `${lang}.${k}`).toBeTruthy();
      }
    }
  });

  it('contains keys used by the profile feature', () => {
    const keys = ['profile', 'my_profile', 'edit_avatar', 'remove_avatar', 'report_title', 'report_send', 'back', 'safety_number_profile', 'banned', 'registered'] as const;
    for (const key of keys) {
      expect((translations.en as Record<string, string>)[key], key).toBeTruthy();
      expect((translations.ru as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe('escape layer stack', () => {
  it('returns the topmost layer', () => {
    clearEscapeStack();
    const off1 = pushEscapeLayer({ layer: 40, handleWhileTyping: true, run: () => {} });
    const off2 = pushEscapeLayer({ layer: 86, handleWhileTyping: true, run: () => {} });
    expect(topEscapeLayer()?.layer).toBe(86);
    off2();
    expect(topEscapeLayer()?.layer).toBe(40);
    off1();
    expect(topEscapeLayer()).toBeNull();
    expect(escapeStackSize()).toBe(0);
  });

  it('prefers the last registered layer on equal priority', () => {
    clearEscapeStack();
    const off1 = pushEscapeLayer({ layer: 61, handleWhileTyping: true, run: () => {} });
    const off2 = pushEscapeLayer({ layer: 61, handleWhileTyping: true, run: () => {} });
    expect(topEscapeLayer()?.handleWhileTyping).toBe(true);
    off2();
    off1();
  });

  it('unregisters exactly the given layer', () => {
    clearEscapeStack();
    const off1 = pushEscapeLayer({ layer: 10, handleWhileTyping: true, run: () => {} });
    const off2 = pushEscapeLayer({ layer: 20, handleWhileTyping: true, run: () => {} });
    off2();
    off2();
    expect(escapeStackSize()).toBe(1);
    off1();
    expect(escapeStackSize()).toBe(0);
  });

  it('detects typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('runTopEscapeLayer runs the topmost layer at or above the minimum', () => {
    clearEscapeStack();
    const calls: string[] = [];
    const offBase = pushEscapeLayer({ layer: 30, handleWhileTyping: true, run: () => calls.push('base') });
    const offModal = pushEscapeLayer({ layer: 86, handleWhileTyping: true, run: () => calls.push('profile') });
    const offReport = pushEscapeLayer({ layer: 91, handleWhileTyping: true, run: () => calls.push('report') });

    // the report modal is on top, so the back gesture closes it
    expect(runTopEscapeLayer(40)).toBe(true);
    expect(calls).toEqual(['report']);
    offReport();

    // then the profile underneath
    expect(runTopEscapeLayer(40)).toBe(true);
    expect(calls).toEqual(['report', 'profile']);
    offModal();

    // only the base layer is left and it is below the minimum: the back gesture
    // has to fall through to navigation instead of closing it
    expect(runTopEscapeLayer(40)).toBe(false);
    expect(calls).toEqual(['report', 'profile']);

    // with no minimum it still runs the base layer
    expect(runTopEscapeLayer()).toBe(true);
    expect(calls).toEqual(['report', 'profile', 'base']);
    offBase();
    expect(runTopEscapeLayer(0)).toBe(false);
  });

  it('runTopEscapeLayer reports false on an empty stack', () => {
    clearEscapeStack();
    expect(runTopEscapeLayer(40)).toBe(false);
    expect(runTopEscapeLayer()).toBe(false);
  });

  it('hasEscapeLayerAtLeast looks for a layer without running it', () => {
    clearEscapeStack();
    let ran = false;
    const off1 = pushEscapeLayer({ layer: 30, handleWhileTyping: true, run: () => { ran = true; } });
    const off2 = pushEscapeLayer({ layer: 86, handleWhileTyping: true, run: () => { ran = true; } });
    expect(hasEscapeLayerAtLeast(40)).toBe(true);
    expect(hasEscapeLayerAtLeast(91)).toBe(false);
    expect(ran).toBe(false);
    off2();
    expect(hasEscapeLayerAtLeast(40)).toBe(false);
    expect(hasEscapeLayerAtLeast(0)).toBe(true);
    off1();
    expect(hasEscapeLayerAtLeast(0)).toBe(false);
  });
});

describe('back navigation', () => {
  const home = { typing: false, modalOpen: false, chatOpen: false, settingsOpen: false, inDm: false };

  it('exits the app from the home screen only', () => {
    expect(resolveBackAction(home)).toBe('exit');
  });

  it('unfocuses a text field before anything else', () => {
    expect(resolveBackAction({ ...home, typing: true, modalOpen: true })).toBe('blur-input');
  });

  it('closes a modal before navigating anywhere', () => {
    expect(resolveBackAction({ ...home, modalOpen: true, chatOpen: true, settingsOpen: true, inDm: true })).toBe('dismiss-modal');
  });

  it('walks chat -> settings -> dm -> home', () => {
    expect(resolveBackAction({ ...home, chatOpen: true })).toBe('close-chat');
    expect(resolveBackAction({ ...home, settingsOpen: true })).toBe('close-settings');
    expect(resolveBackAction({ ...home, inDm: true })).toBe('open-general');
  });

  it('prefers the chat over settings and the dm', () => {
    expect(resolveBackAction({ ...home, chatOpen: true, settingsOpen: true, inDm: true })).toBe('close-chat');
  });
});

describe('own dm message cache', () => {
  const makeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
  };

  it('generates ids the server accepts', () => {
    for (let i = 0; i < 20; i++) {
      const id = newClientMessageId();
      expect(isValidClientMessageId(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('rejects ids the server would drop', () => {
    expect(isValidClientMessageId('short')).toBe(false);
    expect(isValidClientMessageId('has spaces in the middle')).toBe(false);
    expect(isValidClientMessageId('quote"injection;drop'.repeat(4))).toBe(false);
    expect(isValidClientMessageId(42)).toBe(false);
    expect(isValidClientMessageId(undefined)).toBe(false);
  });

  it('remembers and recalls the plaintext of a sent message', () => {
    const storage = makeStorage();
    const id = newClientMessageId();
    rememberOwnMessageText(id, '[image]https://img.test/a.bin[/image]', storage);
    expect(recallOwnMessageText(id, storage)).toBe('[image]https://img.test/a.bin[/image]');
    expect(recallOwnMessageText(newClientMessageId(), storage)).toBeNull();
    expect(recallOwnMessageText(undefined, storage)).toBeNull();
  });

  it('ignores empty text and invalid ids', () => {
    const storage = makeStorage();
    rememberOwnMessageText(newClientMessageId(), '', storage);
    rememberOwnMessageText('bad', 'text', storage);
    expect(recallOwnMessageText('bad', storage)).toBeNull();
  });

  it('survives a reload and can be cleared', () => {
    const first = makeStorage();
    const id = newClientMessageId();
    rememberOwnMessageText(id, 'hello', first);

    const second = makeStorage();
    second.setItem('wn_own_dm_text', first.getItem('wn_own_dm_text') as string);
    expect(recallOwnMessageText(id, second)).toBe('hello');

    forgetOwnMessages(second);
    expect(recallOwnMessageText(id, second)).toBeNull();
  });

  it('caps the number of stored messages', () => {
    const storage = makeStorage();
    for (let i = 0; i < 320; i++) rememberOwnMessageText(newClientMessageId(), 'm' + i, storage);
    const stored = JSON.parse(storage.getItem('wn_own_dm_text') as string) as Record<string, string>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(300);
  });

  it('ignores corrupted storage', () => {
    const storage = makeStorage();
    storage.setItem('wn_own_dm_text', 'not json at all');
    expect(recallOwnMessageText(newClientMessageId(), storage)).toBeNull();
    rememberOwnMessageText(newClientMessageId(), 'ok', storage);
    expect(recallOwnMessageText(newClientMessageId(), storage)).toBeNull();
  });
});

describe('media error reporting', () => {
  it('maps every reason to its own message', () => {
    expect(mediaErrorKey(new MediaError('offline'))).toBe('upload_offline');
    expect(mediaErrorKey(new MediaError('keys'))).toBe('upload_keys_missing');
    expect(mediaErrorKey(new MediaError('upload'))).toBe('upload_failed');
    expect(mediaErrorKey(new MediaError('encrypt'))).toBe('upload_encrypt_failed');
  });

  it('falls back to the upload message for anything unknown', () => {
    expect(mediaErrorKey(new Error('boom'))).toBe('upload_failed');
    expect(mediaErrorKey('boom')).toBe('upload_failed');
    expect(mediaErrorKey(undefined)).toBe('upload_failed');
  });

  it('translates every media error key in both languages', () => {
    for (const key of ['upload_offline', 'upload_keys_missing', 'upload_failed', 'upload_encrypt_failed']) {
      expect(translations.en[key as keyof typeof translations.en]).toBeTruthy();
      expect(translations.ru[key as keyof typeof translations.ru]).toBeTruthy();
    }
  });
});
