# VIR P17 tenant boundary

P17 starts the governed operations control plane with the canonical SaaS tenant key (`tenants.id`, BIGINT).

## Security invariants

- Tenant resolution is fail-closed.
- No implicit `kleopatra` fallback is allowed.
- Accounts with more than one active tenant membership require an explicit signed tenant/location context; the first membership is never selected silently.
- A signed tenant and signed location must resolve to the same tenant.
- Every authenticated `/api/vir/*` request resolves tenant identity before a business router runs.
- P17 stores `tenant_id BIGINT` and validates `location_id -> locations.tenant_id` both in the API and with a database trigger.

## P17 workflow

`preview -> pending_approval -> approved -> executed -> verified`

Executed or verified records can be moved to `rolled_back`. The first release is a controlled control-plane workflow: it records and verifies governed operations but does not perform external side effects.

## Legacy VIR tenant debt

Several earlier VIR route files still contain legacy UUID casts for `tenant_id`. The canonical SaaS baseline uses BIGINT. These legacy modules must be migrated to BIGINT/text-safe tenant comparisons before enabling true multi-tenant production traffic on those modules. P17 deliberately does not repeat that legacy assumption.
