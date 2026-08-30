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
function isDashboardRequest(req:AuthRequest):boolean{
  const path=String(req.originalUrl||req.baseUrl||req.url||"").split("?",1)[0].toLowerCase();
  return path==="/api/dashboard"||path.startsWith("/api/dashboard/");
}

async function tenantFromAuthenticatedLocation(userId:string,locationId:unknown,role:unknown){
  const value=String(locationId??"").trim();
  if(!value)return null;
  const fallbackRole=roleText(role).includes("admin")?"owner":"member";
  const {rows}=await db.query(`SELECT t.id::text id,t.slug,COALESCE(tu.tenant_role,$3::text) tenant_role
    FROM locations l
    JOIN tenants t ON t.id::text=l.tenant_id::text
    LEFT JOIN tenant_users tu ON tu.tenant_id=t.id AND tu.user_id=$1 AND tu.active=true
    WHERE l.id::text=$2 AND t.status IN ('active','trial')
    LIMIT 1`,[userId,value,fallbackRole]);
  return rows[0]??null;
}

async function tenantFromToken(userId:string,tenantId:string){
  if(!tenantId)return null;
  const {rows}=await db.query(`SELECT t.id::text id,t.slug,COALESCE(tu.tenant_role,'member') tenant_role
    FROM tenants t
    LEFT JOIN tenant_users tu ON tu.tenant_id=t.id AND tu.user_id=$1 AND tu.active=true
    WHERE t.id::text=$2 AND t.status IN ('active','trial')
    LIMIT 1`,[userId,tenantId]);
  return rows[0]??null;
}

async function tenantFromMembership(userId:string){
  const {rows}=await db.query(`SELECT t.id::text id,t.slug,COALESCE(tu.tenant_role,'member') tenant_role
    FROM tenant_users tu
    JOIN tenants t ON t.id=tu.tenant_id
    WHERE tu.user_id=$1 AND tu.active=true AND t.status IN ('active','trial')
    ORDER BY t.id
    LIMIT 1`,[userId]);
  return rows[0]??null;
}

export async function resolveTenantIdentity(req: AuthRequest): Promise<TenantIdentity|null> {
  await ensureSaasCore();
  const authUser=req.user as (NonNullable<AuthRequest["user"]>&{tenant_id?:string|number|null;tenant_feature_denied?:string|null})|undefined;
  if(!authUser?.id) return null;
  const userId=String(authUser.id),tokenTenantId=authUser.tenant_id==null?"":String(authUser.tenant_id);

  const tokenRow=tokenTenantId?await tenantFromToken(userId,tokenTenantId):null;
  const locationRow=await tenantFromAuthenticatedLocation(userId,authUser.location_id,authUser.role);

  // Dashboard requests may repair a stale signed tenant_id from the authenticated
  // salon, but normal tenant/location boundary middleware still applies before data
  // leaves the API. The repair changes identity resolution only; it does not widen scope.
  let row=tokenRow;
  if(isDashboardRequest(req)&&locationRow&&(!tokenRow||String(locationRow.id)!==String(tokenRow.id)))row=locationRow;
  if(!row&&!tokenTenantId)row=locationRow;
  if(!row&&!tokenTenantId)row=await tenantFromMembership(userId);
  if(!row){const fallback=await db.query(`SELECT id::text id,slug,$2::text tenant_role FROM tenants WHERE slug='kleopatra' AND status IN ('active','trial') LIMIT 1`,[userId,roleText(authUser.role).includes("admin")?"owner":"member"]);row=fallback.rows[0];}
  if(!row) return null;
  const tenantId=String(row.id);authUser.tenant_id=tenantId;authUser.tenant_feature_denied=null;
  const feature=featureForRequest(req);
  if(feature && !(await tenantFeatureEnabled(tenantId, feature))){authUser.tenant_feature_denied = feature;return null;}
  return{id:tenantId,slug:String(row.slug),role:String(row.tenant_role||"member")};
}
export async function tenantLocationIds(tenantId:string):Promise<string[]>{const{rows}=await db.query(`SELECT id::text id FROM locations WHERE tenant_id=$1`,[tenantId]);return rows.map((r:any)=>String(r.id));}
export async function locationBelongsToTenant(locationId:unknown,tenantId:string):Promise<boolean>{const value=String(locationId??"").trim();if(!value)return false;const{rows}=await db.query(`SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id=$2 LIMIT 1`,[value,tenantId]);return Boolean(rows[0]);}
export async function entityBelongsToTenant(table:string,id:string,tenantId:string):Promise<boolean>{
  const allowed = new Set(["employees","clients","appointments","work_orders","product_stock_balances","purchase_orders","payroll_runs","financial_transactions","finance_transactions","invoices"]);
  if (!allowed.has(table)) return false;
  const hasLocation=await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='location_id' LIMIT 1`,[table]);
  const sql=hasLocation.rowCount?`SELECT 1 FROM ${table} e LEFT JOIN locations l ON l.id::text=e.location_id::text WHERE e.id::text=$1 AND (e.tenant_id::text=$2::text OR l.tenant_id::text=$2::text) LIMIT 1`:`SELECT 1 FROM ${table} e WHERE e.id::text=$1 AND e.tenant_id::text=$2::text LIMIT 1`;
  const{rows}=await db.query(sql,[id,tenantId]);return Boolean(rows[0]);
}
export async function tenantFeatureEnabled(tenantId:string,featureKey:string):Promise<boolean>{const{rows}=await db.query(`SELECT COALESCE(tf.enabled,CASE WHEN COALESCE((sp.features->>'all_modules')::boolean,false) THEN true WHEN sp.features ? $2 THEN COALESCE((sp.features->>$2)::boolean,false) ELSE false END) AS enabled FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended') LEFT JOIN subscription_plans sp ON sp.id=s.plan_id LEFT JOIN tenant_features tf ON tf.tenant_id=t.id AND tf.feature_key=$2 WHERE t.id=$1::bigint LIMIT 1`,[tenantId,featureKey]);return rows[0]?.enabled===true;}
