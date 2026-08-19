import crypto from "crypto";
import pool from "../db";

let schemaPromise:Promise<void>|null=null;

export async function ensureNbaRevenueAttribution(){
  if(schemaPromise)return schemaPromise;
  schemaPromise=pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS crm_nba_marketing_touches(
      id bigserial PRIMARY KEY,
      tenant_id bigint NOT NULL,
      job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
      event_type text NOT NULL DEFAULT 'landing' CHECK(event_type IN('landing')),
      fingerprint_hash text,
      referrer text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS crm_nba_marketing_touches_job_idx ON crm_nba_marketing_touches(tenant_id,job_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS crm_nba_marketing_touches_dedupe_uq
      ON crm_nba_marketing_touches(job_id,fingerprint_hash)
      WHERE fingerprint_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS crm_nba_revenue_attribution(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id bigint NOT NULL,
      job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
      client_id text NOT NULL,
      appointment_id uuid NOT NULL,
      work_order_id uuid,
      expected_booking_value numeric(14,2) NOT NULL DEFAULT 0,
      booked_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(job_id,appointment_id)
    );
    CREATE INDEX IF NOT EXISTS crm_nba_revenue_attr_tenant_idx ON crm_nba_revenue_attribution(tenant_id,booked_at DESC);
    CREATE INDEX IF NOT EXISTS crm_nba_revenue_attr_client_idx ON crm_nba_revenue_attribution(tenant_id,client_id,booked_at DESC);
  `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  return schemaPromise;
}

const uuid=(v:unknown)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||""));
const clean=(v:unknown,max=500)=>String(v||"").trim().slice(0,max);

export async function recordNbaLanding(jobId:string,userAgent:string,referrer:string){
  await ensureNbaRevenueAttribution();
  if(!uuid(jobId))return {ok:false,code:"INVALID_JOB"};
  const job=(await pool.query(`SELECT id,tenant_id,status,sent_at FROM crm_nba_marketing_jobs WHERE id=$1::uuid LIMIT 1`,[jobId])).rows[0];
  if(!job||!["sent","completed"].includes(String(job.status)))return {ok:false,code:"JOB_NOT_TRACKABLE"};
  if(job.sent_at&&new Date(job.sent_at).getTime()<Date.now()-30*86400000)return {ok:false,code:"ATTRIBUTION_WINDOW_EXPIRED"};
  const hour=new Date();hour.setMinutes(0,0,0);
  const fingerprint=crypto.createHash("sha256").update(`${jobId}|${clean(userAgent,300)}|${hour.toISOString()}`).digest("hex");
  await pool.query(`INSERT INTO crm_nba_marketing_touches(tenant_id,job_id,event_type,fingerprint_hash,referrer) VALUES($1::bigint,$2::uuid,'landing',$3,$4) ON CONFLICT DO NOTHING`,[job.tenant_id,job.id,fingerprint,clean(referrer,500)||null]);
  return {ok:true};
}

export async function attributeNbaBooking(jobId:string,appointmentId:string){
  await ensureNbaRevenueAttribution();
  if(!uuid(jobId)||!uuid(appointmentId))return {ok:false,code:"INVALID_ATTRIBUTION"};
  const job=(await pool.query(`SELECT id,tenant_id,client_id,status,sent_at FROM crm_nba_marketing_jobs WHERE id=$1::uuid LIMIT 1`,[jobId])).rows[0];
  if(!job||!["sent","completed"].includes(String(job.status)))return {ok:false,code:"JOB_NOT_TRACKABLE"};
  const sentAt=job.sent_at?new Date(job.sent_at).getTime():0;
  if(!sentAt||sentAt<Date.now()-30*86400000)return {ok:false,code:"ATTRIBUTION_WINDOW_EXPIRED"};
  const appointment=(await pool.query(`
    SELECT a.id::text id,(to_jsonb(a)->>'client_id') client_id,(to_jsonb(a)->>'work_order_id') work_order_id,
      lower(COALESCE(to_jsonb(a)->>'status','')) status,
      COALESCE((SELECT SUM(COALESCE(s.price,0)*(1-COALESCE(s.discount_percent,0)/100.0)) FROM appointment_services s WHERE s.appointment_id=a.id),0)::numeric expected_value
    FROM appointments a WHERE a.id=$1::uuid LIMIT 1`,[appointmentId])).rows[0];
  if(!appointment)return {ok:false,code:"APPOINTMENT_NOT_FOUND"};
  if(String(appointment.client_id)!==String(job.client_id))return {ok:false,code:"CLIENT_MISMATCH"};
  if(["cancelled","canceled","no_show"].includes(String(appointment.status)))return {ok:false,code:"APPOINTMENT_NOT_CONVERTED"};
  const row=(await pool.query(`
    INSERT INTO crm_nba_revenue_attribution(tenant_id,job_id,client_id,appointment_id,work_order_id,expected_booking_value,booked_at)
    VALUES($1::bigint,$2::uuid,$3,$4::uuid,$5::uuid,$6,now())
    ON CONFLICT(job_id,appointment_id) DO UPDATE SET work_order_id=COALESCE(EXCLUDED.work_order_id,crm_nba_revenue_attribution.work_order_id),expected_booking_value=EXCLUDED.expected_booking_value,updated_at=now()
    RETURNING *`,[job.tenant_id,job.id,job.client_id,appointment.id,uuid(appointment.work_order_id)?appointment.work_order_id:null,Number(appointment.expected_value||0)])).rows[0];
  await pool.query(`INSERT INTO crm_nba_marketing_job_events(tenant_id,job_id,event_type,actor,payload) VALUES($1::bigint,$2::uuid,'booking_attributed','public',$3::jsonb)`,[job.tenant_id,job.id,JSON.stringify({appointment_id:appointment.id,work_order_id:row.work_order_id,expected_booking_value:Number(row.expected_booking_value||0)})]);
  return {ok:true,attribution_id:row.id};
}

export async function attributionSummary(tenantId:string,days:number,locationId:string|null){
  await ensureNbaRevenueAttribution();
  const period=Math.max(1,Math.min(365,Math.floor(days||30)));
  const params:any[]=[tenantId,period];
  const locationFilter=locationId?`AND (to_jsonb(a)->>'location_id')=$3::text`:"";
  if(locationId)params.push(locationId);
  const totals=(await pool.query(`
    WITH sent AS (
      SELECT id,action_code,channel FROM crm_nba_marketing_jobs
      WHERE tenant_id=$1::bigint AND sent_at>=now()-($2::int||' days')::interval
    ), touches AS (
      SELECT DISTINCT t.job_id FROM crm_nba_marketing_touches t JOIN sent s ON s.id=t.job_id
    ), attrs AS (
      SELECT r.*,lower(COALESCE(to_jsonb(a)->>'status','')) appointment_status
      FROM crm_nba_revenue_attribution r
      JOIN sent s ON s.id=r.job_id
      JOIN appointments a ON a.id=r.appointment_id
      WHERE 1=1 ${locationFilter}
    ), paid AS (
      SELECT x.job_id,COALESCE(SUM(p.amount),0)::numeric paid_revenue
      FROM attrs x LEFT JOIN work_order_payments p ON p.work_order_id=x.work_order_id
      WHERE x.appointment_status NOT IN('cancelled','canceled','no_show')
      GROUP BY x.job_id
    )
    SELECT
      (SELECT COUNT(*) FROM sent)::int sent_jobs,
      (SELECT COUNT(*) FROM touches)::int landed_jobs,
      (SELECT COUNT(DISTINCT appointment_id) FROM attrs WHERE appointment_status NOT IN('cancelled','canceled','no_show'))::int attributed_bookings,
      COALESCE((SELECT SUM(expected_booking_value) FROM attrs WHERE appointment_status NOT IN('cancelled','canceled','no_show')),0)::numeric expected_booking_value,
      COALESCE((SELECT SUM(paid_revenue) FROM paid),0)::numeric paid_revenue`,params)).rows[0];
  const actionRows=(await pool.query(`
    WITH jobs AS (
      SELECT id,action_code,channel FROM crm_nba_marketing_jobs WHERE tenant_id=$1::bigint AND sent_at>=now()-($2::int||' days')::interval
    ), attr_raw AS (
      SELECT r.job_id,r.expected_booking_value,r.work_order_id,lower(COALESCE(to_jsonb(a)->>'status','')) appointment_status
      FROM crm_nba_revenue_attribution r JOIN appointments a ON a.id=r.appointment_id
      WHERE r.tenant_id=$1::bigint ${locationId?`AND (to_jsonb(a)->>'location_id')=$3::text`:""}
    ), attr_job AS (
      SELECT job_id,
        COUNT(*) FILTER(WHERE appointment_status NOT IN('cancelled','canceled','no_show'))::int conversions,
        COALESCE(SUM(expected_booking_value) FILTER(WHERE appointment_status NOT IN('cancelled','canceled','no_show')),0)::numeric expected_value
      FROM attr_raw GROUP BY job_id
    ), paid_job AS (
      SELECT a.job_id,COALESCE(SUM(p.amount),0)::numeric revenue
      FROM attr_raw a LEFT JOIN work_order_payments p ON p.work_order_id=a.work_order_id
      WHERE a.appointment_status NOT IN('cancelled','canceled','no_show') GROUP BY a.job_id
    )
    SELECT j.action_code,j.channel,COUNT(*)::int sent,
      COALESCE(SUM(a.conversions),0)::int conversions,
      COALESCE(SUM(a.expected_value),0)::numeric expected_value,
      COALESCE(SUM(p.revenue),0)::numeric paid_revenue
    FROM jobs j LEFT JOIN attr_job a ON a.job_id=j.id LEFT JOIN paid_job p ON p.job_id=j.id
    GROUP BY j.action_code,j.channel ORDER BY paid_revenue DESC,conversions DESC,sent DESC`,params)).rows;
  const sent=Number(totals.sent_jobs||0),bookings=Number(totals.attributed_bookings||0),revenue=Number(totals.paid_revenue||0);
  return {period_days:period,...totals,sent_jobs:sent,landed_jobs:Number(totals.landed_jobs||0),attributed_bookings:bookings,expected_booking_value:Number(totals.expected_booking_value||0),paid_revenue:revenue,conversion_rate_percent:sent?Number(((bookings/sent)*100).toFixed(2)):0,revenue_per_send:sent?Number((revenue/sent).toFixed(2)):0,action_rows:actionRows.map((r:any)=>({...r,sent:Number(r.sent||0),conversions:Number(r.conversions||0),expected_value:Number(r.expected_value||0),paid_revenue:Number(r.paid_revenue||0),conversion_rate_percent:Number(r.sent)?Number((Number(r.conversions||0)/Number(r.sent)*100).toFixed(2)):0}))};
}