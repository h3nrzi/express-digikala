import { describe, expect, it } from 'vitest';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpHash,
  createBuyerToken,
  verifyBuyerToken,
} from '../../src/modules/identity/domain/tokens.js';

describe('OTP & JWT Domain Services', () => {
  describe('OTP Generation and Hashing', () => {
    it('generates a 6-digit numeric OTP code', () => {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('hashes OTP and verifies matching code safely', () => {
      const phone = '+989123456789';
      const code = '123456';
      const hash = hashOtpCode(phone, code);

      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 hex string

      expect(verifyOtpHash(phone, '123456', hash)).toBe(true);
      expect(verifyOtpHash(phone, '654321', hash)).toBe(false);
      expect(verifyOtpHash('+989120000000', '123456', hash)).toBe(false);
    });
  });

  describe('JWT Token Issuance and Verification', () => {
    const secret = 'super-secret-jwt-key-123456789012';
    const user = { userId: '550e8400-e29b-41d4-a716-446655440000', phone: '+989123456789' };

    it('creates and verifies a valid buyer JWT token', () => {
      const token = createBuyerToken(user, secret, '1h');
      expect(typeof token).toBe('string');

      const decoded = verifyBuyerToken(token, secret);
      expect(decoded.sub).toBe(user.userId);
      expect(decoded.phone).toBe(user.phone);
      expect(decoded.role).toBe('buyer');
      expect(decoded.exp).toBeDefined();
    });

    it('throws when verifying a token signed with a different secret', () => {
      const token = createBuyerToken(user, secret, '1h');
      expect(() => verifyBuyerToken(token, 'different-wrong-secret')).toThrow();
    });

    it('throws when token is expired', () => {
      // 0s expiration
      const token = createBuyerToken(user, secret, '0s');
      expect(() => verifyBuyerToken(token, secret)).toThrow();
    });

    it('throws when token is malformed', () => {
      expect(() => verifyBuyerToken('invalid-token-string', secret)).toThrow();
    });
  });
});
