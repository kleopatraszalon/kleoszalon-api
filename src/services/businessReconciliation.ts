import cron from "node-cron";
import db from "../db";
import { deliverBusinessControlCriticalAlert } from "./businessControlAlertDelivery";

const TZ = "Europe/Budapest";
const EPS = 0.01;
const ALERT_COOLDOWN_MINUTES = Math.max(15, Number(process.env.RECONCILIATION_ALERT_COOLDOWN_MINUTES || 180));
let schemaPromise: Promise<void> | null = null;
let schedulerStarted = false;

const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0};
const money=(v:unknown)=>Math.round(n(v)*100)/100;
const locationKey=(v:string|null|undefined)=>String(v||"").trim()||"__all__";

async function tableExists(table:string){
  try{return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok)}catch{return false}
}

export function ensureBusinessReconciliationSchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS financial_reconciliation_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_date date NOT NULL, location_key text NOT NULL,
        status text NOT NULL CHECK(status IN('ok','critical')), counts jsonb NOT NULL DEFAULT '{}'::jsonb,
        amount_summary jsonb NOT NULL DEFAULT '{}'::jsonb, discrepancy_count integer NOT NULL DEFAULT 0,
        generated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_date,location_key)
      );
      CREATE TABLE IF NOT EXISTS financial_reconciliation_items(
        id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES financial_reconciliation_runs(id) ON DELETE CASCADE,
        work_order_id text NOT NULL, work_order_number text, location_id text, appointment_id text,
        issues jsonb NOT NULL DEFAULT '[]'::jsonb, chain jsonb NOT NULL DEFAULT '{}'::jsonb,
        amounts jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id,work_order_id)
      );
      CREATE INDEX IF NOT EXISTS financial_reconciliation_items_issue_idx ON financial_reconciliation_items(run_id,work_order_id);

      CREATE TABLE IF NOT EXISTS stock_reconciliation_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_date date NOT NULL, location_key text NOT NULL,
        status text NOT NULL CHECK(status IN('ok','critical')), item_count integer NOT NULL DEFAULT 0,
        discrepancy_count integer NOT NULL DEFAULT 0, total_abs_difference numeric(18,3) NOT NULL DEFAULT 0,
        generated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_date,location_key)
      );
      CREATE TABLE IF NOT EXISTS stock_reconciliation_items(
        id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES stock_reconciliation_runs(id) ON DELETE CASCADE,
        warehouse_id text NOT NULL, warehouse_name text, location_id text, location_name text,
        product_id text NOT NULL, product_name text, opening numeric(18,3) NOT NULL DEFAULT 0,
        receipts numeric(18,3) NOT NULL DEFAULT 0, usage_qty numeric(18,3) NOT NULL DEFAULT 0,
        sales numeric(18,3) NOT NULL DEFAULT 0, scrap numeric(18,3) NOT NULL DEFAULT 0,
        transfer_in numeric(18,3) NOT NULL DEFAULT 0, transfer_out numeric(18,3) NOT NULL DEFAULT 0,
        adjustments numeric(18,3) NOT NULL DEFAULT 0, expected_closing numeric(18,3) NOT NULL DEFAULT 0,
        observed_closing numeric(18,3) NOT NULL DEFAULT 0, difference numeric(18,3) NOT NULL DEFAULT 0,
        movement_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id,warehouse_id,product_id)
      );
      CREATE INDEX IF NOT EXISTS stock_reconciliation_items_diff_idx ON stock_reconciliation_items(run_id,abs(difference));

      CREATE TABLE IF NOT EXISTS reconciliation_alert_events(
        alert_key text PRIMARY KEY, control_type text NOT NULL, business_date date NOT NULL, location_key text NOT NULL,
        severity text NOT NULL DEFAULT 'critical', title text NOT NULL, detail text NOT NULL,
        discrepancy_count integer NOT NULL DEFAULT 0, first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(), last_notified_at timestamptz, resolved_at timestamptz,
        occurrences bigint NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS reconciliation_alert_events_open_idx ON reconciliation_alert_events(resolved_at,last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS inventory_movements_reconciliation_idx ON inventory_movements(warehouse_id,product_id,created_at) WHERE warehouse_id IS NOT NULL;
    `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function syncAlert(controlType:"finance"|"stock",date:string,locKey:string,count:number,title:string,detail:string){
  await ensureBusinessReconciliationSchema();
  const key=`${controlType}:${date}:${locKey}`;
  if(count<=0){
    await db.query(`UPDATE reconciliation_alert_events SET resolved_at=COALESCE(resolved_at,now()),last_seen_at=now() WHERE alert_key=$1 AND resolved_at IS NULL`,[key]);
    return;
  }
  const previous=(await db.query(`SELECT * FROM reconciliation_alert_events WHERE alert_key=$1`,[key])).rows[0];
  const row=(await db.query(`INSERT INTO reconciliation_alert_events(alert_key,control_type,business_date,location_key,title,detail,discrepancy_count)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(alert_key) DO UPDATE SET severity='critical',title=EXCLUDED.title,detail=EXCLUDED.detail,
      discrepancy_count=EXCLUDED.discrepancy_count,last_seen_at=now(),resolved_at=NULL,occurrences=reconciliation_alert_events.occurrences+1
    RETURNING *`,[key,controlType,date,locKey,title,detail,count])).rows[0];
  const last=previous?.last_notified_at?new Date(previous.last_notified_at).getTime():0;
  if(!last||Date.now()-last>=ALERT_COOLDOWN_MINUTES*60_000){
    await deliverBusinessControlCriticalAlert({key,title,detail,control_type:controlType,business_date:date,location_key:locKey,discrepancy_count:count});
    await db.query(`UPDATE reconciliation_alert_events SET last_notified_at=now() WHERE alert_key=$1`,[key]);
  }
  return row;
}

type FinanceOptions={persist?:boolean;notify?:boolean};
export async function runFinancialReconciliation(date:string,locationId:string|null=null,options:FinanceOptions={persist:true,notify:true}){
  await ensureBusinessReconciliationSchema();
  if(!(await tableExists("work_orders")))throw new Error("A work_orders tábla nem érhető el.");
  const workOrders=(await db.query(`
    SELECT wo.id::text id,COALESCE(NULLIF(to_jsonb(wo)->>'work_order_number',''),wo.id::text) work_order_number,
      NULLIF(to_jsonb(wo)->>'appointment_id','') appointment_id,NULLIF(to_jsonb(wo)->>'location_id','') location_id,
      lower(COALESCE(NULLIF(to_jsonb(wo)->>'status',''),'unknown')) status,
      lower(COALESCE(NULLIF(to_jsonb(wo)->>'payment_status',''),'unknown')) payment_status,
      COALESCE(NULLIF(to_jsonb(wo)->>'fully_paid','')::boolean,false) fully_paid,
      COALESCE(NULLIF(to_jsonb(wo)->>'amount_due','')::numeric,NULLIF(to_jsonb(wo)->>'gross_total','')::numeric,NULLIF(to_jsonb(wo)->>'total_price','')::numeric,0)::numeric gross_total
    FROM work_orders wo
    WHERE ($2::text IS NULL OR NULLIF(to_jsonb(wo)->>'location_id','')=$2)
      AND lower(COALESCE(NULLIF(to_jsonb(wo)->>'status',''),'')) IN('completed','closed','paid','settled','archived')
      AND (COALESCE(NULLIF(to_jsonb(wo)->>'financial_closed_at','')::timestamptz,
           NULLIF(to_jsonb(wo)->>'archived_at','')::timestamptz,NULLIF(to_jsonb(wo)->>'locked_at','')::timestamptz,
           NULLIF(to_jsonb(wo)->>'status_updated_at','')::timestamptz,NULLIF(to_jsonb(wo)->>'updated_at','')::timestamptz,
           NULLIF(to_jsonb(wo)->>'created_at','')::timestamptz) AT TIME ZONE '${TZ}')::date=$1::date
    ORDER BY work_order_number`,[date,locationId])).rows;
  const ids=workOrders.map((x:any)=>String(x.id));
  const idParam=ids.length?ids:["00000000-0000-0000-0000-000000000000"];

  const appointmentMap=new Set<string>();
  if(await tableExists("appointments")){
    const rows=(await db.query(`SELECT a.id::text appointment_id,NULLIF(to_jsonb(a)->>'work_order_id','') work_order_id FROM appointments a
      WHERE a.id::text=ANY($1::text[]) OR NULLIF(to_jsonb(a)->>'work_order_id','')=ANY($2::text[])`,[
      workOrders.map((x:any)=>String(x.appointment_id||"")).filter(Boolean),idParam])).rows;
    for(const r of rows){if(r.work_order_id)appointmentMap.add(String(r.work_order_id));}
  }

  const settlementMap=new Map<string,any>();
  if(await tableExists("work_order_settlements")){
    const rows=(await db.query(`SELECT work_order_id::text work_order_id,
      COUNT(*) FILTER(WHERE completed_at IS NOT NULL)::int completed_count,
      COUNT(*)::int total_count FROM work_order_settlements WHERE work_order_id::text=ANY($1::text[]) GROUP BY work_order_id::text`,[idParam])).rows;
    rows.forEach((r:any)=>settlementMap.set(String(r.work_order_id),r));
  }

  const refundMap=new Map<string,number>();
  if(await tableExists("work_order_payment_refunds")){
    const rows=(await db.query(`SELECT p.work_order_id::text work_order_id,COALESCE(SUM(r.amount),0)::numeric refunded
      FROM work_order_payment_refunds r JOIN work_order_payments p ON p.id=r.payment_id
      WHERE p.work_order_id::text=ANY($1::text[]) AND lower(COALESCE(to_jsonb(r)->>'status','completed')) NOT IN('cancelled','void') GROUP BY p.work_order_id::text`,[idParam])).rows;
    rows.forEach((r:any)=>refundMap.set(String(r.work_order_id),n(r.refunded)));
  }

  const paymentMap=new Map<string,any>();
  if(await tableExists("work_order_payments")){
    const rows=(await db.query(`SELECT p.work_order_id::text work_order_id,COUNT(*)::int payment_count,COALESCE(SUM(p.amount),0)::numeric paid,
      BOOL_AND(CASE WHEN COALESCE(NULLIF(to_jsonb(p)->>'revenue_recognition',''),'ledger_income') IN('voucher_redemption','prepaid_redemption') THEN true ELSE NULLIF(to_jsonb(p)->>'financial_movement_id','') IS NOT NULL END) ledger_ok,
      BOOL_AND(NULLIF(to_jsonb(p)->>'cashier_shift_id','') IS NOT NULL) cashier_ok
      FROM work_order_payments p WHERE p.work_order_id::text=ANY($1::text[]) GROUP BY p.work_order_id::text`,[idParam])).rows;
    rows.forEach((r:any)=>paymentMap.set(String(r.work_order_id),r));
  }

  const invoiceMap=new Map<string,any>();
  if(await tableExists("finance_invoices")){
    const rows=(await db.query(`SELECT DISTINCT ON (work_order_id::text) id::text,work_order_id::text work_order_id,
      COALESCE(gross_total,0)::numeric gross_total,lower(COALESCE(status,'')) status,
      NULLIF(to_jsonb(finance_invoices)->>'journal_entry_id','') journal_entry_id,
      COALESCE(NULLIF(to_jsonb(finance_invoices)->>'document_kind',''),'unknown') document_kind,
      COALESCE(NULLIF(to_jsonb(finance_invoices)->>'invoice_no',''),'') invoice_no
      FROM finance_invoices WHERE work_order_id::text=ANY($1::text[]) AND lower(COALESCE(status,''))<>'cancelled'
      ORDER BY work_order_id::text,created_at DESC`,[idParam])).rows;
    rows.forEach((r:any)=>invoiceMap.set(String(r.work_order_id),r));
  }

  const invoiceIds=[...invoiceMap.values()].map((x:any)=>String(x.id));
  const navMap=new Map<string,string>();
  if(invoiceIds.length&&await tableExists("nav_invoice_queue")){
    const rows=(await db.query(`SELECT DISTINCT ON(invoice_id::text) invoice_id::text invoice_id,lower(status) status
      FROM nav_invoice_queue WHERE invoice_id::text=ANY($1::text[]) ORDER BY invoice_id::text,updated_at DESC,created_at DESC`,[invoiceIds])).rows;
    rows.forEach((r:any)=>navMap.set(String(r.invoice_id),String(r.status)));
  }

  const journalIds=[...invoiceMap.values()].map((x:any)=>String(x.journal_entry_id||"")).filter(Boolean);
  const journalMap=new Map<string,any>();
  if(journalIds.length&&await tableExists("accounting_journal_entries")&&await tableExists("accounting_journal_lines")){
    const rows=(await db.query(`SELECT je.id::text id,lower(COALESCE(je.status,'')) status,
      COALESCE(SUM(jl.debit),0)::numeric debit,COALESCE(SUM(jl.credit),0)::numeric credit
      FROM accounting_journal_entries je LEFT JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id
      WHERE je.id::text=ANY($1::text[]) GROUP BY je.id`,[journalIds])).rows;
    rows.forEach((r:any)=>journalMap.set(String(r.id),r));
  }

  const items=workOrders.map((wo:any)=>{
    const id=String(wo.id),issues:string[]=[];
    const payment=paymentMap.get(id),settlement=settlementMap.get(id),invoice=invoiceMap.get(id);
    const gross=money(wo.gross_total),paid=money(n(payment?.paid)-n(refundMap.get(id))),invoiceGross=money(invoice?.gross_total);
    const bookingOk=!wo.appointment_id||appointmentMap.has(id);
    const settlementOk=settlement?Number(settlement.completed_count)>0:(wo.payment_status==="paid"||wo.fully_paid===true);
    const paymentOk=Boolean(payment)&&Math.abs(paid-gross)<=1;
    const ledgerOk=Boolean(payment?.ledger_ok);
    const cashierOk=Boolean(payment?.cashier_ok);
    const invoiceIssued=Boolean(invoice)&&!["draft","cancelled","void"].includes(String(invoice.status||""))&&String(invoice.document_kind||"")!=="internal_draft";
    const invoiceAmountOk=Boolean(invoice)&&Math.abs(invoiceGross-gross)<=1;
    const navStatus=invoice?navMap.get(String(invoice.id))||"missing":"missing";
    const navOk=navStatus==="done";
    const journal=invoice?.journal_entry_id?journalMap.get(String(invoice.journal_entry_id)):null;
    const accountingOk=Boolean(journal)&&["posted","approved"].includes(String(journal.status||""))&&Math.abs(n(journal.debit)-n(journal.credit))<=0.5&&Math.abs(n(journal.debit)-invoiceGross)<=1;
    if(!bookingOk)issues.push("booking_link_missing");
    if(!settlementOk)issues.push("settlement_missing");
    if(!paymentOk)issues.push("payment_amount_mismatch");
    if(!ledgerOk)issues.push("financial_ledger_missing");
    if(!cashierOk)issues.push("cashier_link_missing");
    if(!invoiceIssued)issues.push("invoice_not_issued");
    if(!invoiceAmountOk)issues.push("invoice_amount_mismatch");
    if(!navOk)issues.push(navStatus==="error"?"nav_failed":"nav_not_completed");
    if(!accountingOk)issues.push("accounting_not_reconciled");
    return {work_order_id:id,work_order_number:wo.work_order_number,location_id:wo.location_id||null,appointment_id:wo.appointment_id||null,issues,
      chain:{booking:bookingOk,settlement:settlementOk,payment:paymentOk,ledger:ledgerOk,cashier:cashierOk,invoice:invoiceIssued,nav:navOk,accounting:accountingOk,nav_status:navStatus},
      amounts:{work_order:gross,payments:paid,invoice:invoiceGross,accounting_debit:money(journal?.debit||0)}};
  });

  const ok=(key:string)=>items.filter((x:any)=>x.chain[key]===true).length;
  const counts={work_orders:items.length,booking_source_ok:ok("booking"),settlement_ok:ok("settlement"),payment_ok:ok("payment"),ledger_ok:ok("ledger"),cashier_ok:ok("cashier"),invoice_ok:ok("invoice"),nav_ok:ok("nav"),accounting_ok:ok("accounting")};
  const amountSummary={work_orders:money(items.reduce((s:any,x:any)=>s+n(x.amounts.work_order),0)),payments:money(items.reduce((s:any,x:any)=>s+n(x.amounts.payments),0)),invoices:money(items.reduce((s:any,x:any)=>s+n(x.amounts.invoice),0)),accounting:money(items.reduce((s:any,x:any)=>s+n(x.amounts.accounting_debit),0))};
  const discrepancies=items.filter((x:any)=>x.issues.length>0);
  const status=discrepancies.length?"critical":"ok";
  let runId:string|null=null;
  if(options.persist!==false){
    const run=(await db.query(`INSERT INTO financial_reconciliation_runs(business_date,location_key,status,counts,amount_summary,discrepancy_count,generated_at)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,now()) ON CONFLICT(business_date,location_key) DO UPDATE SET status=EXCLUDED.status,counts=EXCLUDED.counts,
      amount_summary=EXCLUDED.amount_summary,discrepancy_count=EXCLUDED.discrepancy_count,generated_at=now() RETURNING id::text`,[date,locationKey(locationId),status,JSON.stringify(counts),JSON.stringify(amountSummary),discrepancies.length])).rows[0];
    runId=run.id;
    await db.query(`DELETE FROM financial_reconciliation_items WHERE run_id=$1::uuid`,[runId]);
    for(const item of items){await db.query(`INSERT INTO financial_reconciliation_items(run_id,work_order_id,work_order_number,location_id,appointment_id,issues,chain,amounts)
      VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,[runId,item.work_order_id,item.work_order_number,item.location_id,item.appointment_id,JSON.stringify(item.issues),JSON.stringify(item.chain),JSON.stringify(item.amounts)]);}
  }
  if(options.notify!==false)await syncAlert("finance",date,locationKey(locationId),discrepancies.length,"Pénzügyi láncegyeztetési eltérés",`${discrepancies.length} munkalapnál nem egyezik a foglalás → munkalap → settlement → kassza → számla → NAV → könyvelés lánc.`);
  return {business_date:date,location_id:locationId,status,counts,amount_summary:amountSummary,discrepancy_count:discrepancies.length,items,discrepancies,run_id:runId,generated_at:new Date().toISOString()};
}

type StockOptions={persist?:boolean;notify?:boolean};
export async function runStockReconciliation(date:string,locationId:string|null=null,options:StockOptions={persist:true,notify:true}){
  await ensureBusinessReconciliationSchema();
  for(const t of ["inventory_warehouses","inventory_warehouse_balances","inventory_movements","products"])if(!(await tableExists(t)))throw new Error(`A ${t} tábla nem érhető el.`);
  const rows=(await db.query(`
    WITH candidates AS (
      SELECT b.warehouse_id::text warehouse_id,b.product_id::text product_id FROM inventory_warehouse_balances b
      UNION
      SELECT m.warehouse_id::text,m.product_id::text FROM inventory_movements m WHERE m.warehouse_id IS NOT NULL AND m.product_id IS NOT NULL
    )
    SELECT c.warehouse_id,c.product_id,w.name warehouse_name,w.location_id::text location_id,l.name location_name,p.name product_name,
      COALESCE(pre.balance_after,first_day.balance_after-first_day.quantity,b.quantity,0)::numeric opening,
      COALESCE(day.receipts,0)::numeric receipts,COALESCE(day.usage_qty,0)::numeric usage_qty,COALESCE(day.sales,0)::numeric sales,
      COALESCE(day.scrap,0)::numeric scrap,COALESCE(day.transfer_in,0)::numeric transfer_in,COALESCE(day.transfer_out,0)::numeric transfer_out,
      COALESCE(day.adjustments,0)::numeric adjustments,COALESCE(day.net_change,0)::numeric net_change,COALESCE(day.movement_count,0)::int movement_count,
      COALESCE(next_move.balance_after-next_move.quantity,b.quantity,last_day.balance_after,pre.balance_after,first_day.balance_after-first_day.quantity,0)::numeric observed_closing
    FROM candidates c
    JOIN inventory_warehouses w ON w.id::text=c.warehouse_id
    LEFT JOIN locations l ON l.id::text=w.location_id::text
    LEFT JOIN products p ON p.id::text=c.product_id
    LEFT JOIN inventory_warehouse_balances b ON b.warehouse_id::text=c.warehouse_id AND b.product_id::text=c.product_id
    LEFT JOIN LATERAL (SELECT m.balance_after::numeric FROM inventory_movements m WHERE m.warehouse_id::text=c.warehouse_id AND m.product_id::text=c.product_id AND (m.created_at AT TIME ZONE '${TZ}')::date<$1::date ORDER BY m.created_at DESC,m.id DESC LIMIT 1) pre ON true
    LEFT JOIN LATERAL (SELECT m.balance_after::numeric,m.quantity::numeric FROM inventory_movements m WHERE m.warehouse_id::text=c.warehouse_id AND m.product_id::text=c.product_id AND (m.created_at AT TIME ZONE '${TZ}')::date=$1::date ORDER BY m.created_at,m.id LIMIT 1) first_day ON true
    LEFT JOIN LATERAL (SELECT m.balance_after::numeric FROM inventory_movements m WHERE m.warehouse_id::text=c.warehouse_id AND m.product_id::text=c.product_id AND (m.created_at AT TIME ZONE '${TZ}')::date=$1::date ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_day ON true
    LEFT JOIN LATERAL (SELECT m.balance_after::numeric,m.quantity::numeric FROM inventory_movements m WHERE m.warehouse_id::text=c.warehouse_id AND m.product_id::text=c.product_id AND (m.created_at AT TIME ZONE '${TZ}')::date>$1::date ORDER BY m.created_at,m.id LIMIT 1) next_move ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int movement_count,COALESCE(SUM(m.quantity),0)::numeric net_change,
        COALESCE(SUM(CASE WHEN m.quantity>0 AND lower(m.movement_type) NOT LIKE '%transfer%' THEN m.quantity ELSE 0 END),0)::numeric receipts,
        COALESCE(SUM(CASE WHEN m.quantity<0 AND lower(m.movement_type) ~ '(consum|usage|service)' THEN -m.quantity ELSE 0 END),0)::numeric usage_qty,
        COALESCE(SUM(CASE WHEN m.quantity<0 AND lower(m.movement_type) ~ '(sale|retail)' THEN -m.quantity ELSE 0 END),0)::numeric sales,
        COALESCE(SUM(CASE WHEN m.quantity<0 AND lower(m.movement_type) ~ '(writeoff|scrap|waste|loss)' THEN -m.quantity ELSE 0 END),0)::numeric scrap,
        COALESCE(SUM(CASE WHEN m.quantity>0 AND lower(m.movement_type) LIKE '%transfer%' THEN m.quantity ELSE 0 END),0)::numeric transfer_in,
        COALESCE(SUM(CASE WHEN m.quantity<0 AND lower(m.movement_type) LIKE '%transfer%' THEN -m.quantity ELSE 0 END),0)::numeric transfer_out,
        COALESCE(SUM(CASE WHEN NOT(
          (m.quantity>0 AND lower(m.movement_type) NOT LIKE '%transfer%') OR
          (m.quantity<0 AND lower(m.movement_type) ~ '(consum|usage|service|sale|retail|writeoff|scrap|waste|loss)') OR
          (lower(m.movement_type) LIKE '%transfer%')
        ) THEN m.quantity ELSE 0 END),0)::numeric adjustments
      FROM inventory_movements m WHERE m.warehouse_id::text=c.warehouse_id AND m.product_id::text=c.product_id AND (m.created_at AT TIME ZONE '${TZ}')::date=$1::date
    ) day ON true
    WHERE ($2::text IS NULL OR w.location_id::text=$2)
    ORDER BY COALESCE(l.name,'Központ'),w.name,p.name`,[date,locationId])).rows;

  const items=rows.map((r:any)=>{
    const opening=n(r.opening),expected=opening+n(r.net_change),observed=n(r.observed_closing),difference=observed-expected;
    return {...r,opening,receipts:n(r.receipts),usage_qty:n(r.usage_qty),sales:n(r.sales),scrap:n(r.scrap),transfer_in:n(r.transfer_in),transfer_out:n(r.transfer_out),adjustments:n(r.adjustments),expected_closing:Math.round(expected*1000)/1000,observed_closing:Math.round(observed*1000)/1000,difference:Math.round(difference*1000)/1000,movement_count:Number(r.movement_count||0)};
  });
  const discrepancies=items.filter((x:any)=>Math.abs(n(x.difference))>EPS);
  const totalAbs=Math.round(discrepancies.reduce((s:number,x:any)=>s+Math.abs(n(x.difference)),0)*1000)/1000;
  const status=discrepancies.length?"critical":"ok";
  let runId:string|null=null;
  if(options.persist!==false){
    const run=(await db.query(`INSERT INTO stock_reconciliation_runs(business_date,location_key,status,item_count,discrepancy_count,total_abs_difference,generated_at)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(business_date,location_key) DO UPDATE SET status=EXCLUDED.status,item_count=EXCLUDED.item_count,
      discrepancy_count=EXCLUDED.discrepancy_count,total_abs_difference=EXCLUDED.total_abs_difference,generated_at=now() RETURNING id::text`,[date,locationKey(locationId),status,items.length,discrepancies.length,totalAbs])).rows[0];
    runId=run.id;
    await db.query(`DELETE FROM stock_reconciliation_items WHERE run_id=$1::uuid`,[runId]);
    for(const x of items){await db.query(`INSERT INTO stock_reconciliation_items(run_id,warehouse_id,warehouse_name,location_id,location_name,product_id,product_name,opening,receipts,usage_qty,sales,scrap,transfer_in,transfer_out,adjustments,expected_closing,observed_closing,difference,movement_count)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,[runId,x.warehouse_id,x.warehouse_name,x.location_id,x.location_name,x.product_id,x.product_name,x.opening,x.receipts,x.usage_qty,x.sales,x.scrap,x.transfer_in,x.transfer_out,x.adjustments,x.expected_closing,x.observed_closing,x.difference,x.movement_count]);}
  }
  if(options.notify!==false)await syncAlert("stock",date,locationKey(locationId),discrepancies.length,"Automatikus készletegyeztetési eltérés",`${discrepancies.length} telephely/raktár/termék kombinációnál nem teljesül a nyitó + bevét − felhasználás − értékesítés − selejt ± átadás = záró készlet.`);
  return {business_date:date,location_id:locationId,status,item_count:items.length,discrepancy_count:discrepancies.length,total_abs_difference:totalAbs,items,discrepancies,run_id:runId,generated_at:new Date().toISOString()};
}

function budapestDateOffset(days:number){
  const now=new Date(Date.now()+days*86_400_000);
  return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}

export async function runDailyBusinessReconciliation(date=budapestDateOffset(-1)){
  const locations=(await tableExists("locations"))?(await db.query(`SELECT id::text id FROM locations WHERE COALESCE((to_jsonb(locations)->>'active')::boolean,true)=true ORDER BY id`)).rows:[];
  const scopes:[string|null,...string[]]=[null,...locations.map((x:any)=>String(x.id))];
  const results:any[]=[];
  for(const locationId of scopes){
    try{results.push({type:"finance",location_id:locationId,result:await runFinancialReconciliation(date,locationId,{persist:true,notify:true})})}catch(error:any){console.error("[reconciliation] finance failed",locationId,error?.message||error)}
    try{results.push({type:"stock",location_id:locationId,result:await runStockReconciliation(date,locationId,{persist:true,notify:true})})}catch(error:any){console.error("[reconciliation] stock failed",locationId,error?.message||error)}
  }
  return {date,results};
}

export function startBusinessReconciliationScheduler(){
  if(schedulerStarted||process.env.RECONCILIATION_DISABLED==="1"||process.env.NODE_ENV==="test")return;
  schedulerStarted=true;
  cron.schedule("20 2 * * *",()=>{void runDailyBusinessReconciliation().catch(error=>console.error("[reconciliation] daily run failed",error));},{timezone:TZ});
  const timer=setTimeout(()=>{void runDailyBusinessReconciliation().catch(error=>console.error("[reconciliation] initial run failed",error));},45_000);
  timer.unref?.();
  console.log("[reconciliation] daily financial + stock control scheduled for 02:20 Europe/Budapest");
}
