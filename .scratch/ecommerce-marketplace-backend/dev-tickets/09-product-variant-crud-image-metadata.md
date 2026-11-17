# 09: Product Variant CRUD & Image Metadata

**What to build:** Internal catalog users can create and approve variants within an approved product family. Image metadata (URL reference to object storage, alt text, ordering) is stored in the database; the actual files live in object storage and are not managed here.

**Blocked by:** 08 — Product Family CRUD & Attribute Schema

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/catalog/families/:familyId/variants` (catalog role) creates a variant in `draft` state with variant-defining attributes and image metadata records
- [ ] Variant-defining attributes must satisfy the family's attribute schema; creation blocked if required fields are missing
- [ ] `POST /api/v1/admin/catalog/variants/:id/approve` transitions variant to `approved`; a variant is not purchasable until approved
- [ ] Image metadata records: URL (object-storage reference), alt text, display order; at least one image required for approval
- [ ] `GET /api/v1/catalog/variants/:id` (public, unauthenticated) returns approved variant with its family's shared content and all active, purchasable offers
- [ ] Integration tests: draft → approve (all fields present, image present); approve blocked when image missing; public endpoint returns only approved variants
