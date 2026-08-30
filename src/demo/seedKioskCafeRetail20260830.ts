import pool from "../db";
import { classifyProduct, TAXONOMY_VERSION } from "../inventory/productTaxonomy";
import { ensureProductTaxonomySchema, ensureTaxonomyNodes } from "../inventory/ensureProductTaxonomy";

type RetailGroup = "coffee" | "tea" | "drink" | "water" | "chocolate" | "snack" | "protein";
type CatalogItem = {
  code: string;
  name: string;
  price: number;
  group: RetailGroup;
  badge?: string;
  featured?: boolean;
};

const SECTIONS: Record<RetailGroup, { title: string; subtitle: string; order: number }> = {
  coffee: { title: "Kávék", subtitle: "Frissen készített klasszikus és jeges kávék", order: 10 },
  tea: { title: "Teák", subtitle: "Meleg és jeges teák", order: 20 },
  drink: { title: "Üdítők", subtitle: "Hideg frissítők és limonádék", order: 30 },
  water: { title: "Vizek", subtitle: "Szénsavas és szénsavmentes ásványvíz", order: 40 },
  chocolate: { title: "Csokik", subtitle: "Csokoládék és pralinék", order: 50 },
  snack: { title: "Snackek", subtitle: "Könnyű falatok a várakozáshoz", order: 60 },
  protein: { title: "Protein shake", subtitle: "Friss protein shake-ek", order: 70 },
};

const CATALOG: CatalogItem[] = [
  { code: "KLEO-CAFE-ESPRESSO", name: "Kleopátra Espresso", price: 790, group: "coffee", featured: true },
  { code: "KLEO-CAFE-DUPLA-ESPRESSO", name: "Kleopátra Dupla Espresso", price: 990, group: "coffee" },
  { code: "KLEO-CAFE-CAPPUCCINO", name: "Kleopátra Cappuccino", price: 1190, group: "coffee", featured: true },
  { code: "KLEO-CAFE-LATTE", name: "Kleopátra Caffè Latte", price: 1290, group: "coffee" },
  { code: "KLEO-CAFE-FLAT-WHITE", name: "Kleopátra Flat White kávé", price: 1390, group: "coffee" },
  { code: "KLEO-CAFE-ICED-LATTE", name: "Kleopátra Jeges Latte", price: 1390, group: "coffee", badge: "HIDEG" },

  { code: "KLEO-TEA-EARL-GREY", name: "Earl Grey Tea", price: 990, group: "tea" },
  { code: "KLEO-TEA-GREEN", name: "Zöld Tea", price: 990, group: "tea" },
  { code: "KLEO-TEA-MINT", name: "Mentás Herbal Tea", price: 990, group: "tea" },
  { code: "KLEO-TEA-PEACH-ICED", name: "Barackos Jeges Tea", price: 1090, group: "tea", badge: "HIDEG" },

  { code: "KLEO-DRINK-LIME", name: "Cool Lime Limonádé", price: 990, group: "drink", featured: true },
  { code: "KLEO-DRINK-STRAWBERRY", name: "Epres-Lime Limonádé", price: 1090, group: "drink" },
  { code: "KLEO-DRINK-COLA-ZERO", name: "Cola Zero 0,33 l", price: 790, group: "drink" },
  { code: "KLEO-DRINK-ORANGE", name: "Narancs üdítő 0,33 l", price: 790, group: "drink" },
  { code: "KLEO-DRINK-APPLE-JUICE", name: "Almalé 0,25 l", price: 890, group: "drink" },

  { code: "KLEO-WATER-STILL", name: "Szénsavmentes ásványvíz 0,5 l", price: 590, group: "water" },
  { code: "KLEO-WATER-SPARKLING", name: "Szénsavas ásványvíz 0,5 l", price: 650, group: "water" },

  { code: "KLEO-CHOCO-MILK", name: "Tejcsokoládé 50 g", price: 790, group: "chocolate" },
  { code: "KLEO-CHOCO-DARK", name: "Étcsokoládé 50 g", price: 790, group: "chocolate" },
  { code: "KLEO-CHOCO-PRALINE", name: "Praliné válogatás", price: 1190, group: "chocolate", featured: true },

  { code: "KLEO-SNACK-GRANOLA", name: "Granola szelet", price: 690, group: "snack" },
  { code: "KLEO-SNACK-OAT-COOKIE", name: "Zabkeksz", price: 690, group: "snack" },
  { code: "KLEO-SNACK-ALMOND", name: "Sós mandula", price: 890, group: "snack" },
  { code: "KLEO-SNACK-RAW", name: "Gyümölcsös Raw szelet", price: 790, group: "snack" },

  { code: "KLEO-PROTEIN-VANILLA", name: "Vaníliás Protein Shake", price: 1590, group: "protein", featured: true },
  { code: "KLEO-PROTEIN-CHOCOLATE", name: "Csokoládés Protein Shake", price: 1590, group: "protein" },
  { code: "KLEO-PROTEIN-STRAWBERRY", name: "Epres Protein Shake", price: 1590, group: "protein" },
  { code: "KLEO-PROTEIN-COFFEE", name: "Jegeskávés Protein Shake", price: 1690, group: "protein" },
];

async function ensureKioskTables(db: any) {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS kiosk_menus(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NULL REFERENCES locations(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Kiosk menü',theme jsonb NOT NULL DEFAULT '{}'::jsonb,is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kiosk_product_sections(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
      group_key text,title_hu text NOT NULL,subtitle_hu text,image_url text,enabled boolean NOT NULL DEFAULT true,
      display_order int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kiosk_product_items(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),section_id uuid NOT NULL REFERENCES kiosk_product_sections(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,display_order int NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,
      image_url text,badge_text text,featured boolean NOT NULL DEFAULT false,display_name text,UNIQUE(section_id,product_id)
    );
  `);
}

async function seedCafeRetailCatalog() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await ensureKioskTables(db);
    await ensureProductTaxonomySchema(db);

    const location = (await db.query(`
      SELECT id::text id,name FROM locations
      WHERE COALESCE(is_active,true)=true
        AND (lower(name) LIKE '%gyöngy%' OR lower(name) LIKE '%gyongy%')
      ORDER BY CASE WHEN lower(name) LIKE 'gyöngy%' OR lower(name) LIKE 'gyongy%' THEN 0 ELSE 1 END,name
      LIMIT 1
    `)).rows[0];
    if (!location) throw new Error("A Gyöngyös szalon nem található a kávézó katalógushoz.");

    let menu = (await db.query(`SELECT id::text id FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`, [location.id])).rows[0];
    if (!menu) {
      menu = (await db.query(`INSERT INTO kiosk_menus(location_id,name,is_active,updated_at) VALUES($1::uuid,'Gyöngyös kiosk menü',true,now()) RETURNING id::text id`, [location.id])).rows[0];
    }

    const sectionIds = new Map<RetailGroup, string>();
    for (const group of Object.keys(SECTIONS) as RetailGroup[]) {
      const s = SECTIONS[group];
      let section = (await db.query(`SELECT id::text id FROM kiosk_product_sections WHERE menu_id=$1::uuid AND group_key=$2 ORDER BY updated_at DESC NULLS LAST,id LIMIT 1`, [menu.id, `cafe-${group}`])).rows[0];
      if (!section) {
        section = (await db.query(`
          INSERT INTO kiosk_product_sections(menu_id,group_key,title_hu,subtitle_hu,enabled,display_order,updated_at)
          VALUES($1::uuid,$2,$3,$4,true,$5,now()) RETURNING id::text id
        `, [menu.id, `cafe-${group}`, s.title, s.subtitle, s.order])).rows[0];
      } else {
        await db.query(`UPDATE kiosk_product_sections SET title_hu=$2,subtitle_hu=$3,enabled=true,display_order=$4,updated_at=now() WHERE id=$1::uuid`, [section.id, s.title, s.subtitle, s.order]);
      }
      sectionIds.set(group, section.id);
    }

    let created = 0;
    let updated = 0;
    for (let index = 0; index < CATALOG.length; index += 1) {
      const item = CATALOG[index];
      const sourceCategory = `Kleopátra Café / ${SECTIONS[item.group].title}`;
      const tx = classifyProduct({ name: item.name, category: sourceCategory, brand: "Kleopátra Café", lineName: SECTIONS[item.group].title });
      const nodes = await ensureTaxonomyNodes(db, tx);
      let product = (await db.query(`SELECT id::text id FROM products WHERE internal_code=$1 LIMIT 1`, [item.code])).rows[0];
      if (product) {
        await db.query(`
          UPDATE products SET name=$2,brand='Kleopátra Café',line_name=$3,product_group_id=$4::uuid,product_category_id=$5::uuid,
            retail_price_gross=$6::numeric,vat_rate=27,source_category_name=$7,source_system='kiosk-cafe',taxonomy_source=$8,
            taxonomy_confidence=$9::numeric,taxonomy_updated_at=now(),is_active=true,is_service_material=false,is_retail=true,
            is_cleaning=false,is_hospitality=true,is_merchandise=true
          WHERE id=$1::uuid
        `, [product.id, item.name, SECTIONS[item.group].title, nodes.groupId, nodes.categoryId, item.price, sourceCategory, TAXONOMY_VERSION, Math.max(0.95, tx.confidence || 0)]);
        updated += 1;
      } else {
        product = (await db.query(`
          INSERT INTO products(name,internal_code,brand,line_name,product_group_id,product_category_id,retail_price_gross,vat_rate,
            source_category_name,source_system,taxonomy_source,taxonomy_confidence,taxonomy_updated_at,is_active,is_service_material,
            is_retail,is_cleaning,is_hospitality,is_merchandise)
          VALUES($1,$2,'Kleopátra Café',$3,$4::uuid,$5::uuid,$6::numeric,27,$7,'kiosk-cafe',$8,$9::numeric,now(),true,false,true,false,true,true)
          RETURNING id::text id
        `, [item.name, item.code, SECTIONS[item.group].title, nodes.groupId, nodes.categoryId, item.price, sourceCategory, TAXONOMY_VERSION, Math.max(0.95, tx.confidence || 0)])).rows[0];
        created += 1;
      }

      const sectionId = sectionIds.get(item.group)!;
      await db.query(`
        INSERT INTO kiosk_product_items(section_id,product_id,display_order,enabled,image_url,badge_text,featured,display_name)
        VALUES($1::uuid,$2::uuid,$3,true,NULL,$4,$5,$6)
        ON CONFLICT(section_id,product_id) DO UPDATE SET display_order=EXCLUDED.display_order,enabled=true,
          image_url=NULL,badge_text=EXCLUDED.badge_text,featured=EXCLUDED.featured,display_name=EXCLUDED.display_name
      `, [sectionId, product.id, index + 1, item.badge || null, Boolean(item.featured), item.name]);
    }

    await db.query("COMMIT");
    console.log(`[kiosk-cafe] katalógus kész: ${created} új, ${updated} frissített termék (${location.name}).`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

let attempts = 0;
async function runWithRetry() {
  attempts += 1;
  try {
    await seedCafeRetailCatalog();
  } catch (error: any) {
    console.error(`[kiosk-cafe] seed ${attempts}/10 sikertelen:`, error?.message || error);
    if (attempts < 10) setTimeout(() => void runWithRetry(), 30_000);
  }
}

setTimeout(() => void runWithRetry(), 18_000);
