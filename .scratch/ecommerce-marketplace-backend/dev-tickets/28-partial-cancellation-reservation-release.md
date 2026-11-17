# 28: Partial Cancellation & Reservation Release

**What to build:** A buyer can cancel an individual order line or partial quantity of an order line before carrier handoff. The cancelled item's inventory reservation is released immediately while unaffected lines and other seller suborders continue normally.

**Blocked by:** 25 — Buyer Order & Seller Suborder State Machine

**Status:** ready-for-agent

- [ ] `POST /api/v1/orders/:orderId/lines/:lineId/cancel` (buyer auth) requires `Idempotency-Key` and accepts `quantity` to cancel
- [ ] Rejects cancellation if suborder has already reached `shipped` or later states
- [ ] Decrements active line quantity; if full line cancelled, line transitions to `cancelled`
- [ ] Atomically releases corresponding inventory reservation count on the seller's offer
- [ ] If all lines of a seller suborder are cancelled, suborder transitions to `cancelled`
- [ ] Other lines in the same suborder and sibling suborders continue unaffected
- [ ] Integration tests verify partial quantity cancellation, inventory release, immutability of untouched lines, and cancellation rejection after carrier handoff
