# 12: Offer Creation & Price Management

**What to build:** Operational staff can create and update an active offer for a seller, setting and changing the price. Only one active offer per seller–variant pair is permitted. An offer is not purchasable until linked to an approved variant.

**Blocked by:** 10 — Offer-to-Variant Matching

**Status:** ready-for-agent

- [ ] After matching resolves, `PATCH /api/v1/admin/offers/:id/activate` (catalog role) sets initial price and moves the offer to `active` state; offer is now purchasable if seller is active
- [ ] `PATCH /api/v1/admin/offers/:id/price` (catalog role) updates the offer price; price history not required but new price takes effect immediately
- [ ] One active offer per seller–variant pair enforced at the database level (unique constraint); attempt to create a second is rejected with a clear error
- [ ] `DELETE /api/v1/admin/offers/:id` (catalog role) deactivates an offer (soft-delete); deactivated offers are non-purchasable but retained for order history
- [ ] `GET /api/v1/catalog/variants/:variantId/offers` (public, unauthenticated) returns all active, purchasable offers for a variant including seller identity and price
- [ ] Integration tests: activate offer → visible in public endpoint; duplicate offer rejected; deactivate → no longer in public endpoint; suspended seller's offer not returned
