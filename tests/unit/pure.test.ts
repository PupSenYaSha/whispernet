import { describe, it, expect } from 'vitest';
import { generateKeyPair, encryptMessage, decryptMessage } from '../../src/crypto';
import { getAvatarText, getAvatarGradient, avatarUrl, formatProfileDate, translations, messageControls } from '../../src/utils';
import { pushEscapeLayer, topEscapeLayer, escapeStackSize, clearEscapeStack, isTypingTarget, runTopEscapeLayer, hasEscapeLayerAtLeast } from '../../src/escapeStack';
import { resolveBackAction } from '../../src/backNavigation';
import { canSubmitReport, buildReportText } from '../../src/components/ReportModal';
import { newClientMessageId, isValidClientMessageId, rememberOwnMessageTextPlain, recallOwnMessageTextPlain } from '../../src/ownMessageCache';
import { MediaError, mediaErrorKey } from '../../src/upload';

describe('the direct message body', () => {
  // This is what replaced the ratchet, so it has to hold the properties the ratchet was there for:
  // a body only the recipient opens, and no state between messages that can go stale.
  it('opens for the recipient and not for the sender', async () => {
    const sender = await generateKeyPair();
    const bob = await generateKeyPair();
    const enc = await encryptMessage('hello', { 'bob-id': bob.publicKey });
    expect(await decryptMessage(enc, 'bob-id', bob.privateKey)).toBe('hello');
    await expect(decryptMessage(enc, 'bob-id', sender.privateKey)).rejects.toThrow();
  });

  it('refuses a body that was not wrapped for this account', async () => {
    const bob = await generateKeyPair();
    const enc = await encryptMessage('hello', { 'bob-id': bob.publicKey });
    await expect(decryptMessage(enc, 'carol-id', bob.privateKey)).rejects.toThrow(/No encrypted key/);
  });

  it('reads back empty and unicode text', async () => {
    const bob = await generateKeyPair();
    for (const text of ['', 'привет 👋', 'a'.repeat(2000)]) {
      const enc = await encryptMessage(text, { 'bob-id': bob.publicKey });
      expect(await decryptMessage(enc, 'bob-id', bob.privateKey)).toBe(text);
    }
  });

  it('uses a fresh key and nonce per message, so two identical messages differ', async () => {
    const bob = await generateKeyPair();
    const one = await encryptMessage('same', { 'bob-id': bob.publicKey });
    const two = await encryptMessage('same', { 'bob-id': bob.publicKey });
    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.iv).not.toBe(two.iv);
  });

  it('fails on a tampered ciphertext rather than returning garbage', async () => {
    const bob = await generateKeyPair();
    const enc = await encryptMessage('hello', { 'bob-id': bob.publicKey });
    const flipped = enc.ciphertext.slice(0, -2) + (enc.ciphertext.endsWith('A') ? 'BB' : 'AA');
    await expect(decryptMessage({ ...enc, ciphertext: flipped }, 'bob-id', bob.privateKey)).rejects.toThrow();
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
    const keys = ['profile', 'my_profile', 'edit_avatar', 'remove_avatar', 'report_title', 'report_send', 'screenshot_prot', 'banned', 'registered'] as const;
    for (const key of keys) {
      expect((translations.en as Record<string, string>)[key], key).toBeTruthy();
      expect((translations.ru as Record<string, string>)[key], key).toBeTruthy();
    }
  });

  // The whole Russian table once shipped as a wall of U+FFFD, which is what a file looks like after
  // its encoding is mangled in transit. The characters are unrecoverable, so nothing catches this
  // except a check that looks for them.
  it('contains no replacement characters', () => {
    for (const lang of ['en', 'ru'] as const) {
      for (const [k, v] of Object.entries(translations[lang])) {
        expect(v.includes('\uFFFD'), `${lang}.${k}`).toBe(false);
      }
    }
  });

  it('actually writes Russian in the Russian table', () => {
    for (const [k, v] of Object.entries(translations.ru)) {
      expect(/[\u0400-\u04FF]/.test(v), `ru.${k} is not Russian: ${v}`).toBe(true);
    }
  });
});

describe('who may touch a message', () => {
  const own = { isOwn: true };
  const theirs = { isOwn: false };

  it('lets you correct and remove what you wrote', () => {
    expect(messageControls(own)).toEqual({ edit: true, remove: true, report: false });
  });

  it('lets you do neither to what somebody else wrote', () => {
    expect(messageControls(theirs)).toEqual({ edit: false, remove: false, report: true });
  });

  it('offers no pencil on an attachment, which has no words to correct', () => {
    expect(messageControls(own, true).edit).toBe(false);
    expect(messageControls(own, true).remove).toBe(true);
  });
});

describe('what a report is made of', () => {
  // The operator cannot read a private message, so the reporter's own words are the only part of
  // the report a moderator can use. The reason is the headline; the comment rides along with it.
  it('will not go out without a reason', () => {
    expect(canSubmitReport('')).toBe(false);
    expect(canSubmitReport('report_reason_scam')).toBe(true);
  });

  it('keeps what was typed and drops the padding', () => {
    const t = { report_reason_scam: 'Scam', report_reason_other: 'Other' };
    expect(buildReportText('report_reason_scam', '  he asked for my card details  ', t))
      .toBe('Scam: he asked for my card details');
  });

  it('lets the comment stand in when the reason is only other', () => {
    const t = { report_reason_scam: 'Scam', report_reason_other: 'Other' };
    expect(buildReportText('report_reason_other', '  spam  ', t)).toBe('spam');
    expect(buildReportText('report_reason_other', '', t)).toBe('Other');
  });

  it('holds to the same length cap as any other report', () => {
    const t = { report_reason_scam: 'Scam', report_reason_other: 'Other' };
    expect(buildReportText('report_reason_scam', 'x'.repeat(900), t)).toHaveLength(500);
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
    rememberOwnMessageTextPlain(id, '[image]https://img.test/a.bin[/image]', storage);
    expect(recallOwnMessageTextPlain(id, storage)).toBe('[image]https://img.test/a.bin[/image]');
    expect(recallOwnMessageTextPlain(newClientMessageId(), storage)).toBeNull();
    expect(recallOwnMessageTextPlain(undefined, storage)).toBeNull();
  });

  it('ignores empty text and invalid ids', () => {
    const storage = makeStorage();
    rememberOwnMessageTextPlain(newClientMessageId(), '', storage);
    rememberOwnMessageTextPlain('bad', 'text', storage);
    expect(recallOwnMessageTextPlain('bad', storage)).toBeNull();
  });

  it('survives a reload and can be cleared', () => {
    const first = makeStorage();
    const id = newClientMessageId();
    rememberOwnMessageTextPlain(id, 'hello', first);

    const second = makeStorage();
    second.setItem('wn_own_dm_text', first.getItem('wn_own_dm_text') as string);
    expect(recallOwnMessageTextPlain(id, second)).toBe('hello');

    // and a write after that starts the store over rather than failing the send
    rememberOwnMessageTextPlain(newClientMessageId(), 'again', second);
    expect(recallOwnMessageTextPlain(id, second)).toBe('hello');
  });

  it('caps the number of stored messages', () => {
    const storage = makeStorage();
    for (let i = 0; i < 320; i++) rememberOwnMessageTextPlain(newClientMessageId(), 'm' + i, storage);
    const stored = JSON.parse(storage.getItem('wn_own_dm_text') as string) as Record<string, string>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(300);
  });

  it('ignores corrupted storage', () => {
    const storage = makeStorage();
    storage.setItem('wn_own_dm_text', 'not json at all');
    expect(recallOwnMessageTextPlain(newClientMessageId(), storage)).toBeNull();
    rememberOwnMessageTextPlain(newClientMessageId(), 'ok', storage);
    expect(recallOwnMessageTextPlain(newClientMessageId(), storage)).toBeNull();
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
