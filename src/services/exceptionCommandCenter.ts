import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";

const TZ="Europe/Budapest";
const ALERT_COOLDOWN_MINUTES=Math.max(15,Number(process.env.EXCEPTION_CENTER_ALERT_COOLDOWN_MINUTES||120));
let schemaPromise:Promise<void>|null=null;
let schedulerStarted=false;
let syncInFlight:Promise<any>|null=null;

type Severity="critical"|"high"|"medium"|"low";
type CaseStatus="open"|"acknowledged"|"in_progress"|"waiting"|"snoozed"|"resolved"|"dismissed";
type Candidate={
  exception_key:string;source_type:string;source_key:string;category:string;severity:Severity;
  title:string;detail:string;location_id?:string|null;entity_type?:string|null;entity_id?:string|null;
  trace_id?:string|null;source_route?:string|null;source_event_at?:string|Date|null;payload?:Record<string,unknown>;
};
type CollectionResult={source:string;ok:boolean;items:Candidate[];error?:string};

const ACTIVE_STATUSES=["open","acknowledged","in_progress","waiting","snoozed"];
const safe=(v:unknown)=>String(v??"").trim();
const severityRank=(v:string)=>v==="critical"?4:v==="high"?3:v==="medium"?2:1;
const priorityBase=(v:string)=>v==="critical"?100:v==="high"?75:v==="medium"?50:25;

async function tableExists(table:string){
  try{return Boolean((await db.query("SELECT to_regclass($1) IS NOT NULL ok",[`public.${table}`])).rows[0]?.ok)}catch{return false}
}
async function collect(source:string,tables:string[],fn:()=>Promise<Candidate[]>):Promise<CollectionResult>{
  try{
    for(const table of tables)if(!(await tableExists(table)))return{source,ok:false,items:[],error:`${table} unavailable`};
    return{source,ok:true,items:await fn()};
  }catch(error:any){return{source,ok:false,items:[],error:error?.message||String(error)}
}

export function ensureExceptionCommandCenterSchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS exception_routing_rules(
        category text PRIMARY KEY,
        team_key text NOT NULL,
        critical_sla_minutes integer NOT NULL DEFAULT 30,
        high_sla_minutes integer NOT NULL DEFAULT 120,
        medium_sla_minutes integer NOT NULL DEFAULT 480,
        low_sla_minutes integer NOT NULL DEFAULT 1440,
        auto_resolve boolean NOT NULL DEFAULT true,
        active boolean NOT NULL DEFAULT true,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS exception_cases(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        exception_key text NOT NULL UNIQUE,
        source_type text NOT NULL,
        source_key text NOT NULL,
        category text NOT NULL,
        severity text NOT NULL CHECK(severity IN('critical','high','medium','low')),
        priority_score integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'open' CHECK(status IN('open','acknowledged','in_progress','waiting','snoozed','resolved','dismissed')),
        sla_state text NOT NULL DEFAULT 'on_track' CHECK(sla_state IN('on_track','at_risk','breached','closed')),
        sla_minutes integer NOT NULL DEFAULT 120,
        title text NOT NULL,
        detail text NOT NULL,
        location_id text,
        entity_type text,
        entity_id text,
        trace_id text,
        source_route text,
        team_key text,
        owner_key text,
        owner_name text,
        first_detected_at timestamptz NOT NULL DEFAULT now(),
        last_detected_at timestamptz NOT NULL DEFAULT now(),
        last_scanned_at timestamptz NOT NULL DEFAULT now(),
        due_at timestamptz,
        acknowledged_at timestamptz,
        started_at timestamptz,
        breached_at timestamptz,
        snoozed_until timestamptz,
        resolved_at timestamptz,
        dismissed_at timestamptz,
        resolution_note text,
        resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurrence_count bigint NOT NULL DEFAULT 1,
        auto_resolve boolean NOT NULL DEFAULT true,
        last_notification_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS exception_cases_workqueue_idx ON exception_cases(status,severity,sla_state,due_at,priority_score DESC);
      CREATE INDEX IF NOT EXISTS exception_cases_category_idx ON exception_cases(category,status,last_detected_at DESC);
      CREATE INDEX IF NOT EXISTS exception_cases_location_idx ON exception_cases(location_id,status,last_detected_at DESC);
      CREATE INDEX IF NOT EXISTS exception_cases_owner_idx ON exception_cases(owner_key,status,due_at);
      CREATE INDEX IF NOT EXISTS exception_cases_source_idx ON exception_cases(source_type,source_key);

      CREATE TABLE IF NOT EXISTS exception_case_events(
        id bigserial PRIMARY KEY,
        case_id uuid NOT NULL REFERENCES exception_cases(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        actor_key text NOT NULL DEFAULT 'system',
        from_status text,
        to_status text,
        message text,
        evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS exception_case_events_case_idx ON exception_case_events(case_id,created_at,id);
      CREATE OR REPLACE FUNCTION kleo_exception_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'exception_case_events is append-only'; END $$;
      DROP TRIGGER IF EXISTS trg_exception_case_events_immutable ON exception_case_events;
      CREATE TRIGGER trg_exception_case_events_immutable BEFORE UPDATE OR DELETE ON exception_case_events
      FOR EACH ROW EXECUTE FUNCTION kleo_exception_event_immutable();

      CREATE TABLE IF NOT EXISTS exception_case_notifications(
        id bigserial PRIMARY KEY,
        notification_key text NOT NULL,
        case_id uuid REFERENCES exception_cases(id) ON DELETE SET NULL,
        recipient text NOT NULL,
        status text NOT NULL CHECK(status IN('sent','failed','logged')),
        error_text text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS exception_case_notifications_key_idx ON exception_case_notifications(notification_key,created_at DESC);

      INSERT INTO exception_routing_rules(category,team_key,critical_sla_minutes,high_sla_minutes,medium_sla_minutes,low_sla_minutes,auto_resolve) VALUES
        ('finance','finance',30,90,240,720,true),
        ('nav','finance',15,30,120,480,true),
        ('inventory','inventory',45,180,480,1440,true),
        ('procurement','procurement',120,360,720,1440,true),
        ('cashier','operations',15,45,120,480,true),
        ('payroll','hr',60,180,480,1440,true),
        ('communications','customer-care',60,180,480,1440,true),
        ('complaints','customer-care',60,120,240,720,false),
        ('trace','administration',15,45,120,480,true),
        ('system','administration',15,60,180,720,true),
        ('process','management',30,90,240,720,true),
        ('assets','operations',120,360,720,1440,true)
      ON CONFLICT(category) DO NOTHING;
    `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function routeRule(category:string,severity:Severity){
  await ensureExceptionCommandCenterSchema();
  const row=(await db.query(`SELECT * FROM exception_routing_rules WHERE category=$1 AND active=true LIMIT 1`,[category])).rows[0];
  const fallback={team_key:"management",critical_sla_minutes:30,high_sla_minutes:120,medium_sla_minutes:480,low_sla_minutes:1440,auto_resolve:true};
  const r=row||fallback;
  const sla=Number(r[`${severity}_sla_minutes`]||120);
  return{team_key:String(r.team_key||"management"),sla_minutes:Math.max(5,sla),auto_resolve:Boolean(r.auto_resolve)};
}

function apmCategory(key:string,title:string){
  const s=`${key} ${title}`.toLowerCase();
  if(s.includes("nav"))return"nav";
  if(s.includes("imap")||s.includes("email")||s.includes("e-mail")||s.includes("push"))return"communications";
  if(s.includes("cashier")||s.includes("pénzt"))return"cashier";
  if(s.includes("inventory")||s.includes("készlet"))return"inventory";
  if(s.includes("payroll")||s.includes("bér"))return"payroll";
  return"system";
}
function sourceRoute(category:string,entityType?:string|null,entityId?:string|null){
  if(category==="nav")return"/finance/nav-online-invoice";
  if(category==="finance"||category==="process")return"/finance/reconciliation";
  if(category==="inventory")return"/warehouse";
  if(category==="procurement")return"/logisztika";
  if(category==="cashier")return"/finance/cashier";
  if(category==="payroll")return"/modules/team/payroll";
  if(category==="communications")return"/admin/system-health";
  if(category==="complaints")return"/marketing/complaints";
  if(category==="assets")return"/finance/fixed-assets";
  if(category==="trace"&&entityType&&entityId)return`/finance/transaction-trace?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`;
  return"/admin/system-health";
}

async function collectReconciliation():Promise<CollectionResult>{return collect("reconciliation",["reconciliation_alert_events"],async()=>{
  const rows=(await db.query(`SELECT alert_key,control_type,business_date::text,location_key,severity,title,detail,discrepancy_count,first_seen_at,last_seen_at FROM reconciliation_alert_events WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 500`)).rows;
  return rows.map((r:any)=>{const cat=String(r.control_type)==="stock"?"inventory":"finance";return{
    exception_key:`reconciliation:${r.alert_key}`,source_type:"reconciliation",source_key:String(r.alert_key),category:cat,severity:"critical" as Severity,title:String(r.title),detail:String(r.detail),location_id:r.location_key==="__all__"?null:r.location_key,source_route:"/finance/reconciliation",source_event_at:r.last_seen_at,payload:{business_date:r.business_date,discrepancy_count:Number(r.discrepancy_count||0),control_type:r.control_type}
  }})
})}

async function collectProcessIntegrity():Promise<CollectionResult>{return collect("process-integrity",["business_process_integrity_runs","business_process_integrity_exceptions"],async()=>{
  const rows=(await db.query(`WITH latest AS(
      SELECT DISTINCT ON(location_key) id,business_date,location_key,generated_at FROM business_process_integrity_runs ORDER BY location_key,business_date DESC,generated_at DESC
    ) SELECT e.*,l.business_date::text,l.location_key,l.generated_at FROM business_process_integrity_exceptions e JOIN latest l ON l.id=e.run_id ORDER BY e.severity,e.id LIMIT 1000`)).rows;
  return rows.map((r:any)=>{const category=String(r.process_key||"")==="procurement"?"procurement":String(r.process_key||"")==="inventory"?"inventory":"process";const severity:Severity=String(r.severity)==="critical"?"critical":"high";return{
    exception_key:`process:${r.location_key}:${r.process_key}:${r.entity_type}:${r.entity_id}:${r.step_key}:${r.code}`,source_type:"process-integrity",source_key:String(r.id),category,severity,title:String(r.title),detail:String(r.detail),location_id:r.location_key==="__all__"?null:r.location_key,entity_type:String(r.entity_type||""),entity_id:String(r.entity_id||""),source_route:sourceRoute(category,r.entity_type,r.entity_id),source_event_at:r.generated_at,payload:{business_date:r.business_date,process_key:r.process_key,step_key:r.step_key,code:r.code,...(r.payload||{})}
  }})
})}

async function collectTraceAlerts():Promise<CollectionResult>{return collect("trace",["business_transaction_trace_alerts","business_transaction_traces"],async()=>{
  const rows=(await db.query(`SELECT a.alert_key,a.severity,a.alert_type,a.title,a.detail,a.first_seen_at,a.last_seen_at,t.trace_id::text,t.root_type,t.root_id,t.location_id FROM business_transaction_trace_alerts a JOIN business_transaction_traces t ON t.trace_id=a.trace_id WHERE a.resolved_at IS NULL ORDER BY a.last_seen_at DESC LIMIT 500`)).rows;
  return rows.map((r:any)=>({exception_key:`trace:${r.alert_key}`,source_type:"trace",source_key:String(r.alert_key),category:"trace",severity:String(r.severity)==="critical"?"critical":"high",title:String(r.title),detail:String(r.detail),location_id:r.location_id||null,entity_type:r.root_type,entity_id:r.root_id,trace_id:r.trace_id,source_route:sourceRoute("trace",r.root_type,r.root_id),source_event_at:r.last_seen_at,payload:{alert_type:r.alert_type,trace_id:r.trace_id}}))
})}

async function collectApm():Promise<CollectionResult>{return collect("apm",["apm_alert_events"],async()=>{
  const rows=(await db.query(`SELECT alert_key,severity,title,detail,value_text,threshold_text,first_seen_at,last_seen_at FROM apm_alert_events WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 500`)).rows;
  return rows.map((r:any)=>{const category=apmCategory(String(r.alert_key),String(r.title));return{exception_key:`apm:${r.alert_key}`,source_type:"apm",source_key:String(r.alert_key),category,severity:String(r.severity)==="critical"?"critical":"high",title:String(r.title),detail:String(r.detail),source_route:sourceRoute(category),source_event_at:r.last_seen_at,payload:{value:r.value_text,threshold:r.threshold_text}}})
})}

async function collectNav():Promise<CollectionResult>{return collect("nav",["nav_invoice_queue"],async()=>{
  const rows=(await db.query(`SELECT DISTINCT ON(q.invoice_id::text) q.invoice_id::text invoice_id,lower(COALESCE(q.status,'')) status,
      COALESCE(NULLIF(to_jsonb(q)->>'error_message',''),NULLIF(to_jsonb(q)->>'last_error',''),NULLIF(to_jsonb(q)->>'message',''),'NAV feldolgozási hiba') detail,
      COALESCE(NULLIF(to_jsonb(q)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(q)->>'created_at','')::timestamptz,now()) event_at
    FROM nav_invoice_queue q WHERE lower(COALESCE(q.status,'')) IN('error','failed','rejected') ORDER BY q.invoice_id::text,event_at DESC LIMIT 500`)).rows;
  return rows.map((r:any)=>({exception_key:`nav:${r.invoice_id}`,source_type:"nav",source_key:String(r.invoice_id),category:"nav",severity:"critical",title:`NAV számla hiba · ${r.invoice_id}`,detail:String(r.detail),entity_type:"invoice",entity_id:r.invoice_id,source_route:"/finance/nav-online-invoice",source_event_at:r.event_at,payload:{status:r.status}}))
})}

async function collectCashier():Promise<CollectionResult>{return collect("cashier",["cash_register_shifts"],async()=>{
  const rows=(await db.query(`SELECT id::text,location_id::text,business_date::text,status,opened_at,current_cashier FROM cash_register_shifts WHERE status IN('open','handover_pending') AND (business_date<CURRENT_DATE OR opened_at<now()-interval '18 hours') ORDER BY opened_at LIMIT 300`)).rows;
  return rows.map((r:any)=>({exception_key:`cashier:stale:${r.id}`,source_type:"cashier",source_key:String(r.id),category:"cashier",severity:"critical",title:"Nyitva maradt pénztári műszak",detail:`A ${r.business_date} üzleti napi kasszaműszak még ${r.status} állapotú.`,location_id:r.location_id||null,entity_type:"cash_register_shift",entity_id:r.id,source_route:"/finance/cashier",source_event_at:r.opened_at,payload:{business_date:r.business_date,status:r.status,current_cashier:r.current_cashier}}))
})}

async function collectPayroll():Promise<CollectionResult>{return collect("payroll",["payroll_runs"],async()=>{
  const rows=(await db.query(`SELECT p.id::text id,lower(COALESCE(to_jsonb(p)->>'status','')) status,
      NULLIF(to_jsonb(p)->>'location_id','') location_id,COALESCE(NULLIF(to_jsonb(p)->>'period',''),NULLIF(to_jsonb(p)->>'period_month',''),p.id::text) period,
      COALESCE(NULLIF(to_jsonb(p)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(p)->>'created_at','')::timestamptz,now()) event_at
    FROM payroll_runs p WHERE lower(COALESCE(to_jsonb(p)->>'status','')) IN('failed','error') OR
      (lower(COALESCE(to_jsonb(p)->>'status','')) IN('draft','calculated') AND COALESCE(NULLIF(to_jsonb(p)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(p)->>'created_at','')::timestamptz,now())<now()-interval '24 hours')
    ORDER BY event_at LIMIT 300`)).rows;
  return rows.map((r:any)=>{const failed=["failed","error"].includes(String(r.status));return{exception_key:`payroll:${r.id}`,source_type:"payroll",source_key:String(r.id),category:"payroll",severity:failed?"critical":"high",title:failed?"Sikertelen bérszámfejtési futás":"Elakadt bérszámfejtési futás",detail:`Időszak: ${r.period}; státusz: ${r.status}.`,location_id:r.location_id||null,entity_type:"payroll_run",entity_id:r.id,source_route:"/modules/team/payroll",source_event_at:r.event_at,payload:{period:r.period,status:r.status}}})
})}

async function collectCommunications():Promise<CollectionResult>{return collect("communications",["booking_communication_queue"],async()=>{
  const rows=(await db.query(`SELECT q.id::text id,COALESCE(NULLIF(to_jsonb(q)->>'channel',''),'unknown') channel,
      COALESCE(NULLIF(to_jsonb(q)->>'recipient',''),NULLIF(to_jsonb(q)->>'to',''),'') recipient,
      COALESCE(NULLIF(to_jsonb(q)->>'last_error',''),NULLIF(to_jsonb(q)->>'error_message',''),'Sikertelen kézbesítés') detail,
      NULLIF(to_jsonb(q)->>'location_id','') location_id,
      COALESCE(NULLIF(to_jsonb(q)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(q)->>'created_at','')::timestamptz,now()) event_at
    FROM booking_communication_queue q WHERE lower(COALESCE(to_jsonb(q)->>'status',''))='failed' AND NULLIF(to_jsonb(q)->>'resolved_at','') IS NULL ORDER BY event_at LIMIT 500`)).rows;
  return rows.map((r:any)=>({exception_key:`communications:${r.id}`,source_type:"communications",source_key:String(r.id),category:"communications",severity:"high",title:`Sikertelen ${r.channel} kézbesítés`,detail:String(r.detail),location_id:r.location_id||null,entity_type:"booking_communication",entity_id:r.id,source_route:"/admin/system-health",source_event_at:r.event_at,payload:{channel:r.channel,recipient:r.recipient}}))
})}

async function collectComplaints():Promise<CollectionResult>{return collect("complaints",["operations_quality_records"],async()=>{
  const rows=(await db.query(`SELECT id::text,title,description,priority,status,due_at,location_name,assignee,created_at,metadata FROM operations_quality_records
    WHERE module_key='complaints' AND lower(COALESCE(status,'')) NOT IN('resolved','closed','approved','archived')
      AND (due_at<now()+interval '24 hours' OR lower(COALESCE(priority,'')) IN('critical','high'))
    ORDER BY CASE WHEN due_at<now() THEN 0 WHEN lower(COALESCE(priority,''))='critical' THEN 1 ELSE 2 END,due_at NULLS LAST LIMIT 500`)).rows;
  return rows.map((r:any)=>{const critical=Boolean(r.due_at&&new Date(r.due_at).getTime()<Date.now())||String(r.priority).toLowerCase()==="critical";return{exception_key:`complaint:${r.id}`,source_type:"complaints",source_key:String(r.id),category:"complaints",severity:critical?"critical":"high",title:String(r.title||"Vendégpanasz"),detail:String(r.description||"A panasz vezetői figyelmet igényel."),location_id:r.metadata?.location_id||null,entity_type:"complaint",entity_id:r.id,source_route:"/marketing/complaints",source_event_at:r.created_at,payload:{priority:r.priority,status:r.status,due_at:r.due_at,location_name:r.location_name,assignee:r.assignee}}})
})}

async function collectInventory():Promise<CollectionResult>{return collect("inventory",["inventory_warehouse_balances","inventory_warehouses","products"],async()=>{
  const rows=(await db.query(`SELECT b.warehouse_id::text,p.id::text product_id,p.name product_name,w.name warehouse_name,w.location_id::text location_id,b.quantity::numeric quantity,b.min_quantity::numeric min_quantity
    FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=b.product_id
    WHERE b.quantity<0 ORDER BY b.quantity ASC LIMIT 500`)).rows;
  return rows.map((r:any)=>({exception_key:`inventory:negative:${r.warehouse_id}:${r.product_id}`,source_type:"inventory",source_key:`${r.warehouse_id}:${r.product_id}`,category:"inventory",severity:"critical",title:`Negatív készlet · ${r.product_name}`,detail:`${r.warehouse_name}: ${r.quantity} készlet. Negatív készlet üzleti integritási hibát jelez.`,location_id:r.location_id||null,entity_type:"inventory_product",entity_id:r.product_id,source_route:"/warehouse",source_event_at:new Date(),payload:{warehouse_id:r.warehouse_id,warehouse_name:r.warehouse_name,quantity:Number(r.quantity),min_quantity:Number(r.min_quantity||0)}}))
})}

async function collectProcurement():Promise<CollectionResult>{return collect("procurement",["purchase_orders","finance_invoices"],async()=>{
  const rows=(await db.query(`SELECT po.id::text id,po.location_id::text location_id,po.supplier_name,po.status,COALESCE(po.received_at,po.updated_at,po.created_at) event_at
    FROM purchase_orders po LEFT JOIN finance_invoices fi ON fi.purchase_order_id=po.id::text AND lower(COALESCE(fi.direction,''))='incoming' AND lower(COALESCE(fi.status,'')) NOT IN('cancelled','void')
    WHERE lower(COALESCE(po.status,'')) IN('partially_received','received') AND fi.id IS NULL
    ORDER BY event_at LIMIT 300`)).rows;
  return rows.map((r:any)=>({exception_key:`procurement:invoice-missing:${r.id}`,source_type:"procurement",source_key:String(r.id),category:"procurement",severity:String(r.status).toLowerCase()==="received"?"high":"medium",title:`Bevételezett rendelés számla nélkül · #${r.id}`,detail:`${r.supplier_name||"Beszállító"}: a ${r.status} rendeléshez nincs kapcsolt bejövő számla.`,location_id:r.location_id||null,entity_type:"purchase_order",entity_id:r.id,source_route:"/logisztika",source_event_at:r.event_at,payload:{supplier_name:r.supplier_name,status:r.status}}))
})}

async function collectAssets():Promise<CollectionResult>{return collect("assets",["fixed_asset_maintenance_plans","fixed_assets"],async()=>{
  const rows=(await db.query(`SELECT p.id::text plan_id,p.asset_id::text asset_id,p.title,p.next_due_at,a.name asset_name,a.location_id
    FROM fixed_asset_maintenance_plans p JOIN fixed_assets a ON a.id=p.asset_id WHERE p.active=true AND a.active=true AND p.next_due_at<CURRENT_DATE ORDER BY p.next_due_at LIMIT 300`)).rows;
  return rows.map((r:any)=>({exception_key:`assets:maintenance-overdue:${r.plan_id}`,source_type:"assets",source_key:String(r.plan_id),category:"assets",severity:new Date(String(r.next_due_at)).getTime()<Date.now()-7*86400000?"critical":"high",title:`Lejárt eszközkarbantartás · ${r.asset_name}`,detail:`${r.title}; esedékesség: ${String(r.next_due_at).slice(0,10)}.`,location_id:r.location_id||null,entity_type:"fixed_asset",entity_id:r.asset_id,source_route:"/finance/fixed-assets",source_event_at:r.next_due_at,payload:{plan_id:r.plan_id,next_due_at:r.next_due_at}}))
})}

async function collectAll(){
  const results=await Promise.all([collectReconciliation(),collectProcessIntegrity(),collectTraceAlerts(),collectApm(),collectNav(),collectCashier(),collectPayroll(),collectCommunications(),collectComplaints(),collectInventory(),collectProcurement(),collectAssets()]);
  return{results,candidates:results.flatMap(x=>x.items),checkedSources:results.filter(x=>x.ok).map(x=>x.source),errors:results.filter(x=>!x.ok).map(x=>({source:x.source,error:x.error}))};
}

async function event(caseId:string,eventType:string,actorKey:string,message?:string|null,fromStatus?:string|null,toStatus?:string|null,evidence:any={}){
  await db.query(`INSERT INTO exception_case_events(case_id,event_type,actor_key,from_status,to_status,message,evidence) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,[caseId,eventType,actorKey,fromStatus||null,toStatus||null,message||null,JSON.stringify(evidence||{})]);
}

async function upsertCandidate(c:Candidate,scanAt:Date){
  const rule=await routeRule(c.category,c.severity);
  const existing=(await db.query(`SELECT * FROM exception_cases WHERE exception_key=$1 LIMIT 1`,[c.exception_key])).rows[0];
  const observed=c.source_event_at?new Date(c.source_event_at):scanAt;
  const observedAt=Number.isFinite(observed.getTime())?observed:scanAt;
  if(!existing){
    const row=(await db.query(`INSERT INTO exception_cases(exception_key,source_type,source_key,category,severity,priority_score,status,sla_state,sla_minutes,title,detail,location_id,entity_type,entity_id,trace_id,source_route,team_key,first_detected_at,last_detected_at,last_scanned_at,due_at,source_payload,auto_resolve)
      VALUES($1,$2,$3,$4,$5,$6,'open','on_track',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$16+make_interval(mins=>$7),$18::jsonb,$19) RETURNING *`,[
      c.exception_key,c.source_type,c.source_key,c.category,c.severity,priorityBase(c.severity),rule.sla_minutes,c.title,c.detail,c.location_id||null,c.entity_type||null,c.entity_id||null,c.trace_id||null,c.source_route||sourceRoute(c.category,c.entity_type,c.entity_id),rule.team_key,observedAt,scanAt,JSON.stringify(c.payload||{}),rule.auto_resolve])).rows[0];
    await event(row.id,"detected","system","Új automatikus eltérés észlelve.",null,"open",{source_type:c.source_type,severity:c.severity});
    return{row,created:true,reopened:false};
  }
  const dismissed=existing.status==="dismissed";
  const snoozeExpired=existing.status==="snoozed"&&existing.snoozed_until&&new Date(existing.snoozed_until).getTime()<=scanAt.getTime();
  const shouldReopen=existing.status==="resolved"||snoozeExpired;
  const nextStatus:CaseStatus=dismissed?"dismissed":shouldReopen?"open":existing.status;
  const oldSeverity=String(existing.severity) as Severity;
  const severity=severityRank(c.severity)>severityRank(oldSeverity)?c.severity:oldSeverity;
  const slaRule=await routeRule(c.category,severity);
  const sourceAdvanced=observedAt.getTime()>new Date(existing.last_detected_at).getTime()+1000;
  const row=(await db.query(`UPDATE exception_cases SET source_type=$2,source_key=$3,category=$4,severity=$5,
      priority_score=$6,status=$7,sla_state=CASE WHEN $7 IN('resolved','dismissed') THEN 'closed' ELSE sla_state END,
      sla_minutes=$8,title=$9,detail=$10,location_id=COALESCE($11,location_id),entity_type=COALESCE($12,entity_type),entity_id=COALESCE($13,entity_id),trace_id=COALESCE($14,trace_id),source_route=COALESCE($15,source_route),
      team_key=COALESCE(team_key,$16),last_detected_at=GREATEST(last_detected_at,$17),last_scanned_at=$18,
      due_at=CASE WHEN $19 THEN $18+make_interval(mins=>$8) ELSE due_at END,
      acknowledged_at=CASE WHEN $19 THEN NULL ELSE acknowledged_at END,started_at=CASE WHEN $19 THEN NULL ELSE started_at END,
      breached_at=CASE WHEN $19 THEN NULL ELSE breached_at END,snoozed_until=CASE WHEN $19 THEN NULL ELSE snoozed_until END,
      resolved_at=CASE WHEN $19 THEN NULL ELSE resolved_at END,resolution_note=CASE WHEN $19 THEN NULL ELSE resolution_note END,resolution_evidence=CASE WHEN $19 THEN '{}'::jsonb ELSE resolution_evidence END,
      source_payload=$20::jsonb,occurrence_count=occurrence_count+CASE WHEN $21 THEN 1 ELSE 0 END,auto_resolve=$22,updated_at=now() WHERE exception_key=$1 RETURNING *`,[
      c.exception_key,c.source_type,c.source_key,c.category,severity,priorityBase(severity),nextStatus,slaRule.sla_minutes,c.title,c.detail,c.location_id||null,c.entity_type||null,c.entity_id||null,c.trace_id||null,c.source_route||sourceRoute(c.category,c.entity_type,c.entity_id),slaRule.team_key,observedAt,scanAt,shouldReopen,JSON.stringify(c.payload||{}),sourceAdvanced,slaRule.auto_resolve])).rows[0];
  if(shouldReopen)await event(row.id,"reopened","system","A forráseltérés ismét aktív; az ügy automatikusan újranyílt.",existing.status,"open",{source_type:c.source_type});
  if(severity!==oldSeverity)await event(row.id,"severity_changed","system",`Súlyosság növelve: ${oldSeverity} → ${severity}.`,null,null,{from:oldSeverity,to:severity});
  return{row,created:false,reopened:shouldReopen};
}

async function autoResolveMissing(checkedSources:string[],seenKeys:Set<string>,scanAt:Date){
  if(!checkedSources.length)return 0;
  const rows=(await db.query(`SELECT * FROM exception_cases WHERE source_type=ANY($1::text[]) AND auto_resolve=true AND status=ANY($2::text[]) AND last_scanned_at<$3`,[checkedSources,ACTIVE_STATUSES,scanAt])).rows;
  let resolved=0;
  for(const row of rows){if(seenKeys.has(String(row.exception_key)))continue;
    const updated=(await db.query(`UPDATE exception_cases SET status='resolved',sla_state='closed',resolved_at=now(),resolution_note='A forrásrendszer következő ellenőrzése már nem jelezte az eltérést.',resolution_evidence=jsonb_build_object('auto_resolved',true,'scan_at',$2::text),updated_at=now() WHERE id=$1::uuid AND status=ANY($3::text[]) RETURNING *`,[row.id,scanAt.toISOString(),ACTIVE_STATUSES])).rows[0];
    if(updated){resolved++;await event(row.id,"auto_resolved","system","A forrásrendszer szerint az eltérés megszűnt.",row.status,"resolved",{scan_at:scanAt.toISOString()})}
  }
  return resolved;
}

async function refreshSla(){
  await db.query(`UPDATE exception_cases SET
    sla_state=CASE
      WHEN status IN('resolved','dismissed') THEN 'closed'
      WHEN status='snoozed' AND snoozed_until>now() THEN 'on_track'
      WHEN due_at<=now() THEN 'breached'
      WHEN due_at<=now()+make_interval(mins=>GREATEST(15,CEIL(sla_minutes*0.25)::int)) THEN 'at_risk'
      ELSE 'on_track' END,
    breached_at=CASE WHEN status NOT IN('resolved','dismissed') AND due_at<=now() THEN COALESCE(breached_at,now()) ELSE breached_at END,
    priority_score=CASE severity WHEN 'critical' THEN 100 WHEN 'high' THEN 75 WHEN 'medium' THEN 50 ELSE 25 END+
      CASE WHEN status NOT IN('resolved','dismissed') AND due_at<=now() THEN 25 WHEN status NOT IN('resolved','dismissed') AND due_at<=now()+make_interval(mins=>GREATEST(15,CEIL(sla_minutes*0.25)::int)) THEN 10 ELSE 0 END,
    status=CASE WHEN status='snoozed' AND snoozed_until<=now() THEN 'open' ELSE status END,
    updated_at=now()
    WHERE status=ANY($1::text[])`,[ACTIVE_STATUSES]);
}

async function auditNotification(key:string,caseId:string|null,recipient:string,status:"sent"|"failed"|"logged",error?:string|null){
  await db.query(`INSERT INTO exception_case_notifications(notification_key,case_id,recipient,status,error_text) VALUES($1,$2::uuid,$3,$4,$5)`,[key,caseId||null,recipient,status,error?String(error).slice(0,1500):null]);
}
async function notifyDigest(){
  const cases=(await db.query(`SELECT * FROM exception_cases WHERE status=ANY($1::text[]) AND severity IN('critical','high') AND (severity='critical' OR sla_state='breached') AND (last_notification_at IS NULL OR last_notification_at<now()-make_interval(mins=>$2)) ORDER BY priority_score DESC,due_at NULLS LAST LIMIT 30`,[ACTIVE_STATUSES,ALERT_COOLDOWN_MINUTES])).rows;
  if(!cases.length)return{cases:0,sent:0,failed:0};
  const recipients=new Set<string>(await getApmAdminRecipients());
  for(const c of cases)if(String(c.owner_key||"").includes("@"))recipients.add(String(c.owner_key));
  const key=`exception-digest:${new Date().toISOString().slice(0,16)}`;
  if(!recipients.size){for(const c of cases)await auditNotification(key,String(c.id),"unconfigured-admin-recipient","logged","Nincs admin/felelős e-mail cím konfigurálva.");return{cases:cases.length,sent:0,failed:0}}
  const top=cases.slice(0,20).map((c:any,i:number)=>`${i+1}. [${String(c.severity).toUpperCase()}] ${c.title}\n   ${c.category} · ${c.status} · SLA ${c.sla_state} · ${c.location_id||"összes telephely"}\n   ${c.detail}`).join("\n\n");
  const subject=`[${cases.some((c:any)=>c.severity==='critical')?'CRITICAL':'HIGH'}] VIR Exception Command Center – ${cases.length} intézkedést igénylő ügy`;
  const text=["Automatikus VIR Exception Command Center összesítő.","",top,"",`Megnyitás: VIR → Statisztika és VIR → Exception Command Center`,`Értesítési cooldown: ${ALERT_COOLDOWN_MINUTES} perc.`].join("\n");
  let sent=0,failed=0;
  for(const recipient of recipients){try{const r:any=await sendEmail({to:recipient,subject,text});const st=r?.sent?"sent":"logged";for(const c of cases)await auditNotification(key,String(c.id),recipient,st,r?.logged?"SMTP nem küldött; naplózva.":null);if(r?.sent)sent++}catch(error:any){failed++;for(const c of cases)await auditNotification(key,String(c.id),recipient,"failed",error?.message||String(error))}}
  await db.query(`UPDATE exception_cases SET last_notification_at=now() WHERE id=ANY($1::uuid[])`,[cases.map((c:any)=>c.id)]);
  return{cases:cases.length,sent,failed};
}

export async function syncExceptionCommandCenter(){
  if(syncInFlight)return syncInFlight;
  syncInFlight=(async()=>{
    await ensureExceptionCommandCenterSchema();const scanAt=new Date();const collected=await collectAll();const seen=new Set<string>();let created=0,reopened=0;
    for(const candidate of collected.candidates){seen.add(candidate.exception_key);const r=await upsertCandidate(candidate,scanAt);if(r.created)created++;if(r.reopened)reopened++}
    const autoResolved=await autoResolveMissing(collected.checkedSources,seen,scanAt);await refreshSla();const notifications=await notifyDigest();
    const summary=await exceptionCenterSummary(null);
    return{ok:true,scanned_at:scanAt.toISOString(),sources:collected.results.map(x=>({source:x.source,ok:x.ok,count:x.items.length,error:x.error||null})),detected:collected.candidates.length,created,reopened,auto_resolved:autoResolved,notifications,summary};
  })().finally(()=>{syncInFlight=null});
  return syncInFlight;
}

export async function exceptionCenterSummary(locationId:string|null){
  await ensureExceptionCommandCenterSchema();const params:any[]=[];let where="";if(locationId){params.push(locationId);where=` WHERE location_id=$1`}
  const row=(await db.query(`SELECT
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']))::int open,
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']) AND severity='critical')::int critical,
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']) AND severity='high')::int high,
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']) AND sla_state='breached')::int breached,
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']) AND sla_state='at_risk')::int at_risk,
    COUNT(*) FILTER(WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed']) AND owner_key IS NULL)::int unassigned,
    COUNT(*) FILTER(WHERE resolved_at>=now()-interval '24 hours')::int resolved_24h,
    COUNT(*)::int total,
    ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at-first_detected_at))/60) FILTER(WHERE acknowledged_at IS NOT NULL),1) avg_ack_minutes,
    ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-first_detected_at))/60) FILTER(WHERE resolved_at IS NOT NULL AND resolved_at>=now()-interval '30 days'),1) avg_resolution_minutes
    FROM exception_cases${where}`,params)).rows[0]||{};
  const categories=(await db.query(`SELECT category,COUNT(*)::int count,COUNT(*) FILTER(WHERE severity='critical')::int critical,COUNT(*) FILTER(WHERE sla_state='breached')::int breached FROM exception_cases ${where?where+` AND status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed'])`:`WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed'])`} GROUP BY category ORDER BY count DESC`,params)).rows;
  const teams=(await db.query(`SELECT COALESCE(team_key,'unassigned') team_key,COUNT(*)::int count,COUNT(*) FILTER(WHERE sla_state='breached')::int breached FROM exception_cases ${where?where+` AND status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed'])`:`WHERE status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed'])`} GROUP BY COALESCE(team_key,'unassigned') ORDER BY count DESC`,params)).rows;
  return{...row,categories,teams,generated_at:new Date().toISOString()};
}

export async function listExceptionCases(filters:any={}){
  await ensureExceptionCommandCenterSchema();const where:string[]=[];const params:any[]=[];const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace("?",`$${params.length}`))};
  if(filters.status&&filters.status!=="all")add("status=?",String(filters.status));
  else if(filters.status!=="all")where.push(`status=ANY(ARRAY['open','acknowledged','in_progress','waiting','snoozed'])`);
  if(filters.severity&&filters.severity!=="all")add("severity=?",String(filters.severity));
  if(filters.category&&filters.category!=="all")add("category=?",String(filters.category));
  if(filters.team_key&&filters.team_key!=="all")add("team_key=?",String(filters.team_key));
  if(filters.owner_key&&filters.owner_key!=="all")add("owner_key=?",String(filters.owner_key));
  if(filters.location_id)add("location_id=?",String(filters.location_id));
  if(filters.sla_state&&filters.sla_state!=="all")add("sla_state=?",String(filters.sla_state));
  if(filters.q){params.push(`%${String(filters.q).trim()}%`);const p=params.length;where.push(`(title ILIKE $${p} OR detail ILIKE $${p} OR COALESCE(entity_id,'') ILIKE $${p} OR exception_key ILIKE $${p})`)}
  const limit=Math.max(20,Math.min(500,Number(filters.limit||200)));params.push(limit);
  const rows=(await db.query(`SELECT * FROM exception_cases ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY priority_score DESC,CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,due_at NULLS LAST,last_detected_at DESC LIMIT $${params.length}`,params)).rows;
  return rows;
}

export async function getExceptionCase(id:string){
  await ensureExceptionCommandCenterSchema();
  const item=(await db.query(`SELECT * FROM exception_cases WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];if(!item)throw Object.assign(new Error("Az Exception case nem található."),{status:404});
  const events=(await db.query(`SELECT * FROM exception_case_events WHERE case_id=$1::uuid ORDER BY created_at,id`,[id])).rows;
  const notifications=(await db.query(`SELECT * FROM exception_case_notifications WHERE case_id=$1::uuid ORDER BY created_at DESC LIMIT 50`,[id])).rows;
  return{item,events,notifications};
}

export async function updateExceptionCase(id:string,input:any,actorKey:string){
  await ensureExceptionCommandCenterSchema();const before=(await db.query(`SELECT * FROM exception_cases WHERE id=$1::uuid FOR UPDATE`,[id])).rows[0];if(!before)throw Object.assign(new Error("Az Exception case nem található."),{status:404});
  const allowed=new Set<CaseStatus>(["open","acknowledged","in_progress","waiting","snoozed","resolved","dismissed"]);const requested=input.status?String(input.status) as CaseStatus:null;
  if(requested&&!allowed.has(requested))throw Object.assign(new Error("Érvénytelen case státusz."),{status:400});
  if((requested==="resolved"||requested==="dismissed")&&safe(input.note).length<5)throw Object.assign(new Error("Lezáráshoz legalább 5 karakteres indok/bizonyíték szükséges."),{status:400});
  const ownerKey=input.owner_key===undefined?before.owner_key:(safe(input.owner_key)||null),ownerName=input.owner_name===undefined?before.owner_name:(safe(input.owner_name)||null),teamKey=input.team_key===undefined?before.team_key:(safe(input.team_key)||null);
  const status=requested||before.status;const snoozeMinutes=status==="snoozed"?Math.max(15,Math.min(10080,Number(input.snooze_minutes||60))):0;
  const updated=(await db.query(`UPDATE exception_cases SET status=$2,owner_key=$3,owner_name=$4,team_key=$5,
      acknowledged_at=CASE WHEN $2='acknowledged' THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
      started_at=CASE WHEN $2='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,
      snoozed_until=CASE WHEN $2='snoozed' THEN now()+make_interval(mins=>$6) WHEN $2<>'snoozed' THEN NULL ELSE snoozed_until END,
      resolved_at=CASE WHEN $2='resolved' THEN now() WHEN $2<>'resolved' THEN NULL ELSE resolved_at END,
      dismissed_at=CASE WHEN $2='dismissed' THEN now() WHEN $2<>'dismissed' THEN NULL ELSE dismissed_at END,
      sla_state=CASE WHEN $2 IN('resolved','dismissed') THEN 'closed' ELSE sla_state END,
      resolution_note=CASE WHEN $2 IN('resolved','dismissed') THEN $7 ELSE resolution_note END,
      resolution_evidence=CASE WHEN $2 IN('resolved','dismissed') THEN $8::jsonb ELSE resolution_evidence END,updated_at=now() WHERE id=$1::uuid RETURNING *`,[id,status,ownerKey,ownerName,teamKey,snoozeMinutes,safe(input.note)||null,JSON.stringify(input.resolution_evidence||{})])).rows[0];
  if(status!==before.status)await event(id,"status_changed",actorKey,safe(input.note)||`Státusz: ${before.status} → ${status}.`,before.status,status,{snooze_minutes:snoozeMinutes||null});
  if(ownerKey!==before.owner_key||ownerName!==before.owner_name||teamKey!==before.team_key)await event(id,"assigned",actorKey,`Felelős/csapat módosítva: ${ownerName||ownerKey||"nincs"} · ${teamKey||"nincs"}.`,null,null,{owner_key:ownerKey,owner_name:ownerName,team_key:teamKey});
  return updated;
}

export async function addExceptionComment(id:string,message:string,actorKey:string){
  const text=safe(message);if(text.length<2)throw Object.assign(new Error("A megjegyzés túl rövid."),{status:400});
  const exists=(await db.query(`SELECT 1 FROM exception_cases WHERE id=$1::uuid`,[id])).rows[0];if(!exists)throw Object.assign(new Error("Az Exception case nem található."),{status:404});
  await event(id,"comment",actorKey,text);return{ok:true};
}

export async function bulkExceptionAction(ids:string[],input:any,actorKey:string){
  const list=[...new Set((ids||[]).map(safe).filter(Boolean))].slice(0,200);if(!list.length)throw Object.assign(new Error("Nincs kijelölt case."),{status:400});
  const results=[] as any[];for(const id of list){try{results.push({id,ok:true,item:await updateExceptionCase(id,input,actorKey)})}catch(error:any){results.push({id,ok:false,error:error?.message||String(error)})}}
  return{items:results,success:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length};
}

export async function listExceptionRoutingRules(){await ensureExceptionCommandCenterSchema();return(await db.query(`SELECT * FROM exception_routing_rules ORDER BY category`)).rows}
export async function updateExceptionRoutingRule(category:string,input:any,actorKey:string){
  await ensureExceptionCommandCenterSchema();const cat=safe(category);if(!cat)throw Object.assign(new Error("Hiányzó kategória."),{status:400});
  const current=(await db.query(`SELECT * FROM exception_routing_rules WHERE category=$1`,[cat])).rows[0];if(!current)throw Object.assign(new Error("Ismeretlen routing kategória."),{status:404});
  const val=(name:string,fallback:number)=>Math.max(5,Math.min(43200,Number(input[name]??fallback)));
  const row=(await db.query(`UPDATE exception_routing_rules SET team_key=$2,critical_sla_minutes=$3,high_sla_minutes=$4,medium_sla_minutes=$5,low_sla_minutes=$6,auto_resolve=$7,active=$8,updated_by=$9,updated_at=now() WHERE category=$1 RETURNING *`,[cat,safe(input.team_key)||current.team_key,val("critical_sla_minutes",current.critical_sla_minutes),val("high_sla_minutes",current.high_sla_minutes),val("medium_sla_minutes",current.medium_sla_minutes),val("low_sla_minutes",current.low_sla_minutes),input.auto_resolve===undefined?current.auto_resolve:Boolean(input.auto_resolve),input.active===undefined?current.active:Boolean(input.active),actorKey])).rows[0];
  return row;
}

export async function exportExceptionCasesCsv(filters:any={}){
  const rows=await listExceptionCases({...filters,limit:500});const headers=["id","severity","status","sla_state","category","team_key","owner_name","location_id","title","detail","entity_type","entity_id","first_detected_at","last_detected_at","due_at","resolved_at","source_route"];
  const esc=(v:any)=>`"${String(v??"").replace(/"/g,'""')}"`;return`\uFEFF${[headers.join(";"),...rows.map((r:any)=>headers.map(h=>esc(r[h])).join(";"))].join("\n")}`;
}

export function startExceptionCommandCenterScheduler(){
  if(schedulerStarted||process.env.EXCEPTION_CENTER_DISABLED==="1"||process.env.NODE_ENV==="test")return;schedulerStarted=true;
  cron.schedule("*/5 * * * *",()=>{void syncExceptionCommandCenter().catch(error=>console.error("[exception-center] scheduled sync failed",error))},{timezone:TZ});
  const timer=setTimeout(()=>{void syncExceptionCommandCenter().catch(error=>console.error("[exception-center] initial sync failed",error))},45_000);timer.unref?.();
  console.log("[exception-center] automatic sync scheduled every 5 minutes Europe/Budapest");
}
