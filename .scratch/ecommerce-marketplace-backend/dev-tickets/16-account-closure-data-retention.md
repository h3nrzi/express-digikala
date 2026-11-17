# 16: Account Closure & Data-Retention Scheduling

**What to build:** A buyer can request account closure. The closure is deferred until all active orders and support cases resolve, then operational personal data is scheduled for deletion/anonymisation within 30 days.

**Blocked by:** 02 — Buyer OTP Auth, 05 — Audit Trail Shared Writer

**Status:** ready-for-agent

- [ ] `POST /api/v1/account/closure-request` (buyer auth) records a closure request; account moves to `closure-requested` state; buyer is informed of the deferral condition
- [ ] A background check (or hook on order/case resolution) detects when all active orders and support cases for the account are resolved; account then moves to `pending-deletion`
- [ ] In `pending-deletion` state, a scheduled job anonymises operational personal data (name, addresses, contact) within 30 days; financial and commercial history is retained per data-retention policy
- [ ] While in `closure-requested` state, the buyer can still view their order history but cannot place new orders
- [ ] Closure and each data-deletion step produce audit events
- [ ] Integration tests: closure request deferred while order is active; closure proceeds after order resolves; anonymisation job removes personal fields but retains order financial record
