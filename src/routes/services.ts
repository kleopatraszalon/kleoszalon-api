import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";
import servicesImportRouter from "./servicesImportV2";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.services"));
router.use(servicesImportRouter);

async function ensureAltegioColumns() {
  await pool.query(`
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
  `);
}

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
    base_price: row.base_price == null ? null : Number(row.base_price),
    list_price: row.list_price == null ? null : Number(row.list_price),
    currency: row.currency,
    duration_minutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    wait_duration_min: row.wait_duration_min,
    promo_price: row.promo_price == null ? null : Number(row.promo_price),
    promo_valid_from: row.promo_valid_from,
    promo_valid_to: row.promo_valid_to,
    promo_label: row.promo_label,
    online_bookable: row.online_bookable,
    is_active: row.is_active,
    is_combo: row.is_combo,
    altegio_service_id: row.altegio_service_id,
    receipt_name: row.receipt_name,
    online_name: row.online_name,
    price_from: row.price_from == null ? null : Number(row.price_from),
    price_to: row.price_to == null ? null : Number(row.price_to),
    locations: Array.isArray(row.locations) ? row.locations : [],
  };
}

router.get("/", async (req: Request, res: Response) => {
  const includeInactive = req.query.include_inactive === "1";
  try {
    await ensureAltegioColumns();
    const result = await pool.query(`
      SELECT
        s.id,s.name,s.code,s.short_name,s.description_short,s.description_long,
        s.service_type_id,st.name AS service_type_name,
        s.parent_service_id,ps.name AS parent_service_name,
        s.base_price,s.list_price,s.currency,s.duration_minutes,s.wait_duration_min,
        s.promo_price,s.promo_valid_from,s.promo_valid_to,s.promo_label,
        s.online_bookable,s.is_active,s.is_combo,s.altegio_service_id,
        s.receipt_name,s.online_name,s.price_from,s.price_to,
        COALESCE((
          SELECT json_agg(json_build_object('id',l.id,'name',l.name) ORDER BY l.name)
          FROM public.service_locations sl
          JOIN public.locations l ON l.id=sl.location_id
          WHERE sl.service_id=s.id
        ),'[]'::json) AS locations
      FROM public.services s
      LEFT JOIN public.service_types st ON st.id=s.service_type_id
      LEFT JOIN public.services ps ON ps.id=s.parent_service_id
      WHERE ($1::boolean) OR s.is_active=true
      ORDER BY COALESCE(st.display_order,999999),st.name,s.name
    `,[includeInactive]);
    res.json(result.rows.map(mapServiceRow));
  } catch (err) {
    console.error("GET /services hiba:",err);
    res.status(500).json({error:"Nem sikerült a szolgáltatásokat betölteni."});
  }
});

router.get("/available", async (_req: Request,res: Response) => {
  try {
    const result=await pool.query(`SELECT id,name,short_name,duration_minutes,base_price,list_price FROM public.services WHERE is_active=true AND online_bookable=true ORDER BY name`);
    res.json(result.rows);
  } catch(err) {
    console.error("GET /services/available hiba:",err);
    res.status(500).json({error:"Nem sikerült a szolgáltatásokat betölteni."});
  }
});

router.get("/:id", async (req: Request,res: Response) => {
  try {
    await ensureAltegioColumns();
    const result=await pool.query(`
      SELECT s.*,st.name AS service_type_name,ps.name AS parent_service_name,
        COALESCE((SELECT json_agg(json_build_object('id',l.id,'name',l.name) ORDER BY l.name)
          FROM public.service_locations sl JOIN public.locations l ON l.id=sl.location_id WHERE sl.service_id=s.id),'[]'::json) AS locations
      FROM public.services s
      LEFT JOIN public.service_types st ON st.id=s.service_type_id
      LEFT JOIN public.services ps ON ps.id=s.parent_service_id
      WHERE s.id=$1::uuid
    `,[req.params.id]);
    if(!result.rowCount) return res.status(404).json({error:"Nincs ilyen szolgáltatás."});
    res.json(mapServiceRow(result.rows[0]));
  } catch(err) {
    console.error("GET /services/:id hiba:",err);
    res.status(500).json({error:"Nem sikerült betölteni a szolgáltatást."});
  }
});

router.post("/", async (req: Request,res: Response) => {
  const b=req.body||{};
  if(!b.name||!b.duration_minutes) return res.status(400).json({error:"A név és az időtartam (perc) kötelező."});
  try {
    const result=await pool.query(`
      INSERT INTO public.services(name,code,short_name,service_type_id,parent_service_id,base_price,list_price,currency,duration_minutes,wait_duration_min,description_short,description_long,promo_price,promo_valid_from,promo_valid_to,promo_label,online_bookable,is_active,is_combo)
      VALUES($1::text,$2::text,$3::text,$4::uuid,$5::uuid,$6::numeric,COALESCE($7::numeric,$6::numeric),COALESCE($8::text,'HUF'),$9::integer,$10::integer,$11::text,$12::text,$13::numeric,$14::date,$15::date,$16::text,$17::boolean,$18::boolean,$19::boolean)
      RETURNING *
    `,[b.name,b.code||null,b.short_name||null,b.service_type_id||null,b.parent_service_id||null,b.base_price??null,b.list_price??null,b.currency||"HUF",b.duration_minutes,b.wait_duration_min??null,b.description_short||null,b.description_long||null,b.promo_price??null,b.promo_valid_from||null,b.promo_valid_to||null,b.promo_label||null,b.online_bookable??true,b.is_active??true,b.is_combo??false]);
    res.status(201).json(mapServiceRow(result.rows[0]));
  } catch(err) {
    console.error("POST /services hiba:",err);
    res.status(500).json({error:"Nem sikerült létrehozni az új szolgáltatást."});
  }
});

router.patch("/:id", async (req: Request,res: Response) => {
  const b=req.body||{};
  try {
    const result=await pool.query(`
      UPDATE public.services s SET
        name=COALESCE($2::text,s.name),code=$3::text,short_name=$4::text,
        service_type_id=$5::uuid,parent_service_id=$6::uuid,
        base_price=$7::numeric,list_price=$8::numeric,currency=COALESCE($9::text,s.currency),
        duration_minutes=COALESCE($10::integer,s.duration_minutes),wait_duration_min=$11::integer,
        description_short=$12::text,description_long=$13::text,promo_price=$14::numeric,
        promo_valid_from=$15::date,promo_valid_to=$16::date,promo_label=$17::text,
        online_bookable=COALESCE($18::boolean,s.online_bookable),is_active=COALESCE($19::boolean,s.is_active),is_combo=COALESCE($20::boolean,s.is_combo),updated_at=now()
      WHERE s.id=$1::uuid RETURNING *
    `,[req.params.id,b.name??null,b.code??null,b.short_name??null,b.service_type_id||null,b.parent_service_id||null,b.base_price??null,b.list_price??null,b.currency||null,b.duration_minutes??null,b.wait_duration_min??null,b.description_short??null,b.description_long??null,b.promo_price??null,b.promo_valid_from||null,b.promo_valid_to||null,b.promo_label??null,b.online_bookable,b.is_active,b.is_combo]);
    if(!result.rowCount) return res.status(404).json({error:"Nincs ilyen szolgáltatás."});
    res.json(mapServiceRow(result.rows[0]));
  } catch(err) {
    console.error("PATCH /services/:id hiba:",err);
    res.status(500).json({error:"Nem sikerült frissíteni a szolgáltatást."});
  }
});

router.post("/reprice", async (req: Request,res: Response) => {
  const {percent,round_to,service_type_id}=req.body||{};
  if(typeof percent!=="number") return res.status(400).json({error:"percent (százalék) kötelező."});
  const factor=1+percent/100;
  const roundTo=typeof round_to==="number"&&round_to>0?round_to:10;
  const client=await (pool as any).connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE public.services s SET list_price=CASE WHEN list_price IS NULL THEN NULL ELSE ROUND(list_price*$1::numeric/$2::numeric)*$2::numeric END,updated_at=now() WHERE s.is_active=true AND ($3::uuid IS NULL OR s.service_type_id=$3::uuid)`,[factor,roundTo,service_type_id||null]);
    await client.query("COMMIT");
    res.json({ok:true});
  } catch(err) {
    try{await client.query("ROLLBACK");}catch{}
    console.error("POST /services/reprice hiba:",err);
    res.status(500).json({error:"Nem sikerült az átárazás."});
  } finally { client.release(); }
});

export default router;
