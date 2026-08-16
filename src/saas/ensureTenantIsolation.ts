import db from "../db";
import { ensureSaasCore } from "./ensureSaasCore";

let isolationPromise: Promise<void> | null = null;

const TABLES = [
  "employees",
  "clients",
  "appointments",
  "work_orders",
  "product_stock_balances",
  "purchase_orders",
] as const;

async function tableExists(table: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [table]
  );
  return Boolean(result.rowCount);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return Boolean(result.rowCount);
}

/**
 * SaaS Core v2 compatibility migration.
 * Adds tenant_id to the first business-critical tables and backfills it from
 * locations. Rows with no usable location are assigned to the legacy
 * Kleopátra tenant so the existing single-company dataset remains intact.
 */
export function ensureTenantIsolation(): Promise<void> {
  if (isolationPromise) return isolationPromise;

  isolationPromise = (async () => {
    await ensureSaasCore();
    const tenant = await db.query(`SELECT id FROM tenants WHERE slug='kleopatra' LIMIT 1`);
    const kleopatraTenantId = tenant.rows[0]?.id;
    if (!kleopatraTenantId) throw new Error("Kleopátra tenant bootstrap hiányzik.");

    for (const table of TABLES) {
      if (!(await tableExists(table))) continue;
      await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id bigint`);

      if (await columnExists(table, "location_id")) {
        await db.query(
          `UPDATE ${table} e
              SET tenant_id=l.tenant_id
             FROM locations l
            WHERE e.tenant_id IS NULL
              AND e.location_id IS NOT NULL
              AND e.location_id::text=l.id::text
              AND l.tenant_id IS NOT NULL`
        );
      }

      await db.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`, [kleopatraTenantId]);
      await db.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`);
    }
  })().catch((error) => {
    isolationPromise = null;
    throw error;
  });

  return isolationPromise;
}

export default ensureTenantIsolation;
