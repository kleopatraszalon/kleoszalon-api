import { Router } from "express";
import db from "../db";
import ensureBookingV4 from "../booking/ensureBookingV4";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asIds=(v:unknown)=>Array.isArray(v)?v.map(String).filter(Boolean):String(v||"").split(",").map(x=>x.trim()).filter(Boolean);
const add=(d:Date,m:number)=>new Date(d.getTime()+m*60000);

router.use(async(_req,res,next)=>{try{await Promise.all([ensureBookingV4(),ensureOnlineBooking()]);next()}catch(error:any){res.status(500).json({error:"A Booking 4.0 Phase 2 inicializálása sikertelen.",detail:error?.message||String(error)})}});

router.get("/v4/chain-availability",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim();
    const date=String(req.query.date||"").trim();
    const serviceIds=asIds(req.query.service_ids);
    const maxGap=Math.min(240,Math.max(0,Number(req.query.max_gap_minutes||90)));
    if(!UUID_RE.test(locationId)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!serviceIds.length||serviceIds.length>6||serviceIds.some(id=>!UUID_RE.test(id)))return res.status(400).json({error:"Érvényes location_id, date és 1–6 service_ids szükséges."});

    const svc=(await db.query(`SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes FROM services s WHERE s.id=ANY($1::uuid[]) AND s.is_active=true AND COALESCE(s.online_bookable,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$2::uuid))`,[serviceIds,locationId])).rows;
    if(svc.length!==new Set(serviceIds).size)return res.status(400).json({error:"Egy vagy több szolgáltatás ezen a telephelyen nem foglalható."});
    const byId=new Map(svc.map((x:any)=>[String(x.id),x]));

    const cfg=(await db.query(`SELECT opening_minute,closing_minute,slot_interval_minutes,minimum_notice_minutes,booking_horizon_days,enabled FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId])).rows[0]||{};
    if(cfg.enabled===false)return res.status(403).json({error:"Az online foglalás ezen a telephelyen ki van kapcsolva."});
    const base=new Date(`${date}T00:00:00`);
    const from=add(base,Number(cfg.opening_minute??480));
    const to=add(base,Number(cfg.closing_minute??1200));
    const notice=new Date(Date.now()+Number(cfg.minimum_notice_minutes??60)*60000);
    const step=Math.max(5,Number(cfg.slot_interval_minutes??15));
    const horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days??60));
    if(from>horizon)return res.json({service_ids:serviceIds,max_gap_minutes:maxGap,chains:[]});

    const empByService=new Map<string,any[]>();
    const allEmp=new Map<string,any>();
    for(const serviceId of serviceIds){
      const rows=(await db.query(`SELECT e.id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name,e.photo_url,lvl.code staff_level_code,lvl.name staff_level_name FROM employees e LEFT JOIN booking_staff_levels lvl ON lvl.id=e.booking_staff_level_id WHERE e.active=true AND (e.location_id=$1::uuid OR e.location_id IS NULL) AND (NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id) OR EXISTS(SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=$2::uuid)) ORDER BY e.is_top_specialist DESC,full_name`,[locationId,serviceId])).rows;
      empByService.set(serviceId,rows);rows.forEach((x:any)=>allEmp.set(String(x.id),x));
    }
    const employeeIds=[...allEmp.keys()];
    if(!employeeIds.length)return res.json({service_ids:serviceIds,max_gap_minutes:maxGap,chains:[]});

    const busy=(await db.query(`SELECT employee_id,start_time,end_time FROM appointments WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz UNION ALL SELECT employee_id,start_time,end_time FROM appointment_technical_breaks WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,[locationId,employeeIds,from.toISOString(),to.toISOString()])).rows;
    const candidatesByService=new Map<string,any[]>();
    for(const serviceId of serviceIds){
      const service:any=byId.get(serviceId),candidates:any[]=[];
      for(const employee of empByService.get(serviceId)||[]){
        const blocks=busy.filter((b:any)=>String(b.employee_id)===String(employee.id));
        for(let cursor=new Date(from);cursor<to;cursor=add(cursor,step)){
          const end=add(cursor,Number(service.duration_minutes||30));
          if(end>to||cursor<notice)continue;
          if(blocks.some((b:any)=>new Date(b.start_time)<end&&new Date(b.end_time)>cursor))continue;
          candidates.push({service_id:serviceId,service_name:service.name,duration_minutes:Number(service.duration_minutes||30),employee_id:employee.id,employee_name:employee.full_name,photo_url:employee.photo_url,staff_level_code:employee.staff_level_code,staff_level_name:employee.staff_level_name,start:cursor.toISOString(),end:end.toISOString()});
        }
      }
      candidates.sort((a,b)=>+new Date(a.start)-+new Date(b.start));
      candidatesByService.set(serviceId,candidates.slice(0,240));
    }

    let beam=(candidatesByService.get(serviceIds[0])||[]).slice(0,80).map(item=>({items:[item],gap_minutes:0,start:item.start,end:item.end}));
    for(let i=1;i<serviceIds.length&&beam.length;i++){
      const next=candidatesByService.get(serviceIds[i])||[],expanded:any[]=[];
      for(const chain of beam){
        const prevEnd=+new Date(chain.end);
        for(const cand of next){
          const start=+new Date(cand.start);if(start<prevEnd)continue;
          const gap=(start-prevEnd)/60000;if(gap>maxGap)break;
          expanded.push({items:[...chain.items,cand],gap_minutes:chain.gap_minutes+gap,start:chain.start,end:cand.end});
        }
      }
      expanded.sort((a,b)=>a.gap_minutes-b.gap_minutes||(+new Date(a.end)-+new Date(a.start))-(+new Date(b.end)-+new Date(b.start)));
      beam=expanded.slice(0,80);
    }
    res.json({service_ids:serviceIds,max_gap_minutes:maxGap,chains:beam.slice(0,30).map((c:any)=>({...c,total_duration_minutes:Math.round((+new Date(c.end)-+new Date(c.start))/60000)}))});
  }catch(error:any){res.status(500).json({error:"A több szakemberes időpontlánc keresése sikertelen.",detail:error?.message||String(error)});}
});

export default router;
