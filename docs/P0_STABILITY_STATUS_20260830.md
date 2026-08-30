# VIR P0 stability status — 2026-08-30

## Completed in this branch

- Removed hard PostgreSQL `bigint` assumptions from tenant/location ownership checks at the legacy compatibility boundary.
- Normalized tenant/location equality through `::text` without weakening tenant equality requirements.
- Hardened the authenticated location -> tenant join for mixed legacy schemas.
- Extended the SaaS isolation contract so the former hard-coded location `bigint` predicates cannot silently return.
- Added a compatibility/security note documenting why this boundary exists.

## Validation gate

Required before merge:

1. TypeScript production build.
2. SaaS tenant-isolation contract.
3. RBAC fail-closed/workorder contract suite.
4. Full repository test suite through CI.
5. Existing release-candidate and security checks applicable to pull requests.

## Deferred to follow-on P0 changes

- Frontend canonical route/menu regression audit.
- Role-by-role dashboard smoke matrix.
- Production endpoint readiness verification after deploy.
