import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Router, type NextFunction, type Request, type Response } from "express";
import db from "../db";
import JWT_SECRET from "../security/jwtSecret";
import { requireAdmin } from "../middleware/requireRoles";
import type { AuthRequest } from "../middleware/auth";
import { writeSystemAudit } from "../audit/systemAudit";

type PolicyName = "login" | "booking" | "api";
type Policy = { enabled: boolean; max: number; windowMs: number };
type SecurityConfig = Record<PolicyName, Policy>;
type Bucket = { count: number; resetAt: number };
type BruteState = { failures: number; blockedUntil: number; lastFailureAt: number };

const router = Router();

const DEFAULTS: SecurityConfig = {
  login: { enabled: true, max: 10, windowMs: 15 * 60_000 },
  booking: { enabled: true, max: 120, windowMs: 5 * 60_000 },
  api: { enabled: true, max: 6000, windowMs: 60_000 },
};

const BRUTE_FAILURE_WINDOW_MS = 30 * 60_000;
const BRUTE_BLOCK_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const BRUTE_THRESHOLD = 5;
const SESSION_TOUCH_MS = 5 * 60_000;
const REVOCATION_REFRESH_MS = 30_000;

let config: SecurityConfig = structuredClone(DEFAULTS);
let updatedAt: string | null = null;
let updatedBy: string | null = null;
let loadPromise: Promise<void> | null = null;
const buckets = new Map<string, Bucket>();
const bruteStates = new Map<string, BruteState>();
const sessionTouchedAt = new Map<string, number>();
let revokedTokenHashes = new Set<string>();
let revokedLoadedAt = 0;
let lastPruneAt = 0;

function cloneConfig(value: SecurityConfig): SecurityConfig {
  return { login: { ...value.login }, booking: { ...value.booking }, api: { ...value.api } };
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
    );
    CREATE TABLE IF NOT EXISTS security_sessions (
      token_hash text PRIMARY KEY,
      user_id text,
      email text,
      role_text text,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      ip_address text,
      user_agent text,
      revoked_at timestamptz,
      revoked_by text
    );
    CREATE INDEX IF NOT EXISTS security_sessions_last_seen_idx ON security_sessions(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS security_sessions_user_idx ON security_sessions(user_id,last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS security_sessions_revoked_idx ON security_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
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

function header(req: Request, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ? String(value) : null;
}

function requestIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function requestPath(req: Request): string {
  const raw = String(req.originalUrl || req.url || req.path || "").split("?")[0];
  return raw.startsWith("/api/") ? raw.slice(4) : raw;
}

function isLoginPath(req: Request): boolean {
  const path = requestPath(req);
  return path === "/login" || path === "/employee-login" || path.startsWith("/auth/");
}

function classify(req: Request): PolicyName | null {
  if (req.method === "OPTIONS") return null;
  const path = requestPath(req);
  if (path === "/health" || path === "/health/ready" || path === "/health/db") return null;
  if (path.startsWith("/signage/") || path.startsWith("/kiosk/health")) return null;
  if (isLoginPath(req)) return "login";
  if (path.startsWith("/public/booking")) return "booking";
  return "api";
}

function prune(now: number) {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  for (const [key, state] of bruteStates) {
    if (state.blockedUntil <= now && now - state.lastFailureAt > BRUTE_FAILURE_WINDOW_MS) bruteStates.delete(key);
  }
  for (const [key, touchedAt] of sessionTouchedAt) if (now - touchedAt > 24 * 60 * 60_000) sessionTouchedAt.delete(key);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.removeHeader("X-Powered-By");
  next();
}

function payloadGuard(req: Request, res: Response, next: NextFunction) {
  if (req.body == null || typeof req.body !== "object") return next();
  let nodes = 0;
  let invalid = "";
  const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
  const visit = (value: unknown, depth: number) => {
    if (invalid) return;
    nodes += 1;
    if (nodes > 20_000) { invalid = "A kérés túl összetett."; return; }
    if (depth > 12) { invalid = "A kérés beágyazási mélysége túl nagy."; return; }
    if (typeof value === "string") {
      if (value.includes("\u0000")) invalid = "A kérés tiltott vezérlőkaraktert tartalmaz.";
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (dangerousKeys.has(key)) { invalid = "A kérés tiltott objektumkulcsot tartalmaz."; return; }
        visit(item, depth + 1);
      }
    }
  };
  visit(req.body, 0);
  if (!invalid) return next();
  return res.status(400).json({ error: invalid, code: "INVALID_INPUT_STRUCTURE" });
}

function loginIdentifier(req: Request): string {
  const value = req.body?.email ?? req.body?.login_name ?? req.body?.username ?? req.body?.identifier ?? "";
  return String(value).trim().toLocaleLowerCase("hu-HU").slice(0, 160);
}

function bruteKey(req: Request): string {
  const identifier = loginIdentifier(req);
  return `${requestIp(req)}:${identifier || "<unknown>"}`;
}

function blockDurationForFailures(failures: number): number {
  const level = Math.max(0, Math.floor((failures - BRUTE_THRESHOLD) / 2));
  return BRUTE_BLOCK_STEPS_MS[Math.min(level, BRUTE_BLOCK_STEPS_MS.length - 1)];
}

function bruteForceProtection(req: Request, res: Response, next: NextFunction) {
  if (!isLoginPath(req) || req.method !== "POST") return next();
  const now = Date.now();
  prune(now);
  const key = bruteKey(req);
  const existing = bruteStates.get(key);
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((existing.blockedUntil - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("X-Kleo-Brute-Force", "blocked");
    return res.status(429).json({
      error: "Túl sok sikertelen bejelentkezési kísérlet. Próbáld újra később.",
      code: "AUTH_TEMPORARILY_BLOCKED",
      retry_after_seconds: retryAfter,
    });
  }

  res.once("finish", () => {
    const success = res.statusCode >= 200 && res.statusCode < 300;
    if (success) bruteStates.delete(key);
    else if (res.statusCode === 401 || res.statusCode === 403) {
      const current = bruteStates.get(key);
      const stale = !current || now - current.lastFailureAt > BRUTE_FAILURE_WINDOW_MS;
      const failures = (stale ? 0 : current.failures) + 1;
      const blockedUntil = failures >= BRUTE_THRESHOLD ? Date.now() + blockDurationForFailures(failures) : 0;
      bruteStates.set(key, { failures, blockedUntil, lastFailureAt: Date.now() });
    }
    void writeSystemAudit(req as AuthRequest, {
      moduleKey: "security.auth",
      entityType: "login",
      entityId: loginIdentifier(req) || null,
      action: success ? "login_success" : "login_failed",
      severity: success ? "info" : "warning",
      summary: success ? "Sikeres bejelentkezés." : "Sikertelen bejelentkezési kísérlet.",
      metadata: { status_code: res.statusCode },
    });
  });
  next();
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const policyName = classify(req);
  if (!policyName) return next();
  const policy = config[policyName];
  if (!policy.enabled) return next();
  const now = Date.now();
  prune(now);
  const key = `${policyName}:${requestIp(req)}`;
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

function requestToken(req: Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return String((req as any).cookies?.token || "").trim();
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function refreshRevocations(force = false) {
  const now = Date.now();
  if (!force && now - revokedLoadedAt < REVOCATION_REFRESH_MS) return;
  revokedLoadedAt = now;
  try {
    await ensureStorage();
    const { rows } = await db.query("SELECT token_hash FROM security_sessions WHERE revoked_at IS NOT NULL");
    revokedTokenHashes = new Set(rows.map((row: any) => String(row.token_hash)));
  } catch (error: any) {
    console.warn("[security-sessions] revocation refresh skipped:", error?.message || error);
  }
}

function sessionGuard(req: Request, res: Response, next: NextFunction) {
  const token = requestToken(req);
  if (!token) return next();
  let claims: any;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch {
    return next();
  }
  const hash = tokenHash(token);
  void refreshRevocations();
  if (revokedTokenHashes.has(hash)) {
    res.clearCookie("token", { path: "/" });
    return res.status(401).json({ error: "A munkamenet visszavonásra került.", code: "SESSION_REVOKED" });
  }
  const now = Date.now();
  const lastTouch = sessionTouchedAt.get(hash) || 0;
  if (now - lastTouch >= SESSION_TOUCH_MS) {
    sessionTouchedAt.set(hash, now);
    void ensureStorage().then(() => db.query(
      `INSERT INTO security_sessions(token_hash,user_id,email,role_text,first_seen_at,last_seen_at,ip_address,user_agent)
       VALUES($1,$2,$3,$4,now(),now(),$5,$6)
       ON CONFLICT(token_hash) DO UPDATE SET
         user_id=EXCLUDED.user_id,email=EXCLUDED.email,role_text=EXCLUDED.role_text,
         last_seen_at=now(),ip_address=EXCLUDED.ip_address,user_agent=EXCLUDED.user_agent`,
      [
        hash,
        claims?.id == null ? null : String(claims.id),
        claims?.email == null ? null : String(claims.email),
        claims?.role == null ? null : JSON.stringify(claims.role),
        requestIp(req),
        String(req.headers["user-agent"] || "").slice(0, 500) || null,
      ],
    )).catch((error: any) => console.warn("[security-sessions] touch failed:", error?.message || error));
  }
  next();
}

// authRoutes is mounted first at /api, so these middleware functions protect API traffic that later falls through to other routers.
router.use(securityHeaders);
router.use(payloadGuard);
router.use(bruteForceProtection);
router.use(rateLimit);
router.use(sessionGuard);

function actor(req: AuthRequest): string {
  return String((req.user as any)?.id || (req.user as any)?.email || "admin");
}

router.get("/admin/security-settings", requireAdmin, async (req: AuthRequest, res: Response) => {
  await loadStoredConfig();
  await refreshRevocations();
  const xff = header(req, "x-forwarded-for");
  const cfConnectingIp = header(req, "cf-connecting-ip");
  const cfRay = header(req, "cf-ray");
  const now = Date.now();
  const blockedLogins = Array.from(bruteStates.values()).filter(x => x.blockedUntil > now).length;
  return res.json({
    policies: cloneConfig(config),
    defaults: cloneConfig(DEFAULTS),
    hardening: {
      security_headers: true,
      hsts_in_production: true,
      payload_structure_guard: true,
      brute_force_protection: true,
      brute_force_threshold: BRUTE_THRESHOLD,
      progressive_blocks_seconds: BRUTE_BLOCK_STEPS_MS.map(ms => ms / 1000),
      currently_blocked_login_keys: blockedLogins,
      session_inventory: true,
      remote_session_revocation: true,
      revoked_session_count: revokedTokenHashes.size,
    },
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

router.get("/admin/security-sessions", requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    await ensureStorage();
    const { rows } = await db.query(`
      SELECT token_hash,user_id,email,role_text,first_seen_at,last_seen_at,ip_address,user_agent,revoked_at,revoked_by
      FROM security_sessions
      WHERE last_seen_at > now() - interval '30 days'
      ORDER BY last_seen_at DESC
      LIMIT 500
    `);
    return res.json({ sessions: rows });
  } catch (error: any) {
    return res.status(500).json({ error: "A munkamenetek nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.post("/admin/security-sessions/:tokenHash/revoke", requireAdmin, async (req: AuthRequest, res: Response) => {
  const hash = String(req.params.tokenHash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: "Érvénytelen munkamenet-azonosító." });
  try {
    await ensureStorage();
    const by = actor(req);
    const result = await db.query(
      "UPDATE security_sessions SET revoked_at=COALESCE(revoked_at,now()),revoked_by=$2 WHERE token_hash=$1 RETURNING token_hash,user_id,email,revoked_at",
      [hash, by],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "A munkamenet nem található." });
    revokedTokenHashes.add(hash);
    await writeSystemAudit(req, {
      moduleKey: "security.sessions",
      entityType: "session",
      entityId: hash.slice(0, 16),
      action: "session_revoked",
      severity: "warning",
      summary: "Adminisztrátor távolról visszavont egy munkamenetet.",
      metadata: { user_id: result.rows[0].user_id, email: result.rows[0].email },
    });
    return res.json({ ok: true, session: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: "A munkamenet visszavonása sikertelen.", detail: error?.message || String(error) });
  }
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
    await writeSystemAudit(req, {
      moduleKey: "security.settings",
      entityType: "runtime_policy",
      entityId: "1",
      action: "security_policy_updated",
      severity: "warning",
      summary: "Biztonsági rate-limit szabályok módosítva.",
      after: nextConfig,
    });
    return res.json({ ok: true, policies: cloneConfig(config), updated_at: updatedAt, updated_by: updatedBy });
  } catch (error: any) {
    console.error("[security-settings] save failed:", error?.message || error);
    return res.status(500).json({ error: "A biztonsági beállításokat nem sikerült menteni." });
  }
});

router.post("/admin/security-settings/reset", requireAdmin, async (req: AuthRequest, res: Response) => {
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
    bruteStates.clear();
    updatedAt = rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : new Date().toISOString();
    updatedBy = rows[0]?.updated_by ?? by;
    return res.json({ ok: true, policies: cloneConfig(config), updated_at: updatedAt, updated_by: updatedBy });
  } catch {
    return res.status(500).json({ error: "Az alapértelmezett biztonsági beállításokat nem sikerült visszaállítani." });
  }
});

export default router;
