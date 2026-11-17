Type: spec
Status: ready-for-agent

# Ecommerce Marketplace Backend — MVP Spec

---

## Problem Statement

Building a trustworthy online marketplace for the Iranian market requires a backend that can coordinate
multi-seller physical-goods sales while keeping buyer experience predictable and reliable. No existing
backend serves this combination: a single checkout spanning direct-sales and third-party seller offers,
inventory atomically reserved at order time, legally-aware return and refund flows, and a full audit
trail for internal operations — all inside a small-team, low-infrastructure MVP budget.

---

## Solution

Build a **modular-monolith REST API backend** (Node.js / Express.js / TypeScript / PostgreSQL) that
supports the complete buyer purchase flow — browse catalog, add to cart, checkout, pay, track, cancel
or return — together with the internal tooling needed for seller onboarding, catalog management, order
operations, finance and support. Third-party sellers have no login accounts in the MVP; all seller-side
changes are handled by operational users through internal APIs.

---

## User Stories

### Buyer — Discovery

1. As a buyer, I want to browse the catalog without signing in, so that I can explore products before
   committing to registration.
2. As a buyer, I want to search and filter the catalog by category, attribute, and price, so that I can
   find the product variant I need efficiently.
3. As a buyer, I want to see a product family page with its variants (size, color, material), shared
   content, and all active seller offers, so that I can compare options before choosing.
4. As a buyer, I want to see the available-to-sell inventory count on each seller offer, so that I know
   whether the item is in stock before adding it to my cart.
5. As a buyer, I want to see the seller's identity clearly on each offer, so that I know who I am
   contracting with before checkout.

### Buyer — Cart and Checkout

6. As a buyer, I want to add offers from multiple sellers to a single shopping cart, so that I can
   complete one checkout for my whole order.
7. As a buyer, I want my cart to persist across sessions without locking inventory, so that I can return
   to it later without affecting other buyers.
8. As a buyer, I want to be notified at checkout if a price has changed since I last viewed the offer,
   so that I can confirm or abandon the purchase with accurate information.
9. As a buyer, I want checkout to either succeed for all items or fail entirely, so that I am never
   left with a partial reservation that blocks my payment.
10. As a buyer, I want my delivery address validated against the active delivery coverage area at
    checkout, so that I am not charged for an unserviceable destination.
11. As a buyer, I want all inventory for my cart atomically reserved before I am asked to pay, so that
    items are not sold to someone else while I complete payment.
12. As a buyer, I want 15 minutes to complete payment before my reservation expires, so that I am not
    indefinitely blocked from buying.
13. As a buyer, I want to sign in with an OTP sent to my verified phone number, so that I can place
    orders without a password.

### Buyer — Orders and Tracking

14. As a buyer, I want to see my buyer order summarizing all seller suborders in one place, so that I
    can track everything from a single view.
15. As a buyer, I want to see the independent delivery status for each seller suborder, so that I know
    which parcels have shipped and which are still being prepared.
16. As a buyer, I want to receive a confirmation of my order and payment, so that I have proof of
    purchase.
17. As a buyer, I want to see the seller's identity and the agreed price on my order record, so that the
    purchase terms are clear and stable.

### Buyer — Cancellation

18. As a buyer, I want to cancel an individual order line or a quantity of it before the parcel is
    handed to the carrier, so that I can change my mind without returning a shipment.
19. As a buyer, I want to see the cancelled quantity's refund immediately initiated to my original
    payment method, so that I can trust I will be reimbursed.
20. As a buyer, I want lines I did not cancel to continue unaffected, so that I do not lose the rest
    of my order because of a partial change.

### Buyer — Returns

21. As a buyer, I want to submit a return request for all or part of a delivered order line, so that I
    can exercise my statutory right of withdrawal or report a defect.
22. As a buyer, I want to submit a return request within at least seven working days of delivery and
    after receiving the required purchase information, so that I can comply with the statutory window.
23. As a buyer, I want defects, discrepancies, and wrong items treated as support claims rather than
    standard withdrawals, so that I do not face an arbitrary deadline for genuine product issues.
24. As a buyer, I want my refund for accepted return units processed on the same day the platform
    decides to accept the return, so that I am not waiting indefinitely for my money.
25. As a buyer, I want return shipping costs covered by the platform when the fault is the seller's or
    the platform's, so that defective or wrong items do not cost me anything to return.
26. As a buyer, I want to track the status of my return request separately from the delivery status of
    the parcel, so that I can see where my return stands without confusion.

### Buyer — Support

27. As a buyer, I want to open a support case by phone or email, so that I have a channel to resolve
    issues not covered by self-service flows.
28. As a buyer, I want my support case linked to the relevant order, suborder, payment, or return, so
    that the support team has all context in one place.
29. As a buyer, I want an initial response to a blocking issue (order, payment, security) within 4
    working hours, so that critical problems are not ignored.

### Buyer — Account

30. As a buyer, I want to manage saved delivery addresses on my account, so that repeat purchases are
    faster.
31. As a buyer, I want to request account closure and have my operational data deleted within 30 days
    of all active orders and cases resolving, so that I control my personal information.
32. As a buyer, I want to recover access to my account by re-verifying the same phone number, so that
    losing a password does not lock me out.

### Internal Team — Catalog

33. As an internal catalog user, I want to create and approve product families and variants with
    required category attributes, so that only complete and unambiguous products are purchasable.
34. As an internal catalog user, I want to match a seller's proposed offer to an exact existing variant
    before making it purchasable, so that duplicate or ambiguous catalog entries are prevented.
35. As an internal catalog user, I want to hold a proposed offer in review when matching is ambiguous,
    so that unclear catalog entries are not auto-merged or silently discarded.
36. As an internal catalog user, I want to create a new product family or variant when no match exists
    and information is complete, so that legitimate new products can be listed.
37. As an internal catalog user, I want to store and serve product images in object storage with only
    metadata in the database, so that large files do not slow down transactional queries.

### Internal Team — Seller Management

38. As a seller-operations user, I want to record a third-party seller's application and progress it
    through review to active, rejected, or suspended, so that only vetted sellers can list products.
39. As a seller-operations user, I want to immediately suspend a seller's ability to sell in cases of
    serious risk, so that buyer harm is prevented without delay.
40. As a seller-operations user, I want to update a third-party seller's offer price and inventory on
    their behalf (since sellers have no self-service portal in the MVP), so that offer data stays
    accurate.
41. As a seller-operations user, I want to record and act on inventory adjustment requests from
    third-party sellers, so that there is a traceable chain of custody for inventory changes.

### Internal Team — Inventory

42. As an operations user, I want inventory reservations created atomically at order time and
    protected by database constraints, so that the platform never oversells a seller offer.
43. As an operations user, I want inventory shortfalls (physical count less than reserved) to halt
    new sales and escalate to operations rather than silently releasing reservations, so that
    buyer commitments are honored.
44. As an operations user, I want inventory only restored from returned goods after physical receipt
    and inspection confirm resalability, so that defective returns do not inflate available stock.

### Internal Team — Orders and Fulfillment

45. As an order-operations user, I want to monitor all buyer orders and seller suborders, so that I
    can intervene if preparation or shipping is delayed.
46. As an order-operations user, I want to record carrier handoff events for suborders when carrier
    tracking is not available automatically, so that order status stays current.
47. As an order-operations user, I want to see which orders are in each state, so that I can
    prioritize and assign work.

### Internal Team — Returns

48. As an order-operations user, I want to record the outcome of a return inspection and accept or
    reject individual units, so that partial returns are handled precisely.
49. As an order-operations user, I want refunds for accepted return units triggered automatically on
    the day of the decision, so that manual steps do not delay buyer reimbursement.
50. As an order-operations user, I want the seller's settlement balance updated for returned units
    before the next weekly settlement run, so that commissions and payouts reflect actual kept goods.

### Internal Team — Payments and Settlement

51. As a finance user, I want to reconcile each seller suborder's gross sales, commission, refunds,
    and net settlement amount in one ledger, so that the financial record is auditable.
52. As a finance user, I want all payment gateway events idempotently recorded with a provider event
    ID, so that duplicate webhooks cannot create duplicate records.
53. As a finance user, I want weekly seller settlement runs computed automatically and confirmed by an
    authorized finance user before payment is initiated, so that settlement is controlled and reviewed.
54. As a finance user, I want any disputed or open return withheld from settlement until resolved, so
    that disputed amounts are never paid out early.
55. As a finance user, I want all tax-relevant fields (rate, exemption, effective date) snapshot at
    line level on each order, so that future rule changes do not alter historical invoice calculations.
56. As a finance user, I want each seller suborder's invoicing record linked to the correct taxpayer
    ID, so that electronic invoice obligations are traceable per seller.

### Internal Team — Audit and Operations

57. As any operational user, I want an immutable audit trail for every significant state change —
    timestamp, actor, action, entity, before/after value, reason, and linked event ID — so that
    disputes and compliance queries are answerable.
58. As an access administrator, I want to invite users and grant or revoke operational roles, so that
    access is kept to the minimum needed.
59. As any operational user, I want to open and progress support cases linked to buyer orders and
    return requests, so that multi-step issues are tracked from intake to resolution.
60. As a finance user, I want any out-of-policy financial adjustment to require a logged reason and
    restricted to an authorized role, so that manual overrides are traceable.

### Internal Team — Deployment and Monitoring

61. As a developer, I want the same build artifact deployed to staging first and then to production
    with a manual approval gate, so that regressions are caught before they reach buyers.
62. As an operator, I want structured logs scrubbed of sensitive data (codes, tokens, full addresses),
    so that log access does not create a privacy risk.
63. As an operator, I want alerts for security events, payment failures, and backup failures sent to
    a named owner, so that critical problems are acted on immediately.
64. As an operator, I want encrypted backups taken at least every four hours and restoration tested
    monthly, so that the RPO of four hours and RTO of eight hours are achievable.
65. As a developer, I want database migrations to be backward-compatible with the previous application
    version, so that rollback does not require a data restore.

---

## Implementation Decisions

### Architecture

- **Style:** Modular monolith in one codebase; a separate worker process from the same codebase handles
  background jobs. No independent microservices in the MVP.
- **Modules:** Identity and Access · Seller Participation · Catalog · Offer and Inventory · Cart and
  Checkout · Order and Fulfillment · Payment and Settlement · Returns · Operations and Support. Each
  module owns its own data writes; cross-module communication goes through defined contracts. Adapters
  handle external provider calls and notifications. Audit-trail recording is a shared capability.
- **Storage:** PostgreSQL as the primary transactional store. Object storage for product images and
  support attachments (database holds metadata and references only). No separate cache or search service
  at launch; basic PostgreSQL search is sufficient for initial load. Need will be revisited on real
  traffic data.
- **Background jobs:** Outbox-pattern transactional jobs table in PostgreSQL; a persistent worker
  process polls it. No separate message broker. Handlers must be idempotent with retry; failures are
  surfaced for manual re-run. Covers: reservation expiry, payment reconciliation, periodic settlement,
  and notifications.
- **Provider integrations:** Payment provider and carrier are external adapters. Provider event (webhook)
  persisted before processing; deduplication by provider event ID. Specific providers TBD after legal
  constraints and geography are confirmed.
- **Hosting:** Single-region deployment; provider and region to be confirmed before production.

### Domain Model Decisions

- **Catalog:** Three-layer model — shared product content (title, description, base attributes),
  product family (identity attributes), product variant (variant-defining attributes + images). The
  platform's internal team creates, approves, and maintains shared content. Sellers may suggest edits
  but cannot write directly.
- **Offer:** One active seller offer per (seller, variant) pair. Price and inventory live on the offer.
  An offer is not purchasable until linked to an approved variant.
- **Inventory:** Per-offer integer count. Available-to-sell = physical minus reserved. Reservation
  created atomically with order placement (not at cart). Released on payment failure, cancellation, or
  expiry. Inventory restored from returns only after physical inspection confirms resalability.
- **Cart:** Holds offer lines without reserving inventory. Cart persists across sessions. Quantity and
  price verified at checkout.
- **Checkout and Buyer Order:** One checkout creates one Buyer Order containing one Seller Suborder per
  seller. Atomic: all lines succeed or none; inventory for all lines reserved in one database
  transaction. Price change requires explicit buyer re-confirmation before order is created.
- **Seller Suborder:** Independent preparation and delivery tracking per seller. Cancellation before
  carrier handoff releases that quantity's reservation; other lines are unaffected.
- **Payment:** One payment per buyer order. 15-minute reservation window (configurable). Payment expiry
  triggers provider reconciliation then order/suborder closure and reservation release. Late
  confirmation after release triggers full refund. All financial mutations require an `Idempotency-Key`.
- **Refunds:** Initiated to original payment method. For cancellations: same day. For accepted returns:
  same day as acceptance decision. Platform bears return shipping cost for defect/wrong item; buyer bears
  it for standard withdrawal.
- **Settlement:** Seller balance = gross sales of kept units minus commission minus related refunds.
  Commission base excludes shipping and separately-stated tax. Computed weekly; finance user confirms
  before payment. Disputed/open returns withhold only the contested amount. Platform pays provider fees.
- **Returns:** Return request records requested, inspected, accepted, and returned quantities separately.
  Original order quantity is immutable. Partial return: some units; full return: all units in scope.
  Delivery status of parcel remains "delivered"; return status is separate. Statutory 7-working-day
  withdrawal window starts from the later of delivery and provision of required information
  (conservative interpretation, to be confirmed with legal counsel before launch). Defect/discrepancy
  claims handled as support cases without a strict deadline.
- **Invoice and Tax:** Customer summary provided per checkout. Each seller issues their own sales
  invoice per suborder (platform for direct sales; third-party seller for their suborder). Platform
  invoices commission income separately. Tax rates, exemptions, and effective dates are stored as a
  configurable rule applied by (item ID, taxpayer file, document type, effective date); they are
  snapshotted at line level on each order and must not be hard-coded. This model is a planning
  assumption pending official tax authority guidance.
- **Data Retention:** Operational data (addresses, contact) deleted/anonymized ≤30 days after account
  closure and resolution of active orders/cases. Delivery recipient data deleted/anonymized 180 days
  after delivery and return/case closure. Financial/commercial history retained up to 10 years where
  legally required; buyer PII de-identified unless law requires it. Support case content 24 months
  after closure. Auth/security events 12 months. Backups rotational, max 35 days; deletion markers
  re-applied after restore. Specific periods are planning policy pending legal/tax guidance.
- **Delivery Coverage:** Configurable postal-code allowlist. Checkout blocks destinations outside the
  list. Pilot starts with Tehran and connected suburbs; exact codes confirmed after carrier selection.
- **Identity and Access:** Buyer authenticates with verified phone number + short-lived OTP; Bearer
  token issued. Third-party sellers have no login in MVP. Operational users are invited, use personal
  accounts, require a second factor for internal tools. Roles: seller management, catalog, order/
  fulfillment/returns, support, finance, access management. Access administrator cannot perform
  financial or order operations without an additional role.
- **Audit Trail:** Immutable, append-only. Fields: timestamp · actor (user or system) · action ·
  entity type + ID · previous value · new value · reason · linked event/case ID. Corrections recorded
  as new corrective events, not overwrites.

### API Contract

- **Base path:** `/api/v1`; internal operations at `/api/v1/admin`.
- **Auth:** Buyer APIs — OTP + Bearer token (short-lived). Internal APIs — personal account + second
  factor + operational role. Buyer can only access their own resources.
- **Public (unauthenticated):** Catalog read (product families, variants, published offers).
- **Buyer resources:** Account, saved addresses, cart, checkout, buyer orders (own), cancellations,
  return requests, support cases.
- **Internal resources:** Seller participation, catalog CRUD, offer and inventory, order and fulfillment,
  payment and settlement, return decisions, support case management.
- **Third-party sellers:** No API or login in MVP. Payment provider webhooks received on a separate
  endpoint.
- **Versioning:** Breaking changes release under a new path version.
- **Response format:** JSON / UTF-8. Standard HTTP verbs and status codes.
- **Error format:** `{ code, message (Persian), traceId, fieldErrors? }`. Validation runs before any
  state change.
- **Pagination:** Cursor-based (`limit`, `cursor`, `nextCursor`). Allowlisted filter and sort options
  per resource.
- **Idempotency:** `Idempotency-Key` header required on checkout, payment initiation, cancellation,
  return request, refund, and settlement operations. Same key + different body returns `409 Conflict`.
  Webhooks deduplicated by provider event ID.

---

## Testing Decisions

### What makes a good test

A good test exercises external behavior visible through the module's or API's interface and asserts
outcomes in terms of domain state — not internal implementation steps. Tests should not assert which
private functions were called or what SQL was generated; they should assert what the caller can observe:
HTTP response bodies, database state after the operation, and audit-trail entries.

### Test seam

The **primary test seam is the REST API boundary** (`/api/v1` and `/api/v1/admin`). This is the highest
meaningful boundary: it exercises the full module stack — routing, validation, domain logic, database
writes, and job enqueueing — with a real PostgreSQL instance and simulated external adapters.

Supplementary seam: **domain rule unit tests** for pure calculations (commission amount, settlement
balance, return window, VAT snapshot) where the input/output is entirely in-memory and covers the
combinatorial edge cases too expensive to exercise end-to-end.

Background jobs tested via **integration tests** that seed the jobs table, trigger the worker, and
assert the resulting database state.

### Which modules will be tested

All nine domain modules, through their API endpoints:

| Module | Critical paths |
|---|---|
| Identity and Access | OTP flow, token issuance, role enforcement |
| Seller Participation | Lifecycle transitions, suspension |
| Catalog | Variant creation, offer matching, approval gate |
| Offer and Inventory | Atomic reservation, oversell prevention, inventory shortfall escalation |
| Cart and Checkout | Multi-seller atomic checkout, price-change confirmation, delivery-area validation |
| Order and Fulfillment | Suborder state machine, carrier handoff recording, independent cancellation |
| Payment and Settlement | 15-minute expiry, late-success refund, idempotent webhooks, weekly settlement |
| Returns | Partial return quantities, refund on acceptance, return shipping cost rules, status independence |
| Operations and Support | Audit-trail immutability, role-access boundaries, support case lifecycle |

### Mandatory regression scenarios (must have executable tests)

1. Multi-seller atomic checkout: inventory reserved for all lines or none; price change detected and
   shown; simultaneous buyer checkout causes one to fail cleanly.
2. Payment expiry: reservation released after 15 min; late payment success triggers full refund;
   duplicate webhook ignored.
3. Partial cancellation: cancelled line's reservation released; remaining lines and other suborders
   unaffected; refund initiated.
4. Partial return: return quantity recorded separately from order quantity; accepted units refunded same
   day; seller settlement adjusted; delivery status unaffected.
5. Buyer data isolation: buyer A cannot read buyer B's orders, cart, or personal data.
6. Internal role enforcement: each role can only perform operations in its area; access admin cannot
   perform financial operations; unauthenticated requests rejected.
7. Audit trail: sensitive state changes produce immutable, append-only records; no overwrite path exists.
8. Background job idempotency: re-running a completed job produces no duplicate state changes.
9. Inventory shortfall: adjustment that would undercut reservations halts new sales and escalates.

### Test data

- Fabricated, deterministic fixtures covering boundary cases and representative Iranian data (postal
  codes, phone number format).
- Real buyer PII is never used in test environments.
- Payment and carrier integrations simulated in normal runs; sandbox provider tests run as a pre-launch
  gate in staging.

### Prior art in codebase

No existing codebase yet; this is a greenfield project. The patterns above should become the
established convention from the first commit.

---

## Out of Scope

- **Frontend**: The project covers backend APIs and contracts only.
- **Digital goods, services, or special-shipping physical goods**: MVP is limited to standard physical
  goods with no special handling.
- **Multi-market or international launch**: Pilot market is Iran (Tehran metro area).
- **Promotions, discount codes, loyalty points**: Explicitly excluded from MVP.
- **Buyer reviews and ratings**: Not in MVP; trust is based on product information quality and support.
- **Third-party seller self-service portal or API**: Sellers have no login; all operations are internal.
- **Multi-region or HA infrastructure**: Single-region in MVP; multi-region deferred.
- **Hosting provider selection**: Provider, region, and production serviceability verification are
  pre-production steps, not part of this development spec. (Issues 33–35 track the pre-production
  work.)
- **Numerical success-metric thresholds**: Will be set after initial pilot evidence (Issue 01).
- **Initial commission rate**: Set before seller activation, after cost modelling (Issue 09 decision).
- **Qualified payment and carrier provider selection**: Determined after legal path for fund allocation
  and geography are confirmed (tracked separately).
- **Official tax authority guidance**: Planning assumption in place; official confirmation required
  before production (Issue 29).
- **AML scope determination**: Planning assumption only; official determination required before
  third-party seller activation (Issue 32).
- **Seller license / shared-domain rule**: Planning assumption; official guidance required before
  third-party seller activation (Issue 21/22).
- **Category-specific product regulations**: Must be evaluated per SKU and category before listing.

---

## Further Notes

- **Legal flags before launch:** At least four decisions carry legal conditions that must be resolved
  before the corresponding feature is activated in production: tax invoicing model (Issue 29/30),
  AML scope (Issue 32), seller license on shared domain (Issue 21/22), and return window calculation
  (Issue 25). The backend must keep these configurable and must not hard-code assumptions.
- **Provisional policy markers:** Any backend logic implementing a provisional business rule (e.g.,
  initial-suborder shipping cost on partial withdrawal) should be tagged with a comment referencing the
  relevant issue number so it is easy to locate and update when the legal position is confirmed.
- **Data separation principle:** Personal data, operational data, and commercial/financial history live
  in separate, independently controlled storage scopes so that deletion and anonymization can be applied
  without touching financial records.
- **Provider-agnostic design:** No provider name, endpoint, or SDK may be hard-coded. All external
  integrations go through adapter interfaces so the provider can be swapped before or after launch.
- **Deployment pre-production checklist** (not part of this spec but tracked in issues 33–35):
  written RPO/RTO confirmation from hosting provider, restore test in staging, carrier and payment
  sandbox test, load test at 25 rps steady / 50 rps burst, access and audit-trail review.
