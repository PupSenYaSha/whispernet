import { describe, it, expect } from 'vitest';
import { isEncryptedBundle, type EncryptedKeyBundle } from '../src/crypto-keys';

describe('crypto-keys', () => {
  describe('isEncryptedBundle', () => {
    it('returns true for valid bundle', () => {
      const bundle = { v: 1, salt: 'abc', iv: 'def', data: 'ghi', publicKey: {} };
      expect(isEncryptedBundle(bundle)).toBe(true);
    });

    it('returns false for missing fields', () => {
      expect(isEncryptedBundle({ v: 1, salt: 'abc' })).toBe(false);
    });

    it('returns false for wrong version', () => {
      expect(isEncryptedBundle({ v: 2, salt: 'abc', iv: 'def', data: 'ghi' })).toBe(false);
    });

    it('returns false for null', () => {
      expect(isEncryptedBundle(null)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isEncryptedBundle('not a bundle')).toBe(false);
    });
  });
});
