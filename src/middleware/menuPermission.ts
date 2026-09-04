import type { Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "./auth";
import { parseRoleKeys } from "../security/roles";
import { isRbacFailClosed } from "../security/rbacMode";

export type MenuAction =
  | "can_view"
  | "can_create"
  | "can_edit"
  | "can_delete"
  | "can_approve"
  | "can_export"
  | "can_view_financial"
  | "can_manage_permissions";

const RECEPTIONIST_CHECKOUT_ACTIONS = new Set<MenuAction>(["can_view", "can_create", "can_edit"]);

async function checkMenuPermission(
  menuCode: string,
  action: MenuAction,
  req: AuthRequest & { accessScope?: string },
  res: Response,
  next: NextFunction
) {
  let strict = false;
  try {
    const roles = parseRoleKeys(req.user?.role);
    if (roles.includes("admin")) {
      req.accessScope = "all_locations";
      return next();
    }
    if (!roles.length) return res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });

    // Üzleti alapszabály: a recepciós a saját telephelyén kezeli a kasszát és a
    // munkalap fizetését/lezárását. Ezt nem teheti működésképtelenné egy régi vagy
    // hiányos role_menu_permissions sor. A workOrderFinanceScope továbbra is
    // own-location határt érvényesít, ezért ez nem ad globális pénzügyi hozzáférést.
    if (menuCode === "finance.checkout" && roles.includes("receptionist") && RECEPTIONIST_CHECKOUT_ACTIONS.has(action)) {
      req.accessScope = "own_location";
      return next();
    }

    strict = await isRbacFailClosed();
    const menu = await db.query(
      `SELECT id FROM menus WHERE code=$1 ORDER BY COALESCE(is_active,true) DESC,id LIMIT 1`,
      [menuCode]
    );
    if (!menu.rows[0]) {
      if (!strict) return next();
      return res.status(403).json({
        error: "A kért funkcióhoz nincs konfigurált menüjogosultság.",
        menu_code: menuCode,
        permission: action,
        reason: "menu_not_configured",
      });
    }

    const rows = await db.query(
      `SELECT role_key, ${action} AS allowed, scope_type
       FROM role_menu_permissions
       WHERE lower(role_key)=ANY($1::text[]) AND menu_id=$2`,
      [roles, menu.rows[0].id]
    );

    if (!rows.rowCount) {
      if (!strict) return next();
      return res.status(403).json({
        error: "Ehhez a művelethez nincs explicit jogosultság beállítva.",
        menu_code: menuCode,
        permission: action,
        reason: "permission_not_configured",
      });
    }

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
    if (["42P01", "42703"].includes(String(error?.code || ""))) {
      if (!strict) return next();
      return res.status(503).json({
        error: "A jogosultsági rendszer sémája hiányos. A hozzáférés biztonsági okból megtagadva.",
        code: "rbac_schema_unavailable",
      });
    }
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