import { Router } from "express";
import db from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { clientLatenessStats } from "../services/clientLateness";

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function effectiveLocation(req: AuthRequest): string {
  if (isAdmin(req)) return String(req.query.location_id || "").trim();
  return String(req.user?.location_id || "").trim();
}

async function tableExists(name: string): Promise<boolean> {
  try {
    const result = await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${name}`]);
    return Boolean(result.rows[0]?.ok);
  } catch {
    return false;
  }
}

async function safeRows(label: string, query: Promise<any>): Promise<any[]> {
  try {
    return (await query).rows || [];
  } catch (error: any) {
    console.warn(`[client-read-500-hotfix] optional ${label} skipped`, error?.code || "", error?.message || error);
    return [];
  }
}

/**
 * Production recovery for CRM installations where optional tag tables were only
 * partially bootstrapped because legacy client IDs use a different SQL type.
 * A read-only work-order screen must never fail merely because CRM tags are absent.
 */
router.get("/segments", async (req: AuthRequest, res) => {
  try {
    if (!(await tableExists("crm_tags"))) return res.json([]);

    const locationId = effectiveLocation(req);
    const hasClientTags = await tableExists("crm_client_tags");
    const hasClients = await tableExists("clients");

    if (!hasClientTags || !hasClients) {
      const rows = await safeRows(
        "segments-base",
        db.query(`
          SELECT t.id::text id,
            COALESCE(NULLIF(to_jsonb(t)->>'name',''),'Címke') name,
            COALESCE(NULLIF(to_jsonb(t)->>'color',''),'#7c5ce5') color,
            CASE WHEN lower(COALESCE(NULLIF(to_jsonb(t)->>'is_active',''),'true')) IN ('false','0','no','nem') THEN false ELSE true END is_active,
            0::int client_count
          FROM crm_tags t
          ORDER BY 2
        `),
      );
      return res.json(rows);
    }

    const rows = await safeRows(
      "segments",
      db.query(
        `
          SELECT t.id::text id,
            COALESCE(NULLIF(to_jsonb(t)->>'name',''),'Címke') name,
            COALESCE(NULLIF(to_jsonb(t)->>'color',''),'#7c5ce5') color,
            CASE WHEN lower(COALESCE(NULLIF(to_jsonb(t)->>'is_active',''),'true')) IN ('false','0','no','nem') THEN false ELSE true END is_active,
            COUNT(c.id)::int client_count
          FROM crm_tags t
          LEFT JOIN crm_client_tags ct ON (to_jsonb(ct)->>'tag_id')=t.id::text
          LEFT JOIN clients c
            ON c.id::text=(to_jsonb(ct)->>'client_id')
           AND ($1::text='' OR COALESCE(to_jsonb(c)->>'location_id','')=$1::text)
          GROUP BY t.id
          ORDER BY 2
        `,
        [locationId],
      ),
    );
    return res.json(rows);
  } catch (error: any) {
    console.error("[client-read-500-hotfix] segments failed closed to empty", error?.code || "", error?.message || error);
    return res.json([]);
  }
});

/**
 * Lightweight, schema-drift-tolerant client context used by the digital work
 * order. Optional history must degrade independently instead of taking the whole
 * guest step down with HTTP 500.
 */
router.get("/:id", async (req: AuthRequest, res, next) => {
  if (!UUID_RE.test(String(req.params.id || ""))) return next();

  try {
    const clientResult = await db.query(
      `SELECT c.*,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'') display_name
       FROM clients c
       WHERE c.id::text=$1
       LIMIT 1`,
      [req.params.id],
    );
    const client = clientResult.rows[0];
    if (!client) return res.status(404).json({ error: "Az ügyfél nem található." });

    const locationId = effectiveLocation(req);
    const clientLocation = String(client.location_id || "").trim();
    if (locationId && clientLocation && locationId !== clientLocation) {
      return res.status(404).json({ error: "Az ügyfél nem található ezen a telephelyen." });
    }

    let locationName: string | null = null;
    if (clientLocation && (await tableExists("locations"))) {
      const locationRows = await safeRows(
        "location",
        db.query("SELECT name FROM locations WHERE id::text=$1 LIMIT 1", [clientLocation]),
      );
      locationName = locationRows[0]?.name || null;
    }

    const [appointments, notes, tags, forms, loyalty, consents, lateness] = await Promise.all([
      safeRows(
        "appointments",
        db.query(
          `SELECT a.id,a.start_time,a.end_time,a.status,a.title,
             NULLIF(to_jsonb(a)->>'arrived_at','') arrived_at,
             CASE WHEN COALESCE(to_jsonb(a)->>'late_minutes','')~'^\\d+$' THEN (to_jsonb(a)->>'late_minutes')::int ELSE 0 END late_minutes,
             (SELECT name FROM locations l WHERE l.id::text=a.location_id::text LIMIT 1) location_name,
             (SELECT COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'') FROM employees e WHERE e.id::text=a.employee_id::text LIMIT 1) employee_name
           FROM appointments a
           WHERE a.client_id::text=$1
           ORDER BY a.start_time DESC
           LIMIT 100`,
          [req.params.id],
        ),
      ),
      safeRows("notes", db.query("SELECT * FROM crm_client_notes WHERE client_id::text=$1 ORDER BY created_at DESC", [req.params.id])),
      safeRows(
        "tags",
        db.query("SELECT t.* FROM crm_client_tags ct JOIN crm_tags t ON t.id::text=ct.tag_id::text WHERE ct.client_id::text=$1 ORDER BY t.name", [req.params.id]),
      ),
      safeRows(
        "forms",
        db.query("SELECT r.*,f.title,f.form_type FROM crm_form_responses r JOIN crm_forms f ON f.id::text=r.form_id::text WHERE r.client_id::text=$1 ORDER BY r.completed_at DESC", [req.params.id]),
      ),
      safeRows(
        "loyalty",
        db.query("SELECT pm.*,t.name tier_name,t.color,t.discount_percent FROM loyalty_program_members pm LEFT JOIN loyalty_program_tiers t ON t.code=pm.tier_code WHERE pm.client_id::text=$1", [req.params.id]),
      ),
      safeRows("consents", db.query("SELECT * FROM crm_consent_history WHERE client_id::text=$1 ORDER BY created_at DESC LIMIT 20", [req.params.id])),
      clientLatenessStats(String(req.params.id)).catch(() => ({
        attended: 0,
        late_count: 0,
        late_percentage: 0,
        max_late_minutes: 0,
        grace_minutes: 5,
      })),
    ]);

    return res.json({
      client: { ...client, location_name: locationName },
      appointments,
      notes,
      tags,
      forms,
      loyalty: loyalty[0] || null,
      consents,
      lateness,
      recovery: true,
      hotfix: "client-read-500",
    });
  } catch (error: any) {
    console.error("[client-read-500-hotfix] client base read failed", error?.code || "", error?.message || error);
    return next(error);
  }
});

export default router;
