# VIR P0 production closure runbook

Date: 2026-08-18

This runbook closes the four production-blocking controls without storing secret values in GitHub issues, workflow inputs or repository files.

## P0/1 — Backup / restore evidence

Root cause confirmed from failed workflow run 32091487136: `BACKUP_SOURCE_DATABASE_URL` is missing, so the production evidence job stops before `pg_dump`.

Required operator action:
1. GitHub repository → Settings → Secrets and variables → Actions.
2. Add repository secret `BACKUP_SOURCE_DATABASE_URL` using the Render PostgreSQL external connection URL suitable for GitHub-hosted runners.
3. Do not paste the URL into issues, commits or workflow inputs.
4. Run **Backup restore requirement evidence** manually.
5. Expected result: production dump, isolated PostgreSQL restore, consistency checks and Release Control evidence PASS.
6. On a successful non-PR run, `p0-close-backup-on-success.yml` automatically comments on and closes issue #270.

## P0/2 — Credential rotation

Required operator action in Render/provider administration:
1. Rotate PostgreSQL/Render database credentials.
2. Rotate SMTP credentials.
3. Rotate `JWT_SECRET` and invalidate existing browser sessions.
4. Review every credential that appeared in the historical committed `.env`; rotate any still-valid value.
5. Update Render environment variables and redeploy/restart as required.
6. Verify login, database connectivity and mail delivery operationally.
7. Run **Security secret rotation evidence** and provide only a non-secret ticket/change reference plus the four confirmations.
8. The workflow verifies live API/database readiness and then records evidence and closes issue #62.

Never put secret values into the workflow evidence reference.

## P0/3 — NAV real TEST configuration and UAT

Required operator action in Render:
1. Configure `NAV_TECHNICAL_LOGIN`.
2. Configure `NAV_TECHNICAL_PASSWORD`.
3. Configure `NAV_SIGNING_KEY`.
4. Configure `NAV_EXCHANGE_KEY`.
5. Ensure the VIR NAV TEST configuration record contains the legal issuer name, 11-digit tax number, postal code, city and address, and that environment is `test`.
6. Run **NAV real TEST UAT**.
7. Expected: TEST-only safety gate, tokenExchange, official XSD validation, isolated fixture, manageInvoice, transaction-status polling, idempotency and audit chain PASS.
8. On successful non-PR UAT, `p0-close-nav-on-success.yml` automatically comments on and closes issue #212.

No NAV secret value may be written to GitHub issues or workflow inputs.

## P0/4 — Protect `main`

Current audit state: `main` reports `protected=false`.

Required GitHub repository administration:
1. GitHub repository → Settings → Rules → Rulesets (or Branches → Branch protection rule).
2. Target branch: `main`.
3. Require a pull request before merging.
4. Require at least one approval.
5. Require status checks before merging.
6. Add the canonical release/quality checks and `p0-production-readiness` once it has run on `main`.
7. Require branch to be up to date before merging.
8. Block force pushes.
9. Block branch deletion.
10. Do not allow routine bypass of the rule.

The `P0 production readiness` workflow verifies `protected=true`, required PR review, required status checks and disabled force-push behavior. It fails closed if protection cannot be proven.

## Final closure gate

After the four controls above are completed, run **P0 production readiness** manually.

PASS requires all of the following at the same time:
- issue #270 closed by successful production backup/restore evidence;
- issue #62 closed by controlled credential-rotation evidence;
- issue #212 closed by successful NAV real TEST UAT;
- `main` branch protection proven active with PR review and required checks.

The workflow publishes commit status `p0/production-readiness` and fails closed while any blocker remains.
