import db, { PG_POOL_MAX } from "../db";
import { getComplaintMailboxStatus } from "./complaintMailbox";
import { deliverApmCriticalAlert } from "./apmAlertDelivery";
import { getApiWindow, getRequestSampleCount, getSlowQueryWindow } from "../observability/runtime";

export type ApmStatus = "ok" | "warning" | "critical" | "unknown";
export type ApmMetric = {
  key: string;
  group: string;
  label: string;
  status: ApmStatus;
  value: number | string;
  unit?: string;
  message: string;
  threshold: string;
  details?: Record<string, unknown>;
};

export type ApmSnapshot = {
  captured_at: string;
  window_minutes: number;
  overall_status: ApmStatus;
  summary: { ok: number; warning: number; critical: number; unknown: number };
  api: ReturnType<typeof getApiWindow>;
  db_pool: { max: number; total: number; idle: number; active: number; waiting: number; utilization_pct: number };
  slow_queries: ReturnType<typeof getSlowQueryWindow>;
  metrics: ApmMetric[];
  critical_alerts: Array<Pick<ApmMetric, "key" | "label" | "value" | "message" | "threshold">>;
};

let schemaPromise: Promise<void> | null = null;
let workerStarted = false;
let workerTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let collectInFlight: Promise<ApmSnapshot> | null = null;

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

const thresholds = {
  apiP95Warn: envNumber("APM_API_P95_WARN_MS", 1000),
  apiP95Critical: envNumber("APM_API_P95_CRITICAL_MS", 2500),
  apiP99Warn: envNumber("APM_API_P99_WARN_MS", 2000),
  apiP99Critical: envNumber("APM_API_P99_CRITICAL_MS", 4000),
  http4xxWarn: envNumber("APM_HTTP_4XX_WARN_PCT", 15),
  http4xxCritical: envNumber("APM_HTTP_4XX_CRITICAL_PCT", 30),
  http5xxWarn: envNumber("APM_HTTP_5XX_WARN_PCT", 1),
  http5xxCritical: envNumber("APM_HTTP_5XX_CRITICAL_PCT", 5),
  poolUtilWarn: envNumber("APM_DB_POOL_WARN_PCT", 80),
  poolUtilCritical: envNumber("APM_DB_POOL_CRITICAL_PCT", 95),
  poolWaitingWarn: envNumber("APM_DB_POOL_WAITING_WARN", 1),
  poolWaitingCritical: envNumber("APM_DB_POOL_WAITING_CRITICAL", 3),
  slowWarn: envNumber("APM_SLOW_QUERY_WARN_COUNT", 5),
  slowCritical: envNumber("APM_SLOW_QUERY_CRITICAL_COUNT", 20),
  navQueueWarn: envNumber("APM_NAV_QUEUE_WARN", 10),
  navQueueCritical: envNumber("APM_NAV_QUEUE_CRITICAL", 50),
  navFailedWarn: envNumber("APM_NAV_FAILED_WARN", 1),
  navFailedCritical: envNumber("APM_NAV_FAILED_CRITICAL", 5),
  imapWarnMinutes: envNumber("APM_IMAP_WARN_MINUTES", 60),
  imapCriticalMinutes: envNumber("APM_IMAP_CRITICAL_MINUTES", 180),
  emailDueWarn: envNumber("APM_EMAIL_QUEUE_WARN", 20),
  emailDueCritical: envNumber("APM_EMAIL_QUEUE_CRITICAL", 100),
  pushQueueWarn: envNumber("APM_PUSH_QUEUE_WARN", 50),
  pushQueueCritical: envNumber("APM_PUSH_QUEUE_CRITICAL", 250),
  schedulerWarnHours: envNumber("APM_DAILY_ACTION_WARN_HOURS", 30),
  schedulerCriticalHours: envNumber("APM_DAILY_ACTION_CRITICAL_HOURS", 48),
  staleCashierWarn: envNumber("APM_STALE_CASHIER_WARN", 1),
  staleCashierCritical: envNumber("APM_STALE_CASHIER_CRITICAL", 3),
  settlementWarn: envNumber("APM_SETTLEMENT_FAILED_WARN", 1),
  settlementCritical: envNumber("APM_SETTLEMENT_FAILED_CRITICAL", 3),
  inventoryWarn: envNumber("APM_INVENTORY_DISCREPANCY_WARN", 1),
  inventoryCritical: envNumber("APM_INVENTORY_DISCREPANCY_CRITICAL", 5),
  payrollWarn: envNumber("APM_PAYROLL_ERROR_WARN", 1),
  payrollCritical: envNumber("APM_PAYROLL_ERROR_CRITICAL", 3),
  alertCooldownMinutes: envNumber("APM_CRITICAL_ALERT_COOLDOWN_MINUTES", 60),
};

export function ensureObservabilitySchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS apm_metric_snapshots(
        id bigserial PRIMARY KEY,
        captured_at timestamptz NOT NULL DEFAULT now(),
        overall_status text NOT NULL CHECK(overall_status IN ('ok','warning','critical','unknown')),
        payload jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apm_metric_snapshots_time ON apm_metric_snapshots(captured_at DESC);

      CREATE TABLE IF NOT EXISTS apm_alert_events(
        alert_key text PRIMARY KEY,
        severity text NOT NULL DEFAULT 'critical',
        title text NOT NULL,
        detail text NOT NULL,
        value_text text,
        threshold_text text,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        last_notified_at timestamptz,
        resolved_at timestamptz,
        occurrences bigint NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_apm_alert_events_open ON apm_alert_events(resolved_at,last_seen_at DESC);
    `).then(() => undefined).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function tableExists(table: string) {
  try {
    const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${table}`]);
    return Boolean(rows[0]?.ok);
  } catch { return false; }
}

async function count(sql: string, params: any[] = []) {
  try {
    const { rows } = await db.query(sql, params);
    return Number(rows[0]?.count || 0);
  } catch { return 0; }
}

function highStatus(value: number, warning: number, critical: number): ApmStatus {
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return "ok";
}

function ageStatus(age: number | null, warning: number, critical: number): ApmStatus {
  if (age == null || !Number.isFinite(age)) return "unknown";
  if (age >= critical) return "critical";
  if (age >= warning) return "warning";
  return "ok";
}

function metric(input: ApmMetric) { return input; }

async function collectNavMetrics(): Promise<ApmMetric[]> {
  if (!(await tableExists("nav_invoice_queue"))) {
    return [
      metric({ key:"nav.queue", group:"NAV", label:"NAV queue hossz", status:"critical", value:"n/a", message:"A nav_invoice_queue tábla nem érhető el.", threshold:`warning >= ${thresholds.navQueueWarn}, critical >= ${thresholds.navQueueCritical}` }),
      metric({ key:"nav.failed", group:"NAV", label:"Failed NAV számlák", status:"critical", value:"n/a", message:"A NAV hibasor nem mérhető.", threshold:`warning >= ${thresholds.navFailedWarn}, critical >= ${thresholds.navFailedCritical}` }),
    ];
  }
  const queued = await count(`SELECT COUNT(*)::int count FROM nav_invoice_queue WHERE lower(COALESCE(status,'')) IN ('queued','processing','retry','pending')`);
  const failed = await count(`SELECT COUNT(*)::int count FROM nav_invoice_queue WHERE lower(COALESCE(status,'')) IN ('error','failed')`);
  return [
    metric({ key:"nav.queue", group:"NAV", label:"NAV queue hossz", status:highStatus(queued,thresholds.navQueueWarn,thresholds.navQueueCritical), value:queued, unit:"db", message:`${queued} NAV tétel vár feldolgozásra.`, threshold:`warning >= ${thresholds.navQueueWarn}, critical >= ${thresholds.navQueueCritical}` }),
    metric({ key:"nav.failed", group:"NAV", label:"Failed NAV számlák", status:highStatus(failed,thresholds.navFailedWarn,thresholds.navFailedCritical), value:failed, unit:"db", message:`${failed} NAV tétel van hibaállapotban.`, threshold:`warning >= ${thresholds.navFailedWarn}, critical >= ${thresholds.navFailedCritical}` }),
  ];
}

async function collectMailMetrics(): Promise<ApmMetric[]> {
  const mailbox = getComplaintMailboxStatus();
  const lastSuccess = mailbox.lastSuccessAt ? new Date(mailbox.lastSuccessAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(lastSuccess) ? Math.max(0, (Date.now() - lastSuccess) / 60_000) : null;
  const imapStatus: ApmStatus = !mailbox.enabled ? "critical" : mailbox.lastError && ageMinutes == null ? "critical" : ageStatus(ageMinutes, thresholds.imapWarnMinutes, thresholds.imapCriticalMinutes);
  const metrics: ApmMetric[] = [
    metric({
      key:"imap.last_success", group:"Kommunikáció", label:"IMAP utolsó sikeres szinkron", status:imapStatus,
      value:ageMinutes == null ? "nincs" : Math.round(ageMinutes), unit:ageMinutes == null ? undefined : "perc",
      message:!mailbox.enabled?"A vendégpanasz IMAP nincs konfigurálva.":mailbox.lastSuccessAt?`Utolsó sikeres IMAP szinkron: ${mailbox.lastSuccessAt}${mailbox.lastError?`; utolsó hiba: ${mailbox.lastError}`:""}.`:"Még nincs sikeres IMAP szinkron.",
      threshold:`warning >= ${thresholds.imapWarnMinutes} perc, critical >= ${thresholds.imapCriticalMinutes} perc`,
      details:{ running:mailbox.running, last_error:mailbox.lastError, imported_total:mailbox.totalImported },
    }),
  ];

  if (await tableExists("booking_communication_queue")) {
    const pendingTotal = await count(`SELECT COUNT(*)::int count FROM booking_communication_queue WHERE status='pending' AND channel='email'`);
    const due = await count(`SELECT COUNT(*)::int count FROM booking_communication_queue WHERE status='pending' AND channel='email' AND scheduled_at<=now()`);
    const failed = await count(`SELECT COUNT(*)::int count FROM booking_communication_queue WHERE status='failed' AND channel='email' AND resolved_at IS NULL`);
    const score = Math.max(due, failed * 5);
    metrics.push(metric({ key:"email.queue", group:"Kommunikáció", label:"E-mail queue", status:highStatus(score,thresholds.emailDueWarn,thresholds.emailDueCritical), value:due, unit:"esedékes", message:`${due} esedékes, ${pendingTotal} összes várakozó és ${failed} feloldatlan hibás e-mail.`, threshold:`warning >= ${thresholds.emailDueWarn}, critical >= ${thresholds.emailDueCritical} esedékes/hiba-pont`, details:{ pending_total:pendingTotal, due_now:due, failed_unresolved:failed } }));
  } else {
    metrics.push(metric({ key:"email.queue", group:"Kommunikáció", label:"E-mail queue", status:"unknown", value:"n/a", message:"A booking_communication_queue tábla nem érhető el.", threshold:`warning >= ${thresholds.emailDueWarn}, critical >= ${thresholds.emailDueCritical}` }));
  }

  if (await tableExists("vir_alert_deliveries")) {
    const pendingPush = await count(`SELECT COUNT(*)::int count FROM vir_alert_deliveries WHERE channel='push' AND status IN ('pending','processing','retry')`);
    const failedPush = await count(`SELECT COUNT(*)::int count FROM vir_alert_deliveries WHERE channel='push' AND status='failed'`);
    const score = Math.max(pendingPush, failedPush * 10);
    metrics.push(metric({ key:"push.queue", group:"Kommunikáció", label:"Push queue", status:highStatus(score,thresholds.pushQueueWarn,thresholds.pushQueueCritical), value:pendingPush, unit:"db", message:`${pendingPush} push vár kézbesítésre, ${failedPush} hibás kézbesítés van naplózva.`, threshold:`warning >= ${thresholds.pushQueueWarn}, critical >= ${thresholds.pushQueueCritical} queue/hiba-pont`, details:{ pending:pendingPush, failed:failedPush } }));
  } else {
    metrics.push(metric({ key:"push.queue", group:"Kommunikáció", label:"Push queue", status:"unknown", value:"n/a", message:"A push delivery queue még nem érhető el.", threshold:`warning >= ${thresholds.pushQueueWarn}, critical >= ${thresholds.pushQueueCritical}` }));
  }
  return metrics;
}

async function collectDailyActionMetric(): Promise<ApmMetric> {
  if (!(await tableExists("daily_action_campaigns"))) return metric({ key:"daily_action.scheduler", group:"Marketing", label:"Napi akció scheduler", status:"critical", value:"n/a", message:"A daily_action_campaigns tábla hiányzik.", threshold:`warning >= ${thresholds.schedulerWarnHours} óra, critical >= ${thresholds.schedulerCriticalHours} óra` });
  try {
    const { rows } = await db.query(`SELECT created_at,updated_at,id::text id FROM daily_action_campaigns WHERE COALESCE(auto_selector_meta,'{}'::jsonb) <> '{}'::jsonb ORDER BY COALESCE(updated_at,created_at) DESC LIMIT 1`);
    const row = rows[0];
    if (!row) return metric({ key:"daily_action.scheduler", group:"Marketing", label:"Napi akció scheduler", status:"warning", value:"nincs futás", message:"Még nincs auto-selector futási bizonyíték.", threshold:`warning >= ${thresholds.schedulerWarnHours} óra, critical >= ${thresholds.schedulerCriticalHours} óra` });
    const at = new Date(row.updated_at || row.created_at).getTime();
    const ageHours = Math.max(0, (Date.now() - at) / 3_600_000);
    return metric({ key:"daily_action.scheduler", group:"Marketing", label:"Napi akció scheduler", status:ageStatus(ageHours,thresholds.schedulerWarnHours,thresholds.schedulerCriticalHours), value:Math.round(ageHours*10)/10, unit:"óra", message:`Utolsó automatikus napi akció: ${new Date(at).toISOString()}.`, threshold:`warning >= ${thresholds.schedulerWarnHours} óra, critical >= ${thresholds.schedulerCriticalHours} óra`, details:{ campaign_id:row.id, last_run_at:new Date(at).toISOString() } });
  } catch (error:any) {
    return metric({ key:"daily_action.scheduler", group:"Marketing", label:"Napi akció scheduler", status:"critical", value:"hiba", message:error?.message || "A scheduler állapot nem olvasható.", threshold:`warning >= ${thresholds.schedulerWarnHours} óra, critical >= ${thresholds.schedulerCriticalHours} óra` });
  }
}

async function collectBusinessMetrics(api: ReturnType<typeof getApiWindow>): Promise<ApmMetric[]> {
  const result: ApmMetric[] = [];

  if (await tableExists("cashier_shifts")) {
    const openTotal = await count(`SELECT COUNT(*)::int count FROM cashier_shifts WHERE status='open'`);
    const stale = await count(`SELECT COUNT(*)::int count FROM cashier_shifts WHERE status='open' AND (business_date<CURRENT_DATE OR opened_at<now()-interval '18 hours')`);
    result.push(metric({ key:"cashier.open_stale", group:"Pénzügy", label:"Nyitva maradt pénztári műszakok", status:highStatus(stale,thresholds.staleCashierWarn,thresholds.staleCashierCritical), value:stale, unit:"műszak", message:`${stale} elavult és ${openTotal} összes nyitott műszak.`, threshold:`warning >= ${thresholds.staleCashierWarn}, critical >= ${thresholds.staleCashierCritical}`, details:{ open_total:openTotal, stale } }));
  } else {
    result.push(metric({ key:"cashier.open_stale", group:"Pénzügy", label:"Nyitva maradt pénztári műszakok", status:"unknown", value:"n/a", message:"A cashier_shifts tábla nem érhető el.", threshold:`warning >= ${thresholds.staleCashierWarn}, critical >= ${thresholds.staleCashierCritical}` }));
  }

  const settlementFailures = api.settlement_failures;
  result.push(metric({ key:"settlement.failed", group:"Pénzügy", label:"Sikertelen settlementek", status:highStatus(settlementFailures,thresholds.settlementWarn,thresholds.settlementCritical), value:settlementFailures, unit:`/${api.window_minutes} perc`, message:`${settlementFailures} sikertelen settlement HTTP művelet a gördülő ablakban.`, threshold:`warning >= ${thresholds.settlementWarn}, critical >= ${thresholds.settlementCritical}`, details:{ top_error_routes:api.top_error_routes.filter((x:any)=>/settle|settlement/i.test(x.route)) } }));

  let inventoryDiscrepancies = 0;
  let negativeBalances = 0;
  if (await tableExists("inventory_stocktakes")) {
    inventoryDiscrepancies = await count(`SELECT COUNT(*)::int count FROM inventory_stocktake_items i JOIN inventory_stocktakes s ON s.id=i.stocktake_id WHERE s.status IN ('draft','submitted') AND i.counted_quantity IS NOT NULL AND abs(i.counted_quantity-i.expected_quantity)>0.001`);
  }
  if (await tableExists("inventory_warehouse_balances")) {
    negativeBalances = await count(`SELECT COUNT(*)::int count FROM inventory_warehouse_balances WHERE quantity<0`);
  }
  const inventoryTotal = inventoryDiscrepancies + negativeBalances;
  result.push(metric({ key:"inventory.discrepancies", group:"Készlet", label:"Készleteltérések", status:highStatus(inventoryTotal,thresholds.inventoryWarn,thresholds.inventoryCritical), value:inventoryTotal, unit:"tétel", message:`${inventoryDiscrepancies} nyitott leltáreltérés és ${negativeBalances} negatív raktárkészlet.`, threshold:`warning >= ${thresholds.inventoryWarn}, critical >= ${thresholds.inventoryCritical}`, details:{ open_stocktake_discrepancies:inventoryDiscrepancies, negative_balances:negativeBalances } }));

  let payrollRunErrors = 0;
  if (await tableExists("payroll_runs")) payrollRunErrors = await count(`SELECT COUNT(*)::int count FROM payroll_runs WHERE lower(COALESCE(status,'')) IN ('failed','error')`);
  const payrollErrors = api.payroll_errors + payrollRunErrors;
  result.push(metric({ key:"payroll.errors", group:"HR / Payroll", label:"Payroll hibák", status:highStatus(payrollErrors,thresholds.payrollWarn,thresholds.payrollCritical), value:payrollErrors, unit:"hiba", message:`${api.payroll_errors} payroll HTTP hiba a gördülő ablakban és ${payrollRunErrors} hibás payroll run.`, threshold:`warning >= ${thresholds.payrollWarn}, critical >= ${thresholds.payrollCritical}`, details:{ http_errors:api.payroll_errors, failed_runs:payrollRunErrors } }));
  return result;
}

function overall(metrics: ApmMetric[]): ApmStatus {
  if (metrics.some(x => x.status === "critical")) return "critical";
  if (metrics.some(x => x.status === "warning")) return "warning";
  if (metrics.some(x => x.status === "unknown")) return "unknown";
  return "ok";
}

async function syncCriticalAlerts(metrics: ApmMetric[]) {
  await ensureObservabilitySchema();
  const criticalKeys = new Set(metrics.filter(x => x.status === "critical").map(x => x.key));
  for (const m of metrics) {
    if (m.status !== "critical") continue;
    await db.query(`
      INSERT INTO apm_alert_events(alert_key,severity,title,detail,value_text,threshold_text,first_seen_at,last_seen_at,resolved_at,occurrences)
      VALUES($1,'critical',$2,$3,$4,$5,now(),now(),NULL,1)
      ON CONFLICT(alert_key) DO UPDATE SET
        severity='critical',title=EXCLUDED.title,detail=EXCLUDED.detail,value_text=EXCLUDED.value_text,
        threshold_text=EXCLUDED.threshold_text,last_seen_at=now(),resolved_at=NULL,
        occurrences=apm_alert_events.occurrences+1
    `, [m.key,m.label,m.message,String(m.value),m.threshold]);

    const claim = await db.query(`
      UPDATE apm_alert_events
         SET last_notified_at=now()
       WHERE alert_key=$1
         AND (last_notified_at IS NULL OR last_notified_at < now()-($2::text || ' minutes')::interval)
      RETURNING alert_key,title,detail,value_text,threshold_text,last_seen_at
    `, [m.key,String(thresholds.alertCooldownMinutes)]);
    if (claim.rows[0]) {
      const row = claim.rows[0];
      deliverApmCriticalAlert({ key:row.alert_key, title:row.title, detail:row.detail, value:row.value_text || "", threshold:row.threshold_text || "", detected_at:new Date(row.last_seen_at).toISOString() })
        .catch(error => console.error("[APM] critical alert delivery failed", m.key, error));
    }
  }
  if (criticalKeys.size) {
    await db.query(`UPDATE apm_alert_events SET resolved_at=now() WHERE resolved_at IS NULL AND NOT (alert_key = ANY($1::text[]))`, [[...criticalKeys]]);
  } else {
    await db.query(`UPDATE apm_alert_events SET resolved_at=now() WHERE resolved_at IS NULL`);
  }
}

async function persistSnapshot(snapshot: ApmSnapshot) {
  await ensureObservabilitySchema();
  const compact = {
    captured_at:snapshot.captured_at,
    overall_status:snapshot.overall_status,
    api:{ requests:snapshot.api.requests,p50_ms:snapshot.api.p50_ms,p95_ms:snapshot.api.p95_ms,p99_ms:snapshot.api.p99_ms,rate_4xx:snapshot.api.rate_4xx,rate_5xx:snapshot.api.rate_5xx },
    db_pool:snapshot.db_pool,
    metrics:snapshot.metrics.map(x => ({ key:x.key,status:x.status,value:x.value,unit:x.unit })),
  };
  await db.query(`INSERT INTO apm_metric_snapshots(overall_status,payload) VALUES($1,$2::jsonb)`, [snapshot.overall_status, JSON.stringify(compact)]);
  await db.query(`DELETE FROM apm_metric_snapshots WHERE captured_at<now()-interval '7 days'`).catch(() => undefined);
}

export async function collectApmSnapshot(options: { persist?: boolean; notify?: boolean; windowMinutes?: number } = {}): Promise<ApmSnapshot> {
  if (collectInFlight) return collectInFlight;
  collectInFlight = (async () => {
    const windowMinutes = Math.max(1, Math.min(1440, Number(options.windowMinutes || process.env.APM_WINDOW_MINUTES || 15)));
    const api = getApiWindow(windowMinutes);
    const slow = getSlowQueryWindow(windowMinutes);
    const total = Number((db as any).totalCount || 0);
    const idle = Number((db as any).idleCount || 0);
    const waiting = Number((db as any).waitingCount || 0);
    const active = Math.max(0,total-idle);
    const utilization = PG_POOL_MAX > 0 ? Math.round((active / PG_POOL_MAX) * 10_000) / 100 : 0;
    const poolStatus = waiting >= thresholds.poolWaitingCritical || utilization >= thresholds.poolUtilCritical ? "critical" : waiting >= thresholds.poolWaitingWarn || utilization >= thresholds.poolUtilWarn ? "warning" : "ok";

    const sampleState: ApmStatus = api.requests < 5 ? "unknown" : "ok";
    const metrics: ApmMetric[] = [
      metric({ key:"api.latency.p50", group:"API", label:"API p50", status:sampleState, value:api.p50_ms, unit:"ms", message:`${api.requests} kérésből számítva ${windowMinutes} perces ablakban.`, threshold:"információs medián" }),
      metric({ key:"api.latency.p95", group:"API", label:"API p95", status:api.requests<5?"unknown":highStatus(api.p95_ms,thresholds.apiP95Warn,thresholds.apiP95Critical), value:api.p95_ms, unit:"ms", message:`p95 válaszidő ${api.p95_ms} ms.`, threshold:`warning >= ${thresholds.apiP95Warn} ms, critical >= ${thresholds.apiP95Critical} ms` }),
      metric({ key:"api.latency.p99", group:"API", label:"API p99", status:api.requests<5?"unknown":highStatus(api.p99_ms,thresholds.apiP99Warn,thresholds.apiP99Critical), value:api.p99_ms, unit:"ms", message:`p99 válaszidő ${api.p99_ms} ms.`, threshold:`warning >= ${thresholds.apiP99Warn} ms, critical >= ${thresholds.apiP99Critical} ms` }),
      metric({ key:"api.http.4xx_rate", group:"API", label:"HTTP 4xx arány", status:api.requests<10?"unknown":highStatus(api.rate_4xx,thresholds.http4xxWarn,thresholds.http4xxCritical), value:api.rate_4xx, unit:"%", message:`${api.count_4xx}/${api.requests} kérés 4xx.`, threshold:`warning >= ${thresholds.http4xxWarn}%, critical >= ${thresholds.http4xxCritical}%` }),
      metric({ key:"api.http.5xx_rate", group:"API", label:"HTTP 5xx arány", status:api.requests<10?"unknown":highStatus(api.rate_5xx,thresholds.http5xxWarn,thresholds.http5xxCritical), value:api.rate_5xx, unit:"%", message:`${api.count_5xx}/${api.requests} kérés 5xx.`, threshold:`warning >= ${thresholds.http5xxWarn}%, critical >= ${thresholds.http5xxCritical}%` }),
      metric({ key:"db.pool", group:"Adatbázis", label:"DB connection pool", status:poolStatus, value:utilization, unit:"% aktív", message:`Pool: ${active} aktív / ${total} megnyitott / ${idle} idle / ${waiting} várakozó; max ${PG_POOL_MAX}.`, threshold:`warning >= ${thresholds.poolUtilWarn}% vagy waiting >= ${thresholds.poolWaitingWarn}; critical >= ${thresholds.poolUtilCritical}% vagy waiting >= ${thresholds.poolWaitingCritical}`, details:{ max:PG_POOL_MAX,total,idle,active,waiting } }),
      metric({ key:"db.slow_queries", group:"Adatbázis", label:"Slow query", status:highStatus(slow.count,thresholds.slowWarn,thresholds.slowCritical), value:slow.count, unit:`/${windowMinutes} perc`, message:`${slow.count} lassú/hibás lekérdezés; max ${slow.max_ms} ms; küszöb ${slow.threshold_ms} ms.`, threshold:`warning >= ${thresholds.slowWarn}, critical >= ${thresholds.slowCritical}`, details:{ max_ms:slow.max_ms,failed:slow.failed,threshold_ms:slow.threshold_ms,recent:slow.recent } }),
    ];

    metrics.push(...await collectNavMetrics());
    metrics.push(...await collectMailMetrics());
    metrics.push(await collectDailyActionMetric());
    metrics.push(...await collectBusinessMetrics(api));

    const state = overall(metrics);
    const summary = {
      ok:metrics.filter(x=>x.status==="ok").length,
      warning:metrics.filter(x=>x.status==="warning").length,
      critical:metrics.filter(x=>x.status==="critical").length,
      unknown:metrics.filter(x=>x.status==="unknown").length,
    };
    const snapshot: ApmSnapshot = {
      captured_at:new Date().toISOString(),
      window_minutes:windowMinutes,
      overall_status:state,
      summary,
      api,
      db_pool:{ max:PG_POOL_MAX,total,idle,active,waiting,utilization_pct:utilization },
      slow_queries:slow,
      metrics,
      critical_alerts:metrics.filter(x=>x.status==="critical").map(x=>({key:x.key,label:x.label,value:x.value,message:x.message,threshold:x.threshold})),
    };
    if (options.persist !== false) await persistSnapshot(snapshot);
    if (options.notify !== false) await syncCriticalAlerts(metrics);
    return snapshot;
  })().finally(() => { collectInFlight = null; });
  return collectInFlight;
}

export async function getApmHistory(hours = 24) {
  await ensureObservabilitySchema();
  const safeHours = Math.max(1, Math.min(168, Number(hours) || 24));
  const { rows } = await db.query(`SELECT captured_at,overall_status,payload FROM apm_metric_snapshots WHERE captured_at>=now()-($1::text || ' hours')::interval ORDER BY captured_at ASC`, [String(safeHours)]);
  return { hours:safeHours, points:rows };
}

export async function getApmAlerts(limit = 100) {
  await ensureObservabilitySchema();
  const { rows } = await db.query(`SELECT alert_key,severity,title,detail,value_text,threshold_text,first_seen_at,last_seen_at,last_notified_at,resolved_at,occurrences FROM apm_alert_events ORDER BY (resolved_at IS NULL) DESC,last_seen_at DESC LIMIT $1`, [Math.max(1,Math.min(500,limit))]);
  return rows;
}

export async function getApmDeliveryAudit(limit = 100) {
  if (!(await tableExists("apm_alert_deliveries"))) return [];
  const { rows } = await db.query(`SELECT id,alert_key,recipient,channel,status,error_text,created_at FROM apm_alert_deliveries ORDER BY created_at DESC LIMIT $1`, [Math.max(1,Math.min(500,limit))]);
  return rows;
}

export function startObservabilityWorker() {
  if (workerStarted || process.env.APM_DISABLED === "1" || process.env.NODE_ENV === "test") return;
  workerStarted = true;
  const intervalMs = Math.max(60_000, Number(process.env.APM_SNAPSHOT_INTERVAL_MS || 60_000));
  const run = () => collectApmSnapshot({persist:true,notify:true}).catch(error => console.error("[APM] snapshot worker failed", error));
  initialTimer = setTimeout(run, Math.max(5_000, Number(process.env.APM_INITIAL_DELAY_MS || 20_000)));
  initialTimer.unref?.();
  workerTimer = setInterval(run, intervalMs);
  workerTimer.unref?.();
  console.log(`[APM] observability worker started; interval=${intervalMs}ms; in-memory request samples=${getRequestSampleCount()}`);
}
