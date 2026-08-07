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

function ruleForPath(path: string): Rule | null {
  if (path === "/api/hr" || path.startsWith("/api/hr/")) return { feature: "hr", menu: "team" };
  if (path === "/api/payroll" || path.startsWith("/api/payroll/")) return { feature: "hr", menu: "team.payroll" };
  if (path.startsWith("/api/transactions/inventory")) return { feature: "inventory", menu: "inventory" };
  if (path.startsWith("/api/transactions/cashier")) return { feature: "finance", menu: "finance.checkout" };
  if (path.startsWith("/api/transactions/audit")) return { feature: "audit", menu: "settings.audit" };
  return null;
}

/**
 * A legfontosabb üzleti API-k központi védelme. A router-szintű speciális
 * guardok (jóváhagyás, export, pénzügyi láthatóság) továbbra is ráépülhetnek.
 */
export async function enforceKnownModuleAccess(req: AuthRequest, res: Response): Promise<boolean> {
  const rule = ruleForPath(String(req.originalUrl || req.url || "").split("?", 1)[0]);
  if (!rule) return true;

  const roles = roleKeys(req);
  if (roles.includes("admin")) return true;
  if (!roles.length) {
    res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });
    return false;
  }

  try {
    const featureRows = await db.query(
      `SELECT can_use FROM role_feature_permissions WHERE role_key=ANY($1::text[]) AND feature_key=$2`,
      [roles, rule.feature]
    );
    if (featureRows.rowCount && !featureRows.rows.some((r: any) => r.can_use === true)) {
      res.status(403).json({ error: "Ehhez a funkcióhoz nincs jogosultsága.", feature_key: rule.feature });
      return false;
    }

    const menu = await db.query(`SELECT id FROM menus WHERE code=$1 AND COALESCE(is_active,true)=true LIMIT 1`, [rule.menu]);
    if (!menu.rows[0]) return true;
    const action = actionForMethod(req.method);
    const permissions = await db.query(
      `SELECT ${action} AS allowed FROM role_menu_permissions WHERE role_key=ANY($1::text[]) AND menu_id=$2`,
      [roles, menu.rows[0].id]
    );
    if (permissions.rowCount && !permissions.rows.some((r: any) => r.allowed === true)) {
      res.status(403).json({ error: "Ehhez a művelethez nincs jogosultsága.", menu_code: rule.menu, permission: action });
      return false;
    }
    return true;
  } catch (error: any) {
    // Migráció előtti környezetben kompatibilisen továbbengedünk.
    if (["42P01", "42703"].includes(String(error?.code || ""))) return true;
    throw error;
  }
}
