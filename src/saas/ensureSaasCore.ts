import db from "../db";

let ensurePromise: Promise<void> | null = null;

const REQUIRED_TABLES = [
  "tenants",
  "tenant_settings",
  "tenant_branding",
  "tenant_users",
  "tenant_features",
  "subscription_plans",
  "subscriptions",
  "subscription_events",
  "subscription_invoices",
  "billing_webhook_events",
  "franchise_networks",
  "franchise_members",
] as const;

/**
 * Runtime SaaS readiness check.
 *
 * Schema creation and data backfill are intentionally NOT performed here.
 * Production DDL belongs to the versioned migration runner (`npm run migrate`).
 * This function is safe to call from routers because it only validates that the
 * expected migrated schema is present and caches the result for the process.
 */
export function ensureSaasCore(): Promise<void> {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    const present = new Set(rows.map((row) => String(row.table_name)));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    if (missing.length) {
      throw new Error(
        `SaaS schema migration required. Missing tables: ${missing.join(", ")}. Run npm run migrate before starting the API.`,
      );
    }
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  return ensurePromise;
}

export default ensureSaasCore;
