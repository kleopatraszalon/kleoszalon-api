import { Router, Response } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { DEFAULT_WEBSITE_CONFIG } from "../website/defaultWebsiteConfig";
import { ensureWebsiteCms } from "../website/ensureWebsiteCms";

const router = Router();

function roles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.toLowerCase());
  const value = String(raw || "");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.toLowerCase());
  } catch {}
  return value.split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}

function requireWebsiteAdmin(req: AuthRequest, res: Response): boolean {
  const r = roles(req.user?.role);
  if (r.some(x => ["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto"].includes(x))) return true;
  res.status(403).json({ error: "A weboldal szerkesztéséhez vezetői vagy adminisztrátori jogosultság szükséges." });
  return false;
}

function validConfig(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

router.get("/public/website/config", async (_req, res) => {
  try {
    await ensureWebsiteCms();
    const { rows } = await pool.query(`SELECT published,published_at FROM website_cms WHERE id=1`);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res.json({ config: rows[0]?.published || DEFAULT_WEBSITE_CONFIG, published_at: rows[0]?.published_at || null });
  } catch (err: any) {
    console.error("GET public website config:", err?.message || err);
    return res.json({ config: DEFAULT_WEBSITE_CONFIG, published_at: null, fallback: true });
  }
});

router.get("/admin/website/config", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  try {
    await ensureWebsiteCms();
    const { rows } = await pool.query(`SELECT draft,published,updated_at,published_at,updated_by FROM website_cms WHERE id=1`);
    return res.json(rows[0] || { draft: DEFAULT_WEBSITE_CONFIG, published: DEFAULT_WEBSITE_CONFIG });
  } catch (err: any) {
    return res.status(500).json({ error: "A weboldal beállításai nem tölthetők be.", detail: err?.message || String(err) });
  }
});

router.put("/admin/website/config", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  if (!validConfig(req.body?.config)) return res.status(400).json({ error: "Érvénytelen weboldal-konfiguráció." });
  try {
    await ensureWebsiteCms();
    const config = req.body.config;
    await pool.query(`UPDATE website_cms SET draft=$1::jsonb,updated_at=now(),updated_by=$2 WHERE id=1`, [JSON.stringify(config), req.user?.id || null]);
    await pool.query(`INSERT INTO website_cms_revisions(revision_type,config,created_by) VALUES('draft',$1::jsonb,$2)`, [JSON.stringify(config), req.user?.id || null]);
    return res.json({ ok: true, updated_at: new Date().toISOString() });
  } catch (err: any) {
    return res.status(500).json({ error: "A piszkozat mentése nem sikerült.", detail: err?.message || String(err) });
  }
});

router.post("/admin/website/publish", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  try {
    await ensureWebsiteCms();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`UPDATE website_cms SET published=draft,published_at=now(),updated_at=now(),updated_by=$1 WHERE id=1 RETURNING published,published_at`, [req.user?.id || null]);
      await client.query(`INSERT INTO website_cms_revisions(revision_type,config,created_by) VALUES('publish',$1::jsonb,$2)`, [JSON.stringify(rows[0].published), req.user?.id || null]);
      await client.query("COMMIT");
      return res.json({ ok: true, published_at: rows[0].published_at, config: rows[0].published });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    return res.status(500).json({ error: "A publikálás nem sikerült.", detail: err?.message || String(err) });
  }
});

router.post("/admin/website/reset-brand", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  try {
    await ensureWebsiteCms();
    await pool.query(`UPDATE website_cms SET draft=$1::jsonb,updated_at=now(),updated_by=$2 WHERE id=1`, [JSON.stringify(DEFAULT_WEBSITE_CONFIG), req.user?.id || null]);
    return res.json({ ok: true, config: DEFAULT_WEBSITE_CONFIG });
  } catch (err: any) {
    return res.status(500).json({ error: "Az arculati alapértékek visszaállítása nem sikerült.", detail: err?.message || String(err) });
  }
});

router.get("/admin/website/revisions", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  try {
    await ensureWebsiteCms();
    const { rows } = await pool.query(`SELECT id,revision_type,created_at,created_by FROM website_cms_revisions ORDER BY id DESC LIMIT 30`);
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: "A változásnapló nem tölthető be.", detail: err?.message || String(err) });
  }
});

router.post("/admin/website/revisions/:id/restore", requireAuth, async (req: AuthRequest, res) => {
  if (!requireWebsiteAdmin(req, res)) return;
  const revisionId = Number(req.params.id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return res.status(400).json({ error: "Érvénytelen verzióazonosító." });
  try {
    await ensureWebsiteCms();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const revision = await client.query(`SELECT config FROM website_cms_revisions WHERE id=$1 LIMIT 1`, [revisionId]);
      if (!revision.rows[0]?.config) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "A kiválasztott weboldal-verzió nem található." });
      }
      const restored = revision.rows[0].config;
      const updated = await client.query(
        `UPDATE website_cms SET draft=$1::jsonb,updated_at=now(),updated_by=$2 WHERE id=1 RETURNING updated_at`,
        [JSON.stringify(restored), req.user?.id || null],
      );
      await client.query(
        `INSERT INTO website_cms_revisions(revision_type,config,created_by) VALUES('draft',$1::jsonb,$2)`,
        [JSON.stringify(restored), req.user?.id || null],
      );
      await client.query("COMMIT");
      return res.json({ ok: true, restored_from: revisionId, config: restored, updated_at: updated.rows[0]?.updated_at || new Date().toISOString() });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    return res.status(500).json({ error: "A kiválasztott verzió visszaállítása nem sikerült.", detail: err?.message || String(err) });
  }
});

export default router;
