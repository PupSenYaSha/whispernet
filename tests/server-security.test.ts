import { describe, it, expect } from 'vitest';
import { nextMondayMidnightMSK } from '../server/time.js';

function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[<>&"']/g, '')
    .trim();
}

function sanitizeText(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
}

function isValidNickname(nick: string): boolean {
  return /^[a-zA-Z0-9_-]{3,16}$/.test(nick);
}

describe('server sanitize', () => {
  it('removes control characters', () => {
    expect(sanitize('hello\x00world')).toBe('helloworld');
    expect(sanitize('test\x1ftext')).toBe('testtext');
  });

  it('removes HTML special chars', () => {
    expect(sanitize('<script>')).toBe('script');
    expect(sanitize('a&b')).toBe('ab');
    expect(sanitize('x"y')).toBe('xy');
    expect(sanitize("a'b")).toBe('ab');
  });

  it('trims whitespace', () => {
    expect(sanitize('  hello  ')).toBe('hello');
  });

  it('preserves normal text', () => {
    expect(sanitize('Hello World 123')).toBe('Hello World 123');
  });
});

describe('message text sanitize', () => {
  it('removes control characters', () => {
    expect(sanitizeText('hello\x00world')).toBe('helloworld');
    expect(sanitizeText('test\x1ftext')).toBe('testtext');
  });

  it("preserves apostrophes and quotes in messages", () => {
    expect(sanitizeText("don't stop")).toBe("don't stop");
    expect(sanitizeText('she said "hi"')).toBe('she said "hi"');
    expect(sanitizeText('a < b & c > d')).toBe('a < b & c > d');
  });

  it('trims whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });
});

describe('nickname validation', () => {
  it('accepts valid nicknames', () => {
    expect(isValidNickname('alice')).toBe(true);
    expect(isValidNickname('Bob_123')).toBe(true);
    expect(isValidNickname('user-name')).toBe(true);
    expect(isValidNickname('abc')).toBe(true);
  });

  it('rejects too short', () => {
    expect(isValidNickname('ab')).toBe(false);
    expect(isValidNickname('a')).toBe(false);
  });

  it('rejects too long', () => {
    expect(isValidNickname('a'.repeat(17))).toBe(false);
  });

  it('rejects special characters', () => {
    expect(isValidNickname('<script>')).toBe(false);
    expect(isValidNickname('user name')).toBe(false);
    expect(isValidNickname('user@name')).toBe(false);
    expect(isValidNickname('user.name')).toBe(false);
  });
});

describe('weekly cleanup schedule (Moscow time)', () => {
  const MSK = 3 * 60 * 60 * 1000;

  function expectMondayMidnightMSK(ts: number) {
    const d = new Date(ts + MSK); // view as Moscow wall-clock
    expect(d.getUTCDay()).toBe(1); // Monday
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  }

  it('schedules the next Monday 00:00 MSK from a Wednesday', () => {
    // 2026-01-07 is a Wednesday (UTC). Pick a fixed instant.
    const wed = Date.parse('2026-01-07T12:00:00Z');
    expectMondayMidnightMSK(nextMondayMidnightMSK(wed));
    // 2026-01-07 12:00 UTC +3h = 15:00 MSK Wed -> next Monday is 2026-01-12 00:00 MSK
    const expected = Date.parse('2026-01-12T00:00:00Z') - MSK;
    expect(nextMondayMidnightMSK(wed)).toBe(expected);
  });

  it('skips to next week if called exactly on Monday after midnight', () => {
    // Monday 2026-01-12 01:00 MSK (already past 00:00) -> should be 2026-01-19
    const monAfter = Date.parse('2026-01-12T01:00:00Z') - MSK;
    const result = nextMondayMidnightMSK(monAfter);
    expectMondayMidnightMSK(result);
    expect(result).toBe(Date.parse('2026-01-19T00:00:00Z') - MSK);
  });

  it('is always strictly in the future relative to the input time', () => {
    for (let i = 0; i < 7; i++) {
      const base = Date.parse('2026-02-01T00:00:00Z') + i * 24 * 3600 * 1000;
      const r = nextMondayMidnightMSK(base);
      expect(r).toBeGreaterThan(base);
      expectMondayMidnightMSK(r);
    }
  });
});

