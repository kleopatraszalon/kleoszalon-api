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

function rolesOf(req: AuthRequest) {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw || "").replace(/[\[\]"]/g, "").split(",").map(x => x.trim()).filter(Boolean);
}

function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (rolesOf(req).map(x => x.toLowerCase()).includes("admin")) return next();
  return res.status(403).json({ message: "A dashboard beállításait csak adminisztrátor módosíthatja." });
}

router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT settings FROM dashboard_settings WHERE id = 1`);
    const saved = rows[0]?.settings && typeof rows[0].settings === "object" ? rows[0].settings : {};
    res.json({ settings: { ...DEFAULT_DASHBOARD_SETTINGS, ...saved } });
  } catch (err) {
    next(err);
  }
});

router.put("/", adminOnly, async (req: AuthRequest, res, next) => {
  try {
    const incoming = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {};
    const clean: Record<string, boolean> = {};
    for (const key of Object.keys(DEFAULT_DASHBOARD_SETTINGS)) {
      clean[key] = incoming[key] === undefined
        ? (DEFAULT_DASHBOARD_SETTINGS as any)[key]
        : Boolean(incoming[key]);
    }
    const actor = req.user?.email || String(req.user?.id || "");
    const { rows } = await db.query(
      `INSERT INTO dashboard_settings (id, settings, updated_by, updated_at)
       VALUES (1, $1::jsonb, $2, now())
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING settings, updated_by, updated_at`,
      [JSON.stringify(clean), actor]
    );
    res.json({ settings: { ...DEFAULT_DASHBOARD_SETTINGS, ...(rows[0]?.settings || {}) }, updated_by: rows[0]?.updated_by, updated_at: rows[0]?.updated_at });
  } catch (err) {
    next(err);
  }
});

export default router;
