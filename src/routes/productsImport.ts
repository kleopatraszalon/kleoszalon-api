import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import pool from "../db";
import { classifyProduct, TAXONOMY_VERSION, normalizeTaxonomyText } from "../inventory/productTaxonomy";
import { ensureProductTaxonomySchema, ensureTaxonomyNodes } from "../inventory/ensureProductTaxonomy";
import productTaxonomyAdminRouter from "./productTaxonomyAdmin";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use("/taxonomy", productTaxonomyAdminRouter);

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || null; };
const number = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/\s/g, "").replace(/Ft/gi, "").replace(",", ".").replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
function pick(row: Record<string, unknown>, aliases: string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const n = normalizeTaxonomyText(alias);
    const hit = entries.find(([k]) => normalizeTaxonomyText(k) === n);
    if (hit) return hit[1];
  }
  for (const alias of aliases) {
    const n = normalizeTaxonomyText(alias);
    const hit = entries.find(([k]) => normalizeTaxonomyText(k).includes(n) || n.includes(normalizeTaxonomyText(k)));
    if (hit) return hit[1];
  }
  return null;
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
  } catch (e: any) {
    return res.status(400).json({ error: "Az Altegio termék Excel nem olvasható.", detail: e?.message });
  }

  const client = await (pool as any).connect();
  let created = 0, updated = 0, skipped = 0, lowConfidence = 0;
  const groupCodes = new Set<string>();
  const categoryCodes = new Set<string>();
  try {
    await client.query("BEGIN");
    await ensureProductTaxonomySchema(client);

    for (const r of raw) {
      const sourceCategoryName = text(pick(r, ["Kategória", "Kategoria"])) || "Egyéb";
      const sourceCategoryIdRaw = number(pick(r, ["Kategóriaazonosító", "Kategória azonosító", "Kategoriaazonosito"]));
      const sourceCategoryId = sourceCategoryIdRaw == null ? null : Math.trunc(sourceCategoryIdRaw);
      const name = text(pick(r, ["Megnevezés a nyugtán", "Megnevezés", "Név", "Nev"]));
      const sku = text(pick(r, ["Cikkszám", "Cikkszam"]));
      const barcode = text(pick(r, ["Vonalkód", "Vonalkod"]));
      const brand = text(pick(r, ["Márka", "Marka", "Brand", "Gyártó", "Gyarto"]));
      const lineName = text(pick(r, ["Termékvonal", "Termekvonal", "Termékcsalád", "Termekcsalad", "Line"]));
      if (!name) { skipped++; continue; }

      const tx = classifyProduct({ name, category: sourceCategoryName, brand, lineName });
      if (tx.confidence < 0.6) lowConfidence++;
      const nodes = await ensureTaxonomyNodes(client, tx);
      groupCodes.add(nodes.groupCode);
      categoryCodes.add(nodes.categoryCode);

      const sale = number(pick(r, ["Eladási ár, Ft", "Eladási ár", "Eladasi ar"]));
      const purchase = number(pick(r, ["Beszerzési ár, Ft", "Beszerzési ár", "Beszerzesi ar"]));
      const key = barcode ? `barcode:${barcode}` : sku ? `sku:${sku}` : `name:${normalizeTaxonomyText(name)}|src:${sourceCategoryId ?? normalizeTaxonomyText(sourceCategoryName)}`;
      const found = await client.query(
        `SELECT id FROM public.products WHERE altegio_product_key=$1 OR ($2::text IS NOT NULL AND barcode=$2) OR ($3::text IS NOT NULL AND internal_code=$3) LIMIT 1`,
        [key, barcode, sku],
      );

      const params = [
        name, sku, barcode, brand, lineName, nodes.groupId, nodes.categoryId, purchase, sale,
        text(pick(r, ["Értékesítési egység", "Ertekesitesi egyseg", "Eladási egység"])),
        text(pick(r, ["Mértékegység felhasználáskor", "Mertekegyseg felhasznalaskor", "Felhasználási egység"])),
        text(pick(r, ["Felhasználható menyiségi egység (Kiszerelés)", "Felhasználható mennyiségi egység (Kiszerelés)", "Kiszerelés"])),
        number(pick(r, ["Nettó tömeg, g.", "Nettó tömeg", "Netto tomeg"])),
        number(pick(r, ["Bruttó tömeg, g.", "Bruttó tömeg", "Brutto tomeg"])),
        number(pick(r, ["Kritikus mennyiség", "Kritikus mennyiseg"])),
        number(pick(r, ["Rendelt mennyiség", "Rendelt mennyiseg"])),
        text(pick(r, ["Megjegyzés", "Megjegyzes"])), key, sourceCategoryId, sourceCategoryName,
        TAXONOMY_VERSION, tx.confidence,
        tx.flags.is_service_material, tx.flags.is_retail, tx.flags.is_cleaning, tx.flags.is_hospitality, tx.flags.is_merchandise,
      ];

      if (found.rows[0]) {
        await client.query(`
          UPDATE public.products SET
            name=$1,receipt_name=$1,internal_code=$2,barcode=$3,brand=$4,line_name=$5,
            product_group_id=$6::uuid,product_category_id=$7::uuid,purchase_price_net=$8::numeric,retail_price_gross=$9::numeric,
            sale_unit=$10,usage_unit=$11,package_unit=$12,net_weight_g=$13::numeric,gross_weight_g=$14::numeric,
            critical_quantity=$15::numeric,ordered_quantity=$16::numeric,import_note=$17,altegio_product_key=$18,
            source_category_id=$19::bigint,source_category_name=$20,source_system='altegio',imported_at=now(),
            taxonomy_source=$21,taxonomy_confidence=$22::numeric,taxonomy_updated_at=now(),is_active=true,
            is_service_material=$23::boolean,is_retail=$24::boolean,is_cleaning=$25::boolean,is_hospitality=$26::boolean,is_merchandise=$27::boolean
          WHERE id=$28::uuid
        `, [...params, found.rows[0].id]);
        updated++;
      } else {
        await client.query(`
          INSERT INTO public.products(
            name,receipt_name,internal_code,barcode,brand,line_name,product_group_id,product_category_id,purchase_price_net,retail_price_gross,
            sale_unit,usage_unit,package_unit,net_weight_g,gross_weight_g,critical_quantity,ordered_quantity,import_note,altegio_product_key,
            source_category_id,source_category_name,source_system,imported_at,taxonomy_source,taxonomy_confidence,taxonomy_updated_at,is_active,
            is_service_material,is_retail,is_cleaning,is_hospitality,is_merchandise)
          VALUES($1,$1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::numeric,$9::numeric,$10,$11,$12,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17,$18,
                 $19::bigint,$20,'altegio',now(),$21,$22::numeric,now(),true,$23::boolean,$24::boolean,$25::boolean,$26::boolean,$27::boolean)
        `, params);
        created++;
      }
    }

    await client.query("COMMIT");
    return res.json({
      ok: true,
      taxonomy_version: TAXONOMY_VERSION,
      sourceRows: raw.length,
      groups: groupCodes.size,
      categories: categoryCodes.size,
      created,
      updated,
      skipped,
      low_confidence: lowConfidence,
    });
  } catch (e: any) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Altegio product import error", e);
    return res.status(500).json({ error: "Az Altegio termékek importja nem sikerült.", code: e?.code || null, detail: e?.message || String(e) });
  } finally {
    client.release();
  }
});

export default router;
