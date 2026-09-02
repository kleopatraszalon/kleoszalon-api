import { Router } from "express";
import { pool } from "../db";
import { ensureBookingWorkOrderSchema } from "../services/bookingWorkOrder";
import { repairBookingWorkOrderStatusConstraints } from "../booking/repairBookingWorkOrderStatusConstraints";
import { ensureKioskQueueSchema } from "../services/kioskQueue";
import { ensureKioskWorkOrderInsertCompatibility, finalizeKioskWorkOrderTotals } from "../services/kioskWorkOrderRuntime";

export const kioskRouter = Router();
const clean=(v:unknown)=>String(v??"").trim();
const qty=(v:unknown)=>Math.max(1,Math.min(99,Number(v)||1));
let schemaReady=false;
let workOrderRuntimeReady=false;
let workOrderRuntimePromise:Promise<void>|null=null;

async function ensureKioskPublicSchema(){
 if(schemaReady)return;
 await pool.query(`
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE TABLE IF NOT EXISTS kiosk_menus(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NULL REFERENCES locations(id) ON DELETE CASCADE,
     name text NOT NULL DEFAULT 'Kiosk menü',theme jsonb NOT NULL DEFAULT '{}'::jsonb,is_active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS kiosk_menu_sections(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
     title_hu text NOT NULL,display_order int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS subtitle_hu text;
   ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS image_url text;
   ALTER TABLE kiosk_menu_sections ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
   CREATE TABLE IF NOT EXISTS kiosk_menu_items(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),section_id uuid NOT NULL REFERENCES kiosk_menu_sections(id) ON DELETE CASCADE,
     service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,display_order int NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,
     UNIQUE(section_id,service_id)
   );
   ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS image_url text;
   ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS badge_text text;
   ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
   ALTER TABLE kiosk_menu_items ADD COLUMN IF NOT EXISTS display_name text;

   CREATE TABLE IF NOT EXISTS kiosk_product_sections(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
     group_key text,title_hu text NOT NULL,subtitle_hu text,image_url text,enabled boolean NOT NULL DEFAULT true,
     display_order int NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS kiosk_product_items(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),section_id uuid NOT NULL REFERENCES kiosk_product_sections(id) ON DELETE CASCADE,
     product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,display_order int NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,
     image_url text,badge_text text,featured boolean NOT NULL DEFAULT false,display_name text,UNIQUE(section_id,product_id)
   );
   CREATE TABLE IF NOT EXISTS kiosk_devices(
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),device_key text NOT NULL UNIQUE,name text NOT NULL,
     location_id uuid REFERENCES locations(id) ON DELETE SET NULL,is_active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
 `);
 schemaReady=true;
}

async function ensureKioskWorkOrderRuntime(){
 if(workOrderRuntimeReady)return;
 if(workOrderRuntimePromise)return workOrderRuntimePromise;
 workOrderRuntimePromise=(async()=>{
  const cx=await pool.connect();
  try{
   await ensureBookingWorkOrderSchema(cx);
   await repairBookingWorkOrderStatusConstraints(cx);
   // A két általános bootstrap readiness feltétele történeti okból nem ellenőriz
   // minden legacy defaultot. A KIOSK saját guardja ezért mindig közvetlenül
   // biztosítja a tényleges INSERT-kompatibilitást.
   await ensureKioskWorkOrderInsertCompatibility(cx);
  }finally{cx.release()}
  await ensureKioskQueueSchema();
  workOrderRuntimeReady=true;
 })().catch(error=>{workOrderRuntimePromise=null;throw error});
 return workOrderRuntimePromise;
}

async function gyongyosLocation(){
 await ensureKioskPublicSchema();
 return (await pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true AND (lower(name) LIKE '%gyöngy%' OR lower(name) LIKE '%gyongy%') ORDER BY CASE WHEN lower(name) LIKE 'gyöngy%' OR lower(name) LIKE 'gyongy%' THEN 0 ELSE 1 END,name LIMIT 1`)).rows[0]||null;
}
async function ensureGyongyosDevice(){
 const loc=await gyongyosLocation();if(!loc)return null;
 return (await pool.query(`INSERT INTO kiosk_devices(device_key,name,location_id,is_active,updated_at) VALUES('gyongyos-main','Gyöngyös szalon kiosk',$1::uuid,true,now()) ON CONFLICT(device_key) DO UPDATE SET location_id=EXCLUDED.location_id,name=EXCLUDED.name,is_active=true,updated_at=now() RETURNING id::text id,device_key,name,location_id::text location_id,is_active,updated_at`,[loc.id])).rows[0]||null;
}
async function resolveLocation(explicit?:unknown){
 const given=clean(explicit);if(given){const row=(await pool.query(`SELECT id::text id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[given])).rows[0];if(row)return row}
 const device=await ensureGyongyosDevice();if(device?.location_id){const row=(await pool.query(`SELECT id::text id,name FROM locations WHERE id=$1::uuid`,[device.location_id])).rows[0];if(row)return row}
 const gy=await gyongyosLocation();if(gy)return gy;
 return (await pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name LIMIT 1`)).rows[0]||null;
}
async function kioskMenu(locationId:string){if(!locationId)return null;await ensureKioskPublicSchema();return (await pool.query(`SELECT id::text id,name,theme,is_active,updated_at FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[locationId])).rows[0]||null}

kioskRouter.get("/context",async(req,res)=>{try{
 const location=await resolveLocation(req.query.location_id||req.query.locationId);const locationId=location?.id||"";
 const[locations,employees,device]=await Promise.all([
  pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY CASE WHEN id::text=$1::text THEN 0 ELSE 1 END,name`,[locationId]),
  pool.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,location_id::text location_id,photo_url FROM employees WHERE COALESCE(active,true)=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,[locationId]),
  ensureGyongyosDevice()
 ]);
 res.json({ok:true,bound_location:location,device,locations:locations.rows,employees:employees.rows});
 }catch(e:any){console.error("Kiosk context hiba:",e);res.status(500).json({ok:false,error:"kiosk_context_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/config",async(req,res)=>{try{
 const location=await resolveLocation(req.query.location_id||req.query.locationId);const locationId=location?.id||"",menu=await kioskMenu(locationId);let sections:any[]=[];let productSections:any[]=[];
 if(menu?.id){
  sections=(await pool.query(`SELECT id::text id,title_hu title,COALESCE(subtitle_hu,'') subtitle,COALESCE(image_url,'') image_url,enabled,display_order FROM kiosk_menu_sections WHERE menu_id=$1::uuid ORDER BY display_order,id`,[menu.id])).rows;
  productSections=(await pool.query(`SELECT id::text id,title_hu title,COALESCE(subtitle_hu,'') subtitle,COALESCE(image_url,'') image_url,enabled,display_order FROM kiosk_product_sections WHERE menu_id=$1::uuid ORDER BY display_order,id`,[menu.id])).rows;
 }
 res.json({ok:true,location_id:locationId||null,location,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{},updated_at:menu.updated_at}:null,sections,productSections});
 }catch(e:any){res.status(500).json({ok:false,error:"kiosk_config_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/services",async(req,res)=>{try{
 await ensureKioskPublicSchema();
 const language=clean(req.query.lang)||"hu",location=await resolveLocation(req.query.locationId||req.query.location_id),locationId=location?.id||"",menu=await kioskMenu(locationId);
 if(menu&&!menu.is_active)return res.json({ok:true,language,location,categories:[],services:[],menu:{id:menu.id,name:menu.name,is_active:false,theme:menu.theme||{}}});
 const menuId=menu?.id||null;
 const r=await pool.query(`
   SELECT s.id::text id,s.name,COALESCE(s.description_short,s.description_long,'') description,
          COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(s.duration_minutes,30)::int duration_minutes,
          COALESCE(km.section_id::text,s.service_type_id::text) category_id,COALESCE(km.section_title,st.name,'Egyéb') category_name,
          COALESCE(km.section_subtitle,'') category_subtitle,COALESCE(km.section_image,'') category_image,
          COALESCE(km.section_order,999999) section_order,COALESCE(km.item_order,999999) item_order,
          COALESCE(km.item_image,'') image_url,COALESCE(km.badge_text,'') badge_text,COALESCE(km.featured,false) featured,
          COALESCE(NULLIF(km.display_name,''),s.name) display_name
   FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
   LEFT JOIN LATERAL (
     SELECT sec.id section_id,sec.title_hu section_title,sec.subtitle_hu section_subtitle,sec.image_url section_image,
            sec.display_order section_order,mi.display_order item_order,mi.image_url item_image,mi.badge_text,mi.featured,mi.display_name
     FROM kiosk_menu_sections sec JOIN kiosk_menu_items mi ON mi.section_id=sec.id
     WHERE sec.menu_id=$2::uuid AND sec.enabled=true AND mi.service_id=s.id AND mi.enabled=true
     ORDER BY sec.display_order,mi.featured DESC,mi.display_order LIMIT 1
   ) km ON $2::uuid IS NOT NULL
   WHERE COALESCE(s.is_active,true)=true
     AND ($1::text='' OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id::text=$1))
     AND ($2::uuid IS NULL OR km.section_id IS NOT NULL)
   ORDER BY section_order,featured DESC,item_order,COALESCE(km.section_title,st.name,'Egyéb'),s.name`,[locationId,menuId]);
 const services=r.rows.map((row:any)=>({id:String(row.id),name:row.display_name||row.name,name_hu:row.display_name||row.name,description:row.description??null,list_price:Number(row.price||0),base_price:Number(row.price||0),duration_minutes:Number(row.duration_minutes||30),category_id:row.category_id,category_name:row.category_name,category_name_hu:row.category_name,category_subtitle:row.category_subtitle||"",category_image:row.category_image||"",image_url:row.image_url||"",badge_text:row.badge_text||"",featured:Boolean(row.featured)}));
 const map=new Map<string,any>();for(const s of services){const id=String(s.category_id||s.category_name||"other");if(!map.has(id))map.set(id,{id,name:s.category_name||"Egyéb",subtitle:s.category_subtitle||"",image_path:s.category_image||null,type:"service"})}
 res.json({ok:true,language,location,categories:Array.from(map.values()),services,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{}}:null});
 }catch(e:any){console.error("Kiosk services hiba:",e);res.status(500).json({ok:false,error:"kiosk_services_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/products",async(req,res)=>{try{
 await ensureKioskPublicSchema();
 const location=await resolveLocation(req.query.locationId||req.query.location_id),locationId=location?.id||"",menu=await kioskMenu(locationId);
 if(!menu||!menu.is_active)return res.json({ok:true,location,categories:[],products:[],menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{}}:null});
 const r=await pool.query(`
   SELECT p.id::text id,
     COALESCE(NULLIF(pi.display_name,''),NULLIF(to_jsonb(p)->>'name_hu',''),NULLIF(to_jsonb(p)->>'name',''),'Termék') name,
     COALESCE(NULLIF(to_jsonb(p)->>'web_description_hu',''),NULLIF(to_jsonb(p)->>'web_description',''),'') description,
     COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,0) price,
     COALESCE(NULLIF(pi.image_url,''),NULLIF(to_jsonb(p)->>'image_url',''),NULLIF(to_jsonb(p)->>'web_image_url',''),NULLIF(to_jsonb(p)->>'photo_url',''),'') image_url,
     sec.id::text category_id,sec.title_hu category_name,COALESCE(sec.subtitle_hu,'') category_subtitle,COALESCE(sec.image_url,'') category_image,
     sec.display_order section_order,pi.display_order item_order,COALESCE(pi.badge_text,'') badge_text,COALESCE(pi.featured,false) featured
   FROM kiosk_product_sections sec JOIN kiosk_product_items pi ON pi.section_id=sec.id JOIN products p ON p.id=pi.product_id
   WHERE sec.menu_id=$1::uuid AND sec.enabled=true AND pi.enabled=true
     AND COALESCE(to_jsonb(p)->>'is_active','true') NOT IN ('false','0')
     AND COALESCE(to_jsonb(p)->>'is_retail','true') NOT IN ('false','0')
   ORDER BY sec.display_order,pi.featured DESC,pi.display_order,name
 `,[menu.id]);
 const products=r.rows.map((row:any)=>({id:String(row.id),name:row.name,name_hu:row.name,web_description:row.description||"",retail_price_gross:Number(row.price||0),sale_price:Number(row.price||0),image_url:row.image_url||"",category_id:row.category_id,category_name:row.category_name,category_subtitle:row.category_subtitle||"",category_image:row.category_image||"",badge_text:row.badge_text||"",featured:Boolean(row.featured)}));
 const map=new Map<string,any>();for(const p of products){const id=String(p.category_id);if(!map.has(id))map.set(id,{id,name:p.category_name||"Termékek",subtitle:p.category_subtitle||"",image_path:p.category_image||null,type:"product"})}
 res.json({ok:true,location,categories:Array.from(map.values()),products,menu:{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{}}});
 }catch(e:any){console.error("Kiosk products hiba:",e);res.status(500).json({ok:false,error:"kiosk_products_failed",detail:e?.message||String(e)})}});

kioskRouter.post("/workorders",async(req,res)=>{
 let stage="runtime-guard";
 try{await ensureKioskWorkOrderRuntime()}
 catch(e:any){console.error("Kiosk workorder runtime guard hiba:",e);return res.status(503).json({error:"A kiosk munkalap adatbázis-előkészítése átmenetileg nem sikerült.",error_code:"kiosk_workorder_runtime_not_ready",stage,diagnostic:{code:e?.code||null,table:e?.table||null,column:e?.column||null,constraint:e?.constraint||null}})}
 stage="resolve-location";
 const resolved=await resolveLocation(req.body?.location_id);const locationId=resolved?.id||"",employeeId=clean(req.body?.employee_id),clientName=clean(req.body?.client_name),phone=clean(req.body?.phone),email=clean(req.body?.email),note=clean(req.body?.note),paymentMethod=clean(req.body?.payment_method)||"reception",items=Array.isArray(req.body?.items)?req.body.items:[];
 if(!locationId||!clientName||(!phone&&!email)||!items.length)return res.status(400).json({error:"Telephely, vendégnév, elérhetőség és legalább egy tétel szükséges."});
 const validateOnly=String(req.query.validate_only||"")==="1"&&String(req.headers["x-kleo-kiosk-uat"]||"")==="1";
 const cx=await pool.connect();
 try{
  stage="begin";await cx.query("BEGIN");
  stage="location";const loc=await cx.query(`SELECT id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[locationId]);if(!loc.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott szalon nem található."})}
  stage="client-find";let client=await cx.query(`SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(name,''),'') client_name,phone,email FROM clients WHERE location_id=$1::uuid AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`,[locationId,phone,email]);
  let clientId=client.rows[0]?.id;
  if(!clientId){stage="client-create";client=await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,$2,$3,$4::uuid,false,true,'kiosk',now(),now()) RETURNING id`,[clientName,phone||null,email||null,locationId]);clientId=client.rows[0].id}
  if(employeeId){stage="employee";const emp=await cx.query(`SELECT id FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true AND (location_id=$2::uuid OR location_id IS NULL)`,[employeeId,locationId]);if(!emp.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott munkatárs nem található ebben a szalonban."})}}
  stage="official-number";const number=(await cx.query(`SELECT next_official_work_order_number(now()) work_order_number`)).rows[0].work_order_number;
  const sourceSnapshot={source:"kiosk",device_key:"gyongyos-main",payment_method:paymentMethod,items,location_id:locationId};
  stage="workorder-header";const header=await cx.query(`INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot) VALUES('Kiosk rendelés / szolgáltatás',$1,'waiting',$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,false,false,'public-kiosk',now(),$8,now(),$9::jsonb) RETURNING id,work_order_number,status,created_at,kiosk_queue_no,kiosk_queue_date,kiosk_queue_code`,[note||`Kiosk fizetési mód: ${paymentMethod}`,employeeId||null,clientId,clientName,phone||null,email||null,locationId,number,JSON.stringify(sourceSnapshot)]);
  const workOrderId=String(header.rows[0].id);let calculatedTotal=0;let savedItemCount=0;
  stage="items";
  for(const raw of items){
   const kind=clean(raw?.kind||raw?.meta?.kind).toLowerCase(),id=clean(raw?.id),quantity=qty(raw?.qty);if(!id)continue;
   if(kind==="product"){
    const p=(await cx.query(`SELECT id,COALESCE(NULLIF(to_jsonb(products)->>'name_hu',''),name) name,COALESCE(NULLIF(to_jsonb(products)->>'retail_price_gross','')::numeric,0)::numeric price FROM products WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];
    if(p){const price=Number(p.price||0),lineTotal=quantity*price;await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,$5,0,$6)`,[workOrderId,p.id,p.name,quantity,price,lineTotal]);calculatedTotal+=lineTotal;savedItemCount++}
   }else if(kind==="service"){
    const s=(await cx.query(`SELECT id,name,COALESCE(promo_price,list_price,base_price,0)::numeric price,COALESCE(duration_minutes,30)::int duration FROM services WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];
    if(s){const price=Number(s.price||0),lineTotal=quantity*price;await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes) VALUES($1,'service',$2,$3,$4,$5,0,$6,$7)`,[workOrderId,s.id,s.name,quantity,price,lineTotal,s.duration]);calculatedTotal+=lineTotal;savedItemCount++}
   }
  }
  if(!savedItemCount){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott tételek közül egyik sem található az aktuális katalógusban."})}
  stage="totals";await finalizeKioskWorkOrderTotals(cx,workOrderId,calculatedTotal);
  stage=validateOnly?"uat-rollback":"commit";
  if(validateOnly)await cx.query("ROLLBACK");else await cx.query("COMMIT");
  res.status(201).json({ok:true,...header.rows[0],source:"kiosk",location:resolved,payment_method:paymentMethod,total:calculatedTotal,item_count:savedItemCount,validated_only:validateOnly});
 }catch(e:any){
  await cx.query("ROLLBACK").catch(()=>undefined);
  console.error("Kiosk workorder hiba:",{stage,code:e?.code||null,table:e?.table||null,column:e?.column||null,constraint:e?.constraint||null,message:e?.message||String(e)});
  res.status(500).json({error:"A kiosk munkalap létrehozása sikertelen.",error_code:"kiosk_workorder_create_failed",stage,diagnostic:{code:e?.code||null,table:e?.table||null,column:e?.column||null,constraint:e?.constraint||null}})
 }finally{cx.release()}
});

export default kioskRouter;
