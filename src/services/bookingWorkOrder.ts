let schemaReady=false;

export type BookingWorkOrderResult={appointment_id:string;work_order_id:string|null;work_order_number:string|null;created:boolean;status:string;skipped?:boolean};
const ACTIVE_APPOINTMENT_STATUSES=new Set(['pending','confirmed','booked','waiting','arrived','in_progress']);
const TERMINAL_APPOINTMENT_STATUSES=new Set(['cancelled','canceled','no_show','completed']);

async function safeIndex(c:any,sql:string,label:string){
  try{await c.query(sql)}catch(error:any){
    if(['23505','42P01','42703'].includes(String(error?.code||''))){console.warn(`[booking-workorder] ${label} index skipped:`,error?.message||error);return}
    throw error;
  }
}

export async function ensureBookingWorkOrderSchema(c:any){
  if(schemaReady)return;
  await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await c.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_id uuid;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_number text;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_name text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_phone text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_email text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS location_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS appointment_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fully_paid boolean NOT NULL DEFAULT false;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS note_for_another_visitor boolean NOT NULL DEFAULT false;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_created_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_reason text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archive_hash text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS work_order_number_sequences(
      year integer PRIMARY KEY,
      last_value bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const hasItems=(await c.query(`SELECT to_regclass('public.work_order_items') IS NOT NULL ok`)).rows[0]?.ok;
  if(hasItems){
    await c.query(`
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS line_total numeric(14,2) NOT NULL DEFAULT 0;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS duration_minutes integer;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS quantity numeric(12,3) NOT NULL DEFAULT 1;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS unit_price numeric(14,2) NOT NULL DEFAULT 0;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_name text;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_type text;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS service_id uuid;
      ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS product_id uuid;
    `);
  }

  const hasAppointmentServices=(await c.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL ok`)).rows[0]?.ok;
  if(hasAppointmentServices){
    await c.query(`
      ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS duration_minutes integer;
      ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS price numeric(14,2);
      ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS discount_percent numeric(7,4) NOT NULL DEFAULT 0;
      ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
      ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    `);
  }

  const hasClients=(await c.query(`SELECT to_regclass('public.clients') IS NOT NULL ok`)).rows[0]?.ok;
  if(hasClients){
    await c.query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS full_name text;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS name text;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text;
    `);
  }

  await c.query(`CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now()) RETURNS text LANGUAGE plpgsql AS $$ DECLARE y integer:=EXTRACT(YEAR FROM p_at)::integer;n bigint;BEGIN INSERT INTO work_order_number_sequences(year,last_value) VALUES(y,1) ON CONFLICT(year) DO UPDATE SET last_value=work_order_number_sequences.last_value+1,updated_at=now() RETURNING last_value INTO n;RETURN 'KLEO-ML-'||y::text||'-'||LPAD(n::text,6,'0');END $$;`);

  await safeIndex(c,`CREATE UNIQUE INDEX IF NOT EXISTS work_orders_appointment_uq ON work_orders(appointment_id) WHERE appointment_id IS NOT NULL`,'appointment');
  await safeIndex(c,`CREATE UNIQUE INDEX IF NOT EXISTS work_orders_official_number_uq ON work_orders(work_order_number) WHERE work_order_number IS NOT NULL`,'number');
  await safeIndex(c,`CREATE INDEX IF NOT EXISTS appointments_work_order_idx ON appointments(work_order_id)`,'appointment-link');
  schemaReady=true;
}

async function appointmentRow(c:any,id:string){
  return (await c.query(`SELECT a.*,COALESCE(NULLIF(cl.full_name,''),NULLIF(cl.name,''),'') client_name_resolved,cl.phone client_phone_resolved,cl.email client_email_resolved FROM appointments a LEFT JOIN clients cl ON cl.id=a.client_id WHERE a.id=$1::uuid FOR UPDATE OF a`,[id])).rows[0]||null;
}

async function appointmentServices(c:any,appointmentId:string){
  const hasTable=(await c.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL ok`)).rows[0]?.ok;
  if(!hasTable)return[];
  return (await c.query(`SELECT aps.service_id::text,COALESCE(s.name,'Szolgáltatás') name,COALESCE(aps.duration_minutes,s.duration_minutes,30)::int duration_minutes,COALESCE(aps.price,s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(aps.discount_percent,0)::numeric discount_percent,COALESCE(aps.sort_order,0)::int sort_order FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id WHERE aps.appointment_id=$1::uuid ORDER BY COALESCE(aps.sort_order,0),aps.created_at`,[appointmentId])).rows;
}

export async function ensureBookingWorkOrder(c:any,appointmentId:string,createdBy:string):Promise<BookingWorkOrderResult>{
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`booking-workorder:${appointmentId}`]);
  const ap=await appointmentRow(c,appointmentId);
  if(!ap){const error:any=new Error('A foglalás nem található.');error.httpStatus=404;throw error;}
  if(ap.work_order_id){
    const existing=(await c.query(`SELECT id::text,work_order_number FROM work_orders WHERE id=$1::uuid`,[ap.work_order_id])).rows[0]||null;
    if(existing)return{appointment_id:String(ap.id),work_order_id:String(existing.id),work_order_number:existing.work_order_number||ap.work_order_number||null,created:false,status:String(ap.status||'')};
    await c.query(`UPDATE appointments SET work_order_id=NULL,work_order_number=NULL,updated_at=now() WHERE id=$1::uuid`,[ap.id]);
  }
  const existingByAppointment=(await c.query(`SELECT id::text,work_order_number,status FROM work_orders WHERE appointment_id=$1::uuid ORDER BY created_at LIMIT 1`,[ap.id])).rows[0]||null;
  if(existingByAppointment){
    await c.query(`UPDATE appointments SET work_order_id=$2::uuid,work_order_number=$3,updated_at=now() WHERE id=$1::uuid`,[ap.id,existingByAppointment.id,existingByAppointment.work_order_number]);
    return{appointment_id:String(ap.id),work_order_id:String(existingByAppointment.id),work_order_number:existingByAppointment.work_order_number||null,created:false,status:String(ap.status||'')};
  }
  const apStatus=String(ap.status||'confirmed').toLowerCase();
  if(TERMINAL_APPOINTMENT_STATUSES.has(apStatus)||!ACTIVE_APPOINTMENT_STATUSES.has(apStatus))return{appointment_id:String(ap.id),work_order_id:null,work_order_number:null,created:false,status:apStatus,skipped:true};
  const services=await appointmentServices(c,String(ap.id));
  const title=String(ap.title||'').trim()||services.map((s:any)=>s.name).filter(Boolean).join(', ')||String(ap.client_name_resolved||'').trim()||'Foglalás';
  const woStatus=apStatus==='in_progress'?'in_progress':apStatus==='arrived'?'arrived':'waiting';
  const number=(await c.query(`SELECT next_official_work_order_number(COALESCE($1::timestamptz,now())) work_order_number`,[ap.created_at||null])).rows[0].work_order_number;
  const sourceSnapshot={created_from:'appointment',booking_source:ap.booking_source||'internal',appointment:{id:ap.id,location_id:ap.location_id,employee_id:ap.employee_id,client_id:ap.client_id,title:ap.title,start_time:ap.start_time,end_time:ap.end_time,status:ap.status,notes:ap.notes},services};
  let wo:any;
  try{
    wo=(await c.query(`INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,appointment_id,fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,$11,now(),$12,COALESCE($13::timestamptz,now()),$14::jsonb) RETURNING id::text,work_order_number,status`,[title,ap.notes||null,woStatus,ap.employee_id||null,ap.client_id||null,ap.client_name_resolved||null,ap.client_phone_resolved||null,ap.client_email_resolved||null,ap.location_id||null,ap.id,createdBy,number,ap.created_at||null,JSON.stringify(sourceSnapshot)])).rows[0];
  }catch(error:any){
    if(error?.code!=='23505')throw error;
    wo=(await c.query(`SELECT id::text,work_order_number,status FROM work_orders WHERE appointment_id=$1::uuid LIMIT 1`,[ap.id])).rows[0];
    if(!wo)throw error;
  }
  const hasItemsNow=(await c.query(`SELECT to_regclass('public.work_order_items') IS NOT NULL ok`)).rows[0]?.ok;
  if(hasItemsNow){
    const existingItems=Number((await c.query(`SELECT COUNT(*)::int count FROM work_order_items WHERE work_order_id=$1::uuid`,[wo.id])).rows[0]?.count||0);
    if(existingItems===0){
      for(const s of services){
        const price=Number(s.price||0),discountPercent=Math.max(0,Math.min(100,Number(s.discount_percent||0))),discountAmount=Math.round(price*discountPercent)/100,lineTotal=Math.max(0,Math.round((price-discountAmount)*100)/100);
        await c.query(`INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes) VALUES($1::uuid,'service',$2::uuid,$3,1,$4,$5,$6,$7)`,[wo.id,s.service_id,s.name,price,discountAmount,lineTotal,s.duration_minutes||null]);
      }
    }
    const recalc=(await c.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;
    if(recalc)await c.query(`SELECT recalc_work_order_totals($1::uuid)`,[wo.id]);
  }
  await c.query(`UPDATE appointments SET work_order_id=$2::uuid,work_order_number=$3,updated_at=now() WHERE id=$1::uuid`,[ap.id,wo.id,wo.work_order_number]);
  await c.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'workorder_linked',$2,$3::jsonb,$4)`,[ap.id,createdBy,JSON.stringify({work_order_id:wo.id,work_order_number:wo.work_order_number}),`Automatikus munkalap: ${wo.work_order_number}`]).catch(()=>undefined);
  return{appointment_id:String(ap.id),work_order_id:String(wo.id),work_order_number:wo.work_order_number,created:true,status:apStatus};
}
