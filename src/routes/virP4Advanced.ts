import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";

const router=Router();
router.use(requireManagement);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const n=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));

type Scope={tenantId:string;locationId:string|null};
async function scope(req:AuthRequest,res:Response):Promise<Scope|undefined>{
 const tenantId=String(req.user?.tenant_id||"").trim();
 if(!tenantId){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return;}
 const locationId=String(req.query.locationId||req.query.location_id||"").trim()||null;
 if(!locationId)return{tenantId,locationId:null};
 if(!UUID.test(locationId)){res.status(400).json({ok:false,error:"Érvénytelen telephelyazonosító."});return;}
 const owned=(await pool.query(`SELECT id FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`,[locationId,tenantId])).rows[0];
 if(!owned){res.status(403).json({ok:false,error:"A telephely nem tartozik a tenantjához."});return;}
 return{tenantId,locationId};
}

router.get("/smart-shift-generator",async(req:AuthRequest,res:Response)=>{
 try{
  const s=await scope(req,res);if(!s)return;const days=clamp(Math.round(n(req.query.days)||14),7,30);
  const rows=(await pool.query(`
   WITH dates AS (SELECT d::date day FROM generate_series(current_date,current_date+($3::int-1),interval '1 day') d),
   locs AS (SELECT id,name FROM locations WHERE tenant_id=$1::uuid AND active IS DISTINCT FROM false AND ($2::uuid IS NULL OR id=$2::uuid)),
   hist AS (SELECT a.location_id,EXTRACT(ISODOW FROM a.start_time)::int dow,COALESCE(SUM(EXTRACT(EPOCH FROM(a.end_time-a.start_time))/60.0),0)/GREATEST(COUNT(DISTINCT a.start_time::date),1) avg_minutes FROM appointments a WHERE a.tenant_id=$1::uuid AND a.start_time>=now()-interval '56 days' AND a.start_time<now() AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show') GROUP BY 1,2),
   booked AS (SELECT a.location_id,a.start_time::date day,COALESCE(SUM(EXTRACT(EPOCH FROM(a.end_time-a.start_time))/60.0),0) booked_minutes FROM appointments a WHERE a.tenant_id=$1::uuid AND a.start_time>=current_date AND a.start_time<current_date+$3::int AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show') GROUP BY 1,2),
   shifts AS (SELECT e.location_id,ws.work_date::date day,COUNT(DISTINCT ws.employee_id)::int staff_count,COALESCE(SUM(EXTRACT(EPOCH FROM(ws.ends_at-ws.starts_at))/60.0),0) staff_minutes FROM work_shifts ws JOIN employees e ON e.id=ws.employee_id WHERE e.tenant_id=$1::uuid AND COALESCE(e.active,true)=true AND ws.status='published' AND ws.work_date>=current_date AND ws.work_date<current_date+$3::int GROUP BY 1,2)
   SELECT l.id::text location_id,l.name location_name,d.day,COALESCE(b.booked_minutes,0) booked_minutes,COALESCE(h.avg_minutes,0) historical_minutes,COALESCE(sh.staff_count,0)::int staff_count,COALESCE(sh.staff_minutes,0) staff_minutes
   FROM locs l CROSS JOIN dates d LEFT JOIN hist h ON h.location_id=l.id AND h.dow=EXTRACT(ISODOW FROM d.day)::int LEFT JOIN booked b ON b.location_id=l.id AND b.day=d.day LEFT JOIN shifts sh ON sh.location_id=l.id AND sh.day=d.day ORDER BY l.name,d.day`,[s.tenantId,s.locationId,days])).rows;
  const proposals:any[]=[];
  for(const r of rows){const demand=Math.max(n(r.booked_minutes),n(r.historical_minutes));const required=demand>0?Math.max(1,Math.ceil(demand/(480*0.8))):0;const gap=required-n(r.staff_count);if(gap<=0)continue;
   const candidates=(await pool.query(`SELECT e.id::text employee_id,COALESCE(NULLIF(e.full_name,''),concat_ws(' ',e.last_name,e.first_name),'Munkatárs') employee_name,COUNT(o.service_id) FILTER(WHERE COALESCE(o.can_perform,true)=true AND (o.qualification_valid_until IS NULL OR o.qualification_valid_until>=$3::date))::int active_skills FROM employees e LEFT JOIN employee_service_overrides o ON o.employee_id=e.id WHERE e.tenant_id=$1::uuid AND e.location_id=$2::uuid AND COALESCE(e.active,true)=true AND NOT EXISTS(SELECT 1 FROM work_shifts ws WHERE ws.employee_id=e.id AND ws.work_date=$3::date AND ws.status='published') GROUP BY e.id,e.full_name,e.last_name,e.first_name ORDER BY active_skills DESC,employee_name LIMIT $4`,[s.tenantId,r.location_id,r.day,Math.min(8,gap*3)])).rows;
   proposals.push({location_id:r.location_id,location_name:r.location_name,day:r.day,required_staff:required,scheduled_staff:n(r.staff_count),staff_gap:gap,demand_minutes:Math.round(demand),suggested_shift:{start_local:"09:00",end_local:"17:00",paid_minutes:480},candidates,approval_required:true,automatic_write:false,rationale:`${gap} főnyi becsült kapacitáshiány; csak olyan aktív munkatársak szerepelnek, akiknek nincs publikált műszakjuk ezen a napon.`});
  }
  res.json({ok:true,model:"human_approval_shift_proposal_v1",days,automatic_scheduling:false,approval_required:true,summary:{proposal_days:proposals.length,total_staff_gap:proposals.reduce((a,x)=>a+x.staff_gap,0)},proposals});
 }catch(e:any){res.status(500).json({ok:false,error:e?.message||"smart_shift_generator_failed"});}
});

router.get("/employee-revenue-coach",async(req:AuthRequest,res:Response)=>{
 try{const s=await scope(req,res);if(!s)return;const days=clamp(Math.round(n(req.query.days)||30),14,90);
  const rows=(await pool.query(`SELECT e.id::text employee_id,COALESCE(NULLIF(e.full_name,''),concat_ws(' ',e.last_name,e.first_name),'Munkatárs') employee_name,l.id::text location_id,l.name location_name,COUNT(DISTINCT a.id)::int appointments,COUNT(DISTINCT a.client_id)::int unique_clients,COUNT(DISTINCT a.client_id) FILTER(WHERE EXISTS(SELECT 1 FROM appointments f WHERE f.client_id=a.client_id AND f.employee_id=e.id AND f.start_time>a.start_time AND f.start_time<=a.start_time+interval '90 days'))::int rebooked_clients,COALESCE(SUM(COALESCE(aps.price,0)),0) revenue,COALESCE(AVG(COALESCE(aps.price,0)),0) avg_service_value,COALESCE(SUM(EXTRACT(EPOCH FROM(a.end_time-a.start_time))/60.0),0) booked_minutes FROM employees e JOIN locations l ON l.id=e.location_id LEFT JOIN appointments a ON a.employee_id=e.id AND a.tenant_id=$1::uuid AND a.start_time>=current_date-$3::int AND a.start_time<current_date+1 AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show') LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE e.tenant_id=$1::uuid AND COALESCE(e.active,true)=true AND ($2::uuid IS NULL OR e.location_id=$2::uuid) GROUP BY e.id,e.full_name,e.last_name,e.first_name,l.id,l.name ORDER BY revenue DESC`,[s.tenantId,s.locationId,days])).rows;
  const items=rows.map((r:any)=>{const ap=n(r.appointments),clients=n(r.unique_clients),re=n(r.rebooked_clients),rev=n(r.revenue);const rebookRate=clients?Math.round(re/clients*100):0;const hourly=n(r.booked_minutes)?Math.round(rev/(n(r.booked_minutes)/60)):0;const score=clamp(Math.round(rebookRate*.45+Math.min(100,hourly/150)*.35+Math.min(100,ap/Math.max(1,days)*700)*.2),0,100);const actions:string[]=[];if(rebookRate<45)actions.push("Növeld a következő időpont helyben történő visszafoglalását.");if(hourly<12000)actions.push("Vizsgáld meg a szolgáltatásmixet és az upsell/cross-sell lehetőségeket.");if(ap<days*.4)actions.push("Alacsony kihasználtság: kapacitásfeltöltő kampány vagy műszakfinomítás javasolt.");if(!actions.length)actions.push("Stabil teljesítmény; fókusz a megtartás és magas értékű szolgáltatásmix fenntartásán.");return{...r,appointments:ap,unique_clients:clients,rebook_rate_percent:rebookRate,revenue:Math.round(rev),avg_service_value:Math.round(n(r.avg_service_value)),revenue_per_booked_hour:hourly,coach_score:score,recommendations:actions};});
  res.json({ok:true,model:"non_punitive_employee_revenue_coach_v1",days,non_punitive:true,no_automatic_hr_action:true,items});
 }catch(e:any){res.status(500).json({ok:false,error:e?.message||"employee_revenue_coach_failed"});}
});

router.get("/service-portfolio",async(req:AuthRequest,res:Response)=>{
 try{const s=await scope(req,res);if(!s)return;const days=clamp(Math.round(n(req.query.days)||90),30,180);
  const rows=(await pool.query(`SELECT s.id::text service_id,s.name service_name,COUNT(DISTINCT a.id)::int bookings,COUNT(DISTINCT a.client_id)::int clients,COALESCE(SUM(COALESCE(aps.price,s.base_price,0)),0) revenue,COALESCE(AVG(EXTRACT(EPOCH FROM(a.end_time-a.start_time))/60.0),COALESCE(s.duration_minutes,s.base_duration_minutes,30)) avg_minutes,COALESCE(AVG(COALESCE(aps.price,s.base_price,0)),0) avg_price FROM services s LEFT JOIN appointment_services aps ON aps.service_id=s.id LEFT JOIN appointments a ON a.id=aps.appointment_id AND a.tenant_id=$1::uuid AND a.start_time>=current_date-$3::int AND a.start_time<current_date+1 AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show') WHERE COALESCE(s.is_active,true)=true AND ($2::uuid IS NULL OR a.location_id=$2::uuid OR a.id IS NULL) GROUP BY s.id,s.name,s.duration_minutes,s.base_duration_minutes ORDER BY revenue DESC`,[s.tenantId,s.locationId,days])).rows;
  const items=rows.map((r:any)=>{const bookings=n(r.bookings),rev=n(r.revenue),mins=Math.max(1,n(r.avg_minutes));const revPerHour=Math.round(n(r.avg_price)/(mins/60));let action="HOLD";if(bookings>=Math.max(8,days/6)&&revPerHour>=18000)action="GROW";else if(bookings>=Math.max(8,days/6)&&revPerHour<12000)action="REPRICE";else if(bookings<=Math.max(2,days/45))action="REVIEW";return{...r,bookings,revenue:Math.round(rev),avg_minutes:Math.round(mins),avg_price:Math.round(n(r.avg_price)),revenue_per_hour:revPerHour,recommendation:action,rationale:action==="GROW"?"Erős kereslet és magas időarányos árbevétel.":action==="REPRICE"?"Van kereslet, de az időarányos bevétel gyenge.":action==="REVIEW"?"Alacsony kereslet; tartalom, ár, láthatóság vagy kivezetés vizsgálata indokolt.":"Kiegyensúlyozott portfólióelem."};});
  res.json({ok:true,model:"demand_value_service_portfolio_v1",days,automatic_catalog_changes:false,items,summary:{grow:items.filter(x=>x.recommendation==="GROW").length,reprice:items.filter(x=>x.recommendation==="REPRICE").length,review:items.filter(x=>x.recommendation==="REVIEW").length}});
 }catch(e:any){res.status(500).json({ok:false,error:e?.message||"service_portfolio_failed"});}
});

router.get("/cannibalization",async(req:AuthRequest,res:Response)=>{
 try{const s=await scope(req,res);if(!s)return;const days=clamp(Math.round(n(req.query.days)||90),30,180);
  const rows=(await pool.query(`WITH recent AS (SELECT a.client_id,a.location_id,MIN(a.start_time) first_visit,COUNT(*)::int visits,COALESCE(SUM(COALESCE(aps.price,0)),0) revenue FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE a.tenant_id=$1::uuid AND a.client_id IS NOT NULL AND a.start_time>=current_date-$2::int AND a.start_time<current_date+1 AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show') GROUP BY 1,2),pairs AS (SELECT r2.location_id destination_id,r1.location_id source_id,COUNT(DISTINCT r2.client_id)::int shared_clients,COALESCE(SUM(r2.revenue),0) destination_revenue FROM recent r2 JOIN recent r1 ON r1.client_id=r2.client_id AND r1.location_id<>r2.location_id WHERE r1.first_visit<r2.first_visit GROUP BY 1,2) SELECT p.source_id::text,p.destination_id::text,ls.name source_name,ld.name destination_name,p.shared_clients,p.destination_revenue FROM pairs p JOIN locations ls ON ls.id=p.source_id JOIN locations ld ON ld.id=p.destination_id WHERE ls.tenant_id=$1::uuid AND ld.tenant_id=$1::uuid AND ($3::uuid IS NULL OR p.source_id=$3::uuid OR p.destination_id=$3::uuid) ORDER BY p.shared_clients DESC,p.destination_revenue DESC`,[s.tenantId,days,s.locationId])).rows;
  const items=rows.map((r:any)=>({source_location_id:r.source_id,source_location_name:r.source_name,destination_location_id:r.destination_id,destination_location_name:r.destination_name,shared_clients:n(r.shared_clients),destination_revenue:Math.round(n(r.destination_revenue)),signal:n(r.shared_clients)>=10?"HIGH":n(r.shared_clients)>=4?"MEDIUM":"LOW",interpretation:"Átfedő vendégmozgás-jelzés; nem bizonyítja önmagában a kannibalizációt. Kampány-, nyitási és hálózati növekedési kontextussal együtt értelmezendő."}));
  res.json({ok:true,model:"cross_location_client_flow_signal_v1",days,causality_claim:false,items});
 }catch(e:any){res.status(500).json({ok:false,error:e?.message||"cannibalization_failed"});}
});

export default router;
