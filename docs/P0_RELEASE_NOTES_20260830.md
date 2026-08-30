# P0 release note

Tenant/location authorization is now resilient to legacy tenant ownership column types while remaining fail-closed. Regression coverage prevents restoration of hard-coded bigint comparisons in the compatibility path.
