import { describe, it, expect } from 'vitest';

function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[<>&"']/g, '')
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
