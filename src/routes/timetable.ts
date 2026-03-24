// backend/src/routes/timetable.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

type ColSet = Set<string>;
let employeesCols: ColSet | null = null;

async function loadEmployeesCols(): Promise<ColSet> {
  if (employeesCols) return employeesCols;
  const r = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='employees'`
  );
  employeesCols = new Set(r.rows.map((x: any) => String(x.column_name)));
  return employeesCols;
}

function pick(cols: ColSet, names: string[]): string | null {
  for (const n of names) if (cols.has(n)) return n;
  return null;
}

function buildEmployeesSelect(cols: ColSet) {
  // name fields
  const fullNameCol = pick(cols, ["full_name", "fullname", "name", "display_name"]);
  const shortNameCol = pick(cols, ["short_name", "shortname", "nick", "nickname", "initials"]);
  const firstNameCol = pick(cols, ["first_name", "firstname", "given_name"]);
  const lastNameCol = pick(cols, ["last_name", "lastname", "family_name"]);
  const photoCol = pick(cols, ["photo_url", "avatar_url", "image_url", "photo", "avatar"]);
  const roleCol = pick(cols, ["role", "position", "job_title"]);
  const locationCol = pick(cols, ["location_id", "salon_id", "branch_id"]);

  const fullNameExpr =
    fullNameCol
      ? `e.${fullNameCol}::text`
      : (firstNameCol || lastNameCol)
        ? `trim(concat_ws(' ', ${firstNameCol ? `e.${firstNameCol}::text` : "''"}, ${lastNameCol ? `e.${lastNameCol}::text` : "''"}))`
        : `'Munkatárs'`;

  const shortNameExpr =
    shortNameCol
      ? `e.${shortNameCol}::text`
      : (firstNameCol || lastNameCol)
        ? `trim(concat_ws(' ', ${firstNameCol ? `e.${firstNameCol}::text` : "''"}, ${lastNameCol ? `left(e.${lastNameCol}::text, 1) || '.'` : "''"}))`
        : `NULL::text`;

  const photoExpr = photoCol ? `e.${photoCol}::text` : `NULL::text`;
  const roleExpr = roleCol ? `e.${roleCol}::text` : `NULL::text`;
  const locExpr = locationCol ? `e.${locationCol}::uuid` : `NULL::uuid`;

  return `
    SELECT
      e.id::text AS id,
      ${fullNameExpr} AS full_name,
      ${shortNameExpr} AS short_name,
      ${photoExpr} AS photo_url,
      ${roleExpr} AS role,
      ${locExpr} AS location_id
    FROM employees e
    ORDER BY COALESCE(${shortNameExpr}, ${fullNameExpr}) ASC
  `;
}

/**
 * GET /api/timetable?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Robust: employees tábla eltérő sémáját automatikusan kezeli (short_name hiány -> nem dől el).
 */
router.get("/", async (req: AuthRequest, res) => {
  const { from, to } = req.query as any;

  if (!from || !to) {
    return res.status(400).json({ error: "from és to query param kötelező (YYYY-MM-DD)" });
  }

  try {
    const cols = await loadEmployeesCols();
    const employeesSql = buildEmployeesSelect(cols);
    const employeesRes = await pool.query(employeesSql);

    const apRes = await pool.query(
      `
      WITH has_aps AS (
        SELECT to_regclass('public.appointment_services') IS NOT NULL AS ok
      ),
      has_app_prod AS (
        SELECT to_regclass('public.appointment_products') IS NOT NULL AS ok
      )
      SELECT
        a.id::text,
        a.employee_id::text,
        a.client_id::text AS client_id,
        COALESCE(c.full_name, c.name, '') AS client_name,
        a.location_id::text,
        NULL::text AS location_name,
        a.title,
        a.start_time,
        a.end_time,
        a.status,
        a.notes,
        (
          CASE
            WHEN (SELECT ok FROM has_aps) THEN
              COALESCE((
                SELECT array_agg(COALESCE(s.name, '') ORDER BY aps.sort_order, aps.created_at)
                FROM appointment_services aps
                LEFT JOIN services s ON s.id = aps.service_id
                WHERE aps.appointment_id = a.id
              ), ARRAY[]::text[])
            ELSE ARRAY[]::text[]
          END
        ) AS service_names,
        (
          CASE
            WHEN (SELECT ok FROM has_aps) THEN
              COALESCE((
                SELECT COALESCE(SUM(COALESCE(aps.price, 0)), 0)
                FROM appointment_services aps
                WHERE aps.appointment_id = a.id
              ), 0)
            ELSE 0
          END
          +
          CASE
            WHEN (SELECT ok FROM has_app_prod) THEN
              COALESCE((
                SELECT COALESCE(SUM(COALESCE(ap.qty,1) * COALESCE(ap.price,0)), 0)
                FROM appointment_products ap
                WHERE ap.appointment_id = a.id
              ), 0)
            ELSE 0
          END
        )::numeric AS total
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.start_time >= ($1::date)::timestamp
        AND a.start_time <  (($2::date + INTERVAL '1 day')::timestamp)
      ORDER BY a.start_time ASC
      `,
      [from, to]
    );

    return res.json({
      employees: employeesRes.rows,
      appointments: apRes.rows,
    });
  } catch (err: any) {
    console.error("[/api/timetable] error:", err);
    return res.status(500).json({
      error: "Szerver hiba a timetable lekérésnél",
      detail: err?.message || String(err),
      code: err?.code || null,
    });
  }
});

export default router;
