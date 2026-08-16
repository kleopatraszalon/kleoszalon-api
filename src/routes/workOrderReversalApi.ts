import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';
import {ensureFinanceNav} from '../finance/ensureFinanceNav';

const router=Router();
router.use(requireAuth);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isAdmin=(role:unknown)=>hasAnyRole(role,['admin']);
const canOperateOpenWorkOrder=(role:unknown)=>hasAnyRole(role,['admin','receptionist','location_manager','manager']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'admin');
let cancellationSchemaReady=false;

async function ensureCancellationSchema(){
 if(cancellationSchemaReady)return;
 await db.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_by text;
  ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancel_reason text;
  CREATE TABLE IF NOT EXISTS work_order_stock_reservations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
    quantity numeric(14,3) NOT NULL CHECK(quantity>0),
    status text NOT NULL DEFAULT 'active' CHECK(status IN('active','released','consumed')),
    reserved_by text NOT NULL,
    reserved_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    released_by text,
    release_reason text,
    UNIQUE(work_order_id,product_id,location_id)
  );
  CREATE INDEX IF NOT EXISTS work_order_stock_reservations_active_idx
    ON work_order_stock_reservations(location_id,product_id,status) WHERE status='active';
  CREATE TABLE IF NOT EXISTS work_order_cancellation_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT UNIQUE,
    location_id uuid,
    reason text NOT NULL CHECK(length(btrim(reason))>=5),
    cancelled_by text NOT NULL,
    cancelled_at timestamptz NOT NULL DEFAULT now(),
    released_reservations integer NOT NULL DEFAULT 0,
    source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
  );
 `);
 cancellationSchemaReady=true;
}
function scopeAllowed(req:AuthRequest,locationId:unknown){
 if(isAdmin(req.user?.role))return true;
 const userLocation=String(req.user?.location_id||'');
 return Boolean(userLocation)&&userLocation===String(locationId||'');
}

router.post('/:id/stock-reservation',async(req:AuthRequest,res,next)=>{
 const cx=await db.connect();
 try{
  if(!canOperateOpenWorkOrder(req.user?.role))return res.status(403).json({code:'WORK_ORDER_RESERVATION_FORBIDDEN',message:'Nincs jogosultság készlet foglalására.'});
  const workOrderId=String(req.params.id||'').trim(),productId=String(req.body?.product_id||'').trim(),quantity=Number(req.body?.quantity||0);
  if(!UUID_RE.test(workOrderId)||!UUID_RE.test(productId)||!(quantity>0))return res.status(400).json({code:'INVALID_STOCK_RESERVATION',message:'Érvényes munkalap-, termékazonosító és pozitív mennyiség szükséges.'});
  await ensureCancellationSchema();await cx.query('BEGIN');
  const wo=(await cx.query(`SELECT id::text,location_id::text,status,financial_closed_at,locked_at,archived_at FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[workOrderId])).rows[0];
  if(!wo){await cx.query('ROLLBACK');return res.status(404).json({code:'WORK_ORDER_NOT_FOUND',message:'A munkalap nem található.'});}
  if(!scopeAllowed(req,wo.location_id)){await cx.query('ROLLBACK');return res.status(404).json({code:'WORK_ORDER_NOT_IN_SCOPE',message:'A munkalap nem ehhez a szalonhoz tartozik.'});}
  if(!['waiting','arrived','in_progress'].includes(String(wo.status||''))||wo.financial_closed_at||wo.locked_at||wo.archived_at){await cx.query('ROLLBACK');return res.status(409).json({code:'WORK_ORDER_NOT_RESERVABLE',message:'Csak nyitott, pénzügyileg nem lezárt munkalaphoz foglalható készlet.'});}
  const balance=(await cx.query(`SELECT COALESCE(quantity,0)::numeric quantity FROM product_stock_balances WHERE product_id=$1::uuid AND location_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,[productId,wo.location_id||null])).rows[0];
  if(!balance){await cx.query('ROLLBACK');return res.status(409).json({code:'STOCK_BALANCE_MISSING',message:'Ehhez a termékhez nincs készletegyenleg a munkalap szalonjában.'});}
  const held=Number((await cx.query(`SELECT COALESCE(SUM(quantity),0)::numeric quantity FROM work_order_stock_reservations WHERE product_id=$1::uuid AND location_id IS NOT DISTINCT FROM $2::uuid AND status='active' AND work_order_id<>$3::uuid`,[productId,wo.location_id||null,workOrderId])).rows[0]?.quantity||0);
  const available=Number(balance.quantity||0)-held;
  if(available+1e-9<quantity){await cx.query('ROLLBACK');return res.status(409).json({code:'STOCK_RESERVATION_INSUFFICIENT',message:'Nincs elegendő szabad készlet a foglaláshoz.',available_quantity:available});}
  const row=(await cx.query(`INSERT INTO work_order_stock_reservations(work_order_id,product_id,location_id,quantity,status,reserved_by,reserved_at,released_at,released_by,release_reason)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,'active',$5,now(),NULL,NULL,NULL)
    ON CONFLICT(work_order_id,product_id,location_id) DO UPDATE SET quantity=EXCLUDED.quantity,status='active',reserved_by=EXCLUDED.reserved_by,reserved_at=now(),released_at=NULL,released_by=NULL,release_reason=NULL
    RETURNING id::text,work_order_id::text,product_id::text,location_id::text,quantity::numeric,status,reserved_by,reserved_at`,[workOrderId,productId,wo.location_id||null,quantity,actor(req)])).rows[0];
  await cx.query('COMMIT');return res.status(201).json({...row,available_after:available-quantity});
 }catch(error){await cx.query('ROLLBACK').catch(()=>undefined);return next(error)}finally{cx.release()}
});

router.post('/:id/cancel-open',async(req:AuthRequest,res,next)=>{
 const cx=await db.connect();
 try{
  if(!canOperateOpenWorkOrder(req.user?.role))return res.status(403).json({code:'WORK_ORDER_CANCEL_FORBIDDEN',message:'Nincs jogosultság a munkalap visszavonására.'});
  const workOrderId=String(req.params.id||'').trim(),reason=String(req.body?.reason||'').trim();
  if(!UUID_RE.test(workOrderId))return res.status(400).json({code:'INVALID_WORK_ORDER_ID',message:'Érvénytelen munkalapazonosító.'});
  if(reason.length<5)return res.status(400).json({code:'WORK_ORDER_CANCEL_REASON_REQUIRED',message:'A visszavonás indoklása legalább 5 karakter legyen.'});
  await ensureCancellationSchema();await cx.query('BEGIN');
  const wo=(await cx.query(`SELECT w.*,w.location_id::text location_id_text FROM work_orders w WHERE id=$1::uuid FOR UPDATE`,[workOrderId])).rows[0];
  if(!wo){await cx.query('ROLLBACK');return res.status(404).json({code:'WORK_ORDER_NOT_FOUND',message:'A munkalap nem található.'});}
  if(!scopeAllowed(req,wo.location_id_text)){await cx.query('ROLLBACK');return res.status(404).json({code:'WORK_ORDER_NOT_IN_SCOPE',message:'A munkalap nem ehhez a szalonhoz tartozik.'});}
  const prior=(await cx.query(`SELECT * FROM work_order_cancellation_events WHERE work_order_id=$1::uuid LIMIT 1`,[workOrderId])).rows[0]||null;
  if(String(wo.status||'')==='cancelled'&&prior){await cx.query('COMMIT');return res.json({ok:true,idempotent:true,cancellation:prior});}
  const paid=Number((await cx.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id=$1::uuid`,[workOrderId])).rows[0]?.total||0);
  const invoice=(await cx.query(`SELECT id::text,status,invoice_no FROM finance_invoices WHERE direction='outgoing' AND work_order_id=$1::text AND COALESCE(status,'draft') NOT IN('draft','cancelled','void','storno') ORDER BY created_at DESC LIMIT 1`,[workOrderId])).rows[0]||null;
  const finalized=Boolean(wo.financial_closed_at||wo.locked_at||wo.archived_at||String(wo.status||'')==='completed'||paid>0||invoice);
  if(finalized){await cx.query('ROLLBACK');return res.status(409).json({code:'WORK_ORDER_FINANCIALLY_FINALIZED',message:'A munkalap pénzügyi vagy számlázási eseményt tartalmaz; normál visszavonás helyett auditált reversal szükséges.',reversal_endpoint:`/api/workorders/${workOrderId}/reversal-request`});}
  const released=(await cx.query(`UPDATE work_order_stock_reservations SET status='released',released_at=now(),released_by=$2,release_reason=$3 WHERE work_order_id=$1::uuid AND status='active' RETURNING id`,[workOrderId,actor(req),reason])).rowCount||0;
  await cx.query(`UPDATE salon_stock_requests SET status='cancelled',updated_at=now(),note=concat_ws(' · ',NULLIF(note,''),$2) WHERE source_work_order_id=$1::uuid AND status IN('requested','approved','partially_supplied')`,[workOrderId,`Munkalap visszavonva: ${reason}`]).catch(()=>undefined);
  const updated=(await cx.query(`UPDATE work_orders SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),cancelled_by=COALESCE(cancelled_by,$2),cancel_reason=COALESCE(cancel_reason,$3),status_updated_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING id::text,status,cancelled_at,cancelled_by,cancel_reason,location_id::text`,[workOrderId,actor(req),reason])).rows[0];
  if(wo.appointment_id)await cx.query(`UPDATE appointments SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE id=$1::uuid AND lower(COALESCE(status,'')) NOT IN('cancelled','canceled','completed','no_show')`,[wo.appointment_id]).catch(()=>undefined);
  await cx.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,metadata) VALUES($1::uuid,'business',$2,'cancelled',$3,$4,$5::jsonb)`,[workOrderId,String(wo.status||''),actor(req),reason,JSON.stringify({released_reservations:released})]).catch(()=>undefined);
  const event=(await cx.query(`INSERT INTO work_order_cancellation_events(work_order_id,location_id,reason,cancelled_by,released_reservations,source_snapshot) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb) ON CONFLICT(work_order_id) DO UPDATE SET work_order_id=EXCLUDED.work_order_id RETURNING *`,[workOrderId,wo.location_id||null,reason,actor(req),released,JSON.stringify({status:wo.status,amount_paid:paid,financial_closed_at:wo.financial_closed_at,invoice:null})])).rows[0];
  await cx.query('COMMIT');return res.json({ok:true,idempotent:false,work_order:updated,released_reservations:released,cancellation:event});
 }catch(error){await cx.query('ROLLBACK').catch(()=>undefined);return next(error)}finally{cx.release()}
});

router.post('/:id/reversal-request',async(req:AuthRequest,res,next)=>{
  try{
    if(!isAdmin(req.user?.role))return res.status(403).json({code:'REVERSAL_ADMIN_REQUIRED',message:'Lezárt munkalap visszafordítását csak adminisztrátor kezdeményezheti.'});
    const workOrderId=String(req.params.id||'').trim();
    if(!UUID_RE.test(workOrderId))return res.status(400).json({code:'INVALID_WORK_ORDER_ID',message:'Érvénytelen munkalapazonosító.'});
    const reason=String(req.body?.reason||'').trim();
    const key=String(req.get('Idempotency-Key')||req.body?.idempotency_key||'').trim();
    if(reason.length<5)return res.status(400).json({code:'REVERSAL_REASON_REQUIRED',message:'A visszafordítás indoklása legalább 5 karakter legyen.'});
    if(key.length<8)return res.status(400).json({code:'REVERSAL_IDEMPOTENCY_KEY_REQUIRED',message:'A visszafordításhoz legalább 8 karakteres Idempotency-Key szükséges.'});

    await ensureFinanceNav();
    const prior=(await db.query(`SELECT id::text,work_order_id::text,status,idempotency_key FROM work_order_reversals WHERE work_order_id=$1::uuid OR idempotency_key=$2 ORDER BY created_at LIMIT 1`,[workOrderId,key])).rows[0]||null;
    if(prior&&String(prior.idempotency_key)===key&&String(prior.work_order_id)!==workOrderId)
      return res.status(409).json({code:'REVERSAL_IDEMPOTENCY_KEY_CONFLICT',message:'Ez az Idempotency-Key már másik munkalap visszafordításához tartozik.'});

    const row=(await db.query(`SELECT * FROM kleo_register_work_order_reversal($1::uuid,$2,$3,$4)`,[workOrderId,reason,actor(req),key])).rows[0];
    return res.status(prior?200:202).json({
      ok:true,
      idempotent:Boolean(prior),
      reversal:row,
      message:prior?'A visszafordítási kérés már létezett; ugyanazt a rekordot adtuk vissza.':'A visszafordítási kérés auditáltan rögzítve. A forrás munkalap és archívum változatlan maradt.'
    });
  }catch(error:any){
    const code=String(error?.code||'');const message=String(error?.message||'');
    if(code==='P0002'||message.includes('WORK_ORDER_NOT_FOUND'))return res.status(404).json({code:'WORK_ORDER_NOT_FOUND',message:'A munkalap nem található.'});
    if(code==='23514'&&message.includes('WORK_ORDER_NOT_FINALIZED'))return res.status(409).json({code:'WORK_ORDER_NOT_FINALIZED',message:'Csak véglegesen lezárt vagy archivált munkalap fordítható vissza.'});
    if(code==='23505'&&message.includes('REVERSAL_IDEMPOTENCY_KEY_CONFLICT'))return res.status(409).json({code:'REVERSAL_IDEMPOTENCY_KEY_CONFLICT',message:'Ez az Idempotency-Key már másik munkalap visszafordításához tartozik.'});
    if(code==='22023')return res.status(400).json({code:message.includes('IDEMPOTENCY')?'REVERSAL_IDEMPOTENCY_KEY_REQUIRED':'REVERSAL_REASON_REQUIRED',message:'A visszafordítási kérés indoklása vagy idempotenciakulcsa érvénytelen.'});
    return next(error);
  }
});

router.get('/:id/reversal',async(req:AuthRequest,res,next)=>{
  try{
    if(!hasAnyRole(req.user?.role,['admin','accounting','bookkeeper','konyveles','könyvelés']))return res.status(403).json({message:'A visszafordítási auditadat csak adminisztrátor vagy könyvelés számára érhető el.'});
    const workOrderId=String(req.params.id||'').trim();
    if(!UUID_RE.test(workOrderId))return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});
    await ensureFinanceNav();
    const row=(await db.query(`SELECT * FROM work_order_reversals WHERE work_order_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,[workOrderId])).rows[0];
    if(!row)return res.status(404).json({message:'Ehhez a munkalaphoz nincs visszafordítási rekord.'});
    return res.json(row);
  }catch(error){return next(error)}
});

export default router;
