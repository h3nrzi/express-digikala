# 20: Payment Initiation Adapter & Idempotency

**What to build:** An authenticated buyer can initiate payment for their pending order through a provider-agnostic payment gateway adapter. Each initiation requires an `Idempotency-Key` and establishes the configurable 15-minute reservation expiry deadline.

**Blocked by:** 19 — Atomic Multi-Seller Checkout & Inventory Reservation

**Status:** ready-for-agent

- [ ] Define provider-agnostic payment adapter interface (`initiatePayment`, `verifyPayment`, `refundPayment`) with a test mock implementation
- [ ] `POST /api/v1/payments/initiate` requires `Idempotency-Key` header and valid buyer token
- [ ] Validates order is in `pending-payment` state and belongs to calling buyer
- [ ] Persists initial payment record in DB before invoking external adapter
- [ ] Records payment initiation timestamp and calculates 15-minute reservation expiration deadline
- [ ] Duplicate initiation with identical `Idempotency-Key` returns existing payment intent without creating new gateway charges
- [ ] Initiation with same key but differing payload returns `409 Conflict`
- [ ] Integration tests verify adapter invocation, idempotency handling, and payment record creation
