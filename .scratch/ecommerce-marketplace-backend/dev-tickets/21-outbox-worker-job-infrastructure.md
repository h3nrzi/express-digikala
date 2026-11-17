# 21: Outbox Worker & Job Infrastructure

**What to build:** A transactional outbox table and a dedicated, persistent worker process to run asynchronous background tasks (such as reservation expiry and notifications) reliably without external message brokers.

**Blocked by:** 01 — Project Scaffold

**Status:** ready-for-agent

- [ ] `outbox_jobs` table created via migration: `id`, `job_type`, `payload` (JSONB), `status` (`pending`, `processing`, `completed`, `failed`), `scheduled_at`, `attempts`, `last_error`, `locked_at`
- [ ] Transactional helper to enqueue outbox jobs within an existing DB transaction
- [ ] Dedicated worker loop with configurable polling interval that atomically claims pending jobs using `SELECT ... FOR UPDATE SKIP LOCKED`
- [ ] Handlers execute with automatic exponential backoff retry on transient errors
- [ ] Jobs exceeding maximum attempts transition to `failed` and log structured error details for manual intervention
- [ ] Integration tests confirm atomic lock acquisition, retry backoff, and idempotent task execution
