import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'unknown');
const allowedCancelReasons=new Set(['Közbejött valami','Betegség','Egyéb']);
const ADMIN=['admin','administrator','rendszergazda','superadmin','super_admin'];
const RECEPTION=['receptionist','recepciós','recepcios','reception'];
const BUSINESS=['location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager'];
const roles=(raw:any):string[]=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const parsed=JSON.parse(String(raw||''));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const anyRole=(r:string[],allowed:string[])=>r.some(x=>allowed.includes(x));
type Scope={isAdmin:boolean;locationId:string|null};
function resolveScope(req:AuthRequest):Scope|null{const r=roles(req.user?.role);if(anyRole(r,ADMIN))return{isAdmin:true,locationId:null};if(anyRole(r,[...RECEPTION,...BUSINESS]))return{isAdmin:false,locationId:req.user?.location_id?String(req.user.location_id):null};return null}
function requireEditor(req:AuthRequest,res:Response,next:NextFunction){const scope=resolveScope(req);if(!scope)return res.status(403).json({error:'Foglalást csak adminisztrátor, recepciós vagy üzletvezető mondhat le, illetve jelölhet meg nem jelentként.'});if(!scope.isAdmin&&!scope.locationId)return res.status(403).json({error:'A felhasználóhoz nincs szalon rendelve.'});(req as any).appointmentLifecycleScope=scope;next()}
router.use(requireEditor);

async function ensureLifecycleSchema(c:any){
  await c.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason text;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_note text;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_reason text;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status text NOT NULL DEFAULT 'draft';
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_note text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_by text;
  `);
}

async function terminate(req:AuthRequest,res:any,next:any,target:'cancelled'|'no_show'){
  const c=await db.connect();
  try{
    const reason=String(req.body?.reason||'').trim();
    const note=String(req.body?.note||'').trim();
    if(target==='cancelled'){
      if(!allowedCancelReasons.has(reason)) return res.status(400).json({error:'Válasszon lemondási okot: Közbejött valami, Betegség vagy Egyéb.'});
      if(reason==='Egyéb'&&!note) return res.status(400).json({error:'Egyéb lemondási ok esetén a megjegyzés kötelező.'});
    }else if(!reason){
      return res.status(400).json({error:'A meg nem jelenés oka kötelező.'});
    }

    await c.query('BEGIN');
    await ensureLifecycleSchema(c);
    const ap=(await c.query(`SELECT * FROM appointments WHERE id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];
    if(!ap){await c.query('ROLLBACK');return res.status(404).json({error:'A foglalás nem található.'});}
    const scope=(req as any).appointmentLifecycleScope as Scope;
    if(!scope.isAdmin&&String(ap.location_id||'')!==String(scope.locationId||'')){await c.query('ROLLBACK');return res.status(404).json({error:'A foglalás nem található ezen a szalonon.'});}
    if(String(ap.status||'')==='completed'){await c.query('ROLLBACK');return res.status(409).json({error:'Befejezett időpont nem mondható le és nem jelölhető meg nem jelenésnek.'});}
    if(String(ap.status||'')===target){await c.query('COMMIT');return res.json({appointment:ap,idempotent:true});}

    let wo:any=null;
    if(ap.work_order_id){
      wo=(await c.query(`SELECT * FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[ap.work_order_id])).rows[0]||null;
      if(wo?.locked_at||['completed','cancelled','no_show'].includes(String(wo?.status||''))){
        await c.query('ROLLBACK');
        return res.status(409).json({error:`A kapcsolódó ${wo?.work_order_number||'munkalap'} már lezárt/archivált; a foglalás állapota nem módosítható.`});
      }
      const payments=Number((await c.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id=$1`,[ap.work_order_id])).rows[0]?.total||0);
      if(payments>0||wo?.financial_closed_at){
        await c.query('ROLLBACK');
        return res.status(409).json({error:'A kapcsolódó munkalapon már van fizetés vagy pénzügyi zárás. Előbb pénzügyi sztornó/jóváírás szükséges.'});
      }
    }

    const updatedAp=(await c.query(target==='cancelled'
      ? `UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancellation_note=$3,cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE id=$1::uuid RETURNING *`
      : `UPDATE appointments SET status='no_show',no_show_reason=$2,no_show_at=COALESCE(no_show_at,now()),updated_at=now() WHERE id=$1::uuid RETURNING *`,
      target==='cancelled'?[req.params.id,reason,note||null]:[req.params.id,reason]
    )).rows[0];

    if(wo){
      await c.query(`UPDATE work_orders SET status=$2,document_status='cancelled',cancellation_reason=$3,cancellation_note=$4,cancelled_at=COALESCE(cancelled_at,now()),cancelled_by=$5,status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[wo.id,target,reason,note||null,actor(req)]);
      const hasHistory=(await c.query(`SELECT to_regclass('public.work_order_status_history') IS NOT NULL ok`)).rows[0]?.ok;
      if(hasHistory) await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata) VALUES($1,'document',$2,'cancelled',$3,$4,$5,$6::jsonb)`,[wo.id,wo.document_status||'draft',actor(req),target==='no_show'?'NO_SHOW':'APPOINTMENT_CANCELLED',note||reason,JSON.stringify({appointment_id:ap.id,appointment_status:target})]).catch(()=>undefined);
    }

    await c.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6)`,[ap.id,target,actor(req),JSON.stringify(ap),JSON.stringify(updatedAp),note||reason]).catch(()=>undefined);
    await c.query('COMMIT');
    res.json({appointment:updatedAp,work_order_id:wo?.id||null,work_order_number:wo?.work_order_number||null,work_order_cancelled:Boolean(wo),status:target});
  }catch(error:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    if(error?.code==='22P02')return res.status(400).json({error:'Érvénytelen foglalásazonosító.'});
    if(error?.code==='55000')return res.status(409).json({error:error?.message||'A lezárt munkalap miatt a művelet nem végezhető el.'});
    next(error);
  }finally{c.release();}
}

router.post('/appointments/:id/cancel',(req:AuthRequest,res,next)=>terminate(req,res,next,'cancelled'));
router.post('/appointments/:id/no-show',(req:AuthRequest,res,next)=>terminate(req,res,next,'no_show'));

export default router;
