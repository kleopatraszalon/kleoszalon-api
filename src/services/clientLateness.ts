import db from '../db';

const GRACE_MINUTES=Math.max(0,Number(process.env.APPOINTMENT_LATE_GRACE_MINUTES||5));
let schemaReady=false;

async function ensureSchema(){
  if(schemaReady)return;
  await db.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS arrived_at timestamptz;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS late_minutes integer;
  `);
  schemaReady=true;
}

async function crmReady(){
  const row=(await db.query(`SELECT to_regclass('public.crm_tags') tags,to_regclass('public.crm_client_tags') links`)).rows[0];
  return Boolean(row?.tags&&row?.links);
}

export async function recordWorkOrderArrival(workOrderId:string){
  await ensureSchema();
  const row=(await db.query(`
    SELECT a.id::text appointment_id,a.start_time,a.arrived_at,
      COALESCE(NULLIF(to_jsonb(w)->>'client_id',''),a.client_id::text) client_id
    FROM work_orders w
    JOIN appointments a ON a.id::text=NULLIF(to_jsonb(w)->>'appointment_id','')
    WHERE w.id::text=$1
    LIMIT 1`,[workOrderId])).rows[0];
  if(!row)return null;

  const arrival=row.arrived_at?new Date(row.arrived_at):new Date();
  const scheduled=new Date(row.start_time);
  const lateMinutes=Math.max(0,Math.floor((arrival.getTime()-scheduled.getTime())/60000));
  await db.query(`UPDATE appointments SET arrived_at=COALESCE(arrived_at,$2::timestamptz),late_minutes=COALESCE(late_minutes,$3) WHERE id::text=$1`,[row.appointment_id,arrival.toISOString(),lateMinutes]);

  const clientId=String(row.client_id||'').trim();
  if(clientId&&lateMinutes>GRACE_MINUTES&&await crmReady()){
    const tag=(await db.query(`INSERT INTO crm_tags(name,color,is_active) VALUES('Késett','#dc2626',true)
      ON CONFLICT ((lower(name))) DO UPDATE SET is_active=true RETURNING id`)).rows[0];
    if(tag?.id)await db.query(`INSERT INTO crm_client_tags(client_id,tag_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`,[clientId,tag.id]);
  }
  return{appointment_id:String(row.appointment_id),client_id:clientId||null,late_minutes:lateMinutes,is_late:lateMinutes>GRACE_MINUTES,grace_minutes:GRACE_MINUTES};
}

export async function clientLatenessStats(clientId:string){
  await ensureSchema();
  const row=(await db.query(`SELECT
      COUNT(*) FILTER(WHERE arrived_at IS NOT NULL)::int attended,
      COUNT(*) FILTER(WHERE arrived_at IS NOT NULL AND COALESCE(late_minutes,0)>$2)::int late_count,
      COALESCE(ROUND(100.0*COUNT(*) FILTER(WHERE arrived_at IS NOT NULL AND COALESCE(late_minutes,0)>$2)/NULLIF(COUNT(*) FILTER(WHERE arrived_at IS NOT NULL),0),1),0)::numeric late_percentage,
      COALESCE(MAX(late_minutes) FILTER(WHERE arrived_at IS NOT NULL),0)::int max_late_minutes
    FROM appointments WHERE client_id::text=$1`,[clientId,GRACE_MINUTES])).rows[0]||{};
  return{attended:Number(row.attended||0),late_count:Number(row.late_count||0),late_percentage:Number(row.late_percentage||0),max_late_minutes:Number(row.max_late_minutes||0),grace_minutes:GRACE_MINUTES};
}
