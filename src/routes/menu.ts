import * as express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureVirSpecModules } from "../virSpec/ensureVirSpecModules";

const router = express.Router();

function roleKeys(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw || ""));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return String(raw || "")
      .split(",")
      .map((x) => x.replace(/[\[\]"]/g, "").trim())
      .filter(Boolean);
  }
}

function isAdmin(req: AuthRequest): boolean {
  return roleKeys(req.user?.role).map((x) => x.toLowerCase()).includes("admin");
}

async function bestEffort(label: string, fn: () => Promise<any>) {
  try { await fn(); }
  catch (err: any) { console.warn(`⚠️ Menü előkészítés kihagyva (${label}):`, err?.message || err); }
}

async function ensureTeamImportMenu() {
  await pool.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'team.import','Importálás és duplikációkezelés',NULL,'/modules/team/import',70,t.id,'staff_import',true
    FROM menus t WHERE t.code='team'
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
      parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true
  `);
}

async function ensureProcurementMenu() {
  await pool.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES ('procurement','Beszerzés','ShoppingBag',NULL,75,NULL,'inventory',true)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,
      parent_id=NULL,feature_key='inventory',is_active=true
  `);

  await pool.query(`
    WITH p AS (SELECT id FROM menus WHERE code='procurement')
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT x.code,x.name,NULL,x.route,x.order_index,p.id,'inventory',true
    FROM p CROSS JOIN (VALUES
      ('procurement.dashboard','Beszerzési dashboard','/warehouse?view=procurement&section=dashboard',10),
      ('procurement.suggestions','Rendelési javaslatok','/warehouse?view=procurement&section=suggestions',20),
      ('procurement.approvals','Jóváhagyásra vár','/warehouse?view=procurement&section=approvals',30),
      ('procurement.orders','Beszerzési rendelések','/warehouse?view=procurement&section=orders',40),
      ('procurement.suppliers','Beszállítók','/warehouse?view=procurement&section=suppliers',50),
      ('procurement.prices','Beszállítói árak','/warehouse?view=procurement&section=prices',60),
      ('procurement.performance','Beszállítói teljesítmény','/warehouse?view=procurement&section=performance',70),
      ('procurement.deviations','Eltérések','/warehouse?view=procurement&section=deviations',80)
    ) AS x(code,name,route,order_index)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
      parent_id=EXCLUDED.parent_id,feature_key='inventory',is_active=true
  `);

  await pool.query(`
    INSERT INTO role_menu_permissions(
      role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
      can_export,can_view_financial,can_manage_permissions,scope_type
    )
    SELECT rp.role_key,target.id,rp.can_view,rp.can_create,rp.can_edit,rp.can_delete,
           rp.can_approve,rp.can_export,rp.can_view_financial,rp.can_manage_permissions,rp.scope_type
    FROM role_menu_permissions rp
    JOIN menus source ON source.id=rp.menu_id AND source.code='inventory'
    CROSS JOIN menus target
    WHERE target.code='procurement' OR target.code LIKE 'procurement.%'
    ON CONFLICT(role_key,menu_id) DO NOTHING
  `).catch(() => undefined);
}

async function ensureCleanMenu() {
  await pool.query(`UPDATE menus SET name='Irányítópult' WHERE code='dashboard'`);
  await pool.query(`UPDATE menus SET is_active=false WHERE code IN ('inventory.receiving','inventory.suppliers')`);
  await pool.query(`
    UPDATE menus child SET parent_id=settings.id, is_active=true
    FROM menus settings
    WHERE settings.code='settings'
      AND child.code IN ('screens.signage','screens.kiosk','integrations.marketplace','integrations.api','integrations.logs')
  `);
  await pool.query(`UPDATE menus SET is_active=false WHERE code IN ('screens','integrations')`);
}

router.put("/reorder-roots", requireAuth, async (req: AuthRequest, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Csak adminisztrátor rendezheti a főmenüt." });
  const orderedIds = Array.isArray(req.body?.ordered_ids)
    ? req.body.ordered_ids.map((x: unknown) => Number(x)).filter((x: number) => Number.isInteger(x) && x > 0)
    : [];
  if (!orderedIds.length) return res.status(400).json({ message: "Hiányzik a főmenü sorrendje." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id FROM menus WHERE parent_id IS NULL AND COALESCE(is_active,true) AND id = ANY($1::int[])`,
      [orderedIds]
    );
    if (rows.length !== orderedIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "A sorrend csak aktív főmenü-elemeket tartalmazhat." });
    }
    for (let i = 0; i < orderedIds.length; i += 1) {
      await client.query(`UPDATE menus SET order_index=$2 WHERE id=$1 AND parent_id IS NULL`, [orderedIds[i], (i + 1) * 10]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("❌ Főmenü sorrend mentési hiba:", err?.message || err);
    return res.status(500).json({ message: "A főmenü sorrendjét nem sikerült menteni." });
  } finally {
    client.release();
  }
});

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const roles = roleKeys(req.user?.role).map((x) => x.toLowerCase());
  const admin = roles.includes("admin");

  // Fontos: a menü megjelenése nem függhet migrációk sikerétől.
  await bestEffort("VIR modulok", () => ensureVirSpecModules());
  await bestEffort("HR import menü", () => ensureTeamImportMenu());
  await bestEffort("Beszerzés menü", () => ensureProcurementMenu());
  await bestEffort("menütisztítás", () => ensureCleanMenu());

  try {
    let rows: any[] = [];
    try {
      const result = await pool.query(
        `SELECT DISTINCT m.id,m.code,m.name,m.icon,m.route,m.order_index,m.parent_id,m.feature_key,
          COALESCE(p.can_view,$2::boolean) can_view,
          COALESCE(p.can_create,$2::boolean) can_create,
          COALESCE(p.can_edit,$2::boolean) can_edit,
          COALESCE(p.can_delete,$2::boolean) can_delete,
          COALESCE(p.can_approve,$2::boolean) can_approve,
          COALESCE(p.can_export,$2::boolean) can_export,
          COALESCE(p.can_view_financial,$2::boolean) can_view_financial,
          COALESCE(p.can_manage_permissions,$2::boolean) can_manage_permissions,
          COALESCE(p.scope_type,CASE WHEN $2 THEN 'all_locations' ELSE 'own_location' END) scope_type
         FROM menus m
         LEFT JOIN role_menu_permissions p ON p.menu_id=m.id AND lower(p.role_key)=ANY($1::text[])
         WHERE COALESCE(m.is_active,true) AND ($2 OR COALESCE(p.can_view,false))
         ORDER BY m.order_index,m.id`,
        [roles, admin]
      );
      rows = result.rows;
    } catch (permissionError: any) {
      console.warn("⚠️ Jogosultságos menülekérdezés hibás:", permissionError?.message || permissionError);
      if (!admin) throw permissionError;
      const fallback = await pool.query(
        `SELECT m.id,m.code,m.name,m.icon,m.route,m.order_index,m.parent_id,m.feature_key,
                true can_view,true can_create,true can_edit,true can_delete,true can_approve,
                true can_export,true can_view_financial,true can_manage_permissions,'all_locations'::text scope_type
         FROM menus m
         WHERE COALESCE(m.is_active,true)
         ORDER BY m.order_index,m.id`
      );
      rows = fallback.rows;
    }

    const byId = new Map<number, any>();
    rows.forEach((r) => byId.set(Number(r.id), {
      ...r,
      id: Number(r.id),
      required_role: "all",
      role: "all",
      permissions: {
        can_view:r.can_view, can_create:r.can_create, can_edit:r.can_edit,
        can_delete:r.can_delete, can_approve:r.can_approve, can_export:r.can_export,
        can_view_financial:r.can_view_financial, can_manage_permissions:r.can_manage_permissions,
        scope_type:r.scope_type,
      },
      submenus: [],
    }));

    const roots: any[] = [];
    rows.forEach((r) => {
      const item = byId.get(Number(r.id));
      if (r.parent_id && byId.has(Number(r.parent_id))) byId.get(Number(r.parent_id)).submenus.push(item);
      else roots.push(item);
    });
    const sort = (items: any[]) => {
      items.sort((a,b)=>(a.order_index||0)-(b.order_index||0)||a.id-b.id);
      items.forEach((x)=>sort(x.submenus));
    };
    sort(roots);
    return res.json(roots);
  } catch (err: any) {
    console.error("❌ Jogosultságalapú menühiba:", err?.message || err);
    return res.status(500).json({ error: "A menü betöltése nem sikerült.", detail: err?.message || String(err) });
  }
});

export default router;
