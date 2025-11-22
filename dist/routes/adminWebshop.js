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
        const safeOriginalName = file.originalname.replace(/\s+/g, "_");
        const ext = path_1.default.extname(safeOriginalName);
        const base = path_1.default.basename(safeOriginalName, ext);
        const unique = Date.now().toString(36);
        cb(null, `${base}-${unique}${ext}`);
    },
});
const upload = (0, multer_1.default)({ storage });
// =========================
//  HELPER FÜGGVÉNYEK
// =========================
function toNumber(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isNaN(n) ? null : n;
}
/**
 * Ha nincs product_group_id a kérésben, megpróbálunk
 * egy alapértelmezett csoportot választani.
 */
async function resolveProductGroupId(explicitGroupId) {
    if (explicitGroupId && String(explicitGroupId).trim() !== "") {
        return String(explicitGroupId).trim();
    }
    const result = await db_1.default.query(`SELECT id FROM product_groups ORDER BY id LIMIT 1`);
    const rows = result.rows;
    if (!rows.length) {
        throw new Error("Nincs elérhető termékcsoport (product_groups tábla üres).");
    }
    return rows[0].id;
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
        image_url,
        product_group_id,
        main_category,
        sub_category,
        service_category
      FROM products
      ORDER BY COALESCE(web_sort_order, 9999), name
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list products error:", err);
        return res.status(500).send("Hiba a termékek listázásakor.");
    }
});
/**
 * POST /api/admin/webshop/products
 * Új termék létrehozása.
 */
router.post("/products", async (req, res) => {
    try {
        const { name, retail_price_gross, sale_price, web_is_visible, is_retail, web_sort_order, web_description, product_group_id, main_category, sub_category, service_category, } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).send("A terméknév kötelező.");
        }
        const retailPrice = toNumber(retail_price_gross);
        const salePrice = toNumber(sale_price);
        const sortOrder = toNumber(web_sort_order);
        const visible = typeof web_is_visible === "boolean" ? web_is_visible : true;
        const retail = typeof is_retail === "boolean" ? is_retail : true;
        const resolvedGroupId = await resolveProductGroupId(product_group_id);
        const result = await db_1.default.query(`
      INSERT INTO products (
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        product_group_id,
        main_category,
        sub_category,
        service_category
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        image_url,
        product_group_id,
        main_category,
        sub_category,
        service_category
      `, [
            String(name).trim(),
            retailPrice,
            salePrice,
            visible,
            retail,
            sortOrder,
            web_description || null,
            resolvedGroupId,
            main_category || null,
            sub_category || null,
            service_category || null,
        ]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create product error:", err);
        if (err?.code === "23502") {
            // NOT NULL violation, pl. product_group_id
            return res
                .status(400)
                .send("Nem sikerült létrehozni a terméket: hiányzó kötelező mező (pl. product_group_id).");
        }
        return res.status(500).send("Hiba a termék létrehozásakor.");
    }
});
/**
 * PUT /api/admin/webshop/products/:id
 * Termék frissítése.
 */
router.put("/products/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, retail_price_gross, sale_price, web_is_visible, is_retail, web_sort_order, web_description, product_group_id, main_category, sub_category, service_category, } = req.body || {};
        const retailPrice = retail_price_gross !== undefined ? toNumber(retail_price_gross) : null;
        const salePrice = sale_price !== undefined ? toNumber(sale_price) : null;
        const sortOrder = web_sort_order !== undefined ? toNumber(web_sort_order) : null;
        const visible = typeof web_is_visible === "boolean" ? web_is_visible : null;
        const retail = typeof is_retail === "boolean" ? is_retail : null;
        const resolvedGroupId = product_group_id !== undefined
            ? await resolveProductGroupId(product_group_id)
            : null;
        const result = await db_1.default.query(`
      UPDATE products
      SET
        name = COALESCE($2, name),
        retail_price_gross = COALESCE($3, retail_price_gross),
        sale_price = COALESCE($4, sale_price),
        web_is_visible = COALESCE($5, web_is_visible),
        is_retail = COALESCE($6, is_retail),
        web_sort_order = COALESCE($7, web_sort_order),
        web_description = COALESCE($8, web_description),
        product_group_id = COALESCE($9, product_group_id),
        main_category = COALESCE($10, main_category),
        sub_category = COALESCE($11, sub_category),
        service_category = COALESCE($12, service_category)
      WHERE id = $1
      RETURNING
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        image_url,
        product_group_id,
        main_category,
        sub_category,
        service_category
      `, [
            id,
            name !== undefined ? String(name).trim() : null,
            retailPrice,
            salePrice,
            visible,
            retail,
            sortOrder,
            web_description !== undefined ? web_description : null,
            resolvedGroupId,
            main_category !== undefined ? main_category : null,
            sub_category !== undefined ? sub_category : null,
            service_category !== undefined ? service_category : null,
        ]);
        if (!result.rows.length) {
            return res.status(404).send("A termék nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update product error:", err);
        return res.status(500).send("Hiba a termék frissítésekor.");
    }
});
/**
 * DELETE /api/admin/webshop/products/:id
 * Termék törlése.
 */
router.delete("/products/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`DELETE FROM products WHERE id = $1 RETURNING id`, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A termék nem található.");
        }
        return res.json({ status: "ok" });
    }
    catch (err) {
        console.error("❌ Admin delete product error:", err);
        return res.status(500).send("Hiba a termék törlésekor.");
    }
});
/**
 * POST /api/admin/webshop/products/:id/image
 * Termékkép feltöltése.
 */
router.post("/products/:id/image", upload.single("file"), async (req, res) => {
    try {
        const { id } = req.params;
        const file = req.file;
        if (!file) {
            return res.status(400).send("Nem érkezett fájl.");
        }
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
        usage_count,
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
        0,
        COALESCE($10, true)
      )
      RETURNING *
      `, [
            String(code).trim().toUpperCase(),
            description || null,
            discount_type || null,
            toNumber(discount_value),
            toNumber(min_order_total),
            toNumber(max_discount_value),
            valid_from || null,
            valid_until || null,
            usage_limit !== undefined ? Number(usage_limit) : null,
            typeof is_active === "boolean" ? is_active : true,
        ]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create coupon error:", err);
        return res.status(500).send("Hiba a kupon létrehozásakor.");
    }
});
/**
 * PUT /api/admin/webshop/coupons/:id
 */
router.put("/coupons/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { description, discount_type, discount_value, min_order_total, max_discount_value, valid_from, valid_until, usage_limit, is_active, } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE coupons
      SET
        description = COALESCE($2, description),
        discount_type = COALESCE($3, discount_type),
        discount_value = COALESCE($4, discount_value),
        min_order_total = COALESCE($5, min_order_total),
        max_discount_value = COALESCE($6, max_discount_value),
        valid_from = COALESCE($7, valid_from),
        valid_until = COALESCE($8, valid_until),
        usage_limit = COALESCE($9, usage_limit),
        is_active = COALESCE($10, is_active)
      WHERE id = $1
      RETURNING *
      `, [
            id,
            description !== undefined ? description : null,
            discount_type !== undefined ? discount_type : null,
            discount_value !== undefined ? toNumber(discount_value) : null,
            min_order_total !== undefined ? toNumber(min_order_total) : null,
            max_discount_value !== undefined
                ? toNumber(max_discount_value)
                : null,
            valid_from !== undefined ? valid_from : null,
            valid_until !== undefined ? valid_until : null,
            usage_limit !== undefined ? Number(usage_limit) : null,
            typeof is_active === "boolean" ? is_active : null,
        ]);
        if (!result.rows.length) {
            return res.status(404).send("A kupon nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update coupon error:", err);
        return res.status(500).send("Hiba a kupon frissítésekor.");
    }
});
/**
 * DELETE /api/admin/webshop/coupons/:id
 */
router.delete("/coupons/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`DELETE FROM coupons WHERE id = $1 RETURNING id`, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A kupon nem található.");
        }
        return res.json({ status: "ok" });
    }
    catch (err) {
        console.error("❌ Admin delete coupon error:", err);
        return res.status(500).send("Hiba a kupon törlésekor.");
    }
});
// =========================
//  RENDELÉSEK
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
 * GET /api/admin/webshop/orders/:id
 */
router.get("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
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
        if (!result.rows.length) {
            return res.status(404).send("A rendelés nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin get order error:", err);
        return res.status(500).send("Hiba a rendelés betöltésekor.");
    }
});
/**
 * PUT /api/admin/webshop/orders/:id
 * (tipikusan státusz, fizetési státusz frissítése)
 */
router.put("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_status } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE webshop_orders
      SET
        status = COALESCE($2, status),
        payment_status = COALESCE($3, payment_status)
      WHERE id = $1
      RETURNING *
      `, [id, status || null, payment_status || null]);
        if (!result.rows.length) {
            return res.status(404).send("A rendelés nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update order error:", err);
        return res.status(500).send("Hiba a rendelés frissítésekor.");
    }
});
// =========================
//  SZÁMLÁK
// =========================
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
        amount_gross,
        currency,
        pdf_url,
        created_at
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
 * GET /api/admin/webshop/invoices/:id
 */
router.get("/invoices/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url,
        created_at
      FROM webshop_invoices
      WHERE id = $1
      `, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A számla nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin get invoice error:", err);
        return res.status(500).send("Hiba a számla betöltésekor.");
    }
});
/**
 * POST /api/admin/webshop/invoices
 * Egyszerű számlarögzítés (külső számlázó után).
 */
router.post("/invoices", async (req, res) => {
    try {
        const { invoice_number, order_id, amount_gross, currency, pdf_url } = req.body || {};
        if (!invoice_number || !order_id) {
            return res
                .status(400)
                .send("Számlaszám és rendelés azonosító kötelező.");
        }
        const result = await db_1.default.query(`
      INSERT INTO webshop_invoices (
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `, [
            String(invoice_number).trim(),
            order_id,
            toNumber(amount_gross),
            currency || "HUF",
            pdf_url || null,
        ]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create invoice error:", err);
        return res.status(500).send("Hiba a számla létrehozásakor.");
    }
});
/**
 * PUT /api/admin/webshop/invoices/:id
 */
router.put("/invoices/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { invoice_number, amount_gross, currency, pdf_url } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE webshop_invoices
      SET
        invoice_number = COALESCE($2, invoice_number),
        amount_gross = COALESCE($3, amount_gross),
        currency = COALESCE($4, currency),
        pdf_url = COALESCE($5, pdf_url)
      WHERE id = $1
      RETURNING *
      `, [
            id,
            invoice_number !== undefined
                ? String(invoice_number).trim()
                : null,
            amount_gross !== undefined ? toNumber(amount_gross) : null,
            currency !== undefined ? currency : null,
            pdf_url !== undefined ? pdf_url : null,
        ]);
        if (!result.rows.length) {
            return res.status(404).send("A számla nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update invoice error:", err);
        return res.status(500).send("Hiba a számla frissítésekor.");
    }
});
exports.default = router;
