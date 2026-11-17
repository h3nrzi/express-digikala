# 10: Offer-to-Variant Matching

**What to build:** When a third-party seller (via ops staff) proposes an offer, it must be matched to an exact existing variant before it can become purchasable. An unambiguous match links the offer to the variant automatically.

**Blocked by:** 06 — Seller Application & Review Lifecycle, 09 — Product Variant CRUD & Image Metadata

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/offers/propose` (catalog role) accepts a seller ID, proposed variant attributes, and proposed price
- [ ] Matching logic searches approved variants by family + variant-defining attributes; exact match auto-links the offer to the variant and sets it to `pending-inventory` state
- [ ] If zero matches found and information is complete, the caller is told to create a new variant (see ticket 11)
- [ ] Ambiguous match (more than one candidate) routes the offer to `held-for-review` (see ticket 11)
- [ ] Offer cannot be proposed for a suspended seller; rejected with a clear error
- [ ] Integration tests: exact match → offer linked; zero matches → caller informed; ambiguous match → offer held; suspended seller rejected
