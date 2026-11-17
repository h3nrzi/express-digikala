# 14: Cart Persistence & Session Handling

**What to build:** An authenticated buyer can build a cart across multiple sessions without locking any inventory. The cart faithfully reflects current offer availability on each read.

**Blocked by:** 02 — Buyer OTP Auth, 13 — Inventory Management & Shortfall Escalation

**Status:** ready-for-agent

- [ ] `PUT /api/v1/cart/lines/:offerId` (buyer auth) adds or updates a line; quantity validated against `available_to_sell` on write (advisory — no reservation made)
- [ ] `DELETE /api/v1/cart/lines/:offerId` removes a line
- [ ] `GET /api/v1/cart` returns all lines with current offer price, seller identity, and current `available_to_sell`; lines for deactivated or suspended offers are flagged (not silently removed)
- [ ] Cart persists across sessions (tied to buyer account, not session token)
- [ ] A buyer has exactly one active cart
- [ ] No inventory is reserved or locked at any point in this ticket
- [ ] Integration tests: add line → persists after new login; update quantity; remove line; deactivated offer flagged on cart read; cart for one buyer not visible to another buyer
