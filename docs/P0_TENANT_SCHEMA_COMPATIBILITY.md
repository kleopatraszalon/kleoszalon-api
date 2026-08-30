# P0 tenant schema compatibility guard

## Scope

This P0 fix prevents tenant/location authorization queries from assuming that every legacy `tenant_id` column is already PostgreSQL `bigint`.

## Failure mode

Production databases can temporarily contain legacy tenant ownership columns whose physical type differs from the canonical SaaS migration type. Hard-casting request tenant IDs to `bigint` in ownership checks can therefore turn an otherwise valid authenticated request into a database error and HTTP 500.

## Guard

Tenant/location ownership comparisons in `src/saas/tenantAccess.ts` are performed through text-normalized equality at the compatibility boundary. This preserves fail-closed tenant scoping while accepting legacy physical column types during migration convergence.

The contract in `tests/saas-tenant-isolation.contract.test.js` protects the compatibility predicates and rejects reintroduction of the former hard-coded `bigint` location checks.

## Security property

This change does not widen tenant access. Equality is still required for the authenticated tenant, location and allowlisted business entity; only the PostgreSQL comparison representation changes.
