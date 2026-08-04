import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

let schemaReady: Promise<void> | null = null;

function ensureHrSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS positions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL,
          code text,
          description text,
          base_monthly_wage numeric(12,2) NOT NULL DEFAULT 0,
          base_hourly_wage numeric(12,2) NOT NULL DEFAULT 0,
          commission_percent numeric(5,2) NOT NULL DEFAULT 0,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS positions_name_unique
          ON positions (lower(name));

        ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS birth_date date;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS qualification text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS monthly_wage numeric(12,2);
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_wage numeric(12,2);
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS commission_percent numeric(5,2);
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS role jsonb NOT NULL DEFAULT '["employee"]'::jsonb;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id uuid;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url text;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
        CREATE UNIQUE INDEX IF NOT EXISTS employees_login_name_unique
          ON employees (lower(login_name)) WHERE login_name IS NOT NULL;

        CREATE TABLE IF NOT EXISTS employee_wage_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          monthly_wage numeric(12,2),
          hourly_wage numeric(12,2),
          commission_percent numeric(5,2),
          valid_from date NOT NULL DEFAULT CURRENT_DATE,
          note text,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS employee_service_overrides (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          custom_price numeric(12,2),
          custom_duration_minutes integer,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS employee_service_override_unique
          ON employee_service_overrides(employee_id, service_id);
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

const asyncRoute =
  (handler: (req: any, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    handler(req, res).catch(next);

const numberOrNull = (value: unknown) =>
  value === "" || value === null || value === undefined ? null : Number(value);

router.get(
  "/positions",
  requireAuth,
  asyncRoute(async (_req, res) => {
    await ensureHrSchema();
    const { rows } = await pool.query(`
      SELECT p.*,
             COUNT(e.id)::int AS employee_count
      FROM positions p
      LEFT JOIN employees e ON e.position_id = p.id AND e.active = true
      GROUP BY p.id
      ORDER BY p.is_active DESC, p.name
    `);
    res.json(rows);
  })
);

router.post(
  "/positions",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const { name, code, description, base_monthly_wage, base_hourly_wage, commission_percent, is_active } = req.body || {};
    if (!String(name || "").trim()) return res.status(400).json({ error: "A munkakör neve kötelező." });
    const { rows } = await pool.query(
      `INSERT INTO positions
        (name, code, description, base_monthly_wage, base_hourly_wage, commission_percent, is_active)
       VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,0),COALESCE($6,0),COALESCE($7,true))
       RETURNING *`,
      [String(name).trim(), code || null, description || null, numberOrNull(base_monthly_wage), numberOrNull(base_hourly_wage), numberOrNull(commission_percent), is_active]
    );
    res.status(201).json(rows[0]);
  })
);

router.patch(
  "/positions/:id",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const { name, code, description, base_monthly_wage, base_hourly_wage, commission_percent, is_active } = req.body || {};
    if (!String(name || "").trim()) return res.status(400).json({ error: "A munkakör neve kötelező." });
    const { rows } = await pool.query(
      `UPDATE positions SET name=$2, code=$3, description=$4,
        base_monthly_wage=COALESCE($5,0), base_hourly_wage=COALESCE($6,0),
        commission_percent=COALESCE($7,0), is_active=COALESCE($8,true), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, String(name).trim(), code || null, description || null, numberOrNull(base_monthly_wage), numberOrNull(base_hourly_wage), numberOrNull(commission_percent), is_active]
    );
    if (!rows[0]) return res.status(404).json({ error: "A munkakör nem található." });
    res.json(rows[0]);
  })
);

router.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    await ensureHrSchema();
    const includeInactive = req.query.include_inactive === "1";
    const { rows } = await pool.query(`
      SELECT e.id, e.location_id, l.name AS location_name, e.full_name,
             e.first_name, e.last_name, e.email, e.phone, e.birth_date,
             e.qualification, e.employment_type, e.position_id,
             p.name AS position_name, e.monthly_wage, e.hourly_wage,
             e.commission_percent, e.photo_url, e.active, e.login_name, e.role,
             e.created_at, e.updated_at
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN positions p ON p.id = e.position_id
      ${includeInactive ? "" : "WHERE e.active = true"}
      ORDER BY e.active DESC, e.full_name NULLS LAST, e.last_name, e.first_name
    `);
    res.json(rows);
  })
);

router.post(
  "/",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const body = req.body || {};
    const fullName = String(body.full_name || `${body.last_name || ""} ${body.first_name || ""}`).trim();
    if (!fullName) return res.status(400).json({ error: "A munkatárs neve kötelező." });
    if (body.login_name && !body.plain_password) return res.status(400).json({ error: "Belépési névhez jelszó is szükséges." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const passwordHash = body.plain_password ? await bcrypt.hash(String(body.plain_password), 12) : null;
      const inserted = await client.query(
        `INSERT INTO employees
          (full_name, first_name, last_name, email, phone, birth_date, qualification,
           employment_type, location_id, position_id, monthly_wage, hourly_wage,
           commission_percent, active, login_name, password_hash, role, photo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,true),$15,$16,$17::jsonb,$18)
         RETURNING id`,
        [fullName, body.first_name || null, body.last_name || null, body.email || null,
         body.phone || null, body.birth_date || null, body.qualification || null,
         body.employment_type || null, body.location_id || null, body.position_id || null,
         numberOrNull(body.monthly_wage), numberOrNull(body.hourly_wage), numberOrNull(body.commission_percent),
         body.active, body.login_name || null, passwordHash, JSON.stringify(body.roles?.length ? body.roles : ["employee"]), body.photo_url || null]
      );
      const employeeId = inserted.rows[0].id;

      if (body.monthly_wage || body.hourly_wage || body.commission_percent) {
        await client.query(
          `INSERT INTO employee_wage_history
             (employee_id, monthly_wage, hourly_wage, commission_percent, valid_from, note)
           VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6)`,
          [employeeId, numberOrNull(body.monthly_wage), numberOrNull(body.hourly_wage), numberOrNull(body.commission_percent), body.wage_valid_from || null, "Kezdő bérezés"]
        );
      }
      for (const service of Array.isArray(body.services) ? body.services : []) {
        await client.query(
          `INSERT INTO employee_service_overrides
             (employee_id, service_id, custom_price, custom_duration_minutes)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, service_id) DO UPDATE SET
             custom_price=EXCLUDED.custom_price,
             custom_duration_minutes=EXCLUDED.custom_duration_minutes`,
          [employeeId, service.service_id, numberOrNull(service.custom_price), numberOrNull(service.custom_duration_min ?? service.custom_duration_minutes)]
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ id: employeeId, message: "A munkatárs létrejött." });
    } catch (error: any) {
      await client.query("ROLLBACK");
      if (error?.code === "23505") return res.status(409).json({ error: "Ez a belépési név vagy munkatárs már létezik." });
      throw error;
    } finally {
      client.release();
    }
  })
);

router.patch(
  "/:id",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const body = req.body || {};
    const fullName = String(body.full_name || `${body.last_name || ""} ${body.first_name || ""}`).trim();
    if (!fullName) return res.status(400).json({ error: "A munkatárs neve kötelező." });
    const { rows } = await pool.query(
      `UPDATE employees SET full_name=$2, first_name=$3, last_name=$4, email=$5,
        phone=$6, birth_date=$7, qualification=$8, employment_type=$9,
        location_id=$10, position_id=$11, monthly_wage=$12, hourly_wage=$13,
        commission_percent=$14, active=COALESCE($15,true), photo_url=$16, updated_at=now()
       WHERE id=$1 RETURNING id`,
      [req.params.id, fullName, body.first_name || null, body.last_name || null,
       body.email || null, body.phone || null, body.birth_date || null, body.qualification || null,
       body.employment_type || null, body.location_id || null, body.position_id || null,
       numberOrNull(body.monthly_wage), numberOrNull(body.hourly_wage), numberOrNull(body.commission_percent),
       body.active, body.photo_url || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "A munkatárs nem található." });
    res.json({ id: rows[0].id, message: "A munkatárs adatai frissültek." });
  })
);

router.patch(
  "/:id/active",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const { rows } = await pool.query(
      "UPDATE employees SET active=$2, updated_at=now() WHERE id=$1 RETURNING id, active",
      [req.params.id, Boolean(req.body?.active)]
    );
    if (!rows[0]) return res.status(404).json({ error: "A munkatárs nem található." });
    res.json(rows[0]);
  })
);

router.get(
  "/:id/wages",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const { rows } = await pool.query(
      "SELECT * FROM employee_wage_history WHERE employee_id=$1 ORDER BY valid_from DESC, created_at DESC",
      [req.params.id]
    );
    res.json(rows);
  })
);

router.post(
  "/:id/wages",
  requireAuth,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureHrSchema();
    const body = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE employees SET monthly_wage=$2, hourly_wage=$3, commission_percent=$4, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [req.params.id, numberOrNull(body.monthly_wage), numberOrNull(body.hourly_wage), numberOrNull(body.commission_percent)]
      );
      if (!updated.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "A munkatárs nem található." }); }
      const { rows } = await client.query(
        `INSERT INTO employee_wage_history
          (employee_id, monthly_wage, hourly_wage, commission_percent, valid_from, note)
         VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6) RETURNING *`,
        [req.params.id, numberOrNull(body.monthly_wage), numberOrNull(body.hourly_wage), numberOrNull(body.commission_percent), body.valid_from || null, body.note || null]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  })
);

export default router;
