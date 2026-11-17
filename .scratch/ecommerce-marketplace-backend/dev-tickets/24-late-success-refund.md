# 24: Late-Success Refund

**What to build:** Handle race conditions where payment confirmation arrives after the 15-minute reservation window expired and inventory was already released, automatically triggering a full refund via the payment adapter.

**Blocked by:** 22 — Payment Webhook Ingestion & Deduplication, 23 — Reservation Expiry Background Job

**Status:** ready-for-agent

- [ ] Webhook handler detects if incoming successful payment references an order already transitioned to `expired`
- [ ] Does NOT attempt to re-reserve inventory or re-activate expired order
- [ ] Automatically initiates full refund request via payment gateway adapter using an idempotency key
- [ ] Records refund record tied to the payment and logs audit trail event citing `late_payment_after_expiry`
- [ ] Replays of webhook or repeated refund worker sweeps do not trigger multiple refund requests
- [ ] Integration tests simulate expiry release followed by delayed success webhook, asserting order remains expired and full refund is requested
