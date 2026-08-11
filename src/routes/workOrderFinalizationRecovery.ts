import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {generateAndDeliverClosedWorkOrder,loadWorkOrderArchive,renderClosedWorkOrderPdf} from '../workorders/workOrderDocument';

const router=Router();
router.use(requireAuth);

const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'system');

async function tableExists(c:any,table:string){
  const q=await c.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`]);
  return Boolean(q.rows[0]?.ok);
}

async function columnExists(c:any,table:string,column:string){
  const q=await c.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) ok`,[table,column]);
  return Boolean(q.rows[0]?.ok);
}

async function safeDDL(c:any,sql:string,label:string){
  try{await c.query(sql);return true}
  catch(e:any){console.warn(`[workorder-finalization-recovery] ${label} skipped`,e?.code||'',e?.message||e);return false}
}

async function ensureCoreSchema(c:any){
  await safeDDL(c,`CREATE EXTENSION IF NOT EXISTS pgcrypto`,'pgcrypto');
  const workOrderColumns:[string,string][]=[
    ['work_order_number','text'],['document_status',`text DEFAULT 'draft'`],['completed_at','timestamptz'],['closed_at','timestamptz'],
    ['closed_by','text'],['locked_at','timestamptz'],['locked_reason','text'],['archived_at','timestamptz'],['archive_hash','text'],
    ['status_updated_at','timestamptz'],['financial_closed_at','timestamptz'],['financial_closed_by','text'],['payment_status',`text DEFAULT 'unpaid'`]
  ];
  for(const[col,type]of workOrderColumns)await safeDDL(c,`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS ${col} ${type}`,`work_orders.${col}`);
  if(await tableExists(c,'work_order_items'))await safeDDL(c,`ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,'work_order_items.created_at');
  if(await tableExists(c,'work_order_payments'))await safeDDL(c,`ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS paid_at timestamptz NOT NULL DEFAULT now()`,'work_order_payments.paid_at');
  await safeDDL(c,`CREATE TABLE IF NOT EXISTS work_order_archive(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id uuid NOT NULL,
    work_order_number text NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now(),
    terminal_status text NOT NULL,
    snapshot jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    pdf_generated_at timestamptz,
    email_sent_at timestamptz,
    email_status text,
    email_recipients jsonb,
    email_error text
  )`,'work_order_archive');
  for(const[col,type]of [['pdf_generated_at','timestamptz'],['email_sent_at','timestamptz'],['email_status','text'],['email_recipients','jsonb'],['email_error','text']] as [string,string][])await safeDDL(c,`ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS ${col} ${type}`,`work_order_archive.${col}`);
}

async function ensureWorkOrderNumber(c:any,wo:any){
  if(String(wo.work_order_number||'').trim())return String(wo.work_order_number);
  const year=new Date(wo.created_at||Date.now()).getFullYear();
  const fallback=`KLEO-ML-${year}-${String(wo.id).replace(/-/g,'').slice(0,12).toUpperCase()}`;
  await c.query(`UPDATE work_orders SET work_order_number=$2 WHERE id=$1::uuid AND (work_order_number IS NULL OR btrim(work_order_number)='')`,[wo.id,fallback]);
  return fallback;
}

async function snapshotFor(c:any,workOrderId:string,header:any){
  const items=await tableExists(c,'work_order_items')?(await c.query(`SELECT * FROM work_order_items WHERE work_order_id::text=$1 ORDER BY id`,[workOrderId])).rows:[];
  const payments=await tableExists(c,'work_order_payments')?(await c.query(`SELECT * FROM work_order_payments WHERE work_order_id::text=$1 ORDER BY id`,[workOrderId])).rows:[];
  return{header,items,payments};
}

async function upsertArchive(c:any,workOrder:any){
  const existing=(await c.query(`SELECT * FROM work_order_archive WHERE work_order_id::text=$1 ORDER BY archived_at DESC LIMIT 1`,[workOrder.id])).rows[0];
  if(existing)return existing;
  const snapshot=await snapshotFor(c,String(workOrder.id),workOrder);
  const hash=(await c.query(`SELECT encode(digest(convert_to($1::text,'UTF8'),'sha256'),'hex') hash`,[JSON.stringify(snapshot)])).rows[0]?.hash||'';
  const number=String(workOrder.work_order_number||await ensureWorkOrderNumber(c,workOrder));
  return (await c.query(`INSERT INTO work_order_archive(work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash)
    VALUES($1::uuid,$2,COALESCE($3::timestamptz,now()),$4,$5::jsonb,$6) RETURNING *`,[
      workOrder.id,number,workOrder.archived_at||workOrder.locked_at||workOrder.completed_at||new Date().toISOString(),String(workOrder.status||'completed'),JSON.stringify(snapshot),hash
    ])).rows[0];
}

async function optionalPostProcessing(c:any,workOrder:any,by:string){
  const warnings:string[]=[];
  if(workOrder.appointment_id&&await tableExists(c,'appointments')){
    try{
      const sets=[`status='completed'`];const params:any[]=[workOrder.appointment_id];
      if(await columnExists(c,'appointments','work_order_id')){params.push(workOrder.id);sets.push(`work_order_id=COALESCE(work_order_id,$${params.length}::uuid)`)}
      if(await columnExists(c,'appointments','work_order_number')){params.push(workOrder.work_order_number||null);sets.push(`work_order_number=COALESCE(work_order_number,$${params.length})`)}
      await c.query(`UPDATE appointments SET ${sets.join(',')} WHERE id::text=$1`,params);
    }catch(e:any){warnings.push(`Időpont lezárási szinkron: ${e?.message||e}`)}
  }
  if(await tableExists(c,'work_order_status_history')){
    try{await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata)
      VALUES($1::uuid,'document',$2,'completed',$3,'FINALIZATION_RECOVERY',$4,'{}'::jsonb)`,[workOrder.id,'open',by,'Végleges lezárás recovery útvonalon.'])}
    catch(e:any){warnings.push(`Státusztörténet: ${e?.message||e}`)}
  }
  return warnings;
}

router.post('/workorders/:id/finalize',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    await ensureCoreSchema(c);
    await c.query('BEGIN');
    let wo=(await c.query(`SELECT * FROM work_orders WHERE id::text=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}

    const number=await ensureWorkOrderNumber(c,wo);wo={...wo,work_order_number:number};
    if(wo.locked_at||wo.archived_at||String(wo.status||'')==='completed'){
      const archive=await upsertArchive(c,wo);await c.query('COMMIT');
      let delivery:any=null;try{delivery=await generateAndDeliverClosedWorkOrder(String(wo.id),{sendMail:true,forceMail:false})}catch(e:any){delivery={mail:{sent:false,error:String(e?.message||e)}}}
      const{pdf,...deliveryMeta}=delivery||{};
      return res.json({idempotent:true,finalized:true,work_order:wo,archive,delivery:deliveryMeta,message:'A munkalap már lezárt; az archív dokumentum ellenőrizve.'});
    }

    if(String(wo.status||'')!=='in_progress'){
      await c.query('ROLLBACK');return res.status(409).json({message:'A munkalap csak Folyamatban állapotból zárható véglegesen.',code:'WORKORDER_NOT_IN_PROGRESS'});
    }
    if(String(wo.payment_status||'')!=='paid'||!wo.financial_closed_at){
      await c.query('ROLLBACK');return res.status(409).json({message:'A munkalap csak teljesen kifizetett és pénzügyileg lezárt állapotban véglegesíthető.',code:'WORKORDER_NOT_FINANCIALLY_CLOSED'});
    }

    const sets=[`status='completed'`];const params:any[]=[wo.id];
    const add=async(col:string,expr:string,value?:any)=>{if(await columnExists(c,'work_orders',col)){if(arguments.length>2){params.push(value);sets.push(`${col}=${expr.replace('?',`$${params.length}`)}`)}else sets.push(`${col}=${expr}`)}};
    await add('document_status',`'completed'`);
    await add('completed_at',`COALESCE(completed_at,now())`);
    await add('closed_at',`COALESCE(closed_at,now())`);
    if(await columnExists(c,'work_orders','closed_by')){params.push(actor(req));sets.push(`closed_by=COALESCE(closed_by,$${params.length})`)}
    await add('locked_at',`COALESCE(locked_at,now())`);
    await add('locked_reason',`COALESCE(locked_reason,'TERMINAL_STATUS:COMPLETED')`);
    await add('archived_at',`COALESCE(archived_at,now())`);
    await add('status_updated_at',`now()`);
    if(await columnExists(c,'work_orders','updated_at'))sets.push(`updated_at=now()`);

    wo=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id=$1::uuid RETURNING *`,params)).rows[0];
    const archive=await upsertArchive(c,wo);
    if(await columnExists(c,'work_orders','archive_hash'))await c.query(`UPDATE work_orders SET archive_hash=COALESCE(archive_hash,$2) WHERE id=$1::uuid`,[wo.id,archive.snapshot_hash]).catch(()=>undefined);
    const warnings=await optionalPostProcessing(c,wo,actor(req));
    await c.query('COMMIT');

    let delivery:any=null;
    try{delivery=await generateAndDeliverClosedWorkOrder(String(wo.id),{sendMail:true,forceMail:false})}
    catch(e:any){delivery={mail:{sent:false,error:String(e?.message||e)}};warnings.push(`PDF/e-mail: ${String(e?.message||e)}`)}
    const{pdf,...deliveryMeta}=delivery||{};
    return res.json({finalized:true,recovery:true,work_order:wo,archive,warnings,delivery:deliveryMeta});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    console.error('[workorder-finalization-recovery] finalize failed',e?.code||'',e?.message||e);
    next(e);
  }finally{c.release()}
});

router.get('/workorders/:id/pdf',async(req,res,next)=>{
  const c=await db.connect();
  try{
    await ensureCoreSchema(c);
    const archive=await loadWorkOrderArchive(req.params.id);
    if(!archive)return res.status(409).json({message:'A PDF a munkalap végleges lezárása és archiválása után készíthető el.',code:'WORKORDER_NOT_ARCHIVED'});
    const pdf=await renderClosedWorkOrderPdf(archive);
    await db.query(`UPDATE work_order_archive SET pdf_generated_at=now() WHERE work_order_id::text=$1`,[req.params.id]).catch(()=>undefined);
    const filename=`${archive.work_order_number||'lezart-munkalap'}.pdf`.replace(/[^A-Za-z0-9._-]/g,'_');
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.setHeader('Content-Length',String(pdf.length));return res.send(pdf);
  }catch(e){next(e)}finally{c.release()}
});

router.post('/workorders/:id/email',async(req,res,next)=>{
  const c=await db.connect();
  try{
    await ensureCoreSchema(c);
    const archive=await loadWorkOrderArchive(req.params.id);
    if(!archive)return res.status(409).json({message:'E-mail csak véglegesen lezárt és archivált munkalapról küldhető.',code:'WORKORDER_NOT_ARCHIVED'});
    const delivery=await generateAndDeliverClosedWorkOrder(req.params.id,{sendMail:true,forceMail:true});const{pdf,...meta}=delivery;return res.json(meta);
  }catch(e){next(e)}finally{c.release()}
});

export default router;
