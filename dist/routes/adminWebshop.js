"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// =========================
//  FÁJL FELTÖLTÉS BEÁLLÍTÁS
// =========================
const uploadDir = path_1.default.join(__dirname, "..", "..", "uploads", "products");
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
        const safeOriginalName = String(file.originalname || "file").replace(/[^a-zA-Z0-9_.-]/g, "_");
        const uniqueName = `${Date.now()}_${safeOriginalName}`;
        cb(null, uniqueName);
    },
});
const upload = (0, multer_1.default)({ storage });
// Szám konverzió helper
function toNumber(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isNaN(n) ? null : n;
}
// =========================
//  TERMÉKEK
// =========================
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
 * POST /api/admin/webshop/products
 * Új termék felvitele webshophoz.
 *
 * Itt biztosítjuk, hogy legyen érvényes product_group_id ÉS unit_id,
 * mert a products táblában ezek NOT NULL.
 */
router.post("/products", async (req, res) => {
    try {
        const { name, retail_price_gross, sale_price, web_is_visible, is_retail, web_sort_order, web_description, product_group_id, unit_id, } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).send("A terméknév kötelező.");
        }
        const retailPrice = toNumber(retail_price_gross);
        const salePrice = toNumber(sale_price);
        const sortOrder = toNumber(web_sort_order);
        const visible = typeof web_is_visible === "boolean" ? web_is_visible : true;
        const retail = typeof is_retail === "boolean" ? is_retail : true;
        // Biztosítjuk a kötelező product_group_id és unit_id értékeket
        let groupId = product_group_id || null;
        let unitId = unit_id || null;
        // Ha nincs a body-ban megadva, kérjük le az első létezőt
        if (!groupId) {
            const groupResult = await db_1.default.query(`SELECT id FROM product_groups ORDER BY id LIMIT 1`);
            groupId = groupResult.rows[0]?.id ?? null;
        }
        if (!unitId) {
            const unitResult = await db_1.default.query(`SELECT id FROM units ORDER BY id LIMIT 1`);
            unitId = unitResult.rows[0]?.id ?? null;
        }
        if (!groupId || !unitId) {
            console.error("❌ Admin create product error: nincs elérhető product_group vagy unit a beszúráshoz.");
            return res
                .status(500)
                .send("Nem található alapértelmezett termékcsoport vagy mértékegység (unit).");
        }
        const result = await db_1.default.query(`
      INSERT INTO products (
        product_group_id,
        unit_id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        image_url
      `, [
            groupId,
            unitId,
            String(name).trim(),
            retailPrice,
            salePrice,
            visible,
            retail,
            sortOrder,
            web_description || null,
        ]);
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create product error:", err);
        return res.status(500).send("Hiba az új termék létrehozásakor.");
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
            name ?? null,
            toNumber(retail_price_gross),
            toNumber(sale_price),
            web_is_visible,
            is_retail,
            toNumber(web_sort_order),
            web_description ?? null,
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
 * Kép feltöltése egy termékhez (form-data: file)
 */
router.post("/products/:id/image", upload.single("file"), async (req, res) => {
    try {
        const { id } = req.params;
        const file = req.file;
        if (!file) {
            return res.status(400).send("Nem érkezett fájl.");
        }
        const publicUrl = `/uploads/products/${file.filename}`;
        await db_1.default.query(`UPDATE products SET image_url = $2 WHERE id = $1`, [
            id,
            publicUrl,
        ]);
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
// =========================
//  KUPONOK
// =========================
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
 */
router.post("/coupons", async (req, res) => {
    try {
        const { code, description, discount_type, discount_value, min_order_total, max_discount_value, valid_from, valid_until, usage_limit, is_active, } = req.body || {};
        if (!code || !discount_value) {
            return res
                .status(400)
                .send("Kuponkód és kedvezmény értéke kötelező.");
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
      VALUES (
        $1,
        $2,
        COALESCE($3, 'percent'),
        $4,
        COALESCE($5, 0),
        $6,
        $7,
        $8,
        $9,
        COALESCE($10, true)
      )
      RETURNING *
      `, [
            String(code).trim().toUpperCase(),
            description || null,
            discount_type || "percent",
            toNumber(discount_value),
            toNumber(min_order_total) ?? 0,
            toNumber(max_discount_value),
            valid_from || null,
            valid_until || null,
            usage_limit ? Number(usage_limit) : null,
            is_active,
        ]);
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create coupon error:", err);
        return res.status(500).send("Hiba a kupon létrehozásakor.");
    }
});
// =========================
//  RENDELÉSEK & SZÁMLÁK
// =========================
/**
 * GET /api/admin/webshop/orders
 */
router.get("/orders", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
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
      ORDER BY created_at DESC
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list orders error:", err);
        return res.status(500).send("Hiba a rendelések listázásakor.");
    }
});
/**
 * PATCH /api/admin/webshop/orders/:id
 * Rendelés státusz / fizetési státusz frissítése
 */
router.patch("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_status } = req.body || {};
        await db_1.default.query(`
      UPDATE webshop_orders
      SET
        status = COALESCE($2, status),
        payment_status = COALESCE($3, payment_status)
      WHERE id = $1
      `, [id, status ?? null, payment_status ?? null]);
        const result = await db_1.default.query(`
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
      WHERE id = $1
      `, [id]);
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update order error:", err);
        return res.status(500).send("Hiba a rendelés frissítésekor.");
    }
});
/**
 * GET /api/admin/webshop/invoices
 */
router.get("/invoices", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        customer_name,
        customer_tax_number,
        total_gross,
        currency,
        status,
        created_at,
        payment_due_date,
        payment_method
      FROM webshop_invoices
      ORDER BY created_at DESC
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list invoices error:", err);
        return res.status(500).send("Hiba a számlák listázásakor.");
    }
});
/**
 * PATCH /api/admin/webshop/invoices/:id
 */
router.patch("/invoices/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body || {};
        await db_1.default.query(`
      UPDATE webshop_invoices
      SET status = COALESCE($2, status)
      WHERE id = $1
      `, [id, status ?? null]);
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        customer_name,
        customer_tax_number,
        total_gross,
        currency,
        status,
        created_at,
        payment_due_date,
        payment_method
      FROM webshop_invoices
      WHERE id = $1
      `, [id]);
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update invoice error:", err);
        return res.status(500).send("Hiba a számla frissítésekor.");
    }
});
exports.default = router;
