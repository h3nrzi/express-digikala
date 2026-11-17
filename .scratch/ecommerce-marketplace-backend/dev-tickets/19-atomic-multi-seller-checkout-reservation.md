# 19: Atomic Multi-Seller Checkout & Inventory Reservation

**What to build:** A buyer completes checkout and one Buyer Order is created containing one Seller Suborder per seller in the cart. All inventory for all lines is reserved in a single database transaction — either everything succeeds or nothing does. Simultaneous checkout on the same offer causes one to fail cleanly.

**Blocked by:** 14 — Cart Persistence & Session Handling, 15 — Saved Delivery Addresses CRUD, 17 — Delivery Area Validation, 18 — Price-Change Detection & Buyer Re-Confirmation

**Status:** ready-for-agent

- [ ] `POST /api/v1/checkout` (buyer auth) requires `Idempotency-Key` header; validates: delivery address is in coverage area, no unacknowledged price changes, all offers still active and in-stock
- [ ] Creates one `buyer_order`, one `seller_suborder` per seller, and one `order_line` per cart line in a single DB transaction; reserves inventory for every line atomically in the same transaction
- [ ] If any reservation would exceed `available_to_sell`, the entire transaction is rolled back and the response identifies the out-of-stock lines
- [ ] On success, cart is cleared; buyer order is in `pending-payment` state
- [ ] Same `Idempotency-Key` on a second call returns the existing order without creating a duplicate
- [ ] Integration tests: happy path multi-seller; one line out-of-stock → entire checkout fails; two concurrent buyers checking out the last unit → one succeeds, one fails; idempotent retry returns same order; delivery address outside coverage → rejected; price not re-confirmed → rejected
