import { Router, Response } from "express";
import * as db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const pool = ((db as any).pool ?? (db as any).default) as {
  query: (sql: string, params?: any[]) => Promise<any>;
  connect: () => Promise<any>;
};

const router = Router();
router.use(requireAuth);

const ADMIN_ROLES = new Set(["admin", "administrator", "rendszergazda", "superadmin", "super_admin", "manager"]);
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
  heroSubtitle: "Válassz kategóriát, majd szolgáltatást vagy terméket néhány érintéssel.",
  heroImageUrl: "/images/szolgaltatasok.jpg",
  startTitle: "Üdvözlünk a Kleopátra Szépségszalonban!",
  startSubtitle: "Érintsd meg a képernyőt a választás megkezdéséhez.",
  startButtonText: "Kezdés",
  logoUrl: "/images/kleo_logo@2x.png",
  showStartScreen: true,
  showPrices: true,
  showDuration: true,
  showEmployees: false,
  showProducts: true,
  autoResetSeconds: 30,
  cardRadius: 24,
  contentWidth: 760,
  categoryColumns: 2,
  productColumns: 2,
  layoutOrder: ["hero", "services", "products"],
  layoutVisibility: { hero: true, services: true, products: true },
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

    CREATE TABLE IF NOT EXISTS kiosk_product_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
      group_key text,
      title_hu text NOT NULL,
      subtitle_hu text,
      image_url text,
      enabled boolean NOT NULL DEFAULT true,
      display_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kiosk_product_sections_menu_idx ON kiosk_product_sections(menu_id,display_order);

    CREATE TABLE IF NOT EXISTS kiosk_product_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id uuid NOT NULL REFERENCES kiosk_product_sections(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      display_order int NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      image_url text,
      badge_text text,
      featured boolean NOT NULL DEFAULT false,
      display_name text,
      UNIQUE(section_id,product_id)
    );

    CREATE TABLE IF NOT EXISTS kiosk_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_key text NOT NULL UNIQUE,
      name text NOT NULL,
      location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function gyongyosLocation() {
  return (await pool.query(`
    SELECT id::text id,name
    FROM locations
    WHERE COALESCE(is_active,true)=true
      AND (lower(name) LIKE '%gyöngy%' OR lower(name) LIKE '%gyongy%')
    ORDER BY CASE WHEN lower(name) LIKE 'gyöngy%' OR lower(name) LIKE 'gyongy%' THEN 0 ELSE 1 END,name
    LIMIT 1
  `)).rows[0] || null;
}

async function ensureGyongyosDevice() {
  const location = await gyongyosLocation();
  if (!location) return null;
  const device = (await pool.query(`
    INSERT INTO kiosk_devices(device_key,name,location_id,is_active,updated_at)
    VALUES('gyongyos-main','Gyöngyös szalon kiosk',$1::uuid,true,now())
    ON CONFLICT(device_key) DO UPDATE SET name=EXCLUDED.name,location_id=EXCLUDED.location_id,is_active=true,updated_at=now()
    RETURNING id::text id,device_key,name,location_id::text location_id,is_active,updated_at
  `,[location.id])).rows[0];
  return { ...device, location };
}

async function loadProducts() {
  const rows = (await pool.query(`
    SELECT p.id::text id,
      COALESCE(NULLIF(to_jsonb(p)->>'name_hu',''),NULLIF(to_jsonb(p)->>'name',''),'Termék') name,
      COALESCE(NULLIF(to_jsonb(p)->>'web_description_hu',''),NULLIF(to_jsonb(p)->>'web_description',''),'') description,
      COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,0) price,
      COALESCE(NULLIF(to_jsonb(p)->>'image_url',''),NULLIF(to_jsonb(p)->>'web_image_url',''),NULLIF(to_jsonb(p)->>'photo_url',''),'') image_url,
      NULLIF(to_jsonb(p)->>'product_category_id','') category_id,
      NULLIF(to_jsonb(p)->>'product_group_id','') group_id,
      COALESCE(NULLIF(to_jsonb(p)->>'sub_category',''),NULLIF(to_jsonb(p)->>'main_category',''),NULLIF(to_jsonb(p)->>'brand',''),'') fallback_group
    FROM products p
    WHERE COALESCE(to_jsonb(p)->>'is_active','true') NOT IN ('false','0')
      AND COALESCE(to_jsonb(p)->>'is_retail','true') NOT IN ('false','0')
    ORDER BY COALESCE(NULLIF(to_jsonb(p)->>'sub_category',''),NULLIF(to_jsonb(p)->>'main_category',''),NULLIF(to_jsonb(p)->>'brand',''),'Termékek'),
             COALESCE(NULLIF(to_jsonb(p)->>'name_hu',''),NULLIF(to_jsonb(p)->>'name',''),'Termék')
  `)).rows;

  const categoryMap = new Map<string,string>();
  const groupMap = new Map<string,string>();
  try {
    const cats = (await pool.query(`SELECT id::text id,COALESCE(NULLIF(name_hu,''),NULLIF(name_en,''),'Termékek') name FROM product_categories`)).rows;
    cats.forEach((x:any)=>categoryMap.set(String(x.id),String(x.name)));
  } catch {}
  try {
    const groups = (await pool.query(`SELECT id::text id,COALESCE(NULLIF(name_hu,''),NULLIF(name_en,''),'Termékek') name FROM product_groups`)).rows;
    groups.forEach((x:any)=>groupMap.set(String(x.id),String(x.name)));
  } catch {}

  return rows.map((row:any)=>{
    const groupKey = String(row.category_id || row.group_id || row.fallback_group || 'products');
    const groupName = categoryMap.get(String(row.category_id || '')) || groupMap.get(String(row.group_id || '')) || String(row.fallback_group || 'Termékek');
    return { id:String(row.id), name:String(row.name), description:row.description || '', price:Number(row.price||0), image_url:row.image_url || '', group_key:groupKey, group_name:groupName };
  });
}

router.use(async (_req, _res, next) => {
  try { await ensureKioskTables(); await ensureGyongyosDevice(); next(); }
  catch (e) { console.error("ensureKioskTables hiba:", e); next(e); }
});

router.get("/locations", async (req: AuthRequest, res: Response) => {
  if (!canManageKiosk(req)) return res.status(403).json({ ok: false, error: "Nincs kiosk admin jogosultsága." });
  const own = requestLocation(req);
  const device = await ensureGyongyosDevice();
  const { rows } = await pool.query(`
    SELECT id::text id,name,
      CASE WHEN id::text=$3::text THEN true ELSE false END is_device_location
    FROM locations
    WHERE COALESCE(is_active,true)=true AND ($1::boolean=true OR id::text=$2::text)
    ORDER BY CASE WHEN id::text=$3::text THEN 0 ELSE 1 END,name
  `,[isAdmin(req),own || "",device?.location?.id || ""]);
  res.json({ ok:true, locations:rows, device });
});

router.get("/device", async (req: AuthRequest, res: Response) => {
  if (!canManageKiosk(req)) return res.status(403).json({ ok:false,error:"Nincs kiosk admin jogosultsága." });
  const device = await ensureGyongyosDevice();
  res.json({ ok:true, device });
});

router.get("/menu", async (req: AuthRequest, res: Response) => {
  const device = await ensureGyongyosDevice();
  const locationId = String(req.query.locationId || req.query.location_id || device?.location?.id || "").trim();
  if (!locationId) return res.status(400).json({ ok:false,error:"Nem található kiosk telephely." });
  if (!assertLocationAccess(req,res,locationId)) return;
  const location = (await pool.query(`SELECT id::text id,name FROM locations WHERE id=$1::uuid`,[locationId])).rows[0];
  if (!location) return res.status(404).json({ ok:false,error:"A telephely nem található." });

  const menu = (await pool.query(`SELECT id::text id,location_id::text location_id,name,theme,is_active,created_at,updated_at FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[locationId])).rows[0] || null;
  const services = (await pool.query(`
    SELECT s.id::text id,s.name,COALESCE(s.description_short,s.description_long,'') description,
      COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric base_price,COALESCE(s.duration_minutes,30)::int duration_minutes,
      s.service_type_id::text service_type_id,COALESCE(st.name,'Egyéb') service_type_name
    FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
    WHERE COALESCE(s.is_active,true)=true AND (
      NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
      OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid)
    ) ORDER BY COALESCE(st.display_order,999999),COALESCE(st.name,'Egyéb'),s.name
  `,[locationId])).rows;
  const products = await loadProducts();

  const sections:any[]=[];
  const productSections:any[]=[];
  if (menu?.id) {
    const rows=(await pool.query(`
      SELECT sec.id::text section_id,sec.title_hu,sec.subtitle_hu,sec.image_url,sec.enabled section_enabled,sec.display_order,
        mi.service_id::text service_id,mi.enabled,mi.display_order item_order,mi.image_url item_image_url,mi.badge_text,mi.featured,mi.display_name
      FROM kiosk_menu_sections sec LEFT JOIN kiosk_menu_items mi ON mi.section_id=sec.id
      WHERE sec.menu_id=$1::uuid ORDER BY sec.display_order,mi.featured DESC,mi.display_order
    `,[menu.id])).rows;
    const by=new Map<string,any>();
    for(const row of rows){
      if(!by.has(row.section_id)){const section={id:row.section_id,title:row.title_hu,subtitle:row.subtitle_hu||"",imageUrl:row.image_url||"",enabled:Boolean(row.section_enabled),order:Number(row.display_order||0),items:[] as any[]};by.set(row.section_id,section);sections.push(section)}
      if(row.service_id)by.get(row.section_id).items.push({serviceId:row.service_id,enabled:Boolean(row.enabled),order:Number(row.item_order||0),imageUrl:row.item_image_url||"",badgeText:row.badge_text||"",featured:Boolean(row.featured),displayName:row.display_name||""});
    }
    const prows=(await pool.query(`
      SELECT sec.id::text section_id,sec.group_key,sec.title_hu,sec.subtitle_hu,sec.image_url,sec.enabled section_enabled,sec.display_order,
        pi.product_id::text product_id,pi.enabled,pi.display_order item_order,pi.image_url item_image_url,pi.badge_text,pi.featured,pi.display_name
      FROM kiosk_product_sections sec LEFT JOIN kiosk_product_items pi ON pi.section_id=sec.id
      WHERE sec.menu_id=$1::uuid ORDER BY sec.display_order,pi.featured DESC,pi.display_order
    `,[menu.id])).rows;
    const pby=new Map<string,any>();
    for(const row of prows){
      if(!pby.has(row.section_id)){const section={id:row.section_id,groupKey:row.group_key||"",title:row.title_hu,subtitle:row.subtitle_hu||"",imageUrl:row.image_url||"",enabled:Boolean(row.section_enabled),order:Number(row.display_order||0),items:[] as any[]};pby.set(row.section_id,section);productSections.push(section)}
      if(row.product_id)pby.get(row.section_id).items.push({productId:row.product_id,enabled:Boolean(row.enabled),order:Number(row.item_order||0),imageUrl:row.item_image_url||"",badgeText:row.badge_text||"",featured:Boolean(row.featured),displayName:row.display_name||""});
    }
  }

  const enabledServices=new Set<string>();
  sections.filter(s=>s.enabled).forEach(s=>s.items.filter((i:any)=>i.enabled).forEach((i:any)=>enabledServices.add(String(i.serviceId))));
  const enabledProducts=new Set<string>();
  productSections.filter(s=>s.enabled).forEach(s=>s.items.filter((i:any)=>i.enabled).forEach((i:any)=>enabledProducts.add(String(i.productId))));
  const stats={
    total_services:services.length,enabled_services:enabledServices.size,disabled_services:Math.max(0,services.length-enabledServices.size),section_count:sections.filter(s=>s.enabled).length,
    total_products:products.length,enabled_products:enabledProducts.size,disabled_products:Math.max(0,products.length-enabledProducts.size),product_section_count:productSections.filter(s=>s.enabled).length,
  };
  res.json({ok:true,location,device,menu,sections,services,productSections,products,stats,defaults:DEFAULT_THEME});
});

router.post("/menu/init", async (req: AuthRequest, res: Response) => {
  const device=await ensureGyongyosDevice();
  const locationId=String(req.body?.locationId||req.body?.location_id||device?.location?.id||"").trim();
  const name=String(req.body?.name||"Gyöngyös kiosk").trim()||"Gyöngyös kiosk";
  if(!locationId)return res.status(400).json({ok:false,error:"locationId kötelező"});
  if(!assertLocationAccess(req,res,locationId))return;
  const existing=(await pool.query(`SELECT id::text id FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[locationId])).rows[0];
  if(existing)return res.json({ok:true,menuId:existing.id,existing:true});

  const cx=await pool.connect();
  try{
    await cx.query("BEGIN");
    const menuId=(await cx.query(`INSERT INTO kiosk_menus(location_id,name,theme,is_active) VALUES($1::uuid,$2,$3::jsonb,true) RETURNING id::text id`,[locationId,name,JSON.stringify(DEFAULT_THEME)])).rows[0].id;
    const types=(await cx.query(`SELECT id::text id,COALESCE(name,'Egyéb') title FROM service_types ORDER BY COALESCE(display_order,999999),COALESCE(name,'Egyéb')`)).rows;
    const typeToSection=new Map<string,string>();let order=0;
    for(const type of types){const id=(await cx.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,$2,'',$3,true) RETURNING id::text id`,[menuId,type.title,order++])).rows[0].id;typeToSection.set(type.id,id)}
    const otherId=(await cx.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,'Egyéb','',$2,true) RETURNING id::text id`,[menuId,order++])).rows[0].id;
    const serviceRows=(await cx.query(`SELECT s.id::text id,s.service_type_id::text service_type_id FROM services s WHERE COALESCE(s.is_active,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))`,[locationId])).rows;
    let itemOrder=0;for(const service of serviceRows){const sectionId=typeToSection.get(service.service_type_id)||otherId;await cx.query(`INSERT INTO kiosk_menu_items(section_id,service_id,display_order,enabled) VALUES($1::uuid,$2::uuid,$3,true) ON CONFLICT(section_id,service_id) DO UPDATE SET enabled=true,display_order=EXCLUDED.display_order`,[sectionId,service.id,itemOrder++])}

    const products=await loadProducts();
    const productGroups=new Map<string,{name:string;items:any[]}>();
    products.forEach((p:any)=>{if(!productGroups.has(p.group_key))productGroups.set(p.group_key,{name:p.group_name,items:[]});productGroups.get(p.group_key)!.items.push(p)});
    let pSectionOrder=0;
    for(const [groupKey,group] of productGroups){
      const sectionId=(await cx.query(`INSERT INTO kiosk_product_sections(menu_id,group_key,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,$2,$3,'',$4,true) RETURNING id::text id`,[menuId,groupKey,group.name,pSectionOrder++])).rows[0].id;
      let pOrder=0;for(const product of group.items)await cx.query(`INSERT INTO kiosk_product_items(section_id,product_id,display_order,enabled) VALUES($1::uuid,$2::uuid,$3,true) ON CONFLICT(section_id,product_id) DO UPDATE SET enabled=true,display_order=EXCLUDED.display_order`,[sectionId,product.id,pOrder++]);
    }
    await cx.query("COMMIT");res.status(201).json({ok:true,menuId});
  }catch(e:any){await cx.query("ROLLBACK");console.error("kiosk init hiba:",e);res.status(500).json({ok:false,error:e?.message||"init_failed"})}finally{cx.release()}
});

router.put("/menu/:menuId/settings", async (req: AuthRequest, res: Response) => {
  const menuId=String(req.params.menuId||"");
  const menu=(await pool.query(`SELECT id::text id,location_id::text location_id FROM kiosk_menus WHERE id=$1::uuid`,[menuId])).rows[0];
  if(!menu)return res.status(404).json({ok:false,error:"menu_not_found"});
  if(!assertLocationAccess(req,res,menu.location_id))return;
  const name=String(req.body?.name||"Kiosk menü").trim()||"Kiosk menü";
  const theme=req.body?.theme&&typeof req.body.theme==="object"?{...DEFAULT_THEME,...req.body.theme}:DEFAULT_THEME;
  const isActive=Boolean(req.body?.is_active??true);
  await pool.query(`UPDATE kiosk_menus SET name=$2,theme=$3::jsonb,is_active=$4,updated_at=now() WHERE id=$1::uuid`,[menuId,name,JSON.stringify(theme),isActive]);
  for(const section of Array.isArray(req.body?.sections)?req.body.sections:[]){await pool.query(`UPDATE kiosk_menu_sections SET title_hu=$3,subtitle_hu=$4,image_url=$5,enabled=$6,display_order=$7,updated_at=now() WHERE id=$1::uuid AND menu_id=$2::uuid`,[String(section.id),menuId,String(section.title||"Szekció").trim()||"Szekció",String(section.subtitle||"").trim()||null,String(section.imageUrl||"").trim()||null,Boolean(section.enabled??true),Number(section.order||0)])}
  for(const section of Array.isArray(req.body?.productSections)?req.body.productSections:[]){await pool.query(`UPDATE kiosk_product_sections SET title_hu=$3,subtitle_hu=$4,image_url=$5,enabled=$6,display_order=$7,updated_at=now() WHERE id=$1::uuid AND menu_id=$2::uuid`,[String(section.id),menuId,String(section.title||"Termékek").trim()||"Termékek",String(section.subtitle||"").trim()||null,String(section.imageUrl||"").trim()||null,Boolean(section.enabled??true),Number(section.order||0)])}
  res.json({ok:true});
});

router.put("/menu/:menuId/items", async (req: AuthRequest, res: Response) => {
  const menuId=String(req.params.menuId||"");
  const menu=(await pool.query(`SELECT id::text id,location_id::text location_id FROM kiosk_menus WHERE id=$1::uuid`,[menuId])).rows[0];
  if(!menu)return res.status(404).json({ok:false,error:"menu_not_found"});
  if(!assertLocationAccess(req,res,menu.location_id))return;
  const cx=await pool.connect();
  try{
    await cx.query("BEGIN");
    for(const section of Array.isArray(req.body?.sections)?req.body.sections:[]){
      const sectionId=String(section.sectionId||"");
      const valid=(await cx.query(`SELECT 1 FROM kiosk_menu_sections WHERE id=$1::uuid AND menu_id=$2::uuid`,[sectionId,menuId])).rows[0];if(!valid)continue;
      for(const item of Array.isArray(section.items)?section.items:[])await cx.query(`INSERT INTO kiosk_menu_items(section_id,service_id,display_order,enabled,image_url,badge_text,featured,display_name) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT(section_id,service_id) DO UPDATE SET display_order=EXCLUDED.display_order,enabled=EXCLUDED.enabled,image_url=EXCLUDED.image_url,badge_text=EXCLUDED.badge_text,featured=EXCLUDED.featured,display_name=EXCLUDED.display_name`,[sectionId,String(item.serviceId),Number(item.order||0),Boolean(item.enabled),String(item.imageUrl||"").trim()||null,String(item.badgeText||"").trim()||null,Boolean(item.featured),String(item.displayName||"").trim()||null]);
    }
    for(const section of Array.isArray(req.body?.productSections)?req.body.productSections:[]){
      const sectionId=String(section.sectionId||"");
      const valid=(await cx.query(`SELECT 1 FROM kiosk_product_sections WHERE id=$1::uuid AND menu_id=$2::uuid`,[sectionId,menuId])).rows[0];if(!valid)continue;
      for(const item of Array.isArray(section.items)?section.items:[])await cx.query(`INSERT INTO kiosk_product_items(section_id,product_id,display_order,enabled,image_url,badge_text,featured,display_name) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT(section_id,product_id) DO UPDATE SET display_order=EXCLUDED.display_order,enabled=EXCLUDED.enabled,image_url=EXCLUDED.image_url,badge_text=EXCLUDED.badge_text,featured=EXCLUDED.featured,display_name=EXCLUDED.display_name`,[sectionId,String(item.productId),Number(item.order||0),Boolean(item.enabled),String(item.imageUrl||"").trim()||null,String(item.badgeText||"").trim()||null,Boolean(item.featured),String(item.displayName||"").trim()||null]);
    }
    await cx.query(`UPDATE kiosk_menus SET updated_at=now() WHERE id=$1::uuid`,[menuId]);
    await cx.query("COMMIT");res.json({ok:true});
  }catch(e:any){await cx.query("ROLLBACK");console.error("kiosk items save hiba:",e);res.status(500).json({ok:false,error:e?.message||"save_failed"})}finally{cx.release()}
});

export default router;
