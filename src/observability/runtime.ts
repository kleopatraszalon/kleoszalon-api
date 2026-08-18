import http from "http";

export type ApiRequestSample = {
  at: number;
  duration_ms: number;
  status: number;
  method: string;
  path: string;
};

export type SlowQuerySample = {
  at: number;
  duration_ms: number;
  query: string;
  failed: boolean;
};

const REQUEST_RETENTION_MS = Math.max(15 * 60_000, Number(process.env.APM_REQUEST_RETENTION_MS || 24 * 60 * 60_000));
const QUERY_RETENTION_MS = Math.max(15 * 60_000, Number(process.env.APM_QUERY_RETENTION_MS || 24 * 60 * 60_000));
const MAX_REQUEST_SAMPLES = Math.max(1000, Number(process.env.APM_MAX_REQUEST_SAMPLES || 20_000));
const MAX_QUERY_SAMPLES = Math.max(250, Number(process.env.APM_MAX_QUERY_SAMPLES || 5_000));
const SLOW_QUERY_MS = Math.max(50, Number(process.env.APM_SLOW_QUERY_MS || 750));

const requestSamples: ApiRequestSample[] = [];
const slowQuerySamples: SlowQuerySample[] = [];
let httpInstalled = false;

function trim<T extends { at: number }>(items: T[], retentionMs: number, max: number) {
  const oldest = Date.now() - retentionMs;
  while (items.length && items[0].at < oldest) items.shift();
  if (items.length > max) items.splice(0, items.length - max);
}

function normalizedPath(rawUrl: string) {
  let pathname = rawUrl || "/";
  try { pathname = new URL(rawUrl || "/", "http://apm.local").pathname; } catch {}
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/[0-9]{4,}(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{24,64}(?=\/|$)/gi, "/:id")
    .slice(0, 240);
}

function shouldMeasureApi(rawUrl: string) {
  const path = normalizedPath(rawUrl);
  if (!path.startsWith("/api/")) return false;
  if (/^\/api\/health(?:\/|$)/.test(path)) return false;
  if (/^\/api\/transactions\/notifications\/observability(?:\/|$)/.test(path)) return false;
  return true;
}

export function installHttpInstrumentation() {
  if (httpInstalled || process.env.APM_DISABLED === "1") return;
  httpInstalled = true;
  const proto: any = http.Server.prototype as any;
  const originalEmit = proto.emit;
  if (proto.__kleoApmEmitWrapped) return;
  proto.__kleoApmEmitWrapped = true;
  proto.emit = function (event: string, ...args: any[]) {
    if (event === "request") {
      const req = args[0] as http.IncomingMessage;
      const res = args[1] as http.ServerResponse;
      const rawUrl = String(req?.url || "");
      if (shouldMeasureApi(rawUrl)) {
        const started = process.hrtime.bigint();
        let recorded = false;
        const record = () => {
          if (recorded) return;
          recorded = true;
          const duration = Number(process.hrtime.bigint() - started) / 1_000_000;
          requestSamples.push({
            at: Date.now(),
            duration_ms: Math.round(duration * 100) / 100,
            status: Number(res.statusCode || 0),
            method: String(req.method || "GET").toUpperCase(),
            path: normalizedPath(rawUrl),
          });
          trim(requestSamples, REQUEST_RETENTION_MS, MAX_REQUEST_SAMPLES);
        };
        res.once("finish", record);
        res.once("close", record);
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

export function getApiWindow(windowMinutes = 15) {
  trim(requestSamples, REQUEST_RETENTION_MS, MAX_REQUEST_SAMPLES);
  const since = Date.now() - Math.max(1, windowMinutes) * 60_000;
  const rows = requestSamples.filter(x => x.at >= since);
  const durations = rows.map(x => x.duration_ms);
  const count4xx = rows.filter(x => x.status >= 400 && x.status < 500).length;
  const count5xx = rows.filter(x => x.status >= 500).length;
  const settlementFailures = rows.filter(x => /\/(settle|settlement)(?:\/|$)/i.test(x.path) && x.status >= 500).length;
  const payrollErrors = rows.filter(x => /\/payroll(?:\/|$)/i.test(x.path) && x.status >= 500).length;
  const errorRoutes = new Map<string, number>();
  for (const row of rows) if (row.status >= 400) errorRoutes.set(`${row.method} ${row.path}`, (errorRoutes.get(`${row.method} ${row.path}`) || 0) + 1);
  return {
    window_minutes: windowMinutes,
    requests: rows.length,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    p99_ms: percentile(durations, 99),
    count_4xx: count4xx,
    count_5xx: count5xx,
    rate_4xx: rows.length ? Math.round((count4xx / rows.length) * 10_000) / 100 : 0,
    rate_5xx: rows.length ? Math.round((count5xx / rows.length) * 10_000) / 100 : 0,
    settlement_failures: settlementFailures,
    payroll_errors: payrollErrors,
    top_error_routes: [...errorRoutes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([route, count]) => ({ route, count })),
  };
}

function sanitizeSql(text: unknown) {
  return String(text || "")
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export function observeDbQuery(text: unknown, durationMs: number, failed = false) {
  if (!failed && durationMs < SLOW_QUERY_MS) return;
  slowQuerySamples.push({
    at: Date.now(),
    duration_ms: Math.round(durationMs * 100) / 100,
    query: sanitizeSql(text),
    failed,
  });
  trim(slowQuerySamples, QUERY_RETENTION_MS, MAX_QUERY_SAMPLES);
}

export function getSlowQueryWindow(windowMinutes = 15) {
  trim(slowQuerySamples, QUERY_RETENTION_MS, MAX_QUERY_SAMPLES);
  const since = Date.now() - Math.max(1, windowMinutes) * 60_000;
  const rows = slowQuerySamples.filter(x => x.at >= since);
  return {
    window_minutes: windowMinutes,
    threshold_ms: SLOW_QUERY_MS,
    count: rows.length,
    failed: rows.filter(x => x.failed).length,
    max_ms: rows.length ? Math.max(...rows.map(x => x.duration_ms)) : 0,
    recent: rows.slice(-20).reverse(),
  };
}

export function getRequestSampleCount() {
  trim(requestSamples, REQUEST_RETENTION_MS, MAX_REQUEST_SAMPLES);
  return requestSamples.length;
}
