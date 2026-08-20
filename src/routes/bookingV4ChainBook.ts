import { Router } from "express";
import crypto from "crypto";
import db from "../db";
import ensureBookingV4 from "../booking/ensureBookingV4";
import ensureBookingV4Chain from "../booking/ensureBookingV4Chain";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";
import { ensureBookingWorkOrder,ensureBookingWorkOrderSchema } from "../services/bookingWorkOrder";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normCode=(v:unknown)=>String(v||"").trim().toUpperCase();

type ChainItem={service_id:string;employee_id:string;start:string;end:string};

router.use(async(_req,res,next)=>{try{await Promise.all([ensureBookingV4(),ensureBookingV4Chain(),ensureOnlineBooking()]);next()}catch(error:any){res.status(500).json({error:"A Booking 4.0 láncfoglalás inicializálása sikertelen.",detail:error?.message||String(error)})}});

router.post("/v4/chain-book",async(req,res)=>{
  const locationId=String(req.body?.location_id||"").trim();
  const items:Array<ChainItem>=Array.isArray(req.body?.items)?req.body.items.map((x:any)=>({service_id:String(x?.service_id||""),employee_id:String(x?.employee_id||""),start:String(x?.start||""),end:String(x?.end||"")})):[];
  const fullName=String(req.body?.client_name||"").trim(),phone=String(req.body?.phone||"").trim(),email=String(req.body?.email||"").trim();
  if(!UUID_RE.test(locationId)||items.length<2||items.length>6||!fullName||!phone||!email)return res.status(400).json({error:"Telephely, 2–6 láncelem, név, telefonszám és e-mail cím szükséges."});
  if(items.some(x=>!UUID_RE.test(x.service_id)||!UUID_RE.test(x.employee_id)||!Number.isFinite(new Date(x.start).getTime())||!Number.isFinite(new Date(x.end).getTime())||new Date(x.end)<=new Date(x.start)))return res.status(400).json({error:"A foglalási lánc egyik eleme érvénytelen."});
  for(let i=1;i<items.length;i++)if(new Date(items[i].start)<new Date(items[i-1].end))return res.status(400).json({error:"A lánc időpontjai átfedik egymást."});

  const cx=await db.connect();
  try{
    await ensureBookingWorkOrderSchema(cx);
    await cx.query("BEGIN");
    const cfg=(await cx.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId])).rows[0]||{enabled:true,online_discount_percent:5,require_staff_confirmation:true};
    if(cfg.enabled===false){await cx.query("ROLLBACK");return res.status(403).json({error:"Az online foglalás ezen a telephelyen ki van kapcsolva."});}

    const employeeIds=[...new Set(items.map(x=>x.employee_id))].sort();
    for(const employeeId of employeeIds)await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`booking-v4-chain:${locationId}:${employeeId}:${items[0].start.slice(0,10)}`]);

    const resolved:any[]=[];
    for(const item of items){
      const service=(await cx.query(`SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,COALESCE((SELECT p.price FROM booking_service_prices_by_level p JOIN employees e ON e.id=$2::uuid WHERE p.service_id=s.id AND p.staff_level_id=e.booking_staff_level_id AND p.is_active=true AND (p.location_id=$3::uuid OR p.location_id IS NULL) ORDER BY (p.location_id=$3::uuid) DESC,p.updated_at DESC LIMIT 1),s.promo_price,s.list_price,s.base_price,0)::numeric price FROM services s WHERE s.id=$1::uuid AND s.is_active=true AND COALESCE(s.online_bookable,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$3::uuid))`,[item.service_id,item.employee_id,locationId])).rows[0];
      if(!service){await cx.query("ROLLBACK");return res.status(400).json({error:"Egy kiválasztott szolgáltatás ezen a szalonon nem foglalható."});}
      const employee=(await cx.query(`SELECT e.id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name FROM employees e WHERE e.id=$1::uuid AND e.active=true AND (e.location_id=$2::uuid OR e.location_id IS NULL) AND (NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id) OR EXISTS(SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=$3::uuid))`,[item.employee_id,locationId,item.service_id])).rows[0];
      if(!employee){await cx.query("ROLLBACK");return res.status(400).json({error:"Egy kiválasztott szakember nem jogosult a szolgáltatásra."});}
      const expectedEnd=new Date(new Date(item.start).getTime()+Number(service.duration_minutes||30)*60000);
      if(Math.abs(expectedEnd.getTime()-new Date(item.end).getTime())>60000){await cx.query("ROLLBACK");return res.status(409).json({error:`A(z) ${service.name} időtartama időközben megváltozott. Kérj új időpontláncot.`});}
      const conflict=(await cx.query(`SELECT 1 FROM appointments WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$3::timestamptz AND end_time>$2::timestamptz UNION ALL SELECT 1 FROM appointment_technical_breaks WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[item.employee_id,item.start,item.end])).rowCount;
      if(conflict){await cx.query("ROLLBACK");return res.status(409).json({error:`${employee.full_name} egyik időpontja időközben foglalttá vált. Kérj új láncot.`});}
      resolved.push({...item,service,employee});
    }

    let client=(await cx.query(`SELECT id FROM clients WHERE location_id=$1::uuid AND (regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g') OR lower(COALESCE(email,''))=lower($3)) ORDER BY updated_at DESC NULLS LAST LIMIT 1`,[locationId,phone,email])).rows[0];
    if(!client)client=(await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,$2,$3,$4::uuid,$5,true,'online',now(),now()) RETURNING id`,[fullName,phone,email,locationId,Boolean(req.body?.marketing_consent)])).rows[0];
    else await cx.query(`UPDATE clients SET full_name=$2,name=$2,phone=$3,email=$4,updated_at=now() WHERE id=$1::uuid`,[client.id,fullName,phone,email]);

    const baseSubtotal=resolved.reduce((sum,x)=>sum+Number(x.service.price||0),0);
    let coupon:any=null,couponDiscount=0;
    const couponCode=normCode(req.body?.coupon_code);
    if(couponCode){
      const serviceIds=resolved.map(x=>x.service.id);
      coupon=(await cx.query(`SELECT c.*,(NOT EXISTS(SELECT 1 FROM booking_coupon_locations cl WHERE cl.coupon_id=c.id) OR EXISTS(SELECT 1 FROM booking_coupon_locations cl WHERE cl.coupon_id=c.id AND cl.location_id=$2::uuid)) location_ok,(NOT EXISTS(SELECT 1 FROM booking_coupon_services cs WHERE cs.coupon_id=c.id) OR EXISTS(SELECT 1 FROM booking_coupon_services cs WHERE cs.coupon_id=c.id AND cs.service_id=ANY($3::uuid[]))) service_ok,(SELECT count(*)::int FROM booking_coupon_redemptions r WHERE r.coupon_id=c.id) total_uses,(SELECT count(*)::int FROM booking_coupon_redemptions r WHERE r.coupon_id=c.id AND r.client_id=$4::uuid) customer_uses FROM booking_coupon_campaigns c WHERE upper(c.code)=upper($1) AND c.is_active=true AND (c.valid_from IS NULL OR c.valid_from<=now()) AND (c.valid_until IS NULL OR c.valid_until>=now()) LIMIT 1 FOR UPDATE`,[couponCode,locationId,serviceIds,client.id])).rows[0];
      if(!coupon||!coupon.location_ok||!coupon.service_ok){await cx.query("ROLLBACK");return res.status(400).json({error:"A kupon erre a foglalási láncra nem használható."});}
      if(coupon.max_total_uses!=null&&Number(coupon.total_uses)>=Number(coupon.max_total_uses)){await cx.query("ROLLBACK");return res.status(409).json({error:"A kupon felhasználási kerete elfogyott."});}
      if(coupon.max_uses_per_customer!=null&&Number(coupon.customer_uses)>=Number(coupon.max_uses_per_customer)){await cx.query("ROLLBACK");return res.status(409).json({error:"A kupont már a megengedett alkalommal felhasználtad."});}
      if(coupon.minimum_booking_value!=null&&baseSubtotal<Number(coupon.minimum_booking_value)){await cx.query("ROLLBACK");return res.status(400).json({error:`A kupon minimum ${Number(coupon.minimum_booking_value).toLocaleString('hu-HU')} Ft foglalási értéktől érvényes.`});}
      couponDiscount=Math.min(baseSubtotal,coupon.discount_type==='percent'?baseSubtotal*Number(coupon.discount_value)/100:Number(coupon.discount_value));
    }

    const totalGap=resolved.slice(1).reduce((sum,x,i)=>sum+Math.max(0,Math.round((+new Date(x.start)-+new Date(resolved[i].end))/60000)),0);
    const chain=(await cx.query(`INSERT INTO booking_chains(location_id,client_id,start_time,end_time,total_gap_minutes,booking_source) VALUES($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5,'online') RETURNING id`,[locationId,client.id,resolved[0].start,resolved[resolved.length-1].end,totalGap])).rows[0];
    const status=cfg.require_staff_confirmation?'pending':'confirmed',appointments:any[]=[];
    const couponExtraPercent=baseSubtotal>0?couponDiscount/baseSubtotal*100:0;
    for(let i=0;i<resolved.length;i++){
      const x=resolved[i],token=crypto.randomUUID();
      const ap=(await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,cancellation_token,confirmation_required,confirmed_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,$7,$8,'online',$9::uuid,$10,$11,now()) RETURNING id`,[x.employee_id,client.id,locationId,x.service.name,x.start,x.end,status,`Booking 4.0 lánc: ${chain.id}`,token,Boolean(cfg.require_staff_confirmation),cfg.require_staff_confirmation?null:new Date().toISOString()])).rows[0];
      const discount=Math.min(100,Math.max(0,100-(100-Number(cfg.online_discount_percent||0))*(1-couponExtraPercent/100)));
      await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order) VALUES($1::uuid,$2::uuid,$3,$4,$5,0)`,[ap.id,x.service.id,x.service.duration_minutes,x.service.price,discount]);
      await cx.query(`INSERT INTO booking_chain_items(chain_id,appointment_id,sequence_no,service_id,employee_id,start_time,end_time) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::timestamptz,$7::timestamptz)`,[chain.id,ap.id,i,x.service.id,x.employee_id,x.start,x.end]);
      await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'booking_v4_chain_created','public',$2::jsonb,'Booking 4.0 több szakemberes láncfoglalás')`,[ap.id,JSON.stringify({chain_id:chain.id,sequence_no:i,employee_id:x.employee_id,service_id:x.service.id,start_time:x.start,end_time:x.end})]);
      if(Boolean(req.body?.booking_for_other))await cx.query(`INSERT INTO booking_guest_beneficiaries(appointment_id,booked_for_other,guest_name,guest_phone,guest_email,relationship_label) VALUES($1::uuid,true,$2,$3,$4,$5) ON CONFLICT(appointment_id) DO UPDATE SET booked_for_other=true,guest_name=EXCLUDED.guest_name,guest_phone=EXCLUDED.guest_phone,guest_email=EXCLUDED.guest_email,relationship_label=EXCLUDED.relationship_label,updated_at=now()`,[ap.id,String(req.body?.guest_name||'').trim()||null,String(req.body?.guest_phone||'').trim()||null,String(req.body?.guest_email||'').trim()||null,String(req.body?.relationship_label||'').trim()||null]);
      appointments.push({id:ap.id,service_id:x.service.id,service_name:x.service.name,employee_id:x.employee_id,employee_name:x.employee.full_name,start:x.start,end:x.end,cancellation_token:token});
    }
    if(coupon&&appointments[0])await cx.query(`INSERT INTO booking_coupon_redemptions(coupon_id,appointment_id,client_id,discount_amount) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,[coupon.id,appointments[0].id,client.id,couponDiscount]);
    if(appointments[0])await cx.query(`INSERT INTO booking_marketing_consents(appointment_id,email,phone,channel,consented,consented_at) VALUES($1::uuid,$2,$3,'email',$4,CASE WHEN $4 THEN now() ELSE NULL END)`,[appointments[0].id,email,phone,Boolean(req.body?.marketing_consent)]);
    await cx.query("COMMIT");

    for(const ap of appointments){try{await cx.query("BEGIN");const wo=await ensureBookingWorkOrder(cx,String(ap.id),"public");await cx.query("COMMIT");ap.work_order_id=wo.work_order_id;ap.work_order_number=wo.work_order_number;}catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);console.error('[booking-v4-chain] work order deferred',{appointment_id:ap.id,error:error?.message||String(error)});}}
    res.status(201).json({ok:true,chain_id:chain.id,status,appointments,total_gap_minutes:totalGap,coupon_code:coupon?.code||null,coupon_discount_amount:Math.round(couponDiscount),final_total:Math.max(0,Math.round(baseSubtotal*(1-Number(cfg.online_discount_percent||0)/100)-couponDiscount))});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);res.status(500).json({error:"A több szakemberes foglalási lánc mentése sikertelen.",detail:error?.message||String(error)});}finally{cx.release();}
});

export default router;
