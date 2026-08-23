import { Router, Request, Response } from "express";
import pool from "../db";
import catalog from "../data/kleoshop-catalog.json";

const router = Router();
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestedItem = { product_id?: unknown; quantity?: unknown };
type PricedItem = { product_id: string; name: string; quantity: number; unit_price: number; line_total: number };

function normalizeItems(raw: unknown): Array<{ product_id: string; quantity: number }> {
  if (!Array.isArray(raw) || raw.length === 0) throw Object.assign(new Error("A kosár üres."), { status: 400 });
  const quantities = new Map<string, number>();
  for (const item of raw as RequestedItem[]) {
    const productId = String(item?.product_id || "").trim();
    const quantity = Number(item?.quantity);
    if (!uuid.test(productId)) throw Object.assign(new Error("Érvénytelen termékazonosító."), { status: 400 });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw Object.assign(new Error("A termékmennyiség 1 és 100 közötti egész szám lehet."), { status: 400 });
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return [...quantities.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
}

async function priceCart(client: any, rawItems: unknown): Promise<{ items: PricedItem[]; subtotal: number }> {
  const requested = normalizeItems(rawItems);
  const ids = requested.map(x => x.product_id);
  const { rows } = await client.query(
    `SELECT id::text id,COALESCE(display_name_hu,name_hu,name,'Termék') name,
            CASE
              WHEN COALESCE(sale_price,0) > 0
               AND (COALESCE(retail_price_gross,0) <= 0 OR sale_price < retail_price_gross)
                THEN sale_price
              ELSE COALESCE(retail_price_gross,0)
            END::numeric unit_price
       FROM products
      WHERE id=ANY($1::uuid[])
        AND COALESCE(is_retail,false)=true
        AND COALESCE(web_is_visible,false)=true`,
    [ids]
  );
  if (rows.length !== ids.length) throw Object.assign(new Error("A kosár egy vagy több terméke már nem rendelhető."), { status: 409 });
  const byId = new Map(rows.map((row: any) => [String(row.id), row]));
  const items = requested.map(req => {
    const product: any = byId.get(req.product_id);
    const unitPrice = money(Number(product.unit_price || 0));
    if (!(unitPrice > 0)) throw Object.assign(new Error("A kosár egy vagy több termékének nincs érvényes webshopára."), { status: 409 });
    return { product_id: req.product_id, name: String(product.name || "Termék"), quantity: req.quantity, unit_price: unitPrice, line_total: money(unitPrice * req.quantity) };
  });
  return { items, subtotal: money(items.reduce((sum, item) => sum + item.line_total, 0)) };
}

async function calculateCoupon(client: any, rawCode: unknown, subtotal: number, lock = false) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { couponId: null as string | null, code: null as string | null, discount: 0, finalTotal: subtotal };
  const { rows } = await client.query(
    `SELECT id,code,discount_type,discount_value,max_discount_value,min_order_total,usage_limit,used_count
       FROM coupons
      WHERE upper(code)=upper($1) AND COALESCE(is_active,false)=true
        AND (valid_from IS NULL OR valid_from<=CURRENT_DATE)
        AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)
      LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [code]
  );
  const coupon = rows[0];
  if (!coupon) throw Object.assign(new Error("Érvénytelen vagy lejárt kuponkód."), { status: 400 });
  if (coupon.usage_limit != null && Number(coupon.used_count || 0) >= Number(coupon.usage_limit)) throw Object.assign(new Error("A kupon elérte a felhasználási limitet."), { status: 409 });
  const minimum = Number(coupon.min_order_total || 0);
  if (subtotal < minimum) throw Object.assign(new Error(`A kupon minimum rendelési értéke ${Math.round(minimum).toLocaleString("hu-HU")} Ft.`), { status: 400 });
  const value = Number(coupon.discount_value || 0);
  let discount = String(coupon.discount_type || "percent") === "fixed" ? value : subtotal * value / 100;
  const cap = coupon.max_discount_value == null ? null : Number(coupon.max_discount_value);
  if (cap != null) discount = Math.min(discount, cap);
  discount = money(Math.max(0, Math.min(subtotal, discount)));
  if (discount <= 0) throw Object.assign(new Error("A kupon nem ad kedvezményt erre a rendelésre."), { status: 400 });
  return { couponId: String(coupon.id), code: String(coupon.code || code).toUpperCase(), discount, finalTotal: money(subtotal - discount) };
}

router.get("/catalog-status", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE COALESCE(web_is_visible,false)=true)::int AS visible,
        count(*) FILTER (WHERE COALESCE(is_retail,false)=true)::int AS retail,
        count(*) FILTER (WHERE COALESCE(retail_price_gross,0)>0)::int AS priced,
        count(DISTINCT web_source_url)::int AS distinct_urls,
        max(web_source_catalog_at) AS catalog_at,
        max(web_source_synced_at) AS synced_at
      FROM products
      WHERE web_source='kleoshop' AND web_source_url IS NOT NULL
    `);
    const categoryRows = await pool.query(`
      SELECT main_category,sub_category,count(*)::int AS product_count
      FROM products
      WHERE web_source='kleoshop' AND web_source_url IS NOT NULL
      GROUP BY main_category,sub_category
      ORDER BY main_category,sub_category
    `);
    const row = rows[0] || {};
    const expected = Number(catalog.product_count);
    const ok = Number(row.total || 0) === expected && Number(row.visible || 0) === expected && Number(row.retail || 0) === expected && Number(row.priced || 0) === expected && Number(row.distinct_urls || 0) === expected;
    return res.status(ok ? 200 : 503).json({ ok, expected, total: Number(row.total || 0), visible: Number(row.visible || 0), retail: Number(row.retail || 0), priced: Number(row.priced || 0), distinct_urls: Number(row.distinct_urls || 0), catalog_at: row.catalog_at || null, synced_at: row.synced_at || null, categories: categoryRows.rows });
  } catch (error: any) {
    console.error("Kleoshop catalog status error:", error);
    return res.status(503).json({ ok: false, expected: catalog.product_count, error: "catalog_status_unavailable", detail: error?.message || String(error) });
  }
});

router.post("/validate-coupon", async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const priced = await priceCart(client, req.body?.cart?.items);
    const coupon = await calculateCoupon(client, req.body?.code, priced.subtotal, false);
    return res.json({ valid: true, code: coupon.code, subtotal_gross: priced.subtotal, discount_gross: coupon.discount, final_total_gross: coupon.finalTotal, message: "A kupon sikeresen alkalmazható." });
  } catch (error: any) {
    const status = Number(error?.status || 500);
    if (status >= 500) console.error("Webshop kuponellenőrzés hiba:", error);
    return res.status(status).json({ valid: false, message: error?.message || "A kupon ellenőrzése sikertelen." });
  } finally { client.release(); }
});

router.post("/order", async (req: Request, res: Response) => {
  const customer = req.body?.customer || {};
  const paymentMethod = String(req.body?.payment_method || "").trim().toLowerCase();
  const shippingAddress = String(customer.shipping_address || customer.address || "").trim();
  const billingSameAsShipping = customer.billing_same_as_shipping !== false;
  const billingName = billingSameAsShipping ? String(customer.full_name || "").trim() : String(customer.billing_name || "").trim();
  const billingAddress = billingSameAsShipping ? shippingAddress : String(customer.billing_address || "").trim();
  if (!String(customer.full_name || "").trim() || !String(customer.email || "").trim() || !shippingAddress) return res.status(400).json({ error: "Név, e-mail és szállítási cím megadása kötelező." });
  if (!billingName || !billingAddress) return res.status(400).json({ error: "A számlázási név és cím megadása kötelező." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email))) return res.status(400).json({ error: "Érvénytelen e-mail cím." });
  if (!["cod", "card"].includes(paymentMethod)) return res.status(400).json({ error: "Érvénytelen fizetési mód." });
  if (paymentMethod === "card") return res.status(503).json({ error: "A bankkártyás fizetési szolgáltató még nincs élesítve. Kérjük, válassza az utánvétet." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE webshop_orders ADD COLUMN IF NOT EXISTS shipping_address text, ADD COLUMN IF NOT EXISTS billing_same_as_shipping boolean, ADD COLUMN IF NOT EXISTS billing_name text, ADD COLUMN IF NOT EXISTS billing_address text`);
    const priced = await priceCart(client, req.body?.items);
    const coupon = await calculateCoupon(client, req.body?.coupon?.code, priced.subtotal, true);
    const total = coupon.finalTotal;
    const { rows } = await client.query(
      `INSERT INTO webshop_orders(
         customer_full_name,customer_email,customer_phone,customer_address,customer_note,
         shipping_address,billing_same_as_shipping,billing_name,billing_address,
         subtotal_gross,discount_gross,total_gross,currency,payment_method,status,
         coupon_id,coupon_code,coupon_discount_gross,items_json
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'HUF',$13,'new',$14,$15,$16,$17::jsonb)
       RETURNING id`,
      [String(customer.full_name).trim(), String(customer.email).trim().toLowerCase(), String(customer.phone || "").trim() || null,
       shippingAddress, String(customer.note || "").trim() || null, shippingAddress, billingSameAsShipping, billingName, billingAddress,
       priced.subtotal, coupon.discount, total, paymentMethod, coupon.couponId, coupon.code, coupon.discount, JSON.stringify(priced.items)]
    );
    if (coupon.couponId) await client.query(`UPDATE coupons SET used_count=COALESCE(used_count,0)+1 WHERE id=$1`, [coupon.couponId]);
    await client.query("COMMIT");
    return res.status(201).json({ order_id: rows[0].id, status: "new", payment_method: paymentMethod, shipping_address: shippingAddress, billing_same_as_shipping: billingSameAsShipping, billing_name: billingName, billing_address: billingAddress, totals: { subtotal_gross: priced.subtotal, discount_gross: coupon.discount, total_gross: total, currency: "HUF" } });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    const status = Number(error?.status || 500);
    if (status >= 500) console.error("Webshop rendelés hiba:", error);
    return res.status(status).json({ error: error?.message || "Hiba történt a rendelés mentésekor." });
  } finally { client.release(); }
});

export default router;
