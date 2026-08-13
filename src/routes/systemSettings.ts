import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireAdmin, requireManagement } from "../middleware/requireRoles";
import { ensureOnlineBooking } from "../booking/ensureOnlineBooking";

type SettingType = "number" | "boolean" | "text" | "time";
type SettingScope = "global" | "location";
type SettingStorage = "system" | "online_booking";

type SettingDefinition = {
  key: string;
  category: string;
  category_label: string;
  label: string;
  description: string;
  type: SettingType;
  scope: SettingScope;
  storage: SettingStorage;
  column?: string;
  defaultValue: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  spec_reference?: string;
};

const router = Router();
let schemaReady: Promise<void> | null = null;

const DEFINITIONS: SettingDefinition[] = [
  {
    key: "booking.online_discount_percent",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Online bejelentkezők kedvezménye",
    description: "Az online felületről érkező foglalások szolgáltatási kedvezménye. A specifikáció jelenlegi alapértéke 5%.",
    type: "number",
    scope: "location",
    storage: "online_booking",
    column: "online_discount_percent",
    defaultValue: 5,
    min: 0,
    max: 100,
    step: 0.5,
    unit: "%",
    spec_reference: "Spec. 18. Beállítások; online bejelentkezők kedvezménye",
  },
  {
    key: "booking.enabled",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Online foglalás engedélyezve",
    description: "Szalononként kapcsolható az online időpontfoglalás elérhetősége.",
    type: "boolean",
    scope: "location",
    storage: "online_booking",
    column: "enabled",
    defaultValue: true,
  },
  {
    key: "booking.slot_interval_minutes",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Online foglalási időrács",
    description: "A publikus foglaló által felkínált időpontok lépésköze percben.",
    type: "number",
    scope: "location",
    storage: "online_booking",
    column: "slot_interval_minutes",
    defaultValue: 15,
    min: 5,
    max: 120,
    step: 5,
    unit: "perc",
  },
  {
    key: "booking.opening_time",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Online foglalás napi kezdete",
    description: "A publikus foglaló legkorábbi felkínálható időpontja.",
    type: "time",
    scope: "location",
    storage: "online_booking",
    column: "opening_minute",
    defaultValue: "08:00",
  },
  {
    key: "booking.closing_time",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Online foglalás napi vége",
    description: "A publikus foglaló legkésőbbi felkínálható időpontja.",
    type: "time",
    scope: "location",
    storage: "online_booking",
    column: "closing_minute",
    defaultValue: "20:00",
  },
  {
    key: "booking.booking_horizon_days",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Foglalási horizont",
    description: "Ennyi nappal előre lehet online időpontot foglalni.",
    type: "number",
    scope: "location",
    storage: "online_booking",
    column: "booking_horizon_days",
    defaultValue: 60,
    min: 1,
    max: 365,
    step: 1,
    unit: "nap",
  },
  {
    key: "booking.minimum_notice_minutes",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Minimális előfoglalási idő",
    description: "Az aktuális időponthoz képest ennyivel későbbi időpont ajánlható fel legkorábban.",
    type: "number",
    scope: "location",
    storage: "online_booking",
    column: "minimum_notice_minutes",
    defaultValue: 60,
    min: 0,
    max: 10080,
    step: 15,
    unit: "perc",
  },
  {
    key: "booking.require_staff_confirmation",
    category: "booking",
    category_label: "Bejelentkezések és online foglalás",
    label: "Munkatársi visszaigazolás szükséges",
    description: "Az online foglalás véglegesítéséhez kérjen-e a rendszer belső megerősítést.",
    type: "boolean",
    scope: "location",
    storage: "online_booking",
    column: "require_staff_confirmation",
    defaultValue: true,
  },
  {
    key: "equipment.service_warning_days",
    category: "equipment",
    category_label: "Eszközök és karbantartás",
    label: "Szerviz figyelmeztetés",
    description: "A rendszer ennyi nappal a következő szerviz előtt jelezze az esedékességet.",
    type: "number",
    scope: "global",
    storage: "system",
    defaultValue: 30,
    min: 0,
    max: 365,
    step: 1,
    unit: "nap",
    spec_reference: "Spec. 3.10. Eszközök és 18. Beállítások",
  },
  {
    key: "finance.cash_variance_warning_huf",
    category: "finance",
    category_label: "Pénzügy és pénztár",
    label: "Kasszaeltérés figyelmeztetési határ",
    description: "A zárási előzményekben ettől az abszolút eltéréstől jelenjen meg kiemelt pénzügyi figyelmeztetés.",
    type: "number",
    scope: "global",
    storage: "system",
    defaultValue: 1000,
    min: 0,
    max: 1000000,
    step: 100,
    unit: "Ft",
  },
  {
    key: "supplier.shelf_life_warning_days",
    category: "supplier",
    category_label: "Beszállítók és szavatosság",
    label: "Szavatossági figyelmeztetés",
    description: "Központi alapérték a beszállítói termékek lejárati figyelmeztetéséhez.",
    type: "number",
    scope: "global",
    storage: "system",
    defaultValue: 30,
    min: 0,
    max: 730,
    step: 1,
    unit: "nap",
    spec_reference: "Spec. 3.13.2. Beszállítók automatikus szavatossági figyelmeztetése",
  },
];

const byKey = new Map(DEFINITIONS.map((item) => [item.key, item]));
const onlineColumns = new Set(DEFINITIONS.filter((item) => item.storage === "online_booking").map((item) => item.column));

function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "");
}

function timeFromMinute(value: unknown) {
  const n = Math.max(0, Math.min(1439, Number(value ?? 0)));
  const hours = Math.floor(n / 60);
  const minutes = n % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minuteFromTime(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw Object.assign(new Error("Érvénytelen időformátum. HH:MM szükséges."), { status: 400 });
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw Object.assign(new Error("Érvénytelen időpont."), { status: 400 });
  }
  return hours * 60 + minutes;
}

function normalize(def: SettingDefinition, raw: unknown) {
  if (def.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (["true", "1", "yes", "on"].includes(String(raw).toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(String(raw).toLowerCase())) return false;
    throw Object.assign(new Error(`${def.label}: logikai érték szükséges.`), { status: 400 });
  }
  if (def.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`${def.label}: számérték szükséges.`), { status: 400 });
    if (def.min != null && value < def.min) throw Object.assign(new Error(`${def.label}: minimum ${def.min}.`), { status: 400 });
    if (def.max != null && value > def.max) throw Object.assign(new Error(`${def.label}: maximum ${def.max}.`), { status: 400 });
    return value;
  }
  if (def.type === "time") return timeFromMinute(minuteFromTime(raw));
  return String(raw ?? "").trim();
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          key text NOT NULL,
          scope_type text NOT NULL DEFAULT 'global',
          scope_id text NOT NULL DEFAULT '*',
          value jsonb NOT NULL,
          category text NOT NULL,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(key,scope_type,scope_id)
        );
        CREATE TABLE IF NOT EXISTS system_settings_audit (
          id bigserial PRIMARY KEY,
          key text NOT NULL,
          scope_type text NOT NULL,
          scope_id text NOT NULL,
          old_value jsonb,
          new_value jsonb,
          actor text,
          note text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS system_settings_audit_lookup_idx
          ON system_settings_audit(key,created_at DESC);
      `);
      for (const def of DEFINITIONS.filter((item) => item.storage === "system")) {
        await db.query(
          `INSERT INTO system_settings(key,scope_type,scope_id,value,category)
           VALUES($1,'global','*',$2::jsonb,$3)
           ON CONFLICT(key,scope_type,scope_id) DO NOTHING`,
          [def.key, JSON.stringify(def.defaultValue), def.category],
        );
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function systemValue(def: SettingDefinition) {
  const row = (
    await db.query(
      `SELECT value,updated_by,updated_at FROM system_settings
       WHERE key=$1 AND scope_type='global' AND scope_id='*' LIMIT 1`,
      [def.key],
    )
  ).rows[0];
  return {
    value: row?.value ?? def.defaultValue,
    source: row ? "global" : "default",
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function bookingRow(locationId: string) {
  await ensureOnlineBooking();
  return (
    await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid LIMIT 1`, [locationId])
  ).rows[0] ?? null;
}

function responseValue(def: SettingDefinition, row: any) {
  if (!row || !def.column) return def.defaultValue;
  const raw = row[def.column];
  if (def.type === "time") return timeFromMinute(raw);
  if (def.type === "number") return Number(raw ?? def.defaultValue);
  if (def.type === "boolean") return Boolean(raw);
  return raw ?? def.defaultValue;
}

async function auditChange(req: AuthRequest, def: SettingDefinition, scopeType: string, scopeId: string, oldValue: unknown, newValue: unknown, note?: string) {
  await db.query(
    `INSERT INTO system_settings_audit(key,scope_type,scope_id,old_value,new_value,actor,note)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
    [def.key, scopeType, scopeId, oldValue === undefined ? null : JSON.stringify(oldValue), JSON.stringify(newValue), actor(req), note || null],
  );
}

router.use(requireAuth, requireManagement);

router.get("/catalog", async (req: AuthRequest, res, next) => {
  try {
    await ensureSchema();
    const locationId = String(req.query.location_id || "").trim();
    let booking: any = null;
    if (locationId) booking = await bookingRow(locationId);
    const items = [];
    for (const def of DEFINITIONS) {
      if (def.storage === "system") {
        const current = await systemValue(def);
        items.push({ ...def, ...current, editable: true });
      } else {
        items.push({
          ...def,
          value: locationId ? responseValue(def, booking) : def.defaultValue,
          source: locationId ? "location" : "default",
          updated_by: null,
          updated_at: booking?.updated_at ?? null,
          editable: Boolean(locationId),
        });
      }
    }
    const categories = Array.from(new Map(DEFINITIONS.map((item) => [item.category, item.category_label])).entries())
      .map(([key, label]) => ({ key, label }));
    res.json({
      categories,
      settings: items,
      selected_location_id: locationId || null,
      specification: {
        online_discount_percent: 5,
        service_warning_days_configurable: true,
      },
    });
  } catch (error) { next(error); }
});

router.put("/:key", requireAdmin, async (req: AuthRequest, res: Response, next) => {
  try {
    await ensureSchema();
    const def = byKey.get(String(req.params.key || ""));
    if (!def) return res.status(404).json({ message: "Ismeretlen rendszerbeállítás." });
    const value = normalize(def, req.body?.value);
    const note = String(req.body?.note || "").trim();

    if (def.storage === "system") {
      const previous = await systemValue(def);
      await db.query(
        `INSERT INTO system_settings(key,scope_type,scope_id,value,category,updated_by,updated_at)
         VALUES($1,'global','*',$2::jsonb,$3,$4,now())
         ON CONFLICT(key,scope_type,scope_id) DO UPDATE SET
           value=EXCLUDED.value,category=EXCLUDED.category,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [def.key, JSON.stringify(value), def.category, actor(req)],
      );
      await auditChange(req, def, "global", "*", previous.value, value, note);
      return res.json({ ok: true, key: def.key, value, scope: "global" });
    }

    if (!def.column || !onlineColumns.has(def.column)) return res.status(500).json({ message: "A beállítás tárolási definíciója hibás." });
    await ensureOnlineBooking();
    const applyToAll = Boolean(req.body?.apply_to_all);
    const locationId = String(req.body?.location_id || "").trim();
    if (!applyToAll && !locationId) return res.status(400).json({ message: "A telephely kiválasztása kötelező." });
    const dbValue = def.type === "time" ? minuteFromTime(value) : value;

    if (applyToAll) {
      const previousRows = await db.query(`SELECT location_id::text,${def.column} value FROM online_booking_settings ORDER BY location_id`);
      await db.query(
        `INSERT INTO online_booking_settings(location_id,${def.column},updated_at)
         SELECT id,$1,now() FROM locations WHERE COALESCE(is_active,true)=true
         ON CONFLICT(location_id) DO UPDATE SET ${def.column}=EXCLUDED.${def.column},updated_at=now()`,
        [dbValue],
      );
      await auditChange(req, def, "all_locations", "*", previousRows.rows, value, note || "Alkalmazva minden aktív szalonra");
      return res.json({ ok: true, key: def.key, value, scope: "all_locations" });
    }

    const before = await bookingRow(locationId);
    await db.query(
      `INSERT INTO online_booking_settings(location_id,${def.column},updated_at)
       VALUES($1::uuid,$2,now())
       ON CONFLICT(location_id) DO UPDATE SET ${def.column}=EXCLUDED.${def.column},updated_at=now()`,
      [locationId, dbValue],
    );
    await auditChange(req, def, "location", locationId, responseValue(def, before), value, note);
    return res.json({ ok: true, key: def.key, value, scope: "location", location_id: locationId });
  } catch (error) { next(error); }
});

router.get("/alerts/summary", async (_req: AuthRequest, res, next) => {
  try {
    await ensureSchema();
    const serviceDef = byKey.get("equipment.service_warning_days")!;
    const varianceDef = byKey.get("finance.cash_variance_warning_huf")!;
    const serviceDays = Number((await systemValue(serviceDef)).value || serviceDef.defaultValue);
    const varianceLimit = Number((await systemValue(varianceDef)).value || varianceDef.defaultValue);

    const equipmentTable = Boolean((await db.query(`SELECT to_regclass('public.master_equipment') IS NOT NULL ok`)).rows[0]?.ok);
    const financeTable = Boolean((await db.query(`SELECT to_regclass('public.cash_register_close_reports') IS NOT NULL ok`)).rows[0]?.ok);

    const equipment = equipmentTable
      ? (await db.query(
          `SELECT id::text,item_number,name,next_service_at,warranty_end
           FROM master_equipment
           WHERE COALESCE(active,true)=true
             AND next_service_at IS NOT NULL
             AND next_service_at::date <= current_date + $1::int
           ORDER BY next_service_at NULLS LAST,name LIMIT 25`,
          [Math.max(0, Math.round(serviceDays))],
        )).rows
      : [];

    const cashVariances = financeTable
      ? (await db.query(
          `SELECT id::text,report_no,location_id,location_name,business_date,difference,closed_at
           FROM cash_register_close_reports
           WHERE closed_at >= now() - interval '30 days'
             AND abs(COALESCE(difference,0)) >= $1::numeric
           ORDER BY abs(COALESCE(difference,0)) DESC,closed_at DESC LIMIT 25`,
          [Math.max(0, varianceLimit)],
        )).rows
      : [];

    res.json({
      equipment: { warning_days: serviceDays, count: equipment.length, items: equipment },
      finance: { variance_warning_huf: varianceLimit, count: cashVariances.length, items: cashVariances },
    });
  } catch (error) { next(error); }
});

router.get("/audit/recent", async (req: AuthRequest, res, next) => {
  try {
    await ensureSchema();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const rows = (
      await db.query(
        `SELECT id,key,scope_type,scope_id,old_value,new_value,actor,note,created_at
         FROM system_settings_audit ORDER BY created_at DESC LIMIT $1`,
        [limit],
      )
    ).rows;
    res.json(rows);
  } catch (error) { next(error); }
});

export default router;
