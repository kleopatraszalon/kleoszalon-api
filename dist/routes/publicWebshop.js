"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = __importDefault(require("../db")); // ha nálad export { pool }, akkor írd át
const router = (0, express_1.Router)();
// Helper – JSON-biztos numerikus konverzió
function toNumber(value) {
    if (value == null)
        return 0;
    if (typeof value === "number")
        return value;
    const n = parseFloat(String(value).replace(",", "."));
    return Number.isNaN(n) ? 0 : n;
}
/**
 * GET /api/public/webshop/products
 * Csak azokat a termékeket listázza, amelyek webshopban eladhatók.
 */
router.get("/products", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        name,
        retail_price_gross,
        sale_price,
        image_url,
        web_description,
        is_retail,
        web_is_visible,
        main_category,
        sub_category,
        service_category
      FROM products
      WHERE is_retail = true
        AND web_is_visible = true
      ORDER BY COALESCE(web_sort_order, 9999), name
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Webshop products error:", err);
        return res.status(500).send("Hiba a webshop termékek betöltésekor.");
    }
});
/**
 * GET /api/public/webshop/products/:productId
 * Egy konkrét termék adatainak lekérése a webshophoz.
 */
router.get("/products/:productId", async (req, res) => {
    try {
        const { productId } = req.params;
        const result = await db_1.default.query(`
      SELECT
        id,
        name,
        retail_price_gross,
        sale_price,
        image_url,
        web_description,
        is_retail,
        web_is_visible,
        main_category,
        sub_category,
        service_category
      FROM products
      WHERE id = $1
      LIMIT 1
      `, [productId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Termék nem található." });
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Webshop product detail error:", err);
        return res.status(500).send("Hiba a webshop termék betöltésekor.");
    }
});
/**
 * GET /api/public/webshop/products/:productId/reviews
 * Jóváhagyott vélemények listája egy termékhez.
 */
router.get("/products/:productId/reviews", async (req, res) => {
    const { productId } = req.params;
    if (!productId) {
        return res.status(400).json({ error: "Hiányzik a productId." });
    }
    try {
        const result = await db_1.default.query(`
        SELECT
          id,
          product_id,
          rating,
          text,
          author_name,
          created_at
        FROM product_reviews
        WHERE product_id = $1
        ORDER BY created_at DESC
        `, [productId]);
        // Ha nincs vélemény, üres listát adunk vissza – ez nem hiba.
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Webshop product reviews error:", err);
        return res
            .status(500)
            .json({ error: "Hiba történt a termék véleményeinek betöltésekor." });
    }
});
/**
 router.get(
  "/products/:productId/reviews",
  async (req: Request, res: Response) => {
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({ error: "Hiányzik a productId." });
    }

    try {
      const result = await pool.query(
        `
        SELECT
          id,
          product_id,
          rating,
          text,
          author_name,
          created_at
        FROM product_reviews
        WHERE product_id = $1
        ORDER BY created_at DESC
        `,
        [productId]
      );

      // Ha nincs vélemény, üres listát adunk vissza – ez nem hiba.
      return res.json(result.rows);
    } catch (err) {
      console.error("❌ Webshop product reviews error:", err);
      return res
        .status(500)
        .json({ error: "Hiba történt a termék véleményeinek betöltésekor." });
    }
  }
);

/**
 * POST /api/public/webshop/register
 * Vendég regisztráció -> users tábla
 * Body: { full_name, email, password }
 */
router.post("/register", async (req, res) => {
    try {
        const { full_name, email, password } = req.body || {};
        if (!full_name || !email || !password) {
            return res
                .status(400)
                .send("Hiányzó adat. Név, e-mail és jelszó kötelező.");
        }
        // Ha már van ilyen e-mail, ne duplikáljunk felhasználót
        const existing = await db_1.default.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email]);
        if (existing.rows.length > 0) {
            return res.status(200).json({
                message: "Már létezik felhasználó ezzel az e-mail címmel. Jelentkezz be a meglévő fiókoddal.",
            });
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        // Itt a TE users tábládba írunk:
        // email, password_hash, role, full_name, is_active
        await db_1.default.query(`
      INSERT INTO users (
        email,
        password_hash,
        role,
        full_name,
        is_active
      )
      VALUES ($1, $2, $3, $4, true)
      `, [email, passwordHash, "client", full_name]);
        return res.json({
            message: "Sikeres regisztráció a Kleopátra webshopban.",
        });
    }
    catch (err) {
        console.error("❌ Webshop register error:", err);
        return res.status(500).send("Hiba a regisztráció során.");
    }
});
/**
 * POST /api/public/webshop/validate-coupon
 * Body: { code, cart: { items: [{product_id, quantity, unit_price}], total_gross } }
 */
router.post("/validate-coupon", async (req, res) => {
    try {
        const { code, cart } = req.body || {};
        const now = new Date();
        if (!code || !cart) {
            return res.status(400).json({
                valid: false,
                message: "Hiányzó kuponkód vagy kosár.",
            });
        }
        const upper = String(code).trim().toUpperCase();
        const totalGross = toNumber(cart.total_gross);
        const result = await db_1.default.query(`
      SELECT *
      FROM coupons
      WHERE code = $1
        AND is_active = true
        AND (valid_from IS NULL OR valid_from <= $2::date)
        AND (valid_until IS NULL OR valid_until >= $2::date)
      LIMIT 1
      `, [upper, now]);
        if (result.rows.length === 0) {
            return res.json({
                valid: false,
                message: "Érvénytelen vagy lejárt kuponkód.",
            });
        }
        const coupon = result.rows[0];
        // usage_limit / used_count ellenőrzése
        if (coupon.usage_limit != null &&
            coupon.used_count >= coupon.usage_limit) {
            return res.json({
                valid: false,
                message: "A kupon elérte a felhasználási limitet.",
            });
        }
        // min_order_total ellenőrzés
        const minOrder = toNumber(coupon.min_order_total);
        if (totalGross < minOrder) {
            return res.json({
                valid: false,
                message: `A kupon minimum rendeléshez kötött (${minOrder.toLocaleString("hu-HU")} Ft).`,
            });
        }
        let discount = 0;
        const discountType = coupon.discount_type || "percent";
        const discountValue = toNumber(coupon.discount_value);
        const maxDiscountValue = coupon.max_discount_value
            ? toNumber(coupon.max_discount_value)
            : null;
        if (discountType === "percent") {
            discount = (totalGross * discountValue) / 100;
        }
        else if (discountType === "fixed") {
            discount = discountValue;
        }
        if (maxDiscountValue != null && discount > maxDiscountValue) {
            discount = maxDiscountValue;
        }
        if (discount <= 0) {
            return res.json({
                valid: false,
                message: "A kupon nem ad kedvezményt erre a rendelésre.",
            });
        }
        const finalTotal = totalGross - discount;
        return res.json({
            valid: true,
            code: upper,
            discount_gross: discount,
            final_total_gross: finalTotal,
            message: "A kupon sikeresen alkalmazható.",
        });
    }
    catch (err) {
        console.error("❌ Validate coupon error:", err);
        return res.status(500).json({
            valid: false,
            message: "Hiba történt a kupon ellenőrzése során.",
        });
    }
});
/**
 * POST /api/public/webshop/order
 *
 * Body:
 * {
 *   customer: { full_name, email, phone, address, note },
 *   payment_method: "card" | "cod",
 *   coupon: { code, discount_gross } | null,
 *   items: [{ product_id, quantity, unit_price }],
 *   totals: {
 *     subtotal_gross,
 *     discount_gross,
 *     total_gross,
 *     currency
 *   }
 * }
 */
router.post("/order", async (req, res) => {
    const client = await db_1.default.connect();
    try {
        const { customer, payment_method, coupon, items, totals } = req.body || {};
        if (!customer || !payment_method || !items || !totals) {
            return res.status(400).send("Hiányzó adatok a rendelésben.");
        }
        const subtotal = toNumber(totals.subtotal_gross);
        const discount = toNumber(totals.discount_gross);
        const total = toNumber(totals.total_gross);
        const currency = totals.currency || "HUF";
        if (!customer.full_name || !customer.email || !customer.address) {
            return res
                .status(400)
                .send("Név, e-mail és cím megadása kötelező.");
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).send("A rendeléshez üres kosár érkezett.");
        }
        await client.query("BEGIN");
        let couponId = null;
        let couponCode = null;
        let couponDiscount = 0;
        if (coupon && coupon.code) {
            couponCode = String(coupon.code).toUpperCase();
            couponDiscount = toNumber(coupon.discount_gross);
            const couponRes = await client.query(`SELECT id, usage_limit, used_count FROM coupons WHERE code = $1 LIMIT 1`, [couponCode]);
            if (couponRes.rows.length > 0) {
                couponId = couponRes.rows[0].id;
                // usage_count növelése (védelem: csak akkor, ha nem lépte túl)
                if (couponRes.rows[0].usage_limit == null ||
                    couponRes.rows[0].used_count < couponRes.rows[0].usage_limit) {
                    await client.query(`UPDATE coupons SET used_count = used_count + 1 WHERE id = $1`, [couponId]);
                }
            }
        }
        // webshop_orders beszúrása
        const insertOrder = await client.query(`
      INSERT INTO webshop_orders (
        customer_full_name,
        customer_email,
        customer_phone,
        customer_address,
        customer_note,
        subtotal_gross,
        discount_gross,
        total_gross,
        currency,
        payment_method,
        status,
        coupon_id,
        coupon_code,
        coupon_discount_gross,
        items_json
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, 'new',
        $11, $12, $13,
        $14
      )
      RETURNING id
      `, [
            customer.full_name,
            customer.email,
            customer.phone || null,
            customer.address,
            customer.note || null,
            subtotal,
            discount,
            total,
            currency,
            payment_method,
            couponId,
            couponCode,
            couponDiscount,
            JSON.stringify(items),
        ]);
        const orderId = insertOrder.rows[0].id;
        await client.query("COMMIT");
        // Ha kártyás fizetés: itt tudsz payment_url-t generálni (Barion, SimplePay, stb.)
        // Most csak egy egyszerű válasz:
        return res.json({
            order_id: orderId,
            status: "ok",
        });
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Webshop order error:", err);
        return res.status(500).send("Hiba történt a rendelés mentésekor.");
    }
    finally {
        client.release();
    }
});
exports.default = router;
