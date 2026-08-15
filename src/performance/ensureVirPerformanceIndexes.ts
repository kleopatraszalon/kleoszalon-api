import pool from "../db";

type IndexSpec = {
  table: string;
  columns: string[];
  sql: string;
};

const INDEXES: IndexSpec[] = [
  {
    table: "employees",
    columns: ["location_id", "active", "full_name"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_employees_location_active_name ON employees(location_id, active, full_name)",
  },
  {
    table: "clients",
    columns: ["location_id"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_clients_location ON clients(location_id)",
  },
  {
    table: "appointments",
    columns: ["location_id", "start_time"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_appointments_location_start ON appointments(location_id, start_time)",
  },
  {
    table: "work_orders",
    columns: ["location_id", "status"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_workorders_location_status ON work_orders(location_id, status)",
  },
  {
    table: "service_locations",
    columns: ["location_id", "service_id"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_service_locations_location_service ON service_locations(location_id, service_id)",
  },
  {
    table: "product_stock_balances",
    columns: ["location_id", "product_id"],
    sql: "CREATE INDEX IF NOT EXISTS idx_vir_stock_location_product ON product_stock_balances(location_id, product_id)",
  },
];

async function tableHasColumns(table: string, columns: string[]) {
  const result = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2::text[])`,
    [table, columns],
  );
  return new Set(result.rows.map((row) => String(row.column_name))).size === columns.length;
}

/**
 * Adds idempotent indexes for the VIR's highest-frequency location-scoped
 * lookups. Missing legacy tables/columns are skipped so schema drift cannot
 * make the API unavailable. Failures are isolated per index.
 */
export async function ensureVirPerformanceIndexes() {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const spec of INDEXES) {
    try {
      if (!(await tableHasColumns(spec.table, spec.columns))) {
        skipped.push(spec.table);
        continue;
      }
      await pool.query(spec.sql);
      applied.push(spec.table);
    } catch (error: any) {
      skipped.push(spec.table);
      console.warn("[performance-index] skipped", spec.table, error?.code || "", error?.message || error);
    }
  }

  console.log("[performance-index] ready", { applied, skipped });
  return { applied, skipped };
}

export default ensureVirPerformanceIndexes;
