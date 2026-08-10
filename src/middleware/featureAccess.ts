import type { Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "./auth";
import { parseRoleKeys } from "../security/roles";
import { isRbacFailClosed } from "../security/rbacMode";

async function checkFeature(featureKey: string, req: AuthRequest, res: Response, next: NextFunction) {
  let strict = false;
  try {
    const roles = parseRoleKeys(req.user?.role);
    if (roles.includes("admin")) return next();
    if (!roles.length) return res.status(403).json({ error: "Nincs érvényes szerepkör a művelethez." });

    strict = await isRbacFailClosed();
    const configured = await db.query(
      `SELECT can_use,scope_type
       FROM role_feature_permissions
       WHERE lower(role_key)=ANY($1::text[]) AND feature_key=$2`,
      [roles, featureKey]
    );

    if (!configured.rowCount) {
      if (!strict) return next();
      return res.status(403).json({
        error: "Ehhez a funkcióhoz nincs explicit jogosultság beállítva.",
        feature_key: featureKey,
        reason: "feature_not_configured",
      });
    }
    if (configured.rows.some((row: any) => row.can_use === true)) return next();
    return res.status(403).json({ error: "Ehhez a funkcióhoz nincs jogosultsága.", feature_key: featureKey });
  } catch (error: any) {
    if (["42P01", "42703"].includes(String(error?.code || ""))) {
      if (!strict) return next();
      return res.status(503).json({
        error: "A funkciójogosultsági rendszer sémája hiányos. A hozzáférés biztonsági okból megtagadva.",
        code: "rbac_schema_unavailable",
      });
    }
    return next(error);
  }
}

export function requireFeature(featureKey: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return requireAuth(req, res, () => {
        void checkFeature(featureKey, req, res, next);
      });
    }
    void checkFeature(featureKey, req, res, next);
  };
}
