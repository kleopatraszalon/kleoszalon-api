import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import catalog from "../data/kleoshop-catalog.json";

type CatalogProduct = (typeof catalog.products)[number];
type SyncStats = { inserted: number; updated: number; matchedByName: number; total: number };

async function ensureSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS product_groups (
      id uuid PRIMARY KEY,
      name_hu text NOT NULL,
      name_en text,
      name_ru text,
      created_at timestamptz DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS product_categories (
      id uuid PRIMARY KEY,
      product_group_id uuid NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
      name_hu text NOT NULL,
      name_en text,
      name_ru text,
      created_at timestamptz DEFAULT now()
    )
  `);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_group_id uuid REFERENCES product_groups(id)`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_category_id uuid REFERENCES product_categories(id)`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS main_category text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sub_category text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS service_category text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_source text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_source_url text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_source_sku text`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_source_synced_at timestamptz`);
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_source_catalog_at timestamptz`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_web_source_url_unique ON products(web_source_url) WHERE web_source_url IS NOT NULL`);
}

async function getOrCreateGroup(client: PoolClient, label: string) {
  const found = await client.query(`SELECT id FROM product_groups WHERE lower(trim(name_hu))=lower(trim($1)) ORDER BY created_at ASC NULLS LAST LIMIT 1`, [label]);
  if (found.rowCount) return String(found.rows[0].id);
  const id = randomUUID();
  await client.query(`INSERT INTO product_groups(id,name_hu,name_en,name_ru) VALUES($1,$2,$2,$2)`, [id, label]);
  return id;
}

async function getOrCreateCategory(client: PoolClient, groupId: string, label: string) {
  const found = await client.query(
    `SELECT id FROM product_categories WHERE product_group_id=$1 AND lower(trim(name_hu))=lower(trim($2)) ORDER BY created_at ASC NULLS LAST LIMIT 1`,
    [groupId, label],
  );
  if (found.rowCount) return String(found.rows[0].id);
  const id = randomUUID();
  await client.query(`INSERT INTO product_categories(id,product_group_id,name_hu,name_en,name_ru) VALUES($1,$2,$3,$3,$3)`, [id, groupId, label]);
  return id;
}

function normalizedName(value: string) {
  return String(value || "").trim().toLocaleLowerCase("hu-HU");
}

export async function syncKleoshopCatalog(client: PoolClient): Promise<SyncStats> {
  if (catalog.product_count < 500 || catalog.priced_product_count !== catalog.product_count) {
    throw new Error(`Kleoshop catalog snapshot is incomplete: ${catalog.priced_product_count}/${catalog.product_count}`);
  }

  await client.query("BEGIN");
  try {
    await ensureSchema(client);

    const groupCache = new Map<string, string>();
    const categoryCache = new Map<string, string>();
    const groupFor = async (product: CatalogProduct) => {
      const label = product.classification.display_group;
      let id = groupCache.get(label);
      if (!id) {
        id = await getOrCreateGroup(client, label);
        groupCache.set(label, id);
      }
      return id;
    };
    const categoryFor = async (product: CatalogProduct, groupId: string) => {
      const label = product.classification.display_subgroup;
      const cacheKey = `${groupId}:${label}`;
      let id = categoryCache.get(cacheKey);
      if (!id) {
        id = await getOrCreateCategory(client, groupId, label);
        categoryCache.set(cacheKey, id);
      }
      return id;
    };

    const current = await client.query(`SELECT id,name,web_source_url FROM products`);
    const byUrl = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const row of current.rows) {
      if (row.web_source_url) byUrl.set(String(row.web_source_url), String(row.id));
      const nameKey = normalizedName(String(row.name || ""));
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, String(row.id));
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
      let id = byUrl.get(sourceUrl) || byName.get(nameKey) || null;
      const wasNameMatch = Boolean(id && !byUrl.has(sourceUrl));
      sortOrder += 1;

      if (id) {
        await client.query(
          `UPDATE products SET
             name=$2,
             retail_price_gross=$3,
             sale_price=NULL,
             web_is_visible=true,
             is_retail=true,
             web_sort_order=$4,
             web_description=$5,
             image_url=$6,
             product_group_id=$7,
             product_category_id=$8,
             main_category=$9,
             sub_category=$10,
             service_category=$11,
             web_source='kleoshop',
             web_source_url=$12,
             web_source_sku=$13,
             web_source_synced_at=now(),
             web_source_catalog_at=$14::timestamptz
           WHERE id=$1`,
          [
            id,
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
          ],
        );
        updated += 1;
        if (wasNameMatch) matchedByName += 1;
      } else {
        const created = await client.query(
          `INSERT INTO products(
             name,retail_price_gross,sale_price,web_is_visible,is_retail,web_sort_order,web_description,image_url,
             product_group_id,product_category_id,main_category,sub_category,service_category,
             web_source,web_source_url,web_source_sku,web_source_synced_at,web_source_catalog_at
           ) VALUES($1,$2,NULL,true,true,$3,$4,$5,$6,$7,$8,$9,$10,'kleoshop',$11,$12,now(),$13::timestamptz)
           RETURNING id`,
          [
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
          ],
        );
        id = String(created.rows[0].id);
        inserted += 1;
        byUrl.set(sourceUrl, id);
        if (!byName.has(nameKey)) byName.set(nameKey, id);
      }
      selectedIds.add(id);
    }

    // If legacy duplicates with the exact same webshop name exist, keep the selected
    // synced master visible and hide only the other unsourced webshop duplicates.
    if (selectedIds.size) {
      const names = catalog.products.map((product) => product.name);
      await client.query(
        `UPDATE products p SET web_is_visible=false
         WHERE p.web_source_url IS NULL
           AND lower(trim(p.name)) = ANY($1::text[])
           AND NOT (p.id = ANY($2::uuid[]))`,
        [names.map(normalizedName), [...selectedIds]],
      );
    }

    const verified = await client.query(`SELECT count(*)::int AS count FROM products WHERE web_source='kleoshop' AND web_source_url IS NOT NULL`);
    const total = Number(verified.rows[0]?.count || 0);
    if (total !== catalog.product_count) {
      throw new Error(`Kleoshop sync verification failed: expected ${catalog.product_count}, persisted ${total}`);
    }

    await client.query("COMMIT");
    console.log(`[kleoshop-sync] ${total} products verified; inserted=${inserted}, updated=${updated}, name_matches=${matchedByName}`);
    return { inserted, updated, matchedByName, total };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
