export type OperationalRole =
  'seller-mgmt' | 'catalog' | 'order-ops' | 'support' | 'finance' | 'access-admin' | 'staff';

export const OPERATIONAL_ROLES: readonly OperationalRole[] = [
  'seller-mgmt',
  'catalog',
  'order-ops',
  'support',
  'finance',
  'access-admin',
] as const;

export const ACCESS_ADMIN_ROLE: OperationalRole = 'access-admin';
