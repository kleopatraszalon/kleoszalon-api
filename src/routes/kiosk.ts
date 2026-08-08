import { Router } from "express";
import { pool } from "../db";

export const kioskRouter = Router();
const clean=(v:unknown)=>String(v??"").trim();
const qty=(v:unknown)=>Math.max(1,Math.min(99,Number(v)||1));
let schemaReady=false;

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
 `);
 schemaReady=true;
}

async function kioskMenu(locationId:string){
 if(!locationId)return null;
 try{await ensureKioskPublicSchema();return (await pool.query(`SELECT id::text id,name,theme,is_active,updated_at FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[locationId])).rows[0]||null}catch{return null}
}

kioskRouter.get("/context",async(req,res)=>{try{const locationId=clean(req.query.location_id||req.query.locationId);const[locations,employees]=await Promise.all([
 pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
 pool.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,location_id::text location_id,photo_url FROM employees WHERE COALESCE(active,true)=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,[locationId])
]);res.json({ok:true,locations:locations.rows,employees:employees.rows})}catch(e:any){console.error("Kiosk context hiba:",e);res.status(500).json({ok:false,error:"kiosk_context_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/config",async(req,res)=>{try{const locationId=clean(req.query.location_id||req.query.locationId),menu=await kioskMenu(locationId);let sections:any[]=[];if(menu?.id){sections=(await pool.query(`SELECT id::text id,title_hu title,COALESCE(subtitle_hu,'') subtitle,COALESCE(image_url,'') image_url,enabled,display_order FROM kiosk_menu_sections WHERE menu_id=$1::uuid ORDER BY display_order,id`,[menu.id])).rows}res.json({ok:true,location_id:locationId||null,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{},updated_at:menu.updated_at}:null,sections})}catch(e:any){res.status(500).json({ok:false,error:"kiosk_config_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/services",async(req,res)=>{try{
 await ensureKioskPublicSchema();
 const language=clean(req.query.lang)||"hu",locationId=clean(req.query.locationId||req.query.location_id),menu=await kioskMenu(locationId);
 if(menu&&!menu.is_active)return res.json({ok:true,language,categories:[],services:[],menu:{id:menu.id,name:menu.name,is_active:false,theme:menu.theme||{}}});
 const menuId=menu?.id||null;
 const r=await pool.query(`
   SELECT s.id::text id,s.name,
          COALESCE(s.description_short,s.description_long,'') description,
          COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
          COALESCE(s.duration_minutes,30)::int duration_minutes,
          COALESCE(km.section_id::text,s.service_type_id::text) category_id,
          COALESCE(km.section_title,st.name,'Egyéb') category_name,
          COALESCE(km.section_subtitle,'') category_subtitle,
          COALESCE(km.section_image,'') category_image,
          COALESCE(km.section_order,999999) section_order,
          COALESCE(km.item_order,999999) item_order,
          COALESCE(km.item_image,'') image_url,
          COALESCE(km.badge_text,'') badge_text,
          COALESCE(km.featured,false) featured,
          COALESCE(NULLIF(km.display_name,''),s.name) display_name
   FROM services s
   LEFT JOIN service_types st ON st.id=s.service_type_id
   LEFT JOIN LATERAL (
     SELECT sec.id section_id,sec.title_hu section_title,sec.subtitle_hu section_subtitle,sec.image_url section_image,
            sec.display_order section_order,mi.display_order item_order,mi.image_url item_image,mi.badge_text,mi.featured,mi.display_name
     FROM kiosk_menu_sections sec
     JOIN kiosk_menu_items mi ON mi.section_id=sec.id
     WHERE sec.menu_id=$2::uuid AND sec.enabled=true AND mi.service_id=s.id AND mi.enabled=true
     ORDER BY sec.display_order,mi.featured DESC,mi.display_order LIMIT 1
   ) km ON $2::uuid IS NOT NULL
   WHERE COALESCE(s.is_active,true)=true
     AND ($1::text='' OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id::text=$1))
     AND ($2::uuid IS NULL OR km.section_id IS NOT NULL)
   ORDER BY section_order,featured DESC,item_order,COALESCE(km.section_title,st.name,'Egyéb'),s.name`,[locationId,menuId]);
 const services=r.rows.map((row:any)=>({
   id:String(row.id),name:row.display_name||row.name,name_hu:row.display_name||row.name,description:row.description??null,
   list_price:Number(row.price||0),base_price:Number(row.price||0),duration_minutes:Number(row.duration_minutes||30),
   category_id:row.category_id,category_name:row.category_name,category_name_hu:row.category_name,
   category_subtitle:row.category_subtitle||"",category_image:row.category_image||"",image_url:row.image_url||"",
   badge_text:row.badge_text||"",featured:Boolean(row.featured)
 }));
 const map=new Map<string,any>();for(const s of services){const id=String(s.category_id||s.category_name||"other");if(!map.has(id))map.set(id,{id,name:s.category_name||"Egyéb",subtitle:s.category_subtitle||"",image_path:s.category_image||null})}
 res.json({ok:true,language,categories:Array.from(map.values()),services,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{}}:null})
 }catch(e:any){console.error("Kiosk services hiba:",e);res.status(500).json({ok:false,error:"kiosk_services_failed",detail:e?.message||String(e)})}});

kioskRouter.post("/workorders",async(req,res)=>{const locationId=clean(req.body?.location_id),employeeId=clean(req.body?.employee_id),clientName=clean(req.body?.client_name),phone=clean(req.body?.phone),email=clean(req.body?.email),note=clean(req.body?.note),paymentMethod=clean(req.body?.payment_method)||"reception",items=Array.isArray(req.body?.items)?req.body.items:[];if(!locationId||!clientName||(!phone&&!email)||!items.length)return res.status(400).json({error:"Telephely, vendégnév, elérhetőség és legalább egy tétel szükséges."});const cx=await pool.connect();try{await cx.query("BEGIN");const loc=await cx.query(`SELECT id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[locationId]);if(!loc.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott szalon nem található."})}
 let client=await cx.query(`SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(name,''),'') client_name,phone,email FROM clients WHERE location_id=$1::uuid AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`,[locationId,phone,email]);let clientId=client.rows[0]?.id;if(!clientId){client=await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,$2,$3,$4::uuid,false,true,'kiosk',now(),now()) RETURNING id`,[clientName,phone||null,email||null,locationId]);clientId=client.rows[0].id}
 if(employeeId){const emp=await cx.query(`SELECT id FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true AND (location_id=$2::uuid OR location_id IS NULL)`,[employeeId,locationId]);if(!emp.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott munkatárs nem található ebben a szalonban."})}}
 const number=(await cx.query(`SELECT next_official_work_order_number(now()) work_order_number`)).rows[0].work_order_number;const sourceSnapshot={source:"kiosk",payment_method:paymentMethod,items,location_id:locationId};const header=await cx.query(`INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot) VALUES('Kiosk rendelés / szolgáltatás',$1,'waiting',$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,false,false,'public-kiosk',now(),$8,now(),$9::jsonb) RETURNING id,work_order_number,status,created_at`,[note||`Kiosk fizetési mód: ${paymentMethod}`,employeeId||null,clientId,clientName,phone||null,email||null,locationId,number,JSON.stringify(sourceSnapshot)]);const workOrderId=header.rows[0].id;
 for(const raw of items){const kind=clean(raw?.kind||raw?.meta?.kind).toLowerCase(),id=clean(raw?.id),quantity=qty(raw?.qty);if(!id)continue;if(kind==="product"){const p=(await cx.query(`SELECT id,name,COALESCE(retail_price_gross,0)::numeric price FROM products WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];if(p){const price=Number(p.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,$5,0,$6)`,[workOrderId,p.id,p.name,quantity,price,quantity*price])}}else if(kind==="service"){const s=(await cx.query(`SELECT id,name,COALESCE(promo_price,list_price,base_price,0)::numeric price,COALESCE(duration_minutes,30)::int duration FROM services WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];if(s){const price=Number(s.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes) VALUES($1,'service',$2,$3,$4,$5,0,$6,$7)`,[workOrderId,s.id,s.name,quantity,price,quantity*price,s.duration])}}else{const unitPrice=Number(raw?.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,0,$5)`,[workOrderId,clean(raw?.title)||"Kiosk tétel",quantity,unitPrice,quantity*unitPrice])}}
 const recalc=(await cx.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;if(recalc)await cx.query(`SELECT recalc_work_order_totals($1::uuid)`,[workOrderId]);await cx.query("COMMIT");res.status(201).json({ok:true,...header.rows[0],source:"kiosk",payment_method:paymentMethod})}catch(e:any){await cx.query("ROLLBACK").catch(()=>undefined);console.error("Kiosk workorder hiba:",e);res.status(500).json({error:"A kiosk munkalap létrehozása sikertelen.",detail:e?.message||String(e)})}finally{cx.release()}});

export default kioskRouter;
