import { describe, expect, it } from 'vitest';
import {
  PRODUCT_FAMILY_STATUSES,
  assertCanEditFamily,
  assertValidFamilyTransition,
  canTransitionFamilyStatus,
  isValidFamilyStatus,
} from '../../src/modules/catalog/domain/status-machine.js';
import { InvalidStateTransitionError } from '../../src/errors.js';

describe('Product Family Lifecycle State Machine (Unit)', () => {
  describe('Status definitions', () => {
    it('defines the allowed product family statuses', () => {
      expect(PRODUCT_FAMILY_STATUSES).toEqual(['draft', 'approved', 'archived']);
    });

    it('identifies valid family statuses', () => {
      expect(isValidFamilyStatus('draft')).toBe(true);
      expect(isValidFamilyStatus('approved')).toBe(true);
      expect(isValidFamilyStatus('archived')).toBe(true);
      expect(isValidFamilyStatus('pending')).toBe(false);
      expect(isValidFamilyStatus('')).toBe(false);
    });
  });

  describe('Allowed transitions', () => {
    it('allows draft -> approved', () => {
      expect(canTransitionFamilyStatus('draft', 'approved')).toBe(true);
      expect(() => assertValidFamilyTransition('draft', 'approved')).not.toThrow();
    });

    it('allows draft -> archived', () => {
      expect(canTransitionFamilyStatus('draft', 'archived')).toBe(true);
      expect(() => assertValidFamilyTransition('draft', 'archived')).not.toThrow();
    });

    it('allows approved -> archived', () => {
      expect(canTransitionFamilyStatus('approved', 'archived')).toBe(true);
      expect(() => assertValidFamilyTransition('approved', 'archived')).not.toThrow();
    });
  });

  describe('Forbidden transitions', () => {
    it('forbids approved -> draft directly (requires creating a new draft)', () => {
      expect(canTransitionFamilyStatus('approved', 'draft')).toBe(false);
      expect(() => assertValidFamilyTransition('approved', 'draft')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids re-approving an already approved family', () => {
      expect(canTransitionFamilyStatus('approved', 'approved')).toBe(false);
      expect(() => assertValidFamilyTransition('approved', 'approved')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids reviving an archived family', () => {
      expect(canTransitionFamilyStatus('archived', 'draft')).toBe(false);
      expect(canTransitionFamilyStatus('archived', 'approved')).toBe(false);
    });
  });

  describe('Editability guard (assertCanEditFamily)', () => {
    it('allows editing when family is in draft status', () => {
      expect(() => assertCanEditFamily('draft')).not.toThrow();
    });

    it('forbids editing when family is approved, throwing InvalidStateTransitionError', () => {
      expect(() => assertCanEditFamily('approved')).toThrow(InvalidStateTransitionError);
    });

    it('forbids editing when family is archived', () => {
      expect(() => assertCanEditFamily('archived')).toThrow(InvalidStateTransitionError);
    });
  });
});
