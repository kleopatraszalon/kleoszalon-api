import type {Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from './auth';
import {ensureTenantIsolation} from '../saas/ensureTenantIsolation';
import {locationBelongsToTenant,resolveTenantIdentity} from '../saas/tenantAccess';

const MANAGER=new Set(['location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager']);
function roles(raw:any):string[]{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').replace(/[\[\]"]/g,'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}
function isManager(req:AuthRequest){return roles(req.user?.role).some(r=>MANAGER.has(r))}
function ownLocation(req:AuthRequest){return req.user?.location_id?String(req.user.location_id):''}
async function employeeBelongs(employeeId:any,locationId:string,tenantId:string){if(!employeeId)return false;const q=await db.query(`SELECT 1 FROM employees WHERE id::text=$1 AND location_id::text=$2 AND tenant_id=$3::bigint LIMIT 1`,[String(employeeId),locationId,tenantId]);return Boolean(q.rows[0])}

async function guard(req:AuthRequest,res:Response,next:NextFunction){
 try{
  await ensureTenantIsolation();
  const tenant=await resolveTenantIdentity(req);
  if(!tenant){
   const denied=(req.user as any)?.tenant_feature_denied;
   return res.status(403).json({error:denied?`A(z) ${denied} modul nincs engedélyezve az előfizetési csomagban.`:'A felhasználóhoz nincs aktív tenant-hozzáférés.',code:denied?'TENANT_FEATURE_DISABLED':'TENANT_ACCESS_DENIED',feature:denied||undefined});
  }
  const requested=String(req.query.location_id||req.body?.location_id||'').trim();
  if(requested&&!(await locationBelongsToTenant(requested,tenant.id)))return res.status(403).json({error:'A kért telephely nem az aktív tenanthoz tartozik.',code:'TENANT_LOCATION_FORBIDDEN'});
  const own=ownLocation(req);
  if(own&&!(await locationBelongsToTenant(own,tenant.id)))return res.status(403).json({error:'A felhasználó telephelye nem az aktív tenanthoz tartozik.',code:'TENANT_LOCATION_MISMATCH'});

  if(!isManager(req))return next();
  const locationId=own;if(!locationId)return res.status(403).json({error:'Az üzletvezetői fiókhoz nincs telephely rendelve.'});
  const path=String(req.path||'');
  if(req.method==='GET'&&path==='/timesheets'){
   const from=req.query.from||null,to=req.query.to||null,employee=req.query.employee_id||null;
   if(employee&&!(await employeeBelongs(employee,locationId,tenant.id)))return res.status(404).json({error:'A munkatárs nem ehhez az üzlethez tartozik.'});
   const {rows}=await db.query(`SELECT t.*,e.full_name,l.name location_name FROM timesheets t JOIN employees e ON e.id=t.employee_id LEFT JOIN locations l ON l.id=COALESCE(t.location_id,e.location_id) WHERE e.tenant_id=$5::bigint AND ($1::date IS NULL OR t.work_date >= $1) AND ($2::date IS NULL OR t.work_date <= $2) AND ($3::uuid IS NULL OR t.employee_id=$3) AND COALESCE(t.location_id,e.location_id)=$4::uuid ORDER BY t.work_date DESC,e.full_name`,[from,to,employee,locationId,tenant.id]);
   return res.json(rows)
  }
  if(req.method==='GET'&&path==='/attendance-summary'){
   const from=req.query.from||new Date().toISOString().slice(0,8)+'01',to=req.query.to||new Date().toISOString().slice(0,10);
   const {rows}=await db.query(`SELECT COUNT(DISTINCT t.employee_id)::int employee_count,COALESCE(SUM(t.regular_minutes),0)::int regular_minutes,COALESCE(SUM(t.overtime_minutes),0)::int overtime_minutes,COALESCE(SUM(t.break_minutes),0)::int break_minutes,COUNT(*) FILTER(WHERE t.status='approved')::int approved_count,COUNT(*) FILTER(WHERE t.status<>'approved')::int open_count,(SELECT COUNT(*)::int FROM leave_requests r JOIN employees er ON er.id=r.employee_id WHERE er.tenant_id=$4::bigint AND r.status='pending' AND r.date_from<=$2::date AND r.date_to>=$1::date AND er.location_id=$3::uuid) pending_leave_count FROM timesheets t JOIN employees e ON e.id=t.employee_id WHERE e.tenant_id=$4::bigint AND t.work_date BETWEEN $1::date AND $2::date AND COALESCE(t.location_id,e.location_id)=$3::uuid`,[from,to,locationId,tenant.id]);
   return res.json({...rows[0],from,to,location_id:locationId})
  }
  if(req.method==='GET'&&path==='/leave-requests'){
   const employee=req.query.employee_id||null;if(employee&&!(await employeeBelongs(employee,locationId,tenant.id)))return res.status(404).json({error:'A munkatárs nem ehhez az üzlethez tartozik.'});
   const {rows}=await db.query(`SELECT r.*,e.full_name,t.name leave_type_name,t.color FROM leave_requests r JOIN employees e ON e.id=r.employee_id JOIN leave_types t ON t.id=r.leave_type_id WHERE e.tenant_id=$3::bigint AND e.location_id=$1::uuid AND ($2::uuid IS NULL OR r.employee_id=$2) ORDER BY r.date_from DESC`,[locationId,employee,tenant.id]);return res.json(rows)
  }
  if(req.method==='POST'&&path==='/timesheets'){
   if(!(await employeeBelongs(req.body?.employee_id,locationId,tenant.id)))return res.status(403).json({error:'Csak a saját üzlet munkatársának rögzíthető jelenlét.'});
   if(!req.body||typeof req.body!=='object')req.body={};req.body.location_id=locationId;return next()
  }
  if(req.method==='POST'&&path==='/leave-requests'){
   if(!(await employeeBelongs(req.body?.employee_id,locationId,tenant.id)))return res.status(403).json({error:'Csak a saját üzlet munkatársának rögzíthető távollét.'});return next()
  }
  const tm=path.match(/^\/timesheets\/([^/]+)\/status$/);if(tm&&req.method==='PATCH'){
   const q=await db.query(`SELECT 1 FROM timesheets t JOIN employees e ON e.id=t.employee_id WHERE e.tenant_id=$3::bigint AND t.id::text=$1 AND COALESCE(t.location_id,e.location_id)::text=$2 LIMIT 1`,[tm[1],locationId,tenant.id]);if(!q.rows[0])return res.status(404).json({error:'A jelenléti sor nem ehhez az üzlethez tartozik.'});return next()
  }
  const lm=path.match(/^\/leave-requests\/([^/]+)$/);if(lm&&req.method==='PATCH'){
   const q=await db.query(`SELECT 1 FROM leave_requests r JOIN employees e ON e.id=r.employee_id WHERE e.tenant_id=$3::bigint AND r.id::text=$1 AND e.location_id::text=$2 LIMIT 1`,[lm[1],locationId,tenant.id]);if(!q.rows[0])return res.status(404).json({error:'A távolléti kérelem nem ehhez az üzlethez tartozik.'});return next()
  }
  return next()
 }catch(error){next(error)}
}

export default function hrLocationScope(req:AuthRequest,res:Response,next:NextFunction){if(req.user)return void guard(req,res,next);return requireAuth(req,res,()=>void guard(req,res,next))}