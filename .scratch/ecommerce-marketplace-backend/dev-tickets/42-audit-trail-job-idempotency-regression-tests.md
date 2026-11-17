# 42: Audit-Trail & Background-Job Idempotency Regression Tests

**What to build:** An automated regression suite verifying that sensitive state mutations produce immutable append-only audit trail records, no database overwrite path exists, re-executing background jobs produces no duplicate state changes, and inventory shortfalls halt sales with operational escalation.

**Blocked by:** 37 — Weekly Settlement Run & Finance Confirmation Gate, 38 — Support Case CRUD & Order/Return Linkage, 39 — Out-of-Policy Financial Adjustment Logging

**Status:** ready-for-agent

- [ ] Audit trail immutability test: exercises direct SQL `UPDATE` and `DELETE` queries against `audit_events` and asserts database-level failure
- [ ] Audit coverage test: executes seller state change, offer price change, order cancellation, return decision, and financial adjustment; asserts matching immutable audit records exist for all
- [ ] Outbox idempotency test: seeds duplicate executions of reservation expiry, payment reconciliation, and webhook dispatch; asserts underlying business entities incur no duplicate state mutations
- [ ] Inventory shortfall test: applies physical stock reduction below reserved count; asserts new sales are halted (`sales_halted = true`), reservations remain intact, and escalation event is emitted
- [ ] Executable via `npm run test:regression:integrity` and integrated into CI
