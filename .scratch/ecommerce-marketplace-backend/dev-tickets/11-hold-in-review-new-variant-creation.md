# 11: Hold-in-Review & New-Variant Creation Flow

**What to build:** Ambiguous offer proposals are held for a catalog user to resolve. The user can link the offer to an existing variant, approve a new variant to link it to, or reject the hold (discarding the offer).

**Blocked by:** 10 — Offer-to-Variant Matching

**Status:** ready-for-agent

- [ ] `GET /api/v1/admin/offers/held` (catalog role) lists offers in `held-for-review` state with proposed attributes and candidate variant matches
- [ ] `POST /api/v1/admin/offers/:id/resolve/link` links the held offer to a specified existing variant and moves offer to `pending-inventory`
- [ ] `POST /api/v1/admin/offers/:id/resolve/create-variant` creates and immediately approves a new variant from the proposed attributes, then links the offer; requires all variant attribute fields to be present
- [ ] `POST /api/v1/admin/offers/:id/resolve/reject` discards the offer with a mandatory reason; audit event recorded
- [ ] An offer may not be held indefinitely: held offers older than a configurable threshold appear in a staleness report endpoint
- [ ] Integration tests: resolve by link; resolve by new variant; reject; staleness threshold surfaced correctly
