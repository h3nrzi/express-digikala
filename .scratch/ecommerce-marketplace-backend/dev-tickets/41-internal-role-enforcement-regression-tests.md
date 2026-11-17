# 41: Internal Role-Enforcement Regression Tests

**What to build:** An automated regression suite verifying complete RBAC boundary enforcement: each operational role can only access endpoints within its explicit domain, the access-admin role is blocked from financial and order operations, and unauthenticated requests to internal routes fail.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 37 — Weekly Settlement Run & Finance Confirmation Gate, 39 — Out-of-Policy Financial Adjustment Logging

**Status:** ready-for-agent

- [ ] Fixture seeds internal users for all six roles: `seller-mgmt`, `catalog`, `order-ops`, `support`, `finance`, `access-admin`, plus an unassigned staff member
- [ ] Verifies role matrix against all internal endpoints:
  - Seller operations accessible only by `seller-mgmt`
  - Catalog and offer approval accessible only by `catalog`
  - Order state advances and carrier handoffs accessible only by `order-ops`
  - Support case workflows accessible only by `support` and `order-ops`
  - Settlement runs and adjustments accessible strictly by `finance`
  - Role management accessible strictly by `access-admin`
- [ ] Explicitly asserts `access-admin` cannot trigger settlement confirmations, adjustments, or suborder state changes
- [ ] Asserts unauthenticated requests to `/api/v1/admin/*` receive 401
- [ ] Asserts requests without MFA verification receive 403
- [ ] Executable via `npm run test:security:rbac` and integrated into CI
