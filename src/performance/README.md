# VIR fast-load policy

- Normal GET requests must not execute schema/menu migrations synchronously.
- Heavy dashboard aggregates use a short private in-process cache and single-flight loading.
- Cache keys include scope inputs (date range, location and role/financial visibility as applicable).
- Slow aggregate loads are logged when they exceed the configured threshold.
- Schema bootstrap remains idempotent and checks `schema_migrations` before executing migration SQL.
