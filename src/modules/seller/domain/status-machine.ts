import { InvalidStateTransitionError } from '../../../errors.js';

export const SELLER_STATUSES = ['pending-review', 'under-review', 'active', 'rejected'] as const;

export type SellerStatus = (typeof SELLER_STATUSES)[number];

export function isValidSellerStatus(status: unknown): status is SellerStatus {
  return typeof status === 'string' && (SELLER_STATUSES as readonly string[]).includes(status);
}

export const ALLOWED_STATUS_TRANSITIONS: Record<SellerStatus, readonly SellerStatus[]> = {
  'pending-review': ['under-review'],
  'under-review': ['active', 'rejected'],
  active: [],
  rejected: [],
};

export function canTransitionSellerStatus(current: SellerStatus, next: SellerStatus): boolean {
  if (current === next) {
    return false;
  }
  const allowed = ALLOWED_STATUS_TRANSITIONS[current];
  return allowed.includes(next);
}

export function assertValidSellerTransition(current: SellerStatus, next: SellerStatus): void {
  if (!canTransitionSellerStatus(current, next)) {
    throw new InvalidStateTransitionError(
      `تغییر وضعیت فروشنده از '${current}' به '${next}' مجاز نمی‌باشد. مسیر مجاز: pending-review -> under-review -> active | rejected`,
    );
  }
}
