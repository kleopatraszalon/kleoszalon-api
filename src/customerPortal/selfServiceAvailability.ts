import db from "../db";
import { ensureOnlineBooking } from "../booking/ensureOnlineBooking";

const addMinutes=(date:Date,minutes:number)=>new Date(date.getTime()+minutes*60000);

type AvailabilityResult={
  status:number;
  body:any;
};

type Interval={from:Date;to:Date};

async function hasWorkShifts(){
  return Boolean((await db.query(`SELECT to_regclass('public.work_shifts') IS NOT NULL ok`)).rows[0]?.ok);
}

export async function getCustomerAppointmentAvailability(
  appointmentId:string,
  clientId:string,
  date:string,
  requestedEmployeeId:string|null,
):Promise<AvailabilityResult>{
  await ensureOnlineBooking();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return{status:400,body:{error:"Érvényes date (YYYY-MM-DD) kötelező."}};

  const appointment=(await db.query(`
    SELECT a.id::text,a.location_id::text,a.employee_id::text,a.status,
           COALESCE(array_agg(aps.service_id::text ORDER BY aps.sort_order) FILTER(WHERE aps.service_id IS NOT NULL),'{}'::text[]) service_ids,
           COALESCE(sum(COALESCE(aps.duration_minutes,s.duration_minutes,30)),0)::int duration_minutes
      FROM appointments a
      LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
      LEFT JOIN services s ON s.id=aps.service_id
     WHERE a.id=$1::uuid AND a.client_id=$2::uuid
     GROUP BY a.id,a.location_id,a.employee_id,a.status
     LIMIT 1`,[appointmentId,clientId])).rows[0];
  if(!appointment)return{status:404,body:{error:"Az időpont nem található."}};
  if(["cancelled","canceled","completed","paid","no_show"].includes(String(appointment.status||"").toLowerCase()))return{status:409,body:{error:"Ez az időpont már nem helyezhető át."}};
  const serviceIds=(appointment.service_ids||[]).map(String).filter(Boolean);
  if(!serviceIds.length)return{status:409,body:{error:"Az időponthoz nem tartozik áthelyezhető szolgáltatás."}};
  const locationId=String(appointment.location_id||"");
  const duration=Math.max(5,Number(appointment.duration_minutes||0));

  const cfg=(await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId])).rows[0]||{
    enabled:true,slot_interval_minutes:15,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60,
  };
  if(cfg.enabled===false)return{status:403,body:{error:"Az online időpont-módosítás ezen a telephelyen ki van kapcsolva."}};

  const employees=(await db.query(`
    SELECT e.id::text id,COALESCE(NULLIF(e.full_name,''),NULLIF(concat_ws(' ',e.last_name,e.first_name),''),'Munkatárs') full_name
      FROM employees e
     WHERE COALESCE(e.active,true)=true
       AND (e.location_id=$1::uuid OR e.location_id IS NULL)
       AND ($2::uuid IS NULL OR e.id=$2::uuid)
       AND (
         NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id)
         OR NOT EXISTS(
           SELECT 1 FROM unnest($3::uuid[]) sid(service_id)
           WHERE NOT EXISTS(
             SELECT 1 FROM employee_service_overrides eo
             WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id
           )
         )
       )
     ORDER BY full_name`,[locationId,requestedEmployeeId||null,serviceIds])).rows;
  if(!employees.length)return{status:200,body:{duration_minutes:duration,service_ids:serviceIds,slots:[],schedule_source:"published_shifts"}};

  const boundsRow=(await db.query(`SELECT
      (($1::date+make_interval(mins=>$2::int)) AT TIME ZONE 'Europe/Budapest') starts_at,
      (($1::date+make_interval(mins=>$3::int)) AT TIME ZONE 'Europe/Budapest') ends_at`,
    [date,Number(cfg.opening_minute||480),Number(cfg.closing_minute||1200)])).rows[0];
  const bounds:Interval={from:new Date(boundsRow.starts_at),to:new Date(boundsRow.ends_at)};
  const horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));
  if(bounds.from>horizon)return{status:200,body:{duration_minutes:duration,service_ids:serviceIds,slots:[],schedule_source:"outside_horizon"}};

  const employeeIds=employees.map((x:any)=>String(x.id));
  let scheduleSource="salon_hours_fallback";
  let intervals=new Map<string,Interval[]>(employeeIds.map(id=>[id,[bounds]]));
  if(await hasWorkShifts()){
    const publishedCount=Number((await db.query(`SELECT count(*)::int count
      FROM work_shifts s JOIN employees e ON e.id=s.employee_id
      WHERE s.work_date=$1::date AND s.status='published'
        AND (s.location_id=$2::uuid OR (s.location_id IS NULL AND (e.location_id=$2::uuid OR e.location_id IS NULL)))`,[date,locationId])).rows[0]?.count||0);
    if(publishedCount>0){
      scheduleSource="published_shifts";
      intervals=new Map();
      const rows=(await db.query(`SELECT s.employee_id::text employee_id,s.starts_at,s.ends_at
        FROM work_shifts s JOIN employees e ON e.id=s.employee_id
        WHERE s.work_date=$1::date AND s.status='published' AND s.employee_id=ANY($2::uuid[])
          AND (s.location_id=$3::uuid OR (s.location_id IS NULL AND (e.location_id=$3::uuid OR e.location_id IS NULL)))
        ORDER BY s.employee_id,s.starts_at`,[date,employeeIds,locationId])).rows;
      for(const row of rows){
        const id=String(row.employee_id),from=new Date(row.starts_at),to=new Date(row.ends_at);
        const clipped={from:from<bounds.from?bounds.from:from,to:to>bounds.to?bounds.to:to};
        if(clipped.to<=clipped.from)continue;
        const list=intervals.get(id)||[];list.push(clipped);intervals.set(id,list);
      }
    }
  }

  const busy=(await db.query(`
    SELECT employee_id::text employee_id,start_time,end_time
      FROM appointments
     WHERE id<>$1::uuid AND location_id=$2::uuid AND employee_id=ANY($3::uuid[])
       AND status NOT IN('cancelled','canceled','no_show')
       AND start_time<$5::timestamptz AND end_time>$4::timestamptz
    UNION ALL
    SELECT employee_id::text employee_id,start_time,end_time
      FROM appointment_technical_breaks
     WHERE location_id=$2::uuid AND employee_id=ANY($3::uuid[])
       AND start_time<$5::timestamptz AND end_time>$4::timestamptz`,
    [appointmentId,locationId,employeeIds,bounds.from.toISOString(),bounds.to.toISOString()])).rows;
  const busyMap=new Map<string,any[]>();
  for(const row of busy){const id=String(row.employee_id),list=busyMap.get(id)||[];list.push(row);busyMap.set(id,list);}

  const slots:any[]=[];
  const step=Math.max(5,Number(cfg.slot_interval_minutes||15));
  const noticeAt=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000);
  for(const employee of employees){
    const id=String(employee.id),blocks=busyMap.get(id)||[];
    for(const interval of intervals.get(id)||[]){
      for(let cursor=new Date(interval.from);cursor<interval.to;cursor=addMinutes(cursor,step)){
        const end=addMinutes(cursor,duration);
        if(cursor<noticeAt||end>interval.to)continue;
        if(blocks.some((b:any)=>new Date(b.start_time)<end&&new Date(b.end_time)>cursor))continue;
        slots.push({employee_id:id,employee_name:employee.full_name,start:cursor.toISOString(),end:end.toISOString()});
      }
    }
  }

  return{status:200,body:{
    appointment_id:appointmentId,
    duration_minutes:duration,
    service_ids:serviceIds,
    slots:slots.sort((a,b)=>a.start.localeCompare(b.start)||a.employee_name.localeCompare(b.employee_name,"hu")).slice(0,240),
    schedule_source:scheduleSource,
    excludes_current_appointment:true,
  }};
}
