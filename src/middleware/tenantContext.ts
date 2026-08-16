import { NextFunction, Response } from "express";
import db from "../db";
import { AuthRequest } from "./auth";
import { ensureSaasCore } from "../saas/ensureSaasCore";

export interface TenantAuthRequest extends AuthRequest {
  tenant?: {
    id: string;
    slug: string;
    name: string;
    role: string;
    status: string;
  };
}

export async function requireTenantContext(req: TenantAuthRequest, res: Response, next: NextFunction) {
  try {
    await ensureSaasCore();

    const authUser = req.user as (NonNullable<AuthRequest["user"]> & { tenant_id?: string | number | null }) | undefined;
    const tokenTenantId = authUser?.tenant_id ? String(authUser.tenant_id) : "";
    const userId = authUser?.id != null ? String(authUser.id) : "";

    const { rows } = await db.query(
      `SELECT t.id::text AS id,t.slug,t.name,t.status,tu.tenant_role
         FROM tenants t
         LEFT JOIN tenant_users tu
           ON tu.tenant_id=t.id
          AND tu.user_id=$1
          AND tu.active=true
        WHERE t.status IN ('active','trial')
          AND (
            ($2<>'' AND t.id::text=$2)
            OR ($2='' AND tu.user_id IS NOT NULL)
          )
        ORDER BY CASE WHEN $2<>'' AND t.id::text=$2 THEN 0 ELSE 1 END,t.id
        LIMIT 1`,
      [userId, tokenTenantId]
    );

    let tenant = rows[0];

    // Átmeneti kompatibilitás: régi tokennél/adminnál a Kleopátra tenant legyen az alapértelmezett.
    if (!tenant && userId) {
      const fallback = await db.query(
        `SELECT t.id::text AS id,t.slug,t.name,t.status,
                CASE WHEN lower(COALESCE($2,'')) LIKE '%admin%' THEN 'owner' ELSE 'member' END AS tenant_role
           FROM tenants t
          WHERE t.slug='kleopatra' AND t.status IN ('active','trial')
          LIMIT 1`,
        [userId, Array.isArray(authUser?.role) ? authUser?.role.join(',') : String(authUser?.role ?? '')]
      );
      tenant = fallback.rows[0];
    }

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
    return res.status(500).json({ ok: false, code: "TENANT_CONTEXT_ERROR", error: "A tenant-környezet nem tölthető be." });
  }
}

export function requireTenantRole(...allowedRoles: string[]) {
  const allowed = new Set(allowedRoles.map(x => x.toLowerCase()));
  return (req: TenantAuthRequest, res: Response, next: NextFunction) => {
    const role = String(req.tenant?.role || "").toLowerCase();
    if (!role || !allowed.has(role)) {
      return res.status(403).json({ ok: false, code: "TENANT_ROLE_FORBIDDEN", error: "Nincs megfelelő tenant jogosultság." });
    }
    return next();
  };
}
