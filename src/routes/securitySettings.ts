import { Router, type NextFunction, type Request, type Response } from "express";
import db from "../db";
import { requireAdmin } from "../middleware/requireRoles";
import type { AuthRequest } from "../middleware/auth";

type PolicyName = "login" | "booking" | "api";
type Policy = { enabled: boolean; max: number; windowMs: number };
type SecurityConfig = Record<PolicyName, Policy>;
type Bucket = { count: number; resetAt: number };

const router = Router();

const DEFAULTS: SecurityConfig = {
  login: { enabled: true, max: 10, windowMs: 15 * 60_000 },
  booking: { enabled: true, max: 120, windowMs: 5 * 60_000 },
  api: { enabled: true, max: 6000, windowMs: 60_000 },
};

let config: SecurityConfig = structuredClone(DEFAULTS);
let updatedAt: string | null = null;
let updatedBy: string | null = null;
let loadPromise: Promise<void> | null = null;
const buckets = new Map<string, Bucket>();
let lastPruneAt = 0;

function cloneConfig(value: SecurityConfig): SecurityConfig {
  return {
    login: { ...value.login },
    booking: { ...value.booking },
    api: { ...value.api },
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function normalizePolicy(raw: any, fallback: Policy): Policy {
  return {
    enabled: raw?.enabled === undefined ? fallback.enabled : Boolean(raw.enabled),
    max: clampNumber(raw?.max, fallback.max, 1, 100_000),
    windowMs: clampNumber(raw?.windowMs, fallback.windowMs, 1_000, 24 * 60 * 60_000),
  };
}

function normalizeConfig(raw: any): SecurityConfig {
  return {
    login: normalizePolicy(raw?.login, DEFAULTS.login),
    booking: normalizePolicy(raw?.booking, DEFAULTS.booking),
    api: normalizePolicy(raw?.api, DEFAULTS.api),
  };
}

async function ensureStorage() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS security_runtime_settings (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    )
  `);
}

async function loadStoredConfig() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      await ensureStorage();
      const { rows } = await db.query("SELECT config, updated_at, updated_by FROM security_runtime_settings WHERE id=1");
      if (rows[0]) {
        config = normalizeConfig(rows[0].config);
        updatedAt = rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null;
        updatedBy = rows[0].updated_by ?? null;
      }
    } catch (error: any) {
      console.warn("[security-settings] persistent config load skipped:", error?.message || error);
    }
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}

void loadStoredConfig();

function requestIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function classify(req: Request): PolicyName | null {
  if (req.method === "OPTIONS") return null;
  const path = String(req.path || req.url || "").split("?")[0];
  if (path === "/health" || path === "/health/ready" || path === "/health/db") return null;
  if (path.startsWith("/signage/") || path.startsWith("/kiosk/health")) return null;
  if (path === "/login" || path === "/employee-login") return "login";
  if (path.startsWith("/public/booking")) return "booking";
  return "api";
}

function prune(now: number) {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const policyName = classify(req);
  if (!policyName) return next();
  const policy = config[policyName];
  if (!policy.enabled) return next();

  const now = Date.now();
  prune(now);
  const ip = requestIp(req);
  const key = `${policyName}:${ip}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + policy.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const remaining = Math.max(0, policy.max - bucket.count);
  res.setHeader("RateLimit-Limit", String(policy.max));
  res.setHeader("RateLimit-Remaining", String(remaining));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  res.setHeader("X-Kleo-RateLimit-Policy", policyName);

  if (bucket.count <= policy.max) return next();
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: "Túl sok kérés érkezett. Kérjük, próbálja újra később.",
    code: "RATE_LIMITED",
    policy: policyName,
    retry_after_seconds: retryAfter,
  });
}

router.use(rateLimit);

function header(req: Request, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ? String(value) : null;
}

function actor(req: AuthRequest): string {
  return String((req.user as any)?.id || (req.user as any)?.email || "admin");
}

router.get("/admin/security-settings", requireAdmin, async (req: AuthRequest, res: Response) => {
  await loadStoredConfig();
  const xff = header(req, "x-forwarded-for");
  const cfConnectingIp = header(req, "cf-connecting-ip");
  const cfRay = header(req, "cf-ray");
  return res.json({
    policies: cloneConfig(config),
    defaults: cloneConfig(DEFAULTS),
    persistence: {
      type: "postgres",
      limiter_store: "process-memory",
      warning: "A limit-számlálók példányonként memóriában élnek. Több API példánynál Redis/Key Value közös store ajánlott.",
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
    cloudflare: {
      api_token_configured: Boolean(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN),
      zone_id_configured: Boolean(process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID),
      headers_detected: Boolean(cfConnectingIp || cfRay),
      cf_ray: cfRay,
      connecting_ip_present: Boolean(cfConnectingIp),
      note: "A Cloudflare API token értéke biztonsági okból soha nem kerül a frontendnek visszaadásra.",
    },
    proxy: {
      express_trust_proxy_expected: 1,
      request_ip: requestIp(req),
      x_forwarded_for: xff,
      cf_connecting_ip: cfConnectingIp,
      forwarded_chain_length: xff ? xff.split(",").map(x => x.trim()).filter(Boolean).length : 0,
    },
  });
});

router.put("/admin/security-settings", requireAdmin, async (req: AuthRequest, res: Response) => {
  const nextConfig = normalizeConfig(req.body?.policies || req.body || {});
  const by = actor(req);
  try {
    await ensureStorage();
    const { rows } = await db.query(
      `INSERT INTO security_runtime_settings(id,config,updated_at,updated_by)
       VALUES(1,$1::jsonb,now(),$2)
       ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,updated_at=now(),updated_by=EXCLUDED.updated_by
       RETURNING updated_at,updated_by`,
      [JSON.stringify(nextConfig), by],
    );
    config = nextConfig;
    buckets.clear();
    updatedAt = rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : new Date().toISOString();
    updatedBy = rows[0]?.updated_by ?? by;
    return res.json({ ok: true, policies: cloneConfig(config), updated_at: updatedAt, updated_by: updatedBy });
  } catch (error: any) {
    console.error("[security-settings] save failed:", error?.message || error);
    return res.status(500).json({ error: "A biztonsági beállításokat nem sikerült menteni." });
  }
});

router.post("/admin/security-settings/reset", requireAdmin, async (req: AuthRequest, res: Response) => {
  req.body = { policies: cloneConfig(DEFAULTS) };
  const nextConfig = cloneConfig(DEFAULTS);
  const by = actor(req);
  try {
    await ensureStorage();
    const { rows } = await db.query(
      `INSERT INTO security_runtime_settings(id,config,updated_at,updated_by)
       VALUES(1,$1::jsonb,now(),$2)
       ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,updated_at=now(),updated_by=EXCLUDED.updated_by
       RETURNING updated_at,updated_by`,
      [JSON.stringify(nextConfig), by],
    );
    config = nextConfig;
    buckets.clear();
    updatedAt = rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : new Date().toISOString();
    updatedBy = rows[0]?.updated_by ?? by;
    return res.json({ ok: true, policies: cloneConfig(config), updated_at: updatedAt, updated_by: updatedBy });
  } catch (error: any) {
    return res.status(500).json({ error: "Az alapértelmezett biztonsági beállításokat nem sikerült visszaállítani." });
  }
});

export default router;
