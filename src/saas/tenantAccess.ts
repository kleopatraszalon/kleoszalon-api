import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { ensureSaasCore } from "./ensureSaasCore";

export type TenantIdentity = {
  id: string;
  slug: string;
  role: string;
};

function roleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",").toLowerCase();
  return String(value ?? "").toLowerCase();
}

/** Resolve the authenticated user's active tenant. Existing Kleopátra users
 * are backfilled by ensureSaasCore(), therefore the fallback remains safe for
 * the migration period while old JWTs do not yet contain tenant_id.
 */
export async function resolveTenantIdentity(req: AuthRequest): Promise<TenantIdentity | null> {
  await ensureSaasCore();
  const authUser = req.user as (NonNullable<AuthRequest["user"]> & { tenant_id?: string | number | null }) | undefined;
  if (!authUser?.id) return null;

  const userId = String(authUser.id);
  const tokenTenantId = authUser.tenant_id == null ? "" : String(authUser.tenant_id);
  const { rows } = await db.query(
    `SELECT t.id::text id,t.slug,COALESCE(tu.tenant_role,'member') tenant_role
       FROM tenants t
       LEFT JOIN tenant_users tu
         ON tu.tenant_id=t.id AND tu.user_id=$1 AND tu.active=true
      WHERE t.status IN ('active','trial')
        AND (($2<>'' AND t.id::text=$2) OR ($2='' AND tu.user_id IS NOT NULL))
      ORDER BY CASE WHEN $2<>'' AND t.id::text=$2 THEN 0 ELSE 1 END,t.id
      LIMIT 1`,
    [userId, tokenTenantId]
  );
  let row = rows[0];

  if (!row) {
    const fallback = await db.query(
      `SELECT id::text id,slug,$2::text tenant_role
         FROM tenants
        WHERE slug='kleopatra' AND status IN ('active','trial')
        LIMIT 1`,
      [userId, roleText(authUser.role).includes("admin") ? "owner" : "member"]
    );
    row = fallback.rows[0];
  }
  if (!row) return null;
  authUser.tenant_id = String(row.id);
  return { id: String(row.id), slug: String(row.slug), role: String(row.tenant_role || "member") };
}

export async function tenantLocationIds(tenantId: string): Promise<string[]> {
  const { rows } = await db.query(`SELECT id::text id FROM locations WHERE tenant_id=$1::bigint`, [tenantId]);
  return rows.map((row: any) => String(row.id));
}

export async function locationBelongsToTenant(locationId: unknown, tenantId: string): Promise<boolean> {
  const value = String(locationId ?? "").trim();
  if (!value) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1`,
    [value, tenantId]
  );
  return Boolean(rows[0]);
}

export async function entityBelongsToTenant(table: string, id: string, tenantId: string): Promise<boolean> {
  const allowed = new Set(["employees", "clients", "appointments", "work_orders", "product_stock_balances", "purchase_orders"]);
  if (!allowed.has(table)) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM ${table} e
       LEFT JOIN locations l ON l.id::text=e.location_id::text
      WHERE e.id::text=$1
        AND (e.tenant_id=$2::bigint OR l.tenant_id=$2::bigint)
      LIMIT 1`,
    [id, tenantId]
  );
  return Boolean(rows[0]);
}

/**
 * Subscription feature resolver.
 * Tenant-level override wins over the plan definition; `all_modules` grants
 * every feature. Missing feature keys are denied for non-internal plans.
 */
export async function tenantFeatureEnabled(tenantId: string, featureKey: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT
       COALESCE(tf.enabled,
         CASE
           WHEN COALESCE((sp.features->>'all_modules')::boolean,false) THEN true
           WHEN sp.features ? $2 THEN COALESCE((sp.features->>$2)::boolean,false)
           ELSE false
         END
       ) AS enabled
       FROM tenants t
       LEFT JOIN subscriptions s
         ON s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended')
       LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
       LEFT JOIN tenant_features tf ON tf.tenant_id=t.id AND tf.feature_key=$2
      WHERE t.id=$1::bigint
      LIMIT 1`,
    [tenantId, featureKey]
  );
  return rows[0]?.enabled === true;
}
