import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { ensureProductTaxonomySchema } from "../inventory/ensureProductTaxonomy";
import catalog from "../data/kleoshop-catalog.json";

type CatalogProduct = (typeof catalog.products)[number];
type SyncStats = { inserted: number; updated: number; matchedByName: number; total: number };

const TAXONOMY_SOURCE = "kleoshop-2026-v1";

async function ensureSchema(client: PoolClient) {
  await ensureProductTaxonomySchema(client);
  await client.query(`
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS main_category text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sub_category text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS service_category text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS web_source text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS web_source_url text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS web_source_sku text;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS web_source_synced_at timestamptz;
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS web_source_catalog_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS products_web_source_url_unique
      ON public.products(web_source_url) WHERE web_source_url IS NOT NULL;
  `);
}

function groupCode(product: CatalogProduct) {
  return `WEB_${String(product.classification.main_category).toUpperCase()}`.slice(0, 96);
}

function categoryCode(product: CatalogProduct) {
  return `WEB_${String(product.classification.main_category).toUpperCase()}_${String(product.classification.sub_category).toUpperCase()}`.slice(0, 96);
}

async function getOrCreateGroup(client: PoolClient, product: CatalogProduct) {
  const code = groupCode(product);
  const label = product.classification.display_group;
  const found = await client.query(
    `SELECT id FROM public.product_groups WHERE upper(COALESCE(code,''))=upper($1) LIMIT 1`,
    [code],
  );
  if (found.rowCount) {
    const id = String(found.rows[0].id);
    await client.query(
      `UPDATE public.product_groups SET
         name=$2,name_hu=$2,name_en=COALESCE(NULLIF(name_en,''),$2),name_ru=COALESCE(NULLIF(name_ru,''),$2),
         code=$3,product_type_code='WEBSHOP',product_type_name='Webshop',is_active=true
       WHERE id=$1::uuid`,
      [id, label, code],
    );
    return id;
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.product_groups(
       id,name,name_hu,name_en,name_ru,code,product_type_code,product_type_name,sort_order,is_active
     ) VALUES($1::uuid,$2,$2,$2,$2,$3,'WEBSHOP','Webshop',500,true)`,
    [id, label, code],
  );
  return id;
}

async function getOrCreateCategory(client: PoolClient, product: CatalogProduct, groupId: string) {
  const code = categoryCode(product);
  const label = product.classification.display_subgroup;
  const found = await client.query(
    `SELECT id FROM public.product_categories WHERE upper(COALESCE(code,''))=upper($1) LIMIT 1`,
    [code],
  );
  if (found.rowCount) {
    const id = String(found.rows[0].id);
    await client.query(
      `UPDATE public.product_categories SET
         product_group_id=$2::uuid,name=$3,name_hu=$3,
         name_en=COALESCE(NULLIF(name_en,''),$3),name_ru=COALESCE(NULLIF(name_ru,''),$3),
         code=$4,is_active=true
       WHERE id=$1::uuid`,
      [id, groupId, label, code],
    );
    return id;
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.product_categories(
       id,product_group_id,name,name_hu,name_en,name_ru,code,sort_order,display_order,is_active
     ) VALUES($1::uuid,$2::uuid,$3,$3,$3,$3,$4,500,500,true)`,
    [id, groupId, label, code],
  );
  return id;
}

function normalizedName(value: string) {
  return String(value || "").trim().toLocaleLowerCase("hu-HU");
}

export async function syncKleoshopCatalog(client: PoolClient): Promise<SyncStats> {
  if (catalog.product_count < 500 || catalog.priced_product_count !== catalog.product_count) {
    throw new Error(`Kleoshop catalog snapshot is incomplete: ${catalog.priced_product_count}/${catalog.product_count}`);
  }

  const catalogNameCounts = new Map<string, number>();
  for (const product of catalog.products) {
    const nameKey = normalizedName(product.name);
    catalogNameCounts.set(nameKey, (catalogNameCounts.get(nameKey) || 0) + 1);
  }

  await client.query("BEGIN");
  try {
    await ensureSchema(client);

    const groupCache = new Map<string, string>();
    const categoryCache = new Map<string, string>();
    const groupFor = async (product: CatalogProduct) => {
      const code = groupCode(product);
      let id = groupCache.get(code);
      if (!id) {
        id = await getOrCreateGroup(client, product);
        groupCache.set(code, id);
      }
      return id;
    };
    const categoryFor = async (product: CatalogProduct, groupId: string) => {
      const code = categoryCode(product);
      let id = categoryCache.get(code);
      if (!id) {
        id = await getOrCreateCategory(client, product, groupId);
        categoryCache.set(code, id);
      }
      return id;
    };

    const current = await client.query(`SELECT id,name,web_source_url FROM public.products`);
    const byUrl = new Map<string, string>();
    const byName = new Map<string, string>();
    const existingNameCounts = new Map<string, number>();
    for (const row of current.rows) {
      if (row.web_source_url) byUrl.set(String(row.web_source_url), String(row.id));
      const nameKey = normalizedName(String(row.name || ""));
      if (nameKey) existingNameCounts.set(nameKey, (existingNameCounts.get(nameKey) || 0) + 1);
    }
    for (const row of current.rows) {
      const nameKey = normalizedName(String(row.name || ""));
      if (nameKey && existingNameCounts.get(nameKey) === 1) byName.set(nameKey, String(row.id));
    }

    let inserted = 0;
    let updated = 0;
    let matchedByName = 0;
    const selectedIds = new Set<string>();
    let sortOrder = 1000;

    for (const product of catalog.products) {
      if (!(Number(product.price_gross) > 0)) throw new Error(`Invalid Kleoshop price: ${product.name}`);
      const groupId = await groupFor(product);
      const categoryId = await categoryFor(product, groupId);
      const sourceUrl = String(product.source_url);
      const nameKey = normalizedName(product.name);
      const allowNameMatch = catalogNameCounts.get(nameKey) === 1;
      let id = byUrl.get(sourceUrl) || (allowNameMatch ? byName.get(nameKey) : undefined) || null;
      const wasNameMatch = Boolean(id && !byUrl.has(sourceUrl));
      sortOrder += 1;

      const commonParams = [
        product.name,
        Number(product.price_gross),
        sortOrder,
        product.description || null,
        product.image_url || null,
        groupId,
        categoryId,
        product.classification.main_category,
        product.classification.sub_category,
        product.classification.service_category || null,
        sourceUrl,
        product.sku || null,
        catalog.source_scan_generated_at,
      ];

      if (id) {
        await client.query(
          `UPDATE public.products SET
             name=$2,retail_price_gross=$3,sale_price=NULL,web_is_visible=true,is_retail=true,
             web_sort_order=$4,web_description=$5,image_url=$6,product_group_id=$7::uuid,product_category_id=$8::uuid,
             main_category=$9,sub_category=$10,service_category=$11,
             web_source='kleoshop',web_source_url=$12,web_source_sku=$13,web_source_synced_at=now(),web_source_catalog_at=$14::timestamptz,
             source_system='kleoshop',source_category_name=$15,taxonomy_source=$16,taxonomy_confidence=1,taxonomy_updated_at=now()
           WHERE id=$1::uuid`,
          [id, ...commonParams, `${product.classification.display_group} > ${product.classification.display_subgroup}`, TAXONOMY_SOURCE],
        );
        updated += 1;
        if (wasNameMatch) matchedByName += 1;
      } else {
        const created = await client.query(
          `INSERT INTO public.products(
             name,retail_price_gross,sale_price,web_is_visible,is_retail,web_sort_order,web_description,image_url,
             product_group_id,product_category_id,main_category,sub_category,service_category,
             web_source,web_source_url,web_source_sku,web_source_synced_at,web_source_catalog_at,
             source_system,source_category_name,taxonomy_source,taxonomy_confidence,taxonomy_updated_at
           ) VALUES(
             $1,$2,NULL,true,true,$3,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,
             'kleoshop',$11,$12,now(),$13::timestamptz,'kleoshop',$14,$15,1,now()
           ) RETURNING id`,
          [
            ...commonParams,
            `${product.classification.display_group} > ${product.classification.display_subgroup}`,
            TAXONOMY_SOURCE,
          ],
        );
        id = String(created.rows[0].id);
        inserted += 1;
        byUrl.set(sourceUrl, id);
        if (allowNameMatch && !byName.has(nameKey)) byName.set(nameKey, id);
      }
      selectedIds.add(id);
    }

    // Exact-name legacy duplicates are hidden only when that source name itself
    // is unique in the verified catalog. Duplicate-name source products remain distinct.
    const uniqueNames = catalog.products
      .filter((product) => catalogNameCounts.get(normalizedName(product.name)) === 1)
      .map((product) => normalizedName(product.name));
    if (selectedIds.size && uniqueNames.length) {
      await client.query(
        `UPDATE public.products p SET web_is_visible=false
         WHERE p.web_source_url IS NULL
           AND lower(trim(p.name)) = ANY($1::text[])
           AND NOT (p.id = ANY($2::uuid[]))`,
        [uniqueNames, [...selectedIds]],
      );
    }

    const verified = await client.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE COALESCE(web_is_visible,false)=true)::int AS visible,
        count(*) FILTER (WHERE COALESCE(retail_price_gross,0)>0)::int AS priced,
        count(DISTINCT web_source_url)::int AS distinct_urls
      FROM public.products
      WHERE web_source='kleoshop' AND web_source_url IS NOT NULL
    `);
    const row = verified.rows[0] || {};
    const total = Number(row.total || 0);
    if (
      total !== catalog.product_count ||
      Number(row.visible || 0) !== catalog.product_count ||
      Number(row.priced || 0) !== catalog.product_count ||
      Number(row.distinct_urls || 0) !== catalog.product_count
    ) {
      throw new Error(
        `Kleoshop sync verification failed: expected ${catalog.product_count}; ` +
        `total=${row.total}, visible=${row.visible}, priced=${row.priced}, distinct_urls=${row.distinct_urls}`,
      );
    }

    await client.query("COMMIT");
    console.log(`[kleoshop-sync] ${total} products verified; inserted=${inserted}, updated=${updated}, name_matches=${matchedByName}`);
    return { inserted, updated, matchedByName, total };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
