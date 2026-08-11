import {Router} from 'express';
import crypto from 'crypto';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {generateAndDeliverClosedWorkOrder,loadWorkOrderArchive,renderClosedWorkOrderPdf} from '../workorders/workOrderDocument';

const router=Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'system');

async function tableExists(name:string){const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);return Boolean(q.rows[0]?.ok)}
async function columns(table:string){const q=await db.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]))}
const timestampLike=(t:string|undefined)=>t==='timestamp with time zone'||t==='timestamp without time zone';
const textLike=(t:string|undefined)=>['text','character varying','character'].includes(String(t||''));

async function orderedRows(c:any,table:string,workOrderId:string,preferred:string){
  const cols=await columns(table);const order=cols.has(preferred)?`${preferred},id`:'id';
  return (await c.query(`SELECT * FROM ${table} WHERE work_order_id::text=$1 ORDER BY ${order}`,[workOrderId])).rows;
}

async function ensureArchiveRow(c:any,wo:any,terminalStatus='completed'){
  const existing=(await c.query(`SELECT * FROM work_order_archive WHERE work_order_id::text=$1 ORDER BY archived_at DESC LIMIT 1`,[String(wo.id)])).rows[0];
  if(existing)return existing;
  const [items,payments]=await Promise.all([
    orderedRows(c,'work_order_items',String(wo.id),'created_at'),
    orderedRows(c,'work_order_payments',String(wo.id),'paid_at'),
  ]);
  const snapshotHeader={...wo,status:terminalStatus};
  const snapshot={header:snapshotHeader,items,payments};
  const hash=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const number=String(wo.work_order_number||`KLEO-ML-${new Date().getFullYear()}-${String(wo.id).replace(/-/g,'').slice(0,12).toUpperCase()}`);
  return (await c.query(`INSERT INTO work_order_archive(work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash) VALUES($1::uuid,$2,COALESCE($3::timestamptz,now()),$4,$5::jsonb,$6) RETURNING *`,[wo.id,number,wo.archived_at||wo.locked_at||wo.completed_at||new Date().toISOString(),terminalStatus,JSON.stringify(snapshot),hash])).rows[0];
}

async function deliverNow(workOrderId:string,forceMail=false){
  try{
    const delivery=await generateAndDeliverClosedWorkOrder(workOrderId,{sendMail:true,forceMail});
    const{pdf,...meta}=delivery;
    return{pdf_ready:Boolean(pdf?.length),pdf_bytes:Number(pdf?.length||0),delivery:meta};
  }catch(e:any){
    console.warn('[workorder-finalization-fast] document delivery failed',e?.message||e);
    return{pdf_ready:false,pdf_bytes:0,delivery:{mail:{attempted:true,sent:false,error:String(e?.message||e)}}};
  }
}

router.post('/workorders/:id/finalize',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    const [hasOrders,hasItems,hasPayments,hasArchive]=await Promise.all([tableExists('work_orders'),tableExists('work_order_items'),tableExists('work_order_payments'),tableExists('work_order_archive')]);
    if(!hasOrders||!hasItems||!hasPayments||!hasArchive)return next();
    const woCols=await columns('work_orders');
    await c.query('BEGIN');
    let wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
    const j=wo._json||{};

    if(j.locked_at||j.archived_at||String(wo.status||'')==='completed'){
      const archive=await ensureArchiveRow(c,wo,'completed');await c.query('COMMIT');
      const docs=await deliverNow(String(wo.id),false);
      return res.json({idempotent:true,finalized:true,work_order:{...wo,status:'completed'},archive,fast:true,...docs});
    }
    if(['cancelled','no_show'].includes(String(wo.status||''))){await c.query('ROLLBACK');return res.status(409).json({message:'Lemondott vagy meg nem jelent munkalap nem zárható teljesítettként.',code:'WORKORDER_TERMINAL_CANCELLED'})}

    const [grossQ,paidQ]=await Promise.all([
      c.query(`SELECT COALESCE(SUM(line_total),0)::numeric gross FROM work_order_items WHERE work_order_id::text=$1`,[req.params.id]),
      c.query(`SELECT COALESCE(SUM(amount),0)::numeric paid FROM work_order_payments WHERE work_order_id::text=$1`,[req.params.id]),
    ]);
    const gross=Number(grossQ.rows[0]?.gross||0),paid=Number(paidQ.rows[0]?.paid||0),discount=Number(j.discount_amount||0),tip=Number(j.tip_amount||0),due=Math.max(0,gross-discount+tip);
    const financiallyClosed=Boolean(j.financial_closed_at)&&String(j.payment_status||'')==='paid';
    if(!financiallyClosed||paid+.009<due){await c.query('ROLLBACK');return res.status(409).json({message:'A munkalap csak teljesen kifizetett és pénzügyileg lezárt állapotban véglegesíthető.',code:'WORKORDER_NOT_FINANCIALLY_CLOSED',amount_due:due,amount_paid:paid})}

    const params:any[]=[wo.id];
    const buildSets=(includeStatus:boolean)=>{
      const sets:string[]=[];
      if(includeStatus)sets.push(`status='completed'`);
      if(woCols.has('payment_status'))sets.push(`payment_status='paid'`);
      if(woCols.has('fully_paid'))sets.push(`fully_paid=true`);
      if(woCols.has('gross_total')){params.push(gross);sets.push(`gross_total=$${params.length}`)}
      if(woCols.has('amount_due')){params.push(due);sets.push(`amount_due=$${params.length}`)}
      if(woCols.has('amount_paid')){params.push(paid);sets.push(`amount_paid=$${params.length}`)}
      if(woCols.has('financial_closed_at'))sets.push(`financial_closed_at=COALESCE(financial_closed_at,now())`);
      if(woCols.has('financial_closed_by')&&textLike(woCols.get('financial_closed_by'))){params.push(actor(req));sets.push(`financial_closed_by=COALESCE(financial_closed_by,$${params.length})`)}
      if(woCols.has('document_status'))sets.push(`document_status='completed'`);
      if(timestampLike(woCols.get('completed_at')))sets.push('completed_at=COALESCE(completed_at,now())');
      if(timestampLike(woCols.get('closed_at')))sets.push('closed_at=COALESCE(closed_at,now())');
      if(timestampLike(woCols.get('locked_at')))sets.push('locked_at=COALESCE(locked_at,now())');
      if(timestampLike(woCols.get('archived_at')))sets.push('archived_at=COALESCE(archived_at,now())');
      if(woCols.has('locked_reason'))sets.push(`locked_reason=COALESCE(locked_reason,'TERMINAL_STATUS:COMPLETED')`);
      if(woCols.has('closed_by')&&textLike(woCols.get('closed_by'))){params.push(actor(req));sets.push(`closed_by=COALESCE(closed_by,$${params.length})`)}
      if(timestampLike(woCols.get('status_updated_at')))sets.push('status_updated_at=now()');
      if(timestampLike(woCols.get('updated_at')))sets.push('updated_at=now()');
      return sets;
    };

    // Először normál completed státusszal próbáljuk. Ha egy régi CHECK/trigger ezt blokkolja,
    // a dokumentumot akkor is lezárjuk locked/archived állapottal; az archív snapshot terminal_status=completed lesz.
    await c.query('SAVEPOINT wo_finalize_status');
    let statusPersisted=true;
    let sets=buildSets(true);
    try{
      wo=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id=$1::uuid RETURNING *`,params)).rows[0];
    }catch(e:any){
      if(String(e?.code)!=='23514')throw e;
      await c.query('ROLLBACK TO SAVEPOINT wo_finalize_status');
      statusPersisted=false;
      params.splice(1);
      sets=buildSets(false);
      wo=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id=$1::uuid RETURNING *`,params)).rows[0];
    }
    await c.query('RELEASE SAVEPOINT wo_finalize_status');

    const archive=await ensureArchiveRow(c,{...wo,status:'completed'},'completed');
    if(woCols.has('archive_hash'))await c.query(`UPDATE work_orders SET archive_hash=COALESCE(archive_hash,$2) WHERE id=$1::uuid`,[wo.id,archive.snapshot_hash]).catch(()=>undefined);
    await c.query('COMMIT');

    const docs=await deliverNow(String(wo.id),false);
    return res.json({finalized:true,fast:true,status_persisted:statusPersisted,work_order:{...wo,status:'completed'},archive,...docs});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    console.error('[workorder-finalization-fast] failed',e?.code||'',e?.message||e);
    if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.',code:e.code});
    if(e?.code==='57014'||e?.code==='55P03')return res.status(503).json({message:'A munkalap lezárását adatbázis-zárolás vagy timeout akadályozta.',code:e.code});
    return next(e);
  }finally{c.release()}
});

router.get('/workorders/:id/pdf',async(req,res,next)=>{
  try{
    const archive=await loadWorkOrderArchive(req.params.id);
    if(!archive)return res.status(409).json({message:'A PDF a munkalap végleges lezárása után tölthető le.',code:'WORKORDER_NOT_ARCHIVED'});
    const pdf=await renderClosedWorkOrderPdf(archive);
    await db.query(`UPDATE work_order_archive SET pdf_generated_at=now() WHERE work_order_id::text=$1`,[req.params.id]).catch(()=>undefined);
    const filename=`${archive.work_order_number||'lezart-munkalap'}.pdf`.replace(/[^A-Za-z0-9._-]/g,'_');
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.setHeader('Content-Length',String(pdf.length));return res.send(pdf);
  }catch(e){next(e)}
});

router.post('/workorders/:id/email',async(req,res,next)=>{
  try{const delivery=await generateAndDeliverClosedWorkOrder(req.params.id,{sendMail:true,forceMail:true});const{pdf,...meta}=delivery;return res.json(meta)}catch(e){next(e)}
});

export default router;
