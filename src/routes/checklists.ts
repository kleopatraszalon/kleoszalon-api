import { Router, Response, NextFunction } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { ensureHrV2 } from "../hr/ensureHrV2";

const router = Router();

type Frequency = "daily" | "weekly" | "monthly";
const FREQUENCIES = new Set<Frequency>(["daily", "weekly", "monthly"]);

const asyncRoute =
  (handler: (req: AuthRequest, res: Response) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) =>
    handler(req, res).catch(next);

function roles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.toLowerCase());
  const value = String(raw ?? "");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.toLowerCase());
  } catch {}
  return value.split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}

function isAdmin(req: AuthRequest) {
  return roles(req.user?.role).some(r => ["admin", "administrator", "rendszergazda", "superadmin", "super_admin"].includes(r));
}

function isManagement(req: AuthRequest) {
  return roles(req.user?.role).some(r => ["admin", "administrator", "rendszergazda", "superadmin", "super_admin", "manager", "vezető", "vezeto"].includes(r));
}

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isAdmin(req)) return res.status(403).json({ error: "A check listák adminisztrálásához admin jogosultság szükséges." });
  return next();
}

function requireManagement(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isManagement(req)) return res.status(403).json({ error: "A check lista állapotok megtekintéséhez vezetői jogosultság szükséges." });
  return next();
}

router.use(requireAuth);
router.use(async (_req: AuthRequest, _res: Response, next: NextFunction) => {
  try {
    await ensureHrV2();
    next();
  } catch (error) {
    next(error);
  }
});

async function resolveEmployee(req: AuthRequest) {
  const email = String(req.user?.email ?? "").trim();
  const userId = String(req.user?.id ?? "").trim();
  const { rows } = await pool.query(
    `SELECT e.id,e.full_name,e.email,e.location_id,
            COALESCE(e.position_id,pa.position_id) AS position_id,
            p.name AS position_name
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT x.position_id
           FROM employee_position_assignments x
          WHERE x.employee_id=e.id AND x.is_active=true
            AND x.valid_from<=CURRENT_DATE
            AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
          ORDER BY x.is_primary DESC,x.valid_from DESC
          LIMIT 1
       ) pa ON true
       LEFT JOIN hr_positions p ON p.id=COALESCE(e.position_id,pa.position_id)
      WHERE ($1<>'' AND (lower(COALESCE(e.email,''))=lower($1) OR lower(COALESCE(e.login_name,''))=lower($1)))
         OR e.id::text=$2
      ORDER BY CASE WHEN $1<>'' AND lower(COALESCE(e.email,''))=lower($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [email, userId]
  );
  return rows[0] ?? null;
}

function timeToMinutes(raw: unknown, fallback = 18 * 60) {
  const m = String(raw ?? "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function budapestClock() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekday = ({ Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 } as Record<string,number>)[get("weekday")] ?? 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day, weekday, minutes: hour * 60 + minute, daysToMonthEnd: lastDay - day };
}

function periodStartSql(alias = "i") {
  return `CASE ${alias}.frequency
    WHEN 'daily' THEN (now() AT TIME ZONE 'Europe/Budapest')::date
    WHEN 'weekly' THEN date_trunc('week',now() AT TIME ZONE 'Europe/Budapest')::date
    WHEN 'monthly' THEN date_trunc('month',now() AT TIME ZONE 'Europe/Budapest')::date
  END`;
}

function warningActive(frequency: Frequency, checklist: any) {
  const now = budapestClock();
  if (frequency === "daily") return now.minutes >= timeToMinutes(checklist.daily_warning_time);
  if (frequency === "weekly") return now.weekday >= Number(checklist.weekly_warning_weekday ?? 3);
  return now.daysToMonthEnd <= Number(checklist.monthly_warning_days ?? 7);
}

function buildStatus(items: any[], frequency: Frequency, checklist: any) {
  const all = items.filter(i => i.frequency === frequency && i.is_active !== false);
  const required = all.filter(i => i.is_required !== false);
  const completed = required.filter(i => i.completed === true).length;
  const total = required.length;
  const percent = total ? Math.round((completed / total) * 100) : 100;
  const done = total === 0 || completed === total;
  const warning = !done && warningActive(frequency, checklist);
  return {
    frequency,
    total,
    completed,
    missing: Math.max(0, total - completed),
    percent,
    warning,
    state: done ? "green" : warning ? "red" : "amber",
  };
}

function aggregateSummary(checklists: any[]) {
  return (["daily", "weekly", "monthly"] as Frequency[]).map(frequency => {
    const statuses = checklists.map(c => c.status?.[frequency]).filter(Boolean);
    const total = statuses.reduce((s:number,x:any)=>s+Number(x.total||0),0);
    const completed = statuses.reduce((s:number,x:any)=>s+Number(x.completed||0),0);
    const warning = statuses.some((x:any)=>x.warning);
    const done = total === 0 || completed === total;
    return {
      frequency,total,completed,missing:Math.max(0,total-completed),
      percent: total ? Math.round(completed/total*100) : 100,
      warning,state: done ? "green" : warning ? "red" : "amber",
    };
  }).reduce((acc:any,x:any)=>{acc[x.frequency]=x;return acc;},{});
}

router.get("/my", asyncRoute(async (req, res) => {
  const employee = await resolveEmployee(req);
  if (!employee) return res.status(404).json({ error: "A belépett felhasználóhoz nem található munkatársi rekord." });
  if (!employee.position_id) return res.status(409).json({ error: "A munkatárshoz nincs munkakör rendelve, ezért nincs kiosztható check lista." });

  const { rows } = await pool.query(
    `SELECT c.id AS checklist_id,c.code,c.name AS checklist_name,c.description AS checklist_description,
            c.daily_warning_time,c.weekly_warning_weekday,c.monthly_warning_days,
            i.id AS item_id,i.item_key,i.frequency,i.section,i.title,i.description,
            i.sort_order,i.is_required,i.is_active,
            COALESCE(cc.completed,false) AS completed,cc.completed_at,cc.note,
            ${periodStartSql("i")} AS period_start
       FROM vir_checklist_position_assignments a
       JOIN vir_checklists c ON c.id=a.checklist_id AND c.is_active=true
       JOIN vir_checklist_items i ON i.checklist_id=c.id AND i.is_active=true
       LEFT JOIN vir_checklist_completions cc
         ON cc.checklist_item_id=i.id
        AND cc.employee_id=$1
        AND cc.period_start=${periodStartSql("i")}
      WHERE a.position_id=$2 AND a.is_active=true
      ORDER BY c.name,
               CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,
               i.sort_order,i.title`,
    [employee.id, employee.position_id]
  );

  const map = new Map<string, any>();
  for (const row of rows) {
    const id = String(row.checklist_id);
    if (!map.has(id)) map.set(id, {
      id, code:row.code, name:row.checklist_name, description:row.checklist_description,
      daily_warning_time:row.daily_warning_time,
      weekly_warning_weekday:row.weekly_warning_weekday,
      monthly_warning_days:row.monthly_warning_days,
      items:[], status:{},
    });
    map.get(id).items.push({
      id:String(row.item_id), item_key:row.item_key, frequency:row.frequency,
      section:row.section, title:row.title, description:row.description,
      sort_order:row.sort_order, is_required:row.is_required, is_active:row.is_active,
      completed:row.completed, completed_at:row.completed_at, note:row.note,
      period_start:row.period_start,
    });
  }
  const checklists = Array.from(map.values());
  for (const c of checklists) {
    c.status.daily = buildStatus(c.items,"daily",c);
    c.status.weekly = buildStatus(c.items,"weekly",c);
    c.status.monthly = buildStatus(c.items,"monthly",c);
  }
  return res.json({ employee, checklists, summary:aggregateSummary(checklists) });
}));

router.patch("/my/items/:itemId", asyncRoute(async (req, res) => {
  const employee = await resolveEmployee(req);
  if (!employee) return res.status(404).json({ error: "A belépett felhasználóhoz nem található munkatársi rekord." });
  if (!employee.position_id) return res.status(409).json({ error: "A munkatárshoz nincs munkakör rendelve." });
  const completed = req.body?.completed !== false;
  const note = req.body?.note == null ? null : String(req.body.note).slice(0,2000);

  const item = await pool.query(
    `SELECT i.id,i.frequency
       FROM vir_checklist_items i
       JOIN vir_checklists c ON c.id=i.checklist_id AND c.is_active=true
       JOIN vir_checklist_position_assignments a ON a.checklist_id=c.id AND a.is_active=true
      WHERE i.id=$1 AND i.is_active=true AND a.position_id=$2
      LIMIT 1`,
    [req.params.itemId, employee.position_id]
  );
  if (!item.rows[0]) return res.status(404).json({ error: "Ez a check lista tétel nincs a munkakörhöz rendelve." });

  const frequency = String(item.rows[0].frequency) as Frequency;
  const period = await pool.query(
    `SELECT CASE $1::text
      WHEN 'daily' THEN (now() AT TIME ZONE 'Europe/Budapest')::date
      WHEN 'weekly' THEN date_trunc('week',now() AT TIME ZONE 'Europe/Budapest')::date
      ELSE date_trunc('month',now() AT TIME ZONE 'Europe/Budapest')::date END AS period_start`,
    [frequency]
  );
  const periodStart = period.rows[0].period_start;

  const { rows } = await pool.query(
    `INSERT INTO vir_checklist_completions
       (checklist_item_id,employee_id,period_start,completed,completed_at,completed_by_user_id,location_id,note)
     VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN now() ELSE NULL END,$5,$6,$7)
     ON CONFLICT(checklist_item_id,employee_id,period_start) DO UPDATE SET
       completed=EXCLUDED.completed,
       completed_at=CASE WHEN EXCLUDED.completed THEN now() ELSE NULL END,
       completed_by_user_id=EXCLUDED.completed_by_user_id,
       location_id=EXCLUDED.location_id,
       note=EXCLUDED.note,
       updated_at=now()
     RETURNING completed,completed_at,note,period_start`,
    [req.params.itemId, employee.id, periodStart, completed, String(req.user?.id ?? ""), employee.location_id ?? req.user?.location_id ?? null, note]
  );
  return res.json({ ok:true, item_id:req.params.itemId, frequency, ...rows[0] });
}));

router.get("/admin/positions", requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT id,name,code FROM hr_positions WHERE COALESCE(is_active,true)=true ORDER BY name`);
  res.json(rows);
}));

router.get("/admin/checklists", requireAdmin, asyncRoute(async (_req, res) => {
  const checklists = await pool.query(
    `SELECT c.*,
            COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.code))
              FILTER (WHERE p.id IS NOT NULL AND a.is_active=true),'[]'::jsonb) AS positions
       FROM vir_checklists c
       LEFT JOIN vir_checklist_position_assignments a ON a.checklist_id::text=c.id::text
       LEFT JOIN hr_positions p ON p.id::text=a.position_id::text
      GROUP BY c.id
      ORDER BY c.name`
  );
  const items = await pool.query(
    `SELECT * FROM vir_checklist_items
      ORDER BY checklist_id,CASE frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,sort_order,title`
  );
  const byChecklist = new Map<string, any[]>();
  for (const i of items.rows) {
    const key=String(i.checklist_id); if(!byChecklist.has(key))byChecklist.set(key,[]); byChecklist.get(key)!.push(i);
  }
  res.json(checklists.rows.map(c=>({...c,items:byChecklist.get(String(c.id))||[]})));
}));

router.post("/admin/checklists", requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error:"A check lista neve kötelező." });
  const code = String(req.body?.code ?? `checklist-${Date.now()}`).trim().toLowerCase().replace(/[^a-z0-9_-]+/g,"-");
  const { rows } = await pool.query(
    `INSERT INTO vir_checklists(code,name,description,daily_warning_time,weekly_warning_weekday,monthly_warning_days,is_active,created_by)
     VALUES ($1,$2,$3,COALESCE($4::time,'18:00'::time),COALESCE($5,3),COALESCE($6,7),COALESCE($7,true),$8)
     RETURNING *`,
    [code,name,req.body?.description||null,req.body?.daily_warning_time||null,Number(req.body?.weekly_warning_weekday)||3,Number(req.body?.monthly_warning_days)||7,req.body?.is_active,String(req.user?.id??"")]
  );
  res.status(201).json(rows[0]);
}));

router.patch("/admin/checklists/:id", requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error:"A check lista neve kötelező." });
  const { rows } = await pool.query(
    `UPDATE vir_checklists SET
       name=$2,description=$3,daily_warning_time=COALESCE($4::time,daily_warning_time),
       weekly_warning_weekday=COALESCE($5,weekly_warning_weekday),
       monthly_warning_days=COALESCE($6,monthly_warning_days),
       is_active=COALESCE($7,is_active),updated_at=now()
     WHERE id=$1 RETURNING *`,
    [req.params.id,name,req.body?.description||null,req.body?.daily_warning_time||null,
     req.body?.weekly_warning_weekday==null?null:Number(req.body.weekly_warning_weekday),
     req.body?.monthly_warning_days==null?null:Number(req.body.monthly_warning_days),req.body?.is_active]
  );
  if(!rows[0])return res.status(404).json({error:"A check lista nem található."});
  res.json(rows[0]);
}));

router.put("/admin/checklists/:id/positions", requireAdmin, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.position_ids) ? req.body.position_ids.map(String).filter(Boolean) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE vir_checklist_position_assignments SET is_active=false,updated_at=now() WHERE checklist_id::text=$1`,[req.params.id]);
    for(const positionId of ids) {
      await client.query(
        `INSERT INTO vir_checklist_position_assignments(checklist_id,position_id,is_active)
         VALUES ($1,$2,true)
         ON CONFLICT(checklist_id,position_id) DO UPDATE SET is_active=true,updated_at=now()`,
        [req.params.id,positionId]
      );
    }
    await client.query("COMMIT");
    res.json({ok:true,position_ids:ids});
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}));

router.post("/admin/checklists/:id/items", requireAdmin, asyncRoute(async (req, res) => {
  const frequency = String(req.body?.frequency ?? "daily") as Frequency;
  if(!FREQUENCIES.has(frequency))return res.status(400).json({error:"Érvénytelen gyakoriság."});
  const title=String(req.body?.title??"").trim();
  if(!title)return res.status(400).json({error:"A feladat megnevezése kötelező."});
  const itemKey=String(req.body?.item_key??`${frequency}-${Date.now()}`).trim();
  const {rows}=await pool.query(
    `INSERT INTO vir_checklist_items(checklist_id,item_key,frequency,section,title,description,sort_order,is_required,is_active)
     VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,true),COALESCE($9,true)) RETURNING *`,
    [req.params.id,itemKey,frequency,req.body?.section||null,title,req.body?.description||null,Number(req.body?.sort_order)||0,req.body?.is_required,req.body?.is_active]
  );
  res.status(201).json(rows[0]);
}));

router.patch("/admin/items/:id", requireAdmin, asyncRoute(async (req, res) => {
  const frequency=String(req.body?.frequency??"") as Frequency;
  if(!FREQUENCIES.has(frequency))return res.status(400).json({error:"Érvénytelen gyakoriság."});
  const title=String(req.body?.title??"").trim();
  if(!title)return res.status(400).json({error:"A feladat megnevezése kötelező."});
  const {rows}=await pool.query(
    `UPDATE vir_checklist_items SET frequency=$2,section=$3,title=$4,description=$5,sort_order=$6,
       is_required=COALESCE($7,is_required),is_active=COALESCE($8,is_active),updated_at=now()
     WHERE id=$1 RETURNING *`,
    [req.params.id,frequency,req.body?.section||null,title,req.body?.description||null,Number(req.body?.sort_order)||0,req.body?.is_required,req.body?.is_active]
  );
  if(!rows[0])return res.status(404).json({error:"A check lista tétel nem található."});
  res.json(rows[0]);
}));

router.delete("/admin/items/:id", requireAdmin, asyncRoute(async (req,res)=>{
  const {rowCount}=await pool.query(`UPDATE vir_checklist_items SET is_active=false,updated_at=now() WHERE id=$1`,[req.params.id]);
  if(!rowCount)return res.status(404).json({error:"A check lista tétel nem található."});
  res.json({ok:true});
}));

async function managementStatus(req: AuthRequest, res: Response) {
  const admin = isAdmin(req);
  const requestedLocation = String(req.query.location_id ?? "").trim();
  const effectiveLocation = admin ? requestedLocation : String(req.user?.location_id ?? "").trim();
  const {rows}=await pool.query(
    `SELECT e.id AS employee_id,e.full_name,e.location_id,l.name AS location_name,p.name AS position_name,i.frequency,
            COUNT(*) FILTER (WHERE i.is_required=true)::int AS total,
            COUNT(cc.id) FILTER (WHERE i.is_required=true AND cc.completed=true)::int AS completed,
            BOOL_OR(
              CASE i.frequency
                WHEN 'daily' THEN (now() AT TIME ZONE 'Europe/Budapest')::time >= c.daily_warning_time
                WHEN 'weekly' THEN EXTRACT(ISODOW FROM now() AT TIME ZONE 'Europe/Budapest') >= c.weekly_warning_weekday
                WHEN 'monthly' THEN (((date_trunc('month',now() AT TIME ZONE 'Europe/Budapest') + interval '1 month - 1 day')::date - (now() AT TIME ZONE 'Europe/Budapest')::date) <= c.monthly_warning_days)
                ELSE false
              END
            ) FILTER (WHERE i.is_required=true AND COALESCE(cc.completed,false)=false) AS warning_active
       FROM employees e
       LEFT JOIN locations l ON l.id=e.location_id
       JOIN hr_positions p ON p.id::text=e.position_id::text
       JOIN vir_checklist_position_assignments a ON a.position_id::text=p.id::text AND a.is_active=true
       JOIN vir_checklists c ON c.id::text=a.checklist_id::text AND c.is_active=true
       JOIN vir_checklist_items i ON i.checklist_id::text=c.id::text AND i.is_active=true
       LEFT JOIN vir_checklist_completions cc
         ON cc.checklist_item_id=i.id AND cc.employee_id=e.id
        AND cc.period_start=${periodStartSql("i")}
      WHERE COALESCE(e.active,true)=true
        AND ($1='' OR e.location_id::text=$1)
      GROUP BY e.id,e.full_name,e.location_id,l.name,p.name,i.frequency
      ORDER BY e.full_name,CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END`,
    [effectiveLocation]
  );
  const map=new Map<string,any>();
  for(const row of rows){
    const id=String(row.employee_id);
    if(!map.has(id))map.set(id,{employee_id:id,full_name:row.full_name,location_id:row.location_id,location_name:row.location_name,position_name:row.position_name,daily:null,weekly:null,monthly:null});
    const total=Number(row.total||0),completed=Number(row.completed||0),missing=Math.max(0,total-completed),warning=missing>0&&row.warning_active===true;
    map.get(id)[row.frequency]={total,completed,missing,percent:total?Math.round(completed/total*100):100,warning,state:missing===0?"green":warning?"red":"amber"};
  }
  const employees=Array.from(map.values());
  const summary={
    employees:employees.length,
    red:employees.filter((e:any)=>[e.daily,e.weekly,e.monthly].some((s:any)=>s?.state==="red")).length,
    amber:employees.filter((e:any)=>![e.daily,e.weekly,e.monthly].some((s:any)=>s?.state==="red")&&[e.daily,e.weekly,e.monthly].some((s:any)=>s?.state==="amber")).length,
    green:employees.filter((e:any)=>[e.daily,e.weekly,e.monthly].every((s:any)=>!s||s.state==="green")).length,
  };
  res.json({summary,employees});
}

router.get("/management/status", requireManagement, asyncRoute(managementStatus));
router.get("/admin/status", requireAdmin, asyncRoute(managementStatus));

export default router;
