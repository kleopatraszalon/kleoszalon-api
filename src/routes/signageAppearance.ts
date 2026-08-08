import { Router } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";

export const signageAppearancePublicRouter = Router();
export const signageAppearanceAdminRouter = Router();
signageAppearanceAdminRouter.use(requireAuth);

const BASE_APPEARANCE = {
  colors: {
    background: "#09070a",
    surface: "#171219",
    surfaceAlt: "#211720",
    text: "#fffaf5",
    muted: "#cfc4c8",
    gold: "#b69861",
    accent: "#ec008c",
    success: "#41d67c"
  },
  effects: {
    glow: 32,
    blur: 18,
    radius: 26,
    contrast: 1,
    motion: "medium",
    ambient: true,
    scanlines: false
  },
  popup: {
    enabled: true,
    intervalSec: 180,
    durationSec: 12,
    initialDelaySec: 45,
    source: "flash_then_deal",
    animation: "impact",
    showPrice: true
  }
};

export const DEFAULT_SIGNAGE_APPEARANCE = { ...BASE_APPEARANCE, template: "neon" };
export const CLASSIC_SIGNAGE_APPEARANCE = { ...BASE_APPEARANCE, template: "classic", effects: { ...BASE_APPEARANCE.effects, ambient: false, scanlines: false, glow: 0, blur: 0, radius: 18 } };

async function ensure() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `INSERT INTO public.signage_settings(key,value)
     VALUES('appearance_config',$1)
     ON CONFLICT(key) DO NOTHING`,
    [JSON.stringify(DEFAULT_SIGNAGE_APPEARANCE)]
  );
}

function mergeConfig(raw: any) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    ...DEFAULT_SIGNAGE_APPEARANCE,
    ...input,
    colors: { ...DEFAULT_SIGNAGE_APPEARANCE.colors, ...(input.colors || {}) },
    effects: { ...DEFAULT_SIGNAGE_APPEARANCE.effects, ...(input.effects || {}) },
    popup: { ...DEFAULT_SIGNAGE_APPEARANCE.popup, ...(input.popup || {}) }
  };
}

async function readConfig() {
  await ensure();
  const row = (await pool.query(`SELECT value,updated_at FROM public.signage_settings WHERE key='appearance_config' LIMIT 1`)).rows[0];
  let parsed: any = {};
  try { parsed = JSON.parse(String(row?.value || "{}")); } catch {}
  return { config: mergeConfig(parsed), updated_at: row?.updated_at || null };
}

signageAppearancePublicRouter.get("/appearance", async (_req, res) => {
  try {
    const data = await readConfig();
    res.json({ ok: true, ...data });
  } catch (e: any) {
    res.json({ ok: true, config: DEFAULT_SIGNAGE_APPEARANCE, updated_at: null, warning: e?.message || String(e) });
  }
});

signageAppearanceAdminRouter.get("/", async (_req, res) => {
  try { res.json({ ok: true, ...(await readConfig()) }); }
  catch (e: any) { res.status(500).json({ ok: false, error: e?.message || "appearance_read_failed" }); }
});

signageAppearanceAdminRouter.put("/", async (req, res) => {
  try {
    await ensure();
    const config = mergeConfig(req.body?.config ?? req.body ?? {});
    const allowedTemplates = new Set(["classic", "neon", "luxe", "glass"]);
    if (!allowedTemplates.has(String(config.template))) config.template = "neon";
    config.popup.intervalSec = Math.max(45, Math.min(1800, Number(config.popup.intervalSec) || 180));
    config.popup.durationSec = Math.max(5, Math.min(60, Number(config.popup.durationSec) || 12));
    config.popup.initialDelaySec = Math.max(10, Math.min(900, Number(config.popup.initialDelaySec) || 45));
    config.effects.radius = Math.max(0, Math.min(60, Number(config.effects.radius) || 26));
    config.effects.glow = Math.max(0, Math.min(80, Number(config.effects.glow) || 32));
    config.effects.blur = Math.max(0, Math.min(40, Number(config.effects.blur) || 18));
    const row = (await pool.query(
      `INSERT INTO public.signage_settings(key,value,updated_at)
       VALUES('appearance_config',$1,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
       RETURNING updated_at`, [JSON.stringify(config)]
    )).rows[0];
    res.json({ ok: true, config, updated_at: row?.updated_at || null });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "appearance_save_failed" });
  }
});

signageAppearanceAdminRouter.post("/reset", async (_req, res) => {
  try {
    await ensure();
    const row = (await pool.query(
      `INSERT INTO public.signage_settings(key,value,updated_at)
       VALUES('appearance_config',$1,now())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
       RETURNING updated_at`, [JSON.stringify(CLASSIC_SIGNAGE_APPEARANCE)]
    )).rows[0];
    res.json({ ok: true, config: CLASSIC_SIGNAGE_APPEARANCE, updated_at: row?.updated_at || null });
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || "appearance_reset_failed" }); }
});

export default signageAppearanceAdminRouter;
