import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {ensureBookingWorkOrder,ensureBookingWorkOrderSchema,type BookingWorkOrderResult} from '../services/bookingWorkOrder';

const router=Router();
router.use(requireAuth);
const ADMIN=['admin','administrator','rendszergazda','superadmin','super_admin'];
const RECEPTION=['receptionist','recepciós','recepcios','reception'];
const BUSINESS=['location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager'];
const roleList=(raw:any):string[]=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const parsed=JSON.parse(String(raw||''));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const hasAny=(roles:string[],allowed:string[])=>roles.some(role=>allowed.includes(role));
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'system');
type Scope={isAdmin:boolean;locationId:string|null};
function resolveScope(req:AuthRequest):Scope|null{const roles=roleList(req.user?.role);if(hasAny(roles,ADMIN))return{isAdmin:true,locationId:null};if(hasAny(roles,[...RECEPTION,...BUSINESS]))return{isAdmin:false,locationId:req.user?.location_id?String(req.user.location_id):null};return null}
function requireBridgeAccess(req:AuthRequest,res:Response,next:NextFunction){const scope=resolveScope(req);if(!scope)return res.status(403).json({message:'A foglalás–munkalap kapcsolatot csak adminisztrátor, recepciós vagy üzletvezető kezelheti.'});if(!scope.isAdmin&&!scope.locationId)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});(req as any).bookingWorkOrderScope=scope;next()}
router.use(requireBridgeAccess);
async function assertVisible(c:any,id:string,scope:Scope){const ap=(await c.query(`SELECT id::text,location_id::text FROM appointments WHERE id=$1::uuid`,[id])).rows[0];if(!ap){const e:any=new Error('A foglalás nem található.');e.httpStatus=404;throw e}if(!scope.isAdmin&&String(ap.location_id||'')!==String(scope.locationId||'')){const e:any=new Error('A foglalás nem található ezen a szalonon.');e.httpStatus=404;throw e}}

router.post('/ensure',async(req:AuthRequest,res,next)=>{
  const sourceIds:any[]=Array.isArray(req.body?.appointment_ids)?req.body.appointment_ids:[];
  const ids:string[]=Array.from(new Set<string>(sourceIds.map((value:any)=>String(value)).filter(Boolean))).slice(0,100);
  if(!ids.length)return res.json({items:[]});
  const c=await db.connect();
  try{
    await ensureBookingWorkOrderSchema(c);
    await c.query('BEGIN');
    const scope=(req as any).bookingWorkOrderScope as Scope;
    const items:BookingWorkOrderResult[]=[];
    for(const id of ids){await assertVisible(c,id,scope);items.push(await ensureBookingWorkOrder(c,id,actor(req)))}
    await c.query('COMMIT');res.json({items});
  }catch(error:any){await c.query('ROLLBACK').catch(()=>undefined);if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen foglalásazonosító.'});if(error?.httpStatus)return res.status(error.httpStatus).json({message:error.message});next(error)}finally{c.release()}
});

router.post('/appointments/:id/arrive',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    await ensureBookingWorkOrderSchema(c);
    await c.query('BEGIN');
    const scope=(req as any).bookingWorkOrderScope as Scope;
    await assertVisible(c,String(req.params.id),scope);
    const ensured=await ensureBookingWorkOrder(c,String(req.params.id),actor(req));
    if(!ensured.work_order_id){await c.query('ROLLBACK');return res.status(409).json({message:'Ehhez a foglaláshoz ebben az állapotban nem készíthető munkalap.'})}
    const ap=(await c.query(`SELECT id::text,status FROM appointments WHERE id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];
    const wo=(await c.query(`SELECT id::text,work_order_number,status,locked_at,archived_at FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[ensured.work_order_id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A kapcsolódó munkalap nem található.'})}
    if(wo.locked_at||wo.archived_at){await c.query('ROLLBACK');return res.status(409).json({message:`A(z) ${wo.work_order_number||'munkalap'} már lezárt és archivált.`})}
    const apStatus=String(ap?.status||'').toLowerCase();
    if(!['in_progress','completed'].includes(apStatus))await c.query(`UPDATE appointments SET status='arrived',updated_at=now() WHERE id=$1::uuid`,[req.params.id]);
    if(!['in_progress','completed','cancelled','no_show'].includes(String(wo.status||'').toLowerCase())){
      await c.query(`UPDATE work_orders SET status='arrived',status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[wo.id]);
      const hasHistory=(await c.query(`SELECT to_regclass('public.work_order_status_history') IS NOT NULL ok`)).rows[0]?.ok;
      if(hasHistory)await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata) VALUES($1,'operational',$2,'arrived',$3,'APPOINTMENT_ARRIVAL',$4,$5::jsonb)`,[wo.id,wo.status||'waiting',actor(req),'Vendég érkeztetése a foglalási naptárból',JSON.stringify({appointment_id:req.params.id})]).catch(()=>undefined)
    }
    await c.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,note) VALUES($1::uuid,'arrived',$2,$3)`,[req.params.id,actor(req),`Kapcsolt munkalap: ${wo.work_order_number||wo.id}`]).catch(()=>undefined);
    await c.query('COMMIT');res.json({ok:true,appointment_id:req.params.id,appointment_status:apStatus==='in_progress'?'in_progress':'arrived',work_order_id:wo.id,work_order_number:wo.work_order_number,created:ensured.created});
  }catch(error:any){await c.query('ROLLBACK').catch(()=>undefined);if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen foglalásazonosító.'});if(error?.httpStatus)return res.status(error.httpStatus).json({message:error.message});next(error)}finally{c.release()}
});

export default router;
