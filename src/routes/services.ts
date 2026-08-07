// src/routes/services.ts
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

function requireServiceImportAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = String(req.headers.authorization || "");
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Bejelentkezés szükséges." });

  try {
    const payload: any = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_change_me");
    const role = String(payload?.role || "").toLowerCase();
    const allowed = new Set([
      "admin",
      "superadmin",
      "global_admin",
      "owner",
      "manager",
      "tulajdonos",
    ]);
    if (!allowed.has(role)) {
      return res.status(403).json({ error: "Az Altegio import csak admin jogosultsággal végezhető." });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Érvénytelen vagy lejárt bejelentkezés." });
  }
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function secondsToMinutes(v: unknown): number {
  const seconds = Number(v || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.round(seconds / 60));
}

function normalizeKey(v: string): string {
  return v
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
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

async function ensureAltegioServiceImportSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    ALTER TABLE public.service_types
      ADD COLUMN IF NOT EXISTS altegio_category_key text,
      ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    CREATE INDEX IF NOT EXISTS service_types_altegio_category_key_idx
      ON public.service_types(altegio_category_key);

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

    CREATE UNIQUE INDEX IF NOT EXISTS services_altegio_service_id_uq
      ON public.services(altegio_service_id)
      WHERE altegio_service_id IS NOT NULL;

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

async function getOrCreateServiceType(category: string, order: number): Promise<string> {
  const key = normalizeKey(category);
  const existing = await pool.query(
    `SELECT id FROM public.service_types
     WHERE altegio_category_key = $1 OR lower(name) = lower($2)
     ORDER BY CASE WHEN altegio_category_key = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [key, category]
  );

  if (existing.rowCount) {
    const id = String(existing.rows[0].id);
    await pool.query(
      `UPDATE public.service_types
       SET name = $2, altegio_category_key = $3, display_order = $4, updated_at = now()
       WHERE id = $1`,
      [id, category, key, order]
    );
    return id;
  }

  const inserted = await pool.query(
    `INSERT INTO public.service_types(name, altegio_category_key, display_order)
     VALUES ($1,$2,$3)
     RETURNING id`,
    [category, key, order]
  );
  return String(inserted.rows[0].id);
}

/**
 * POST /api/services/import/altegio
 * Multipart form-data: file=<Altegio services.xlsx>
 *
 * A teljes Altegio szolgáltatás-exportot normalizálja:
 * Kategória -> service_types
 * Egyedi Altegio ID -> services
 * Szakemberenként eltérő időtartam -> service_altegio_staff_variants
 */
router.post(
  "/import/altegio",
  requireServiceImportAdmin,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Az Excel fájl feltöltése kötelező (file mező)." });
    }

    let parsedRows: AltegioRow[] = [];
    try {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) return res.status(400).json({ error: "Az Excel munkafüzet üres." });

      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
        defval: null,
        raw: true,
      });

      const required = ["Kategória", "ID", "Név", "Szakemberek ID azonosítója", "Időtartam"];
      if (raw.length) {
        const cols = new Set(Object.keys(raw[0]));
        const missing = required.filter((h) => !cols.has(h));
        if (missing.length) {
          return res.status(400).json({
            error: `Nem Altegio szolgáltatás-export vagy hiányos fejléc. Hiányzik: ${missing.join(", ")}`,
          });
        }
      }

      parsedRows = raw
        .map((r): AltegioRow | null => {
          const category = text(r["Kategória"]);
          const name = text(r["Név"]);
          const serviceId = numberOrNull(r["ID"]);
          if (!category || !name || serviceId === null) return null;
          return {
            category,
            altegioServiceId: Math.trunc(serviceId),
            name,
            receiptName: text(r["Megnevezés a nyugtán"]),
            onlineName: text(r["Név az online foglaláshoz"]),
            priceFrom: numberOrNull(r["Ár -tól"]),
            priceTo: numberOrNull(r["Ár -ig"]),
            apiId: text(r["API_ID"]),
            description: text(r["Leírás"]),
            staffField: text(r["Szakemberek ID azonosítója"]),
            durationMinutes: secondsToMinutes(r["Időtartam"]),
          };
        })
        .filter((r): r is AltegioRow => r !== null);
    } catch (e) {
      console.error("Altegio Excel parse hiba:", e);
      return res.status(400).json({ error: "Az Excel fájl nem olvasható." });
    }

    if (!parsedRows.length) {
      return res.status(400).json({ error: "A fájlban nincs importálható szolgáltatás." });
    }

    const categoryOrder: string[] = [];
    const seenCategories = new Set<string>();
    for (const r of parsedRows) {
      if (!seenCategories.has(r.category)) {
        seenCategories.add(r.category);
        categoryOrder.push(r.category);
      }
    }

    const byService = new Map<number, AltegioRow[]>();
    for (const row of parsedRows) {
      const group = byService.get(row.altegioServiceId) || [];
      group.push(row);
      byService.set(row.altegioServiceId, group);
    }

    let createdServices = 0;
    let updatedServices = 0;
    let staffVariantCount = 0;

    await pool.query("BEGIN");
    try {
      await ensureAltegioServiceImportSchema();

      const typeIds = new Map<string, string>();
      for (let i = 0; i < categoryOrder.length; i += 1) {
        typeIds.set(categoryOrder[i], await getOrCreateServiceType(categoryOrder[i], i));
      }

      for (const [altegioServiceId, rows] of byService.entries()) {
        const representative = rows[0];
        const defaultRow = rows.find((r) => r.staffField === "Alapértelmezett") || representative;
        const typeId = typeIds.get(representative.category)!;

        let serviceId: string | null = null;
        const byExternal = await pool.query(
          `SELECT id FROM public.services WHERE altegio_service_id = $1 LIMIT 1`,
          [altegioServiceId]
        );

        if (byExternal.rowCount) {
          serviceId = String(byExternal.rows[0].id);
          updatedServices += 1;
        } else {
          const byNameAndType = await pool.query(
            `SELECT id FROM public.services
             WHERE lower(name) = lower($1) AND service_type_id = $2::uuid
             ORDER BY is_active DESC NULLS LAST
             LIMIT 1`,
            [representative.name, typeId]
          );
          if (byNameAndType.rowCount) {
            serviceId = String(byNameAndType.rows[0].id);
            updatedServices += 1;
          }
        }

        const sourcePayload = JSON.stringify({
          category: representative.category,
          altegioServiceId,
          apiId: representative.apiId,
        });

        if (serviceId) {
          await pool.query(
            `UPDATE public.services
             SET name = $2,
                 short_name = COALESCE(NULLIF(short_name,''), $3),
                 service_type_id = $4::uuid,
                 base_price = $5,
                 list_price = COALESCE($6,$5),
                 currency = COALESCE(currency,'HUF'),
                 duration_minutes = $7,
                 description_short = COALESCE($8, description_short),
                 altegio_service_id = $9,
                 altegio_api_id = $10,
                 receipt_name = $11,
                 online_name = $12,
                 price_from = $5,
                 price_to = $6,
                 source_system = 'altegio',
                 source_payload = $13::jsonb,
                 imported_at = now(),
                 updated_at = now()
             WHERE id = $1::uuid`,
            [
              serviceId,
              representative.name,
              representative.onlineName,
              typeId,
              representative.priceFrom,
              representative.priceTo,
              defaultRow.durationMinutes,
              representative.description,
              altegioServiceId,
              representative.apiId,
              representative.receiptName,
              representative.onlineName,
              sourcePayload,
            ]
          );
        } else {
          const inserted = await pool.query(
            `INSERT INTO public.services(
               name, code, short_name, service_type_id, parent_service_id,
               base_price, list_price, currency, duration_minutes,
               description_short, description_long,
               online_bookable, is_active, is_combo,
               altegio_service_id, altegio_api_id,
               receipt_name, online_name, price_from, price_to,
               source_system, source_payload, imported_at
             ) VALUES (
               $1,$2,$3,$4::uuid,NULL,
               $5,COALESCE($6,$5),'HUF',$7,
               $8,NULL,
               true,true,false,
               $9,$10,$11,$12,$5,$6,
               'altegio',$13::jsonb,now()
             ) RETURNING id`,
            [
              representative.name,
              `ALT-${altegioServiceId}`,
              representative.onlineName,
              typeId,
              representative.priceFrom,
              representative.priceTo,
              defaultRow.durationMinutes,
              representative.description,
              altegioServiceId,
              representative.apiId,
              representative.receiptName,
              representative.onlineName,
              sourcePayload,
            ]
          );
          serviceId = String(inserted.rows[0].id);
          createdServices += 1;
        }

        await pool.query(
          `DELETE FROM public.service_altegio_staff_variants WHERE service_id = $1::uuid`,
          [serviceId]
        );

        const staffDurations = new Map<string, number>();
        for (const row of rows) {
          if (!row.staffField || row.staffField === "Alapértelmezett") continue;
          for (const rawStaffId of row.staffField.split("##")) {
            const staffId = rawStaffId.trim();
            if (staffId) staffDurations.set(staffId, row.durationMinutes);
          }
        }

        for (const [staffId, durationMinutes] of staffDurations.entries()) {
          await pool.query(
            `INSERT INTO public.service_altegio_staff_variants(
               service_id, altegio_staff_id, duration_minutes
             ) VALUES ($1::uuid,$2,$3)
             ON CONFLICT(service_id, altegio_staff_id)
             DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes, updated_at = now()`,
            [serviceId, staffId, durationMinutes]
          );
          staffVariantCount += 1;
        }
      }

      const auth = String(req.headers.authorization || "");
      let importedBy: string | null = null;
      try {
        const token = auth.replace(/^Bearer\s+/i, "").trim();
        const payload: any = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_change_me");
        importedBy = text(payload?.email) || text(payload?.id);
      } catch {
        importedBy = null;
      }

      await pool.query(
        `INSERT INTO public.service_import_runs(
           source_system, filename, source_rows, category_count, service_count,
           staff_variant_count, created_services, updated_services, imported_by
         ) VALUES ('altegio',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.file.originalname,
          parsedRows.length,
          categoryOrder.length,
          byService.size,
          staffVariantCount,
          createdServices,
          updatedServices,
          importedBy,
        ]
      );

      await pool.query("COMMIT");
      return res.json({
        ok: true,
        sourceRows: parsedRows.length,
        categories: categoryOrder.length,
        services: byService.size,
        staffVariants: staffVariantCount,
        createdServices,
        updatedServices,
        hierarchy: "service_types -> services -> staff variants",
      });
    } catch (e: any) {
      await pool.query("ROLLBACK");
      console.error("Altegio szolgáltatás import hiba:", e);
      return res.status(500).json({
        error: "Az Altegio szolgáltatások importja nem sikerült.",
        detail: process.env.NODE_ENV === "production" ? undefined : e?.message,
      });
    }
  }
);

/**
 * GET /api/services/import/altegio/status
 */
router.get(
  "/import/altegio/status",
  requireServiceImportAdmin,
  async (_req: Request, res: Response) => {
    try {
      await ensureAltegioServiceImportSchema();
      const [run, categories, services, variants] = await Promise.all([
        pool.query(`SELECT * FROM public.service_import_runs WHERE source_system='altegio' ORDER BY imported_at DESC LIMIT 1`),
        pool.query(`SELECT count(*)::int AS n FROM public.service_types WHERE altegio_category_key IS NOT NULL`),
        pool.query(`SELECT count(*)::int AS n FROM public.services WHERE altegio_service_id IS NOT NULL`),
        pool.query(`SELECT count(*)::int AS n FROM public.service_altegio_staff_variants`),
      ]);
      return res.json({
        ok: true,
        lastImport: run.rows[0] || null,
        categories: categories.rows[0]?.n || 0,
        services: services.rows[0]?.n || 0,
        staffVariants: variants.rows[0]?.n || 0,
      });
    } catch (e) {
      console.error("Altegio import status hiba:", e);
      return res.status(500).json({ error: "Az import állapot nem olvasható." });
    }
  }
);

// Segédfüggvény – ugyanazt a shape-et adja vissza, mint amit a frontend vár
function mapServiceRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    short_name: row.short_name,
    description: row.description_short ?? row.description_long ?? null,
    description_short: row.description_short,
    description_long: row.description_long,
    service_type_id: row.service_type_id,
    service_type_name: row.service_type_name,
    parent_service_id: row.parent_service_id,
    parent_service_name: row.parent_service_name,
    base_price: row.base_price,
    list_price: row.list_price,
    currency: row.currency,
    duration_minutes: row.duration_minutes,
    wait_duration_min: row.wait_duration_min,
    promo_price: row.promo_price,
    promo_valid_from: row.promo_valid_from,
    promo_valid_to: row.promo_valid_to,
    promo_label: row.promo_label,
    online_bookable: row.online_bookable,
    is_active: row.is_active,
    is_combo: row.is_combo,
    altegio_service_id: row.altegio_service_id,
    receipt_name: row.receipt_name,
    online_name: row.online_name,
    price_from: row.price_from,
    price_to: row.price_to,
  };
}

/**
 * GET /api/services?include_inactive=1
 * Admin lista, ServicesList.tsx ezt használja
 */
router.get("/", async (req: Request, res: Response) => {
  const includeInactive = req.query.include_inactive === "1";

  const sql = `
    SELECT
      s.id,
      s.name,
      s.code,
      s.short_name,
      s.description_short,
      s.description_long,
      s.service_type_id,
      st.name AS service_type_name,
      s.parent_service_id,
      ps.name AS parent_service_name,
      s.base_price,
      s.list_price,
      s.currency,
      s.duration_minutes,
      s.wait_duration_min,
      s.promo_price,
      s.promo_valid_from,
      s.promo_valid_to,
      s.promo_label,
      s.online_bookable,
      s.is_active,
      s.is_combo,
      s.altegio_service_id,
      s.receipt_name,
      s.online_name,
      s.price_from,
      s.price_to
    FROM public.services s
    LEFT JOIN public.service_types st ON st.id = s.service_type_id
    LEFT JOIN public.services ps ON ps.id = s.parent_service_id
    WHERE ($1::boolean) OR s.is_active = true
    ORDER BY COALESCE(st.display_order, 999999), st.name, s.name;
  `;

  try {
    await ensureAltegioServiceImportSchema();
    const result = await pool.query(sql, [includeInactive]);
    res.json(result.rows.map(mapServiceRow));
  } catch (err) {
    console.error("GET /services hiba:", err);
    res.status(500).json({ error: "Nem sikerült a szolgáltatásokat betölteni." });
  }
});

/**
 * GET /api/services/available
 * Dolgozó felvétel / hozzárendelés (EmployeeCreateModal, EmployeeNewModal)
 */
router.get("/available", async (_req: Request, res: Response) => {
  const sql = `
    SELECT
      s.id,
      s.name,
      s.short_name,
      s.duration_minutes,
      s.base_price,
      s.list_price
    FROM public.services s
    WHERE s.is_active = true
      AND s.online_bookable = true
    ORDER BY s.name;
  `;

  try {
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /services/available hiba:", err);
    res.status(500).json({ error: "Nem sikerült a szolgáltatásokat betölteni." });
  }
});

/**
 * GET /api/services/:id
 * Részletes betöltés szerkesztéshez (ServiceEditModal)
 */
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const sql = `
    SELECT
      s.id,
      s.name,
      s.code,
      s.short_name,
      s.description_short,
      s.description_long,
      s.service_type_id,
      st.name AS service_type_name,
      s.parent_service_id,
      ps.name AS parent_service_name,
      s.base_price,
      s.list_price,
      s.currency,
      s.duration_minutes,
      s.wait_duration_min,
      s.promo_price,
      s.promo_valid_from,
      s.promo_valid_to,
      s.promo_label,
      s.online_bookable,
      s.is_active,
      s.is_combo,
      s.altegio_service_id,
      s.receipt_name,
      s.online_name,
      s.price_from,
      s.price_to
    FROM public.services s
    LEFT JOIN public.service_types st ON st.id = s.service_type_id
    LEFT JOIN public.services ps ON ps.id = s.parent_service_id
    WHERE s.id = $1::uuid;
  `;

  try {
    const result = await pool.query(sql, [id]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Nincs ilyen szolgáltatás." });
    }
    res.json(mapServiceRow(result.rows[0]));
  } catch (err) {
    console.error("GET /services/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatást." });
  }
});

/**
 * POST /api/services
 * Új szolgáltatás felvétele (ServiceNewModal)
 */
router.post("/", async (req: Request, res: Response) => {
  const {
    name,
    code,
    short_name,
    service_type_id,
    parent_service_id,
    base_price,
    list_price,
    currency,
    duration_minutes,
    wait_duration_min,
    description_short,
    description_long,
    promo_price,
    promo_valid_from,
    promo_valid_to,
    promo_label,
    online_bookable = true,
    is_active = true,
    is_combo = false,
  } = req.body || {};

  if (!name || !duration_minutes) {
    return res.status(400).json({
      error: "A név és az időtartam (perc) kötelező.",
    });
  }

  const sql = `
    INSERT INTO public.services (
      name,
      code,
      short_name,
      service_type_id,
      parent_service_id,
      base_price,
      list_price,
      currency,
      duration_minutes,
      wait_duration_min,
      description_short,
      description_long,
      promo_price,
      promo_valid_from,
      promo_valid_to,
      promo_label,
      online_bookable,
      is_active,
      is_combo
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::uuid,
      $5::uuid,
      $6,
      COALESCE($7, $6),
      COALESCE($8, 'HUF'),
      $9,
      $10,
      $11,
      $12,
      $13,
      $14::date,
      $15::date,
      $16,
      $17,
      $18,
      $19
    )
    RETURNING *;
  `;

  const params = [
    name,
    code || null,
    short_name || null,
    service_type_id || null,
    parent_service_id || null,
    base_price ?? null,
    list_price ?? null,
    currency || "HUF",
    duration_minutes,
    wait_duration_min ?? null,
    description_short || null,
    description_long || null,
    promo_price ?? null,
    promo_valid_from || null,
    promo_valid_to || null,
    promo_label || null,
    online_bookable,
    is_active,
    is_combo,
  ];

  try {
    const result = await pool.query(sql, params);
    const row = mapServiceRow(result.rows[0]);
    res.status(201).json(row);
  } catch (err) {
    console.error("POST /services hiba:", err);
    res.status(500).json({ error: "Nem sikerült létrehozni az új szolgáltatást." });
  }
});

/**
 * PATCH /api/services/:id
 * Szolgáltatás módosítása (ServiceEditModal)
 */
router.patch("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const {
    name,
    code,
    short_name,
    service_type_id,
    parent_service_id,
    base_price,
    list_price,
    currency,
    duration_minutes,
    wait_duration_min,
    description_short,
    description_long,
    promo_price,
    promo_valid_from,
    promo_valid_to,
    promo_label,
    online_bookable,
    is_active,
    is_combo,
  } = req.body || {};

  const sql = `
    UPDATE public.services s
    SET
      name              = COALESCE($2, s.name),
      code              = $3,
      short_name        = $4,
      service_type_id   = $5::uuid,
      parent_service_id = $6::uuid,
      base_price        = $7,
      list_price        = $8,
      currency          = COALESCE($9, s.currency),
      duration_minutes  = COALESCE($10, s.duration_minutes),
      wait_duration_min = $11,
      description_short = $12,
      description_long  = $13,
      promo_price       = $14,
      promo_valid_from  = $15::date,
      promo_valid_to    = $16::date,
      promo_label       = $17,
      online_bookable   = COALESCE($18, s.online_bookable),
      is_active         = COALESCE($19, s.is_active),
      is_combo          = COALESCE($20, s.is_combo),
      updated_at        = now()
    WHERE s.id = $1::uuid
    RETURNING *;
  `;

  const params = [
    id,
    name ?? null,
    code ?? null,
    short_name ?? null,
    service_type_id || null,
    parent_service_id || null,
    base_price ?? null,
    list_price ?? null,
    currency || null,
    duration_minutes ?? null,
    wait_duration_min ?? null,
    description_short ?? null,
    description_long ?? null,
    promo_price ?? null,
    promo_valid_from || null,
    promo_valid_to || null,
    promo_label ?? null,
    online_bookable,
    is_active,
    is_combo,
  ];

  try {
    const result = await pool.query(sql, params);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Nincs ilyen szolgáltatás." });
    }
    res.json(mapServiceRow(result.rows[0]));
  } catch (err) {
    console.error("PATCH /services/:id hiba:", err);
    res.status(500).json({ error: "Nem sikerült frissíteni a szolgáltatást." });
  }
});

/**
 * POST /api/services/reprice
 * Teljes szolgáltatási paletta átárazása (pl. +10%)
 * body: { percent: number, round_to?: number, service_type_id?: string }
 */
router.post("/reprice", async (req: Request, res: Response) => {
  const { percent, round_to, service_type_id } = req.body || {};

  if (typeof percent !== "number") {
    return res.status(400).json({ error: "percent (százalék) kötelező." });
  }

  const factor = 1 + percent / 100;
  const roundTo = typeof round_to === "number" && round_to > 0 ? round_to : 10;

  const sql = `
    UPDATE public.services s
    SET list_price = CASE
      WHEN list_price IS NULL THEN NULL
      ELSE ROUND(list_price * $1 / $2) * $2
    END,
    updated_at = now()
    WHERE s.is_active = true
      AND ($3::uuid IS NULL OR s.service_type_id = $3);
  `;

  try {
    await pool.query("BEGIN");
    await pool.query(sql, [factor, roundTo, service_type_id || null]);
    await pool.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("POST /services/reprice hiba:", err);
    res.status(500).json({ error: "Nem sikerült az átárazás." });
  }
});

export default router;
