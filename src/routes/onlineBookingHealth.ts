import { Router } from "express";
import db from "../db";

const router = Router();

type CountRow = { count?: number | string };

async function countReadableRows(
  table: "locations" | "services" | "employees",
  activeKey: "is_active" | "active",
  onlineBookable = false,
): Promise<number> {
  const activeExpr = `lower(COALESCE(NULLIF(to_jsonb(t)->>'${activeKey}',''),'true')) NOT IN ('false','f','0','no','off')`;
  const onlineExpr = onlineBookable
    ? ` AND lower(COALESCE(NULLIF(to_jsonb(t)->>'online_bookable',''),'true')) NOT IN ('false','f','0','no','off')`
    : "";
  const { rows } = await db.query<CountRow>(
    `SELECT count(*)::int AS count FROM ${table} t WHERE ${activeExpr}${onlineExpr}`,
  );
  return Number(rows[0]?.count || 0);
}

router.get("/health", async (_req, res) => {
  try {
    const [locations, services, employees, schema] = await Promise.all([
      countReadableRows("locations", "is_active"),
      countReadableRows("services", "is_active", true),
      countReadableRows("employees", "active"),
      db.query(`
        SELECT
          to_regclass('public.appointments') IS NOT NULL AS appointments_table,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='appointments'
              AND column_name='voice_event_id'
          ) AS voice_event_correlation
      `),
    ]);
    const schemaRow = schema.rows[0] || {};
    res.setHeader("X-Kleo-Hotfix", "booking-health-readonly-v1");
    return res.status(200).json({
      ok: true,
      database: true,
      probe: "read_only",
      locations,
      services,
      employees,
      appointments_table: Boolean(schemaRow.appointments_table),
      voice_event_correlation: Boolean(schemaRow.voice_event_correlation),
      schema_ready: Boolean(schemaRow.appointments_table),
    });
  } catch (error: any) {
    console.error(
      "[booking-health] read-only probe failed",
      error?.code || "ERROR",
      error?.message || error,
    );
    res.setHeader("X-Kleo-Hotfix", "booking-health-readonly-v1");
    return res.status(503).json({
      ok: false,
      database: false,
      probe: "read_only",
      error_code: error?.code || "BOOKING_HEALTH_UNAVAILABLE",
    });
  }
});

export default router;
