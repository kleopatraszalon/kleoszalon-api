import type { NextFunction, Response } from "express";
import { requireAuth, type AuthRequest } from "./auth";
import { hasAnyRole, parseRoleKeys } from "../security/roles";
import { writeSystemAudit } from "../audit/systemAudit";
import { resolveTenantIdentity } from "../saas/tenantAccess";

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

const requireManagementRoles = requireRoles("admin", "manager");

// All management-gated VIR modules share this middleware. Resolve the canonical
// SaaS tenant here before their legacy route-local scopes inspect req.user.tenant_id.
// This repairs old UUID-bearing sessions from the already authenticated location
// without trusting any tenant id supplied by query/body parameters.
export const requireManagement = (req: AuthRequest, res: Response, next: NextFunction) => {
  const run = async () => {
    try {
      const path = String(req.originalUrl || req.url || "").split("?", 1)[0].toLowerCase();
      if (path === "/api/vir" || path.startsWith("/api/vir/")) {
        const identity = await resolveTenantIdentity(req);
        if (!identity) {
          return res.status(403).json({ ok: false, error: "A felhasználóhoz nincs érvényes tenant rendelve." });
        }
      }
      return requireManagementRoles(req, res, next);
    } catch (error) {
      console.error("VIR tenant context resolution failed:", error);
      return res.status(500).json({ ok: false, error: "tenant_context_resolution_failed" });
    }
  };

  if (!req.user) {
    return requireAuth(req, res, () => { void run(); });
  }
  void run();
};
