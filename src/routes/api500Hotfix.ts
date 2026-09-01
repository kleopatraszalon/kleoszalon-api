import { Router, type Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireTenantContext } from "../middleware/tenantContext";
import virCustomizerRouter from "./virCustomizer";

const router = Router();
type JsonRow = Record<string, any>;

const text = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const nullableText = (value: unknown): string | null => {
  const valueAsText = text(value).trim();
  return valueAsText ? valueAsText : null;
};
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const jsonObject = (value: unknown): JsonRow => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : {};
const isActive = (value: unknown): boolean => !["false", "f", "0", "no", "off"].includes(text(value).trim().toLowerCase());

function roleKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(v => v.toLowerCase());
  const value = text(raw);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(v => v.toLowerCase());
  } catch {}
  return value.split(",").map(v => v.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}
function elevated(req: AuthRequest): boolean {
  return roleKeys(req.user?.role).some(role => ["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","location_manager","üzletvezető","uzletvezeto","store_manager","branch_manager"].includes(role));
}
function receptionist(req: AuthRequest): boolean {
  return roleKeys(req.user?.role).some(role => ["receptionist","reception","recepciós","recepcios"].includes(role));
}
function tokenTenantId(req: AuthRequest): string | null {
  return nullableText(req.user?.tenant_id);
}
function readLocationScope(req: AuthRequest): string | null {
  const requested = nullableText(req.query.location_id);
  if (elevated(req)) return requested;
  const own = nullableText(req.user?.location_id);
  if (own) (req.query as any).location_id = own;
  return own;
}
function nameFrom(row: JsonRow, fallback = ""): string {
  const direct = nullableText(row.full_name) || nullableText(row.name) || nullableText(row.display_name);
  if (direct) return direct;
  const composed = [nullableText(row.last_name), nullableText(row.first_name)].filter(Boolean).join(" ").trim();
  return composed || fallback;
}
function warn(scope: string, error: unknown) {
  const e = error as any;
  console.warn(`[api500-hotfix] ${scope}:`, e?.code || "ERROR", e?.message || e);
}

async function tableExists(name: string): Promise<boolean> {
  try {
    const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${name}`]);
    return Boolean(rows[0]?.ok);
  } catch (error) {
    warn(`tableExists(${name})`, error);
    return false;
  }
}

async function loadJsonTable(table: string, ids?: string[]): Promise<JsonRow[]> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return [];
  try {
    if (!(await tableExists(table))) return [];
    if (ids && ids.length === 0) return [];
    const sql = ids
      ? `SELECT to_jsonb(t) AS data FROM ${table} t WHERE t.id::text = ANY($1::text[])`
      : `SELECT to_jsonb(t) AS data FROM ${table} t`;
    const { rows } = await db.query(sql, ids ? [ids] : []);
    return rows.map((row: any) => jsonObject(row.data));
  } catch (error) {
    warn(`loadJsonTable(${table})`, error);
    return [];
  }
}

async function employeeDtos(locationId: string | null, includeInactive = false, tenantId: string | null = null): Promise<JsonRow[]> {
  let raw: JsonRow[] = [];
  try {
    const { rows } = await db.query(
      `SELECT to_jsonb(e) AS data
         FROM employees e
        WHERE ($1::text IS NULL OR NULLIF(to_jsonb(e)->>'location_id','') = $1 OR NULLIF(to_jsonb(e)->>'location_id','') IS NULL)
          AND ($2::text IS NULL OR NULLIF(to_jsonb(e)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(e)->>'tenant_id','') = $2)
        ORDER BY COALESCE(NULLIF(to_jsonb(e)->>'full_name',''), NULLIF(to_jsonb(e)->>'last_name',''), NULLIF(to_jsonb(e)->>'first_name',''), '')`,
      [locationId, tenantId],
    );
    raw = rows.map((row: any) => jsonObject(row.data));
  } catch (error) {
    warn("employees scoped query", error);
    try {
      const { rows } = await db.query("SELECT to_jsonb(e) AS data FROM employees e");
      raw = rows.map((row: any) => jsonObject(row.data)).filter(row => {
        const rowLocation = nullableText(row.location_id);
        if (locationId && rowLocation && rowLocation !== locationId) return false;
        const rowTenant = nullableText(row.tenant_id);
        if (tenantId && rowTenant && rowTenant !== tenantId) return false;
        return true;
      });
    } catch (fallbackError) {
      warn("employees unscoped fallback", fallbackError);
      return [];
    }
  }

  raw = raw.filter(row => includeInactive || isActive(row.active));
  const locationIds = Array.from(new Set(raw.map(row => nullableText(row.location_id)).filter(Boolean))) as string[];
  const positionIds = Array.from(new Set(raw.map(row => nullableText(row.position_id)).filter(Boolean))) as string[];
  const [locations, positions] = await Promise.all([
    loadJsonTable("locations", locationIds),
    loadJsonTable("hr_positions", positionIds),
  ]);
  const locationMap = new Map(locations.map(row => [text(row.id), nameFrom(row)]));
  const positionMap = new Map(positions.map(row => [text(row.id), nameFrom(row)]));

  return raw.map(row => {
    const location_id = nullableText(row.location_id);
    const position_id = nullableText(row.position_id);
    return {
      id: text(row.id),
      location_id,
      location_name: location_id ? locationMap.get(location_id) || null : null,
      full_name: nameFrom(row, "Munkatárs"),
      first_name: nullableText(row.first_name),
      last_name: nullableText(row.last_name),
      email: nullableText(row.email),
      phone: nullableText(row.phone),
      birth_date: row.birth_date ?? null,
      qualification: nullableText(row.qualification),
      employment_type: nullableText(row.employment_type),
      position_id,
      position_name: position_id ? positionMap.get(position_id) || nullableText(row.position_name) : nullableText(row.position_name),
      monthly_wage: numberOrNull(row.monthly_wage),
      hourly_wage: numberOrNull(row.hourly_wage),
      commission_percent: numberOrNull(row.commission_percent),
      photo_url: nullableText(row.photo_url) || nullableText(row.avatar_url) || nullableText(row.image_url),
      active: isActive(row.active),
      login_name: nullableText(row.login_name),
      role: row.role ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  });
}

function dailyActionPercent(row: JsonRow): number {
  const direct = numberOrNull(row.discount_percent);
  if (direct !== null) return Math.max(0, Math.min(100, direct));
  const meta = numberOrNull(jsonObject(row.auto_selector_meta).applied_discount_pct);
  if (meta !== null) return Math.max(0, Math.min(100, meta));
  const match = text(row.discount_text).match(/(\d+(?:[.,]\d+)?)\s*%/);
  return match ? Math.max(0, Math.min(100, Number(match[1].replace(",", ".")) || 0)) : 0;
}

router.get("/public/marketing/daily-actions", async (req, res) => {
  try {
    const now = Date.now();
    const requestedLocation = nullableText(req.query.location_id);
    const clientId = nullableText(req.query.client_id);
    const rows = await loadJsonTable("daily_action_campaigns");
    const actions = rows.filter(row => {
      if (text(row.status).toLowerCase() !== "published") return false;
      const from = new Date(row.valid_from ?? 0).getTime();
      const until = new Date(row.valid_until ?? 0).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(until) || from > now || until < now) return false;
      const meta = jsonObject(row.auto_selector_meta);
      const location = nullableText(row.location_id) || nullableText(meta.location_id);
      if (requestedLocation && location && location !== requestedLocation) return false;
      const audienceType = text(jsonObject(row.audience).type || "all").toLowerCase();
      if (audienceType !== "all" && !clientId) return false;
      return audienceType === "all";
    }).map(row => ({
      id:text(row.id), headline:text(row.headline), description_html:text(row.description_html),
      image_url:nullableText(row.image_url), cta_label:nullableText(row.cta_label), cta_url:nullableText(row.cta_url),
      discount_text:nullableText(row.discount_text), discount_percent:dailyActionPercent(row),
      valid_from:row.valid_from ?? null, valid_until:row.valid_until ?? null,
      location_id:nullableText(row.location_id) || nullableText(jsonObject(row.auto_selector_meta).location_id),
      service_id:nullableText(row.service_id), audience:row.audience ?? {type:"all"},
    }));
    const settings = await loadJsonTable("mobile_app_settings", ["1"]);
    res.setHeader("X-Kleo-Hotfix", "api500-daily-actions-v2");
    return res.json({actions,vapid_public_key:text(process.env.VAPID_PUBLIC_KEY),app_config:jsonObject(settings[0]?.config),app_config_updated_at:settings[0]?.updated_at ?? null});
  } catch (error) {
    warn("public daily actions", error);
    res.setHeader("X-Kleo-Hotfix", "api500-daily-actions-empty-v2");
    return res.status(200).json({actions:[],vapid_public_key:text(process.env.VAPID_PUBLIC_KEY),app_config:{},app_config_updated_at:null});
  }
});

router.get("/employees", requireAuth, requireTenantContext, async (req: AuthRequest, res: Response) => {
  const locationId = readLocationScope(req);
  if (!elevated(req) && !locationId) return res.status(403).json({ error: "A felhasználói fiókhoz nincs telephely rendelve." });
  const includeInactive = text(req.query.include_inactive) === "1";
  try {
    const employees = await employeeDtos(locationId, includeInactive, tokenTenantId(req));
    res.setHeader("X-Kleo-Hotfix", "api500-employees-v5");
    return res.json(employees);
  } catch (error) {
    warn("employees final fallback", error);
    res.setHeader("X-Kleo-Hotfix", "api500-employees-empty-v5");
    return res.status(200).json([]);
  }
});

router.get("/clients/booking-search", requireAuth, requireTenantContext, async (req: AuthRequest, res: Response) => {
  const query = text(req.query.q).trim();
  if (!query) return res.json([]);
  const locationId = readLocationScope(req);
  if (!elevated(req) && !locationId) return res.status(403).json({ error: "A felhasználói fiókhoz nincs telephely rendelve." });
  const tenantId = tokenTenantId(req);
  const contains = `%${query}%`;
  const prefix = `${query}%`;
  try {
    const { rows } = await db.query(
      `SELECT c.id::text id,
              NULLIF(to_jsonb(c)->>'location_id','') location_id,
              COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen vendég') name,
              COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen vendég') full_name,
              NULLIF(to_jsonb(c)->>'phone','') phone,
              NULLIF(to_jsonb(c)->>'email','') email,
              NULLIF(to_jsonb(c)->>'barcode','') barcode,
              NULLIF(to_jsonb(c)->>'vip_status','') vip_status,
              NULLIF(to_jsonb(c)->>'loyalty_points','') loyalty_points,
              NULLIF(to_jsonb(c)->>'points','') points,
              NULLIF(to_jsonb(c)->>'visit_count','') visit_count,
              NULLIF(to_jsonb(c)->>'appointments_count','') appointments_count,
              NULLIF(to_jsonb(c)->>'last_visit_at','') last_visit_at,
              NULLIF(to_jsonb(c)->>'last_appointment_at','') last_appointment_at,
              NULLIF(to_jsonb(c)->>'favorite_service_name','') favorite_service_name,
              NULLIF(to_jsonb(c)->>'favourite_service_name','') favourite_service_name,
              to_jsonb(c)->>'allergies' allergies,
              NULLIF(to_jsonb(c)->>'allergy_notes','') allergy_notes,
              NULLIF(to_jsonb(c)->>'notes','') notes,
              NULLIF(to_jsonb(c)->>'internal_notes','') internal_notes
         FROM clients c
        WHERE ($1::text IS NULL OR NULLIF(to_jsonb(c)->>'location_id','') = $1 OR NULLIF(to_jsonb(c)->>'location_id','') IS NULL)
          AND ($2::text IS NULL OR NULLIF(to_jsonb(c)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(c)->>'tenant_id','') = $2)
          AND CASE
                WHEN lower(COALESCE(NULLIF(to_jsonb(c)->>'is_active',''),'true')) IN ('false','f','0','no','nem','n') THEN false
                ELSE true
              END
          AND (
            COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),to_jsonb(c)->>'name','') ILIKE $3
            OR COALESCE(to_jsonb(c)->>'phone','') ILIKE $3
            OR COALESCE(to_jsonb(c)->>'email','') ILIKE $3
            OR COALESCE(to_jsonb(c)->>'barcode','') ILIKE $3
          )
        ORDER BY
          CASE WHEN COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),to_jsonb(c)->>'name','') ILIKE $4 THEN 0 ELSE 1 END,
          lower(COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'')) ASC
        LIMIT 12`,
      [locationId, tenantId, contains, prefix],
    );
    res.setHeader("X-Kleo-Hotfix", "api500-booking-client-search-v1");
    return res.json(rows);
  } catch (error) {
    warn("booking client search", error);
    res.setHeader("X-Kleo-Hotfix", "api500-booking-client-search-empty-v1");
    return res.status(200).json([]);
  }
});

router.get("/timetable", requireAuth, requireTenantContext, async (req: AuthRequest, res: Response) => {
  const from = text(req.query.from).trim();
  const to = text(req.query.to).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: "Érvényes from és to dátum szükséges." });
  const isElevated = elevated(req);
  if (!isElevated && !receptionist(req)) return res.status(403).json({ error: "A teljes időpont-beosztás csak vezetői vagy recepciós felületen érhető el." });
  const locationId = readLocationScope(req);
  if (!isElevated && !locationId) return res.status(403).json({ error: "A recepciós fiókhoz nincs szalon rendelve." });
  const tenantId = tokenTenantId(req);
  const employees = await employeeDtos(locationId, false, tenantId).catch(error => { warn("timetable employees", error); return [] as JsonRow[]; });

  try {
    if (!(await tableExists("appointments"))) {
      res.setHeader("X-Kleo-Hotfix", "api500-timetable-v4");
      return res.json({employees,appointments:[]});
    }
    const { rows } = await db.query(
      `SELECT to_jsonb(a) AS data FROM appointments a
       WHERE LEFT(COALESCE(NULLIF(to_jsonb(a)->>'start_time',''),NULLIF(to_jsonb(a)->>'starts_at',''),NULLIF(to_jsonb(a)->>'start_at','')),10) BETWEEN $1 AND $2
         AND ($3::text IS NULL OR NULLIF(to_jsonb(a)->>'location_id','') = $3)
         AND ($4::text IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','') = $4)
       ORDER BY COALESCE(NULLIF(to_jsonb(a)->>'start_time',''),NULLIF(to_jsonb(a)->>'starts_at',''),NULLIF(to_jsonb(a)->>'start_at',''),'')`,
      [from,to,locationId,tenantId],
    );
    const appointmentRows = rows.map((row:any)=>jsonObject(row.data));
    const appointmentIds = appointmentRows.map(row=>text(row.id)).filter(Boolean);
    const clientIds = Array.from(new Set(appointmentRows.map(row=>nullableText(row.client_id)).filter(Boolean))) as string[];
    const workOrderIds = Array.from(new Set(appointmentRows.map(row=>nullableText(row.work_order_id)).filter(Boolean))) as string[];
    const locationIds = Array.from(new Set(appointmentRows.map(row=>nullableText(row.location_id)).filter(Boolean))) as string[];
    const [clients,workOrders,locations,serviceRows,productRows] = await Promise.all([
      loadJsonTable("clients",clientIds),loadJsonTable("work_orders",workOrderIds),loadJsonTable("locations",locationIds),
      (async()=>{if(!(await tableExists("appointment_services"))||!appointmentIds.length)return[] as JsonRow[];try{const r=await db.query(`SELECT to_jsonb(x) AS data FROM appointment_services x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,[appointmentIds]);return r.rows.map((x:any)=>jsonObject(x.data));}catch(e){warn("appointment_services",e);return[] as JsonRow[];}})(),
      (async()=>{if(!(await tableExists("appointment_products"))||!appointmentIds.length)return[] as JsonRow[];try{const r=await db.query(`SELECT to_jsonb(x) AS data FROM appointment_products x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,[appointmentIds]);return r.rows.map((x:any)=>jsonObject(x.data));}catch(e){warn("appointment_products",e);return[] as JsonRow[];}})(),
    ]);
    const serviceIds = Array.from(new Set(serviceRows.map(row=>nullableText(row.service_id)).filter(Boolean))) as string[];
    const services = await loadJsonTable("services",serviceIds);
    const serviceMap=new Map(services.map(row=>[text(row.id),nameFrom(row)]));
    const clientMap=new Map(clients.map(row=>[text(row.id),nameFrom(row)]));
    const locationMap=new Map(locations.map(row=>[text(row.id),nameFrom(row)]));
    const workOrderMap=new Map<string,JsonRow>(workOrders.map(row=>[text(row.id),row]));
    const servicesByAppointment=new Map<string,JsonRow[]>();
    for(const row of serviceRows){const key=text(row.appointment_id);if(!key)continue;const list=servicesByAppointment.get(key)||[];list.push(row);servicesByAppointment.set(key,list);}
    const productsByAppointment=new Map<string,JsonRow[]>();
    for(const row of productRows){const key=text(row.appointment_id);if(!key)continue;const list=productsByAppointment.get(key)||[];list.push(row);productsByAppointment.set(key,list);}
    const appointments=appointmentRows.map(row=>{
      const id=text(row.id),servicesForAppointment=servicesByAppointment.get(id)||[],productsForAppointment=productsByAppointment.get(id)||[];
      const service_names=servicesForAppointment.map(item=>nullableText(item.name)||(nullableText(item.service_id)?serviceMap.get(text(item.service_id))||"":"")).filter(Boolean);
      const serviceTotal=servicesForAppointment.reduce((sum,item)=>sum+(numberOrNull(item.price??item.unit_price)||0),0);
      const productTotal=productsForAppointment.reduce((sum,item)=>sum+(numberOrNull(item.qty??item.quantity)||1)*(numberOrNull(item.price??item.unit_price)||0),0);
      const status=text(row.status).trim().toLowerCase();
      const workOrder=nullableText(row.work_order_id)?workOrderMap.get(text(row.work_order_id)):undefined;
      const workOrderStatus=text(workOrder?.status).trim().toLowerCase();
      const workOrderClosed=Boolean(workOrder&&(workOrderStatus==="completed"||workOrder.locked_at||workOrder.archived_at));
      const operational_status=workOrderClosed||["completed","paid"].includes(status)?"work_order_closed":workOrderStatus==="in_progress"||status==="in_progress"?"in_progress":workOrderStatus==="arrived"||status==="arrived"?"arrived":status||"waiting";
      const clientId=nullableText(row.client_id),appointmentLocationId=nullableText(row.location_id);
      return{id,employee_id:nullableText(row.employee_id),client_id:clientId,client_name:clientId?clientMap.get(clientId)||"":"",location_id:appointmentLocationId,location_name:appointmentLocationId?locationMap.get(appointmentLocationId)||null:null,title:nullableText(row.title)||service_names.join(", ")||"Időpont",start_time:row.start_time??row.starts_at??row.start_at??null,end_time:row.end_time??row.ends_at??row.end_at??null,status:nullableText(row.status),operational_status,notes:nullableText(row.notes),service_names,total:serviceTotal+productTotal};
    });
    res.setHeader("X-Kleo-Hotfix", "api500-timetable-v4");
    return res.json({employees,appointments});
  } catch (error) {
    warn("timetable final fallback", error);
    res.setHeader("X-Kleo-Hotfix", "api500-timetable-empty-v4");
    return res.status(200).json({employees,appointments:[]});
  }
});

router.use("/transactions/knowledge-base/vir-customizer", virCustomizerRouter);
export default router;
