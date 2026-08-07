import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import * as XLSX from "xlsx";
import pool from "../db";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function roleTokens(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((v) => v.toLowerCase().trim());
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.toLowerCase().trim());
  } catch {}
  return s
    .replace(/[\[\]{}"']/g, " ")
    .split(/[,;|\s]+/)
    .map((v) => v.toLowerCase().trim())
    .filter(Boolean);
}

function requireImportAdmin(req: Request, res: Response, next: NextFunction) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Bejelentkezés szükséges." });
  try {
    const payload: any = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_change_me");
    const roles = roleTokens(payload?.role);
    const allowed = new Set(["admin", "administrator", "adminisztrátor", "superadmin", "global_admin", "owner", "manager", "tulajdonos"]);
    if (!roles.some((r) => allowed.has(r))) {
      return res.status(403).json({ error: "Az Altegio import csak admin jogosultsággal végezhető." });
    }
    (req as any).altegioImportUser = payload?.email || payload?.id || null;
    return next();
  } catch {
    return res.status(401).json({ error: "Érvénytelen vagy lejárt bejelentkezés." });
  }
}

function txt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/\s/g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function durationMinutes(value: unknown): number {
  const seconds = num(value) ?? 0;
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 1;
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

type Row = {
  category: string;
  altegioServiceId: number;
  name: string;
  receiptName: string | null;
  onlineName: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  apiId: string | null;
  description: string | null;
  staffField: string | null;
  durationMinutes: number;
};

async function ensureSchema() {
  // DDL külön fut a tranzakció ELŐTT. Így egy korábbi félbehagyott/hibás
  // import nem hagyja a sémamódosításokat abortált tranzakcióban.
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    ALTER TABLE public.service_types
      ADD COLUMN IF NOT EXISTS altegio_category_key text,
      ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    ALTER TABLE public.services
      ADD COLUMN IF NOT EXISTS altegio_service_id bigint,
      ADD COLUMN IF NOT EXISTS altegio_api_id text,
      ADD COLUMN IF NOT EXISTS receipt_name text,
      ADD COLUMN IF NOT EXISTS online_name text,
      ADD COLUMN IF NOT EXISTS price_from numeric(14,2),
      ADD COLUMN IF NOT EXISTS price_to numeric(14,2),
      ADD COLUMN IF NOT EXISTS source_system text,
      ADD COLUMN IF NOT EXISTS source_payload jsonb,
      ADD COLUMN IF NOT EXISTS imported_at timestamptz;

    CREATE INDEX IF NOT EXISTS service_types_altegio_category_key_idx
      ON public.service_types(altegio_category_key);
    CREATE UNIQUE INDEX IF NOT EXISTS services_altegio_service_id_uq
      ON public.services(altegio_service_id) WHERE altegio_service_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS public.service_altegio_staff_variants (
      id bigserial PRIMARY KEY,
      service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
      altegio_staff_id text NOT NULL,
      employee_id uuid NULL,
      duration_minutes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(service_id, altegio_staff_id)
    );

    CREATE INDEX IF NOT EXISTS service_altegio_staff_variants_staff_idx
      ON public.service_altegio_staff_variants(altegio_staff_id);

    CREATE TABLE IF NOT EXISTS public.service_import_runs (
      id bigserial PRIMARY KEY,
      source_system text NOT NULL,
      filename text,
      source_rows integer NOT NULL DEFAULT 0,
      category_count integer NOT NULL DEFAULT 0,
      service_count integer NOT NULL DEFAULT 0,
      staff_variant_count integer NOT NULL DEFAULT 0,
      created_services integer NOT NULL DEFAULT 0,
      updated_services integer NOT NULL DEFAULT 0,
      imported_by text,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function parseWorkbook(buffer: Buffer): Row[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Az Excel munkafüzet üres.");

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  if (!raw.length) throw new Error("Az Excel fájl nem tartalmaz adatsort.");

  const required = ["Kategória", "ID", "Név", "Szakemberek ID azonosítója", "Időtartam"];
  const headers = new Set(Object.keys(raw[0]).map((h) => h.replace(/^\uFEFF/, "").trim()));
  const missing = required.filter((h) => !headers.has(h));
  if (missing.length) throw new Error(`Hiányzó Altegio oszlop(ok): ${missing.join(", ")}`);

  return raw.map((r) => {
    const category = txt(r["Kategória"]);
    const name = txt(r["Név"]);
    const serviceId = num(r["ID"]);
    if (!category || !name || serviceId === null) return null;
    return {
      category,
      altegioServiceId: Math.trunc(serviceId),
      name,
      receiptName: txt(r["Megnevezés a nyugtán"]),
      onlineName: txt(r["Név az online foglaláshoz"]),
      priceFrom: num(r["Ár -tól"]),
      priceTo: num(r["Ár -ig"]),
      apiId: txt(r["API_ID"]),
      description: txt(r["Leírás"]),
      staffField: txt(r["Szakemberek ID azonosítója"]),
      durationMinutes: durationMinutes(r["Időtartam"]),
    } as Row;
  }).filter((r): r is Row => r !== null);
}

router.post("/import/altegio", requireImportAdmin, upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Az Excel fájl feltöltése kötelező." });

  let rows: Row[];
  try {
    rows = parseWorkbook(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "A fájlban nincs importálható szolgáltatás." });
    await ensureSchema();
  } catch (e: any) {
    console.error("Altegio import előkészítési hiba:", e);
    return res.status(400).json({ error: e?.message || "Az Excel fájl nem olvasható." });
  }

  const categories: string[] = [];
  const seenCategories = new Set<string>();
  const services = new Map<number, Row[]>();
  for (const row of rows) {
    if (!seenCategories.has(row.category)) {
      seenCategories.add(row.category);
      categories.push(row.category);
    }
    const group = services.get(row.altegioServiceId) || [];
    group.push(row);
    services.set(row.altegioServiceId, group);
  }

  const client = await (pool as any).connect();
  let createdServices = 0;
  let updatedServices = 0;
  let staffVariants = 0;

  try {
    await client.query("BEGIN");

    const categoryIds = new Map<string, string>();
    for (let index = 0; index < categories.length; index += 1) {
      const category = categories[index];
      const key = normalizeKey(category);
      const existing = await client.query(
        `SELECT id FROM public.service_types
         WHERE altegio_category_key = $1 OR lower(trim(name)) = lower(trim($2))
         ORDER BY CASE WHEN altegio_category_key = $1 THEN 0 ELSE 1 END
         LIMIT 1`,
        [key, category]
      );

      let id: string;
      if (existing.rowCount) {
        id = String(existing.rows[0].id);
        await client.query(
          `UPDATE public.service_types
           SET name=$2, altegio_category_key=$3, display_order=$4, updated_at=now()
           WHERE id=$1`,
          [id, category, key, index]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO public.service_types(name, altegio_category_key, display_order)
           VALUES ($1,$2,$3) RETURNING id`,
          [category, key, index]
        );
        id = String(inserted.rows[0].id);
      }
      categoryIds.set(category, id);
    }

    for (const [altegioServiceId, variants] of services.entries()) {
      const representative = variants[0];
      const defaultVariant = variants.find((r) => (r.staffField || "").toLocaleLowerCase("hu-HU") === "alapértelmezett") || representative;
      const typeId = categoryIds.get(representative.category)!;

      const existing = await client.query(
        `SELECT id FROM public.services
         WHERE altegio_service_id=$1
            OR (lower(trim(name))=lower(trim($2)) AND service_type_id=$3)
         ORDER BY CASE WHEN altegio_service_id=$1 THEN 0 ELSE 1 END, is_active DESC NULLS LAST
         LIMIT 1`,
        [altegioServiceId, representative.name, typeId]
      );

      const sourcePayload = JSON.stringify({
        category: representative.category,
        altegioServiceId,
        apiId: representative.apiId,
      });

      let serviceId: string;
      if (existing.rowCount) {
        serviceId = String(existing.rows[0].id);
        await client.query(
          `UPDATE public.services SET
             name=$2,
             code=COALESCE(NULLIF(code,''),$3),
             short_name=COALESCE(NULLIF($4,''),short_name),
             service_type_id=$5,
             base_price=$6,
             list_price=COALESCE($7,$6),
             currency=COALESCE(NULLIF(currency,''),'HUF'),
             duration_minutes=$8,
             description_short=COALESCE($9,description_short),
             altegio_service_id=$10,
             altegio_api_id=$11,
             receipt_name=$12,
             online_name=$13,
             price_from=$6,
             price_to=$7,
             source_system='altegio',
             source_payload=$14::jsonb,
             imported_at=now(),
             updated_at=now()
           WHERE id=$1`,
          [serviceId, representative.name, `ALT-${altegioServiceId}`, representative.onlineName, typeId,
           representative.priceFrom, representative.priceTo, defaultVariant.durationMinutes,
           representative.description, altegioServiceId, representative.apiId, representative.receiptName,
           representative.onlineName, sourcePayload]
        );
        updatedServices += 1;
      } else {
        const inserted = await client.query(
          `INSERT INTO public.services(
             name,code,short_name,service_type_id,parent_service_id,
             base_price,list_price,currency,duration_minutes,
             description_short,description_long,online_bookable,is_active,is_combo,
             altegio_service_id,altegio_api_id,receipt_name,online_name,price_from,price_to,
             source_system,source_payload,imported_at
           ) VALUES (
             $1,$2,$3,$4,NULL,$5,COALESCE($6,$5),'HUF',$7,
             $8,NULL,true,true,false,$9,$10,$11,$12,$5,$6,'altegio',$13::jsonb,now()
           ) RETURNING id`,
          [representative.name, `ALT-${altegioServiceId}`, representative.onlineName, typeId,
           representative.priceFrom, representative.priceTo, defaultVariant.durationMinutes,
           representative.description, altegioServiceId, representative.apiId, representative.receiptName,
           representative.onlineName, sourcePayload]
        );
        serviceId = String(inserted.rows[0].id);
        createdServices += 1;
      }

      await client.query(`DELETE FROM public.service_altegio_staff_variants WHERE service_id=$1`, [serviceId]);
      const staffMap = new Map<string, number>();
      for (const variant of variants) {
        if (!variant.staffField || variant.staffField.toLocaleLowerCase("hu-HU") === "alapértelmezett") continue;
        for (const item of variant.staffField.split(/##|[,;\s]+/)) {
          const staffId = item.trim();
          if (staffId) staffMap.set(staffId, variant.durationMinutes);
        }
      }
      for (const [staffId, mins] of staffMap.entries()) {
        await client.query(
          `INSERT INTO public.service_altegio_staff_variants(service_id,altegio_staff_id,duration_minutes)
           VALUES($1,$2,$3)
           ON CONFLICT(service_id,altegio_staff_id)
           DO UPDATE SET duration_minutes=EXCLUDED.duration_minutes,updated_at=now()`,
          [serviceId, staffId, mins]
        );
        staffVariants += 1;
      }
    }

    await client.query(
      `INSERT INTO public.service_import_runs(
         source_system,filename,source_rows,category_count,service_count,staff_variant_count,
         created_services,updated_services,imported_by
       ) VALUES('altegio',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.file.originalname, rows.length, categories.length, services.size, staffVariants,
       createdServices, updatedServices, (req as any).altegioImportUser || null]
    );

    await client.query("COMMIT");
    return res.json({
      ok: true,
      sourceRows: rows.length,
      categories: categories.length,
      services: services.size,
      staffVariants,
      createdServices,
      updatedServices,
      hierarchy: "service_types -> services -> staff variants",
    });
  } catch (e: any) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Altegio szolgáltatás import hiba:", e);
    // A kliensnek visszaadunk egy rövid, használható diagnosztikát. Nem küldünk SQL-t vagy adatot.
    const code = e?.code ? ` [${e.code}]` : "";
    const detail = String(e?.message || "ismeretlen adatbázis-hiba").slice(0, 280);
    return res.status(500).json({
      error: `Az Altegio szolgáltatások importja nem sikerült.${code} ${detail}`,
    });
  } finally {
    client.release();
  }
});

router.get("/import/altegio/status", requireImportAdmin, async (_req: Request, res: Response) => {
  try {
    await ensureSchema();
    const [run, categoryCount, serviceCount, variantCount] = await Promise.all([
      pool.query(`SELECT * FROM public.service_import_runs WHERE source_system='altegio' ORDER BY imported_at DESC LIMIT 1`),
      pool.query(`SELECT count(*)::int AS n FROM public.service_types WHERE altegio_category_key IS NOT NULL`),
      pool.query(`SELECT count(*)::int AS n FROM public.services WHERE altegio_service_id IS NOT NULL`),
      pool.query(`SELECT count(*)::int AS n FROM public.service_altegio_staff_variants`),
    ]);
    return res.json({
      ok: true,
      lastImport: run.rows[0] || null,
      categories: categoryCount.rows[0]?.n || 0,
      services: serviceCount.rows[0]?.n || 0,
      staffVariants: variantCount.rows[0]?.n || 0,
    });
  } catch (e: any) {
    return res.status(500).json({ error: `Az import állapot nem olvasható. ${String(e?.message || "").slice(0, 240)}` });
  }
});

export default router;
