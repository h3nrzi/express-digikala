# 18: Price-Change Detection & Buyer Re-Confirmation

**What to build:** When a buyer initiates checkout, the current offer prices are compared against the prices stored in their cart lines. If any price has changed, the buyer is told exactly which lines changed and must explicitly re-confirm before the order can be created.

**Blocked by:** 13 — Inventory Management & Shortfall Escalation

**Status:** ready-for-agent

- [ ] `POST /api/v1/checkout/validate` (buyer auth) reads the buyer's cart and compares each line's stored price with the current offer price
- [ ] Response includes a `price_changes` array: for each changed line, the old and new price are returned
- [ ] If `price_changes` is non-empty, order creation is blocked until the buyer calls `POST /api/v1/checkout/confirm-prices` with an acknowledgement payload listing the changed lines
- [ ] `confirm-prices` issues a short-lived confirmation token (or sets a flag) allowing a single subsequent checkout attempt
- [ ] If a price changes again after confirmation, the token is invalidated and re-confirmation is required
- [ ] Integration tests: no price change → validation passes; price increases → change surface and order blocked; re-confirmation → order allowed; second price change after confirmation → blocked again
