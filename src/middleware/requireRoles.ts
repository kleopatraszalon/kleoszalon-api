import type { NextFunction, Response } from "express";
import { requireAuth, type AuthRequest } from "./auth";
import { hasAnyRole, parseRoleKeys } from "../security/roles";

function checkRoles(allowed: readonly string[], req: AuthRequest, res: Response, next: NextFunction) {
  if (hasAnyRole(req.user?.role, allowed)) return next();
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
