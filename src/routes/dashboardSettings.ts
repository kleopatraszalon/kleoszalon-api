import { Router, Response } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

export const DEFAULT_DASHBOARD_SETTINGS = {
  executive_overview: true,
  period_insights: true,
  targets: true,
  live_business: true,
  classic_kpis: true,
  revenue_mix: true,
  location_performance: true,
  hr_performance: true,
  top_staff_alerts: true,
};

export const DEFAULT_DASHBOARD_ORDER = [
  "executive_overview",
  "period_insights",
  "targets",
  "live_business",
  "classic_kpis",
  "revenue_mix",
  "location_performance",
  "hr_performance",
  "top_staff_alerts",
] as const;

const validKeys = new Set<string>(DEFAULT_DASHBOARD_ORDER);

function normalizeRole(value: string) {
  const role = value.trim().toLowerCase();
  if (["administrator", "rendszergazda", "superadmin", "super_admin"].includes(role)) return "admin";
  if (["vezető", "vezeto"].includes(role)) return "manager";
  return role || "employee";
}

function rolesOf(req: AuthRequest) {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map(normalizeRole).filter(Boolean);
  const value = String(raw || "");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(normalizeRole).filter(Boolean);
  } catch {}
  return value.replace(/[\[\]"]/g, "").split(",").map(x => normalizeRole(x)).filter(Boolean);
}

function isAdmin(req: AuthRequest) {
  return rolesOf(req).includes("admin");
}

function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ message: "A dashboard beállításait csak adminisztrátor módosíthatja." });
}

function cleanSettings(incoming: any) {
  const clean: Record<string, boolean> = {};
  for (const key of Object.keys(DEFAULT_DASHBOARD_SETTINGS)) {
    clean[key] = incoming?.[key] === undefined
      ? (DEFAULT_DASHBOARD_SETTINGS as any)[key]
      : Boolean(incoming[key]);
  }
  clean.live_business = true;
  return clean;
}

function cleanOrder(incoming: any): string[] {
  const requested = Array.isArray(incoming) ? incoming.map(String).filter(key => validKeys.has(key)) : [];
  const unique = Array.from(new Set(requested));
  for (const key of DEFAULT_DASHBOARD_ORDER) if (!unique.includes(key)) unique.push(key);
  return ["live_business",...unique.filter(key=>key!=="live_business")];
}

async function hasProfilesTable() {
  const { rows } = await db.query(`SELECT to_regclass('public.dashboard_layout_profiles') IS NOT NULL AS ok`);
  return Boolean(rows[0]?.ok);
}

async function legacyLayout() {
  try {
    const { rows } = await db.query(`SELECT settings FROM dashboard_settings WHERE id = 1`);
    const saved = rows[0]?.settings && typeof rows[0].settings === "object" ? rows[0].settings : {};
    return { settings: cleanSettings(saved), order: cleanOrder(DEFAULT_DASHBOARD_ORDER) };
  } catch {
    return { settings: { ...DEFAULT_DASHBOARD_SETTINGS }, order: [...DEFAULT_DASHBOARD_ORDER] };
  }
}

router.get("/", async (req: AuthRequest, res, next) => {
  try {
    const admin = isAdmin(req);
    const actualRole = rolesOf(req)[0] || "employee";
    const targetRole = admin && req.query.role_key ? normalizeRole(String(req.query.role_key)) : actualRole;
    const requestedLocation = String(req.query.location_id || "").trim();
    const actualLocation = req.user?.location_id == null ? "" : String(req.user.location_id);
    const targetLocation = admin ? requestedLocation : actualLocation;
    const roleKey = targetRole || "*";
    const locationKey = targetLocation || "*";

    if (!(await hasProfilesTable())) {
      const legacy = await legacyLayout();
      return res.json({ ...legacy, role_key: roleKey, location_id: locationKey === "*" ? null : locationKey, source: "legacy" });
    }

    const { rows } = await db.query(
      `SELECT role_key,location_key,settings,widget_order,updated_by,updated_at
       FROM dashboard_layout_profiles
       WHERE (role_key=$1 OR role_key='*') AND (location_key=$2 OR location_key='*')
       ORDER BY
         CASE WHEN role_key=$1 THEN 0 ELSE 1 END,
         CASE WHEN location_key=$2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [roleKey, locationKey]
    );

    if (!rows[0]) {
      const legacy = await legacyLayout();
      return res.json({ ...legacy, role_key: roleKey, location_id: locationKey === "*" ? null : locationKey, source: "default" });
    }

    const savedSettings = rows[0].settings && typeof rows[0].settings === "object" ? rows[0].settings : {};
    res.json({
      settings: cleanSettings(savedSettings),
      order: cleanOrder(rows[0].widget_order),
      role_key: roleKey,
      location_id: locationKey === "*" ? null : locationKey,
      source: { role_key: rows[0].role_key, location_key: rows[0].location_key },
      updated_by: rows[0].updated_by,
      updated_at: rows[0].updated_at,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/", adminOnly, async (req: AuthRequest, res, next) => {
  try {
    if (!(await hasProfilesTable())) {
      return res.status(409).json({ message: "A dashboard profil migráció még nincs lefuttatva a pgAdminban." });
    }
    const roleKey = req.body?.role_key ? normalizeRole(String(req.body.role_key)) : "*";
    const locationKey = String(req.body?.location_id || "").trim() || "*";
    const clean = cleanSettings(req.body?.settings);
    const order = cleanOrder(req.body?.order);
    const actor = req.user?.email || String(req.user?.id || "");
    const { rows } = await db.query(
      `INSERT INTO dashboard_layout_profiles (role_key,location_key,settings,widget_order,updated_by,updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,now())
       ON CONFLICT (role_key,location_key) DO UPDATE SET
         settings=EXCLUDED.settings,
         widget_order=EXCLUDED.widget_order,
         updated_by=EXCLUDED.updated_by,
         updated_at=now()
       RETURNING role_key,location_key,settings,widget_order,updated_by,updated_at`,
      [roleKey, locationKey, JSON.stringify(clean), JSON.stringify(order), actor]
    );
    res.json({
      settings: cleanSettings(rows[0]?.settings || {}),
      order: cleanOrder(rows[0]?.widget_order),
      role_key: rows[0]?.role_key,
      location_id: rows[0]?.location_key === "*" ? null : rows[0]?.location_key,
      updated_by: rows[0]?.updated_by,
      updated_at: rows[0]?.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
