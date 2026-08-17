import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { ensureSaasCore } from "./ensureSaasCore";

export type TenantIdentity = { id: string; slug: string; role: string };
function roleText(value: unknown): string { if(Array.isArray(value)) return value.map(String).join(",").toLowerCase(); return String(value??"").toLowerCase(); }
function featureForRequest(req: AuthRequest): string | null {
  const url=String(req.originalUrl||req.baseUrl||req.url||"").toLowerCase();
  if(url.startsWith("/api/clients")) return "crm";
  if(url.startsWith("/api/appointments")||url.startsWith("/api/bookings")||url.startsWith("/api/workorders")) return "booking";
  if(url.startsWith("/api/employees")||url.startsWith("/api/hr")||url.startsWith("/api/payroll")||url.startsWith("/api/timetable")||url.startsWith("/api/checklists")) return "hr";
  if(url.startsWith("/api/transactions/inventory")||url.startsWith("/api/transactions/procurement")||url.startsWith("/api/warehouse")) return "inventory";
  if(url.startsWith("/api/transactions/finance")||url.startsWith("/api/finance")||url.startsWith("/api/payroll-accounting")) return "finance";
  if(url.startsWith("/api/marketing")||url.startsWith("/api/newsletter")||url.startsWith("/api/daily-actions")) return "marketing";
  return null;
}

export async function resolveTenantIdentity(req: AuthRequest): Promise<TenantIdentity|null> {
  await ensureSaasCore();
  const authUser=req.user as (NonNullable<AuthRequest["user"]>&{tenant_id?:string|number|null;tenant_feature_denied?:string|null})|undefined;
  if(!authUser?.id) return null;
  const userId=String(authUser.id),tokenTenantId=authUser.tenant_id==null?"":String(authUser.tenant_id);
  const {rows}=await db.query(`SELECT t.id::text id,t.slug,COALESCE(tu.tenant_role,'member') tenant_role FROM tenants t LEFT JOIN tenant_users tu ON tu.tenant_id=t.id AND tu.user_id=$1 AND tu.active=true WHERE t.status IN ('active','trial') AND (($2<>'' AND t.id::text=$2) OR ($2='' AND tu.user_id IS NOT NULL)) ORDER BY CASE WHEN $2<>'' AND t.id::text=$2 THEN 0 ELSE 1 END,t.id LIMIT 1`,[userId,tokenTenantId]);
  let row=rows[0];
  if(!row){const fallback=await db.query(`SELECT id::text id,slug,$2::text tenant_role FROM tenants WHERE slug='kleopatra' AND status IN ('active','trial') LIMIT 1`,[userId,roleText(authUser.role).includes("admin")?"owner":"member"]);row=fallback.rows[0];}
  if(!row) return null;
  const tenantId=String(row.id);authUser.tenant_id=tenantId;authUser.tenant_feature_denied=null;
  const feature=featureForRequest(req);
  if(feature && !(await tenantFeatureEnabled(tenantId, feature))){authUser.tenant_feature_denied = feature;return null;}
  return{id:tenantId,slug:String(row.slug),role:String(row.tenant_role||"member")};
}
export async function tenantLocationIds(tenantId:string):Promise<string[]>{const{rows}=await db.query(`SELECT id::text id FROM locations WHERE tenant_id::text=$1::text`,[tenantId]);return rows.map((r:any)=>String(r.id));}
export async function locationBelongsToTenant(locationId:unknown,tenantId:string):Promise<boolean>{const value=String(locationId??"").trim();if(!value)return false;const{rows}=await db.query(`SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id::text=$2::text LIMIT 1`,[value,tenantId]);return Boolean(rows[0]);}
export async function entityBelongsToTenant(table:string,id:string,tenantId:string):Promise<boolean>{
  const allowed = new Set(["employees","clients","appointments","work_orders","product_stock_balances","purchase_orders","payroll_runs","financial_transactions","finance_transactions","invoices"]);
  if (!allowed.has(table)) return false;
  const hasLocation=await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='location_id' LIMIT 1`,[table]);
  const sql=hasLocation.rowCount?`SELECT 1 FROM ${table} e LEFT JOIN locations l ON l.id::text=e.location_id::text WHERE e.id::text=$1 AND (e.tenant_id::text=$2::text OR l.tenant_id::text=$2::text) LIMIT 1`:`SELECT 1 FROM ${table} e WHERE e.id::text=$1 AND e.tenant_id::text=$2::text LIMIT 1`;
  const{rows}=await db.query(sql,[id,tenantId]);return Boolean(rows[0]);
}
export async function tenantFeatureEnabled(tenantId:string,featureKey:string):Promise<boolean>{const{rows}=await db.query(`SELECT COALESCE(tf.enabled,CASE WHEN COALESCE((sp.features->>'all_modules')::boolean,false) THEN true WHEN sp.features ? $2 THEN COALESCE((sp.features->>$2)::boolean,false) ELSE false END) AS enabled FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended') LEFT JOIN subscription_plans sp ON sp.id=s.plan_id LEFT JOIN tenant_features tf ON tf.tenant_id=t.id AND tf.feature_key=$2 WHERE t.id=$1::bigint LIMIT 1`,[tenantId,featureKey]);return rows[0]?.enabled===true;}
