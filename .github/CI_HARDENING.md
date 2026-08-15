# VIR CI hardening

Release gates on pull requests to `main` and post-merge pushes to `main` enforce:

1. deterministic `npm ci` install;
2. full contract/regression suite;
3. TypeScript production build;
4. critical workorder/RBAC regression subset;
5. production dependency audit blocking high/critical findings;
6. production baseline smoke checks for API health, public daily actions and booking health.

Breaking dependency upgrades are not applied automatically. In particular, no `npm audit fix --force` step is permitted in the release gate.
