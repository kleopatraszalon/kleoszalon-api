import type { Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "./auth";

export type MenuAction =
  | "can_view"
  | "can_create"
  | "can_edit"
  | "can_delete"
  | "can_approve"
  | "can_export"
  | "can_view_financial"
  | "can_manage_permissions";

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
  return value
    .split(",")
    .map(x => x.replace(/[\[\]"]/g, ""))
    .map(normalizeRole)
    .filter(Boolean);
}

async function checkMenuPermission(
  menuCode: string,
  action: MenuAction,
  req: AuthRequest & { accessScope?: string },
  res: Response,
  next: NextFunction
) {
  try {
    const roles = roleKeys(req);
    if (roles.includes("admin")) {
      req.accessScope = "all_locations";
      return next();
    }
    if (!roles.length) return res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });

    // Az is_active kizárólag a navigáció láthatóságát szabályozza. Egy rejtett
    // menü mögötti API jogosultságát továbbra is ellenőrizni kell; különben egy
    // menüpont elrejtése véletlen jogosultság-bypass-t okozna.
    const menu = await db.query(`SELECT id FROM menus WHERE code=$1 ORDER BY COALESCE(is_active,true) DESC,id LIMIT 1`, [menuCode]);
    if (!menu.rows[0]) return next();

    const rows = await db.query(
      `SELECT role_key, ${action} AS allowed, scope_type
       FROM role_menu_permissions
       WHERE role_key = ANY($1::text[]) AND menu_id=$2`,
      [roles, menu.rows[0].id]
    );

    if (!rows.rowCount) return next();
    const allowed = rows.rows.filter((r: any) => r.allowed === true);
    if (!allowed.length) {
      return res.status(403).json({
        error: "Ehhez a művelethez nincs jogosultsága.",
        menu_code: menuCode,
        permission: action,
      });
    }

    const rank: Record<string, number> = { own: 0, own_location: 1, selected_locations: 2, all_locations: 3 };
    req.accessScope = allowed
      .map((r: any) => String(r.scope_type || "own_location"))
      .sort((a: string, b: string) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] || "own_location";
    return next();
  } catch (error: any) {
    if (["42P01", "42703"].includes(String(error?.code || ""))) return next();
    return next(error);
  }
}

export function requireMenuPermission(menuCode: string, action: MenuAction = "can_view") {
  return (req: AuthRequest & { accessScope?: string }, res: Response, next: NextFunction) => {
    if (!req.user) {
      return requireAuth(req, res, () => {
        void checkMenuPermission(menuCode, action, req, res, next);
      });
    }
    void checkMenuPermission(menuCode, action, req, res, next);
  };
}

/** Egységes CRUD-védelem egy teljes routerre. */
export function requireMenuPermissionByMethod(menuCode: string) {
  return (req: AuthRequest & { accessScope?: string }, res: Response, next: NextFunction) => {
    let action: MenuAction = "can_view";
    switch (String(req.method || "GET").toUpperCase()) {
      case "POST": action = "can_create"; break;
      case "PUT":
      case "PATCH": action = "can_edit"; break;
      case "DELETE": action = "can_delete"; break;
      default: action = "can_view";
    }
    return requireMenuPermission(menuCode, action)(req, res, next);
  };
}
