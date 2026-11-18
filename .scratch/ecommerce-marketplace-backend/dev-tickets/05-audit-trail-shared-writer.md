# 05: Audit Trail Shared Writer

**What to build:** An append-only audit event table and a shared writer utility consumed by every module. No module may overwrite or delete an audit event. Corrections are new events, not overwrites.

**Blocked by:** 01 — Project Scaffold

**Status:** completed

- [x] `audit_events` table created via migration: `id`, `occurred_at`, `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `previous_value` (JSONB), `new_value` (JSONB), `reason`, `linked_event_id`
- [x] Database-level constraint (or trigger) prevents `UPDATE` and `DELETE` on `audit_events`
- [x] Writer utility function (`recordAuditEvent(...)`) used by all modules; never writes directly to the table outside the utility
- [x] Writer is transactional: audit event and the state change it describes are committed together or not at all
- [x] Integration test: calling the writer produces a readable event; attempting to overwrite or delete an event fails at the database level
