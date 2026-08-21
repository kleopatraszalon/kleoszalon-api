import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

async function tableExists(name: string): Promise<boolean> {
  try {
    const result = await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${name}`]);
    return Boolean(result.rows[0]?.ok);
  } catch {
    return false;
  }
}

async function columns(name: string): Promise<Set<string>> {
  try {
    const result = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [name],
    );
    return new Set(result.rows.map((row: any) => String(row.column_name)));
  } catch {
    return new Set();
  }
}

const cleanedNumeric = (expression: string) =>
  `regexp_replace(COALESCE(${expression},'0'),'[^0-9,.-]','','g')`;

const numericValue = (expression: string, fallback = "0") => {
  const cleaned = cleanedNumeric(expression);
  return `CASE WHEN ${cleaned} ~ '^-?[0-9]+([.,][0-9]+)?$' THEN replace(${cleaned},',','.')::numeric ELSE ${fallback}::numeric END`;
};

/**
 * Schema-drift-tolerant product feed for the digital work-order cashier.
 * It intentionally avoids direct dependencies on optional product group/category
 * tables and treats stock fields through JSON text so legacy column types cannot
 * turn a harmless product lookup into HTTP 500.
 */
router.get("/retail/products", async (req, res) => {
  try {
    if (!(await tableExists("products"))) return res.json([]);

    const productColumns = await columns("products");
    if (!productColumns.has("id")) return res.json([]);

    const locationId = String(req.query.location_id || "").trim();
    const search = String(req.query.q || "").trim().slice(0, 120);
    const groupId = String(req.query.group_id || "").trim();

    const hasBalances = await tableExists("product_stock_balances");
    const balanceColumns = hasBalances ? await columns("product_stock_balances") : new Set<string>();
    const stockCapable = balanceColumns.has("product_id") && balanceColumns.has("quantity");
    const stockLocationCapable = stockCapable && balanceColumns.has("location_id");

    const rawName = "COALESCE(NULLIF(to_jsonb(p)->>'name',''),NULLIF(to_jsonb(p)->>'product_name',''),NULLIF(to_jsonb(p)->>'title',''),'Névtelen termék')";
    const rawPrice = "COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross',''),NULLIF(to_jsonb(p)->>'sale_price',''),NULLIF(to_jsonb(p)->>'price',''),'0')";
    const rawVat = "COALESCE(NULLIF(to_jsonb(p)->>'vat_rate',''),NULLIF(to_jsonb(p)->>'vat',''),'0.27')";
    const priceSql = numericValue(rawPrice, "0");
    const vatBaseSql = numericValue(rawVat, "0.27");
    const vatSql = `CASE WHEN (${vatBaseSql}) > 1 THEN (${vatBaseSql}) / 100 ELSE (${vatBaseSql}) END`;

    const stockQuantity = numericValue("to_jsonb(s)->>'quantity'", "0");
    const stockSql = stockCapable
      ? `(SELECT COALESCE(SUM(${stockQuantity}),0)::numeric
          FROM product_stock_balances s
          WHERE (to_jsonb(s)->>'product_id')=p.id::text
            AND ($1::text='' OR ${stockLocationCapable ? "COALESCE(to_jsonb(s)->>'location_id','')=$1::text" : "TRUE"}))`
      : "0::numeric";

    const filters = [
      "lower(COALESCE(NULLIF(to_jsonb(p)->>'is_active',''),'true')) NOT IN ('false','0','no','nem','inactive')",
    ];
    const params: any[] = [locationId];

    if (search) {
      params.push(`%${search}%`);
      const parameter = `$${params.length}`;
      filters.push(`(
        ${rawName} ILIKE ${parameter}
        OR COALESCE(to_jsonb(p)->>'barcode','') ILIKE ${parameter}
        OR COALESCE(to_jsonb(p)->>'internal_code','') ILIKE ${parameter}
        OR COALESCE(to_jsonb(p)->>'sku','') ILIKE ${parameter}
        OR COALESCE(to_jsonb(p)->>'product_group_name','') ILIKE ${parameter}
        OR COALESCE(to_jsonb(p)->>'category_name','') ILIKE ${parameter}
      )`);
    }

    if (groupId) {
      params.push(groupId);
      filters.push(`COALESCE(to_jsonb(p)->>'product_group_id','')=$${params.length}`);
    }

    const result = await db.query(
      `SELECT p.id::text id,
         ${rawName} name,
         (${priceSql})::numeric price,
         (${stockSql})::numeric available_stock,
         (${vatSql})::numeric vat_rate,
         NULLIF(to_jsonb(p)->>'product_group_id','') group_id,
         COALESCE(NULLIF(to_jsonb(p)->>'product_group_name',''),NULLIF(to_jsonb(p)->>'group_name',''),'Nincs csoport') group_name,
         NULLIF(to_jsonb(p)->>'product_category_id','') category_id,
         COALESCE(NULLIF(to_jsonb(p)->>'product_category_name',''),NULLIF(to_jsonb(p)->>'category_name',''),'Nincs kategória') category_name
       FROM products p
       WHERE ${filters.join(" AND ")}
       ORDER BY group_name,category_name,name
       LIMIT 500`,
      params,
    );

    return res.json(result.rows);
  } catch (error: any) {
    console.error("[retail-products-500-hotfix] failed closed to empty", error?.code || "", error?.message || error);
    // Product sale is optional during work-order editing. Returning an empty list
    // keeps the work-order and client history usable while surfacing no stale stock.
    return res.json([]);
  }
});

export default router;
