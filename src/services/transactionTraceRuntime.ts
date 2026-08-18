import cron from "node-cron";
import db from "../db";
import {ensureTransactionTraceabilitySchema,verifyTransactionTrace} from "./transactionTraceability";

const TZ="Europe/Budapest";
let started=false;
const ROOT_TYPES=new Set(["work_order","purchase_order","booking","invoice"]);
const rootType=(v:unknown)=>{const s=String(v||"").trim();if(!ROOT_TYPES.has(s))throw Object.assign(new Error("Érvénytelen tranzakciótípus."),{status:400});return s};
const rootId=(v:unknown)=>{const s=String(v||"").trim();if(!s||s.length>160)throw Object.assign(new Error("Érvénytelen tranzakcióazonosító."),{status:400});return s};

async function exists(table:string){try{return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok)}catch{return false}}
async function rows(table:string,sql:string,params:any[]=[]){if(!(await exists(table)))return[];return(await db.query(sql,params)).rows}

const KEYS=['id','status','payment_status','approval_status','amount','gross_total','invoice_no','document_number','work_order_id','appointment_id','purchase_order_id','invoice_id','journal_entry_id','financial_movement_id','cashier_shift_id','location_id','movement_type','quantity','balance_after','completed_at','cancelled_at','reversed_by_id','created_at','updated_at','received_at','ordered_at','fully_paid','amount_due','total_price','direction','reference_type','reference_id'];
function safeEvidence(row:any){const out:any={};for(const k of KEYS)if(row?.[k]!=null&&row[k]!=="")out[k]=row[k];return out}

async function ensureSnapshot(rtype:string,rid:string,entityType:string,row:any,moduleKey:string,relation:string){
  if(!row)return;const eid=String(row.id??row.event_id??"").trim();if(!eid)return;
  const already=(await db.query(`SELECT 1 FROM business_transaction_entities e JOIN business_transaction_traces t ON t.trace_id=e.trace_id WHERE t.root_type=$1 AND t.root_id=$2 AND e.entity_type=$3 AND e.entity_id=$4 LIMIT 1`,[rtype,rid,entityType,eid])).rows[0];
  if(already)return;
  const occurred=row.updated_at||row.created_at||row.completed_at||row.received_at||row.ordered_at||new Date().toISOString();
  await db.query(`SELECT kleo_append_transaction_event($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::timestamptz)`,[
    rtype,rid,row.location_id==null?null:String(row.location_id),`${entityType}.snapshot`,entityType,eid,moduleKey,'snapshot',JSON.stringify(safeEvidence(row)),JSON.stringify({relation,legacy_backfill:true}),'legacy-backfill',null,occurred
  ]);
}

async function materializeWorkOrder(rid:string){
  const wo=(await rows('work_orders',`SELECT w.* FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[rid]))[0];
  if(!wo)throw Object.assign(new Error("A munkalap nem található."),{status:404});
  await ensureSnapshot('work_order',rid,'work_orders',wo,'workorder','root');
  const appointmentId=String(wo.appointment_id||'').trim();
  for(const row of await rows('appointments',`SELECT a.* FROM appointments a WHERE a.id::text=$1 OR NULLIF(to_jsonb(a)->>'work_order_id','')=$2 ORDER BY COALESCE(NULLIF(to_jsonb(a)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(a)->>'created_at','')::timestamptz,now())`,[appointmentId||'__none__',rid]))await ensureSnapshot('work_order',rid,'appointments',row,'booking','booking_source');
  for(const row of await rows('work_order_settlements',`SELECT x.* FROM work_order_settlements x WHERE x.work_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,NULLIF(to_jsonb(x)->>'completed_at','')::timestamptz,now())`,[rid]))await ensureSnapshot('work_order',rid,'work_order_settlements',row,'workorder','settlement');
  for(const row of await rows('work_order_payments',`SELECT x.* FROM work_order_payments x WHERE x.work_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]))await ensureSnapshot('work_order',rid,'work_order_payments',row,'finance','payment');
  for(const row of await rows('financial_movements',`SELECT x.* FROM financial_movements x WHERE NULLIF(to_jsonb(x)->>'work_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'occurred_at','')::timestamptz,NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]))await ensureSnapshot('work_order',rid,'financial_movements',row,'finance','ledger');
  const invoices=await rows('finance_invoices',`SELECT x.* FROM finance_invoices x WHERE NULLIF(to_jsonb(x)->>'work_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]);
  for(const row of invoices)await ensureSnapshot('work_order',rid,'finance_invoices',row,'finance','invoice');
  const invoiceIds=invoices.map((x:any)=>String(x.id||'')).filter(Boolean);
  if(invoiceIds.length)for(const row of await rows('nav_invoice_queue',`SELECT x.* FROM nav_invoice_queue x WHERE x.invoice_id::text=ANY($1::text[]) ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[invoiceIds]))await ensureSnapshot('work_order',rid,'nav_invoice_queue',row,'finance','nav');
  const journalIds=invoices.map((x:any)=>String(x.journal_entry_id||'')).filter(Boolean);
  if(journalIds.length)for(const row of await rows('accounting_journal_entries',`SELECT x.* FROM accounting_journal_entries x WHERE x.id::text=ANY($1::text[])`,[journalIds]))await ensureSnapshot('work_order',rid,'accounting_journal_entries',row,'finance','accounting');
  return wo;
}

async function materializePurchaseOrder(rid:string){
  const po=(await rows('purchase_orders',`SELECT x.* FROM purchase_orders x WHERE x.id::text=$1 LIMIT 1`,[rid]))[0];
  if(!po)throw Object.assign(new Error("A beszerzési rendelés nem található."),{status:404});
  await ensureSnapshot('purchase_order',rid,'purchase_orders',po,'procurement','root');
  for(const row of await rows('purchase_order_items',`SELECT x.* FROM purchase_order_items x WHERE x.purchase_order_id::text=$1`,[rid]))await ensureSnapshot('purchase_order',rid,'purchase_order_items',row,'procurement','item');
  for(const row of await rows('procurement_receipt_costs',`SELECT x.* FROM procurement_receipt_costs x WHERE x.purchase_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'received_at','')::timestamptz,NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]))await ensureSnapshot('purchase_order',rid,'procurement_receipt_costs',row,'procurement','receipt');
  for(const row of await rows('inventory_movements',`SELECT x.* FROM inventory_movements x WHERE NULLIF(to_jsonb(x)->>'source_record_type','')='purchase_order' AND NULLIF(to_jsonb(x)->>'source_record_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]))await ensureSnapshot('purchase_order',rid,'inventory_movements',row,'inventory','stock_receipt');
  const invoices=await rows('finance_invoices',`SELECT x.* FROM finance_invoices x WHERE NULLIF(to_jsonb(x)->>'purchase_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rid]);
  for(const row of invoices)await ensureSnapshot('purchase_order',rid,'finance_invoices',row,'finance','incoming_invoice');
  const journalIds=invoices.map((x:any)=>String(x.journal_entry_id||'')).filter(Boolean);
  if(journalIds.length)for(const row of await rows('accounting_journal_entries',`SELECT x.* FROM accounting_journal_entries x WHERE x.id::text=ANY($1::text[])`,[journalIds]))await ensureSnapshot('purchase_order',rid,'accounting_journal_entries',row,'finance','accounting');
  return po;
}

export async function materializeTrace(typeInput:string,idInput:string){
  await ensureTransactionTraceabilitySchema();const type=rootType(typeInput),id=rootId(idInput);
  if(type==='work_order')await materializeWorkOrder(id);
  else if(type==='purchase_order')await materializePurchaseOrder(id);
  else if(type==='booking'){
    const row=(await rows('appointments',`SELECT x.* FROM appointments x WHERE x.id::text=$1 LIMIT 1`,[id]))[0];if(!row)throw Object.assign(new Error("A foglalás nem található."),{status:404});await ensureSnapshot(type,id,'appointments',row,'booking','root');
  }else{
    const row=(await rows('finance_invoices',`SELECT x.* FROM finance_invoices x WHERE x.id::text=$1 LIMIT 1`,[id]))[0];if(!row)throw Object.assign(new Error("A számla nem található."),{status:404});await ensureSnapshot(type,id,'finance_invoices',row,'finance','root');
  }
  return(await db.query(`SELECT * FROM business_transaction_traces WHERE root_type=$1 AND root_id=$2`,[type,id])).rows[0];
}

async function eventsFor(type:string,id:string){return(await db.query(`SELECT e.* FROM business_transaction_events e JOIN business_transaction_traces t ON t.trace_id=e.trace_id WHERE t.root_type=$1 AND t.root_id=$2 ORDER BY e.sequence`,[type,id])).rows}
function lastOf(items:any[]){return items.length?items[items.length-1]:null}
function stage(status:'ok'|'warning'|'critical',key:string,label:string,count:number,detail:string){return{key,label,status,evidence_count:count,detail}}

async function stagesFor(type:string,id:string){
  const ev=await eventsFor(type,id);const by=(entity:string)=>ev.filter((x:any)=>x.entity_type===entity);const last=(entity:string)=>lastOf(by(entity))?.evidence||{};
  if(type==='work_order'){
    const payment=by('work_order_payments'),settlement=by('work_order_settlements'),invoice=last('finance_invoices'),nav=last('nav_invoice_queue'),journal=last('accounting_journal_entries');
    return[
      stage(by('appointments').length?'ok':'warning','booking','Foglalás',by('appointments').length,by('appointments').length?'Kapcsolt foglalási bizonyíték megtalálva.':'A munkalaphoz nincs külön foglalási bizonyíték.'),
      stage(by('work_orders').length?'ok':'critical','work_order','Munkalap',by('work_orders').length,'A szolgáltatási teljesítés gyökérrekordja.'),
      stage(payment.length?'ok':'critical','payment','Fizetés',payment.length,payment.length?'Legalább egy fizetési rekord kapcsolódik.':'Nincs fizetési rekord.'),
      stage(settlement.some((x:any)=>x.evidence?.completed_at)||settlement.length?'ok':'critical','settlement','Settlement',settlement.length,settlement.length?'Settlement bizonyíték rendelkezésre áll.':'Nincs settlement bizonyíték.'),
      stage(payment.some((x:any)=>x.evidence?.cashier_shift_id)?'ok':'critical','cashier','Pénztár',payment.filter((x:any)=>x.evidence?.cashier_shift_id).length,'A fizetés pénztári műszakhoz kötése.'),
      stage(by('financial_movements').length||payment.some((x:any)=>x.evidence?.financial_movement_id)?'ok':'critical','ledger','Pénzügyi tranzakció',by('financial_movements').length,'Ledger / financial movement kapcsolat.'),
      stage(by('finance_invoices').length&&!['draft','cancelled','void'].includes(String(invoice.status||'').toLowerCase())?'ok':'critical','invoice','Számla',by('finance_invoices').length,'Hivatalos számla állapot.'),
      stage(String(nav.status||'').toLowerCase()==='done'?'ok':'critical','nav','NAV',by('nav_invoice_queue').length,`Legutóbbi NAV státusz: ${String(nav.status||'nincs')}.`),
      stage(by('accounting_journal_entries').length&&['posted','approved'].includes(String(journal.status||'').toLowerCase())?'ok':'critical','accounting','Főkönyv',by('accounting_journal_entries').length,`Főkönyvi státusz: ${String(journal.status||'nincs')}.`),
    ];
  }
  if(type==='purchase_order'){
    const po=last('purchase_orders'),invoice=last('finance_invoices'),journal=last('accounting_journal_entries');
    return[
      stage(by('purchase_orders').length?'ok':'critical','order','Beszerzés',by('purchase_orders').length,'Beszerzési rendelés gyökérrekord.'),
      stage(['approved','auto_approved'].includes(String(po.approval_status||'').toLowerCase())?'ok':'critical','approval','Jóváhagyás',by('purchase_orders').length,`Jóváhagyási státusz: ${String(po.approval_status||'nincs')}.`),
      stage(by('procurement_receipt_costs').length||['received','partially_received'].includes(String(po.status||'').toLowerCase())?'ok':'critical','receipt','Bevételezés',by('procurement_receipt_costs').length,'Bevételezési bizonylat és költségkapcsolat.'),
      stage(by('inventory_movements').length?'ok':'critical','inventory','Készlet',by('inventory_movements').length,'A bevételezésből létrejött készletmozgások.'),
      stage(by('finance_invoices').length&&!['draft','cancelled','void'].includes(String(invoice.status||'').toLowerCase())?'ok':'critical','invoice','Bejövő számla',by('finance_invoices').length,'Kapcsolt bejövő számla.'),
      stage(by('accounting_journal_entries').length&&['posted','approved'].includes(String(journal.status||'').toLowerCase())?'ok':'critical','accounting','Könyvelés',by('accounting_journal_entries').length,`Főkönyvi státusz: ${String(journal.status||'nincs')}.`),
    ];
  }
  return[stage('ok',type,type==='booking'?'Foglalás':'Számla',ev.length,'Gyökérrekord bizonyítási eseményei.')];
}

export async function traceDetail(typeInput:string,idInput:string,actor='live-read'){
  const type=rootType(typeInput),id=rootId(idInput);const trace=await materializeTrace(type,id);if(!trace)throw Object.assign(new Error("A tranzakció-életút nem hozható létre."),{status:404});
  const stages=await stagesFor(type,id);const lifecycle=stages.some((x:any)=>x.status==='critical')?'incomplete':'complete';
  await db.query(`UPDATE business_transaction_traces SET lifecycle_status=$2,updated_at=now() WHERE trace_id=$1::uuid`,[trace.trace_id,lifecycle]);trace.lifecycle_status=lifecycle;
  const proof=await verifyTransactionTrace(String(trace.trace_id),actor);
  const [events,entities,verifications]=await Promise.all([
    db.query(`SELECT event_id,sequence,event_type,entity_type,entity_id,module_key,action,occurred_at,actor_key,source,previous_hash,event_hash,evidence,metadata FROM business_transaction_events WHERE trace_id=$1::uuid ORDER BY sequence`,[trace.trace_id]),
    db.query(`SELECT entity_type,entity_id,relation,first_seen_at,last_seen_at FROM business_transaction_entities WHERE trace_id=$1::uuid ORDER BY first_seen_at,entity_type`,[trace.trace_id]),
    db.query(`SELECT verified_at,verified_by,event_count,broken_count,sequence_ok,hash_chain_ok,result FROM business_transaction_verifications WHERE trace_id=$1::uuid ORDER BY verified_at DESC LIMIT 12`,[trace.trace_id]),
  ]);
  let audit:any[]=[];if(await exists('system_audit_log')){const ids=entities.rows.map((x:any)=>String(x.entity_id));if(ids.length)audit=(await db.query(`SELECT id,occurred_at,actor_key,actor_name,location_id,module_key,entity_type,entity_id,action,severity,summary,metadata FROM system_audit_log WHERE entity_id=ANY($1::text[]) ORDER BY occurred_at DESC LIMIT 150`,[ids])).rows}
  return{trace,proof,stages,events:events.rows,entities:entities.rows,verifications:verifications.rows,audit_events:audit,proof_model:{append_only:true,hash_algorithm:'SHA-256',hash_chained:true,legacy_backfill:true,automatic_database_capture:true}};
}

export async function recentTraces(limit=60,locationId:string|null=null){await ensureTransactionTraceabilitySchema();const l=Math.max(1,Math.min(200,Number(limit||60)));return(await db.query(`SELECT t.*,(SELECT COUNT(*)::int FROM business_transaction_events e WHERE e.trace_id=t.trace_id) event_count,(SELECT result FROM business_transaction_verifications v WHERE v.trace_id=t.trace_id ORDER BY verified_at DESC LIMIT 1) verification_result FROM business_transaction_traces t WHERE ($1::text IS NULL OR t.location_id=$1) ORDER BY t.last_seen_at DESC LIMIT $2`,[locationId,l])).rows}
export async function searchTraces(qInput:string,limit=40){await ensureTransactionTraceabilitySchema();const q=String(qInput||'').trim();if(q.length<2)return[];return(await db.query(`SELECT trace_id,root_type,root_id,location_id,title,lifecycle_status,integrity_status,last_seen_at FROM business_transaction_traces t WHERE t.root_id ILIKE $1 OR COALESCE(t.title,'') ILIKE $1 OR EXISTS(SELECT 1 FROM business_transaction_entities e WHERE e.trace_id=t.trace_id AND e.entity_id ILIKE $1) ORDER BY last_seen_at DESC LIMIT $2`,[`%${q}%`,Math.max(1,Math.min(80,Number(limit||40)))])).rows}

export async function backfillTraces(days=30,limit=500){
  await ensureTransactionTraceabilitySchema();const d=Math.max(1,Math.min(180,Number(days||30))),l=Math.max(1,Math.min(2000,Number(limit||500)));const out:any={work_orders:0,purchase_orders:0,verified:0,broken:0,errors:[]};
  if(await exists('work_orders'))for(const row of(await db.query(`SELECT id::text id FROM work_orders WHERE COALESCE(NULLIF(to_jsonb(work_orders)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(work_orders)->>'created_at','')::timestamptz,now())>=now()-make_interval(days=>$1) ORDER BY COALESCE(NULLIF(to_jsonb(work_orders)->>'updated_at','')::timestamptz,now()) DESC LIMIT $2`,[d,l])).rows){try{await materializeTrace('work_order',String(row.id));out.work_orders++}catch(error:any){out.errors.push({type:'work_order',id:String(row.id),message:error?.message||String(error)})}}
  if(await exists('purchase_orders'))for(const row of(await db.query(`SELECT id::text id FROM purchase_orders WHERE COALESCE(updated_at,created_at,now())>=now()-make_interval(days=>$1) ORDER BY COALESCE(updated_at,created_at) DESC LIMIT $2`,[d,l])).rows){try{await materializeTrace('purchase_order',String(row.id));out.purchase_orders++}catch(error:any){out.errors.push({type:'purchase_order',id:String(row.id),message:error?.message||String(error)})}}
  for(const row of(await db.query(`SELECT trace_id::text FROM business_transaction_traces ORDER BY last_seen_at DESC LIMIT $1`,[Math.min(l,500)])).rows){try{const v=await verifyTransactionTrace(String(row.trace_id),'scheduled-maintenance');out.verified++;if(v.result==='broken')out.broken++}catch(error:any){out.errors.push({type:'verification',id:String(row.trace_id),message:error?.message||String(error)})}}
  return{...out,generated_at:new Date().toISOString()};
}

export function startTraceMaintenance(){if(started||process.env.TRANSACTION_TRACE_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;cron.schedule('35 2 * * *',()=>{void backfillTraces(45,800).catch(error=>console.error('[transaction-trace] scheduled maintenance failed',error))},{timezone:TZ});const timer=setTimeout(()=>{void backfillTraces(30,500).catch(error=>console.error('[transaction-trace] initial backfill failed',error))},90_000);timer.unref?.();console.log('[transaction-trace] trace backfill + SHA-256 verification scheduled 02:35 Europe/Budapest')}
