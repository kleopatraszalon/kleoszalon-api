import * as express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureVirSpecModules } from "../virSpec/ensureVirSpecModules";
import { ensureMenuHealth } from "../menu/ensureMenuHealth";
import { applyMenuLayoutOverrides, clearMenuLayoutOverrides, saveMenuLayout, type MenuLayoutItem } from "../menu/menuLayout";
import { clearShortCache, shortCache, timed } from "../performance/shortCache";

const router=express.Router();
const MENU_CACHE_MS=Number(process.env.MENU_RESPONSE_CACHE_MS??15000);
const MENU_MAINTENANCE_MS=Number(process.env.MENU_MAINTENANCE_MS??600000);
let maintenancePromise:Promise<void>|null=null;
let nextMaintenanceAt=0;
function roleKeys(raw:any):string[]{if(Array.isArray(raw))return raw.map(String);try{const p=JSON.parse(String(raw||""));return Array.isArray(p)?p.map(String):[String(p)]}catch{return String(raw||"").split(",").map(x=>x.replace(/[\[\]"]/g,"").trim()).filter(Boolean)}}
function isAdmin(req:AuthRequest){return roleKeys(req.user?.role).map(x=>x.toLowerCase()).includes("admin")}
async function bestEffort(label:string,fn:()=>Promise<any>){try{await fn()}catch(err:any){console.warn(`⚠️ Menü előkészítés kihagyva (${label}):`,err?.message||err)}}

async function ensureTeamImportMenu(){await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'team.import','Importálás és duplikációkezelés',NULL,'/modules/team/import',70,t.id,'staff_import',true FROM menus t WHERE t.code='team' ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`)}
async function ensureProcurementMenu(){
 await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES ('procurement','Beszerzés','ShoppingBag',NULL,75,NULL,'inventory',true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,parent_id=NULL,feature_key='inventory',is_active=true`);
 await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='procurement') INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT x.code,x.name,NULL,x.route,x.order_index,p.id,'inventory',true FROM p CROSS JOIN (VALUES ('procurement.dashboard','Beszerzési dashboard','/warehouse?view=procurement&section=dashboard',10),('procurement.suggestions','Rendelési javaslatok','/warehouse?view=procurement&section=suggestions',20),('procurement.approvals','Jóváhagyásra vár','/warehouse?view=procurement&section=approvals',30),('procurement.orders','Beszerzési rendelések','/warehouse?view=procurement&section=orders',40),('procurement.suppliers','Beszállítók','/warehouse?view=procurement&section=suppliers',50),('procurement.prices','Beszállítói árak','/warehouse?view=procurement&section=prices',60),('procurement.performance','Beszállítói teljesítmény','/warehouse?view=procurement&section=performance',70),('procurement.deviations','Eltérések','/warehouse?view=procurement&section=deviations',80)) AS x(code,name,route,order_index) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='inventory',is_active=true`);
 await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type) SELECT rp.role_key,target.id,rp.can_view,rp.can_create,rp.can_edit,rp.can_delete,rp.can_approve,rp.can_export,rp.can_view_financial,rp.can_manage_permissions,rp.scope_type FROM role_menu_permissions rp JOIN menus source ON source.id=rp.menu_id AND source.code='inventory' CROSS JOIN menus target WHERE (target.code='procurement' OR target.code LIKE 'procurement.%') AND lower(rp.role_key)<>'location_manager' ON CONFLICT(role_key,menu_id) DO NOTHING`).catch(()=>undefined);
 await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT 'location_manager',m.id,(m.code IN ('procurement','procurement.dashboard','procurement.suggestions','procurement.orders')),(m.code='procurement.orders'),(m.code='procurement.orders'),false,false,(m.code='procurement.orders'),false,false,'own_location',now() FROM menus m WHERE m.code='procurement' OR m.code LIKE 'procurement.%' ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=false,can_approve=false,can_export=EXCLUDED.can_export,can_view_financial=false,can_manage_permissions=false,scope_type='own_location',updated_at=now()`).catch(()=>undefined);
}
async function ensureCurrentStageMenus(){
 await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;`);
 await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL`);
 await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('finance','Pénzügyek','WalletCards',NULL,60,NULL,'finance',true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true`);
 await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1) INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'finance.control','Pénzügyi kontroll és havi zárás',NULL,'/finance?section=control',145,p.id,'finance',true FROM p ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`);
 await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1) INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'finance.payroll','Bér- és jutalékszámítás',NULL,'/modules/team/payroll',80,p.id,'payroll',true FROM p ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`);
 await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='team' LIMIT 1) INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'team.positions','Munkakörök',NULL,'/hr/positions',30,p.id,'hr',true FROM p ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`);
 await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1) INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'customers.loyalty_program','Törzsvásárlói program',NULL,'/modules/customers/loyalty-program',60,p.id,'loyalty',true FROM p ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`);
 await pool.query(`UPDATE menus SET is_active=false WHERE code='team.payroll'`);
 let settingsId:number|null=null;const found=await pool.query(`SELECT id FROM menus WHERE code IN ('settings','settings.admin','administration') OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció') ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id LIMIT 1`);settingsId=found.rows[0]?.id?Number(found.rows[0].id):null;
 if(!settingsId){const c=await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'audit',true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true RETURNING id`);settingsId=Number(c.rows[0].id)}
 await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('settings.system_health','Rendszerellenőrzés','Activity','/admin/system-health',190,$1,'audit',true),('settings.uat','UAT tesztközpont','ClipboardCheck','/admin/uat',195,$1,'audit',true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`,[settingsId]);
 await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT r.role_key,m.id,true,(m.code IN ('settings.uat','team.positions','customers.loyalty_program')),(m.code IN ('settings.uat','team.positions','customers.loyalty_program')),false,(m.code='settings.uat'),true,(m.code NOT IN ('team.positions','customers.loyalty_program')),(r.role_key='admin'),'all_locations',now() FROM (VALUES ('admin'),('manager')) r(role_key) JOIN menus m ON m.code IN ('finance.control','finance.payroll','team.positions','customers.loyalty_program','settings.system_health','settings.uat') ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_approve=EXCLUDED.can_approve,can_export=true,can_view_financial=EXCLUDED.can_view_financial,updated_at=now()`).catch(()=>undefined);
}
async function ensureCleanMenu(){await pool.query(`UPDATE menus SET name='Irányítópult' WHERE code='dashboard'`);await pool.query(`UPDATE menus SET is_active=false WHERE code IN ('inventory.receiving','inventory.suppliers')`);await pool.query(`UPDATE menus child SET parent_id=settings.id,is_active=true FROM menus settings WHERE settings.code='settings' AND child.code IN ('screens.signage','screens.kiosk','integrations.marketplace','integrations.api','integrations.logs')`);await pool.query(`UPDATE menus SET is_active=false WHERE code IN ('screens','integrations')`)}

async function runMenuMaintenance(){
 await bestEffort("VIR modulok",()=>ensureVirSpecModules());
 await bestEffort("HR import menü",()=>ensureTeamImportMenu());
 await bestEffort("Beszerzés menü",()=>ensureProcurementMenu());
 await bestEffort("aktuális etap menük",()=>ensureCurrentStageMenus());
 await bestEffort("korábbi menütisztítás",()=>ensureCleanMenu());
 await bestEffort("menü audit és önjavítás",()=>ensureMenuHealth());
 await bestEffort("egyedi menürendezés",()=>applyMenuLayoutOverrides());
 clearShortCache("menu:");
}
function scheduleMenuMaintenance(force=false){
 const now=Date.now();
 if(!force&&(maintenancePromise||now<nextMaintenanceAt))return;
 nextMaintenanceAt=now+MENU_MAINTENANCE_MS;
 const timer=setTimeout(()=>{
   if(maintenancePromise)return;
   maintenancePromise=timed("menu background maintenance",runMenuMaintenance,750).finally(()=>{maintenancePromise=null});
 },100);
 timer.unref?.();
}

function parseLayoutItems(raw:unknown):MenuLayoutItem[]{
 if(!Array.isArray(raw)||!raw.length)throw new Error("Hiányzik a menüelrendezés.");
 const items=raw.map((value:any)=>({id:Number(value?.id),parent_id:value?.parent_id===null||value?.parent_id===undefined?null:Number(value.parent_id),order_index:Number(value?.order_index)}));
 if(items.some(x=>!Number.isInteger(x.id)||x.id<=0||!Number.isInteger(x.order_index)||x.order_index<0||(x.parent_id!==null&&(!Number.isInteger(x.parent_id)||x.parent_id<=0))))throw new Error("Érvénytelen menüelrendezési adat.");
 if(new Set(items.map(x=>x.id)).size!==items.length)throw new Error("Egy menüpont csak egyszer szerepelhet az elrendezésben.");
 if(items.some(x=>x.parent_id===x.id))throw new Error("Egy menüpont nem lehet saját maga alatt.");
 return items;
}

router.put("/layout",requireAuth,async(req:AuthRequest,res)=>{
 if(!isAdmin(req))return res.status(403).json({message:"Csak adminisztrátor rendezheti át a menüt."});
 try{
  const items=parseLayoutItems(req.body?.items);
  const actor=String((req.user as any)?.id||(req.user as any)?.email||"admin");
  await saveMenuLayout(items,actor);
  clearShortCache("menu:");
  res.json({ok:true,count:items.length});
 }catch(err:any){res.status(400).json({message:err?.message||"A menüelrendezést nem sikerült menteni."})}
});

router.delete("/layout",requireAuth,async(req:AuthRequest,res)=>{
 if(!isAdmin(req))return res.status(403).json({message:"Csak adminisztrátor állíthatja vissza a menüt."});
 try{
  await clearMenuLayoutOverrides();
  await runMenuMaintenance();
  clearShortCache("menu:");
  res.json({ok:true});
 }catch(err:any){res.status(500).json({message:err?.message||"A menü alapelrendezését nem sikerült visszaállítani."})}
});

router.put("/reorder-roots",requireAuth,async(req:AuthRequest,res)=>{
 if(!isAdmin(req))return res.status(403).json({message:"Csak adminisztrátor rendezheti a főmenüt."});
 const ids=Array.isArray(req.body?.ordered_ids)?req.body.ordered_ids.map((x:unknown)=>Number(x)).filter((x:number)=>Number.isInteger(x)&&x>0):[];
 if(!ids.length)return res.status(400).json({message:"Hiányzik a főmenü sorrendje."});
 try{
  const{rows}=await pool.query(`SELECT id FROM menus WHERE parent_id IS NULL AND COALESCE(is_active,true) AND id=ANY($1::bigint[])`,[ids]);
  if(rows.length!==ids.length)return res.status(400).json({message:"A sorrend csak aktív főmenü-elemeket tartalmazhat."});
  const actor=String((req.user as any)?.id||(req.user as any)?.email||"admin");
  await saveMenuLayout(ids.map((id:number,index:number)=>({id,parent_id:null,order_index:(index+1)*10})),actor);
  clearShortCache("menu:");
  res.json({ok:true});
 }catch(err:any){res.status(500).json({message:err?.message||"A főmenü sorrendjét nem sikerült menteni."})}
});

async function readMenuTree(roles:string[],admin:boolean){
 await bestEffort("egyedi menürendezés betöltése",()=>applyMenuLayoutOverrides());
 let rows:any[]=[];
 try{const r=await pool.query(`SELECT DISTINCT m.id,m.code,m.name,m.icon,m.route,m.order_index,m.parent_id,m.feature_key,COALESCE(p.can_view,$2::boolean) can_view,COALESCE(p.can_create,$2::boolean) can_create,COALESCE(p.can_edit,$2::boolean) can_edit,COALESCE(p.can_delete,$2::boolean) can_delete,COALESCE(p.can_approve,$2::boolean) can_approve,COALESCE(p.can_export,$2::boolean) can_export,COALESCE(p.can_view_financial,$2::boolean) can_view_financial,COALESCE(p.can_manage_permissions,$2::boolean) can_manage_permissions,COALESCE(p.scope_type,CASE WHEN $2 THEN 'all_locations' ELSE 'own_location' END) scope_type FROM menus m LEFT JOIN role_menu_permissions p ON p.menu_id=m.id AND lower(p.role_key)=ANY($1::text[]) WHERE COALESCE(m.is_active,true) AND ($2 OR COALESCE(p.can_view,false)) ORDER BY m.order_index,m.id`,[roles,admin]);rows=r.rows}catch(e:any){if(!admin)throw e;rows=(await pool.query(`SELECT m.id,m.code,m.name,m.icon,m.route,m.order_index,m.parent_id,m.feature_key,true can_view,true can_create,true can_edit,true can_delete,true can_approve,true can_export,true can_view_financial,true can_manage_permissions,'all_locations'::text scope_type FROM menus m WHERE COALESCE(m.is_active,true) ORDER BY m.order_index,m.id`)).rows}
 const byId=new Map<number,any>();rows.forEach(r=>byId.set(Number(r.id),{...r,id:Number(r.id),required_role:"all",role:"all",permissions:{can_view:r.can_view,can_create:r.can_create,can_edit:r.can_edit,can_delete:r.can_delete,can_approve:r.can_approve,can_export:r.can_export,can_view_financial:r.can_view_financial,can_manage_permissions:r.can_manage_permissions,scope_type:r.scope_type},submenus:[]}));const roots:any[]=[];rows.forEach(r=>{const item=byId.get(Number(r.id));if(r.parent_id&&byId.has(Number(r.parent_id)))byId.get(Number(r.parent_id)).submenus.push(item);else roots.push(item)});const sort=(a:any[])=>{a.sort((x,y)=>(x.order_index||0)-(y.order_index||0)||x.id-y.id);a.forEach(x=>sort(x.submenus))};sort(roots);return roots
}

router.get("/",requireAuth,async(req:AuthRequest,res)=>{const roles=roleKeys(req.user?.role).map(x=>x.toLowerCase()).sort(),admin=roles.includes("admin");try{const key=`menu:${admin?"admin":"user"}:${roles.join(",")}`;const roots=await shortCache(key,MENU_CACHE_MS,()=>timed(`/api/menus ${roles.join(",")||"no-role"}`,()=>readMenuTree(roles,admin)));res.setHeader("Cache-Control","private, no-store");res.json(roots);scheduleMenuMaintenance()}catch(err:any){console.error("❌ Jogosultságalapú menühiba:",err?.message||err);res.status(500).json({error:"A menü betöltése nem sikerült.",detail:err?.message||String(err)})}});
export default router;
