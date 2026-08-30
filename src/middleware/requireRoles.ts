import type { NextFunction, Response } from "express";
import { requireAuth, type AuthRequest } from "./auth";
import { hasAnyRole, parseRoleKeys } from "../security/roles";
import { writeSystemAudit } from "../audit/systemAudit";

const ACCOUNTING_ROLE_KEYS = new Set(["accounting", "bookkeeper", "könyvelés", "konyveles"]);

function hasScopedAccountingLegalEntityAccess(allowed: readonly string[], req: AuthRequest): boolean {
  if (allowed.length !== 1 || String(allowed[0]).toLowerCase() !== "admin") return false;
  const roles = parseRoleKeys(req.user?.role);
  if (!roles.some(role => ACCOUNTING_ROLE_KEYS.has(role))) return false;
  const url = String(req.originalUrl || req.url || "");
  return /\/vir\/receipt-compliance\/legal-entities(?:\/|$)/.test(url);
}

function auditDenied(allowed: readonly string[], req: AuthRequest) {
  void writeSystemAudit(req, {
    moduleKey: "security.rbac",
    entityType: "route",
    entityId: req.originalUrl || req.url,
    action: "access_denied",
    severity: "warning",
    summary: "Backend RBAC megtagadta a hozzáférést.",
    metadata: {
      required_roles: [...allowed],
      current_roles: parseRoleKeys(req.user?.role),
      method: req.method,
    },
  });
}

function checkRoles(allowed: readonly string[], req: AuthRequest, res: Response, next: NextFunction) {
  if (hasAnyRole(req.user?.role, allowed) || hasScopedAccountingLegalEntityAccess(allowed, req)) return next();
  auditDenied(allowed, req);
  return res.status(403).json({
    error: "Ehhez a művelethez nincs megfelelő jogosultsága.",
    required_roles: allowed,
    current_roles: parseRoleKeys(req.user?.role),
  });
}

export function requireRoles(...allowed: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return requireAuth(req, res, () => checkRoles(allowed, req, res, next));
    }
    return checkRoles(allowed, req, res, next);
  };
}

export const requireAdmin = requireRoles("admin");
export const requireManagement = requireRoles("admin", "manager");
