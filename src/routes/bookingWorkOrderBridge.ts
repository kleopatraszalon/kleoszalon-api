import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);

const ADMIN=['admin','administrator','rendszergazda','superadmin','super_admin'];
const LOCATION_ROLES=['receptionist','recepciós','recepcios','reception','location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager','szalonvezető','szalonvezeto','salon_manager','manager','vezető','vezeto'];
const ACTIVE_APPOINTMENT_STATUSES=new Set(['pending','confirmed','booked','waiting','arrived','in_progress']);
const TERMINAL_APPOINTMENT_STATUSES=new Set(['cancelled','canceled','no_show','completed']);

const roleList=(raw:any):string[]=>{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const parsed=JSON.parse(String(raw||''));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}
  return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean);
};
const hasAny=(roles:string[],allowed:string[])=>roles.some(role=>allowed.includes(role));
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'system');

type Scope={isAdmin:boolean;locationId:string|null};
type EnsureResult={appointment_id:string;work_order_id:string|null;work_order_number:string|null;created:boolean;status:string;skipped?:boolean};

function resolveScope(req:AuthRequest):Scope|null{
  const roles=roleList(req.user?.role);
  if(hasAny(roles,ADMIN))return{isAdmin:true,locationId:null};
  if(hasAny(roles,LOCATION_ROLES))return{isAdmin:false,locationId:req.user?.location_id?String(req.user.location_id):null};
  return null;
}

function requireBridgeAccess(req:AuthRequest,res:Response,next:NextFunction){
  const scope=resolveScope(req);
  if(!scope)return res.status(403).json({message:'A foglalás–munkalap kapcsolatot csak adminisztrátor vagy szalonkezelő használhatja.'});
  if(!scope.isAdmin&&!scope.locationId)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});
  (req as any).bookingWorkOrderScope=scope;
  next();
}
router.use(requireBridgeAccess);

async function ensureSchema(c:any){
  await c.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_id uuid;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_number text;
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
    CREATE TABLE IF NOT EXISTS work_order_number_sequences(year integer PRIMARY KEY,last_value bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
  `);
  await c.query(`CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now()) RETURNS text LANGUAGE plpgsql AS $$ DECLARE y integer:=EXTRACT(YEAR FROM p_at)::integer;n bigint;BEGIN INSERT INTO work_order_number_sequences(year,last_value) VALUES(y,1) ON CONFLICT(year) DO UPDATE SET last_value=work_order_number_sequences.last_value+1,updated_at=now() RETURNING last_value INTO n;RETURN 'KLEO-ML-'||y::text||'-'||LPAD(n::text,6,'0');END $$;`);
}

async function appointmentRow(c:any,id:string){
  return (await c.query(`
    SELECT a.*,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'') client_name_resolved,c.phone client_phone_resolved,c.email client_email_resolved
    FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
    WHERE a.id=$1::uuid FOR UPDATE OF a
  `,[id])).rows[0]||null;
}

function assertVisible(ap:any,scope:Scope){
  if(!ap)return {status:404,message:'A foglalás nem található.'};
  if(!scope.isAdmin&&String(ap.location_id||'')!==String(scope.locationId||''))return {status:404,message:'A foglalás nem található ezen a szalonon.'};
  return null;
}

async function appointmentServices(c:any,appointmentId:string){
  const hasTable=(await c.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL ok`)).rows[0]?.ok;
  if(!hasTable)return[];
  return (await c.query(`
    SELECT aps.service_id::text,COALESCE(s.name,'Szolgáltatás') name,COALESCE(aps.duration_minutes,s.duration_minutes,30)::int duration_minutes,
           COALESCE(aps.price,s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(aps.discount_percent,0)::numeric discount_percent,
           COALESCE(aps.sort_order,0)::int sort_order
    FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id
    WHERE aps.appointment_id=$1::uuid ORDER BY COALESCE(aps.sort_order,0),aps.created_at
  `,[appointmentId])).rows;
}

async function linkedWorkOrder(c:any,ap:any){
  if(!ap?.work_order_id)return null;
  const wo=(await c.query(`SELECT id::text,work_order_number,status,locked_at,archived_at,financial_closed_at FROM work_orders WHERE id=$1::uuid`,[ap.work_order_id])).rows[0]||null;
  if(wo)return wo;
  await c.query(`UPDATE appointments SET work_order_id=NULL,work_order_number=NULL WHERE id=$1::uuid`,[ap.id]);
  ap.work_order_id=null;ap.work_order_number=null;
  return null;
}

async function ensureOne(c:any,appointmentId:string,scope:Scope,createdBy:string):Promise<EnsureResult>{
  await ensureSchema(c);
  const ap=await appointmentRow(c,appointmentId);
  const visibility=assertVisible(ap,scope);
  if(visibility){const err:any=new Error(visibility.message);err.httpStatus=visibility.status;throw err;}

  const existing=await linkedWorkOrder(c,ap);
  if(existing)return{appointment_id:String(ap.id),work_order_id:String(existing.id),work_order_number:existing.work_order_number||ap.work_order_number||null,created:false,status:String(ap.status||'')};

  const apStatus=String(ap.status||'confirmed').toLowerCase();
  if(TERMINAL_APPOINTMENT_STATUSES.has(apStatus)||!ACTIVE_APPOINTMENT_STATUSES.has(apStatus)){
    return{appointment_id:String(ap.id),work_order_id:null,work_order_number:null,created:false,status:apStatus,skipped:true};
  }

  const services=await appointmentServices(c,String(ap.id));
  const title=String(ap.title||'').trim()||services.map((s:any)=>s.name).filter(Boolean).join(', ')||String(ap.client_name_resolved||'').trim()||'Foglalás';
  const woStatus=apStatus==='in_progress'?'in_progress':apStatus==='arrived'?'arrived':'waiting';
  const number=(await c.query(`SELECT next_official_work_order_number(COALESCE($1::timestamptz,now())) work_order_number`,[ap.created_at||null])).rows[0].work_order_number;
  const sourceSnapshot={
    created_from:'appointment_bridge',
    booking_source:ap.booking_source||'internal',
    appointment:{id:ap.id,location_id:ap.location_id,employee_id:ap.employee_id,client_id:ap.client_id,title:ap.title,start_time:ap.start_time,end_time:ap.end_time,status:ap.status,notes:ap.notes},
    services,
  };
  const wo=(await c.query(`
    INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,appointment_id,fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,$11,now(),$12,COALESCE($13::timestamptz,now()),$14::jsonb)
    RETURNING id::text,work_order_number,status
  `,[title,ap.notes||null,woStatus,ap.employee_id||null,ap.client_id||null,ap.client_name_resolved||null,ap.client_phone_resolved||null,ap.client_email_resolved||null,ap.location_id||null,ap.id,createdBy,number,ap.created_at||null,JSON.stringify(sourceSnapshot)])).rows[0];

  for(const s of services){
    const price=Number(s.price||0),discountPercent=Math.max(0,Math.min(100,Number(s.discount_percent||0)));
    const discountAmount=Math.round(price*discountPercent)/100;
    const lineTotal=Math.max(0,Math.round((price-discountAmount)*100)/100);
    await c.query(`
      INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes)
      VALUES($1::uuid,'service',$2::uuid,$3,1,$4,$5,$6,$7)
    `,[wo.id,s.service_id,s.name,price,discountAmount,lineTotal,s.duration_minutes||null]);
  }
  const recalc=(await c.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;
  if(recalc)await c.query(`SELECT recalc_work_order_totals($1::uuid)`,[wo.id]);
  await c.query(`UPDATE appointments SET work_order_id=$2::uuid,work_order_number=$3,updated_at=now() WHERE id=$1::uuid`,[ap.id,wo.id,wo.work_order_number]);
  await c.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'workorder_linked',$2,$3::jsonb,$4)`,[ap.id,createdBy,JSON.stringify({work_order_id:wo.id,work_order_number:wo.work_order_number}),`Automatikus munkalap: ${wo.work_order_number}`]).catch(()=>undefined);
  return{appointment_id:String(ap.id),work_order_id:String(wo.id),work_order_number:wo.work_order_number,created:true,status:apStatus};
}

router.post('/ensure',async(req:AuthRequest,res,next)=>{
  const sourceIds:any[]=Array.isArray(req.body?.appointment_ids)?req.body.appointment_ids:[];
  const ids:string[]=Array.from(new Set<string>(sourceIds.map((value:any)=>String(value)).filter(Boolean))).slice(0,100);
  if(!ids.length)return res.json({items:[]});
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const scope=(req as any).bookingWorkOrderScope as Scope;
    const items:EnsureResult[]=[];
    for(const id of ids)items.push(await ensureOne(c,id,scope,actor(req)));
    await c.query('COMMIT');
    res.json({items});
  }catch(error:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen foglalásazonosító.'});
    if(error?.httpStatus)return res.status(error.httpStatus).json({message:error.message});
    next(error);
  }finally{c.release();}
});

router.post('/appointments/:id/arrive',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const scope=(req as any).bookingWorkOrderScope as Scope;
    const ensured=await ensureOne(c,String(req.params.id),scope,actor(req));
    if(!ensured.work_order_id){await c.query('ROLLBACK');return res.status(409).json({message:'Ehhez a foglaláshoz ebben az állapotban nem készíthető munkalap.'});}
    const ap=await appointmentRow(c,String(req.params.id));
    const wo=(await c.query(`SELECT id::text,work_order_number,status,locked_at,archived_at FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[ensured.work_order_id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A kapcsolódó munkalap nem található.'});}
    if(wo.locked_at||wo.archived_at){await c.query('ROLLBACK');return res.status(409).json({message:`A(z) ${wo.work_order_number||'munkalap'} már lezárt és archivált.`});}
    const apStatus=String(ap?.status||'').toLowerCase();
    if(!['in_progress','completed'].includes(apStatus))await c.query(`UPDATE appointments SET status='arrived',updated_at=now() WHERE id=$1::uuid`,[req.params.id]);
    if(!['in_progress','completed','cancelled','no_show'].includes(String(wo.status||'').toLowerCase())){
      await c.query(`UPDATE work_orders SET status='arrived',status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[wo.id]);
      const hasHistory=(await c.query(`SELECT to_regclass('public.work_order_status_history') IS NOT NULL ok`)).rows[0]?.ok;
      if(hasHistory)await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata) VALUES($1,'operational',$2,'arrived',$3,'APPOINTMENT_ARRIVAL',$4,$5::jsonb)`,[wo.id,wo.status||'waiting',actor(req),'Vendég érkeztetése a foglalási naptárból',JSON.stringify({appointment_id:req.params.id})]).catch(()=>undefined);
    }
    await c.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,note) VALUES($1::uuid,'arrived',$2,$3)`,[req.params.id,actor(req),`Kapcsolt munkalap: ${wo.work_order_number||wo.id}`]).catch(()=>undefined);
    await c.query('COMMIT');
    res.json({ok:true,appointment_id:req.params.id,appointment_status:apStatus==='in_progress'?'in_progress':'arrived',work_order_id:wo.id,work_order_number:wo.work_order_number,created:ensured.created});
  }catch(error:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen foglalásazonosító.'});
    if(error?.httpStatus)return res.status(error.httpStatus).json({message:error.message});
    next(error);
  }finally{c.release();}
});

export default router;
