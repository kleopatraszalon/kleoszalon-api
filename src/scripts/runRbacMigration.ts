import fs from "fs";
import path from "path";
import db from "../db";
import { RBAC_FAIL_CLOSED_VERSION } from "../security/rbacMode";

async function main() {
  if (process.env.ALLOW_RBAC_MIGRATION !== "1") {
    throw new Error("RBAC migration refused. Set ALLOW_RBAC_MIGRATION=1 explicitly for this one command.");
  }

  const sqlPath = path.join(__dirname, "..", "sql", `${RBAC_FAIL_CLOSED_VERSION}.sql`);
  if (!fs.existsSync(sqlPath)) throw new Error(`Migration file not found: ${sqlPath}`);
  const sql = fs.readFileSync(sqlPath, "utf8");
  if (!sql.includes(RBAC_FAIL_CLOSED_VERSION)) throw new Error("Migration marker is missing from SQL file.");

  console.log(`[RBAC] Applying ${RBAC_FAIL_CLOSED_VERSION}...`);
  await db.query(sql);

  const marker = await db.query(`SELECT COUNT(*)::int count FROM schema_migrations WHERE version=$1`, [RBAC_FAIL_CLOSED_VERSION]);
  if (Number(marker.rows[0]?.count || 0) !== 1) throw new Error("RBAC migration marker verification failed.");

  const coverage = await db.query(`
    WITH r(role_key) AS (
      VALUES ('admin'),('manager'),('location_manager'),('salon_manager'),('receptionist'),('employee'),('customer')
    )
    SELECT COUNT(*)::int missing
      FROM r CROSS JOIN menus m
      LEFT JOIN role_menu_permissions p
        ON lower(p.role_key)=r.role_key AND p.menu_id=m.id
     WHERE COALESCE(m.is_active,true) AND p.menu_id IS NULL
  `);
  const missing = Number(coverage.rows[0]?.missing || 0);
  if (missing !== 0) throw new Error(`RBAC coverage verification failed: ${missing} role-menu rows are missing.`);

  const invariants = await db.query(`
    SELECT
      COALESCE(bool_and(CASE WHEN p.role_key IN ('salon_manager','employee','customer') THEN NOT p.can_edit ELSE true END),false) read_only_ok,
      COALESCE(bool_or(p.role_key='location_manager' AND p.can_edit),false) location_manager_edit,
      COALESCE(bool_or(p.role_key='receptionist' AND p.can_edit),false) receptionist_edit
    FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id
    WHERE m.code='appointments.workorders'
  `);
  const inv = invariants.rows[0] || {};
  if (!inv.read_only_ok || !inv.location_manager_edit || !inv.receptionist_edit) {
    throw new Error("RBAC work-order invariant verification failed.");
  }

  console.log(`[RBAC] ${RBAC_FAIL_CLOSED_VERSION} applied successfully. Missing permissions: 0.`);
}

main()
  .catch(error => {
    console.error("[RBAC] Migration failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => undefined);
  });
