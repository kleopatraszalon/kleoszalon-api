import { NextFunction, Response } from "express";
import db from "../db";
import { AuthRequest } from "./auth";

export interface TenantAuthRequest extends AuthRequest {
  tenant?: { id: string; slug: string; name: string; role: string; status: string };
}

/**
 * Resolve tenant context only from an explicit trusted relationship:
 *  - an active tenant_users membership, or
 *  - an active employee whose assigned location belongs to the tenant.
 *
 * There is deliberately no hard-coded `kleopatra` fallback. A missing
 * membership/location association is an authorization failure, not a signal
 * to silently attach the user to the legacy/default tenant.
 */
export async function requireTenantContext(
  req: TenantAuthRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const authUser = req.user;
    const userId = authUser?.id != null ? String(authUser.id) : "";
    const email = String(authUser?.email ?? "").trim();
    const tokenTenantId = authUser?.tenant_id != null ? String(authUser.tenant_id) : "";

    if (!userId) {
      return res.status(403).json({
        ok: false,
        code: "TENANT_ACCESS_DENIED",
        error: "A felhasználóhoz nincs érvényes tenant-identitás rendelve.",
      });
    }

    const { rows } = await db.query(
      `WITH candidates AS (
         SELECT t.id::text AS id,t.slug,t.name,t.status,tu.tenant_role,0 AS source_rank
           FROM tenant_users tu
           JOIN tenants t ON t.id=tu.tenant_id
          WHERE tu.user_id=$1
            AND tu.active=true
            AND t.status IN ('active','trial')
            AND ($3='' OR t.id::text=$3)
         UNION ALL
         SELECT t.id::text AS id,t.slug,t.name,t.status,'member'::text AS tenant_role,1 AS source_rank
           FROM employees e
           JOIN locations l ON l.id::text=e.location_id::text
           JOIN tenants t ON t.id=l.tenant_id
          WHERE e.id::text=$1
            AND COALESCE(e.active,true)=true
            AND t.status IN ('active','trial')
            AND ($2='' OR lower(COALESCE(e.email,''))=lower($2) OR lower(COALESCE(e.login_name,''))=lower($2))
            AND ($3='' OR t.id::text=$3)
       )
       SELECT id,slug,name,status,tenant_role
         FROM candidates
        ORDER BY source_rank,id
        LIMIT 1`,
      [userId, email, tokenTenantId],
    );

    const tenant = rows[0];
    if (!tenant) {
      return res.status(403).json({
        ok: false,
        code: "TENANT_ACCESS_DENIED",
        error: "A felhasználóhoz nincs aktív SaaS tenant-hozzáférés rendelve.",
      });
    }

    req.tenant = {
      id: String(tenant.id),
      slug: String(tenant.slug),
      name: String(tenant.name),
      role: String(tenant.tenant_role || "member"),
      status: String(tenant.status),
    };
    if (authUser) authUser.tenant_id = req.tenant.id;
    return next();
  } catch (error) {
    console.error("[SAAS] tenant context error:", error);
    return res.status(500).json({
      ok: false,
      code: "TENANT_CONTEXT_ERROR",
      error: "A tenant-környezet nem tölthető be.",
    });
  }
}

export function requireTenantRole(...allowedRoles: string[]) {
  const allowed = new Set(allowedRoles.map((x) => x.toLowerCase()));
  return (req: TenantAuthRequest, res: Response, next: NextFunction) => {
    const role = String(req.tenant?.role || "").toLowerCase();
    if (!role || !allowed.has(role)) {
      return res.status(403).json({
        ok: false,
        code: "TENANT_ROLE_FORBIDDEN",
        error: "Nincs megfelelő tenant jogosultság.",
      });
    }
    return next();
  };
}
