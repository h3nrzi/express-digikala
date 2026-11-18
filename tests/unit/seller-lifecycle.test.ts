import { describe, expect, it } from 'vitest';
import {
  SELLER_STATUSES,
  assertValidSellerTransition,
  canTransitionSellerStatus,
  isValidSellerStatus,
  type SellerStatus,
} from '../../src/modules/seller/domain/status-machine.js';
import { InvalidStateTransitionError } from '../../src/errors.js';

describe('Seller Lifecycle State Machine (Unit)', () => {
  describe('Status definitions and type guard', () => {
    it('defines exactly the 4 allowed statuses in the MVP lifecycle', () => {
      expect(SELLER_STATUSES).toEqual(['pending-review', 'under-review', 'active', 'rejected']);
    });

    it('validates known statuses and rejects invalid strings', () => {
      expect(isValidSellerStatus('pending-review')).toBe(true);
      expect(isValidSellerStatus('under-review')).toBe(true);
      expect(isValidSellerStatus('active')).toBe(true);
      expect(isValidSellerStatus('rejected')).toBe(true);

      expect(isValidSellerStatus('suspended')).toBe(false);
      expect(isValidSellerStatus('unknown')).toBe(false);
      expect(isValidSellerStatus('')).toBe(false);
    });
  });

  describe('Allowed transitions', () => {
    it('allows pending-review -> under-review', () => {
      expect(canTransitionSellerStatus('pending-review', 'under-review')).toBe(true);
      expect(() => assertValidSellerTransition('pending-review', 'under-review')).not.toThrow();
    });

    it('allows under-review -> active', () => {
      expect(canTransitionSellerStatus('under-review', 'active')).toBe(true);
      expect(() => assertValidSellerTransition('under-review', 'active')).not.toThrow();
    });

    it('allows under-review -> rejected', () => {
      expect(canTransitionSellerStatus('under-review', 'rejected')).toBe(true);
      expect(() => assertValidSellerTransition('under-review', 'rejected')).not.toThrow();
    });
  });

  describe('Forbidden transitions', () => {
    it('forbids direct jump from pending-review to active', () => {
      expect(canTransitionSellerStatus('pending-review', 'active')).toBe(false);
      expect(() => assertValidSellerTransition('pending-review', 'active')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids direct jump from pending-review to rejected', () => {
      expect(canTransitionSellerStatus('pending-review', 'rejected')).toBe(false);
      expect(() => assertValidSellerTransition('pending-review', 'rejected')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids backward transition from under-review to pending-review', () => {
      expect(canTransitionSellerStatus('under-review', 'pending-review')).toBe(false);
      expect(() => assertValidSellerTransition('under-review', 'pending-review')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids transitions out of terminal active state in this ticket lifecycle', () => {
      const targets: SellerStatus[] = ['pending-review', 'under-review', 'rejected'];
      for (const target of targets) {
        expect(canTransitionSellerStatus('active', target)).toBe(false);
        expect(() => assertValidSellerTransition('active', target)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });

    it('forbids transitions out of terminal rejected state', () => {
      const targets: SellerStatus[] = ['pending-review', 'under-review', 'active'];
      for (const target of targets) {
        expect(canTransitionSellerStatus('rejected', target)).toBe(false);
        expect(() => assertValidSellerTransition('rejected', target)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });

    it('forbids identical state transitions (no-op transitions)', () => {
      for (const status of SELLER_STATUSES) {
        expect(canTransitionSellerStatus(status, status)).toBe(false);
        expect(() => assertValidSellerTransition(status, status)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });
  });
});
