# Workorders performance slice — 2026-08-15

## Scope
- Backward-compatible opt-in pagination on `GET /workorders?paginated=1`.
- `page` and `limit` parameters, default limit 50 and hard maximum 200.
- Five-minute TTL cache for relation existence and `work_orders` column metadata checks.
- PostgreSQL indexes for global and location-filtered newest-first workorder lists.

## Compatibility
Without `paginated=1`, the endpoint preserves the existing array response and existing query behavior.

## Database
Apply `src/sql/20260815_WORKORDER_LIST_PERFORMANCE_V1.sql` through the normal SQL deployment path.

## Verification
The contract suite asserts legacy response compatibility, bounded pagination, metadata caching, and the two intended index definitions. Full regression/build/RBAC/security CI remains the merge gate.
