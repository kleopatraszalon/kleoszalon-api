"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/services.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// Segédfüggvény – ugyanazt a shape-et adja vissza, mint amit a frontend vár
function mapServiceRow(row) {
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
    };
}
/**
 * GET /api/services?include_inactive=1
 * Admin lista, ServicesList.tsx ezt használja
 */
router.get("/", async (req, res) => {
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
      s.is_combo
    FROM public.services s
    LEFT JOIN public.service_types st ON st.id = s.service_type_id
    LEFT JOIN public.services ps ON ps.id = s.parent_service_id
    WHERE ($1::boolean) OR s.is_active = true
    ORDER BY COALESCE(ps.name, s.name), s.name;
  `;
    try {
        const result = await db_1.default.query(sql, [includeInactive]);
        res.json(result.rows.map(mapServiceRow));
    }
    catch (err) {
        console.error("GET /services hiba:", err);
        res.status(500).json({ error: "Nem sikerült a szolgáltatásokat betölteni." });
    }
});
/**
 * GET /api/services/available
 * Dolgozó felvétel / hozzárendelés (EmployeeCreateModal, EmployeeNewModal)
 */
router.get("/available", async (_req, res) => {
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
        const result = await db_1.default.query(sql);
        res.json(result.rows);
    }
    catch (err) {
        console.error("GET /services/available hiba:", err);
        res.status(500).json({ error: "Nem sikerült a szolgáltatásokat betölteni." });
    }
});
/**
 * GET /api/services/:id
 * Részletes betöltés szerkesztéshez (ServiceEditModal)
 */
router.get("/:id", async (req, res) => {
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
      s.is_combo
    FROM public.services s
    LEFT JOIN public.service_types st ON st.id = s.service_type_id
    LEFT JOIN public.services ps ON ps.id = s.parent_service_id
    WHERE s.id = $1::uuid;
  `;
    try {
        const result = await db_1.default.query(sql, [id]);
        if (!result.rowCount) {
            return res.status(404).json({ error: "Nincs ilyen szolgáltatás." });
        }
        res.json(mapServiceRow(result.rows[0]));
    }
    catch (err) {
        console.error("GET /services/:id hiba:", err);
        res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatást." });
    }
});
/**
 * POST /api/services
 * Új szolgáltatás felvétele (ServiceNewModal)
 */
router.post("/", async (req, res) => {
    const { name, code, short_name, service_type_id, parent_service_id, base_price, list_price, currency, duration_minutes, wait_duration_min, description_short, description_long, promo_price, promo_valid_from, promo_valid_to, promo_label, online_bookable = true, is_active = true, is_combo = false, } = req.body || {};
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
        const result = await db_1.default.query(sql, params);
        const row = mapServiceRow(result.rows[0]);
        res.status(201).json(row);
    }
    catch (err) {
        console.error("POST /services hiba:", err);
        res.status(500).json({ error: "Nem sikerült létrehozni az új szolgáltatást." });
    }
});
/**
 * PATCH /api/services/:id
 * Szolgáltatás módosítása (ServiceEditModal)
 */
router.patch("/:id", async (req, res) => {
    const { id } = req.params;
    const { name, code, short_name, service_type_id, parent_service_id, base_price, list_price, currency, duration_minutes, wait_duration_min, description_short, description_long, promo_price, promo_valid_from, promo_valid_to, promo_label, online_bookable, is_active, is_combo, } = req.body || {};
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
        const result = await db_1.default.query(sql, params);
        if (!result.rowCount) {
            return res.status(404).json({ error: "Nincs ilyen szolgáltatás." });
        }
        res.json(mapServiceRow(result.rows[0]));
    }
    catch (err) {
        console.error("PATCH /services/:id hiba:", err);
        res.status(500).json({ error: "Nem sikerült frissíteni a szolgáltatást." });
    }
});
/**
 * POST /api/services/reprice
 * Teljes szolgáltatási paletta átárazása (pl. +10%)
 * body: { percent: number, round_to?: number, service_type_id?: string }
 */
router.post("/reprice", async (req, res) => {
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
        await db_1.default.query("BEGIN");
        await db_1.default.query(sql, [factor, roundTo, service_type_id || null]);
        await db_1.default.query("COMMIT");
        res.json({ ok: true });
    }
    catch (err) {
        await db_1.default.query("ROLLBACK");
        console.error("POST /services/reprice hiba:", err);
        res.status(500).json({ error: "Nem sikerült az átárazás." });
    }
});
exports.default = router;
