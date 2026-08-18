import db from "../db";
import { runFinancialReconciliation, runStockReconciliation } from "./businessReconciliation";

const TZ="Europe/Budapest";
const EPS=0.01;
let schemaPromise:Promise<void>|null=null;

export type ProcessIntegrityStatus="ok"|"warning"|"critical";
export type ProcessIntegrityException={
  process_key:string;entity_type:string;entity_id:string;step_key:string;
  severity:"warning"|"critical";code:string;title:string;detail:string;payload?:Record<string,unknown>;
};

type ProcessSummary={key:string;label:string;status:ProcessIntegrityStatus;entity_count:number;exception_count:number;chain:Array<{key:string;label:string;ok:number;total:number}>;details?:Record<string,unknown>};

type RunOptions={persist?:boolean};
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const money=(v:unknown)=>Math.round(num(v)*100)/100;
const locationKey=(v:string|null|undefined)=>String(v||"").trim()||"__all__";

async function tableExists(table:string){
  try{return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok)}catch{return false}
}

export function ensureBusinessProcessIntegritySchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS business_process_integrity_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_date date NOT NULL,location_key text NOT NULL,
        status text NOT NULL CHECK(status IN('ok','warning','critical')),process_count integer NOT NULL DEFAULT 0,
        passed_count integer NOT NULL DEFAULT 0,warning_count integer NOT NULL DEFAULT 0,failed_count integer NOT NULL DEFAULT 0,
        exception_count integer NOT NULL DEFAULT 0,summary jsonb NOT NULL DEFAULT '{}'::jsonb,generated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(business_date,location_key)
      );
      CREATE TABLE IF NOT EXISTS business_process_integrity_exceptions(
        id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES business_process_integrity_runs(id) ON DELETE CASCADE,
        process_key text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,step_key text NOT NULL,
        severity text NOT NULL CHECK(severity IN('warning','critical')),code text NOT NULL,title text NOT NULL,detail text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id,process_key,entity_type,entity_id,step_key,code)
      );
      CREATE INDEX IF NOT EXISTS business_process_integrity_exceptions_run_idx ON business_process_integrity_exceptions(run_id,severity,process_key);

      DO $$ BEGIN
        IF to_regclass('public.inventory_movements') IS NOT NULL THEN
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source_record_type text;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source_record_id text;
          UPDATE inventory_movements
             SET source_record_type='purchase_order',
                 source_record_id=substring(COALESCE(note,'') from 'Beszerzési rendelés #([0-9]+)')
           WHERE source_record_id IS NULL
             AND COALESCE(note,'') ~ 'Beszerzési rendelés #[0-9]+';
          CREATE INDEX IF NOT EXISTS inventory_movements_source_record_idx ON inventory_movements(source_record_type,source_record_id,product_id);
        END IF;
      END $$;

      CREATE OR REPLACE FUNCTION kleo_inventory_source_link()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_record_id IS NULL AND COALESCE(NEW.note,'') ~ 'Beszerzési rendelés #[0-9]+' THEN
          NEW.source_record_type:='purchase_order';
          NEW.source_record_id:=substring(COALESCE(NEW.note,'') from 'Beszerzési rendelés #([0-9]+)');
        END IF;
        RETURN NEW;
      END $$;
      DO $$ BEGIN
        IF to_regclass('public.inventory_movements') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_kleo_inventory_source_link ON inventory_movements;
          CREATE TRIGGER trg_kleo_inventory_source_link BEFORE INSERT OR UPDATE OF note,source_record_id ON inventory_movements
          FOR EACH ROW EXECUTE FUNCTION kleo_inventory_source_link();
        END IF;
      END $$;
    `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

function statusFromExceptions(items:ProcessIntegrityException[]):ProcessIntegrityStatus{
  if(items.some(x=>x.severity==="critical"))return "critical";
  if(items.length)return "warning";
  return "ok";
}

async function procurementIntegrity(date:string,locationId:string|null){
  const exceptions:ProcessIntegrityException[]=[];
  const required=["purchase_orders","purchase_order_items","inventory_movements","finance_invoices"];
  const missing=[] as string[];
  for(const table of required)if(!(await tableExists(table)))missing.push(table);
  if(missing.length){
    exceptions.push({process_key:"procurement",entity_type:"schema",entity_id:"procurement",step_key:"schema",severity:"critical",code:"procurement_schema_missing",title:"Beszerzési lánc nem ellenőrizhető",detail:`Hiányzó táblák: ${missing.join(', ')}.`,payload:{missing}});
    return {status:"critical" as ProcessIntegrityStatus,entity_count:0,exceptions,chain:[] as ProcessSummary["chain"],items:[] as any[]};
  }

  const orders=(await db.query(`
    SELECT po.id::text id,po.location_id::text location_id,po.supplier_name,lower(COALESCE(po.status,'')) status,
      lower(COALESCE(po.approval_status,'')) approval_status,po.received_at,po.updated_at,
      COUNT(poi.id)::int item_count,
      COALESCE(SUM(poi.ordered_quantity),0)::numeric ordered_qty,
      COALESCE(SUM(poi.received_quantity),0)::numeric received_qty
    FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id=po.id
    WHERE ($2::text IS NULL OR po.location_id::text=$2)
      AND lower(COALESCE(po.status,'')) IN('partially_received','received')
      AND (COALESCE(po.received_at,po.updated_at,po.created_at) AT TIME ZONE '${TZ}')::date=$1::date
    GROUP BY po.id
    ORDER BY po.id`,[date,locationId])).rows;
  const ids=orders.map((x:any)=>String(x.id));
  const idParam=ids.length?ids:["-1"];

  const itemRows=(await db.query(`SELECT poi.purchase_order_id::text order_id,poi.product_id::text product_id,
      COALESCE(p.name,poi.product_id::text) product_name,poi.ordered_quantity::numeric ordered_qty,poi.received_quantity::numeric received_qty
    FROM purchase_order_items poi LEFT JOIN products p ON p.id=poi.product_id WHERE poi.purchase_order_id::text=ANY($1::text[])`,[idParam])).rows;
  const itemsByOrder=new Map<string,any[]>();
  for(const row of itemRows){const key=String(row.order_id);if(!itemsByOrder.has(key))itemsByOrder.set(key,[]);itemsByOrder.get(key)!.push(row)}

  const movementRows=(await db.query(`SELECT source_record_id order_id,product_id::text product_id,COALESCE(SUM(quantity),0)::numeric qty
    FROM inventory_movements WHERE source_record_type='purchase_order' AND source_record_id=ANY($1::text[])
      AND lower(COALESCE(movement_type,'')) IN('receipt','purchase','purchase_receipt') GROUP BY source_record_id,product_id`,[idParam])).rows;
  const movementMap=new Map<string,number>();
  movementRows.forEach((r:any)=>movementMap.set(`${r.order_id}:${r.product_id}`,num(r.qty)));

  let costTable=false;
  try{costTable=await tableExists("procurement_receipt_costs")}catch{}
  const costMap=new Map<string,number>();
  if(costTable){
    const rows=(await db.query(`SELECT purchase_order_id::text order_id,COALESCE(SUM(gross_total),0)::numeric gross FROM procurement_receipt_costs WHERE purchase_order_id::text=ANY($1::text[]) GROUP BY purchase_order_id`,[idParam])).rows;
    rows.forEach((r:any)=>costMap.set(String(r.order_id),money(r.gross)));
  }

  const invoiceRows=(await db.query(`SELECT purchase_order_id::text order_id,COUNT(*)::int invoice_count,
      COALESCE(SUM(gross_total),0)::numeric gross,
      COUNT(*) FILTER(WHERE NULLIF(to_jsonb(finance_invoices)->>'journal_entry_id','') IS NULL)::int missing_journal,
      array_remove(array_agg(NULLIF(to_jsonb(finance_invoices)->>'journal_entry_id','')),NULL) journal_ids
    FROM finance_invoices WHERE purchase_order_id::text=ANY($1::text[]) AND lower(COALESCE(direction,''))='incoming'
      AND lower(COALESCE(status,'')) NOT IN('cancelled','void') GROUP BY purchase_order_id`,[idParam])).rows;
  const invoiceMap=new Map<string,any>();invoiceRows.forEach((r:any)=>invoiceMap.set(String(r.order_id),r));

  const allJournalIds=invoiceRows.flatMap((r:any)=>Array.isArray(r.journal_ids)?r.journal_ids:[]).filter(Boolean).map(String);
  const journalMap=new Map<string,any>();
  if(allJournalIds.length&&await tableExists("accounting_journal_entries")&&await tableExists("accounting_journal_lines")){
    const rows=(await db.query(`SELECT je.id::text id,lower(COALESCE(je.status,'')) status,COALESCE(SUM(jl.debit),0)::numeric debit,COALESCE(SUM(jl.credit),0)::numeric credit
      FROM accounting_journal_entries je LEFT JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id WHERE je.id::text=ANY($1::text[]) GROUP BY je.id`,[allJournalIds])).rows;
    rows.forEach((r:any)=>journalMap.set(String(r.id),r));
  }

  const chainCounts={orders:orders.length,approval_ok:0,receipt_ok:0,stock_ok:0,invoice_ok:0,accounting_ok:0};
  const items=orders.map((order:any)=>{
    const orderId=String(order.id),issues:Array<{code:string;step:string;severity:"warning"|"critical";detail:string}>=[];
    const approvalOk=["approved","auto_approved"].includes(String(order.approval_status));
    if(approvalOk)chainCounts.approval_ok++;else issues.push({code:"procurement_approval_missing",step:"approval",severity:"critical",detail:"A bevételezett rendeléshez nincs érvényes jóváhagyás."});

    const orderItems=itemsByOrder.get(orderId)||[];
    const receiptOk=orderItems.length>0&&orderItems.every((x:any)=>String(order.status)==="received"?num(x.received_qty)+EPS>=num(x.ordered_qty):num(x.received_qty)>0&&num(x.received_qty)<=num(x.ordered_qty)+EPS);
    if(receiptOk)chainCounts.receipt_ok++;else issues.push({code:"procurement_receipt_quantity_mismatch",step:"receipt",severity:"critical",detail:"A rendelési státusz és a bevételezett mennyiségek nem egyeznek."});

    const stockBad=orderItems.filter((x:any)=>Math.abs((movementMap.get(`${orderId}:${x.product_id}`)||0)-num(x.received_qty))>EPS);
    const stockOk=orderItems.length>0&&stockBad.length===0;
    if(stockOk)chainCounts.stock_ok++;else issues.push({code:"procurement_stock_link_mismatch",step:"stock",severity:"critical",detail:`${stockBad.length||orderItems.length} tételnél a bevételezés és a készletmozgás nem igazolható azonos mennyiséggel.`});

    const invoice=invoiceMap.get(orderId);const receiptGross=costMap.get(orderId)||0;const invoiceGross=money(invoice?.gross);
    const invoicePresent=Boolean(invoice)&&Number(invoice.invoice_count)>0;
    const invoiceAmountOk=!invoicePresent?false:receiptGross<=EPS||Math.abs(invoiceGross-receiptGross)<=1;
    const invoiceOk=invoicePresent&&invoiceAmountOk;
    if(invoiceOk)chainCounts.invoice_ok++;
    else if(!invoicePresent)issues.push({code:"procurement_invoice_missing",step:"invoice",severity:String(order.status)==="received"?"critical":"warning",detail:"A bevételezett rendeléshez nincs kapcsolt bejövő számla."});
    else issues.push({code:"procurement_invoice_amount_mismatch",step:"invoice",severity:"critical",detail:`A bevételezés (${receiptGross} Ft) és a kapcsolt számla (${invoiceGross} Ft) összege eltér.`});

    const journalIds=Array.isArray(invoice?.journal_ids)?invoice.journal_ids.filter(Boolean).map(String):[];
    const accountingOk=invoicePresent&&Number(invoice?.missing_journal||0)===0&&journalIds.length>0&&journalIds.every((id:string)=>{const j=journalMap.get(id);return Boolean(j)&&["posted","approved"].includes(String(j.status))&&Math.abs(num(j.debit)-num(j.credit))<=0.5});
    if(accountingOk)chainCounts.accounting_ok++;else if(invoicePresent)issues.push({code:"procurement_accounting_not_reconciled",step:"accounting",severity:"critical",detail:"A kapcsolt bejövő számla nincs teljesen és kiegyensúlyozottan főkönyvelve."});

    for(const issue of issues)exceptions.push({process_key:"procurement",entity_type:"purchase_order",entity_id:orderId,step_key:issue.step,severity:issue.severity,code:issue.code,title:`Beszerzési lánc – #${orderId}`,detail:issue.detail,payload:{supplier:order.supplier_name,status:order.status,approval_status:order.approval_status}});
    return {purchase_order_id:orderId,supplier_name:order.supplier_name,status:order.status,issues:issues.map(x=>x.code),chain:{approval:approvalOk,receipt:receiptOk,stock:stockOk,invoice:invoiceOk,accounting:accountingOk},amounts:{receipt_gross:receiptGross,invoice_gross:invoiceGross}};
  });

  return {status:statusFromExceptions(exceptions),entity_count:orders.length,exceptions,items,chain:[
    {key:"orders",label:"Bevételezett rendelés",ok:orders.length,total:orders.length},
    {key:"approval",label:"Jóváhagyás",ok:chainCounts.approval_ok,total:orders.length},
    {key:"receipt",label:"Bevételezés",ok:chainCounts.receipt_ok,total:orders.length},
    {key:"stock",label:"Készletmozgás",ok:chainCounts.stock_ok,total:orders.length},
    {key:"invoice",label:"Bejövő számla",ok:chainCounts.invoice_ok,total:orders.length},
    {key:"accounting",label:"Könyvelés",ok:chainCounts.accounting_ok,total:orders.length},
  ]};
}

async function systemInvariantIntegrity(locationId:string|null){
  const exceptions:ProcessIntegrityException[]=[];
  const checks:Array<{key:string;label:string;count:number;severity:"warning"|"critical";detail:string}>=[];
  const add=(key:string,label:string,count:number,severity:"warning"|"critical",detail:string)=>{checks.push({key,label,count,severity,detail});if(count>0)exceptions.push({process_key:"system",entity_type:"system",entity_id:key,step_key:key,severity,code:key,title:label,detail:detail.replace("{count}",String(count)),payload:{count}})};

  if(await tableExists("finance_invoices")){
    const vat=Number((await db.query(`SELECT COUNT(*)::int count FROM finance_invoices WHERE lower(COALESCE(status,''))<>'cancelled' AND ABS((COALESCE(net_total,0)+COALESCE(vat_total,0))-COALESCE(gross_total,0))>0.01 AND ($1::text IS NULL OR location_id::text=$1 OR location_id IS NULL)`,[locationId])).rows[0]?.count||0);
    add("invoice_math_error","Számla nettó + ÁFA ≠ bruttó",vat,"critical","{count} számla matematikailag nem zár.");
  }
  if(await tableExists("accounting_journal_entries")&&await tableExists("accounting_journal_lines")){
    const unbalanced=Number((await db.query(`SELECT COUNT(*)::int count FROM (SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id GROUP BY je.id HAVING ABS(COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0))>0.01) q`)).rows[0]?.count||0);
    add("journal_unbalanced","Kiegyensúlyozatlan főkönyvi tétel",unbalanced,"critical","{count} főkönyvi tételnél Tartozik/Követel eltérés van.");
  }
  if(await tableExists("inventory_warehouse_balances")){
    const negative=Number((await db.query(`SELECT COUNT(*)::int count FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id WHERE b.quantity< -0.001 AND ($1::text IS NULL OR w.location_id=$1 OR w.location_id IS NULL)`,[locationId])).rows[0]?.count||0);
    add("negative_stock","Negatív készlet",negative,"critical","{count} raktári készletpozíció negatív.");
  }
  if(await tableExists("cash_register_shifts")){
    const stale=Number((await db.query(`SELECT COUNT(*)::int count FROM cash_register_shifts WHERE status IN('open','handover_pending') AND (business_date<CURRENT_DATE OR opened_at<now()-interval '18 hours') AND ($1::text IS NULL OR location_id::text=$1)`,[locationId])).rows[0]?.count||0);
    add("stale_cashier_shift","Nyitva maradt pénztári műszak",stale,"critical","{count} pénztári műszak elavult vagy előző üzleti napról nyitva maradt.");
  }
  if(await tableExists("booking_communication_queue")){
    const failed=Number((await db.query(`SELECT COUNT(*)::int count FROM booking_communication_queue WHERE status='failed' AND resolved_at IS NULL`)).rows[0]?.count||0);
    add("communication_failed","Sikertelen kommunikáció",failed,"warning","{count} feloldatlan sikertelen foglalási kommunikáció van.");
  }
  if(await tableExists("payroll_runs")){
    const pending=Number((await db.query(`SELECT COUNT(*)::int count FROM payroll_runs WHERE status IN('draft','calculated')`)).rows[0]?.count||0);
    add("payroll_pending","Nyitott bérszámfejtés",pending,"warning","{count} számfejtési futás nincs még jóváhagyva.");
  }
  return {status:statusFromExceptions(exceptions),entity_count:checks.reduce((s,x)=>s+x.count,0),exceptions,checks,chain:checks.map(x=>({key:x.key,label:x.label,ok:x.count===0?1:0,total:1}))};
}

export async function runBusinessProcessIntegrity(date:string,locationId:string|null=null,options:RunOptions={persist:true}){
  await ensureBusinessProcessIntegritySchema();
  const finance=await runFinancialReconciliation(date,locationId,{persist:false,notify:false});
  const stock=await runStockReconciliation(date,locationId,{persist:false,notify:false});
  const procurement=await procurementIntegrity(date,locationId);
  const system=await systemInvariantIntegrity(locationId);
  const exceptions:ProcessIntegrityException[]=[];

  for(const item of finance.discrepancies||[])for(const issue of item.issues||[])exceptions.push({process_key:"finance",entity_type:"work_order",entity_id:String(item.work_order_id),step_key:String(issue),severity:"critical",code:String(issue),title:`Pénzügyi lánc – ${item.work_order_number||item.work_order_id}`,detail:`A pénzügyi folyamat megszakadt: ${issue}.`,payload:{chain:item.chain,amounts:item.amounts}});
  for(const item of stock.discrepancies||[])exceptions.push({process_key:"stock",entity_type:"inventory_position",entity_id:`${item.warehouse_id}:${item.product_id}`,step_key:"closing",severity:"critical",code:"stock_reconciliation_difference",title:`Készleteltérés – ${item.product_name||item.product_id}`,detail:`Várt záró ${item.expected_closing}, tényleges záró ${item.observed_closing}, eltérés ${item.difference}.`,payload:{warehouse:item.warehouse_name,location:item.location_name}});
  exceptions.push(...procurement.exceptions,...system.exceptions);

  const financeStatus:ProcessIntegrityStatus=finance.status==="ok"?"ok":"critical";
  const stockStatus:ProcessIntegrityStatus=stock.status==="ok"?"ok":"critical";
  const processes:ProcessSummary[]=[
    {key:"finance",label:"Foglalás → munkalap → fizetés → settlement → pénztár → tranzakció → számla → NAV → főkönyv",status:financeStatus,entity_count:Number(finance.counts?.work_orders||0),exception_count:(finance.discrepancies||[]).length,chain:[
      ["booking_source_ok","Foglalás / forrás"],["work_orders","Munkalap"],["payment_ok","Fizetés"],["settlement_ok","Settlement"],["cashier_ok","Pénztár"],["ledger_ok","Pénzügyi tranzakció"],["invoice_ok","Számla"],["nav_ok","NAV"],["accounting_ok","Főkönyv"],
    ].map(([key,label])=>({key,label,ok:Number(finance.counts?.[key]||0),total:Number(finance.counts?.work_orders||0)})),details:{amount_summary:finance.amount_summary}},
    {key:"stock",label:"Nyitókészlet + mozgások = zárókészlet",status:stockStatus,entity_count:Number(stock.item_count||0),exception_count:Number(stock.discrepancy_count||0),chain:[{key:"stock",label:"Készletegyenlet",ok:Number(stock.item_count||0)-Number(stock.discrepancy_count||0),total:Number(stock.item_count||0)}],details:{total_abs_difference:stock.total_abs_difference}},
    {key:"procurement",label:"Beszerzés → jóváhagyás → bevételezés → készlet → bejövő számla → könyvelés",status:procurement.status,entity_count:procurement.entity_count,exception_count:procurement.exceptions.length,chain:procurement.chain},
    {key:"system",label:"Üzleti invariánsok és fail-closed kontrollok",status:system.status,entity_count:system.entity_count,exception_count:system.exceptions.length,chain:system.chain,details:{checks:system.checks}},
  ];
  const status:ProcessIntegrityStatus=processes.some(x=>x.status==="critical")?"critical":processes.some(x=>x.status==="warning")?"warning":"ok";
  const result={business_date:date,location_id:locationId,status,processes,exception_count:exceptions.length,exceptions,procurement_items:procurement.items,generated_at:new Date().toISOString()};

  if(options.persist!==false){
    const key=locationKey(locationId),passed=processes.filter(x=>x.status==="ok").length,warnings=processes.filter(x=>x.status==="warning").length,failed=processes.filter(x=>x.status==="critical").length;
    const run=(await db.query(`INSERT INTO business_process_integrity_runs(business_date,location_key,status,process_count,passed_count,warning_count,failed_count,exception_count,summary,generated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()) ON CONFLICT(business_date,location_key) DO UPDATE SET status=EXCLUDED.status,process_count=EXCLUDED.process_count,
      passed_count=EXCLUDED.passed_count,warning_count=EXCLUDED.warning_count,failed_count=EXCLUDED.failed_count,exception_count=EXCLUDED.exception_count,summary=EXCLUDED.summary,generated_at=now() RETURNING id`,
      [date,key,status,processes.length,passed,warnings,failed,exceptions.length,JSON.stringify({processes})])).rows[0];
    await db.query(`DELETE FROM business_process_integrity_exceptions WHERE run_id=$1`,[run.id]);
    for(const e of exceptions)await db.query(`INSERT INTO business_process_integrity_exceptions(run_id,process_key,entity_type,entity_id,step_key,severity,code,title,detail,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`,[run.id,e.process_key,e.entity_type,e.entity_id,e.step_key,e.severity,e.code,e.title,e.detail,JSON.stringify(e.payload||{})]);
  }
  return result;
}
