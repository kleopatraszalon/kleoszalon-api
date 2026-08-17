import { Router, Response } from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import pool from "../db";
import { AuthRequest } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";
import { ensureProductTaxonomySchema } from "../inventory/ensureProductTaxonomy";

const router = Router();
export const fitnessOticBridgeRouter = Router();
const TZ = "Europe/Budapest";
const FITNESS_SCOPE = "GYONGYOS_FITNESS";
const FITNESS_GROUP_CODE = "KLEO_FITNESS_GYONGYOS";
const FITNESS_CATEGORY_CODE = "KLEO_FITNESS_GYONGYOS_PRODUCTS";
const ACCESS_MODES = new Set(["DAYTIME", "24_7", "CUSTOM"]);
const MEMBERSHIP_STATUSES = new Set(["ACTIVE", "PAUSED", "CANCELLED", "EXPIRED"]);
const EQUIPMENT_STATUSES = new Set(["ACTIVE", "MAINTENANCE", "OUT_OF_ORDER", "RETIRED"]);
const MAINTENANCE_TYPES = new Set(["PREVENTIVE", "REPAIR", "INSPECTION"]);
const DISCOUNT_TYPES = new Set(["PERCENT", "FIXED"]);
let schemaPromise: Promise<void> | null = null;

const actor = (req: AuthRequest) => String(req.user?.email || req.user?.id || "");
const hash = (value: unknown) => createHash("sha256").update(String(value ?? "").trim()).digest("hex");
const cleanCard = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, "");
const roles = (req: AuthRequest) => parseRoleKeys(req.user?.role);
const isAdmin = (req: AuthRequest) => roles(req).includes("admin");
const isReceptionist = (req: AuthRequest) => roles(req).includes("receptionist");
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const int = (value: unknown, fallback: number, min = 0, max = 3650) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

async function ensureFitnessSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vir_fitness_settings(
        scope_key text PRIMARY KEY,
        location_id uuid,
        is_24_7_enabled boolean NOT NULL DEFAULT true,
        otic_enabled boolean NOT NULL DEFAULT false,
        otic_mode text NOT NULL DEFAULT 'LOCAL_BRIDGE',
        otic_bridge_token_hash text,
        otic_last_heartbeat_at timestamptz,
        otic_last_source text,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_membership_plans(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL,
        name text NOT NULL,
        duration_days integer NOT NULL DEFAULT 30,
        price numeric(14,2) NOT NULL DEFAULT 0,
        currency text NOT NULL DEFAULT 'HUF',
        access_mode text NOT NULL DEFAULT 'DAYTIME',
        access_start_time time NOT NULL DEFAULT '06:00',
        access_end_time time NOT NULL DEFAULT '22:00',
        allowed_weekdays smallint[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::smallint[],
        is_active boolean NOT NULL DEFAULT true,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_memberships(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL,
        client_id text,
        member_name text NOT NULL,
        email text,
        phone text,
        plan_id uuid REFERENCES vir_fitness_membership_plans(id),
        valid_from date NOT NULL DEFAULT CURRENT_DATE,
        valid_until date NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE',
        card_uid_hash text,
        card_last4 text,
        notes text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vir_fitness_membership_card_uq ON vir_fitness_memberships(location_id,card_uid_hash) WHERE card_uid_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS vir_fitness_membership_valid_idx ON vir_fitness_memberships(location_id,status,valid_until);
      CREATE TABLE IF NOT EXISTS vir_fitness_access_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL,
        membership_id uuid REFERENCES vir_fitness_memberships(id),
        occurred_at timestamptz NOT NULL DEFAULT now(),
        direction text NOT NULL DEFAULT 'UNKNOWN',
        device_id text,
        controller_id text,
        door_id text,
        event_type text,
        decision text NOT NULL,
        reason text,
        card_uid_hash text,
        dedupe_key text NOT NULL UNIQUE,
        raw_event jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vir_fitness_access_events_loc_time_idx ON vir_fitness_access_events(location_id,occurred_at DESC);
      CREATE TABLE IF NOT EXISTS vir_fitness_promotions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL,
        title text NOT NULL,
        description text,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        discount_type text NOT NULL DEFAULT 'PERCENT',
        discount_value numeric(14,2) NOT NULL DEFAULT 0,
        membership_plan_id uuid REFERENCES vir_fitness_membership_plans(id),
        product_id uuid,
        is_active boolean NOT NULL DEFAULT true,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_equipment(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL,
        asset_code text NOT NULL,
        name text NOT NULL,
        manufacturer text,
        model text,
        serial_number text,
        location_area text,
        commissioned_on date,
        maintenance_interval_days integer NOT NULL DEFAULT 90,
        last_maintenance_on date,
        next_maintenance_on date,
        status text NOT NULL DEFAULT 'ACTIVE',
        notes text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(location_id,asset_code)
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_equipment_maintenance(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        equipment_id uuid NOT NULL REFERENCES vir_fitness_equipment(id) ON DELETE CASCADE,
        performed_on date NOT NULL DEFAULT CURRENT_DATE,
        maintenance_type text NOT NULL DEFAULT 'PREVENTIVE',
        description text NOT NULL,
        provider text,
        cost numeric(14,2) NOT NULL DEFAULT 0,
        next_due_on date,
        performed_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const detected = await pool.query(`
      SELECT id,name,city FROM locations
      WHERE COALESCE(is_active,true)=true
        AND (lower(COALESCE(name,'')) LIKE '%gyöngyös%' OR lower(COALESCE(name,'')) LIKE '%gyongyos%'
          OR lower(COALESCE(city,'')) LIKE '%gyöngyös%' OR lower(COALESCE(city,'')) LIKE '%gyongyos%')
      ORDER BY CASE WHEN lower(COALESCE(city,'')) IN ('gyöngyös','gyongyos') THEN 0 ELSE 1 END,name LIMIT 1
    `).catch(() => ({ rows: [] as any[] } as any));
    const detectedId = detected.rows[0]?.id || null;
    await pool.query(`
      INSERT INTO vir_fitness_settings(scope_key,location_id) VALUES($1,$2::uuid)
      ON CONFLICT(scope_key) DO UPDATE SET location_id=COALESCE(vir_fitness_settings.location_id,EXCLUDED.location_id)
    `, [FITNESS_SCOPE, detectedId]);
    await ensureFitnessTaxonomy();
  })().catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}

async function ensureFitnessTaxonomy() {
  await ensureProductTaxonomySchema(pool as any);
  let group = await pool.query(`SELECT id FROM product_groups WHERE upper(COALESCE(code,''))=$1 LIMIT 1`, [FITNESS_GROUP_CODE]);
  let groupId = group.rows[0]?.id ? String(group.rows[0].id) : "";
  if (!groupId) {
    groupId = randomUUID();
    await pool.query(`INSERT INTO product_groups(id,name,name_hu,name_en,name_ru,code,product_type_code,product_type_name,sort_order,is_active) VALUES($1::uuid,'Fitnessz – Gyöngyös','Fitnessz – Gyöngyös','Fitness – Gyongyos','Фитнес – Дьёндьёш',$2,'FITNESS','Fitnessz',850,true)`, [groupId, FITNESS_GROUP_CODE]);
  }
  let category = await pool.query(`SELECT id FROM product_categories WHERE upper(COALESCE(code,''))=$1 LIMIT 1`, [FITNESS_CATEGORY_CODE]);
  let categoryId = category.rows[0]?.id ? String(category.rows[0].id) : "";
  if (!categoryId) {
    categoryId = randomUUID();
    await pool.query(`INSERT INTO product_categories(id,product_group_id,name,name_hu,name_en,name_ru,code,sort_order,display_order,is_active) VALUES($1::uuid,$2::uuid,'Fitnessz termékek','Fitnessz termékek','Fitness products','Фитнес товары',$3,850,850,true)`, [categoryId, groupId, FITNESS_CATEGORY_CODE]);
  }
  return { groupId, categoryId };
}

async function settings() {
  await ensureFitnessSchema();
  const { rows } = await pool.query(`SELECT s.*,l.name location_name,l.city location_city FROM vir_fitness_settings s LEFT JOIN locations l ON l.id=s.location_id WHERE s.scope_key=$1`, [FITNESS_SCOPE]);
  return rows[0] || null;
}

function accessFor(req: AuthRequest, s: any) {
  const own = String(req.user?.location_id || "");
  const locationId = String(s?.location_id || "");
  const admin = isAdmin(req);
  const receptionist = isReceptionist(req);
  return { allowed: admin || (receptionist && Boolean(locationId) && own === locationId), is_admin: admin, is_receptionist: receptionist, own_location_id: own, location_id: locationId };
}

async function requireFitness(req: AuthRequest, res: Response) {
  const s = await settings();
  const access = accessFor(req, s);
  if (!access.allowed) {
    res.status(403).json({ ok: false, code: "FITNESS_GYONGYOS_ONLY", message: "A Fitness modulhoz csak az adminisztrátor és a gyöngyösi recepció férhet hozzá." });
    return null;
  }
  if (!s?.location_id) {
    res.status(503).json({ ok: false, code: "FITNESS_LOCATION_NOT_CONFIGURED", message: "A gyöngyösi Fitness telephely még nincs hozzárendelve." });
    return null;
  }
  return { s, access };
}

async function requireAdmin(req: AuthRequest, res: Response) {
  const ctx = await requireFitness(req, res);
  if (!ctx) return null;
  if (!ctx.access.is_admin) {
    res.status(403).json({ ok: false, message: "Ezt a Fitness beállítást csak adminisztrátor módosíthatja." });
    return null;
  }
  return ctx;
}

router.get("/access", async (req: AuthRequest, res) => {
  try {
    const s = await settings();
    const access = accessFor(req, s);
    res.json({ ok: true, ...access, configured: Boolean(s?.location_id), location: s?.location_id ? { id: s.location_id, name: s.location_name, city: s.location_city } : null });
  } catch (e: any) { res.status(500).json({ ok: false, message: e?.message || "Fitness hozzáférés ellenőrzési hiba." }); }
});

router.get("/dashboard", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireFitness(req, res); if (!ctx) return;
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM vir_fitness_memberships WHERE location_id=$1 AND status='ACTIVE' AND valid_until>=CURRENT_DATE)::int active_memberships,
        (SELECT count(*) FROM vir_fitness_memberships WHERE location_id=$1 AND status='ACTIVE' AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE+7)::int expiring_7d,
        (SELECT count(*) FROM vir_fitness_access_events WHERE location_id=$1 AND occurred_at>=date_trunc('day',now()) AND decision='GRANTED')::int entries_today,
        (SELECT count(*) FROM vir_fitness_access_events WHERE location_id=$1 AND occurred_at>=date_trunc('day',now()) AND decision='DENIED')::int denied_today,
        (SELECT count(*) FROM vir_fitness_equipment WHERE location_id=$1 AND status='OUT_OF_ORDER')::int out_of_order,
        (SELECT count(*) FROM vir_fitness_equipment WHERE location_id=$1 AND COALESCE(next_maintenance_on,'9999-12-31'::date)<=CURRENT_DATE+14 AND status<>'RETIRED')::int maintenance_due_14d
    `, [ctx.s.location_id]);
    res.json({ ok: true, summary: rows[0], settings: ctx.s, access: ctx.access });
  } catch (e: any) { res.status(500).json({ ok: false, message: e?.message || "Fitness dashboard hiba." }); }
});

router.get("/settings", async (req: AuthRequest, res) => {
  try { const ctx = await requireFitness(req, res); if (!ctx) return; res.json({ ok: true, settings: ctx.s, access: ctx.access }); }
  catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
});

router.put("/settings", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    const locationId = String(req.body?.location_id || ctx.s.location_id || "").trim();
    if (!locationId) return res.status(400).json({ message: "Telephely kötelező." });
    const loc = await pool.query(`SELECT id,name,city FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`, [locationId]);
    if (!loc.rows[0]) return res.status(400).json({ message: "A megadott telephely nem található." });
    const text = `${loc.rows[0].name || ""} ${loc.rows[0].city || ""}`.toLocaleLowerCase("hu-HU");
    if (!text.includes("gyöngyös") && !text.includes("gyongyos")) return res.status(400).json({ message: "A Fitness modul kizárólag a gyöngyösi szalonhoz rendelhető." });
    const row = (await pool.query(`UPDATE vir_fitness_settings SET location_id=$2::uuid,is_24_7_enabled=$3,otic_enabled=$4,otic_mode='LOCAL_BRIDGE',updated_by=$5,updated_at=now() WHERE scope_key=$1 RETURNING *`, [FITNESS_SCOPE, locationId, req.body?.is_24_7_enabled !== false, Boolean(req.body?.otic_enabled), actor(req)])).rows[0];
    res.json({ ok: true, settings: row });
  } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
});

router.post("/settings/bridge-token", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    const token = `kleo-fit-${randomBytes(32).toString("base64url")}`;
    await pool.query(`UPDATE vir_fitness_settings SET otic_bridge_token_hash=$2,otic_enabled=true,updated_by=$3,updated_at=now() WHERE scope_key=$1`, [FITNESS_SCOPE, hash(token), actor(req)]);
    res.json({ ok: true, token, warning: "A bridge token csak most látható. A gyöngyösi helyi OTIC bridge-ben biztonságosan kell tárolni." });
  } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
});

router.get("/plans", async (req: AuthRequest, res) => {
  try { const ctx = await requireFitness(req, res); if (!ctx) return; const { rows } = await pool.query(`SELECT * FROM vir_fitness_membership_plans WHERE location_id=$1 ORDER BY is_active DESC,price,name`, [ctx.s.location_id]); res.json(rows); }
  catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.post("/plans", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    const name = String(req.body?.name || "").trim(); if (!name) return res.status(400).json({ message: "Bérletnév kötelező." });
    const mode = String(req.body?.access_mode || "DAYTIME").toUpperCase(); if (!ACCESS_MODES.has(mode)) return res.status(400).json({ message: "Érvénytelen belépési mód." });
    const days = Array.isArray(req.body?.allowed_weekdays) ? req.body.allowed_weekdays.map((x: any) => int(x, 0, 0, 6)) : [0,1,2,3,4,5,6];
    const row = (await pool.query(`INSERT INTO vir_fitness_membership_plans(location_id,name,duration_days,price,currency,access_mode,access_start_time,access_end_time,allowed_weekdays,is_active,created_by) VALUES($1,$2,$3,$4,'HUF',$5,$6::time,$7::time,$8::smallint[],$9,$10) RETURNING *`, [ctx.s.location_id,name,int(req.body?.duration_days,30,1,3650),money(req.body?.price),mode,String(req.body?.access_start_time||"06:00"),String(req.body?.access_end_time||"22:00"),days,req.body?.is_active!==false,actor(req)])).rows[0];
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.patch("/plans/:id", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    const current = (await pool.query(`SELECT * FROM vir_fitness_membership_plans WHERE id=$1::uuid AND location_id=$2`, [req.params.id,ctx.s.location_id])).rows[0]; if (!current) return res.status(404).json({ message: "Bérlettípus nem található." });
    const mode = String(req.body?.access_mode ?? current.access_mode).toUpperCase(); if (!ACCESS_MODES.has(mode)) return res.status(400).json({ message: "Érvénytelen belépési mód." });
    const row = (await pool.query(`UPDATE vir_fitness_membership_plans SET name=$3,duration_days=$4,price=$5,access_mode=$6,access_start_time=$7::time,access_end_time=$8::time,allowed_weekdays=$9::smallint[],is_active=$10,updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING *`, [req.params.id,ctx.s.location_id,String(req.body?.name??current.name),int(req.body?.duration_days??current.duration_days,30,1,3650),money(req.body?.price??current.price),mode,String(req.body?.access_start_time??current.access_start_time),String(req.body?.access_end_time??current.access_end_time),Array.isArray(req.body?.allowed_weekdays)?req.body.allowed_weekdays:current.allowed_weekdays,req.body?.is_active===undefined?current.is_active:Boolean(req.body.is_active)])).rows[0];
    res.json(row);
  } catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.get("/memberships", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireFitness(req, res); if (!ctx) return;
    const { rows } = await pool.query(`SELECT m.*,p.name plan_name,p.access_mode,p.access_start_time,p.access_end_time FROM vir_fitness_memberships m LEFT JOIN vir_fitness_membership_plans p ON p.id=m.plan_id WHERE m.location_id=$1 ORDER BY (m.status='ACTIVE') DESC,m.valid_until DESC,m.member_name`, [ctx.s.location_id]);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.post("/memberships", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireFitness(req, res); if (!ctx) return;
    const name = String(req.body?.member_name || "").trim(); if (!name) return res.status(400).json({ message: "Tag neve kötelező." });
    const planId = String(req.body?.plan_id || "").trim(); if (!planId) return res.status(400).json({ message: "Bérlettípus kötelező." });
    const plan = (await pool.query(`SELECT * FROM vir_fitness_membership_plans WHERE id=$1::uuid AND location_id=$2 AND is_active=true`, [planId,ctx.s.location_id])).rows[0]; if (!plan) return res.status(400).json({ message: "Aktív bérlettípus nem található." });
    const from = String(req.body?.valid_from || new Date().toISOString().slice(0,10));
    const until = String(req.body?.valid_until || "").trim();
    const row = (await pool.query(`INSERT INTO vir_fitness_memberships(location_id,client_id,member_name,email,phone,plan_id,valid_from,valid_until,status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6::uuid,$7::date,COALESCE(NULLIF($8,''),($7::date + $9::int)),'ACTIVE',$10,$11) RETURNING *`, [ctx.s.location_id,String(req.body?.client_id||"")||null,name,String(req.body?.email||"")||null,String(req.body?.phone||"")||null,planId,from,until,int(plan.duration_days,30,1,3650),String(req.body?.notes||"")||null,actor(req)])).rows[0];
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.patch("/memberships/:id", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireFitness(req, res); if (!ctx) return;
    const current = (await pool.query(`SELECT * FROM vir_fitness_memberships WHERE id=$1::uuid AND location_id=$2`, [req.params.id,ctx.s.location_id])).rows[0]; if (!current) return res.status(404).json({ message: "Bérlet nem található." });
    const status = String(req.body?.status ?? current.status).toUpperCase(); if (!MEMBERSHIP_STATUSES.has(status)) return res.status(400).json({ message: "Érvénytelen bérletstátusz." });
    const row = (await pool.query(`UPDATE vir_fitness_memberships SET member_name=$3,email=$4,phone=$5,plan_id=$6::uuid,valid_from=$7::date,valid_until=$8::date,status=$9,notes=$10,updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING *`, [req.params.id,ctx.s.location_id,String(req.body?.member_name??current.member_name),req.body?.email??current.email,req.body?.phone??current.phone,String(req.body?.plan_id??current.plan_id),String(req.body?.valid_from??current.valid_from),String(req.body?.valid_until??current.valid_until),status,req.body?.notes??current.notes])).rows[0]; res.json(row);
  } catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.post("/memberships/:id/card", async (req: AuthRequest, res) => {
  try {
    const ctx = await requireFitness(req, res); if (!ctx) return;
    const uid = cleanCard(req.body?.card_uid); if (uid.length < 3) return res.status(400).json({ message: "Érvényes kártyaazonosító szükséges." });
    const row = (await pool.query(`UPDATE vir_fitness_memberships SET card_uid_hash=$3,card_last4=$4,updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING id,member_name,card_last4,valid_until,status`, [req.params.id,ctx.s.location_id,hash(uid),uid.slice(-4)])).rows[0]; if (!row) return res.status(404).json({ message: "Bérlet nem található." }); res.json({ ok:true,membership:row });
  } catch (e: any) { if (e?.code === "23505") return res.status(409).json({ message: "Ez a kártya már másik aktív/tag bérlethez hozzá van rendelve." }); res.status(500).json({ message: e?.message }); }
});

router.get("/access-events", async (req: AuthRequest, res) => {
  try { const ctx = await requireFitness(req, res); if (!ctx) return; const limit = int(req.query.limit,100,1,500); const { rows } = await pool.query(`SELECT e.*,m.member_name,m.valid_until FROM vir_fitness_access_events e LEFT JOIN vir_fitness_memberships m ON m.id=e.membership_id WHERE e.location_id=$1 ORDER BY e.occurred_at DESC LIMIT $2`, [ctx.s.location_id,limit]); res.json(rows); }
  catch (e: any) { res.status(500).json({ message: e?.message }); }
});

router.get("/promotions", async (req: AuthRequest, res) => {
  try { const ctx=await requireFitness(req,res); if(!ctx)return; const {rows}=await pool.query(`SELECT p.*,mp.name membership_plan_name,pr.name product_name FROM vir_fitness_promotions p LEFT JOIN vir_fitness_membership_plans mp ON mp.id=p.membership_plan_id LEFT JOIN products pr ON pr.id=p.product_id WHERE p.location_id=$1 ORDER BY p.starts_at DESC`,[ctx.s.location_id]);res.json(rows); }
  catch(e:any){res.status(500).json({message:e?.message});}
});

router.post("/promotions", async (req: AuthRequest, res) => {
  try { const ctx=await requireAdmin(req,res);if(!ctx)return;const title=String(req.body?.title||"").trim();if(!title)return res.status(400).json({message:"Akció neve kötelező."});const type=String(req.body?.discount_type||"PERCENT").toUpperCase();if(!DISCOUNT_TYPES.has(type))return res.status(400).json({message:"Érvénytelen kedvezménytípus."});const row=(await pool.query(`INSERT INTO vir_fitness_promotions(location_id,title,description,starts_at,ends_at,discount_type,discount_value,membership_plan_id,product_id,is_active,created_by) VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8::uuid,$9::uuid,$10,$11) RETURNING *`,[ctx.s.location_id,title,String(req.body?.description||"")||null,req.body?.starts_at,req.body?.ends_at,type,money(req.body?.discount_value),String(req.body?.membership_plan_id||"")||null,String(req.body?.product_id||"")||null,req.body?.is_active!==false,actor(req)])).rows[0];res.status(201).json(row); }
  catch(e:any){res.status(500).json({message:e?.message});}
});

router.patch("/promotions/:id", async(req:AuthRequest,res)=>{
  try{const ctx=await requireAdmin(req,res);if(!ctx)return;const current=(await pool.query(`SELECT * FROM vir_fitness_promotions WHERE id=$1::uuid AND location_id=$2`,[req.params.id,ctx.s.location_id])).rows[0];if(!current)return res.status(404).json({message:"Akció nem található."});const type=String(req.body?.discount_type??current.discount_type).toUpperCase();if(!DISCOUNT_TYPES.has(type))return res.status(400).json({message:"Érvénytelen kedvezménytípus."});const row=(await pool.query(`UPDATE vir_fitness_promotions SET title=$3,description=$4,starts_at=$5::timestamptz,ends_at=$6::timestamptz,discount_type=$7,discount_value=$8,membership_plan_id=$9::uuid,product_id=$10::uuid,is_active=$11,updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING *`,[req.params.id,ctx.s.location_id,String(req.body?.title??current.title),req.body?.description??current.description,req.body?.starts_at??current.starts_at,req.body?.ends_at??current.ends_at,type,money(req.body?.discount_value??current.discount_value),String(req.body?.membership_plan_id??current.membership_plan_id||"")||null,String(req.body?.product_id??current.product_id||"")||null,req.body?.is_active===undefined?current.is_active:Boolean(req.body.is_active)])).rows[0];res.json(row);}catch(e:any){res.status(500).json({message:e?.message});}
});

router.get("/equipment", async(req:AuthRequest,res)=>{
  try{const ctx=await requireFitness(req,res);if(!ctx)return;const {rows}=await pool.query(`SELECT e.*,CASE WHEN e.next_maintenance_on IS NOT NULL AND e.next_maintenance_on<CURRENT_DATE AND e.status<>'RETIRED' THEN true ELSE false END maintenance_overdue,(SELECT json_agg(x ORDER BY x.performed_on DESC) FROM (SELECT m.id,m.performed_on,m.maintenance_type,m.description,m.provider,m.cost,m.next_due_on FROM vir_fitness_equipment_maintenance m WHERE m.equipment_id=e.id ORDER BY m.performed_on DESC LIMIT 5)x) maintenance_history FROM vir_fitness_equipment e WHERE e.location_id=$1 ORDER BY maintenance_overdue DESC,e.next_maintenance_on NULLS LAST,e.name`,[ctx.s.location_id]);res.json(rows);}catch(e:any){res.status(500).json({message:e?.message});}
});

router.post("/equipment",async(req:AuthRequest,res)=>{
  try{const ctx=await requireAdmin(req,res);if(!ctx)return;const name=String(req.body?.name||"").trim(),code=String(req.body?.asset_code||"").trim();if(!name||!code)return res.status(400).json({message:"Gépnév és eszközkód kötelező."});const status=String(req.body?.status||"ACTIVE").toUpperCase();if(!EQUIPMENT_STATUSES.has(status))return res.status(400).json({message:"Érvénytelen gépstátusz."});const interval=int(req.body?.maintenance_interval_days,90,1,3650);const row=(await pool.query(`INSERT INTO vir_fitness_equipment(location_id,asset_code,name,manufacturer,model,serial_number,location_area,commissioned_on,maintenance_interval_days,last_maintenance_on,next_maintenance_on,status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::date,COALESCE($11::date,$10::date+$9),$12,$13,$14) RETURNING *`,[ctx.s.location_id,code,name,String(req.body?.manufacturer||"")||null,String(req.body?.model||"")||null,String(req.body?.serial_number||"")||null,String(req.body?.location_area||"")||null,String(req.body?.commissioned_on||"")||null,interval,String(req.body?.last_maintenance_on||"")||null,String(req.body?.next_maintenance_on||"")||null,status,String(req.body?.notes||"")||null,actor(req)])).rows[0];res.status(201).json(row);}catch(e:any){if(e?.code==='23505')return res.status(409).json({message:"Ez az eszközkód már létezik."});res.status(500).json({message:e?.message});}
});

router.patch("/equipment/:id",async(req:AuthRequest,res)=>{
  try{const ctx=await requireAdmin(req,res);if(!ctx)return;const current=(await pool.query(`SELECT * FROM vir_fitness_equipment WHERE id=$1::uuid AND location_id=$2`,[req.params.id,ctx.s.location_id])).rows[0];if(!current)return res.status(404).json({message:"Kondigép nem található."});const status=String(req.body?.status??current.status).toUpperCase();if(!EQUIPMENT_STATUSES.has(status))return res.status(400).json({message:"Érvénytelen gépstátusz."});const row=(await pool.query(`UPDATE vir_fitness_equipment SET asset_code=$3,name=$4,manufacturer=$5,model=$6,serial_number=$7,location_area=$8,commissioned_on=$9::date,maintenance_interval_days=$10,next_maintenance_on=$11::date,status=$12,notes=$13,updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING *`,[req.params.id,ctx.s.location_id,String(req.body?.asset_code??current.asset_code),String(req.body?.name??current.name),req.body?.manufacturer??current.manufacturer,req.body?.model??current.model,req.body?.serial_number??current.serial_number,req.body?.location_area??current.location_area,req.body?.commissioned_on??current.commissioned_on,int(req.body?.maintenance_interval_days??current.maintenance_interval_days,90,1,3650),req.body?.next_maintenance_on??current.next_maintenance_on,status,req.body?.notes??current.notes])).rows[0];res.json(row);}catch(e:any){res.status(500).json({message:e?.message});}
});

router.post("/equipment/:id/maintenance",async(req:AuthRequest,res)=>{
  const c=await pool.connect();try{const ctx=await requireAdmin(req,res);if(!ctx)return;const type=String(req.body?.maintenance_type||"PREVENTIVE").toUpperCase();if(!MAINTENANCE_TYPES.has(type))return res.status(400).json({message:"Érvénytelen karbantartástípus."});const description=String(req.body?.description||"").trim();if(!description)return res.status(400).json({message:"Karbantartási leírás kötelező."});await c.query('BEGIN');const equipment=(await c.query(`SELECT * FROM vir_fitness_equipment WHERE id=$1::uuid AND location_id=$2 FOR UPDATE`,[req.params.id,ctx.s.location_id])).rows[0];if(!equipment){await c.query('ROLLBACK');return res.status(404).json({message:"Kondigép nem található."});}const performed=String(req.body?.performed_on||new Date().toISOString().slice(0,10));const nextDue=String(req.body?.next_due_on||"")||null;const m=(await c.query(`INSERT INTO vir_fitness_equipment_maintenance(equipment_id,performed_on,maintenance_type,description,provider,cost,next_due_on,performed_by) VALUES($1::uuid,$2::date,$3,$4,$5,$6,$7::date,$8) RETURNING *`,[req.params.id,performed,type,description,String(req.body?.provider||"")||null,money(req.body?.cost),nextDue,actor(req)])).rows[0];await c.query(`UPDATE vir_fitness_equipment SET last_maintenance_on=$2::date,next_maintenance_on=COALESCE($3::date,$2::date+maintenance_interval_days),status=CASE WHEN status='MAINTENANCE' THEN 'ACTIVE' ELSE status END,updated_at=now() WHERE id=$1::uuid`,[req.params.id,performed,nextDue]);await c.query('COMMIT');res.status(201).json(m);}catch(e:any){await c.query('ROLLBACK').catch(()=>{});res.status(500).json({message:e?.message});}finally{c.release();}
});

router.get("/products",async(req:AuthRequest,res)=>{
  try{const ctx=await requireFitness(req,res);if(!ctx)return;const nodes=await ensureFitnessTaxonomy();const {rows}=await pool.query(`SELECT p.id,p.name,p.internal_code,p.barcode,p.brand,p.retail_price_gross,p.purchase_price_net,p.vat_rate,p.is_active,g.name product_group_name,c.name product_category_name FROM products p JOIN product_groups g ON g.id=p.product_group_id JOIN product_categories c ON c.id=p.product_category_id WHERE p.product_group_id=$1::uuid AND p.product_category_id=$2::uuid ORDER BY COALESCE(p.is_active,true) DESC,p.name`,[nodes.groupId,nodes.categoryId]);res.json(rows);}catch(e:any){res.status(500).json({message:e?.message});}
});

router.post("/products",async(req:AuthRequest,res)=>{
  try{const ctx=await requireAdmin(req,res);if(!ctx)return;const name=String(req.body?.name||"").trim();if(!name)return res.status(400).json({message:"Terméknév kötelező."});const nodes=await ensureFitnessTaxonomy();const row=(await pool.query(`INSERT INTO products(name,internal_code,barcode,brand,product_group_id,product_category_id,purchase_price_net,retail_price_gross,vat_rate,is_active,is_retail,is_merchandise,taxonomy_source,taxonomy_confidence,taxonomy_updated_at) VALUES($1,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,true,true,'FITNESS_GYONGYOS',1,now()) RETURNING *`,[name,String(req.body?.internal_code||"")||null,String(req.body?.barcode||"")||null,String(req.body?.brand||"")||null,nodes.groupId,nodes.categoryId,req.body?.purchase_price_net===""?null:money(req.body?.purchase_price_net),money(req.body?.retail_price_gross),Number(req.body?.vat_rate??27),req.body?.is_active!==false])).rows[0];res.status(201).json(row);}catch(e:any){res.status(500).json({message:e?.message});}
});

router.patch("/products/:id",async(req:AuthRequest,res)=>{
  try{const ctx=await requireAdmin(req,res);if(!ctx)return;const nodes=await ensureFitnessTaxonomy();const current=(await pool.query(`SELECT * FROM products WHERE id=$1::uuid AND product_group_id=$2::uuid`,[req.params.id,nodes.groupId])).rows[0];if(!current)return res.status(404).json({message:"Fitnessz termék nem található."});const row=(await pool.query(`UPDATE products SET name=$3,internal_code=$4,barcode=$5,brand=$6,purchase_price_net=$7,retail_price_gross=$8,vat_rate=$9,is_active=$10,taxonomy_updated_at=now() WHERE id=$1::uuid AND product_group_id=$2::uuid RETURNING *`,[req.params.id,nodes.groupId,String(req.body?.name??current.name),req.body?.internal_code??current.internal_code,req.body?.barcode??current.barcode,req.body?.brand??current.brand,req.body?.purchase_price_net??current.purchase_price_net,req.body?.retail_price_gross??current.retail_price_gross,req.body?.vat_rate??current.vat_rate,req.body?.is_active===undefined?current.is_active:Boolean(req.body.is_active)])).rows[0];res.json(row);}catch(e:any){res.status(500).json({message:e?.message});}
});

function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23" }).formatToParts(date);
  const get=(t:string)=>parts.find(p=>p.type===t)?.value||"";
  const weekdays:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return { date:`${get("year")}-${get("month")}-${get("day")}`, minute:`${get("hour")}:${get("minute")}`, weekday:weekdays[get("weekday")]??0 };
}
function timeAllowed(now:Date, plan:any, global247:boolean){
  const p=localParts(now);const allowedDays=Array.isArray(plan?.allowed_weekdays)?plan.allowed_weekdays.map(Number):[0,1,2,3,4,5,6];if(!allowedDays.includes(p.weekday))return {ok:false,reason:"A bérlet ezen a napon nem biztosít belépést."};const mode=String(plan?.access_mode||"DAYTIME");if(mode==='24_7')return global247?{ok:true,reason:"Érvényes 0–24 bérlet."}:{ok:false,reason:"A 0–24 belépés jelenleg ki van kapcsolva."};const start=String(plan?.access_start_time||"06:00").slice(0,5),end=String(plan?.access_end_time||"22:00").slice(0,5);const ok=start<=end?(p.minute>=start&&p.minute<=end):(p.minute>=start||p.minute<=end);return ok?{ok:true,reason:"Érvényes időablak."}:{ok:false,reason:`A bérlet belépési ideje ${start}–${end}.`};
}

async function bridgeAuth(req:any,res:Response){
  await ensureFitnessSchema();const s=await settings();if(!s?.location_id||!s?.otic_enabled||!s?.otic_bridge_token_hash){res.status(503).json({ok:false,message:"Az OTIC bridge nincs engedélyezve vagy konfigurálva."});return null;}const bearer=String(req.headers?.authorization||"").replace(/^Bearer\s+/i,"").trim();const header=String(req.headers?.["x-kleo-fitness-bridge-token"]||"").trim();const token=bearer||header;if(!token){res.status(401).json({ok:false,message:"Bridge token szükséges."});return null;}const a=Buffer.from(hash(token)),b=Buffer.from(String(s.otic_bridge_token_hash));if(a.length!==b.length||!timingSafeEqual(a,b)){res.status(401).json({ok:false,message:"Érvénytelen bridge token."});return null;}return s;
}

fitnessOticBridgeRouter.post("/heartbeat",async(req:any,res)=>{
  try{const s=await bridgeAuth(req,res);if(!s)return;const source=String(req.body?.source||req.body?.device_id||"OTIC bridge").slice(0,160);await pool.query(`UPDATE vir_fitness_settings SET otic_last_heartbeat_at=now(),otic_last_source=$2,updated_at=now() WHERE scope_key=$1`,[FITNESS_SCOPE,source]);res.json({ok:true,location_id:s.location_id,server_time:new Date().toISOString()});}catch(e:any){res.status(500).json({ok:false,message:e?.message});}
});

fitnessOticBridgeRouter.post("/events",async(req:any,res)=>{
  try{const s=await bridgeAuth(req,res);if(!s)return;const body=req.body||{},uid=cleanCard(body.card_uid||body.card_id||body.identifier);if(!uid)return res.status(400).json({ok:false,message:"card_uid/card_id/identifier szükséges."});const cardHash=hash(uid);const occurred=new Date(body.occurred_at||Date.now());if(Number.isNaN(occurred.getTime()))return res.status(400).json({ok:false,message:"Érvénytelen occurred_at."});const member=(await pool.query(`SELECT m.*,p.name plan_name,p.access_mode,p.access_start_time,p.access_end_time,p.allowed_weekdays,p.is_active plan_active FROM vir_fitness_memberships m LEFT JOIN vir_fitness_membership_plans p ON p.id=m.plan_id WHERE m.location_id=$1 AND m.card_uid_hash=$2 ORDER BY m.updated_at DESC LIMIT 1`,[s.location_id,cardHash])).rows[0];let allow=false,reason="Ismeretlen fitnessz kártya.";if(member){const lp=localParts(occurred);if(member.status!=='ACTIVE')reason=`A bérlet státusza: ${member.status}.`;else if(String(member.valid_from)>lp.date)reason="A bérlet még nem érvényes.";else if(String(member.valid_until)<lp.date)reason="A bérlet lejárt.";else if(member.plan_active===false)reason="A bérlettípus inaktív.";else{const gate=timeAllowed(occurred,member,Boolean(s.is_24_7_enabled));allow=gate.ok;reason=gate.reason;}}const direction=String(body.direction||"UNKNOWN").toUpperCase();const eventType=String(body.event_type||body.type||"CARD_READ").slice(0,80);const uniqueSeed=String(body.event_id||`${occurred.toISOString()}|${cardHash}|${body.controller_id||""}|${body.door_id||""}|${direction}|${eventType}`);const dedupe=hash(uniqueSeed);const safe={...body,card_uid:undefined,card_id:undefined,identifier:undefined,card_uid_hash:cardHash.slice(0,12)+"…"};const inserted=await pool.query(`INSERT INTO vir_fitness_access_events(location_id,membership_id,occurred_at,direction,device_id,controller_id,door_id,event_type,decision,reason,card_uid_hash,dedupe_key,raw_event) VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[s.location_id,member?.id||null,occurred.toISOString(),["ENTRY","EXIT"].includes(direction)?direction:"UNKNOWN",String(body.device_id||"")||null,String(body.controller_id||"")||null,String(body.door_id||"")||null,eventType,allow?"GRANTED":"DENIED",reason,cardHash,dedupe,JSON.stringify(safe)]);await pool.query(`UPDATE vir_fitness_settings SET otic_last_heartbeat_at=now(),otic_last_source=COALESCE($2,otic_last_source),updated_at=now() WHERE scope_key=$1`,[FITNESS_SCOPE,String(body.source||body.device_id||"")||null]);res.json({ok:true,duplicate:inserted.rowCount===0,allow,decision:allow?"GRANTED":"DENIED",reason,membership:member?{id:member.id,member_name:member.member_name,plan_name:member.plan_name,valid_until:member.valid_until,access_mode:member.access_mode}:null});}catch(e:any){res.status(500).json({ok:false,message:e?.message});}
});

export default router;
