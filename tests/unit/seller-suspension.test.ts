import { describe, expect, it } from 'vitest';
import {
  SELLER_STATUSES,
  assertValidSellerTransition,
  canTransitionSellerStatus,
  isValidSellerStatus,
} from '../../src/modules/seller/domain/status-machine.js';
import { InvalidStateTransitionError } from '../../src/errors.js';

describe('Seller Suspension & Reinstatement State Machine (Unit)', () => {
  describe('Status definitions with suspended state', () => {
    it('includes suspended in SELLER_STATUSES', () => {
      expect(SELLER_STATUSES).toContain('suspended');
    });

    it('recognizes suspended as valid seller status', () => {
      expect(isValidSellerStatus('suspended')).toBe(true);
    });
  });

  describe('Suspension transitions', () => {
    it('allows transition from active to suspended', () => {
      expect(canTransitionSellerStatus('active', 'suspended')).toBe(true);
      expect(() => assertValidSellerTransition('active', 'suspended')).not.toThrow();
    });

    it('forbids suspending from pending-review', () => {
      expect(canTransitionSellerStatus('pending-review', 'suspended')).toBe(false);
      expect(() => assertValidSellerTransition('pending-review', 'suspended')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids suspending from under-review', () => {
      expect(canTransitionSellerStatus('under-review', 'suspended')).toBe(false);
      expect(() => assertValidSellerTransition('under-review', 'suspended')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids suspending an already rejected seller', () => {
      expect(canTransitionSellerStatus('rejected', 'suspended')).toBe(false);
      expect(() => assertValidSellerTransition('rejected', 'suspended')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids suspending an already suspended seller (no-op)', () => {
      expect(canTransitionSellerStatus('suspended', 'suspended')).toBe(false);
      expect(() => assertValidSellerTransition('suspended', 'suspended')).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  describe('Reinstatement transitions', () => {
    it('allows transition from suspended to active', () => {
      expect(canTransitionSellerStatus('suspended', 'active')).toBe(true);
      expect(() => assertValidSellerTransition('suspended', 'active')).not.toThrow();
    });

    it('forbids reinstating to pending-review', () => {
      expect(canTransitionSellerStatus('suspended', 'pending-review')).toBe(false);
      expect(() => assertValidSellerTransition('suspended', 'pending-review')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids reinstating to under-review', () => {
      expect(canTransitionSellerStatus('suspended', 'under-review')).toBe(false);
      expect(() => assertValidSellerTransition('suspended', 'under-review')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids reinstating to rejected', () => {
      expect(canTransitionSellerStatus('suspended', 'rejected')).toBe(false);
      expect(() => assertValidSellerTransition('suspended', 'rejected')).toThrow(
        InvalidStateTransitionError,
      );
    });
  });
});
