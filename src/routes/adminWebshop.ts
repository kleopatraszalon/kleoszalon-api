import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import multer, { StorageEngine } from "multer";
import pool from "../db"; // ha nálad { pool } az export, akkor írd át

const router = Router();

/**
 * Fájlok feltöltési helye: /uploads/products
 * A server.ts-ben legyen:
 *   app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
 */
const uploadDir = path.join(__dirname, "..", "..", "uploads", "products");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage: StorageEngine = multer.diskStorage({
  destination(
    _req: Request,
    _file: Express.Multer.File,
    cb: (error: Error | null, destination: string) => void
  ) {
    cb(null, uploadDir);
  },
  filename(
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, filename: string) => void
  ) {
    const ext = path.extname(file.originalname || "");
    const base = path.basename(file.originalname || "", ext);
    const safeBase = base.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const ts = Date.now();
    cb(null, `${safeBase}_${ts}${ext || ".jpg"}`);
  },
});

const upload = multer({ storage });

/**
 * GET /api/admin/webshop/products
 * Összes termék, admin nézetben.
 */
router.get("/products", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        image_url
      FROM products
      ORDER BY COALESCE(web_sort_order, 9999), name
      `
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("❌ Admin webshop products error:", err);
    return res.status(500).send("Hiba a termékek listázásakor.");
  }
});

/**
 * PUT /api/admin/webshop/products/:id
 * Termék webshop mezők frissítése
 */
router.put("/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      retail_price_gross,
      sale_price,
      web_is_visible,
      is_retail,
      web_sort_order,
      web_description,
    } = req.body || {};

    await pool.query(
      `
      UPDATE products
      SET
        name = COALESCE($2, name),
        retail_price_gross = COALESCE($3, retail_price_gross),
        sale_price = COALESCE($4, sale_price),
        web_is_visible = COALESCE($5, web_is_visible),
        is_retail = COALESCE($6, is_retail),
        web_sort_order = COALESCE($7, web_sort_order),
        web_description = COALESCE($8, web_description)
      WHERE id = $1
      `,
      [
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
      ]
    );

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ Admin update product error:", err);
    return res.status(500).send("Hiba a termék frissítésekor.");
  }
});

/**
 * POST /api/admin/webshop/products/:id/image
 * Kép feltöltése egy termékhez
 * form-data: file
 */
router.post(
  "/products/:id/image",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Nem használunk Express.Multer típust, hogy ne kelljen TS-nek a namespace
      const file = (req as any).file as { filename: string } | undefined;

      if (!file) {
        return res.status(400).send("Nem érkezett fájl.");
      }

      // A frontend a /uploads/...-t fogja használni
      const publicUrl = `/uploads/products/${file.filename}`;

      await pool.query(
        `UPDATE products SET image_url = $2 WHERE id = $1`,
        [id, publicUrl]
      );

      return res.json({
        status: "ok",
        image_url: publicUrl,
      });
    } catch (err) {
      console.error("❌ Admin upload product image error:", err);
      return res.status(500).send("Hiba a kép feltöltésekor.");
    }
  }
);

/**
 * GET /api/admin/webshop/coupons
 */
router.get("/coupons", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM coupons ORDER BY created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("❌ Admin list coupons error:", err);
    return res.status(500).send("Hiba a kuponok listázásakor.");
  }
});

/**
 * POST /api/admin/webshop/coupons
 * Új kupon létrehozása
 */
router.post("/coupons", async (req: Request, res: Response) => {
  try {
    const {
      code,
      description,
      discount_type,
      discount_value,
      min_order_total,
      max_discount_value,
      valid_from,
      valid_until,
      usage_limit,
      is_active,
    } = req.body || {};

    if (!code || !discount_type || discount_value == null) {
      return res
        .status(400)
        .send("Kuponkód, kedvezmény típusa és értéke kötelező.");
    }

    const result = await pool.query(
      `
      INSERT INTO coupons (
        code,
        description,
        discount_type,
        discount_value,
        min_order_total,
        max_discount_value,
        valid_from,
        valid_until,
        usage_limit,
        is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, true))
      RETURNING *
      `,
      [
        String(code).toUpperCase(),
        description || null,
        discount_type,
        discount_value,
        min_order_total || 0,
        max_discount_value || null,
        valid_from || null,
        valid_until || null,
        usage_limit || null,
        is_active,
      ]
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Admin create coupon error:", err);
    return res.status(500).send("Hiba a kupon létrehozásakor.");
  }
});
/**
 * GET /api/admin/webshop/orders
 * Rendelések listája (egyszerű lista, opcionális státusz szűrővel)
 */
router.get("/orders", async (req: Request, res: Response) => {
  try {
    const { status, payment_status } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (payment_status) {
      params.push(payment_status);
      conditions.push(`payment_status = $${params.length}`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const query = `
      SELECT
        id,
        created_at,
        customer_full_name,
        customer_email,
        customer_phone,
        subtotal_gross,
        discount_gross,
        total_gross,
        currency,
        payment_method,
        status,
        payment_status,
        coupon_code
      FROM webshop_orders
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `;

    const result = await pool.query(query, params);

    return res.json(result.rows);
  } catch (err) {
    console.error("❌ Admin list orders error:", err);
    return res.status(500).send("Hiba a rendelések listázásakor.");
  }
});

/**
 * GET /api/admin/webshop/orders/:id
 * Egy rendelés részletei (items_json is)
 */
router.get("/orders/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM webshop_orders
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Rendelés nem található.");
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Admin get order error:", err);
    return res.status(500).send("Hiba a rendelés betöltésekor.");
  }
});

/**
 * PATCH /api/admin/webshop/orders/:id
 * Rendelés státuszainak / belső mezőknek frissítése
 *
 * Body: { status?, payment_status?, internal_note?, shipping_tracking? }
 */
router.patch("/orders/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, payment_status, internal_note, shipping_tracking } =
      req.body || {};

    const fields: string[] = [];
    const params: any[] = [];

    if (status) {
      params.push(status);
      fields.push(`status = $${params.length}`);
    }
    if (payment_status) {
      params.push(payment_status);
      fields.push(`payment_status = $${params.length}`);
    }
    if (internal_note !== undefined) {
      params.push(internal_note);
      fields.push(`internal_note = $${params.length}`);
    }
    if (shipping_tracking !== undefined) {
      params.push(shipping_tracking);
      fields.push(`shipping_tracking = $${params.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).send("Nincs frissítendő mező.");
    }

    params.push(id);
    const query = `
      UPDATE webshop_orders
      SET ${fields.join(", ")},
          updated_at = now()
      WHERE id = $${params.length}
      RETURNING *
    `;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).send("Rendelés nem található.");
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Admin update order error:", err);
    return res.status(500).send("Hiba a rendelés frissítésekor.");
  }
});


export default router;
