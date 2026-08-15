import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";
import { requireManagement } from "../middleware/requireRoles";
import productsImportRouter from "./productsImport";
import { classifyProduct, TAXONOMY_VERSION } from "../inventory/productTaxonomy";
import {
  ensureProductTaxonomyReady,
  ensureProductTaxonomySchema,
  ensureTaxonomyNodes,
  reconcileProductTaxonomy,
} from "../inventory/ensureProductTaxonomy";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.products"));
router.use(productsImportRouter);

const META_CACHE_TTL_MS = 5 * 60 * 1000;
type Cached<T> = { value: T; expiresAt: number };
const columnCache = new Map<string, Cached<Set<string>>>();
let stockTableCache: Cached<boolean> | null = null;

async function cols(table: string) {
  const now = Date.now();
  const cached = columnCache.get(table);
  if (cached && cached.expiresAt > now) return cached.value;
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const value = new Set<string>(r.rows.map((x: any) => x.column_name));
  columnCache.set(table, { value, expiresAt: now + META_CACHE_TTL_MS });
  return value;
}

async function hasStockBalancesTable() {
  const now = Date.now();
  if (stockTableCache && stockTableCache.expiresAt > now) return stockTableCache.value;
  const stock = await pool.query(`SELECT to_regclass('public.product_stock_balances') IS NOT NULL ok`);
  const value = Boolean(stock.rows[0]?.ok);
  stockTableCache = { value, expiresAt: now + META_CACHE_TTL_MS };
  return value;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function map(r: any) {
  return {
    ...r,
    price: r.retail_price_gross == null ? null : Number(r.retail_price_gross),
    price_gross: r.retail_price_gross == null ? null : Number(r.retail_price_gross),
    purchase_price_net: r.purchase_price_net == null ? null : Number(r.purchase_price_net),
    retail_price_gross: r.retail_price_gross == null ? null : Number(r.retail_price_gross),
    vat_rate: r.vat_rate == null ? null : Number(r.vat_rate),
    critical_quantity: r.critical_quantity == null ? null : Number(r.critical_quantity),
    ordered_quantity: r.ordered_quantity == null ? null : Number(r.ordered_quantity),
    stock_quantity: r.stock_quantity == null ? null : Number(r.stock_quantity),
    available_stock: r.available_stock == null ? null : Number(r.available_stock),
    taxonomy_confidence: r.taxonomy_confidence == null ? null : Number(r.taxonomy_confidence),
  };
}

const productSelect = (stockSelect: string) => `
  SELECT p.*,
         g.name AS product_group_name,
         g.code AS product_group_code,
         g.product_type_code,
         g.product_type_name,
         c.name AS product_category_name,
         c.code AS product_category_code
         ${stockSelect}
  FROM products p
  LEFT JOIN product_groups g ON g.id=p.product_group_id
  LEFT JOIN product_categories c ON c.id=p.product_category_id
`;

router.get("/taxonomy/summary", async (_req: Request, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const { rows } = await pool.query(`
      SELECT
        COALESCE(g.product_type_code,'UNCLASSIFIED') AS type_code,
        COALESCE(g.product_type_name,'Nincs besorolva') AS type_name,
        g.id AS group_id,
        COALESCE(g.name,'Nincs csoport') AS group_name,
        g.code AS group_code,
        c.id AS category_id,
        COALESCE(c.name,'Nincs kategória') AS category_name,
        c.code AS category_code,
        COUNT(p.id)::int AS product_count,
        COUNT(p.id) FILTER (WHERE COALESCE(p.is_active,true)=true)::int AS active_product_count,
        COUNT(p.id) FILTER (WHERE COALESCE(p.taxonomy_confidence,0)<0.6)::int AS review_count
      FROM products p
      LEFT JOIN product_groups g ON g.id=p.product_group_id
      LEFT JOIN product_categories c ON c.id=p.product_category_id
      GROUP BY g.product_type_code,g.product_type_name,g.id,g.name,g.code,c.id,c.name,c.code,g.sort_order,c.sort_order
      ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),group_name,category_name
    `);
    res.json({ taxonomy_version: TAXONOMY_VERSION, items: rows });
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült lekérdezni a terméktaxonómiát.", detail: err?.message });
  }
});

router.post("/taxonomy/rebuild", requireManagement, async (req: Request, res: Response) => {
  try {
    const result = await reconcileProductTaxonomy({ force: Boolean((req.body as any)?.force) });
    res.json({ ok: true, taxonomy_version: TAXONOMY_VERSION, ...result });
  } catch (err: any) {
    res.status(500).json({ error: "A termékek újracsoportosítása nem sikerült.", detail: err?.message });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const pc = await cols("products");
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const hasStock = await hasStockBalancesTable();
    const paginated = String(req.query.paginated || "") === "1";

    if (paginated) {
      const page = positiveInt(req.query.page, 1, 1_000_000);
      const limit = positiveInt(req.query.limit, 100, 200);
      const offset = (page - 1) * limit;
      const q = String(req.query.q || "").trim().slice(0, 120);
      const values: any[] = [];
      const filters: string[] = [];

      if (pc.has("is_active") && !includeInactive) filters.push(`COALESCE(p.is_active,true)=true`);
      if (q) {
        values.push(`%${q}%`);
        const searchParam = `$${values.length}::text`;
        const searchable = ["name", "internal_code", "barcode", "brand", "line_name"].filter((name) => pc.has(name));
        if (searchable.length) {
          filters.push(`(${searchable.map((name) => `COALESCE(p.${name}::text,'') ILIKE ${searchParam}`).join(" OR ")})`);
        }
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const countValues = [...values];
      const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM products p ${where}`, countValues);

      values.push(limit);
      const limitParam = `$${values.length}::int`;
      values.push(offset);
      const offsetParam = `$${values.length}::int`;
      const stockJoin = hasStock
        ? `LEFT JOIN (
            SELECT psb.product_id, SUM(psb.quantity)::numeric AS available_stock
            FROM product_stock_balances psb
            JOIN page_products selected ON selected.id=psb.product_id
            GROUP BY psb.product_id
          ) sb ON sb.product_id=p.id`
        : "";
      const stockSel = hasStock
        ? `,sb.available_stock,sb.available_stock stock_quantity`
        : `,NULL::numeric available_stock,NULL::numeric stock_quantity`;
      const sql = `
        WITH page_products AS (
          SELECT p.id
          FROM products p
          LEFT JOIN product_groups g0 ON g0.id=p.product_group_id
          LEFT JOIN product_categories c0 ON c0.id=p.product_category_id
          ${where}
          ORDER BY COALESCE(g0.sort_order,999),COALESCE(c0.sort_order,999),p.name,p.id
          LIMIT ${limitParam} OFFSET ${offsetParam}
        )
        ${productSelect(stockSel)}
        JOIN page_products selected_page ON selected_page.id=p.id
        ${stockJoin}
        ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),p.name,p.id
      `;
      const { rows } = await pool.query(sql, values);
      return res.json({
        items: rows.map(map),
        total: Number(totalResult.rows[0]?.total || 0),
        page,
        limit,
      });
    }

    const active = pc.has("is_active") ? `WHERE ($1::boolean) OR COALESCE(p.is_active,true)=true` : "";
    const stockJoin = hasStock
      ? `LEFT JOIN (SELECT product_id,SUM(quantity)::numeric available_stock FROM product_stock_balances GROUP BY product_id) sb ON sb.product_id=p.id`
      : "";
    const stockSel = hasStock
      ? `,sb.available_stock,sb.available_stock stock_quantity`
      : `,NULL::numeric available_stock,NULL::numeric stock_quantity`;
    const sql = `${productSelect(stockSel)} ${stockJoin} ${active}
      ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),p.name`;
    const { rows } = await pool.query(sql, pc.has("is_active") ? [includeInactive] : []);
    res.json(rows.map(map));
  } catch (err: any) {
    console.error("GET /products hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a termékeket.", detail: err?.message });
  }
});

router.post("/bulk-import", async (req: Request, res: Response) => {
  const items = (req.body as any)?.items || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Nincs importálható adat (items)." });
  const client = await (pool as any).connect();
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  try {
    await client.query("BEGIN");
    await ensureProductTaxonomySchema(client);
    for (let i = 0; i < items.length; i++) {
      const x = items[i] || {};
      const name = String(x.name || "").trim();
      if (!name) {
        errors.push(`Sor ${i + 1}: név hiányzik.`);
        continue;
      }
      try {
        const sourceCategory = String(x.product_category_name || x.product_group_name || "").trim() || null;
        const tx = classifyProduct({ name, category: sourceCategory, brand: x.brand, lineName: x.line_name });
        const nodes = await ensureTaxonomyNodes(client, tx);
        const barcode = String(x.barcode || "").trim() || null;
        const internalCode = String(x.internal_code || "").trim() || null;
        const found = await client.query(
          `SELECT id FROM products WHERE ($1::text IS NOT NULL AND barcode=$1) OR ($2::text IS NOT NULL AND internal_code=$2) OR (lower(name)=lower($3) AND product_category_id=$4::uuid) LIMIT 1`,
          [barcode, internalCode, name, nodes.categoryId],
        );
        const values = [
          name,
          internalCode,
          barcode,
          x.brand || null,
          x.line_name || null,
          nodes.groupId,
          nodes.categoryId,
          x.purchase_price_net ?? null,
          x.retail_price_gross ?? null,
          x.vat_rate ?? 27,
          sourceCategory,
          TAXONOMY_VERSION,
          tx.confidence,
          tx.flags.is_service_material,
          tx.flags.is_retail,
          tx.flags.is_cleaning,
          tx.flags.is_hospitality,
          tx.flags.is_merchandise,
        ];
        if (found.rows[0]) {
          await client.query(`
            UPDATE products SET name=$1,internal_code=$2,barcode=$3,brand=$4,line_name=$5,
              product_group_id=$6::uuid,product_category_id=$7::uuid,purchase_price_net=$8::numeric,
              retail_price_gross=$9::numeric,vat_rate=$10::numeric,source_category_name=COALESCE($11,source_category_name),
              source_system=COALESCE(source_system,'csv'),taxonomy_source=$12,taxonomy_confidence=$13::numeric,taxonomy_updated_at=now(),
              is_service_material=$14::boolean,is_retail=$15::boolean,is_cleaning=$16::boolean,is_hospitality=$17::boolean,is_merchandise=$18::boolean
            WHERE id=$19::uuid
          `, [...values, found.rows[0].id]);
          updated++;
        } else {
          await client.query(`
            INSERT INTO products(name,internal_code,barcode,brand,line_name,product_group_id,product_category_id,purchase_price_net,retail_price_gross,vat_rate,
              source_category_name,source_system,taxonomy_source,taxonomy_confidence,taxonomy_updated_at,is_active,is_service_material,is_retail,is_cleaning,is_hospitality,is_merchandise)
            VALUES($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::numeric,$9::numeric,$10::numeric,$11,'csv',$12,$13::numeric,now(),true,$14::boolean,$15::boolean,$16::boolean,$17::boolean,$18::boolean)
          `, values);
          created++;
        }
      } catch (error: any) {
        errors.push(`Sor ${i + 1}: ${name} – ${error?.message || "mentési hiba"}`);
      }
    }
    await client.query("COMMIT");
    res.json({ message: `Import kész. Létrehozva: ${created}, frissítve: ${updated}.`, created, updated, errors });
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: "Bulk import közben hiba történt.", detail: err?.message });
  } finally {
    client.release();
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const { rows } = await pool.query(`${productSelect(`,NULL::numeric available_stock,NULL::numeric stock_quantity`)} WHERE p.id=$1::uuid LIMIT 1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Termék nem található." });
    res.json(map(rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült lekérdezni a terméket.", detail: err?.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const b: any = req.body || {};
    if (!String(b.name || "").trim()) return res.status(400).json({ error: "A termék neve kötelező." });
    await ensureProductTaxonomySchema();
    let groupId = b.product_group_id || null;
    let categoryId = b.product_category_id || null;
    let tx: ReturnType<typeof classifyProduct> | null = null;
    if (!groupId || !categoryId) {
      tx = classifyProduct({ name: b.name, category: b.product_category_name, brand: b.brand, lineName: b.line_name });
      const nodes = await ensureTaxonomyNodes(pool as any, tx);
      groupId = groupId || nodes.groupId;
      categoryId = categoryId || nodes.categoryId;
    }
    const c = await cols("products");
    const payload = { ...b, product_group_id: groupId, product_category_id: categoryId };
    if (tx) {
      payload.taxonomy_source = TAXONOMY_VERSION;
      payload.taxonomy_confidence = tx.confidence;
      payload.is_service_material = b.is_service_material ?? tx.flags.is_service_material;
      payload.is_retail = b.is_retail ?? tx.flags.is_retail;
      payload.is_cleaning = b.is_cleaning ?? tx.flags.is_cleaning;
      payload.is_hospitality = b.is_hospitality ?? tx.flags.is_hospitality;
      payload.is_merchandise = b.is_merchandise ?? tx.flags.is_merchandise;
    }
    const fields = ["name"];
    const vals: any[] = [String(b.name).trim()];
    const casts = ["text"];
    for (const [k, cast] of [
      ["internal_code", "text"], ["barcode", "text"], ["brand", "text"], ["line_name", "text"],
      ["product_group_id", "uuid"], ["product_category_id", "uuid"], ["purchase_price_net", "numeric"],
      ["retail_price_gross", "numeric"], ["vat_rate", "numeric"], ["size_label", "text"], ["color_text", "text"],
      ["target_gender", "text"], ["is_active", "boolean"], ["is_service_material", "boolean"], ["is_retail", "boolean"],
      ["is_cleaning", "boolean"], ["is_hospitality", "boolean"], ["is_merchandise", "boolean"],
      ["taxonomy_source", "text"], ["taxonomy_confidence", "numeric"],
    ] as any[]) {
      if (c.has(k) && payload[k] !== undefined) {
        fields.push(k);
        vals.push(payload[k] === "" ? null : payload[k]);
        casts.push(cast);
      }
    }
    const ps = vals.map((_, i) => `$${i + 1}::${casts[i]}`).join(",");
    const { rows } = await pool.query(`INSERT INTO products(${fields.join(",")}) VALUES(${ps}) RETURNING *`, vals);
    res.status(201).json(map(rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült létrehozni a terméket.", detail: err?.message });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b: any = req.body || {};
    const c = await cols("products");
    const fields: string[] = [];
    const vals: any[] = [];
    for (const [k, cast] of [
      ["name", "text"], ["internal_code", "text"], ["barcode", "text"], ["brand", "text"], ["line_name", "text"],
      ["product_group_id", "uuid"], ["product_category_id", "uuid"], ["purchase_price_net", "numeric"],
      ["retail_price_gross", "numeric"], ["vat_rate", "numeric"], ["size_label", "text"], ["color_text", "text"],
      ["target_gender", "text"], ["is_active", "boolean"], ["is_service_material", "boolean"], ["is_retail", "boolean"],
      ["is_cleaning", "boolean"], ["is_hospitality", "boolean"], ["is_merchandise", "boolean"],
    ] as any[]) {
      if (c.has(k) && b[k] !== undefined) {
        vals.push(b[k] === "" ? null : b[k]);
        fields.push(`${k}=$${vals.length}::${cast}`);
      }
    }
    if (!fields.length) return res.json({ message: "Nincs módosítandó mező." });
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE products SET ${fields.join(",")},taxonomy_updated_at=now() WHERE id=$${vals.length}::uuid RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: "Termék nem található." });
    res.json(map(rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült módosítani a terméket.", detail: err?.message });
  }
});

export default router;
