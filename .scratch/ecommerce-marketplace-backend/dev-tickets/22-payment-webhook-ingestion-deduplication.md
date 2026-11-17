# 22: Payment Webhook Ingestion & Deduplication

**What to build:** An endpoint to ingest payment gateway webhook callbacks, persisting incoming provider events raw before processing and deduplicating by `provider_event_id` to prevent duplicate ledger or order state updates.

**Blocked by:** 20 — Payment Initiation Adapter & Idempotency, 21 — Outbox Worker & Job Infrastructure

**Status:** ready-for-agent

- [ ] `POST /api/v1/payments/webhook` receives provider events and verifies provider signature
- [ ] `payment_webhook_events` table stores raw payload with unique constraint on `provider_event_id`
- [ ] Duplicate webhook with an existing `provider_event_id` immediately responds 200 OK without re-executing business logic
- [ ] Valid success webhooks transition payment to `succeeded` and enqueue order confirmation processing via outbox
- [ ] Valid failure webhooks transition payment to `failed` and release inventory reservations immediately
- [ ] Integration tests verify signature validation, raw event persistence, webhook deduplication, and subsequent state dispatch
