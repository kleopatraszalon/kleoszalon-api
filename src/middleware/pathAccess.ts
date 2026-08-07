import type { Response } from "express";
import db from "../db";
import type { AuthRequest } from "./auth";
import type { MenuAction } from "./menuPermission";

function normalizeRole(value: string): string {
  const role = value.trim().toLowerCase();
  if (["administrator", "rendszergazda", "superadmin", "super_admin"].includes(role)) return "admin";
  if (["vezető", "vezeto"].includes(role)) return "manager";
  return role;
}

function roleKeys(req: AuthRequest): string[] {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map(normalizeRole).filter(Boolean);
  const value = String(raw || "");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(normalizeRole).filter(Boolean);
  } catch {}
  return value.split(",").map(x => x.replace(/[\[\]"]/g, "")).map(normalizeRole).filter(Boolean);
}

function actionForMethod(method: string): MenuAction {
  switch (method.toUpperCase()) {
    case "POST": return "can_create";
    case "PUT":
    case "PATCH": return "can_edit";
    case "DELETE": return "can_delete";
    default: return "can_view";
  }
}

type Rule = { feature: string; menu: string };
const rank: Record<string, number> = { own: 0, own_location: 1, selected_locations: 2, all_locations: 3 };
function strongest(values: string[]) { return values.sort((a,b)=>(rank[b]??0)-(rank[a]??0))[0] || "own_location"; }
function moreRestrictive(a:string,b:string){ return (rank[a]??1) <= (rank[b]??1) ? a : b; }

function ruleForPath(path: string): Rule | null {
  // HR-en belül a bér/kompenzáció külön érzékeny jogosultságot kap.
  if (path === "/api/payroll" || path.startsWith("/api/payroll/")) return { feature: "hr", menu: "team.payroll" };
  if (path.startsWith("/api/hr/compensation-plans")) return { feature: "hr", menu: "team.payroll" };
  if (/^\/api\/hr\/employees\/[^/]+\/compensation(?:\/|$)/.test(path)) return { feature: "hr", menu: "team.payroll" };
  if (path === "/api/hr" || path.startsWith("/api/hr/")) return { feature: "hr", menu: "team" };

  if (path.startsWith("/api/transactions/inventory")) return { feature: "inventory", menu: "inventory" };

  // Vezetői összesítők külön dashboard-jogosultságot kapnak, nem a napi pénztárjogot.
  if (path.startsWith("/api/transactions/cashier/management-summary") || path.startsWith("/api/transactions/management"))
    return { feature: "management_dashboard", menu: "analytics.main" };
  if (path.startsWith("/api/transactions/cashier")) return { feature: "finance", menu: "finance.checkout" };

  if (path.startsWith("/api/transactions/audit")) return { feature: "audit", menu: "settings.audit" };
  return null;
}

function requestLocation(req: AuthRequest): string | null {
  const q:any=req.query||{}; const b:any=req.body||{};
  const raw=q.location_id ?? b.location_id ?? null;
  return raw == null || raw === "" ? null : String(raw);
}
function injectLocation(req: AuthRequest, locationId: string) {
  if (["GET","HEAD","DELETE"].includes(req.method.toUpperCase())) (req.query as any).location_id=locationId;
  else { if (!req.body || typeof req.body !== "object") req.body={}; (req.body as any).location_id=locationId; }
}

async function enforceLocationScope(req:AuthRequest,res:Response,roles:string[],scope:string):Promise<boolean>{
  if(scope==="all_locations") return true;
  const requested=requestLocation(req);
  if(scope==="own" || scope==="own_location"){
    const own=req.user?.location_id==null?null:String(req.user.location_id);
    if(!own){res.status(403).json({error:"A felhasználóhoz nincs telephely rendelve.",scope_type:scope});return false;}
    if(requested && requested!==own){res.status(403).json({error:"Ehhez a telephelyhez nincs jogosultsága.",scope_type:scope,location_id:requested});return false;}
    if(!requested) injectLocation(req,own);
    return true;
  }
  if(scope==="selected_locations"){
    const allowed=(await db.query(`SELECT DISTINCT location_id FROM role_location_permissions WHERE role_key=ANY($1::text[]) AND can_access=true`,[roles])).rows.map((x:any)=>String(x.location_id));
    if(!allowed.length){res.status(403).json({error:"A szerepkörhöz nincs kijelölt telephely.",scope_type:scope});return false;}
    if(requested){if(!allowed.includes(requested)){res.status(403).json({error:"A kiválasztott telephely nincs engedélyezve ehhez a szerepkörhöz.",scope_type:scope,location_id:requested});return false;}return true;}
    if(allowed.length===1){injectLocation(req,allowed[0]);return true;}
    res.status(400).json({error:"Ehhez a művelethez válasszon egy engedélyezett telephelyet.",scope_type:scope,allowed_location_ids:allowed});return false;
  }
  return true;
}

/** Központi feature + művelet + telephely-hatókör védelem a fő üzleti API-kon. */
export async function enforceKnownModuleAccess(req: AuthRequest, res: Response): Promise<boolean> {
  const rule = ruleForPath(String(req.originalUrl || req.url || "").split("?", 1)[0]);
  if (!rule) return true;

  const roles = roleKeys(req);
  if (roles.includes("admin")) return true;
  if (!roles.length) { res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." }); return false; }

  try {
    const featureRows = await db.query(`SELECT can_use,scope_type FROM role_feature_permissions WHERE role_key=ANY($1::text[]) AND feature_key=$2`,[roles,rule.feature]);
    if (featureRows.rowCount && !featureRows.rows.some((r:any)=>r.can_use===true)) {res.status(403).json({error:"Ehhez a funkcióhoz nincs jogosultsága.",feature_key:rule.feature});return false;}
    const featureScope=strongest(featureRows.rows.filter((r:any)=>r.can_use===true).map((r:any)=>String(r.scope_type||"own_location")));

    const menu = await db.query(`SELECT id FROM menus WHERE code=$1 AND COALESCE(is_active,true)=true LIMIT 1`, [rule.menu]);
    if (!menu.rows[0]) return enforceLocationScope(req,res,roles,featureScope);
    const action = actionForMethod(req.method);
    const permissions = await db.query(`SELECT ${action} AS allowed,scope_type FROM role_menu_permissions WHERE role_key=ANY($1::text[]) AND menu_id=$2`,[roles,menu.rows[0].id]);
    if (permissions.rowCount && !permissions.rows.some((r:any)=>r.allowed===true)) {res.status(403).json({error:"Ehhez a művelethez nincs jogosultsága.",menu_code:rule.menu,permission:action});return false;}
    const menuScope=strongest(permissions.rows.filter((r:any)=>r.allowed===true).map((r:any)=>String(r.scope_type||"own_location")));
    const effectiveScope=moreRestrictive(featureScope,menuScope);
    return enforceLocationScope(req,res,roles,effectiveScope);
  } catch (error: any) {
    if (["42P01", "42703"].includes(String(error?.code || ""))) return true;
    throw error;
  }
}
