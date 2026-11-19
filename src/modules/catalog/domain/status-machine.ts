import { InvalidStateTransitionError } from '../../../errors.js';

export const PRODUCT_FAMILY_STATUSES = ['draft', 'approved', 'archived'] as const;
export type ProductFamilyStatus = (typeof PRODUCT_FAMILY_STATUSES)[number];

const ALLOWED_FAMILY_TRANSITIONS: Record<ProductFamilyStatus, readonly ProductFamilyStatus[]> = {
  draft: ['approved', 'archived'],
  approved: ['archived'],
  archived: [],
};

export function isValidFamilyStatus(status: string): status is ProductFamilyStatus {
  return (PRODUCT_FAMILY_STATUSES as readonly string[]).includes(status);
}

export function canTransitionFamilyStatus(
  from: ProductFamilyStatus,
  to: ProductFamilyStatus,
): boolean {
  return ALLOWED_FAMILY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidFamilyTransition(
  currentStatus: ProductFamilyStatus,
  nextStatus: ProductFamilyStatus,
): void {
  if (!canTransitionFamilyStatus(currentStatus, nextStatus)) {
    throw new InvalidStateTransitionError(
      `تغییر وضعیت نامعتبر است: امکان تغییر وضعیت کالا از «${currentStatus}» به «${nextStatus}» وجود ندارد.`,
    );
  }
}

/**
 * Asserts that the family is in a state where direct edits are allowed.
 * Only families in 'draft' status may be modified directly.
 * Approved families require creating a new draft.
 */
export function assertCanEditFamily(currentStatus: ProductFamilyStatus): void {
  if (currentStatus !== 'draft') {
    throw new InvalidStateTransitionError(
      'ویرایش مستقیم تنها در وضعیت پیش‌نویس (draft) مجاز است. برای تغییرات در کالای تأیید شده، باید پیش‌نویس جدید ایجاد گردد.',
    );
  }
}
