"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const db_1 = __importDefault(require("../db")); // ha nálad { pool } az export, akkor írd át
const router = (0, express_1.Router)();
/**
 * Fájlok feltöltési helye: /uploads/products
 * A server.ts-ben legyen:
 *   app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
 */
const uploadDir = path_1.default.join(__dirname, "..", "..", "uploads", "products");
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer_1.default.diskStorage({
    destination(_req, _file, cb) {
        cb(null, uploadDir);
    },
    filename(_req, file, cb) {
        const ext = path_1.default.extname(file.originalname || "");
        const base = path_1.default.basename(file.originalname || "", ext);
        const safeBase = base.replace(/[^a-zA-Z0-9_-]+/g, "_");
        const ts = Date.now();
        cb(null, `${safeBase}_${ts}${ext || ".jpg"}`);
    },
});
const upload = (0, multer_1.default)({ storage });
/**
 * GET /api/admin/webshop/products
 * Összes termék, admin nézetben.
 */
router.get("/products", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
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
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin webshop products error:", err);
        return res.status(500).send("Hiba a termékek listázásakor.");
    }
});
/**
 * PUT /api/admin/webshop/products/:id
 * Termék webshop mezők frissítése
 */
router.put("/products/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, retail_price_gross, sale_price, web_is_visible, is_retail, web_sort_order, web_description, } = req.body || {};
        await db_1.default.query(`
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
      `, [
            id,
            name,
            retail_price_gross,
            sale_price,
            web_is_visible,
            is_retail,
            web_sort_order,
            web_description,
        ]);
        return res.json({ status: "ok" });
    }
    catch (err) {
        console.error("❌ Admin update product error:", err);
        return res.status(500).send("Hiba a termék frissítésekor.");
    }
});
/**
 * POST /api/admin/webshop/products/:id/image
 * Kép feltöltése egy termékhez
 * form-data: file
 */
router.post("/products/:id/image", upload.single("file"), async (req, res) => {
    try {
        const { id } = req.params;
        // Nem használunk Express.Multer típust, hogy ne kelljen TS-nek a namespace
        const file = req.file;
        if (!file) {
            return res.status(400).send("Nem érkezett fájl.");
        }
        // A frontend a /uploads/...-t fogja használni
        const publicUrl = `/uploads/products/${file.filename}`;
        await db_1.default.query(`UPDATE products SET image_url = $2 WHERE id = $1`, [id, publicUrl]);
        return res.json({
            status: "ok",
            image_url: publicUrl,
        });
    }
    catch (err) {
        console.error("❌ Admin upload product image error:", err);
        return res.status(500).send("Hiba a kép feltöltésekor.");
    }
});
/**
 * GET /api/admin/webshop/coupons
 */
router.get("/coupons", async (_req, res) => {
    try {
        const result = await db_1.default.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list coupons error:", err);
        return res.status(500).send("Hiba a kuponok listázásakor.");
    }
});
/**
 * POST /api/admin/webshop/coupons
 * Új kupon létrehozása
 */
router.post("/coupons", async (req, res) => {
    try {
        const { code, description, discount_type, discount_value, min_order_total, max_discount_value, valid_from, valid_until, usage_limit, is_active, } = req.body || {};
        if (!code || !discount_type || discount_value == null) {
            return res
                .status(400)
                .send("Kuponkód, kedvezmény típusa és értéke kötelező.");
        }
        const result = await db_1.default.query(`
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
      `, [
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
        ]);
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create coupon error:", err);
        return res.status(500).send("Hiba a kupon létrehozásakor.");
    }
});
exports.default = router;
