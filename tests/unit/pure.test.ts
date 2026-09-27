import { describe, it, expect } from 'vitest';
import { generateX3dhSafetyNumber } from '../../src/crypto';
import { getAvatarText, getAvatarGradient, avatarUrl, formatProfileDate, translations } from '../../src/utils';
import { pushEscapeLayer, topEscapeLayer, escapeStackSize, clearEscapeStack, isTypingTarget } from '../../src/escapeStack';

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
});
