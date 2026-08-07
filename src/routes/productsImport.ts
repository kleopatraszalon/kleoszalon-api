import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomUUID } from "crypto";
import pool from "../db";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const norm = (v: unknown) => String(v ?? "")
  .replace(/^\uFEFF/, "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || null; };
const number = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/\s/g, "").replace(/Ft/gi, "").replace(",", ".").replace(/[^0-9.\-]/g, "");
  const n = Number(s); return Number.isFinite(n) ? n : null;
};

function pick(row: Record<string, unknown>, aliases: string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const n = norm(alias);
    const hit = entries.find(([k]) => norm(k) === n);
    if (hit) return hit[1];
  }
  for (const alias of aliases) {
    const n = norm(alias);
    const hit = entries.find(([k]) => norm(k).includes(n) || n.includes(norm(k)));
    if (hit) return hit[1];
  }
  return null;
}

async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS name text;
    ALTER TABLE public.product_categories
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS altegio_category_id bigint,
      ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;
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
      ADD COLUMN IF NOT EXISTS imported_at timestamptz;

    -- Régi adatbázisokban a products.unit_id kötelező mezőként maradhatott meg,
    -- miközben a jelenlegi termékmodell már base_unit_id + importált szöveges
    -- mértékegységeket használ. Az Altegio export nem tartalmaz belső VIR unit UUID-t,
    -- ezért ezt a legacy NOT NULL korlátozást kompatibilitási okból feloldjuk.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'products'
          AND column_name = 'unit_id'
          AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE public.products ALTER COLUMN unit_id DROP NOT NULL;
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS products_altegio_product_key_uq
      ON public.products(altegio_product_key) WHERE altegio_product_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS product_categories_altegio_id_uq
      ON public.product_categories(altegio_category_id) WHERE altegio_category_id IS NOT NULL;
  `);
}

router.post("/import/altegio", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Az Excel fájl feltöltése kötelező." });
  let raw: Record<string, unknown>[] = [];
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Az Excel munkafüzet üres." });
    raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: true });
    if (!raw.length) return res.status(400).json({ error: "Az Excel nem tartalmaz termékadatot." });
    await ensureSchema();
  } catch (e: any) {
    return res.status(400).json({ error: "Az Altegio termék Excel nem olvasható.", detail: e?.message });
  }

  const client = await (pool as any).connect();
  let created = 0, updated = 0, skipped = 0;
  const categories = new Map<string, string>();
  try {
    await client.query("BEGIN");

    let group = await client.query(`
      SELECT id
      FROM public.product_groups
      WHERE lower(COALESCE(name,name_hu,''))=lower('Altegio import')
         OR upper(COALESCE(code,''))='ALTEGIO_IMPORT'
      LIMIT 1
    `);
    let groupId: string;
    if (group.rowCount) groupId = String(group.rows[0].id);
    else {
      groupId = randomUUID();
      await client.query(`
        INSERT INTO public.product_groups(
          id,name,name_hu,name_en,name_ru,code,sort_order,is_active
        )
        VALUES(
          $1::uuid,
          'Altegio import',
          'Altegio import',
          'Altegio import',
          'Altegio import',
          'ALTEGIO_IMPORT',
          999,
          true
        )
      `, [groupId]);
    }

    let order = 0;
    for (const r of raw) {
      const categoryName = text(pick(r, ["Kategória", "Kategoria"]));
      const categoryExt = number(pick(r, ["Kategóriaazonosító", "Kategória azonosító", "Kategoriaazonosito"]));
      const name = text(pick(r, ["Megnevezés a nyugtán", "Megnevezés", "Név", "Nev"]));
      const sku = text(pick(r, ["Cikkszám", "Cikkszam"]));
      const barcode = text(pick(r, ["Vonalkód", "Vonalkod"]));
      if (!name) { skipped++; continue; }

      const catKey = categoryExt != null ? `id:${Math.trunc(categoryExt)}` : `name:${norm(categoryName || "Egyéb")}`;
      let categoryId = categories.get(catKey);
      if (!categoryId) {
        const found = categoryExt != null
          ? await client.query(`SELECT id FROM public.product_categories WHERE altegio_category_id=$1::bigint LIMIT 1`, [Math.trunc(categoryExt)])
          : await client.query(`SELECT id FROM public.product_categories WHERE product_group_id=$1::uuid AND lower(COALESCE(name,name_hu,''))=lower($2::text) LIMIT 1`, [groupId, categoryName || "Egyéb"]);
        if (found.rowCount) categoryId = String(found.rows[0].id);
        else {
          categoryId = randomUUID();
          await client.query(`INSERT INTO public.product_categories(id,product_group_id,name,name_hu,name_en,name_ru,altegio_category_id,display_order)
            VALUES($1::uuid,$2::uuid,$3::text,$3::text,$3::text,$3::text,$4::bigint,$5::integer)`,
            [categoryId, groupId, categoryName || "Egyéb", categoryExt == null ? null : Math.trunc(categoryExt), order++]);
        }
        categories.set(catKey, categoryId);
      }

      const sale = number(pick(r, ["Eladási ár, Ft", "Eladási ár", "Eladasi ar"]));
      const purchase = number(pick(r, ["Beszerzési ár, Ft", "Beszerzési ár", "Beszerzesi ar"]));
      const key = barcode ? `barcode:${barcode}` : sku ? `sku:${sku}` : `name:${norm(name)}|cat:${categoryId}`;
      const foundProduct = await client.query(`SELECT id FROM public.products WHERE altegio_product_key=$1::text OR ($2::text IS NOT NULL AND barcode=$2::text) OR ($3::text IS NOT NULL AND internal_code=$3::text) LIMIT 1`, [key, barcode, sku]);

      const params = [
        name, sku, barcode, groupId, categoryId, purchase, sale,
        text(pick(r,["Értékesítési egység","Ertekesitesi egyseg","Eladási egység"])),
        text(pick(r,["Mértékegység felhasználáskor","Mertekegyseg felhasznalaskor","Felhasználási egység"])),
        text(pick(r,["Felhasználható menyiségi egység (Kiszerelés)","Felhasználható mennyiségi egység (Kiszerelés)","Kiszerelés"])),
        number(pick(r,["Nettó tömeg, g.","Nettó tömeg","Netto tomeg"])),
        number(pick(r,["Bruttó tömeg, g.","Bruttó tömeg","Brutto tomeg"])),
        number(pick(r,["Kritikus mennyiség","Kritikus mennyiseg"])),
        number(pick(r,["Rendelt mennyiség","Rendelt mennyiseg"])),
        text(pick(r,["Megjegyzés","Megjegyzes"])), key
      ];

      if (foundProduct.rowCount) {
        await client.query(`UPDATE public.products SET name=$1::text,receipt_name=$1::text,internal_code=$2::text,barcode=$3::text,product_group_id=$4::uuid,product_category_id=$5::uuid,purchase_price_net=$6::numeric,retail_price_gross=$7::numeric,sale_unit=$8::text,usage_unit=$9::text,package_unit=$10::text,net_weight_g=$11::numeric,gross_weight_g=$12::numeric,critical_quantity=$13::numeric,ordered_quantity=$14::numeric,import_note=$15::text,altegio_product_key=$16::text,source_system='altegio',imported_at=now(),is_active=true WHERE id=$17::uuid`, [...params, String(foundProduct.rows[0].id)]);
        updated++;
      } else {
        await client.query(`INSERT INTO public.products(name,receipt_name,internal_code,barcode,product_group_id,product_category_id,purchase_price_net,retail_price_gross,sale_unit,usage_unit,package_unit,net_weight_g,gross_weight_g,critical_quantity,ordered_quantity,import_note,altegio_product_key,source_system,imported_at,is_active)
          VALUES($1::text,$1::text,$2::text,$3::text,$4::uuid,$5::uuid,$6::numeric,$7::numeric,$8::text,$9::text,$10::text,$11::numeric,$12::numeric,$13::numeric,$14::numeric,$15::text,$16::text,'altegio',now(),true)`, params);
        created++;
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true, sourceRows: raw.length, categories: categories.size, created, updated, skipped });
  } catch (e: any) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Altegio product import error", e);
    return res.status(500).json({ error: "Az Altegio termékek importja nem sikerült.", code: e?.code || null, detail: e?.message || String(e) });
  } finally { client.release(); }
});

export default router;
