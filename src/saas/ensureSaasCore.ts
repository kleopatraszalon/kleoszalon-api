import db from "../db";

let ensurePromise: Promise<void> | null = null;

export const SAAS_CORE_TABLES = [
  "tenants",
  "tenant_settings",
  "tenant_branding",
  "subscription_plans",
  "subscriptions",
  "subscription_events",
  "subscription_invoices",
  "billing_webhook_events",
  "tenant_features",
  "tenant_users",
  "franchise_networks",
  "franchise_members",
] as const;

/**
 * Runtime SaaS schema readiness check.
 *
 * Production schema mutation is performed only by the versioned migration
 * runner before the API starts. Request-time code must never CREATE/ALTER
 * tables or backfill tenant ownership. Missing baseline state is therefore a
 * fail-closed deployment error, not a signal to mutate schema under traffic.
 */
export function ensureSaasCore(): Promise<void> {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const { rows: missingRows } = await db.query<{ table_name: string }>(
      `WITH required(table_name) AS (SELECT unnest($1::text[]))
       SELECT r.table_name
         FROM required r
        WHERE to_regclass('public.' || r.table_name) IS NULL
        ORDER BY r.table_name`,
      [SAAS_CORE_TABLES],
    );

    if (missingRows.length) {
      throw new Error(
        `SaaS migration required. Missing tables: ${missingRows.map((row) => row.table_name).join(", ")}. Run npm run migrate before starting the API.`,
      );
    }

    const { rows } = await db.query(
      `SELECT
         EXISTS(SELECT 1 FROM tenants WHERE slug='kleopatra' AND status IN ('active','trial')) AS baseline_tenant_ok,
         EXISTS(SELECT 1 FROM subscription_plans WHERE code='internal' AND active=true) AS internal_plan_ok`,
    );
    const state = rows[0] || {};
    if (!state.baseline_tenant_ok || !state.internal_plan_ok) {
      throw new Error(
        "SaaS baseline data is incomplete. Run npm run migrate before starting the API.",
      );
    }
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  return ensurePromise;
}

export default ensureSaasCore;
