import { Router } from "express";
import { pool } from "../db";

export const kioskRouter = Router();
const clean=(v:unknown)=>String(v??"").trim();
const qty=(v:unknown)=>Math.max(1,Math.min(99,Number(v)||1));

async function kioskMenu(locationId:string){
 if(!locationId)return null;
 try{return (await pool.query(`SELECT id::text id,name,theme,is_active,updated_at FROM kiosk_menus WHERE location_id=$1::uuid ORDER BY is_active DESC,updated_at DESC LIMIT 1`,[locationId])).rows[0]||null}catch{return null}
}

kioskRouter.get("/context",async(req,res)=>{try{const locationId=clean(req.query.location_id||req.query.locationId);const[locations,employees]=await Promise.all([
 pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
 pool.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,location_id::text location_id,photo_url FROM employees WHERE COALESCE(active,true)=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,[locationId])
]);res.json({ok:true,locations:locations.rows,employees:employees.rows})}catch(e:any){console.error("Kiosk context hiba:",e);res.status(500).json({ok:false,error:"kiosk_context_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/config",async(req,res)=>{try{const locationId=clean(req.query.location_id||req.query.locationId),menu=await kioskMenu(locationId);res.json({ok:true,location_id:locationId||null,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{},updated_at:menu.updated_at}:null})}catch(e:any){res.status(500).json({ok:false,error:"kiosk_config_failed",detail:e?.message||String(e)})}});

kioskRouter.get("/services",async(req,res)=>{try{
 const language=clean(req.query.lang)||"hu",locationId=clean(req.query.locationId||req.query.location_id),menu=await kioskMenu(locationId);
 if(menu&&!menu.is_active)return res.json({ok:true,language,categories:[],services:[],menu:{id:menu.id,name:menu.name,is_active:false,theme:menu.theme||{}}});
 const menuId=menu?.id||null;
 const r=await pool.query(`
   SELECT s.id::text id,s.name,s.description,
          COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
          COALESCE(s.duration_minutes,30)::int duration_minutes,
          COALESCE(km.section_id::text,s.service_type_id::text) category_id,
          COALESCE(km.section_title,st.name,'Egyéb') category_name,
          COALESCE(km.section_order,999999) section_order,
          COALESCE(km.item_order,999999) item_order
   FROM services s
   LEFT JOIN service_types st ON st.id=s.service_type_id
   LEFT JOIN LATERAL (
     SELECT sec.id section_id,sec.title_hu section_title,sec.display_order section_order,mi.display_order item_order
     FROM kiosk_menu_sections sec
     JOIN kiosk_menu_items mi ON mi.section_id=sec.id
     WHERE sec.menu_id=$2::uuid AND mi.service_id=s.id AND mi.enabled=true
     ORDER BY sec.display_order,mi.display_order LIMIT 1
   ) km ON $2::uuid IS NOT NULL
   WHERE COALESCE(s.is_active,true)=true
     AND ($1::text='' OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id::text=$1))
     AND ($2::uuid IS NULL OR km.section_id IS NOT NULL)
   ORDER BY section_order,item_order,COALESCE(km.section_title,st.name,'Egyéb'),s.name`,[locationId,menuId]);
 const services=r.rows.map((row:any)=>({id:String(row.id),name:row.name,name_hu:row.name,description:row.description??null,list_price:Number(row.price||0),base_price:Number(row.price||0),duration_minutes:Number(row.duration_minutes||30),category_id:row.category_id,category_name:row.category_name,category_name_hu:row.category_name}));
 const map=new Map<string,any>();for(const s of services){const id=String(s.category_id||s.category_name||"other");if(!map.has(id))map.set(id,{id,name:s.category_name||"Egyéb",image_path:null})}
 res.json({ok:true,language,categories:Array.from(map.values()),services,menu:menu?{id:menu.id,name:menu.name,is_active:Boolean(menu.is_active),theme:menu.theme||{}}:null})
 }catch(e:any){console.error("Kiosk services hiba:",e);res.status(500).json({ok:false,error:"kiosk_services_failed",detail:e?.message||String(e)})}});

kioskRouter.post("/workorders",async(req,res)=>{const locationId=clean(req.body?.location_id),employeeId=clean(req.body?.employee_id),clientName=clean(req.body?.client_name),phone=clean(req.body?.phone),email=clean(req.body?.email),note=clean(req.body?.note),paymentMethod=clean(req.body?.payment_method)||"reception",items=Array.isArray(req.body?.items)?req.body.items:[];if(!locationId||!clientName||(!phone&&!email)||!items.length)return res.status(400).json({error:"Telephely, vendégnév, elérhetőség és legalább egy tétel szükséges."});const cx=await pool.connect();try{await cx.query("BEGIN");const loc=await cx.query(`SELECT id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[locationId]);if(!loc.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott szalon nem található."})}
 let client=await cx.query(`SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(name,''),'') client_name,phone,email FROM clients WHERE location_id=$1::uuid AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`,[locationId,phone,email]);let clientId=client.rows[0]?.id;if(!clientId){client=await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,$2,$3,$4::uuid,false,true,'kiosk',now(),now()) RETURNING id`,[clientName,phone||null,email||null,locationId]);clientId=client.rows[0].id}
 if(employeeId){const emp=await cx.query(`SELECT id FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true`,[employeeId]);if(!emp.rows[0]){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott munkatárs nem található."})}}
 const number=(await cx.query(`SELECT next_official_work_order_number(now()) work_order_number`)).rows[0].work_order_number;const sourceSnapshot={source:"kiosk",payment_method:paymentMethod,items,location_id:locationId};const header=await cx.query(`INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot) VALUES('Kiosk rendelés / szolgáltatás',$1,'waiting',$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,false,false,'public-kiosk',now(),$8,now(),$9::jsonb) RETURNING id,work_order_number,status,created_at`,[note||`Kiosk fizetési mód: ${paymentMethod}`,employeeId||null,clientId,clientName,phone||null,email||null,locationId,number,JSON.stringify(sourceSnapshot)]);const workOrderId=header.rows[0].id;
 for(const raw of items){const kind=clean(raw?.kind||raw?.meta?.kind).toLowerCase(),id=clean(raw?.id),quantity=qty(raw?.qty);if(!id)continue;if(kind==="product"){const p=(await cx.query(`SELECT id,name,COALESCE(retail_price_gross,0)::numeric price FROM products WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];if(p){const price=Number(p.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,$5,0,$6)`,[workOrderId,p.id,p.name,quantity,price,quantity*price])}}else if(kind==="service"){const s=(await cx.query(`SELECT id,name,COALESCE(promo_price,list_price,base_price,0)::numeric price,COALESCE(duration_minutes,30)::int duration FROM services WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];if(s){const price=Number(s.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes) VALUES($1,'service',$2,$3,$4,$5,0,$6,$7)`,[workOrderId,s.id,s.name,quantity,price,quantity*price,s.duration])}}else{const unitPrice=Number(raw?.price||0);await cx.query(`INSERT INTO work_order_items(work_order_id,item_type,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,0,$5)`,[workOrderId,clean(raw?.title)||"Kiosk tétel",quantity,unitPrice,quantity*unitPrice])}}
 const recalc=(await cx.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;if(recalc)await cx.query(`SELECT recalc_work_order_totals($1::uuid)`,[workOrderId]);await cx.query("COMMIT");res.status(201).json({ok:true,...header.rows[0],source:"kiosk",payment_method:paymentMethod})}catch(e:any){await cx.query("ROLLBACK").catch(()=>undefined);console.error("Kiosk workorder hiba:",e);res.status(500).json({error:"A kiosk munkalap létrehozása sikertelen.",detail:e?.message||String(e)})}finally{cx.release()}});

export default kioskRouter;
