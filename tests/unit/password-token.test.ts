import { describe, expect, it } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  hashPassword,
  verifyPassword,
} from '../../src/modules/identity/domain/passwords.js';

describe('Password & Invite Token Domain Seam', () => {
  describe('Password Hashing', () => {
    it('hashes passwords using scrypt with unique random salts', async () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(hash2).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(hash1).not.toBe(hash2);
    });

    it('verifies passwords correctly', async () => {
      const password = 'StrongPassword987#';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('WrongPassword', hash);
      expect(isInvalid).toBe(false);
    });

    it('returns false for malformed password hashes without throwing', async () => {
      expect(await verifyPassword('password', 'invalid-hash')).toBe(false);
      expect(await verifyPassword('password', 'scrypt:short')).toBe(false);
      expect(await verifyPassword('password', '')).toBe(false);
    });
  });

  describe('Invite Tokens', () => {
    it('generates a 64-character hex cryptographically secure token', () => {
      const token1 = generateInviteToken();
      const token2 = generateInviteToken();

      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).toMatch(/^[0-9a-f]{64}$/);
      expect(token1).not.toBe(token2);
    });

    it('hashes invite tokens deterministically using sha256', () => {
      const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hash1 = hashInviteToken(token);
      const hash2 = hashInviteToken(token);

      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });
  });
});
