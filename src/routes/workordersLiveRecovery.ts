import type {Request,Response,NextFunction} from 'express';
import db from '../db';
import repairBookingWorkOrderStatusConstraints from '../booking/repairBookingWorkOrderStatusConstraints';
import {ensureWorkOrderWorkflow} from '../workorders/ensureWorkOrderWorkflow';

const WORK_ORDER_STATUSES=new Set(['waiting','arrived','in_progress','completed','cancelled','no_show']);
const WORK_ORDER_NEXT:Record<string,Set<string>>={
  waiting:new Set(['arrived','in_progress','cancelled','no_show']),
  arrived:new Set(['in_progress','cancelled','no_show']),
  in_progress:new Set(['cancelled']),
  completed:new Set(),cancelled:new Set(),no_show:new Set()
};

async function relationExists(name:string){
  const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);
  return Boolean(q.rows[0]?.ok);
}
async function tableColumns(name:string){
  const q=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[name]);
  return new Set<string>(q.rows.map((r:any)=>String(r.column_name)));
}
const jsonText=(alias:string,key:string)=>`NULLIF(BTRIM(COALESCE(to_jsonb(${alias})->>'${key}','')),'')`;
const safeNumeric=(alias:string,keys:string[],fallback='0')=>`COALESCE(${keys.map(key=>`CASE WHEN replace(${jsonText(alias,key)},',','.') ~ '^-?[0-9]+([.][0-9]+)?$' THEN replace(${jsonText(alias,key)},',','.')::numeric END`).join(',')},${fallback}::numeric)`;
const safeInteger=(alias:string,key:string,fallback=30)=>`COALESCE(CASE WHEN ${jsonText(alias,key)} ~ '^-?[0-9]+$' THEN ${jsonText(alias,key)}::int END,${fallback})::int`;

async function recoverCatalog(req:Request,res:Response,originalError:any){
  if(!(req as any).workOrderScope)throw originalError;
  await repairBookingWorkOrderStatusConstraints(db);
  const warnings:any[]=[];
  let services:any[]=[];let products:any[]=[];

  if(await relationExists('services')){
    try{
      const q=await db.query(`SELECT s.id::text id,
        COALESCE(${jsonText('s','name')},'Szolgáltatás') name,
        ${safeNumeric('s',['promo_price','list_price','base_price','price'])} price,
        ${safeInteger('s','duration_minutes',30)} duration_minutes,
        'Egyéb'::text category_name
        FROM services s ORDER BY name`);
      services=q.rows;
    }catch(error:any){
      warnings.push({section:'services',code:String(error?.code||'unknown')});
      console.warn('[workorders] recovered catalog services unavailable',error?.code||'',error?.message||error);
    }
  }else warnings.push({section:'services',code:'relation_missing'});

  if(await relationExists('products')){
    try{
      const q=await db.query(`SELECT p.id::text id,
        COALESCE(${jsonText('p','name')},'Termék') name,
        ${safeNumeric('p',['sale_price','retail_price_gross','price'])} price,
        COALESCE(${jsonText('p','main_category')},${jsonText('p','sub_category')},${jsonText('p','category_name')},'Termék') category_name
        FROM products p ORDER BY name`);
      products=q.rows;
    }catch(error:any){
      warnings.push({section:'products',code:String(error?.code||'unknown')});
      console.warn('[workorders] recovered catalog products unavailable',error?.code||'',error?.message||error);
    }
  }else warnings.push({section:'products',code:'relation_missing'});

  return res.json({services,products,recovered:true,schema_warnings:warnings});
}

async function recoverLifecycle(req:Request,res:Response,originalError:any){
  const scope:any=(req as any).workOrderScope;
  if(!scope?.canEdit)throw originalError;
  await repairBookingWorkOrderStatusConstraints(db);
  await ensureWorkOrderWorkflow(db);

  const row=(await db.query(`SELECT id::text,status,location_id::text,
      NULLIF(to_jsonb(work_orders)->>'locked_at','')::timestamptz locked_at,
      NULLIF(to_jsonb(work_orders)->>'archived_at','')::timestamptz archived_at
      FROM work_orders WHERE id::text=$1 LIMIT 1`,[req.params.id])).rows[0];
  if(!row)return res.status(404).json({message:'A munkalap nem található.'});
  if(scope.kind==='location'&&String(row.location_id||'')!==String(scope.locationId||''))return res.status(404).json({message:'Másik szalon munkalapja nem módosítható.'});
  if(row.locked_at||row.archived_at)return res.status(409).json({message:'A munkalap lezárt és archivált; nem módosítható.'});

  const status=String((req as any).body?.status||'').trim().toLowerCase();
  if(!WORK_ORDER_STATUSES.has(status))return res.status(400).json({message:'Érvénytelen munkalap státusz.'});
  if(status==='completed')return res.status(409).json({message:'A munkalap nem zárható le közvetlen státuszváltással. Előbb zárja le a fizetést, majd használja a végleges munkalaplezárást.'});
  const current=String(row.status||'waiting').toLowerCase();
  if(status===current)return res.json(row);
  if(!WORK_ORDER_NEXT[current]?.has(status))return res.status(409).json({message:`Nem engedélyezett státuszváltás: ${current} → ${status}.`});

  const cols=await tableColumns('work_orders');
  const sets:string[]=['status=$2'];
  if(cols.has('started_at'))sets.push(`started_at=CASE WHEN $2='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END`);
  if(cols.has('work_started_at'))sets.push(`work_started_at=CASE WHEN $2='in_progress' THEN COALESCE(work_started_at,now()) ELSE work_started_at END`);
  if(cols.has('arrival_at'))sets.push(`arrival_at=CASE WHEN $2='arrived' THEN COALESCE(arrival_at,now()) ELSE arrival_at END`);
  if(cols.has('cancelled_at'))sets.push(`cancelled_at=CASE WHEN $2 IN ('cancelled','no_show') THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END`);
  if(cols.has('status_updated_at'))sets.push('status_updated_at=now()');
  if(cols.has('updated_at'))sets.push('updated_at=now()');
  if(cols.has('document_status'))sets.push(`document_status=CASE WHEN $2 IN ('cancelled','no_show') THEN 'cancelled' WHEN $2='in_progress' THEN 'open' ELSE COALESCE(document_status,'draft') END`);

  const q=await db.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,[req.params.id,status]);
  return res.json({...q.rows[0],recovered:true});
}

export default async function workordersLiveRecovery(error:any,req:Request,res:Response,next:NextFunction){
  if(res.headersSent)return next(error);
  try{
    const path=String(req.path||'');
    if(req.method==='GET'&&/^\/[^/]+\/catalog\/?$/.test(path)){
      console.error('[workorders] catalog live recovery',error?.code||'',error?.table||'',error?.column||'',error?.message||error);
      return await recoverCatalog(req,res,error);
    }
    if(req.method==='PATCH'&&/^\/[^/]+\/lifecycle\/?$/.test(path)){
      console.error('[workorders] lifecycle live recovery',error?.code||'',error?.table||'',error?.column||'',error?.constraint||'',error?.message||error);
      return await recoverLifecycle(req,res,error);
    }
    return next(error);
  }catch(recoveryError:any){
    console.error('[workorders] live recovery failed',recoveryError?.code||'',recoveryError?.table||'',recoveryError?.column||'',recoveryError?.constraint||'',recoveryError?.message||recoveryError);
    const code=String(recoveryError?.code||'');
    if(['42P01','42703','42804','23502','23503','23514','25P02','55000'].includes(code)){
      return res.status(503).json({
        message:'A munkalap live adatbázis-sémája még nem teljesen kompatibilis.',
        error_code:code,
        table:recoveryError?.table||undefined,
        column:recoveryError?.column||undefined,
        constraint:recoveryError?.constraint||undefined,
        stage:req.method==='GET'?'catalog-recovery':'lifecycle-recovery'
      });
    }
    return next(recoveryError);
  }
}