import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import * as XLSX from "xlsx";
import pool from "../db";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function roleTokens(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(v => v.toLowerCase().trim());
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String).map(v => v.toLowerCase().trim());
  } catch {}
  return s.replace(/[\[\]{}"']/g, " ").split(/[,;|\s]+/).map(v => v.toLowerCase().trim()).filter(Boolean);
}

function requireImportAdmin(req: Request, res: Response, next: NextFunction) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Bejelentkezés szükséges." });
  try {
    const payload: any = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_change_me");
    const allowed = new Set(["admin","administrator","adminisztrátor","superadmin","global_admin","owner","manager","tulajdonos"]);
    if (!roleTokens(payload?.role).some(r => allowed.has(r))) {
      return res.status(403).json({ error: "Az Altegio import csak admin jogosultsággal végezhető." });
    }
    (req as any).altegioImportUser = payload?.email || payload?.id || null;
    next();
  } catch {
    return res.status(401).json({ error: "Érvénytelen vagy lejárt bejelentkezés." });
  }
}

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const normalized = String(v).replace(/\s/g, "").replace(/Ft/gi, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function mins(v: unknown): number {
  const seconds = num(v) ?? 0;
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 1;
}

function normalizeKey(v: string): string {
  return v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
}

type AltegioRow = {
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
    CREATE INDEX IF NOT EXISTS service_types_altegio_category_key_idx ON public.service_types(altegio_category_key);
    CREATE UNIQUE INDEX IF NOT EXISTS services_altegio_service_id_uq ON public.services(altegio_service_id) WHERE altegio_service_id IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS service_altegio_staff_variants_staff_idx ON public.service_altegio_staff_variants(altegio_staff_id);
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

function parseWorkbook(buffer: Buffer): AltegioRow[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("Az Excel munkafüzet üres.");
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: true });
  if (!raw.length) throw new Error("Az Excel fájl nem tartalmaz adatsort.");
  const clean = (k: string) => k.replace(/^\uFEFF/, "").trim();
  const headerMap = new Map(Object.keys(raw[0]).map(k => [clean(k), k]));
  const required = ["Kategória","ID","Név","Szakemberek ID azonosítója","Időtartam"];
  const missing = required.filter(h => !headerMap.has(h));
  if (missing.length) throw new Error(`Hiányzó Altegio oszlop(ok): ${missing.join(", ")}`);
  const get = (r: Record<string, unknown>, key: string) => r[headerMap.get(key) || key];
  return raw.map(r => {
    const category = txt(get(r,"Kategória"));
    const name = txt(get(r,"Név"));
    const id = num(get(r,"ID"));
    if (!category || !name || id == null) return null;
    return {
      category,
      altegioServiceId: Math.trunc(id),
      name,
      receiptName: txt(get(r,"Megnevezés a nyugtán")),
      onlineName: txt(get(r,"Név az online foglaláshoz")),
      priceFrom: num(get(r,"Ár -tól")),
      priceTo: num(get(r,"Ár -ig")),
      apiId: txt(get(r,"API_ID")),
      description: txt(get(r,"Leírás")),
      staffField: txt(get(r,"Szakemberek ID azonosítója")),
      durationMinutes: mins(get(r,"Időtartam")),
    } as AltegioRow;
  }).filter((r): r is AltegioRow => r !== null);
}

router.post("/import/altegio", requireImportAdmin, upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Az Excel fájl feltöltése kötelező." });

  let rows: AltegioRow[];
  try {
    rows = parseWorkbook(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "A fájlban nincs importálható szolgáltatás." });
    await ensureSchema();
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "Az Excel fájl nem olvasható." });
  }

  const categories: string[] = [];
  const categorySet = new Set<string>();
  const grouped = new Map<number, AltegioRow[]>();
  for (const r of rows) {
    if (!categorySet.has(r.category)) { categorySet.add(r.category); categories.push(r.category); }
    const list = grouped.get(r.altegioServiceId) || [];
    list.push(r); grouped.set(r.altegioServiceId, list);
  }

  const client = await (pool as any).connect();
  let createdServices = 0, updatedServices = 0, staffVariants = 0;
  try {
    await client.query("BEGIN");
    const categoryIds = new Map<string,number>();

    for (let i=0;i<categories.length;i++) {
      const category = categories[i];
      const key = normalizeKey(category);
      const found = await client.query(
        `SELECT id FROM public.service_types
         WHERE altegio_category_key=$1::text OR lower(trim(name))=lower(trim($2::text))
         ORDER BY CASE WHEN altegio_category_key=$1::text THEN 0 ELSE 1 END LIMIT 1`,
        [key, category]
      );
      let id: number;
      if (found.rowCount) {
        id = Number(found.rows[0].id);
        await client.query(
          `UPDATE public.service_types SET name=$2::text, altegio_category_key=$3::text, display_order=$4::integer, updated_at=now() WHERE id=$1::integer`,
          [id, category, key, i]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO public.service_types(name,altegio_category_key,display_order) VALUES($1::text,$2::text,$3::integer) RETURNING id`,
          [category,key,i]
        );
        id=Number(ins.rows[0].id);
      }
      categoryIds.set(category,id);
    }

    for (const [altegioId, variants] of grouped.entries()) {
      const r = variants[0];
      const def = variants.find(v => (v.staffField || "").toLocaleLowerCase("hu-HU") === "alapértelmezett") || r;
      const typeId = categoryIds.get(r.category)!;
      const found = await client.query(
        `SELECT id FROM public.services
         WHERE altegio_service_id=$1::bigint
            OR (lower(trim(name))=lower(trim($2::text)) AND service_type_id=$3::integer)
         ORDER BY CASE WHEN altegio_service_id=$1::bigint THEN 0 ELSE 1 END, is_active DESC NULLS LAST LIMIT 1`,
        [altegioId,r.name,typeId]
      );
      const payload = JSON.stringify({category:r.category,altegioServiceId:altegioId,apiId:r.apiId});
      let serviceId: string;
      if (found.rowCount) {
        serviceId=String(found.rows[0].id);
        await client.query(
          `UPDATE public.services SET
             name=$2::text,
             code=COALESCE(NULLIF(code,''),$3::text),
             short_name=COALESCE(NULLIF($4::text,''),short_name),
             service_type_id=$5::integer,
             base_price=$6::numeric,
             list_price=COALESCE($7::numeric,$6::numeric),
             currency=COALESCE(NULLIF(currency,''),'HUF'),
             duration_minutes=$8::integer,
             description_short=COALESCE($9::text,description_short),
             altegio_service_id=$10::bigint,
             altegio_api_id=$11::text,
             receipt_name=$12::text,
             online_name=$13::text,
             price_from=$6::numeric,
             price_to=$7::numeric,
             source_system='altegio',
             source_payload=$14::jsonb,
             imported_at=now(), updated_at=now()
           WHERE id=$1::uuid`,
          [serviceId,r.name,`ALT-${altegioId}`,r.onlineName,typeId,r.priceFrom,r.priceTo,def.durationMinutes,r.description,altegioId,r.apiId,r.receiptName,r.onlineName,payload]
        );
        updatedServices++;
      } else {
        const ins = await client.query(
          `INSERT INTO public.services(
             name,code,short_name,service_type_id,parent_service_id,
             base_price,list_price,currency,duration_minutes,description_short,description_long,
             online_bookable,is_active,is_combo,altegio_service_id,altegio_api_id,receipt_name,online_name,
             price_from,price_to,source_system,source_payload,imported_at
           ) VALUES(
             $1::text,$2::text,$3::text,$4::integer,NULL,
             $5::numeric,COALESCE($6::numeric,$5::numeric),'HUF',$7::integer,$8::text,NULL,
             true,true,false,$9::bigint,$10::text,$11::text,$12::text,
             $5::numeric,$6::numeric,'altegio',$13::jsonb,now()
           ) RETURNING id`,
          [r.name,`ALT-${altegioId}`,r.onlineName,typeId,r.priceFrom,r.priceTo,def.durationMinutes,r.description,altegioId,r.apiId,r.receiptName,r.onlineName,payload]
        );
        serviceId=String(ins.rows[0].id); createdServices++;
      }

      await client.query(`DELETE FROM public.service_altegio_staff_variants WHERE service_id=$1::uuid`,[serviceId]);
      const staffMap=new Map<string,number>();
      for (const v of variants) {
        if (!v.staffField || v.staffField.toLocaleLowerCase("hu-HU")==="alapértelmezett") continue;
        for (const token of v.staffField.split(/##|[,;\s]+/)) {
          const staffId=token.trim(); if (staffId) staffMap.set(staffId,v.durationMinutes);
        }
      }
      for (const [staffId,duration] of staffMap) {
        await client.query(
          `INSERT INTO public.service_altegio_staff_variants(service_id,altegio_staff_id,duration_minutes)
           VALUES($1::uuid,$2::text,$3::integer)
           ON CONFLICT(service_id,altegio_staff_id) DO UPDATE SET duration_minutes=EXCLUDED.duration_minutes,updated_at=now()`,
          [serviceId,staffId,duration]
        );
        staffVariants++;
      }
    }

    await client.query(
      `INSERT INTO public.service_import_runs(source_system,filename,source_rows,category_count,service_count,staff_variant_count,created_services,updated_services,imported_by)
       VALUES('altegio',$1::text,$2::integer,$3::integer,$4::integer,$5::integer,$6::integer,$7::integer,$8::text)`,
      [req.file.originalname,rows.length,categories.length,grouped.size,staffVariants,createdServices,updatedServices,(req as any).altegioImportUser || null]
    );
    await client.query("COMMIT");
    return res.json({ok:true,sourceRows:rows.length,categories:categories.length,services:grouped.size,staffVariants,createdServices,updatedServices,hierarchy:"service_types -> services -> staff variants"});
  } catch (e:any) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Altegio V2 import hiba:",e);
    return res.status(500).json({error:"Az Altegio szolgáltatások importja nem sikerült.",detail:e?.message || String(e),code:e?.code || null});
  } finally {
    client.release();
  }
});

router.get("/import/altegio/status", requireImportAdmin, async (_req,res) => {
  try {
    await ensureSchema();
    const [run,c,s,v]=await Promise.all([
      pool.query(`SELECT * FROM public.service_import_runs WHERE source_system='altegio' ORDER BY imported_at DESC LIMIT 1`),
      pool.query(`SELECT count(*)::int n FROM public.service_types WHERE altegio_category_key IS NOT NULL`),
      pool.query(`SELECT count(*)::int n FROM public.services WHERE altegio_service_id IS NOT NULL`),
      pool.query(`SELECT count(*)::int n FROM public.service_altegio_staff_variants`)
    ]);
    res.json({ok:true,lastImport:run.rows[0]||null,categories:c.rows[0]?.n||0,services:s.rows[0]?.n||0,staffVariants:v.rows[0]?.n||0});
  } catch(e:any) {
    res.status(500).json({error:"Az import állapot nem olvasható.",detail:e?.message,code:e?.code});
  }
});

export default router;