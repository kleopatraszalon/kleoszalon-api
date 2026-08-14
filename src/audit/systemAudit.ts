import db from "../db";
import type { AuthRequest } from "../middleware/auth";

export type AuditSeverity = "info" | "warning" | "error" | "critical";

export type AuditInput = {
  moduleKey: string;
  entityType: string;
  entityId?: string | number | null;
  action: string;
  severity?: AuditSeverity;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  locationId?: string | number | null;
};

let schemaReady: Promise<void> | null = null;
const SENSITIVE_KEY = /(password|password_hash|token|secret|authorization|cookie|vapid|api[_-]?key|private[_-]?key)/i;

function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max-depth]";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => safeJson(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : safeJson(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function ensureSystemAuditSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS system_audit_log (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        actor_key text,
        actor_name text,
        location_id text,
        module_key text NOT NULL,
        entity_type text NOT NULL,
        entity_id text,
        action text NOT NULL,
        severity text NOT NULL DEFAULT 'info',
        summary text,
        before_data jsonb,
        after_data jsonb,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        request_id text,
        ip_address text,
        user_agent text
      );
      ALTER TABLE system_audit_log ADD COLUMN IF NOT EXISTS request_id text;
      ALTER TABLE system_audit_log ADD COLUMN IF NOT EXISTS ip_address text;
      ALTER TABLE system_audit_log ADD COLUMN IF NOT EXISTS user_agent text;
      CREATE INDEX IF NOT EXISTS system_audit_log_time_idx ON system_audit_log(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS system_audit_log_module_idx ON system_audit_log(module_key, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS system_audit_log_actor_idx ON system_audit_log(actor_key, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS system_audit_log_entity_idx ON system_audit_log(entity_type, entity_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS system_audit_log_location_idx ON system_audit_log(location_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS system_audit_log_request_idx ON system_audit_log(request_id) WHERE request_id IS NOT NULL;
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function firstHeader(req: AuthRequest, name: string) {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
}

function requestIp(req: AuthRequest) {
  const forwarded = firstHeader(req, "x-forwarded-for").split(",")[0]?.trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}

export async function writeSystemAudit(req: AuthRequest, input: AuditInput): Promise<void> {
  try {
    await ensureSystemAuditSchema();
    const actorKey = req.user?.email || (req.user?.id != null ? String(req.user.id) : null);
    const actorName = req.user?.email || null;
    const locationId = input.locationId ?? req.user?.location_id ?? null;
    const requestId = firstHeader(req, "x-request-id") || firstHeader(req, "x-render-request-id") || null;
    const userAgent = firstHeader(req, "user-agent") || null;
    const metadata = safeJson({
      source: "application",
      method: req.method,
      path: req.originalUrl || req.path,
      ...input.metadata,
    });

    await db.query(
      `INSERT INTO system_audit_log(
        actor_key,actor_name,location_id,module_key,entity_type,entity_id,action,severity,summary,
        before_data,after_data,metadata,request_id,ip_address,user_agent
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)`,
      [
        actorKey,
        actorName,
        locationId == null ? null : String(locationId),
        input.moduleKey,
        input.entityType,
        input.entityId == null ? null : String(input.entityId),
        input.action,
        input.severity || "info",
        input.summary || null,
        input.before === undefined ? null : JSON.stringify(safeJson(input.before)),
        input.after === undefined ? null : JSON.stringify(safeJson(input.after)),
        JSON.stringify(metadata ?? {}),
        requestId,
        requestIp(req),
        userAgent,
      ],
    );
  } catch (error) {
    // The audit subsystem must never turn a completed business operation into a 500 response.
    console.warn("Stage17 system audit write failed", (error as any)?.message || error);
  }
}
