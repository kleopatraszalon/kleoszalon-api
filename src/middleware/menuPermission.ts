import type { Response, NextFunction } from "express";
import db from "../db";
import type { AuthRequest } from "./auth";

export type MenuAction =
  | "can_view"
  | "can_create"
  | "can_edit"
  | "can_delete"
  | "can_approve"
  | "can_export"
  | "can_view_financial"
  | "can_manage_permissions";

function roleKeys(req: AuthRequest): string[] {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map(x => x.toLowerCase());
  const value = String(raw || "");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.toLowerCase());
  } catch {}
  return value.split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}

/**
 * Szerveroldali műveleti jogosultság-ellenőrzés menükód alapján.
 * - admin: teljes hozzáférés
 * - ha a menühöz az adott szerepkörökre még nincs explicit szabály, a régi
 *   működés marad érvényben (backward compatibility)
 * - ha van szabály, legalább egy szerepkörnek engedélyeznie kell a műveletet
 * A kiszámolt legerősebb hatókört req.accessScope értéken továbbadjuk.
 */
export function requireMenuPermission(menuCode: string, action: MenuAction = "can_view") {
  return async (req: AuthRequest & { accessScope?: string }, res: Response, next: NextFunction) => {
    try {
      const roles = roleKeys(req);
      if (roles.includes("admin")) {
        req.accessScope = "all_locations";
        return next();
      }
      if (!roles.length) return res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });

      const menu = await db.query(`SELECT id FROM menus WHERE code=$1 AND COALESCE(is_active,true)=true LIMIT 1`, [menuCode]);
      if (!menu.rows[0]) {
        // A menümigráció hiánya ne tegye működésképtelenné a régi modult.
        return next();
      }

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
      next();
    } catch (error: any) {
      // Hiányzó jogosultsági migrációnál kompatibilisen továbbengedünk.
      if (["42P01", "42703"].includes(String(error?.code || ""))) return next();
      next(error);
    }
  };
}
