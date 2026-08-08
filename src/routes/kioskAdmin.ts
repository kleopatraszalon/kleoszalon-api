import { Router, Response } from "express";
import * as db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const pool = ((db as any).pool ?? (db as any).default) as {
  query: (sql: string, params?: any[]) => Promise<any>;
  connect: () => Promise<any>;
};

const router = Router();
router.use(requireAuth);

const ADMIN_ROLES = new Set(["admin", "administrator", "rendszergazda", "superadmin", "super_admin"]);
const LOCATION_ROLES = new Set([
  "location_manager", "üzletvezető", "uzletvezeto", "store_manager", "branch_manager",
  "salon_manager", "szalonvezető", "szalonvezeto", "receptionist", "recepciós", "recepcios", "reception",
]);

const DEFAULT_THEME = {
  primaryColor: "#b69861",
  accentColor: "#ec008c",
  backgroundColor: "#f4efe7",
  surfaceColor: "#ffffff",
  textColor: "#181310",
  welcomeText: "Minden ami szépség, csak Neked!",
  heroTitle: "Mit szeretnél ma?",
  heroSubtitle: "Válassz kategóriát, majd szolgáltatást néhány érintéssel.",
  heroImageUrl: "/images/szolgaltatasok.jpg",
  startTitle: "Üdvözlünk a Kleopátra Szépségszalonban!",
  startSubtitle: "Érintsd meg a képernyőt a szolgáltatás kiválasztásához.",
  startButtonText: "Kezdés",
  logoUrl: "/images/kleo_logo@2x.png",
  showStartScreen: true,
  showPrices: true,
  showDuration: true,
  showEmployees: false,
  showWebEmbed: false,
  autoResetSeconds: 30,
  cardRadius: 24,
};

function roleList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.toLowerCase());
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.toLowerCase());
  } catch {}
  return String(raw ?? "").split(",").map((x) => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}
function isAdmin(req: AuthRequest) { return roleList(req.user?.role).some((role) => ADMIN_ROLES.has(role)); }
function canManageKiosk(req: AuthRequest) { return roleList(req.user?.role).some((role) => ADMIN_ROLES.has(role) || LOCATION_ROLES.has(role)); }
function requestLocation(req: AuthRequest): string | null { return req.user?.location_id ? String(req.user.location_id) : null; }
function assertLocationAccess(req: AuthRequest, res: Response, locationId: string) {
  if (!canManageKiosk(req)) { res.status(403).json({ ok: false, error: "A kiosk adminisztrációhoz nincs jogosultsága." }); return false; }
  if (!isAdmin(req)) {
    const own = requestLocation(req);
    if (!own || own !== locationId) { res.status(403).json({ ok: false, error: "Csak a saját szalon kioskja szerkeszthető." }); return false; }
  }
  return true;
}

async function ensureKioskTables() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS kiosk_menus (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NULL REFERENCES locations(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Kiosk menü',
      theme jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kiosk_menus_location_idx ON kiosk_menus(location_id,is_active,updated_at DESC);

    CREATE TABLE IF NOT EXISTS kiosk_menu_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
      title_hu text NOT NULL,
      display_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS subtitle_hu text;
    ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS image_url text;
    ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

    CREATE TABLE IF NOT EXISTS kiosk_menu_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id uuid NOT NULL REFERENCES kiosk_menu_sections(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      display_order int NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      UNIQUE(section_id,service_id)
    );
    ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS image_url text;
    ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS badge_text text;
    ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
    ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS display_name text;
  `);
}

router.use(async (_req, _res, next) => {
  try { await ensureKioskTables(); next(); }
  catch (e) { console.error("ensureKioskTables hiba:", e); next(e); }
});

router.get("/locations", async (req: AuthRequest, res: Response) => {
  if (!canManageKiosk(req)) return res.status(403).json({ ok: false, error: "Nincs kiosk admin jogosultsága." });
  const own = requestLocation(req);
  const { rows } = await pool.query(
    `SELECT id::text id,name FROM locations
     WHERE COALESCE(is_active,true)=true AND ($1::boolean=true OR id::text=$2::text)
     ORDER BY name`, [isAdmin(req), own || ""]);
  res.json({ ok: true, locations: rows });
});

router.get("/menu", async (req: AuthRequest, res: Response) => {
  const locationId = String(req.query.locationId || req.query.location_id || "").trim();
  if (!locationId) return res.status(400).json({ ok: false, error: "locationId kötelező" });
  if (!assertLocationAccess(req, res, locationId)) return;
  const location = (await pool.query(`SELECT id::text id,name FROM locations WHERE id=$1::uuid`, [locationId])).rows[0];
  if (!location) return res.status(404).json({ ok: false, error: "A telephely nem található." });

  const menu = (await pool.query(
    `SELECT id::text id,location_id::text location_id,name,theme,is_active,created_at,updated_at
     FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`, [locationId])).rows[0] || null;

  const services = (await pool.query(
    `SELECT s.id::text id,s.name,COALESCE(s.description_short,s.description_long,'') description,
            COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric base_price,
            COALESCE(s.duration_minutes,30)::int duration_minutes,
            s.service_type_id::text service_type_id,COALESCE(st.name,'Egyéb') service_type_name
     FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
     WHERE COALESCE(s.is_active,true)=true AND (
       NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
       OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid)
     ) ORDER BY COALESCE(st.display_order,999999),COALESCE(st.name,'Egyéb'),s.name`, [locationId])).rows;

  const sections: any[] = [];
  if (menu?.id) {
    const rows = (await pool.query(
      `SELECT sec.id::text section_id,sec.title_hu,sec.subtitle_hu,sec.image_url,sec.enabled section_enabled,sec.display_order,
              mi.service_id::text service_id,mi.enabled,mi.display_order item_order,mi.image_url item_image_url,
              mi.badge_text,mi.featured,mi.display_name
       FROM kiosk_menu_sections sec LEFT JOIN kiosk_menu_items mi ON mi.section_id=sec.id
       WHERE sec.menu_id=$1::uuid ORDER BY sec.display_order,mi.featured DESC,mi.display_order`, [menu.id])).rows;
    const by = new Map<string, any>();
    for (const row of rows) {
      if (!by.has(row.section_id)) {
        const section = {
          id: row.section_id, title: row.title_hu, subtitle: row.subtitle_hu || "", imageUrl: row.image_url || "",
          enabled: Boolean(row.section_enabled), order: Number(row.display_order || 0), items: [] as any[],
        };
        by.set(row.section_id, section); sections.push(section);
      }
      if (row.service_id) by.get(row.section_id).items.push({
        serviceId: row.service_id, enabled: Boolean(row.enabled), order: Number(row.item_order || 0),
        imageUrl: row.item_image_url || "", badgeText: row.badge_text || "", featured: Boolean(row.featured), displayName: row.display_name || "",
      });
    }
  }

  const enabledIds = new Set<string>();
  sections.filter((s) => s.enabled).forEach((section) => section.items.filter((item: any) => item.enabled).forEach((item: any) => enabledIds.add(String(item.serviceId))));
  const stats = { total_services: services.length, enabled_services: enabledIds.size, disabled_services: Math.max(0, services.length - enabledIds.size), section_count: sections.filter((s) => s.enabled).length };
  res.json({ ok: true, location, menu, sections, services, stats, defaults: DEFAULT_THEME });
});

router.post("/menu/init", async (req: AuthRequest, res: Response) => {
  const locationId = String(req.body?.locationId || req.body?.location_id || "").trim();
  const name = String(req.body?.name || "Kiosk menü").trim() || "Kiosk menü";
  if (!locationId) return res.status(400).json({ ok: false, error: "locationId kötelező" });
  if (!assertLocationAccess(req, res, locationId)) return;
  const existing = (await pool.query(`SELECT id::text id FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`, [locationId])).rows[0];
  if (existing) return res.json({ ok: true, menuId: existing.id, existing: true });

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    const menuId = (await cx.query(
      `INSERT INTO kiosk_menus(location_id,name,theme,is_active) VALUES($1::uuid,$2,$3::jsonb,true) RETURNING id::text id`,
      [locationId, name, JSON.stringify(DEFAULT_THEME)])).rows[0].id;
    const types = (await cx.query(`SELECT id::text id,COALESCE(name,'Egyéb') title FROM service_types ORDER BY COALESCE(display_order,999999),COALESCE(name,'Egyéb')`)).rows;
    const typeToSection = new Map<string, string>();
    let order = 0;
    for (const type of types) {
      const id = (await cx.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,$2,'',$3,true) RETURNING id::text id`, [menuId, type.title, order++])).rows[0].id;
      typeToSection.set(type.id, id);
    }
    const otherId = (await cx.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,'Egyéb','',$2,true) RETURNING id::text id`, [menuId, order++])).rows[0].id;
    const services = (await cx.query(
      `SELECT s.id::text id,s.service_type_id::text service_type_id FROM services s
       WHERE COALESCE(s.is_active,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
       OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))`, [locationId])).rows;
    let itemOrder = 0;
    for (const service of services) {
      const sectionId = typeToSection.get(service.service_type_id) || otherId;
      await cx.query(`INSERT INTO kiosk_menu_items(section_id,service_id,display_order,enabled) VALUES($1::uuid,$2::uuid,$3,true) ON CONFLICT(section_id,service_id) DO UPDATE SET enabled=true,display_order=EXCLUDED.display_order`, [sectionId, service.id, itemOrder++]);
    }
    await cx.query("COMMIT"); res.status(201).json({ ok: true, menuId });
  } catch (e: any) {
    await cx.query("ROLLBACK"); console.error("kiosk init hiba:", e); res.status(500).json({ ok: false, error: e?.message || "init_failed" });
  } finally { cx.release(); }
});

router.put("/menu/:menuId/settings", async (req: AuthRequest, res: Response) => {
  const menuId = String(req.params.menuId || "");
  const menu = (await pool.query(`SELECT id::text id,location_id::text location_id FROM kiosk_menus WHERE id=$1::uuid`, [menuId])).rows[0];
  if (!menu) return res.status(404).json({ ok: false, error: "menu_not_found" });
  if (!assertLocationAccess(req, res, menu.location_id)) return;
  const name = String(req.body?.name || "Kiosk menü").trim() || "Kiosk menü";
  const theme = req.body?.theme && typeof req.body.theme === "object" ? { ...DEFAULT_THEME, ...req.body.theme } : DEFAULT_THEME;
  const isActive = Boolean(req.body?.is_active ?? true);
  await pool.query(`UPDATE kiosk_menus SET name=$2,theme=$3::jsonb,is_active=$4,updated_at=now() WHERE id=$1::uuid`, [menuId, name, JSON.stringify(theme), isActive]);
  const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
  for (const section of sections) {
    await pool.query(
      `UPDATE kiosk_menu_sections SET title_hu=$3,subtitle_hu=$4,image_url=$5,enabled=$6,display_order=$7,updated_at=now()
       WHERE id=$1::uuid AND menu_id=$2::uuid`,
      [String(section.id), menuId, String(section.title || "Szekció").trim() || "Szekció", String(section.subtitle || "").trim() || null,
       String(section.imageUrl || "").trim() || null, Boolean(section.enabled ?? true), Number(section.order || 0)]);
  }
  res.json({ ok: true });
});

router.put("/menu/:menuId/items", async (req: AuthRequest, res: Response) => {
  const menuId = String(req.params.menuId || "");
  const menu = (await pool.query(`SELECT id::text id,location_id::text location_id FROM kiosk_menus WHERE id=$1::uuid`, [menuId])).rows[0];
  if (!menu) return res.status(404).json({ ok: false, error: "menu_not_found" });
  if (!assertLocationAccess(req, res, menu.location_id)) return;
  const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    for (const section of sections) {
      const sectionId = String(section.sectionId || "");
      const valid = (await cx.query(`SELECT 1 FROM kiosk_menu_sections WHERE id=$1::uuid AND menu_id=$2::uuid`, [sectionId, menuId])).rows[0];
      if (!valid) continue;
      for (const item of Array.isArray(section.items) ? section.items : []) {
        await cx.query(
          `INSERT INTO kiosk_menu_items(section_id,service_id,display_order,enabled,image_url,badge_text,featured,display_name)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(section_id,service_id) DO UPDATE SET display_order=EXCLUDED.display_order,enabled=EXCLUDED.enabled,
             image_url=EXCLUDED.image_url,badge_text=EXCLUDED.badge_text,featured=EXCLUDED.featured,display_name=EXCLUDED.display_name`,
          [sectionId, String(item.serviceId), Number(item.order || 0), Boolean(item.enabled), String(item.imageUrl || "").trim() || null,
           String(item.badgeText || "").trim() || null, Boolean(item.featured), String(item.displayName || "").trim() || null]);
      }
    }
    await cx.query(`UPDATE kiosk_menus SET updated_at=now() WHERE id=$1::uuid`, [menuId]);
    await cx.query("COMMIT"); res.json({ ok: true });
  } catch (e: any) {
    await cx.query("ROLLBACK"); console.error("kiosk items save hiba:", e); res.status(500).json({ ok: false, error: e?.message || "save_failed" });
  } finally { cx.release(); }
});

export default router;
