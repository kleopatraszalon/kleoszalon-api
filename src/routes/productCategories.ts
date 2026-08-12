import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";
import { ensureProductTaxonomyReady } from "../inventory/ensureProductTaxonomy";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.product-categories"));

router.get("/", async (req: Request, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const sql = `
      SELECT
        c.*,
        g.name AS group_name,
        g.code AS group_code,
        g.product_type_code,
        g.product_type_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      WHERE ($1::boolean) OR COALESCE(c.is_active,true)=true
      ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),c.name
    `;
    const { rows } = await pool.query(sql, [includeInactive]);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /product-categories hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a kategóriákat.", detail: err?.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.name || String(b.name).trim().length === 0) return res.status(400).json({ error: "A kategória neve kötelező." });
    if (!b.product_group_id) return res.status(400).json({ error: "A termékcsoport kötelező." });

    const { rows } = await pool.query(`
      INSERT INTO product_categories(product_group_id,name,code,sort_order,is_active)
      VALUES ($1,$2,$3,$4,COALESCE($5,true))
      RETURNING *
    `, [b.product_group_id, String(b.name).trim(), b.code ?? null, b.sort_order ?? 100, b.is_active]);

    const saved = rows[0];
    const { rows: rows2 } = await pool.query(`
      SELECT c.*,g.name AS group_name,g.code AS group_code,g.product_type_code,g.product_type_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id=c.product_group_id
      WHERE c.id=$1
    `, [saved.id]);
    res.status(201).json(rows2[0]);
  } catch (err: any) {
    console.error("POST /product-categories hiba:", err);
    res.status(500).json({ error: "Nem sikerült létrehozni a kategóriát.", detail: err?.message });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const fields: string[] = [];
    const values: any[] = [];
    const add = (col: string, val: any) => {
      values.push(val);
      fields.push(`${col}=$${values.length}`);
    };
    if (b.name !== undefined) add("name", b.name);
    if (b.code !== undefined) add("code", b.code);
    if (b.sort_order !== undefined) add("sort_order", b.sort_order);
    if (b.is_active !== undefined) add("is_active", b.is_active);
    if (b.product_group_id !== undefined) add("product_group_id", b.product_group_id || null);
    if (!fields.length) return res.json({ message: "Nincs módosítandó mező." });

    values.push(id);
    const { rows } = await pool.query(`UPDATE product_categories SET ${fields.join(", ")} WHERE id=$${values.length} RETURNING *`, values);
    if (!rows[0]) return res.status(404).json({ error: "Kategória nem található." });

    const { rows: rows2 } = await pool.query(`
      SELECT c.*,g.name AS group_name,g.code AS group_code,g.product_type_code,g.product_type_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id=c.product_group_id
      WHERE c.id=$1
    `, [rows[0].id]);
    res.json(rows2[0]);
  } catch (err: any) {
    console.error("PATCH /product-categories/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült módosítani a kategóriát.", detail: err?.message });
  }
});

export default router;
