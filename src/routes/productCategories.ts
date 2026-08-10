import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.product-categories"));

router.get("/", async (_req: Request, res: Response) => {
  try {
    const sql = `
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      ORDER BY c.sort_order, c.name
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("GET /product-categories hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a kategóriákat." });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.name || String(b.name).trim().length === 0) {
      return res.status(400).json({ error: "A kategória neve kötelező." });
    }
    if (!b.product_group_id) {
      return res.status(400).json({ error: "A termékcsoport kötelező." });
    }

    const sql = `
      INSERT INTO product_categories (
        product_group_id,
        name,
        code,
        sort_order,
        is_active
      )
      VALUES ($1,$2,$3,$4,COALESCE($5,true))
      RETURNING *
    `;

    const params = [
      b.product_group_id,
      String(b.name).trim(),
      b.code ?? null,
      b.sort_order ?? 100,
      b.is_active,
    ];

    const { rows } = await pool.query(sql, params);
    const saved = rows[0];

    const { rows: rows2 } = await pool.query(
      `
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      WHERE c.id = $1
      `,
      [saved.id]
    );

    res.status(201).json(rows2[0]);
  } catch (err) {
    console.error("POST /product-categories hiba:", err);
    res.status(500).json({ error: "Nem sikerült létrehozni a kategóriát." });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const add = (col: string, val: any) => {
      fields.push(`${col} = $${i}`);
      values.push(val);
      i++;
    };

    if (b.name !== undefined) add("name", b.name);
    if (b.code !== undefined) add("code", b.code);
    if (b.sort_order !== undefined) add("sort_order", b.sort_order);
    if (b.is_active !== undefined) add("is_active", b.is_active);
    if (b.product_group_id !== undefined)
      add("product_group_id", b.product_group_id || null);

    if (fields.length === 0) {
      return res.json({ message: "Nincs módosítandó mező." });
    }

    values.push(id);

    const sql = `
      UPDATE product_categories
      SET ${fields.join(", ")}
      WHERE id = $${i}
      RETURNING *
    `;

    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Kategória nem található." });
    }

    const saved = rows[0];

    const { rows: rows2 } = await pool.query(
      `
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      WHERE c.id = $1
      `,
      [saved.id]
    );

    res.json(rows2[0]);
  } catch (err) {
    console.error("PATCH /product-categories/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült módosítani a kategóriát." });
  }
});

export default router;
