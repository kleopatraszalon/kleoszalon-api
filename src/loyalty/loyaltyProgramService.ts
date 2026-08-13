import db from "../db";

type Queryable={query:(sql:string,params?:any[])=>Promise<any>};
const n=(v:any)=>Math.max(0,Number(v||0));

export async function ensureLoyaltyProgram(q:Queryable=db){
 await q.query(`
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_spent numeric;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_paid numeric;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_visits integer;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_last_visit timestamptz;
  CREATE TABLE IF NOT EXISTS loyalty_program_settings(id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),enabled boolean NOT NULL DEFAULT true,inactivity_days integer NOT NULL DEFAULT 360,points_enabled boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now(),updated_by text);
  INSERT INTO loyalty_program_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS loyalty_program_tiers(code text PRIMARY KEY,name text NOT NULL,color text NOT NULL,booked_threshold numeric(14,2) NOT NULL DEFAULT 0,paid_threshold numeric(14,2) NOT NULL DEFAULT 0,visits_threshold integer NOT NULL DEFAULT 0,discount_percent numeric(7,2) NOT NULL DEFAULT 0,sort_order integer NOT NULL,is_active boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO loyalty_program_tiers(code,name,color,booked_threshold,paid_threshold,visits_threshold,discount_percent,sort_order) VALUES('bronze','Bronz','#a66b3d',50000,50000,5,3,10),('silver','Ezüst','#8b95a1',150000,150000,12,5,20),('gold','Arany','#d5a51c',300000,300000,25,10,30) ON CONFLICT(code) DO NOTHING;
  CREATE TABLE IF NOT EXISTS loyalty_program_members(client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,tier_code text REFERENCES loyalty_program_tiers(code),booked_total numeric(14,2) NOT NULL DEFAULT 0,paid_total numeric(14,2) NOT NULL DEFAULT 0,visit_count integer NOT NULL DEFAULT 0,last_visit_at timestamptz,evaluated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS loyalty_program_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,old_tier_code text,new_tier_code text,reason text NOT NULL,trigger_source text NOT NULL DEFAULT 'automatic',metrics jsonb NOT NULL DEFAULT '{}'::jsonb,changed_by text,created_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS loyalty_program_members_tier_idx ON loyalty_program_members(tier_code,evaluated_at DESC);
  CREATE INDEX IF NOT EXISTS loyalty_program_history_client_idx ON loyalty_program_history(client_id,created_at DESC);
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS loyalty_tier_code text;
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS loyalty_discount_percent numeric(7,2) NOT NULL DEFAULT 0;
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS loyalty_discount_amount numeric(14,2) NOT NULL DEFAULT 0;
 `);
}

export async function evaluateClient(q:Queryable,clientId:string,source="automatic",changedBy?:string){
 await ensureLoyaltyProgram(q);
 const settings=(await q.query(`SELECT * FROM loyalty_program_settings WHERE id=1`)).rows[0];
 const metrics=(await q.query(`SELECT c.id,
   GREATEST(COALESCE(c.altegio_spent,0),COALESCE((SELECT SUM(COALESCE(w.gross_total,w.amount_due,0)) FROM work_orders w WHERE w.client_id::text=c.id::text AND (w.status='completed' OR w.archived_at IS NOT NULL)),0))::numeric booked_total,
   GREATEST(COALESCE(c.altegio_paid,c.altegio_spent,0),COALESCE((SELECT SUM(COALESCE(w.amount_paid,0)) FROM work_orders w WHERE w.client_id::text=c.id::text AND (w.status='completed' OR w.archived_at IS NOT NULL)),0))::numeric paid_total,
   GREATEST(COALESCE(c.altegio_visits,0),COALESCE((SELECT COUNT(*) FROM appointments a WHERE a.client_id::text=c.id::text AND a.status IN('completed','paid')),0))::int visit_count,
   GREATEST(c.altegio_last_visit,(SELECT MAX(a.start_time) FROM appointments a WHERE a.client_id::text=c.id::text AND a.status IN('completed','paid'))) last_visit_at
   FROM clients c WHERE c.id::text=$1`,[clientId])).rows[0];
 if(!metrics)return null;
 const inactive=metrics.last_visit_at&&new Date(metrics.last_visit_at).getTime()<Date.now()-n(settings.inactivity_days||360)*86400000;
 const tiers=(await q.query(`SELECT * FROM loyalty_program_tiers WHERE is_active ORDER BY sort_order DESC`)).rows;
 const tier=!settings.enabled||inactive?null:tiers.find((t:any)=>(n(t.booked_threshold)>0&&n(metrics.booked_total)>=n(t.booked_threshold))||(n(t.paid_threshold)>0&&n(metrics.paid_total)>=n(t.paid_threshold))||(n(t.visits_threshold)>0&&n(metrics.visit_count)>=n(t.visits_threshold)));
 const old=(await q.query(`SELECT tier_code FROM loyalty_program_members WHERE client_id::text=$1`,[clientId])).rows[0]?.tier_code||null;
 await q.query(`INSERT INTO loyalty_program_members(client_id,tier_code,booked_total,paid_total,visit_count,last_visit_at,evaluated_at) VALUES($1::uuid,$2,$3,$4,$5,$6,now()) ON CONFLICT(client_id) DO UPDATE SET tier_code=EXCLUDED.tier_code,booked_total=EXCLUDED.booked_total,paid_total=EXCLUDED.paid_total,visit_count=EXCLUDED.visit_count,last_visit_at=EXCLUDED.last_visit_at,evaluated_at=now()`,[clientId,tier?.code||null,metrics.booked_total,metrics.paid_total,metrics.visit_count,metrics.last_visit_at]);
 if(old!==(tier?.code||null))await q.query(`INSERT INTO loyalty_program_history(client_id,old_tier_code,new_tier_code,reason,trigger_source,metrics,changed_by) VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7)`,[clientId,old,tier?.code||null,inactive?'INACTIVITY':tier?'THRESHOLD_REACHED':'NO_THRESHOLD',source,JSON.stringify(metrics),changedBy||null]);
 return{...metrics,tier:tier||null,inactive,old_tier_code:old};
}

export async function loyaltyDiscountForWorkOrder(q:Queryable,workOrderId:string,gross:number){
 const wo=(await q.query(`SELECT client_id FROM work_orders WHERE id::text=$1`,[workOrderId])).rows[0];
 if(!wo?.client_id)return{tier_code:null,percent:0,amount:0};
 const result=await evaluateClient(q,String(wo.client_id),"checkout");
 const percent=n(result?.tier?.discount_percent);
 return{tier_code:result?.tier?.code||null,percent,amount:Math.round(n(gross)*percent)/100};
}