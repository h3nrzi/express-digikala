# 25: Buyer Order & Seller Suborder State Machine

**What to build:** The full lifecycle state machine for Buyer Orders (`pending-payment`, `confirmed`, `in-fulfillment`, `completed`, `cancelled`) and Seller Suborders (`pending-payment`, `confirmed`, `preparing`, `shipped`, `delivered`, `cancelled`). Includes buyer read access to their own orders.

**Blocked by:** 20 — Payment Initiation Adapter & Idempotency

**Status:** ready-for-agent

- [ ] State transitions defined and strictly validated; invalid transitions reject with domain error
- [ ] Payment confirmation advances Buyer Order and all associated Seller Suborders to `confirmed`
- [ ] Physical reservation moves from reserved to deducted upon progression from `confirmed` to fulfillment
- [ ] `GET /api/v1/orders` (buyer auth) lists authenticated buyer's orders with summary status
- [ ] `GET /api/v1/orders/:id` (buyer auth) returns full buyer order view with line-level details, agreed prices, seller names, and suborder delivery statuses
- [ ] Attempt by buyer A to access buyer B's order returns 404 or 403
- [ ] Integration tests cover complete happy-path state progressions and rejection of out-of-order transitions
