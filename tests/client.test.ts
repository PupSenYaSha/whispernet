import { describe, it, expect } from 'vitest';
import { isEncryptedBundle, isKeyBackup } from '../src/crypto-keys';

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

  describe('isKeyBackup', () => {
    it('returns true for valid backup', () => {
      const backup = { type: 'whispernet-key-backup', nickname: 'test', publicKey: {}, encryptedPrivateKey: { v: 1, salt: 'a', iv: 'b', data: 'c' } };
      expect(isKeyBackup(backup)).toBe(true);
    });

    it('returns false for missing type', () => {
      expect(isKeyBackup({ nickname: 'test', publicKey: {}, encryptedPrivateKey: {} })).toBe(false);
    });

    it('returns false for wrong type', () => {
      expect(isKeyBackup({ type: 'wrong', nickname: 'test', publicKey: {}, encryptedPrivateKey: {} })).toBe(false);
    });

    it('returns false for null', () => {
      expect(isKeyBackup(null)).toBe(false);
    });
  });
});
