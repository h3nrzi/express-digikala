# 29: Cancellation Refund Initiation

**What to build:** Automatically trigger a refund to the buyer's original payment method on the same day an order line or suborder cancellation occurs.

**Blocked by:** 28 — Partial Cancellation & Reservation Release

**Status:** ready-for-agent

- [ ] Cancellation event triggers calculation of refundable amount (`cancelled_quantity × unit_price` + proportional tax)
- [ ] Enqueues refund task via outbox table with unique idempotency key
- [ ] Outbox worker calls payment adapter `refundPayment` method targeting original payment transaction
- [ ] Creates refund tracking record linked to order line and payment record
- [ ] Creates audit trail record with reason `buyer_cancellation`
- [ ] Integration tests confirm refund calculation accuracy, payment adapter invocation, and idempotency upon worker replay
