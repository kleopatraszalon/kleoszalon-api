import { Router, type NextFunction, type Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import virCustomizerRouter from "./virCustomizer";

const router = Router();

type JsonRow = Record<string, any>;

const text = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const nullableText = (value: unknown): string | null => {
  const v = text(value).trim();
  return v ? v : null;
};
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const isActive = (value: unknown): boolean => !["false", "f", "0", "no", "off"].includes(text(value).trim().toLowerCase());
const jsonObject = (value: unknown): JsonRow => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : {};
const asyncRoute = (handler: (req: AuthRequest, res: Response, next: NextFunction) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => handler(req, res, next).catch(next);

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
  const value = (req.user as any)?.tenant_id;
  return nullableText(value);
}
function readLocationScope(req: AuthRequest): string | null {
  const requested = nullableText(req.query.location_id);
  if (elevated(req)) return requested;
  const own = nullableText(req.user?.location_id);
  if (own) (req.query as any).location_id = own;
  return own;
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${name}`]);
  return Boolean(rows[0]?.ok);
}

async function loadJsonTable(table: string, ids?: string[]): Promise<JsonRow[]> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("Unsafe table name");
  if (!(await tableExists(table))) return [];
  if (ids && ids.length === 0) return [];
  const sql = ids
    ? `SELECT to_jsonb(t) AS data FROM ${table} t WHERE t.id::text = ANY($1::text[])`
    : `SELECT to_jsonb(t) AS data FROM ${table} t`;
  const { rows } = await db.query(sql, ids ? [ids] : []);
  return rows.map((row: any) => jsonObject(row.data));
}

function nameFrom(row: JsonRow, fallback = ""): string {
  const direct = nullableText(row.full_name) || nullableText(row.name) || nullableText(row.display_name);
  if (direct) return direct;
  const composed = [nullableText(row.last_name), nullableText(row.first_name)].filter(Boolean).join(" ").trim();
  return composed || fallback;
}

async function employeeDtos(locationId: string | null, includeInactive = false, tenantId: string | null = null): Promise<JsonRow[]> {
  const { rows } = await db.query(
    `SELECT to_jsonb(e) AS data
       FROM employees e
      WHERE ($1::text IS NULL OR NULLIF(to_jsonb(e)->>'location_id','') = $1)
        AND ($2::text IS NULL OR NULLIF(to_jsonb(e)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(e)->>'tenant_id','') = $2)
      ORDER BY COALESCE(NULLIF(to_jsonb(e)->>'full_name',''), NULLIF(to_jsonb(e)->>'last_name',''), NULLIF(to_jsonb(e)->>'first_name',''), '')`,
    [locationId, tenantId],
  );

  const raw = rows.map((row: any) => jsonObject(row.data)).filter((row: JsonRow) => includeInactive || isActive(row.active));
  const locationIds = Array.from(new Set(raw.map((row) => nullableText(row.location_id)).filter(Boolean))) as string[];
  const positionIds = Array.from(new Set(raw.map((row) => nullableText(row.position_id)).filter(Boolean))) as string[];
  const [locations, positions] = await Promise.all([
    loadJsonTable("locations", locationIds),
    loadJsonTable("hr_positions", positionIds),
  ]);
  const locationMap = new Map(locations.map((row) => [text(row.id), nameFrom(row)]));
  const positionMap = new Map(positions.map((row) => [text(row.id), nameFrom(row)]));

  return raw.map((row) => {
    const location_id = nullableText(row.location_id);
    const position_id = nullableText(row.position_id);
    const full_name = nameFrom(row, "Munkatárs");
    return {
      id: text(row.id), location_id,
      location_name: location_id ? locationMap.get(location_id) || null : null,
      full_name, first_name: nullableText(row.first_name), last_name: nullableText(row.last_name),
      email: nullableText(row.email), phone: nullableText(row.phone), birth_date: row.birth_date ?? null,
      qualification: nullableText(row.qualification), employment_type: nullableText(row.employment_type),
      position_id, position_name: position_id ? positionMap.get(position_id) || nullableText(row.position_name) : nullableText(row.position_name),
      monthly_wage: numberOrNull(row.monthly_wage), hourly_wage: numberOrNull(row.hourly_wage),
      commission_percent: numberOrNull(row.commission_percent),
      photo_url: nullableText(row.photo_url) || nullableText(row.avatar_url) || nullableText(row.image_url),
      active: isActive(row.active), login_name: nullableText(row.login_name), role: row.role ?? null,
      created_at: row.created_at ?? null, updated_at: row.updated_at ?? null,
    };
  });
}

async function countScoped(table: string, locationId: string | null, tenantId: string | null): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !(await tableExists(table))) return 0;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int total FROM ${table} t
      WHERE ($1::text IS NULL OR NULLIF(to_jsonb(t)->>'location_id','')=$1)
        AND ($2::text IS NULL OR NULLIF(to_jsonb(t)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(t)->>'tenant_id','')=$2)`,
    [locationId, tenantId],
  );
  return Number(rows[0]?.total || 0);
}

async function appointmentStats(from: string, to: string, locationId: string | null, tenantId: string | null) {
  if (!(await tableExists("appointments"))) return { total:0, completed:0, cancelled:0, noShow:0 };
  const { rows } = await db.query(
    `SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE lower(COALESCE(to_jsonb(a)->>'status','')) IN ('completed','paid','done','closed'))::int completed,
      COUNT(*) FILTER (WHERE lower(COALESCE(to_jsonb(a)->>'status','')) IN ('cancelled','canceled'))::int cancelled,
      COUNT(*) FILTER (WHERE lower(COALESCE(to_jsonb(a)->>'status','')) IN ('no_show','noshow','no-show'))::int no_show
     FROM appointments a
     WHERE LEFT(COALESCE(NULLIF(to_jsonb(a)->>'start_time',''),NULLIF(to_jsonb(a)->>'starts_at',''),NULLIF(to_jsonb(a)->>'start_at','')),10) BETWEEN $1 AND $2
       AND ($3::text IS NULL OR NULLIF(to_jsonb(a)->>'location_id','')=$3)
       AND ($4::text IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','')=$4)`,
    [from,to,locationId,tenantId],
  );
  return { total:Number(rows[0]?.total||0), completed:Number(rows[0]?.completed||0), cancelled:Number(rows[0]?.cancelled||0), noShow:Number(rows[0]?.no_show||0) };
}

router.get("/employees", requireAuth, asyncRoute(async (req, res) => {
  const locationId = readLocationScope(req);
  if (!elevated(req) && !locationId) return res.status(403).json({ error: "A felhasználói fiókhoz nincs telephely rendelve." });
  const includeInactive = text(req.query.include_inactive) === "1";
  const employees = await employeeDtos(locationId, includeInactive, tokenTenantId(req));
  res.setHeader("X-Kleo-Hotfix", "api500-employees-v2");
  return res.json(employees);
}));

router.get("/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const now = new Date();
  const defaultFrom = new Date(now); defaultFrom.setDate(defaultFrom.getDate()-29);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(text(req.query.from)) ? text(req.query.from) : defaultFrom.toISOString().slice(0,10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(text(req.query.to)) ? text(req.query.to) : now.toISOString().slice(0,10);
  const locationId = readLocationScope(req);
  if (!elevated(req) && !locationId) return res.status(403).json({ error: "A felhasználói fiókhoz nincs telephely rendelve." });
  const tenantId = tokenTenantId(req);
  const [totalClients, appt, rawLocations] = await Promise.all([
    countScoped("clients", locationId, tenantId),
    appointmentStats(from, to, locationId, tenantId),
    loadJsonTable("locations"),
  ]);
  const locations = rawLocations.filter(row => {
    const rowTenant = nullableText(row.tenant_id);
    if (tenantId && rowTenant && rowTenant !== tenantId) return false;
    if (locationId && text(row.id) !== locationId) return false;
    return isActive(row.is_active ?? true);
  }).map(row => ({ id:text(row.id), name:nameFrom(row,"Telephely") }));
  const completionRate = appt.total ? Math.round((1000*appt.completed/appt.total))/10 : 0;
  const noShowRate = appt.total ? Math.round((1000*appt.noShow/appt.total))/10 : 0;
  const payload = {
    period:{from,to},
    stats:{dailyRevenue:0,monthlyRevenue:0,totalRevenue:0,serviceRevenue:0,productRevenue:0,averageInvoice:0,averageServiceInvoice:0,averageCapacity:0,totalClients,newClients:0,activeAppointments:appt.total,completedAppointments:appt.completed,cancelledAppointments:appt.cancelled,noShowCount:appt.noShow,completionRate,noShowRate,sickDays:0,leaveDays:0,unexcusedDays:0,lowStockCount:0},
    chartData:[], revenueByLocation:[], revenueByPosition:[], topEmployees:[], absenceByPosition:[], locations, alerts:[]
  };
  res.setHeader("X-Kleo-Hotfix", "api500-dashboard-v2");
  res.setHeader("Cache-Control", "private, no-store");
  return res.json(payload);
}));

router.get("/timetable", requireAuth, asyncRoute(async (req, res) => {
  const from = text(req.query.from).trim();
  const to = text(req.query.to).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: "Érvényes from és to dátum szükséges." });
  const isElevated = elevated(req);
  if (!isElevated && !receptionist(req)) return res.status(403).json({ error: "A teljes időpont-beosztás csak vezetői vagy recepciós felületen érhető el." });
  const locationId = readLocationScope(req);
  if (!isElevated && !locationId) return res.status(403).json({ error: "A recepciós fiókhoz nincs szalon rendelve." });
  const tenantId = tokenTenantId(req);
  const employees = await employeeDtos(locationId, false, tenantId);

  if (!(await tableExists("appointments"))) {
    res.setHeader("X-Kleo-Hotfix", "api500-timetable-v2");
    return res.json({ employees, appointments: [] });
  }

  const { rows } = await db.query(
    `SELECT to_jsonb(a) AS data FROM appointments a
      WHERE LEFT(COALESCE(NULLIF(to_jsonb(a)->>'start_time',''),NULLIF(to_jsonb(a)->>'starts_at',''),NULLIF(to_jsonb(a)->>'start_at','')),10) BETWEEN $1 AND $2
        AND ($3::text IS NULL OR NULLIF(to_jsonb(a)->>'location_id','') = $3)
        AND ($4::text IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','') IS NULL OR NULLIF(to_jsonb(a)->>'tenant_id','') = $4)
      ORDER BY COALESCE(NULLIF(to_jsonb(a)->>'start_time',''),NULLIF(to_jsonb(a)->>'starts_at',''),NULLIF(to_jsonb(a)->>'start_at',''),'')`,
    [from, to, locationId, tenantId],
  );
  const appointmentRows = rows.map((row: any) => jsonObject(row.data));
  const appointmentIds = appointmentRows.map((row) => text(row.id)).filter(Boolean);
  const clientIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.client_id)).filter(Boolean))) as string[];
  const workOrderIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.work_order_id)).filter(Boolean))) as string[];
  const locationIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.location_id)).filter(Boolean))) as string[];

  const [clients, workOrders, locations, serviceRows, productRows] = await Promise.all([
    loadJsonTable("clients", clientIds), loadJsonTable("work_orders", workOrderIds), loadJsonTable("locations", locationIds),
    (async()=>{if(!(await tableExists("appointment_services"))||!appointmentIds.length)return[] as JsonRow[];const result=await db.query(`SELECT to_jsonb(x) AS data FROM appointment_services x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,[appointmentIds]);return result.rows.map((r:any)=>jsonObject(r.data));})(),
    (async()=>{if(!(await tableExists("appointment_products"))||!appointmentIds.length)return[] as JsonRow[];const result=await db.query(`SELECT to_jsonb(x) AS data FROM appointment_products x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,[appointmentIds]);return result.rows.map((r:any)=>jsonObject(r.data));})(),
  ]);

  const serviceIds=Array.from(new Set(serviceRows.map(row=>nullableText(row.service_id)).filter(Boolean))) as string[];
  const services=await loadJsonTable("services",serviceIds);
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
    const status=text(row.status).trim().toLowerCase();const workOrder=nullableText(row.work_order_id)?workOrderMap.get(text(row.work_order_id)):undefined;const workOrderStatus=text(workOrder?.status).trim().toLowerCase();
    const workOrderClosed=Boolean(workOrder&&(workOrderStatus==="completed"||workOrder.locked_at||workOrder.archived_at));
    const operational_status=workOrderClosed||["completed","paid"].includes(status)?"work_order_closed":workOrderStatus==="in_progress"||status==="in_progress"?"in_progress":workOrderStatus==="arrived"||status==="arrived"?"arrived":status||"waiting";
    const clientId=nullableText(row.client_id),appointmentLocationId=nullableText(row.location_id);
    return{id,employee_id:nullableText(row.employee_id),client_id:clientId,client_name:clientId?clientMap.get(clientId)||"":"",location_id:appointmentLocationId,location_name:appointmentLocationId?locationMap.get(appointmentLocationId)||null:null,title:nullableText(row.title)||service_names.join(", ")||"Időpont",start_time:row.start_time??row.starts_at??row.start_at??null,end_time:row.end_time??row.ends_at??row.end_at??null,status:nullableText(row.status),operational_status,notes:nullableText(row.notes),service_names,total:serviceTotal+productTotal};
  });
  res.setHeader("X-Kleo-Hotfix", "api500-timetable-v2");
  return res.json({employees,appointments});
}));

router.use("/transactions/knowledge-base/vir-customizer", virCustomizerRouter);

export default router;
