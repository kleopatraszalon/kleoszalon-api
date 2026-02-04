import { Router, Request, Response } from "express";
import crypto from "crypto";

// ⚠️ db export kompatibilitás: egyes projektverziókban default export van, másokban named 'pool'
import * as db from "../db";
const pool = ((db as any).pool ?? (db as any).default) as { query: (sql: string, params?: any[]) => Promise<any> };

const router = Router();

/**
 * Admin API for Signage module.
 * Mounted at: /api/admin/signage
 *
 * Endpoints:
 *  - GET/POST/PUT/DELETE /services
 *  - GET/POST/PUT/DELETE /deals
 *  - GET/POST/PUT/DELETE /videos
 *  - GET/POST/PUT/DELETE /quotes
 *  - GET/POST/PUT/DELETE /professionals
 *
 * Backward compat (régi front): / (professionals), /:id (professionals)
 */

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  // Ha már léteznek a táblák (ensureSignageTables), ez nem csinál semmit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signage_services (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      duration_min INT,
      price_text TEXT DEFAULT '',
      priority INT DEFAULT 0,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signage_deals (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      price_text TEXT DEFAULT '',
      valid_from DATE,
      valid_to DATE,
      active BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signage_videos (
      id UUID PRIMARY KEY,
      youtube_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      duration_sec INT DEFAULT 60,
      enabled BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signage_quotes (
      id UUID PRIMARY KEY,
      text TEXT NOT NULL,
      author TEXT DEFAULT '',
      enabled BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signage_professionals (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT DEFAULT '',
      note TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      show BOOLEAN DEFAULT TRUE,
      is_free BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  ensured = true;
}

function pickBool(v: any): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  return undefined;
}
function pickInt(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
function idOrNew(id?: any) {
  const s = String(id ?? "").trim();
  return s || crypto.randomUUID();
}

// ------------------------- SERVICES -------------------------
router.get("/services", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, name, category, duration_min, price_text, priority, enabled, created_at, updated_at
       FROM signage_services
       ORDER BY priority DESC, updated_at DESC`
    );
    const services = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      category: r.category ?? "",
      durationMin: r.duration_min ?? null,
      price_text: r.price_text ?? "",
      priority: Number(r.priority ?? 0),
      enabled: r.enabled === null ? true : !!r.enabled,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ services });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list services" });
  }
});

router.post("/services", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });

    const id = idOrNew(req.body?.id);
    const category = String(req.body?.category ?? "").trim();
    const durationMin = pickInt(req.body?.durationMin ?? req.body?.duration_min);
    const price_text = String(req.body?.price_text ?? req.body?.priceText ?? "").trim();
    const priority = pickInt(req.body?.priority) ?? 0;
    const enabled = pickBool(req.body?.enabled) ?? true;

    const { rows } = await pool.query(
      `INSERT INTO signage_services (id, name, category, duration_min, price_text, priority, enabled)
       VALUES ($1, $2, NULLIF($3,''), $4, NULLIF($5,''), $6, $7)
       RETURNING id, name, category, duration_min, price_text, priority, enabled, created_at, updated_at`,
      [id, name, category, durationMin ?? null, price_text, priority, enabled]
    );

    const r: any = rows[0];
    res.json({
      service: {
        id: r.id,
        name: r.name,
        category: r.category ?? "",
        durationMin: r.duration_min ?? null,
        price_text: r.price_text ?? "",
        priority: Number(r.priority ?? 0),
        enabled: r.enabled === null ? true : !!r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
    });
  } catch (e: any) {
    // gyakori: UUID cast hiba, ha a tábla TEXT-es; ilyenkor a DB üzenet egyértelmű lesz
    res.status(500).json({ error: e?.message ?? "Failed to create service" });
  }
});

router.put("/services/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const id = req.params.id;

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
    const category = req.body?.category !== undefined ? String(req.body.category).trim() : undefined;
    const durationMin = pickInt(req.body?.durationMin ?? req.body?.duration_min);
    const price_text = req.body?.price_text !== undefined ? String(req.body.price_text).trim() : undefined;
    const priority = pickInt(req.body?.priority);
    const enabled = pickBool(req.body?.enabled);

    const { rows } = await pool.query(
      `UPDATE signage_services
       SET
         name = COALESCE($2, name),
         category = COALESCE(NULLIF($3,''), category),
         duration_min = COALESCE($4, duration_min),
         price_text = COALESCE(NULLIF($5,''), price_text),
         priority = COALESCE($6, priority),
         enabled = COALESCE($7, enabled),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, category, duration_min, price_text, priority, enabled, created_at, updated_at`,
      [id, name, category, durationMin ?? null, price_text, priority, enabled]
    );

    if (!rows[0]) return res.status(404).json({ error: "not found" });
    const r: any = rows[0];
    res.json({
      service: {
        id: r.id,
        name: r.name,
        category: r.category ?? "",
        durationMin: r.duration_min ?? null,
        price_text: r.price_text ?? "",
        priority: Number(r.priority ?? 0),
        enabled: r.enabled === null ? true : !!r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update service" });
  }
});

router.delete("/services/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rowCount } = await pool.query("DELETE FROM signage_services WHERE id = $1", [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete service" });
  }
});

// ------------------------- DEALS -------------------------
router.get("/deals", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, title, subtitle, price_text, valid_from, valid_to, active, priority, created_at, updated_at
       FROM signage_deals
       ORDER BY priority DESC, updated_at DESC`
    );
    const deals = rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle ?? "",
      price_text: r.price_text ?? "",
      valid_from: r.valid_from ?? null,
      valid_to: r.valid_to ?? null,
      active: r.active === null ? true : !!r.active,
      priority: Number(r.priority ?? 0),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ deals });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list deals" });
  }
});

router.post("/deals", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const title = String(req.body?.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "title required" });

    const id = idOrNew(req.body?.id);
    const subtitle = String(req.body?.subtitle ?? "").trim();
    const price_text = String(req.body?.price_text ?? req.body?.priceText ?? "").trim();
    const valid_from = req.body?.valid_from ?? req.body?.validFrom ?? null;
    const valid_to = req.body?.valid_to ?? req.body?.validTo ?? null;
    const active = pickBool(req.body?.active) ?? true;
    const priority = pickInt(req.body?.priority) ?? 0;

    const { rows } = await pool.query(
      `INSERT INTO signage_deals (id, title, subtitle, price_text, valid_from, valid_to, active, priority)
       VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, $6, $7, $8)
       RETURNING id, title, subtitle, price_text, valid_from, valid_to, active, priority, created_at, updated_at`,
      [id, title, subtitle, price_text, valid_from, valid_to, active, priority]
    );

    res.json({ deal: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create deal" });
  }
});

router.put("/deals/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const id = req.params.id;

    const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined;
    const subtitle = req.body?.subtitle !== undefined ? String(req.body.subtitle).trim() : undefined;
    const price_text = req.body?.price_text !== undefined ? String(req.body.price_text).trim() : undefined;
    const valid_from = req.body?.valid_from ?? req.body?.validFrom ?? undefined;
    const valid_to = req.body?.valid_to ?? req.body?.validTo ?? undefined;
    const active = pickBool(req.body?.active);
    const priority = pickInt(req.body?.priority);

    const { rows } = await pool.query(
      `UPDATE signage_deals
       SET
         title = COALESCE(NULLIF($2,''), title),
         subtitle = COALESCE(NULLIF($3,''), subtitle),
         price_text = COALESCE(NULLIF($4,''), price_text),
         valid_from = COALESCE($5, valid_from),
         valid_to = COALESCE($6, valid_to),
         active = COALESCE($7, active),
         priority = COALESCE($8, priority),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, subtitle, price_text, valid_from, valid_to, active, priority, created_at, updated_at`,
      [id, title, subtitle, price_text, valid_from, valid_to, active, priority]
    );

    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json({ deal: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update deal" });
  }
});

router.delete("/deals/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rowCount } = await pool.query("DELETE FROM signage_deals WHERE id = $1", [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete deal" });
  }
});

// ------------------------- VIDEOS -------------------------
router.get("/videos", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, youtube_id, title, duration_sec, enabled, priority, created_at, updated_at
       FROM signage_videos
       ORDER BY priority DESC, updated_at DESC`
    );
    const videos = rows.map((r: any) => ({
      id: r.id,
      youtube_id: r.youtube_id,
      title: r.title ?? "",
      duration_sec: Number(r.duration_sec ?? 60),
      enabled: r.enabled === null ? true : !!r.enabled,
      priority: Number(r.priority ?? 0),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ videos });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list videos" });
  }
});

router.post("/videos", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const youtube_id = String(req.body?.youtube_id ?? req.body?.youtubeId ?? "").trim();
    if (!youtube_id) return res.status(400).json({ error: "youtube_id required" });

    const id = idOrNew(req.body?.id);
    const title = String(req.body?.title ?? "").trim();
    const duration_sec = pickInt(req.body?.duration_sec ?? req.body?.durationSec) ?? 60;
    const enabled = pickBool(req.body?.enabled) ?? true;
    const priority = pickInt(req.body?.priority) ?? 0;

    const { rows } = await pool.query(
      `INSERT INTO signage_videos (id, youtube_id, title, duration_sec, enabled, priority)
       VALUES ($1, $2, NULLIF($3,''), $4, $5, $6)
       RETURNING id, youtube_id, title, duration_sec, enabled, priority, created_at, updated_at`,
      [id, youtube_id, title, duration_sec, enabled, priority]
    );

    res.json({ video: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create video" });
  }
});

router.put("/videos/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const id = req.params.id;

    const youtube_id = req.body?.youtube_id !== undefined ? String(req.body.youtube_id).trim() : undefined;
    const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined;
    const duration_sec = pickInt(req.body?.duration_sec ?? req.body?.durationSec);
    const enabled = pickBool(req.body?.enabled);
    const priority = pickInt(req.body?.priority);

    const { rows } = await pool.query(
      `UPDATE signage_videos
       SET
         youtube_id = COALESCE(NULLIF($2,''), youtube_id),
         title = COALESCE(NULLIF($3,''), title),
         duration_sec = COALESCE($4, duration_sec),
         enabled = COALESCE($5, enabled),
         priority = COALESCE($6, priority),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, youtube_id, title, duration_sec, enabled, priority, created_at, updated_at`,
      [id, youtube_id, title, duration_sec, enabled, priority]
    );

    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json({ video: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update video" });
  }
});

router.delete("/videos/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rowCount } = await pool.query("DELETE FROM signage_videos WHERE id = $1", [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete video" });
  }
});

// ------------------------- QUOTES -------------------------
router.get("/quotes", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, text, author, enabled, priority, created_at, updated_at
       FROM signage_quotes
       ORDER BY priority DESC, updated_at DESC`
    );
    const quotes = rows.map((r: any) => ({
      id: r.id,
      text: r.text,
      author: r.author ?? "",
      enabled: r.enabled === null ? true : !!r.enabled,
      priority: Number(r.priority ?? 0),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ quotes });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list quotes" });
  }
});

router.post("/quotes", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const id = idOrNew(req.body?.id);
    const author = String(req.body?.author ?? "").trim();
    const enabled = pickBool(req.body?.enabled) ?? true;
    const priority = pickInt(req.body?.priority) ?? 0;

    const { rows } = await pool.query(
      `INSERT INTO signage_quotes (id, text, author, enabled, priority)
       VALUES ($1, $2, NULLIF($3,''), $4, $5)
       RETURNING id, text, author, enabled, priority, created_at, updated_at`,
      [id, text, author, enabled, priority]
    );

    res.json({ quote: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create quote" });
  }
});

router.put("/quotes/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const id = req.params.id;

    const text = req.body?.text !== undefined ? String(req.body.text).trim() : undefined;
    const author = req.body?.author !== undefined ? String(req.body.author).trim() : undefined;
    const enabled = pickBool(req.body?.enabled);
    const priority = pickInt(req.body?.priority);

    const { rows } = await pool.query(
      `UPDATE signage_quotes
       SET
         text = COALESCE(NULLIF($2,''), text),
         author = COALESCE(NULLIF($3,''), author),
         enabled = COALESCE($4, enabled),
         priority = COALESCE($5, priority),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, text, author, enabled, priority, created_at, updated_at`,
      [id, text, author, enabled, priority]
    );

    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json({ quote: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update quote" });
  }
});

router.delete("/quotes/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { rowCount } = await pool.query("DELETE FROM signage_quotes WHERE id = $1", [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete quote" });
  }
});

// ------------------------- PROFESSIONALS -------------------------
async function listProfessionals() {
  const { rows } = await pool.query(
    `SELECT id, name, title, note, photo_url, show, is_free, priority, created_at, updated_at
     FROM signage_professionals
     ORDER BY priority DESC, updated_at DESC`
  );
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    title: r.title ?? "",
    note: r.note ?? "",
    photo_url: r.photo_url ?? "",
    show: !!r.show,
    is_free: !!r.is_free,
    priority: Number(r.priority ?? 0),
    // legacy aliasok:
    enabled: !!r.show,
    available: !!r.is_free,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

async function createProfessional(req: Request, res: Response) {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });

  const id = idOrNew(req.body?.id);
  const title = String(req.body?.title ?? "").trim();
  const note = String(req.body?.note ?? "").trim();
  const photo_url = String(req.body?.photo_url ?? "").trim();

  const show = pickBool(req.body?.show) ?? pickBool(req.body?.enabled) ?? true;
  const is_free = pickBool(req.body?.is_free) ?? pickBool(req.body?.available) ?? true;
  const priority = pickInt(req.body?.priority) ?? 0;

  const { rows } = await pool.query(
    `INSERT INTO signage_professionals (id, name, title, note, photo_url, show, is_free, priority)
     VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6, $7, $8)
     RETURNING id, name, title, note, photo_url, show, is_free, priority, created_at, updated_at`,
    [id, name, title, note, photo_url, show, is_free, priority]
  );

  return res.json({ professional: rows[0] });
}

async function updateProfessional(req: Request, res: Response) {
  const id = req.params.id;

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
  const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined;
  const note = req.body?.note !== undefined ? String(req.body.note).trim() : undefined;
  const photo_url = req.body?.photo_url !== undefined ? String(req.body.photo_url).trim() : undefined;

  const show = pickBool(req.body?.show) ?? pickBool(req.body?.enabled);
  const is_free = pickBool(req.body?.is_free) ?? pickBool(req.body?.available);
  const priority = pickInt(req.body?.priority);

  const { rows } = await pool.query(
    `UPDATE signage_professionals
     SET
       name = COALESCE(NULLIF($2,''), name),
       title = COALESCE(NULLIF($3,''), title),
       note = COALESCE(NULLIF($4,''), note),
       photo_url = COALESCE(NULLIF($5,''), photo_url),
       show = COALESCE($6, show),
       is_free = COALESCE($7, is_free),
       priority = COALESCE($8, priority),
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, title, note, photo_url, show, is_free, priority, created_at, updated_at`,
    [id, name, title, note, photo_url, show, is_free, priority]
  );

  if (!rows[0]) return res.status(404).json({ error: "not found" });
  return res.json({ professional: rows[0] });
}

async function deleteProfessional(req: Request, res: Response) {
  const { rowCount } = await pool.query("DELETE FROM signage_professionals WHERE id = $1", [req.params.id]);
  return res.json({ ok: (rowCount ?? 0) > 0 });
}

router.get("/professionals", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    res.json({ professionals: await listProfessionals() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
  }
});

router.post("/professionals", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await createProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create professional" });
  }
});

router.put("/professionals/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await updateProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update professional" });
  }
});

router.delete("/professionals/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await deleteProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete professional" });
  }
});

// -------- Backward compat (régi front) --------
router.get("/", async (_req: Request, res: Response) => {
  try {
    await ensureTables();
    res.json({ professionals: await listProfessionals() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await createProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await updateProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await ensureTables();
    await deleteProfessional(req, res);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed" });
  }
});

export default router;
