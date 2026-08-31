import { Router } from "express";
import db from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { resolveTenantIdentity, tenantLocationIds } from "../saas/tenantAccess";

const router = Router();
router.use(requireAuth);

function roleTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.toLowerCase());
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.toLowerCase());
  } catch {
    // Legacy role fields can contain comma separated values.
  }
  return raw
    .split(",")
    .map((item) => item.replace(/[\[\]"']/g, "").trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(req: AuthRequest): boolean {
  return roleTokens(req.user?.role).some((role) =>
    ["admin", "administrator", "superadmin", "super_admin", "rendszergazda"].includes(role),
  );
}

async function permittedLocations(req: AuthRequest): Promise<string[]> {
  const requested = String(req.query.location_id || "").trim();
  const own = String(req.user?.location_id || "").trim();
  try {
    const tenant = await resolveTenantIdentity(req);
    if (tenant) {
      const locations = (await tenantLocationIds(tenant.id)).map(String);
      if (isAdmin(req)) {
        if (requested) return locations.includes(requested) ? [requested] : [];
        return locations;
      }
      if (own && locations.includes(own)) return [own];
      return [];
    }
  } catch (error: any) {
    console.warn("[client-list-recovery] tenant scope unavailable", error?.code || "", error?.message || error);
  }

  // Fail closed to a concrete location when tenant resolution is temporarily
  // unavailable. Never widen an unscoped request to all tenants.
  if (requested && (isAdmin(req) || requested === own)) return [requested];
  if (own) return [own];
  return [];
}

const boolSql = (column: string, defaultValue: boolean) => `CASE
  WHEN lower(COALESCE(NULLIF(to_jsonb(c)->>'${column}',''),'${defaultValue ? "true" : "false"}')) IN ('true','t','1','yes','igen','i','y') THEN true
  WHEN lower(COALESCE(NULLIF(to_jsonb(c)->>'${column}',''),'${defaultValue ? "true" : "false"}')) IN ('false','f','0','no','nem','n') THEN false
  ELSE ${defaultValue ? "true" : "false"}
END`;

/**
 * Stable guest picker / CRM list read.
 * Legacy imports can contain text/empty-string consent flags; direct ::boolean
 * casts used by older reads turn those rows into HTTP 500. This route runs
 * before clientsCore and deliberately parses those values without casts.
 */
router.get("/", async (req: AuthRequest, res, next) => {
  try {
    const locations = await permittedLocations(req);
    if (!locations.length) return res.json([]);

    const q = `%${String(req.query.q || "").trim()}%`;
    const status = String(req.query.status || "all").toLowerCase();
    const activeExpr = boolSql("is_active", true);
    const marketingExpr = boolSql("marketing_consent", false);

    const { rows } = await db.query(
      `SELECT c.id::text id,
        to_jsonb(c)->>'location_id' location_id,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen ügyfél') name,
        to_jsonb(c)->>'phone' phone,
        to_jsonb(c)->>'email' email,
        to_jsonb(c)->>'birth_date' birth_date,
        to_jsonb(c)->>'gender' gender,
        to_jsonb(c)->>'city' city,
        to_jsonb(c)->>'address' address,
        to_jsonb(c)->>'notes' notes,
        to_jsonb(c)->>'barcode' barcode,
        COALESCE(NULLIF(to_jsonb(c)->>'customer_type',''),'normal') customer_type,
        to_jsonb(c)->>'preferred_employee_id' preferred_employee_id,
        COALESCE(NULLIF(to_jsonb(c)->>'preferred_contact',''),'phone') preferred_contact,
        ${marketingExpr} marketing_consent,
        ${activeExpr} is_active,
        COALESCE(NULLIF(to_jsonb(c)->>'source',''),'legacy') source,
        to_jsonb(c)->>'created_at' created_at,
        to_jsonb(c)->>'updated_at' updated_at,
        (SELECT l.name FROM locations l WHERE l.id::text=(to_jsonb(c)->>'location_id') LIMIT 1) location_name,
        COALESCE(a.visits,0)::int visits,
        COALESCE(a.no_shows,0)::int no_shows,
        a.last_visit,
        a.next_visit,
        '[]'::json tags
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE lower(COALESCE(to_jsonb(ap)->>'status','')) IN ('completed','paid','confirmed')) visits,
          COUNT(*) FILTER (WHERE lower(COALESCE(to_jsonb(ap)->>'status',''))='no_show') no_shows,
          MAX(ap.start_time) FILTER (WHERE ap.start_time<=now()) last_visit,
          MIN(ap.start_time) FILTER (
            WHERE ap.start_time>now()
              AND lower(COALESCE(to_jsonb(ap)->>'status','')) NOT IN ('cancelled','no_show')
          ) next_visit
        FROM appointments ap
        WHERE ap.client_id::text=c.id::text
      ) a ON true
      WHERE COALESCE(to_jsonb(c)->>'location_id','')=ANY($1::text[])
        AND ($2='%%'
          OR COALESCE(to_jsonb(c)->>'full_name',to_jsonb(c)->>'name','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'email','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'phone','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'city','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'address','') ILIKE $2)
        AND ($3='all'
          OR ($3='active' AND ${activeExpr})
          OR ($3='inactive' AND NOT (${activeExpr})))
      ORDER BY lower(COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'')) ASC
      LIMIT 20000`,
      [locations, q, status],
    );

    return res.json(rows);
  } catch (error: any) {
    console.error("[client-list-recovery] stable list failed", error?.code || "", error?.message || error);
    return next(error);
  }
});

export default router;
