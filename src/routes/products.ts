import { Router, Request, Response } from "express";
import pool from "../db"; // ugyanaz, mint a többi route-ban!

const router = Router();

type ProductRow = {
  id: string;
  name: string;
  internal_code: string | null;
  barcode: string | null;
  brand: string | null;
  line_name: string | null;
  product_group_id: string | null;
  product_category_id: string | null;
  base_unit_id: string | null;
  package_size: number | null;
  vat_rate: number | null;
  purchase_price_net: number | null;
  retail_price_gross: number | null;
  is_active: boolean | null;
  is_service_material: boolean | null;
  is_retail: boolean | null;
  is_cleaning: boolean | null;
  is_hospitality: boolean | null;
  is_merchandise: boolean | null;
  size_label: string | null;
  color_text: string | null;
  target_gender: string | null;
  product_group_name?: string | null;
  product_category_name?: string | null;
};

function mapRowToProduct(row: any): ProductRow {
  return {
    id: row.id,
    name: row.name,
    internal_code: row.internal_code,
    barcode: row.barcode,
    brand: row.brand,
    line_name: row.line_name,
    product_group_id: row.product_group_id,
    product_category_id: row.product_category_id,
    base_unit_id: row.base_unit_id,
    package_size: row.package_size,
    vat_rate: row.vat_rate,
    purchase_price_net: row.purchase_price_net,
    retail_price_gross: row.retail_price_gross,
    is_active: row.is_active,
    is_service_material: row.is_service_material,
    is_retail: row.is_retail,
    is_cleaning: row.is_cleaning,
    is_hospitality: row.is_hospitality,
    is_merchandise: row.is_merchandise,
    size_label: row.size_label,
    color_text: row.color_text,
    target_gender: row.target_gender,
    product_group_name: row.product_group_name,
    product_category_name: row.product_category_name,
  };
}

/**
 * GET /api/products
 * ?include_inactive=1 → inaktívak is
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const includeInactive =
      String(req.query.include_inactive || "") === "1";

    let where = "WHERE 1=1";
    if (!includeInactive) {
      where += " AND p.is_active = true";
    }

    const sql = `
      SELECT
        p.*,
        pg.name AS product_group_name,
        pc.name AS product_category_name
      FROM products p
      LEFT JOIN product_groups pg ON pg.id = p.product_group_id
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      ${where}
      ORDER BY p.name ASC
    `;

    const { rows } = await pool.query(sql);
    res.json(rows.map(mapRowToProduct));
  } catch (err) {
    console.error("GET /products hiba:", err);
    res
      .status(500)
      .json({ error: "Nem sikerült lekérdezni a termékeket." });
  }
});

/**
 * GET /api/products/:id
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT
        p.*,
        pg.name AS product_group_name,
        pc.name AS product_category_name
      FROM products p
      LEFT JOIN product_groups pg ON pg.id = p.product_group_id
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id = $1
      LIMIT 1
    `;

    const { rows } = await pool.query(sql, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Termék nem található." });
    }

    res.json(mapRowToProduct(rows[0]));
  } catch (err) {
    console.error("GET /products/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a terméket." });
  }
});

/**
 * POST /api/products
 * Új termék
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.name || String(b.name).trim().length === 0) {
      return res.status(400).json({ error: "A termék neve kötelező." });
    }

    const sql = `
      INSERT INTO products (
        name,
        internal_code,
        barcode,
        brand,
        line_name,
        product_group_id,
        product_category_id,
        purchase_price_net,
        retail_price_gross,
        vat_rate,
        size_label,
        color_text,
        target_gender,
        is_active,
        is_service_material,
        is_retail,
        is_cleaning,
        is_hospitality,
        is_merchandise
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,
        $11,$12,$13,
        COALESCE($14,true),
        COALESCE($15,false),
        COALESCE($16,true),
        COALESCE($17,false),
        COALESCE($18,false),
        COALESCE($19,false)
      )
      RETURNING *
    `;

    const params = [
      String(b.name).trim(),
      b.internal_code ?? null,
      b.barcode ?? null,
      b.brand ?? null,
      b.line_name ?? null,
      b.product_group_id || null,
      b.product_category_id || null,
      b.purchase_price_net ?? null,
      b.retail_price_gross ?? null,
      b.vat_rate ?? null,
      b.size_label ?? null,
      b.color_text ?? null,
      b.target_gender ?? null,
      b.is_active,
      b.is_service_material,
      b.is_retail,
      b.is_cleaning,
      b.is_hospitality,
      b.is_merchandise,
    ];

    const { rows } = await pool.query(sql, params);
    const created = rows[0];

    const { rows: rows2 } = await pool.query(
      `
      SELECT
        p.*,
        pg.name AS product_group_name,
        pc.name AS product_category_name
      FROM products p
      LEFT JOIN product_groups pg ON pg.id = p.product_group_id
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id = $1
      `,
      [created.id]
    );

    res.status(201).json(mapRowToProduct(rows2[0]));
  } catch (err) {
    console.error("POST /products hiba:", err);
    res.status(500).json({ error: "Nem sikerült létrehozni a terméket." });
  }
});

/**
 * PATCH /api/products/:id
 * Termék módosítás
 */
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
    if (b.internal_code !== undefined) add("internal_code", b.internal_code);
    if (b.barcode !== undefined) add("barcode", b.barcode);
    if (b.brand !== undefined) add("brand", b.brand);
    if (b.line_name !== undefined) add("line_name", b.line_name);
    if (b.product_group_id !== undefined)
      add("product_group_id", b.product_group_id || null);
    if (b.product_category_id !== undefined)
      add("product_category_id", b.product_category_id || null);
    if (b.purchase_price_net !== undefined)
      add("purchase_price_net", b.purchase_price_net);
    if (b.retail_price_gross !== undefined)
      add("retail_price_gross", b.retail_price_gross);
    if (b.vat_rate !== undefined) add("vat_rate", b.vat_rate);
    if (b.size_label !== undefined) add("size_label", b.size_label);
    if (b.color_text !== undefined) add("color_text", b.color_text);
    if (b.target_gender !== undefined) add("target_gender", b.target_gender);
    if (b.is_active !== undefined) add("is_active", b.is_active);
    if (b.is_service_material !== undefined)
      add("is_service_material", b.is_service_material);
    if (b.is_retail !== undefined) add("is_retail", b.is_retail);
    if (b.is_cleaning !== undefined) add("is_cleaning", b.is_cleaning);
    if (b.is_hospitality !== undefined)
      add("is_hospitality", b.is_hospitality);
    if (b.is_merchandise !== undefined)
      add("is_merchandise", b.is_merchandise);

    if (fields.length === 0) {
      return res.json({ message: "Nincs módosítandó mező." });
    }

    values.push(id);
    const sql = `
      UPDATE products
      SET ${fields.join(", ")}
      WHERE id = $${i}
      RETURNING *
    `;

    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Termék nem található." });
    }

    const updated = rows[0];

    const { rows: rows2 } = await pool.query(
      `
      SELECT
        p.*,
        pg.name AS product_group_name,
        pc.name AS product_category_name
      FROM products p
      LEFT JOIN product_groups pg ON pg.id = p.product_group_id
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id = $1
      `,
      [updated.id]
    );

    res.json(mapRowToProduct(rows2[0]));
  } catch (err) {
    console.error("PATCH /products/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült módosítani a terméket." });
  }
});

/**
 * POST /api/products/bulk-import
 * { items: [{ name, internal_code, barcode, brand, product_group_name, product_category_name, retail_price_gross }] }
 */
router.post("/bulk-import", async (req: Request, res: Response) => {
  try {
    const items = (req.body && (req.body as any).items) || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Nincs importálható adat (items)." });
    }

    const { rows: groupRows } = await pool.query(
      "SELECT id, name, code FROM product_groups"
    );
    const { rows: catRows } = await pool.query(
      "SELECT id, name, product_group_id FROM product_categories"
    );

    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const name = String(item.name || "").trim();
      if (!name) {
        errors.push(`Sor ${i + 1}: név hiányzik, kihagyva.`);
        continue;
      }

      let groupId: string | null = null;
      if (item.product_group_name) {
        const gname = String(item.product_group_name).toLowerCase();
        const g = groupRows.find(
          (gr: any) =>
            String(gr.name).toLowerCase() === gname ||
            String(gr.code || "").toLowerCase() === gname
        );
        groupId = g ? g.id : null;
      }

      let categoryId: string | null = null;
      if (item.product_category_name) {
        const cname = String(item.product_category_name).toLowerCase();
        const match = catRows.find(
          (cr: any) => String(cr.name).toLowerCase() === cname
        );
        categoryId = match ? match.id : null;
      }

      const sql = `
        INSERT INTO products (
          name,
          internal_code,
          barcode,
          brand,
          product_group_id,
          product_category_id,
          retail_price_gross,
          is_active
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,true)
      `;

      try {
        await pool.query(sql, [
          name,
          item.internal_code || null,
          item.barcode || null,
          item.brand || null,
          groupId,
          categoryId,
          item.retail_price_gross ?? null,
        ]);
        created++;
      } catch (e: any) {
        console.error("Bulk import sor hiba:", e);
        errors.push(`Sor ${i + 1}: "${name}" mentése nem sikerült.`);
      }
    }

    res.json({
      message: `Import kész. Létrehozva: ${created} db termék.`,
      errors,
    });
  } catch (err) {
    console.error("POST /products/bulk-import hiba:", err);
    res.status(500).json({ error: "Bulk import közben hiba történt." });
  }
});

export default router;
