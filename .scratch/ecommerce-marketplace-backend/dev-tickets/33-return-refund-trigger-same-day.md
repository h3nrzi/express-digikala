# 33: Return Refund Trigger (Same-Day on Acceptance)

**What to build:** Automatically trigger buyer reimbursement via the payment adapter on the exact day an internal operational return acceptance decision is made, applying applicable return shipping adjustments.

**Blocked by:** 31 — Ops Return Inspection & Accept/Reject Per Unit, 32 — Return Shipping Cost Rules

**Status:** ready-for-agent

- [ ] Transitioning return to accepted automatically calculates refund amount: `accepted_units × unit_price` + tax − (buyer-borne return shipping if applicable)
- [ ] Enqueues refund task in outbox table with idempotency key
- [ ] Outbox worker calls payment gateway adapter to execute refund to original payment source
- [ ] Creates refund tracking record linked to return request and payment
- [ ] Records audit trail event with reason `return_accepted`
- [ ] Integration tests verify same-day refund calculation, shipping deductions, payment gateway invocation, and replay idempotency
