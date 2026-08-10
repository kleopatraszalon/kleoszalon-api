import db from "../db";

export const RBAC_FAIL_CLOSED_VERSION = "20260810_RBAC_FAIL_CLOSED_V1";

let cached: { value: boolean; expires: number } | null = null;

export async function isRbacFailClosed(): Promise<boolean> {
  if (process.env.RBAC_FAIL_CLOSED === "1") return true;
  if (process.env.RBAC_FAIL_CLOSED === "0") return false;
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;
  try {
    const { rows } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS enabled`,
      [RBAC_FAIL_CLOSED_VERSION]
    );
    const value = Boolean(rows[0]?.enabled);
    cached = { value, expires: now + 30_000 };
    return value;
  } catch (error: any) {
    if (String(error?.code || "") === "42P01") {
      cached = { value: false, expires: now + 10_000 };
      return false;
    }
    throw error;
  }
}

export function clearRbacModeCache() {
  cached = null;
}
