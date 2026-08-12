import { randomUUID } from "crypto";
import pool from "../db";
import { classifyProduct, ProductTaxonomyResult, TAXONOMY_VERSION } from "./productTaxonomy";

type DbLike = { query: (sql: string, params?: any[]) => Promise<any> };

export async function ensureProductTaxonomySchema(db: DbLike = pool as any) {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    ALTER TABLE public.product_groups
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS name_hu text,
      ADD COLUMN IF NOT EXISTS name_en text,
      ADD COLUMN IF NOT EXISTS name_ru text,
      ADD COLUMN IF NOT EXISTS code text,
      ADD COLUMN IF NOT EXISTS product_type_code text,
      ADD COLUMN IF NOT EXISTS product_type_name text,
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE public.product_categories
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS name_hu text,
      ADD COLUMN IF NOT EXISTS name_en text,
      ADD COLUMN IF NOT EXISTS name_ru text,
      ADD COLUMN IF NOT EXISTS code text,
      ADD COLUMN IF NOT EXISTS altegio_category_id bigint,
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE public.products
      ADD COLUMN IF NOT EXISTS altegio_product_key text,
      ADD COLUMN IF NOT EXISTS receipt_name text,
      ADD COLUMN IF NOT EXISTS sale_unit text,
      ADD COLUMN IF NOT EXISTS usage_unit text,
      ADD COLUMN IF NOT EXISTS package_unit text,
      ADD COLUMN IF NOT EXISTS net_weight_g numeric(14,3),
      ADD COLUMN IF NOT EXISTS gross_weight_g numeric(14,3),
      ADD COLUMN IF NOT EXISTS critical_quantity numeric(14,3),
      ADD COLUMN IF NOT EXISTS ordered_quantity numeric(14,3),
      ADD COLUMN IF NOT EXISTS import_note text,
      ADD COLUMN IF NOT EXISTS source_system text,
      ADD COLUMN IF NOT EXISTS imported_at timestamptz,
      ADD COLUMN IF NOT EXISTS source_category_id bigint,
      ADD COLUMN IF NOT EXISTS source_category_name text,
      ADD COLUMN IF NOT EXISTS taxonomy_source text,
      ADD COLUMN IF NOT EXISTS taxonomy_confidence numeric(5,4),
      ADD COLUMN IF NOT EXISTS taxonomy_updated_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS products_altegio_product_key_uq
      ON public.products(altegio_product_key) WHERE altegio_product_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS products_taxonomy_source_idx ON public.products(taxonomy_source);
    CREATE INDEX IF NOT EXISTS product_groups_type_idx ON public.product_groups(product_type_code,sort_order,name);
  `);
}

export async function ensureTaxonomyNodes(db: DbLike, tx: ProductTaxonomyResult) {
  const groupCode = `KLEO_${tx.groupCode}`;
  const categoryCode = `KLEO_${tx.groupCode}_${tx.categoryCode}`.slice(0, 96);

  let group = await db.query(`SELECT id FROM public.product_groups WHERE upper(COALESCE(code,''))=upper($1) LIMIT 1`, [groupCode]);
  let groupId = group.rows[0]?.id ? String(group.rows[0].id) : "";
  if (!groupId) {
    groupId = randomUUID();
    await db.query(`
      INSERT INTO public.product_groups(id,name,name_hu,name_en,name_ru,code,sort_order,is_active,product_type_code,product_type_name)
      VALUES($1::uuid,$2,$2,$2,$2,$3,$4,true,$5,$6)
    `, [groupId, tx.groupName, groupCode, groupSort(tx.groupCode), tx.typeCode, tx.typeName]);
  } else {
    await db.query(`
      UPDATE public.product_groups
      SET name=$2,name_hu=$2,product_type_code=$3,product_type_name=$4,sort_order=$5,is_active=true
      WHERE id=$1::uuid
    `, [groupId, tx.groupName, tx.typeCode, tx.typeName, groupSort(tx.groupCode)]);
  }

  let category = await db.query(`SELECT id FROM public.product_categories WHERE upper(COALESCE(code,''))=upper($1) LIMIT 1`, [categoryCode]);
  let categoryId = category.rows[0]?.id ? String(category.rows[0].id) : "";
  if (!categoryId) {
    categoryId = randomUUID();
    await db.query(`
      INSERT INTO public.product_categories(id,product_group_id,name,name_hu,name_en,name_ru,code,sort_order,display_order,is_active)
      VALUES($1::uuid,$2::uuid,$3,$3,$3,$3,$4,$5,$5,true)
    `, [categoryId, groupId, tx.categoryName, categoryCode, categorySort(tx.categoryCode)]);
  } else {
    await db.query(`
      UPDATE public.product_categories
      SET product_group_id=$2::uuid,name=$3,name_hu=$3,sort_order=$4,display_order=$4,is_active=true
      WHERE id=$1::uuid
    `, [categoryId, groupId, tx.categoryName, categorySort(tx.categoryCode)]);
  }

  return { groupId, categoryId, groupCode, categoryCode };
}

function groupSort(code: string) {
  const order = ["HAIR", "COSMETICS", "BODY_TREATMENTS", "NAILS", "LASH_BROW", "MAKEUP", "DEPILATION", "CONSUMABLES", "CLEANING_HYGIENE", "BUFFET_GUEST", "OFFICE_ADMIN", "GIFT_PROMO", "BEAUTY_OTHER"];
  const idx = order.indexOf(code);
  return idx < 0 ? 900 : (idx + 1) * 10;
}

function categorySort(code: string) {
  let hash = 0;
  for (const ch of code) hash = (hash * 31 + ch.charCodeAt(0)) % 80;
  return 10 + hash;
}

export async function reconcileProductTaxonomy(options: { force?: boolean } = {}) {
  const client = await (pool as any).connect();
  const stats = { reviewed: 0, changed: 0, lowConfidence: 0, legacyGroupsDeactivated: 0, legacyCategoriesDeactivated: 0 };
  try {
    await client.query("BEGIN");
    await ensureProductTaxonomySchema(client);
    const { rows } = await client.query(`
      SELECT p.id,p.name,p.brand,p.line_name,p.source_system,p.source_category_id,p.source_category_name,
             p.product_group_id,p.product_category_id,g.code AS group_code,c.name AS category_name,c.altegio_category_id
      FROM public.products p
      LEFT JOIN public.product_groups g ON g.id=p.product_group_id
      LEFT JOIN public.product_categories c ON c.id=p.product_category_id
      WHERE p.product_group_id IS NULL
         OR p.product_category_id IS NULL
         OR COALESCE(g.code,'') LIKE 'ALTG_%'
         OR ($1::boolean AND (COALESCE(p.source_system,'')='altegio' OR COALESCE(p.taxonomy_source,'')=$2::text))
      ORDER BY p.name
    `, [Boolean(options.force), TAXONOMY_VERSION]);

    for (const p of rows) {
      stats.reviewed++;
      const sourceCategoryName = p.source_category_name || p.category_name || null;
      const sourceCategoryId = p.source_category_id ?? p.altegio_category_id ?? null;
      const tx = classifyProduct({ name: p.name, category: sourceCategoryName, brand: p.brand, lineName: p.line_name });
      if (tx.confidence < 0.6) stats.lowConfidence++;
      const nodes = await ensureTaxonomyNodes(client, tx);
      const groupChanged = String(p.product_group_id || "") !== nodes.groupId;
      const categoryChanged = String(p.product_category_id || "") !== nodes.categoryId;
      if (groupChanged || categoryChanged) stats.changed++;
      await client.query(`
        UPDATE public.products SET
          product_group_id=$2::uuid,
          product_category_id=$3::uuid,
          source_category_id=COALESCE(source_category_id,$4::bigint),
          source_category_name=COALESCE(NULLIF(source_category_name,''),$5::text),
          taxonomy_source=$6::text,
          taxonomy_confidence=$7::numeric,
          taxonomy_updated_at=now(),
          is_service_material=$8::boolean,
          is_retail=$9::boolean,
          is_cleaning=$10::boolean,
          is_hospitality=$11::boolean,
          is_merchandise=$12::boolean
        WHERE id=$1::uuid
      `, [p.id, nodes.groupId, nodes.categoryId, sourceCategoryId, sourceCategoryName, TAXONOMY_VERSION, tx.confidence,
          tx.flags.is_service_material, tx.flags.is_retail, tx.flags.is_cleaning, tx.flags.is_hospitality, tx.flags.is_merchandise]);
    }

    const catResult = await client.query(`
      UPDATE public.product_categories c SET is_active=false
      WHERE COALESCE(c.code,'') LIKE 'ALTG_CAT_%'
        AND NOT EXISTS(SELECT 1 FROM public.products p WHERE p.product_category_id=c.id)
      RETURNING c.id
    `);
    stats.legacyCategoriesDeactivated = catResult.rowCount || 0;
    const groupResult = await client.query(`
      UPDATE public.product_groups g SET is_active=false
      WHERE COALESCE(g.code,'') LIKE 'ALTG_%'
        AND NOT EXISTS(SELECT 1 FROM public.products p WHERE p.product_group_id=g.id)
        AND NOT EXISTS(SELECT 1 FROM public.product_categories c WHERE c.product_group_id=g.id AND COALESCE(c.is_active,true)=true)
      RETURNING g.id
    `);
    stats.legacyGroupsDeactivated = groupResult.rowCount || 0;

    await client.query("COMMIT");
    return stats;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

let readiness: Promise<any> | null = null;
export async function ensureProductTaxonomyReady() {
  if (!readiness) {
    readiness = reconcileProductTaxonomy().catch((error) => {
      readiness = null;
      throw error;
    });
  }
  return readiness;
}
