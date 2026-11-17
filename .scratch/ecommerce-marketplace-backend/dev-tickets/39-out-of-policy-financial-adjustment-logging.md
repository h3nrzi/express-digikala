# 39: Out-of-Policy Financial Adjustment Logging

**What to build:** Restrict manual financial adjustments (manual refunds, balance corrections, fee waivers) to authorized finance roles and require a mandatory reason and immutable audit log entry.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 37 — Weekly Settlement Run & Finance Confirmation Gate

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/finance/adjustments` restricted strictly to users possessing `finance` role
- [ ] Payload requires target seller ID / order ID, adjustment amount (positive or negative), category, and mandatory explanatory `reason` string (min 10 chars)
- [ ] Creates adjustment ledger entry that feeds into subsequent settlement runs
- [ ] Writes immutable audit event capturing before/after ledger balance, adjusting user ID, reason, and timestamp
- [ ] Non-finance roles (including `access-admin`) receive 403 Forbidden
- [ ] Integration tests verify role enforcement, rejection of empty reason, ledger entry insertion, and audit trail persistence
