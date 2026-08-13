import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { ensureProductTaxonomyReady, ensureProductTaxonomySchema } from "../inventory/ensureProductTaxonomy";
import { TAXONOMY_VERSION } from "../inventory/productTaxonomy";

const router = Router();

async function ensureReviewAudit() {
  await ensureProductTaxonomySchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_taxonomy_overrides (
      id bigserial PRIMARY KEY,
      product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      old_group_id uuid NULL,
      old_category_id uuid NULL,
      new_group_id uuid NOT NULL,
      new_category_id uuid NOT NULL,
      previous_source text NULL,
      previous_confidence numeric NULL,
      reviewed_by text NULL,
      review_note text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_taxonomy_overrides_product ON product_taxonomy_overrides(product_id, created_at DESC)`);
}

function thresholdFrom(req: AuthRequest) {
  const raw = Number(req.query.threshold ?? 0.6);
  if (!Number.isFinite(raw)) return 0.6;
  return Math.max(0, Math.min(1, raw));
}

router.get("/review", requireManagement, async (req: AuthRequest, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    await ensureReviewAudit();
    const threshold = thresholdFrom(req);
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const search = String(req.query.search || "").trim().toLowerCase();
    const mode = String(req.query.mode || "review").trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 250) || 250));

    const conditions: string[] = [];
    const params: any[] = [];
    if (!includeInactive) conditions.push("COALESCE(p.is_active,true)=true");
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        lower(COALESCE(p.name,'')) LIKE $${params.length}
        OR lower(COALESCE(p.internal_code,'')) LIKE $${params.length}
        OR lower(COALESCE(p.brand,'')) LIKE $${params.length}
        OR lower(COALESCE(p.line_name,'')) LIKE $${params.length}
        OR lower(COALESCE(p.source_category_name,'')) LIKE $${params.length}
      )`);
    }

    params.push(threshold);
    const thresholdRef = `$${params.length}`;
    const reviewPredicate = `(
      p.product_group_id IS NULL
      OR p.product_category_id IS NULL
      OR COALESCE(p.taxonomy_confidence,0) < ${thresholdRef}::numeric
      OR COALESCE(g.code,'') ILIKE '%OTHER%'
      OR COALESCE(c.code,'') ILIKE '%OTHER%'
      OR lower(COALESCE(g.name,'')) LIKE '%egyéb%'
      OR lower(COALESCE(c.name,'')) LIKE '%egyéb%'
    )`;
    if (mode === "review") conditions.push(reviewPredicate);
    if (mode === "unclassified") conditions.push("(p.product_group_id IS NULL OR p.product_category_id IS NULL)");
    if (mode === "fallback") conditions.push(`(
      COALESCE(g.code,'') ILIKE '%OTHER%'
      OR COALESCE(c.code,'') ILIKE '%OTHER%'
      OR lower(COALESCE(g.name,'')) LIKE '%egyéb%'
      OR lower(COALESCE(c.name,'')) LIKE '%egyéb%'
    )`);
    if (mode === "low") conditions.push(`COALESCE(p.taxonomy_confidence,0) < ${thresholdRef}::numeric`);

    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(`
      SELECT
        p.id,p.name,p.internal_code,p.barcode,p.brand,p.line_name,p.source_system,p.source_category_id,p.source_category_name,
        p.is_active,p.taxonomy_source,p.taxonomy_confidence,p.taxonomy_updated_at,
        p.product_group_id,g.name AS product_group_name,g.code AS product_group_code,g.product_type_code,g.product_type_name,
        p.product_category_id,c.name AS product_category_name,c.code AS product_category_code,
        CASE WHEN p.product_group_id IS NULL OR p.product_category_id IS NULL THEN true ELSE false END AS is_unclassified,
        CASE WHEN COALESCE(p.taxonomy_confidence,0) < ${thresholdRef}::numeric THEN true ELSE false END AS is_low_confidence,
        CASE WHEN COALESCE(g.code,'') ILIKE '%OTHER%' OR COALESCE(c.code,'') ILIKE '%OTHER%'
               OR lower(COALESCE(g.name,'')) LIKE '%egyéb%' OR lower(COALESCE(c.name,'')) LIKE '%egyéb%'
             THEN true ELSE false END AS is_fallback,
        (SELECT o.created_at FROM product_taxonomy_overrides o WHERE o.product_id=p.id ORDER BY o.created_at DESC LIMIT 1) AS last_manual_review_at
      FROM products p
      LEFT JOIN product_groups g ON g.id=p.product_group_id
      LEFT JOIN product_categories c ON c.id=p.product_category_id
      ${where}
      ORDER BY
        CASE WHEN p.product_group_id IS NULL OR p.product_category_id IS NULL THEN 0 ELSE 1 END,
        COALESCE(p.taxonomy_confidence,0),
        p.name
      LIMIT $${params.length}::int
    `, params);
    res.json({ taxonomy_version: TAXONOMY_VERSION, threshold, mode, count: rows.length, items: rows.map((r: any) => ({
      ...r,
      taxonomy_confidence: r.taxonomy_confidence == null ? null : Number(r.taxonomy_confidence),
    })) });
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült lekérdezni a taxonómia-felülvizsgálati listát.", detail: err?.message });
  }
});

router.get("/review/summary", requireManagement, async (req: AuthRequest, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const threshold = thresholdFrom(req);
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE COALESCE(is_active,true)=true)::int AS active,
        COUNT(*) FILTER (WHERE product_group_id IS NULL OR product_category_id IS NULL)::int AS unclassified,
        COUNT(*) FILTER (WHERE COALESCE(taxonomy_confidence,0) < $1::numeric)::int AS low_confidence,
        COUNT(*) FILTER (WHERE COALESCE(taxonomy_source,'')='manual')::int AS manual
      FROM products
    `, [threshold]);
    const fallback = await pool.query(`
      SELECT COUNT(p.id)::int AS fallback
      FROM products p
      LEFT JOIN product_groups g ON g.id=p.product_group_id
      LEFT JOIN product_categories c ON c.id=p.product_category_id
      WHERE COALESCE(g.code,'') ILIKE '%OTHER%' OR COALESCE(c.code,'') ILIKE '%OTHER%'
         OR lower(COALESCE(g.name,'')) LIKE '%egyéb%' OR lower(COALESCE(c.name,'')) LIKE '%egyéb%'
    `);
    const s = rows[0] || {};
    res.json({
      taxonomy_version: TAXONOMY_VERSION,
      threshold,
      total: Number(s.total || 0),
      active: Number(s.active || 0),
      unclassified: Number(s.unclassified || 0),
      low_confidence: Number(s.low_confidence || 0),
      fallback: Number(fallback.rows[0]?.fallback || 0),
      manual: Number(s.manual || 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült lekérdezni a taxonómia összesítést.", detail: err?.message });
  }
});

router.patch("/review/:id", requireManagement, async (req: AuthRequest, res: Response) => {
  let client: any = null;
  try {
    await ensureReviewAudit();
    client = await (pool as any).connect();
    await client.query("BEGIN");
    const groupId = String((req.body as any)?.product_group_id || "").trim();
    const categoryId = String((req.body as any)?.product_category_id || "").trim();
    const note = String((req.body as any)?.note || "").trim() || null;
    if (!groupId || !categoryId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "A termékcsoport és a kategória kötelező." });
    }
    const rel = await client.query(
      `SELECT c.id,c.product_group_id,g.name group_name,c.name category_name
       FROM product_categories c JOIN product_groups g ON g.id=c.product_group_id
       WHERE c.id=$1::uuid AND g.id=$2::uuid AND COALESCE(c.is_active,true)=true AND COALESCE(g.is_active,true)=true`,
      [categoryId, groupId],
    );
    if (!rel.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "A kiválasztott kategória nem ehhez a termékcsoporthoz tartozik, vagy inaktív." });
    }
    const current = await client.query(
      `SELECT id,product_group_id,product_category_id,taxonomy_source,taxonomy_confidence FROM products WHERE id=$1::uuid FOR UPDATE`,
      [req.params.id],
    );
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Termék nem található." });
    }
    const before = current.rows[0];
    const updated = await client.query(`
      UPDATE products SET product_group_id=$2::uuid,product_category_id=$3::uuid,
        taxonomy_source='manual',taxonomy_confidence=1,taxonomy_updated_at=now()
      WHERE id=$1::uuid
      RETURNING *
    `, [req.params.id, groupId, categoryId]);
    await client.query(`
      INSERT INTO product_taxonomy_overrides(
        product_id,old_group_id,old_category_id,new_group_id,new_category_id,
        previous_source,previous_confidence,reviewed_by,review_note)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::numeric,$8,$9)
    `, [
      req.params.id,
      before.product_group_id,
      before.product_category_id,
      groupId,
      categoryId,
      before.taxonomy_source,
      before.taxonomy_confidence,
      req.user?.email || String(req.user?.id || "") || null,
      note,
    ]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      product: {
        ...updated.rows[0],
        taxonomy_confidence: Number(updated.rows[0]?.taxonomy_confidence || 0),
        product_group_name: rel.rows[0].group_name,
        product_category_name: rel.rows[0].category_name,
      },
    });
  } catch (err: any) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    res.status(500).json({ error: "A kézi termékbesorolás mentése nem sikerült.", detail: err?.message });
  } finally {
    if (client) client.release();
  }
});

router.get("/review/:id/history", requireManagement, async (req: AuthRequest, res: Response) => {
  try {
    await ensureReviewAudit();
    const { rows } = await pool.query(`
      SELECT o.*,
        og.name AS old_group_name,oc.name AS old_category_name,
        ng.name AS new_group_name,nc.name AS new_category_name
      FROM product_taxonomy_overrides o
      LEFT JOIN product_groups og ON og.id=o.old_group_id
      LEFT JOIN product_categories oc ON oc.id=o.old_category_id
      LEFT JOIN product_groups ng ON ng.id=o.new_group_id
      LEFT JOIN product_categories nc ON nc.id=o.new_category_id
      WHERE o.product_id=$1::uuid
      ORDER BY o.created_at DESC
      LIMIT 100
    `, [req.params.id]);
    res.json({ items: rows });
  } catch (err: any) {
    res.status(500).json({ error: "A kézi besorolási előzmények lekérdezése nem sikerült.", detail: err?.message });
  }
});

export default router;
