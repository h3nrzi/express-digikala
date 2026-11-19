# 08: Product Family CRUD & Attribute Schema

**What to build:** Internal catalog users can create and approve product families. Each category carries a required attribute schema; a family cannot be approved until all required attributes are present.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 05 — Audit Trail Shared Writer

**Status:** completed

- [x] `POST /api/v1/admin/catalog/families` (catalog role) creates a product family in `draft` state with title, description, category, and base attributes
- [x] Category attribute schema (required attribute keys per category) is configurable via an internal endpoint; enforced on family approval
- [x] `POST /api/v1/admin/catalog/families/:id/approve` transitions family to `approved`; rejects if required attributes are missing
- [x] `PATCH /api/v1/admin/catalog/families/:id` allows edits while in `draft`; approved families require a new draft
- [x] Every approval and significant edit produces an audit event
- [x] `GET /api/v1/catalog/families` (public, unauthenticated) returns approved families with pagination; `GET /api/v1/catalog/families/:id` returns full record
- [x] Integration tests: draft → approve (all attributes present); approve blocked when required attribute missing; public endpoint returns only approved families
