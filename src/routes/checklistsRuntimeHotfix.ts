import { Router, Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

type Frequency = "daily" | "weekly" | "monthly";
const FREQUENCIES: Frequency[] = ["daily", "weekly", "monthly"];
const ADMIN = new Set(["admin","administrator","rendszergazda","superadmin","super_admin"]);
const MANAGEMENT = new Set([
  ...ADMIN,
  "manager","vezető","vezeto","location_manager","üzletvezető","uzletvezeto","store_manager","branch_manager","salon_manager","szalonvezető","szalonvezeto"
]);

function roleList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x=>x.toLowerCase());
  try {
    const parsed=JSON.parse(String(raw??""));
    if(Array.isArray(parsed)) return parsed.map(String).map(x=>x.toLowerCase());
  } catch {}
  return String(raw??"").replace(/[\[\]"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
}
function isAdmin(req:AuthRequest){ return roleList(req.user?.role).some(r=>ADMIN.has(r)); }
function isManagement(req:AuthRequest){ return roleList(req.user?.role).some(r=>MANAGEMENT.has(r)); }

async function tableExists(name:string){
  return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`])).rows[0]?.ok);
}

let schemaPromise:Promise<void>|null=null;
async function ensureChecklistSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(()=>undefined);
      await db.query(`
        CREATE TABLE IF NOT EXISTS vir_checklists(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text NOT NULL UNIQUE,name text NOT NULL,description text,
          daily_warning_time time NOT NULL DEFAULT '18:00',weekly_warning_weekday smallint NOT NULL DEFAULT 3,
          monthly_warning_days smallint NOT NULL DEFAULT 7,is_active boolean NOT NULL DEFAULT true,
          created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
        )`);
      await db.query(`CREATE TABLE IF NOT EXISTS vir_checklist_items(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),checklist_id uuid NOT NULL,item_key text NOT NULL,
          frequency text NOT NULL,section text,title text NOT NULL,description text,sort_order integer NOT NULL DEFAULT 0,
          is_required boolean NOT NULL DEFAULT true,is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(checklist_id,item_key)
        )`);
      await db.query(`CREATE TABLE IF NOT EXISTS vir_checklist_position_assignments(
          checklist_id uuid NOT NULL,position_id text NOT NULL,is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(checklist_id,position_id)
        )`);
      await db.query(`CREATE TABLE IF NOT EXISTS vir_checklist_completions(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),checklist_item_id uuid NOT NULL,employee_id text NOT NULL,
          period_start date NOT NULL,completed boolean NOT NULL DEFAULT true,completed_at timestamptz,
          completed_by_user_id text,location_id text,note text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(checklist_item_id,employee_id,period_start)
        )`);
      const alters=[
        `ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS daily_warning_time time NOT NULL DEFAULT '18:00'`,
        `ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS weekly_warning_weekday smallint NOT NULL DEFAULT 3`,
        `ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS monthly_warning_days smallint NOT NULL DEFAULT 7`,
        `ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
        `ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS section text`,
        `ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS description text`,
        `ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0`,
        `ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS is_required boolean NOT NULL DEFAULT true`,
        `ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
        `ALTER TABLE vir_checklist_position_assignments ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
        `ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT true`,
        `ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS completed_at timestamptz`,
        `ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS note text`
      ];
      for(const sql of alters) await db.query(sql);
    })().catch(e=>{schemaPromise=null;throw e});
  }
  return schemaPromise;
}

function periodStartSql(alias="i"){
  return `CASE ${alias}.frequency WHEN 'daily' THEN (now() AT TIME ZONE 'Europe/Budapest')::date WHEN 'weekly' THEN date_trunc('week',now() AT TIME ZONE 'Europe/Budapest')::date ELSE date_trunc('month',now() AT TIME ZONE 'Europe/Budapest')::date END`;
}
function clock(){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Budapest",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());
  const get=(t:string)=>parts.find(p=>p.type===t)?.value??"";
  const year=Number(get("year")),month=Number(get("month")),day=Number(get("day"));
  const weekday=({Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7} as Record<string,number>)[get("weekday")]??1;
  return {weekday,minutes:Number(get("hour"))*60+Number(get("minute")),daysToMonthEnd:new Date(Date.UTC(year,month,0)).getUTCDate()-day};
}
function warningActive(f:Frequency,c:any){
  const n=clock();
  if(f==="daily"){
    const m=String(c.daily_warning_time??"18:00").match(/^(\d{1,2}):(\d{2})/);const limit=m?Number(m[1])*60+Number(m[2]):1080;
    return n.minutes>=limit;
  }
  if(f==="weekly") return n.weekday>=Number(c.weekly_warning_weekday??3);
  return n.daysToMonthEnd<=Number(c.monthly_warning_days??7);
}
function status(items:any[],f:Frequency,c:any){
  const required=items.filter(x=>x.frequency===f&&x.is_active!==false&&x.is_required!==false);
  const completed=required.filter(x=>x.completed===true).length,total=required.length,missing=Math.max(0,total-completed);
  const warning=missing>0&&warningActive(f,c);
  return {frequency:f,total,completed,missing,percent:total?Math.round(completed/total*100):100,warning,state:missing===0?"green":warning?"red":"amber"};
}

async function resolveEmployee(req:AuthRequest){
  if(!await tableExists("employees")) return null;
  const email=String(req.user?.email??"").trim(), userId=String(req.user?.id??"").trim();
  const q=await db.query(`SELECT e.*,to_jsonb(e) AS raw FROM employees e WHERE ($1<>'' AND (lower(COALESCE(to_jsonb(e)->>'email',''))=lower($1) OR lower(COALESCE(to_jsonb(e)->>'login_name',''))=lower($1))) OR e.id::text=$2 ORDER BY CASE WHEN $1<>'' AND lower(COALESCE(to_jsonb(e)->>'email',''))=lower($1) THEN 0 ELSE 1 END LIMIT 1`,[email,userId]);
  const e=q.rows[0]; if(!e)return null;
  let positionId=String(e.raw?.position_id??e.position_id??"").trim();
  if(!positionId&&await tableExists("employee_position_assignments")){
    const a=await db.query(`SELECT position_id::text FROM employee_position_assignments WHERE employee_id::text=$1 AND COALESCE(is_active,true)=true AND COALESCE(valid_from,CURRENT_DATE)<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>=CURRENT_DATE) ORDER BY COALESCE(is_primary,false) DESC,valid_from DESC NULLS LAST LIMIT 1`,[String(e.id)]).catch(()=>({rows:[]} as any));
    positionId=String(a.rows[0]?.position_id??"");
  }
  let positionName:null|string=null;
  if(positionId&&await tableExists("hr_positions")){
    const p=await db.query(`SELECT name FROM hr_positions WHERE id::text=$1 LIMIT 1`,[positionId]).catch(()=>({rows:[]} as any));
    positionName=p.rows[0]?.name??null;
  }
  return {id:String(e.id),full_name:e.raw?.full_name??e.full_name??e.raw?.name??e.name??"",email:e.raw?.email??e.email??null,location_id:e.raw?.location_id??e.location_id??null,position_id:positionId||null,position_name:positionName};
}

router.get("/my",async(req:AuthRequest,res:Response,next:NextFunction)=>{
  try{
    await ensureChecklistSchema();
    const employee=await resolveEmployee(req);
    if(!employee)return res.status(404).json({error:"A belépett felhasználóhoz nem található munkatársi rekord."});
    if(!employee.position_id)return res.status(409).json({error:"A munkatárshoz nincs munkakör rendelve, ezért nincs kiosztható check lista."});
    const {rows}=await db.query(`SELECT c.id AS checklist_id,c.code,c.name AS checklist_name,c.description AS checklist_description,c.daily_warning_time,c.weekly_warning_weekday,c.monthly_warning_days,i.id AS item_id,i.item_key,i.frequency,i.section,i.title,i.description,i.sort_order,i.is_required,i.is_active,COALESCE(cc.completed,false) AS completed,cc.completed_at,cc.note,${periodStartSql("i")} AS period_start FROM vir_checklist_position_assignments a JOIN vir_checklists c ON c.id::text=a.checklist_id::text AND COALESCE(c.is_active,true)=true JOIN vir_checklist_items i ON i.checklist_id::text=c.id::text AND COALESCE(i.is_active,true)=true LEFT JOIN vir_checklist_completions cc ON cc.checklist_item_id::text=i.id::text AND cc.employee_id::text=$1 AND cc.period_start=${periodStartSql("i")} WHERE a.position_id::text=$2 AND COALESCE(a.is_active,true)=true ORDER BY c.name,CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,COALESCE(i.sort_order,0),i.title`,[employee.id,employee.position_id]);
    const map=new Map<string,any>();
    for(const r of rows){const id=String(r.checklist_id);if(!map.has(id))map.set(id,{id,code:r.code,name:r.checklist_name,description:r.checklist_description,daily_warning_time:r.daily_warning_time,weekly_warning_weekday:r.weekly_warning_weekday,monthly_warning_days:r.monthly_warning_days,items:[],status:{}});map.get(id).items.push({id:String(r.item_id),item_key:r.item_key,frequency:r.frequency,section:r.section,title:r.title,description:r.description,sort_order:r.sort_order,is_required:r.is_required,is_active:r.is_active,completed:r.completed,completed_at:r.completed_at,note:r.note,period_start:r.period_start});}
    const checklists=Array.from(map.values());
    for(const c of checklists)for(const f of FREQUENCIES)c.status[f]=status(c.items,f,c);
    const summary=FREQUENCIES.reduce((acc:any,f)=>{const xs=checklists.map(c=>c.status[f]);const total=xs.reduce((s:number,x:any)=>s+x.total,0),completed=xs.reduce((s:number,x:any)=>s+x.completed,0),warning=xs.some((x:any)=>x.warning),missing=Math.max(0,total-completed);acc[f]={frequency:f,total,completed,missing,percent:total?Math.round(completed/total*100):100,warning,state:missing===0?"green":warning?"red":"amber"};return acc;},{});
    res.json({employee,checklists,summary,schema_ready:true});
  }catch(e){next(e)}
});

async function management(req:AuthRequest,res:Response,next:NextFunction){
  try{
    if(!isManagement(req))return res.status(403).json({error:"A check lista állapotok megtekintéséhez vezetői jogosultság szükséges."});
    await ensureChecklistSchema();
    if(!await tableExists("employees"))return res.json({summary:{employees:0,red:0,amber:0,green:0},employees:[],schema_ready:false,message:"Az employees tábla nem érhető el."});
    const admin=isAdmin(req),requested=String(req.query.location_id??"").trim(),own=String(req.user?.location_id??"").trim();
    const location=admin?requested:own;
    if(!admin&&!location)return res.status(403).json({error:"A felhasználóhoz nincs szalon rendelve."});
    const {rows}=await db.query(`SELECT e.id::text employee_id,COALESCE(to_jsonb(e)->>'full_name',to_jsonb(e)->>'name','') full_name,to_jsonb(e)->>'location_id' location_id,to_jsonb(e)->>'position_id' position_id,i.frequency,COUNT(*) FILTER(WHERE COALESCE(i.is_required,true))::int total,COUNT(cc.id) FILTER(WHERE COALESCE(i.is_required,true) AND COALESCE(cc.completed,false))::int completed,BOOL_OR(CASE i.frequency WHEN 'daily' THEN (now() AT TIME ZONE 'Europe/Budapest')::time>=c.daily_warning_time WHEN 'weekly' THEN EXTRACT(ISODOW FROM now() AT TIME ZONE 'Europe/Budapest')>=c.weekly_warning_weekday WHEN 'monthly' THEN (((date_trunc('month',now() AT TIME ZONE 'Europe/Budapest')+interval '1 month - 1 day')::date-(now() AT TIME ZONE 'Europe/Budapest')::date)<=c.monthly_warning_days) ELSE false END) FILTER(WHERE COALESCE(i.is_required,true) AND NOT COALESCE(cc.completed,false)) warning_active FROM employees e JOIN vir_checklist_position_assignments a ON a.position_id::text=(to_jsonb(e)->>'position_id') AND COALESCE(a.is_active,true)=true JOIN vir_checklists c ON c.id::text=a.checklist_id::text AND COALESCE(c.is_active,true)=true JOIN vir_checklist_items i ON i.checklist_id::text=c.id::text AND COALESCE(i.is_active,true)=true LEFT JOIN vir_checklist_completions cc ON cc.checklist_item_id::text=i.id::text AND cc.employee_id::text=e.id::text AND cc.period_start=${periodStartSql("i")} WHERE COALESCE((to_jsonb(e)->>'active')::boolean,true)=true AND ($1='' OR to_jsonb(e)->>'location_id'=$1) GROUP BY e.id,i.frequency ORDER BY full_name,CASE i.frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END`,[location]);
    const map=new Map<string,any>();
    for(const r of rows){const id=String(r.employee_id);if(!map.has(id))map.set(id,{employee_id:id,full_name:r.full_name,location_id:r.location_id,position_id:r.position_id,daily:null,weekly:null,monthly:null});const total=Number(r.total||0),completed=Number(r.completed||0),missing=Math.max(0,total-completed),warning=missing>0&&r.warning_active===true;map.get(id)[r.frequency]={total,completed,missing,percent:total?Math.round(completed/total*100):100,warning,state:missing===0?"green":warning?"red":"amber"};}
    const employees=Array.from(map.values());
    const summary={employees:employees.length,red:employees.filter((e:any)=>FREQUENCIES.some(f=>e[f]?.state==="red")).length,amber:employees.filter((e:any)=>!FREQUENCIES.some(f=>e[f]?.state==="red")&&FREQUENCIES.some(f=>e[f]?.state==="amber")).length,green:employees.filter((e:any)=>FREQUENCIES.every(f=>!e[f]||e[f].state==="green")).length};
    res.json({summary,employees,schema_ready:true});
  }catch(e){next(e)}
}
router.get("/management/status",management);
router.get("/admin/status",management);

export default router;
