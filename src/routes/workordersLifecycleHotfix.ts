import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';

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
const isTimestamp=(dataType:string)=>dataType==='timestamp with time zone'||dataType==='timestamp without time zone';

async function workOrderColumnTypes(){
  const q=await db.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders'`);
  return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]));
}

router.patch('/:id/lifecycle',async(req:AuthRequest,res,next)=>{
  try{
    if(!canEditRole(req.user?.role))return res.status(403).json({message:'A munkalapot csak adminisztrátor, recepciós vagy üzletvezető módosíthatja.'});

    const requested=String(req.body?.status||'').trim().toLowerCase();
    if(!STATUSES.has(requested))return res.status(400).json({message:'Érvénytelen munkalap státusz.'});
    if(requested==='completed')return res.status(409).json({message:'A munkalap nem zárható le közvetlen státuszváltással. Előbb zárja le a fizetést, majd használja a végleges munkalaplezárást.'});

    const row=(await db.query(`SELECT w.id::text id,
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

    // Fontos: itt NINCS request-time DDL, workflow bootstrap vagy constraint migráció.
    // A fizetés előtti egyszerű státuszváltás csak a biztosan típuskompatibilis mezőket írja.
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
    return res.json({...updated,hotfix:true});
  }catch(e:any){
    const code=String(e?.code||'');
    console.error('[workorders-lifecycle-hotfix] failed',code,e?.table||'',e?.column||'',e?.constraint||'',e?.message||e);
    if(code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.',error_code:code});
    if(code==='23514')return res.status(409).json({message:'A régi adatbázis státuszkorlátozása blokkolja az állapotváltást.',error_code:code,constraint:e?.constraint||undefined,detail:e?.message||undefined});
    if(code==='57014'||code==='55P03')return res.status(503).json({message:'Az adatbázis zárolása vagy timeout akadályozta a státuszváltást. Próbálja újra néhány másodperc múlva.',error_code:code});
    return next(e);
  }
});

export default router;
