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
    // Legacy roles are frequently stored as comma-separated text.
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
    console.warn("[booking-client-search] tenant scope unavailable", error?.code || "", error?.message || error);
  }

  // Fail closed. A temporary tenant lookup issue must never broaden a guest search.
  if (requested && (isAdmin(req) || requested === own)) return [requested];
  if (own) return [own];
  return [];
}

/**
 * Small, indexed-friendly guest picker endpoint for appointment creation.
 * It intentionally avoids appointment history, CRM tags and other expensive
 * joins so typing in the picker never has to download the full guest database.
 */
router.get("/booking-search", async (req: AuthRequest, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json([]);

  try {
    const locations = await permittedLocations(req);
    if (!locations.length) return res.json([]);

    const contains = `%${query}%`;
    const prefix = `${query}%`;
    const { rows } = await db.query(
      `SELECT c.id::text id,
        to_jsonb(c)->>'location_id' location_id,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen vendég') name,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen vendég') full_name,
        to_jsonb(c)->>'phone' phone,
        to_jsonb(c)->>'email' email,
        to_jsonb(c)->>'barcode' barcode,
        to_jsonb(c)->>'customer_type' customer_type,
        to_jsonb(c)->>'vip_status' vip_status,
        to_jsonb(c)->>'loyalty_points' loyalty_points,
        to_jsonb(c)->>'points' points,
        to_jsonb(c)->>'visit_count' visit_count,
        to_jsonb(c)->>'appointments_count' appointments_count,
        to_jsonb(c)->>'last_visit_at' last_visit_at,
        to_jsonb(c)->>'last_appointment_at' last_appointment_at,
        to_jsonb(c)->>'favorite_service_name' favorite_service_name,
        to_jsonb(c)->>'favourite_service_name' favourite_service_name,
        to_jsonb(c)->>'allergies' allergies,
        to_jsonb(c)->>'allergy_notes' allergy_notes,
        to_jsonb(c)->>'notes' notes,
        to_jsonb(c)->>'internal_notes' internal_notes
      FROM clients c
      WHERE COALESCE(to_jsonb(c)->>'location_id','')=ANY($1::text[])
        AND CASE
          WHEN lower(COALESCE(NULLIF(to_jsonb(c)->>'is_active',''),'true')) IN ('false','f','0','no','nem','n') THEN false
          ELSE true
        END
        AND (
          COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),to_jsonb(c)->>'name','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'phone','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'email','') ILIKE $2
          OR COALESCE(to_jsonb(c)->>'barcode','') ILIKE $2
        )
      ORDER BY
        CASE WHEN COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),to_jsonb(c)->>'name','') ILIKE $3 THEN 0 ELSE 1 END,
        lower(COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'')) ASC
      LIMIT 12`,
      [locations, contains, prefix],
    );

    return res.json(rows);
  } catch (error: any) {
    console.error("[booking-client-search] failed", error?.code || "", error?.message || error);
    return res.status(503).json({ error: "A vendégkeresés átmenetileg nem elérhető." });
  }
});

export default router;
