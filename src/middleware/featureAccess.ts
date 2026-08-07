import type { Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "./auth";

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

async function checkFeature(featureKey: string, req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const roles = roleKeys(req);
    if (roles.includes("admin")) return next();
    if (!roles.length) return res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });

    const configured = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM role_feature_permissions
       WHERE role_key = ANY($1::text[]) AND feature_key = $2`,
      [roles, featureKey]
    );

    // Visszafelé kompatibilis átmenet: amíg egy funkcióhoz nincs szerepkör-szabály,
    // a korábbi jogosultsági működés marad érvényben.
    if (Number(configured.rows[0]?.count || 0) === 0) return next();

    const allowed = await db.query(
      `SELECT 1
       FROM role_feature_permissions
       WHERE role_key = ANY($1::text[]) AND feature_key = $2 AND can_use = true
       LIMIT 1`,
      [roles, featureKey]
    );
    if (allowed.rowCount) return next();
    return res.status(403).json({ error: "Ehhez a funkcióhoz nincs jogosultsága.", feature_key: featureKey });
  } catch (error: any) {
    // Ha a migráció még nem futott le, ne törjük el a meglévő rendszert.
    if (String(error?.code || "") === "42P01") return next();
    next(error);
  }
}

export function requireFeature(featureKey: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    // A feature guard önállóan is biztonságos: ha a szülő routeren még nem futott
    // requireAuth, előbb hitelesítjük és feltöltjük a req.user objektumot.
    if (!req.user) {
      return requireAuth(req, res, () => {
        void checkFeature(featureKey, req, res, next);
      });
    }
    void checkFeature(featureKey, req, res, next);
  };
}
