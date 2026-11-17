# 13: Inventory Management & Shortfall Escalation

**What to build:** Operational staff can set and adjust the physical inventory count on an offer. Available-to-sell is computed as physical minus reserved. Any adjustment that would undercut existing reservations must halt new sales and escalate rather than silently releasing commitments.

**Blocked by:** 12 — Offer Creation & Price Management

**Status:** ready-for-agent

- [ ] `PATCH /api/v1/admin/offers/:id/inventory` (catalog role) records a seller's inventory adjustment request (quantity, reason) and applies it to the physical count; each request is a traceable event
- [ ] `available_to_sell` is a computed value: `physical_count − reserved_count`; never stored as a plain column that can drift
- [ ] If the new physical count would make `available_to_sell` negative (shortfall), the adjustment is applied but the offer is immediately halted (`sales_halted = true`) and an escalation event is recorded — reservations are NOT silently released
- [ ] `GET /api/v1/admin/offers/halted` (catalog role) lists offers in halted state with their shortfall detail for ops review
- [ ] `GET /api/v1/catalog/variants/:variantId/offers` includes `available_to_sell` per offer (0 when halted or no stock)
- [ ] Integration tests: normal adjustment updates available-to-sell; shortfall adjustment halts sales and creates escalation; halted offer shows 0 available-to-sell publicly; adjustment that restores positive stock and clears halt
