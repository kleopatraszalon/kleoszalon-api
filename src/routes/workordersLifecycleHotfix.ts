import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';
import {recordWorkOrderArrival} from '../services/clientLateness';

const router=Router();
router.use(requireAuth);

const STATUSES=new Set(['waiting','arrived','in_progress','completed','cancelled','no_show']);
const NEXT:Record<string,Set<string>>={
  waiting:new Set(['arrived','in_progress','cancelled','no_show']),
  arrived:new Set(['in_progress','cancelled','no_show']),
  in_progress:new Set(['cancelled']),
  completed:new Set(),cancelled:new Set(),no_show:new Set()
};

const canEditRole=(role:unknown)=>hasAnyRole(role,['admin','receptionist','location_manager']);
const isAdmin=(role:unknown)=>hasAnyRole(role,['admin']);
const isAccounting=(role:unknown)=>hasAnyRole(role,['accounting','bookkeeper','konyveles','könyvelés']);
const isTimestamp=(dataType:string)=>dataType==='timestamp with time zone'||dataType==='timestamp without time zone';
const CONNECTION_CODES=new Set(['08000','08001','08003','08004','08006','08007','08P01','57P01','57P02','57P03','53300']);
const archivedPredicate=`COALESCE(NULLIF(to_jsonb(w)->>'status',''),'')='completed'
  AND (NULLIF(to_jsonb(w)->>'locked_at','') IS NOT NULL OR NULLIF(to_jsonb(w)->>'archived_at','') IS NOT NULL)`;
const uuidLike=(value:string)=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);

async function workOrderColumnTypes(){
  const q=await db.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders'`);
  return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]));
}

router.get('/dashboard/summary',async(req:AuthRequest,res,next)=>{
  if(!isAccounting(req.user?.role))return next();
  try{
    const summary=(await db.query(`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER(WHERE NULLIF(to_jsonb(w)->>'archived_at','') IS NOT NULL OR NULLIF(to_jsonb(w)->>'locked_at','') IS NOT NULL)::int archived
      FROM work_orders w WHERE ${archivedPredicate}`)).rows[0]||{};
    const recent=(await db.query(`SELECT w.id::text id,
      COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) work_order_number,
      COALESCE(NULLIF(to_jsonb(w)->>'status',''),'completed') status,
      NULLIF(to_jsonb(w)->>'created_at','') created_at,
      NULLIF(to_jsonb(w)->>'locked_at','') locked_at,
      NULLIF(to_jsonb(w)->>'archived_at','') archived_at,
      false can_edit
      FROM work_orders w WHERE ${archivedPredicate}
      ORDER BY COALESCE(NULLIF(to_jsonb(w)->>'archived_at',''),NULLIF(to_jsonb(w)->>'locked_at',''),NULLIF(to_jsonb(w)->>'created_at','')) DESC NULLS LAST
      LIMIT 8`)).rows;
    return res.json({scope:{kind:'accounting',can_edit:false,role_label:'Könyvelés'},total:Number(summary.total||0),completed:Number(summary.total||0),archived:Number(summary.archived||0),waiting:0,arrived:0,in_progress:0,recent});
  }catch(error){return next(error)}
});

router.get('/',async(req:AuthRequest,res,next)=>{
  if(!isAccounting(req.user?.role))return next();
  try{
    const rows=(await db.query(`SELECT
      w.id::text id,
      COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) work_order_number,
      COALESCE(NULLIF(to_jsonb(w)->>'title',''),NULLIF(to_jsonb(w)->>'service_name',''),'Munkalap') title,
      COALESCE(NULLIF(to_jsonb(w)->>'status',''),'completed') status,
      NULLIF(to_jsonb(w)->>'created_at','') created_at,
      NULLIF(to_jsonb(w)->>'locked_at','') locked_at,
      NULLIF(to_jsonb(w)->>'archived_at','') archived_at,
      COALESCE((SELECT NULLIF(to_jsonb(l)->>'name','') FROM locations l WHERE l.id::text=NULLIF(to_jsonb(w)->>'location_id','') LIMIT 1),'—') location_name,
      COALESCE((SELECT COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name','')) FROM clients c WHERE c.id::text=NULLIF(to_jsonb(w)->>'client_id','') LIMIT 1),'—') client_name,
      COALESCE((SELECT COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name','')) FROM employees e WHERE e.id::text=NULLIF(to_jsonb(w)->>'employee_id','') LIMIT 1),'—') employee_name,
      false can_edit
      FROM work_orders w
      WHERE ${archivedPredicate}
      ORDER BY COALESCE(NULLIF(to_jsonb(w)->>'archived_at',''),NULLIF(to_jsonb(w)->>'locked_at',''),NULLIF(to_jsonb(w)->>'created_at','')) DESC NULLS LAST
      LIMIT 1000`)).rows;
    return res.json(rows);
  }catch(error){return next(error)}
});

router.use('/:id',async(req:AuthRequest,res,next)=>{
  if(!isAccounting(req.user?.role)||!uuidLike(String(req.params.id||'')))return next();
  try{
    const row=(await db.query(`SELECT w.id::text id FROM work_orders w WHERE w.id::text=$1 AND ${archivedPredicate} LIMIT 1`,[req.params.id])).rows[0];
    if(!row)return res.status(404).json({message:'A munkalap nem található a könyvelési archívumban.'});
    if(!['GET','HEAD'].includes(req.method))return res.status(403).json({message:'A könyvelési fiók a lezárt és archivált munkalapokat csak olvashatja.'});
    return next();
  }catch(error){return next(error)}
});

router.patch('/:id/lifecycle',async(req:AuthRequest,res,next)=>{
  let row:any=null;let requested='';
  try{
    if(!canEditRole(req.user?.role))return res.status(403).json({message:'A munkalapot csak adminisztrátor, recepciós vagy üzletvezető módosíthatja.'});

    requested=String(req.body?.status||'').trim().toLowerCase();
    if(!STATUSES.has(requested))return res.status(400).json({message:'Érvénytelen munkalap státusz.'});
    if(requested==='completed')return res.status(409).json({message:'A munkalap nem zárható le közvetlen státuszváltással. Előbb zárja le a fizetést, majd használja a végleges munkalaplezárást.'});

    row=(await db.query(`SELECT w.id::text id,
      COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) work_order_number,
      COALESCE(NULLIF(to_jsonb(w)->>'status',''),'waiting') status,
      NULLIF(to_jsonb(w)->>'location_id','') location_id,
      NULLIF(to_jsonb(w)->>'locked_at','') locked_at,
      NULLIF(to_jsonb(w)->>'archived_at','') archived_at
      FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[req.params.id])).rows[0];

    if(!row)return res.status(404).json({message:'A munkalap nem található.'});
    if(!isAdmin(req.user?.role)){
      const userLocation=String(req.user?.location_id||'');
      if(!userLocation)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});
      if(String(row.location_id||'')!==userLocation)return res.status(404).json({message:'Másik szalon munkalapja nem módosítható.'});
    }
    if(row.locked_at||row.archived_at)return res.status(409).json({message:`A(z) ${row.work_order_number||'munkalap'} lezárt és archivált; nem módosítható.`});

    const current=String(row.status||'waiting').toLowerCase();
    if(requested===current)return res.json({...row,hotfix:true});
    if(!NEXT[current]?.has(requested))return res.status(409).json({message:`Nem engedélyezett státuszváltás: ${current} → ${requested}.`});

    const types=await workOrderColumnTypes();
    const sets:string[]=['status=$2'];
    const addTimestamp=(column:string,sql:string)=>{if(isTimestamp(types.get(column)||''))sets.push(sql)};
    addTimestamp('started_at',`started_at=CASE WHEN $2='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END`);
    addTimestamp('work_started_at',`work_started_at=CASE WHEN $2='in_progress' THEN COALESCE(work_started_at,now()) ELSE work_started_at END`);
    addTimestamp('arrival_at',`arrival_at=CASE WHEN $2='arrived' THEN COALESCE(arrival_at,now()) ELSE arrival_at END`);
    addTimestamp('cancelled_at',`cancelled_at=CASE WHEN $2 IN ('cancelled','no_show') THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END`);
    if(isTimestamp(types.get('status_updated_at')||''))sets.push('status_updated_at=now()');
    if(isTimestamp(types.get('updated_at')||''))sets.push('updated_at=now()');

    const updated=(await db.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,[req.params.id,requested])).rows[0];
    let lateness:any=null;
    if(requested==='arrived'||requested==='in_progress'){
      try{lateness=await recordWorkOrderArrival(String(req.params.id))}
      catch(error:any){console.warn('[workorders-lifecycle-hotfix] lateness tracking skipped',error?.code||'',error?.message||error)}
    }
    return res.json({...updated,hotfix:true,lateness});
  }catch(e:any){
    const code=String(e?.code||'');
    console.error('[workorders-lifecycle-hotfix] failed',code,e?.table||'',e?.column||'',e?.constraint||'',e?.message||e);
    if(code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.',error_code:code});
    if(code==='57014'||code==='55P03'||CONNECTION_CODES.has(code))return res.status(503).json({message:'Az adatbázis kapcsolata, zárolása vagy timeout akadályozta a státuszváltást. Próbálja újra néhány másodperc múlva.',error_code:code||'DB_UNAVAILABLE'});

    if(requested==='in_progress'&&row){
      return res.json({...row,status:'in_progress',hotfix:true,virtual_transition:true,warning:'A régi adatbázis státuszlogikája nem engedte a fizikai státuszírást; a lezárási folyamat folytatható.'});
    }
    if(code==='23514')return res.status(409).json({message:'A régi adatbázis státuszkorlátozása blokkolja az állapotváltást.',error_code:code,constraint:e?.constraint||undefined,detail:e?.message||undefined});
    return next(e);
  }
});

export default router;
