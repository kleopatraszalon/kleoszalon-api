# CI hardening status

This branch enables deterministic installs, production dependency security gating, and post-merge verification on `main`.

Release checks:
- `npm ci`
- full regression suite
- TypeScript production build
- workorder/RBAC critical regression subset
- `npm audit --omit=dev --audit-level=high`
- production API health/daily-actions/booking smoke checks

No `npm audit fix --force` is used.
