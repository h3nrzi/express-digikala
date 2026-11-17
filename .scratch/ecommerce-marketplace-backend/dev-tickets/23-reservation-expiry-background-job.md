# 23: Reservation Expiry Background Job

**What to build:** A scheduled outbox background job that identifies orders whose 15-minute payment reservation window has elapsed without payment confirmation, runs provider reconciliation, and releases inventory reservations.

**Blocked by:** 20 — Payment Initiation Adapter & Idempotency, 21 — Outbox Worker & Job Infrastructure

**Status:** ready-for-agent

- [ ] Background worker query scans for orders in `pending-payment` where `reservation_expires_at <= NOW()`
- [ ] Calls payment adapter reconciliation to verify if payment was captured on provider side before canceling
- [ ] If payment is uncaptured, marks order and suborders as `expired` / `cancelled` and atomically decrements `reserved_count` on offers
- [ ] Expiry action records an immutable audit event with reason `payment_timeout`
- [ ] Job execution is idempotent: repeated runs against expired orders produce no secondary inventory adjustments or state changes
- [ ] Integration tests verify timely reservation release, provider check before release, and idempotency of worker re-runs
