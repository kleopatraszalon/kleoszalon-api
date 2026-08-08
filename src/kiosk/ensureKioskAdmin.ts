import pool from "../db";

const DEFAULT_THEME = {
  primaryColor: "#b69861", accentColor: "#ec008c", backgroundColor: "#f4efe7", surfaceColor: "#ffffff", textColor: "#181310",
  welcomeText: "Minden ami szépség, csak Neked!", heroTitle: "Mit szeretnél ma?", heroSubtitle: "Válassz kategóriát, majd szolgáltatást vagy terméket néhány érintéssel.",
  heroImageUrl: "/images/szolgaltatasok.jpg", startTitle: "Üdvözlünk a Kleopátra Szépségszalonban!", startSubtitle: "Érintsd meg a képernyőt a választás megkezdéséhez.",
  startButtonText: "Kezdés", logoUrl: "/images/kleo_logo@2x.png", showStartScreen: true, showPrices: true, showDuration: true, showEmployees: false,
  showProducts: true, autoResetSeconds: 30, cardRadius: 24, categoryColumns: 2, productColumns: 2,
  layoutOrder: ["hero","services","products"], layoutVisibility: { hero:true,services:true,products:true },
};

async function ensureKioskSchema(){
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS kiosk_menus(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid REFERENCES locations(id) ON DELETE CASCADE,name text NOT NULL DEFAULT 'Kiosk menü',theme jsonb NOT NULL DEFAULT '{}'::jsonb,is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS kiosk_menu_sections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,title_hu text NOT NULL,display_order int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS subtitle_hu text;ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS image_url text;ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    CREATE TABLE IF NOT EXISTS kiosk_menu_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),section_id uuid NOT NULL REFERENCES kiosk_menu_sections(id) ON DELETE CASCADE,service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,display_order int NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,UNIQUE(section_id,service_id));
    ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS image_url text;ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS badge_text text;ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS display_name text;
    CREATE TABLE IF NOT EXISTS kiosk_product_sections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,group_key text,title_hu text NOT NULL,subtitle_hu text,image_url text,enabled boolean NOT NULL DEFAULT true,display_order int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS kiosk_product_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),section_id uuid NOT NULL REFERENCES kiosk_product_sections(id) ON DELETE CASCADE,product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,display_order int NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,image_url text,badge_text text,featured boolean NOT NULL DEFAULT false,display_name text,UNIQUE(section_id,product_id));
    CREATE TABLE IF NOT EXISTS kiosk_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),device_key text NOT NULL UNIQUE,name text NOT NULL,location_id uuid REFERENCES locations(id) ON DELETE SET NULL,is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
  `);
}

async function ensureGyongyosCatalog(){
  await ensureKioskSchema();
  const location=(await pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true AND (lower(name) LIKE '%gyöngy%' OR lower(name) LIKE '%gyongy%') ORDER BY CASE WHEN lower(name) LIKE 'gyöngy%' OR lower(name) LIKE 'gyongy%' THEN 0 ELSE 1 END,name LIMIT 1`)).rows[0];
  if(!location){console.warn("Gyöngyös kiosk: nincs azonosítható aktív telephely.");return}
  await pool.query(`INSERT INTO kiosk_devices(device_key,name,location_id,is_active,updated_at) VALUES('gyongyos-main','Gyöngyös szalon kiosk',$1::uuid,true,now()) ON CONFLICT(device_key) DO UPDATE SET name=EXCLUDED.name,location_id=EXCLUDED.location_id,is_active=true,updated_at=now()`,[location.id]);
  let menu=(await pool.query(`SELECT id::text id FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[location.id])).rows[0];
  if(!menu){menu=(await pool.query(`INSERT INTO kiosk_menus(location_id,name,theme,is_active) VALUES($1::uuid,$2,$3::jsonb,true) RETURNING id::text id`,[location.id,`${location.name} kiosk`,JSON.stringify(DEFAULT_THEME)])).rows[0]}
  const menuId=menu.id as string;
  const currentTheme=(await pool.query(`SELECT theme FROM kiosk_menus WHERE id=$1::uuid`,[menuId])).rows[0]?.theme||{};
  await pool.query(`UPDATE kiosk_menus SET theme=$2::jsonb,updated_at=updated_at WHERE id=$1::uuid`,[menuId,JSON.stringify({...DEFAULT_THEME,...currentTheme})]);

  const serviceSectionCount=Number((await pool.query(`SELECT count(*)::int n FROM kiosk_menu_sections WHERE menu_id=$1::uuid`,[menuId])).rows[0]?.n||0);
  if(serviceSectionCount===0){
    const types=(await pool.query(`SELECT id::text id,COALESCE(name,'Egyéb') title FROM service_types ORDER BY COALESCE(display_order,999999),COALESCE(name,'Egyéb')`)).rows;const map=new Map<string,string>();let order=0;
    for(const type of types){const id=(await pool.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,$2,'',$3,true) RETURNING id::text id`,[menuId,type.title,order++])).rows[0].id;map.set(type.id,id)}
    const other=(await pool.query(`INSERT INTO kiosk_menu_sections(menu_id,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,'Egyéb','',$2,true) RETURNING id::text id`,[menuId,order++])).rows[0].id;
    const services=(await pool.query(`SELECT s.id::text id,s.service_type_id::text service_type_id FROM services s WHERE COALESCE(s.is_active,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))`,[location.id])).rows;let i=0;
    for(const s of services)await pool.query(`INSERT INTO kiosk_menu_items(section_id,service_id,display_order,enabled) VALUES($1::uuid,$2::uuid,$3,true) ON CONFLICT(section_id,service_id) DO NOTHING`,[map.get(s.service_type_id)||other,s.id,i++]);
  }

  const productSectionCount=Number((await pool.query(`SELECT count(*)::int n FROM kiosk_product_sections WHERE menu_id=$1::uuid`,[menuId])).rows[0]?.n||0);
  if(productSectionCount===0){
    const hasCats=(await pool.query(`SELECT to_regclass('public.product_categories') IS NOT NULL ok`)).rows[0]?.ok;
    const hasGroups=(await pool.query(`SELECT to_regclass('public.product_groups') IS NOT NULL ok`)).rows[0]?.ok;
    const joins=`${hasCats?"LEFT JOIN product_categories pc ON pc.id=NULLIF(to_jsonb(p)->>'product_category_id','')::uuid":""} ${hasGroups?"LEFT JOIN product_groups pg ON pg.id=NULLIF(to_jsonb(p)->>'product_group_id','')::uuid":""}`;
    const categoryExpr=hasCats?"NULLIF(pc.name_hu,'')":"NULL";const groupExpr=hasGroups?"NULLIF(pg.name_hu,'')":"NULL";
    const products=(await pool.query(`SELECT p.id::text id,COALESCE(NULLIF(to_jsonb(p)->>'product_category_id',''),NULLIF(to_jsonb(p)->>'product_group_id',''),NULLIF(to_jsonb(p)->>'sub_category',''),NULLIF(to_jsonb(p)->>'main_category',''),'products') group_key,COALESCE(${categoryExpr},${groupExpr},NULLIF(to_jsonb(p)->>'sub_category',''),NULLIF(to_jsonb(p)->>'main_category',''),NULLIF(to_jsonb(p)->>'brand',''),'Termékek') group_name FROM products p ${joins} WHERE COALESCE(to_jsonb(p)->>'is_active','true') NOT IN ('false','0') AND COALESCE(to_jsonb(p)->>'is_retail','true') NOT IN ('false','0') ORDER BY group_name,COALESCE(NULLIF(to_jsonb(p)->>'name_hu',''),NULLIF(to_jsonb(p)->>'name',''),'Termék')`)).rows;
    const grouped=new Map<string,{name:string;ids:string[]}>();for(const p of products){const key=String(p.group_key);if(!grouped.has(key))grouped.set(key,{name:String(p.group_name||"Termékek"),ids:[]});grouped.get(key)!.ids.push(String(p.id))}
    let so=0;for(const[key,g]of grouped){const sectionId=(await pool.query(`INSERT INTO kiosk_product_sections(menu_id,group_key,title_hu,subtitle_hu,display_order,enabled) VALUES($1::uuid,$2,$3,'',$4,true) RETURNING id::text id`,[menuId,key,g.name,so++])).rows[0].id;let io=0;for(const productId of g.ids)await pool.query(`INSERT INTO kiosk_product_items(section_id,product_id,display_order,enabled) VALUES($1::uuid,$2::uuid,$3,true) ON CONFLICT(section_id,product_id) DO NOTHING`,[sectionId,productId,io++])}
  }
}

export async function ensureKioskAdmin() {
  await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL;`);
  let settingsId=(await pool.query(`SELECT id FROM menus WHERE code='settings' OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció') ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id LIMIT 1`)).rows[0]?.id;
  if(!settingsId)settingsId=(await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,NULL,true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true RETURNING id`)).rows[0].id;
  const menuId=(await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('screens.kiosk','Kiosk admin','MonitorSmartphone','/kiosk',172,$1,NULL,true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=NULL,is_active=true RETURNING id`,[settingsId])).rows[0].id;
  await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT role_key,$1,true,true,true,false,false,false,false,false,scope_type,now() FROM (VALUES('admin','all_locations'),('manager','all_locations'),('location_manager','own_location'),('receptionist','own_location'),('salon_manager','own_location')) AS r(role_key,scope_type) ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=false,scope_type=EXCLUDED.scope_type,updated_at=now()`,[menuId]).catch(()=>undefined);
  await ensureGyongyosCatalog();
}

export default ensureKioskAdmin;
