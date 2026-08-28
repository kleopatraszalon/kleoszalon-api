import type { NextFunction, Request, Response } from "express";
import pool from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import employeesRouter from "./employees";

let skillSchemaReady: Promise<void> | null = null;

function ensureSkillSchema() {
  if (!skillSchemaReady) {
    skillSchemaReady = pool.query(`
      ALTER TABLE employee_service_overrides
        ADD COLUMN IF NOT EXISTS skill_level smallint NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS can_perform boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS qualification_name text,
        ADD COLUMN IF NOT EXISTS qualification_number text,
        ADD COLUMN IF NOT EXISTS qualification_valid_until date,
        ADD COLUMN IF NOT EXISTS qualification_verified boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS skill_notes text,
        ADD COLUMN IF NOT EXISTS skill_updated_at timestamptz NOT NULL DEFAULT now();
    `).then(() => undefined).catch((error) => {
      skillSchemaReady = null;
      throw error;
    });
  }
  return skillSchemaReady;
}

const asyncRoute = (handler: (req: any, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textOrNull = (value: unknown, max: number) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
};
const boolValue = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

employeesRouter.get(
  "/skill-matrix",
  requireAuth,
  requireManagement,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureSkillSchema();
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const locationId = String(req.query.location_id || "").trim() || null;
    if (locationId && !uuidPattern.test(locationId)) {
      return res.status(400).json({ error: "Érvénytelen telephely-azonosító." });
    }

    const { rows } = await pool.query(
      `SELECT
         e.id::text AS employee_id,
         e.full_name AS employee_name,
         e.position_id::text AS position_id,
         p.name AS position_name,
         e.location_id::text AS location_id,
         l.name AS location_name,
         COALESCE(e.active,true) AS employee_active,
         s.id::text AS service_id,
         s.name AS service_name,
         s.base_price,
         s.base_duration_minutes,
         o.custom_price,
         o.custom_duration_minutes,
         COALESCE(o.skill_level,3)::int AS skill_level,
         COALESCE(o.can_perform,true) AS can_perform,
         o.qualification_name,
         o.qualification_number,
         o.qualification_valid_until,
         COALESCE(o.qualification_verified,false) AS qualification_verified,
         o.skill_notes,
         o.skill_updated_at,
         CASE
           WHEN o.qualification_valid_until IS NULL THEN 'none'
           WHEN o.qualification_valid_until < CURRENT_DATE THEN 'expired'
           WHEN o.qualification_valid_until <= CURRENT_DATE + 30 THEN 'expiring'
           ELSE 'valid'
         END AS qualification_status
       FROM employee_service_overrides o
       JOIN employees e ON e.id=o.employee_id
       JOIN services s ON s.id=o.service_id
       LEFT JOIN hr_positions p ON p.id=e.position_id
       LEFT JOIN locations l ON l.id=e.location_id
       WHERE ($1::boolean OR COALESCE(e.active,true)=true)
         AND ($2::uuid IS NULL OR e.location_id=$2::uuid)
       ORDER BY e.full_name NULLS LAST, s.name`,
      [includeInactive, locationId],
    );

    res.json(rows);
  }),
);

employeesRouter.put(
  "/:id/skills/:serviceId",
  requireAuth,
  requireManagement,
  asyncRoute(async (req: AuthRequest, res) => {
    await ensureSkillSchema();
    const employeeId = String(req.params.id || "");
    const serviceId = String(req.params.serviceId || "");
    if (!uuidPattern.test(employeeId) || !uuidPattern.test(serviceId)) {
      return res.status(400).json({ error: "Érvénytelen munkatárs- vagy szolgáltatásazonosító." });
    }

    const body = req.body || {};
    const level = Number(body.skill_level);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      return res.status(400).json({ error: "A skill-szint 1 és 5 közötti egész szám lehet." });
    }

    const validUntil = textOrNull(body.qualification_valid_until, 10);
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      return res.status(400).json({ error: "A képesítés lejárata ÉÉÉÉ-HH-NN formátumú legyen." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query(
        `SELECT * FROM employee_service_overrides WHERE employee_id=$1::uuid AND service_id=$2::uuid FOR UPDATE`,
        [employeeId, serviceId],
      );
      if (!before.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Ez a szolgáltatás nincs hozzárendelve a munkatárshoz. Előbb rendelje hozzá a szolgáltatást.",
        });
      }

      const { rows } = await client.query(
        `UPDATE employee_service_overrides
         SET skill_level=$3,
             can_perform=$4,
             qualification_name=$5,
             qualification_number=$6,
             qualification_valid_until=$7::date,
             qualification_verified=$8,
             skill_notes=$9,
             skill_updated_at=now()
         WHERE employee_id=$1::uuid AND service_id=$2::uuid
         RETURNING *`,
        [
          employeeId,
          serviceId,
          level,
          boolValue(body.can_perform, true),
          textOrNull(body.qualification_name, 180),
          textOrNull(body.qualification_number, 120),
          validUntil,
          boolValue(body.qualification_verified, false),
          textOrNull(body.skill_notes, 1000),
        ],
      );

      try {
        await client.query(
          `INSERT INTO audit_log(actor_user_id,actor_role,action,entity_type,entity_id,location_id,old_data,new_data,request_id,ip_address)
           VALUES($1,$2,'update','employee_service_skill',$3,$4,$5::jsonb,$6::jsonb,$7,NULLIF($8,'')::inet)`,
          [
            String(req.user?.id ?? ""),
            req.user?.role ?? null,
            `${employeeId}:${serviceId}`,
            req.user?.location_id == null ? null : String(req.user.location_id),
            JSON.stringify(before.rows[0]),
            JSON.stringify(rows[0]),
            String(req.headers["x-request-id"] ?? "") || null,
            req.ip || "",
          ],
        );
      } catch (auditError) {
        console.warn("[employee-skill] audit log write skipped", auditError);
      }

      await client.query("COMMIT");
      res.json(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }),
);

export {};
