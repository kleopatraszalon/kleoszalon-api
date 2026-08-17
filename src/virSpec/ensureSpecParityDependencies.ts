import pool from "../db";
import { ensureRuntimeSettingsSchema, hydrateRuntimeSettings } from "../services/virRuntimeSettings";
import { ensureVirPerformanceIndexes } from "../performance/ensureVirPerformanceIndexes";

let ensurePromise: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const retryDelayMs = (() => {
  const configured = Number(process.env.VIR_SPEC_DEPENDENCY_RETRY_MS || 15000);
  return Number.isFinite(configured) ? Math.max(1000, configured) : 15000;
})();

const transientNetworkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
]);

/**
 * Only connectivity/outage failures are allowed to degrade startup. SQL/schema
 * defects still fail fast so a broken migration cannot be hidden by retries.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || "").toUpperCase();
  const message = String(candidate?.message || error || "");

  if (transientNetworkCodes.has(code) || code.startsWith("08")) return true;

  return /connection\s+(?:terminated|refused|reset)|connect\s+econnrefused|timeout|timed\s*out|could\s+not\s+connect|server\s+closed\s+the\s+connection|network\s+is\s+unreachable/i.test(
    message,
  );
}

function scheduleRetry(): void {
  if (retryTimer) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureSpecParityDependencies().catch((error) => {
      console.error("[startup] VIR spec dependency retry failed:", error);
    });
  }, retryDelayMs);

  retryTimer.unref?.();
}

/**
 * Tables used across the legacy-spec parity modules that must exist even when
 * optional workers/pages have not been opened yet. This runs before app.listen,
 * so complaint attachments and review moderation cannot race first-use schema creation.
 *
 * Runtime infrastructure/mail settings are also hydrated here so the IMAP worker
 * receives the encrypted VIR-managed configuration before it starts.
 *
 * A temporary DB/network outage must not prevent the HTTP server from listening:
 * server.ts already exposes degraded 503 behaviour while its DB ping loop recovers.
 * Transient dependency failures therefore schedule a bounded retry. Programming,
 * SQL and schema errors are still re-thrown and remain startup-fatal.
 */
export function ensureSpecParityDependencies(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS operations_quality_records(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        module_key text NOT NULL,
        title text NOT NULL,
        description text,
        location_name text,
        department text,
        assignee text,
        priority text DEFAULT 'normal',
        status text DEFAULT 'open',
        due_at timestamptz,
        recurrence text,
        requires_approval boolean DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS complaint_mail_messages(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mailbox_key text NOT NULL,
        imap_uid bigint NOT NULL,
        message_id text,
        sender_email text,
        sender_name text,
        recipient text,
        subject text,
        received_at timestamptz,
        raw_sha256 text NOT NULL,
        created_at timestamptz DEFAULT now(),
        UNIQUE(mailbox_key, imap_uid)
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_mail_message_id
        ON complaint_mail_messages(message_id);

      CREATE TABLE IF NOT EXISTS complaint_attachments(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mail_message_id uuid REFERENCES complaint_mail_messages(id) ON DELETE CASCADE,
        filename text NOT NULL,
        content_type text,
        byte_size bigint NOT NULL DEFAULT 0,
        sha256 text NOT NULL,
        content bytea NOT NULL,
        source text NOT NULL DEFAULT 'email',
        created_at timestamptz DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint
        ON complaint_attachments(complaint_id, created_at);

      CREATE TABLE IF NOT EXISTS social_campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type text NOT NULL DEFAULT 'manual',
        source_id uuid,
        name text NOT NULL,
        headline text NOT NULL,
        description text NOT NULL DEFAULT '',
        image_url text,
        video_url text,
        link_url text,
        platform_payloads jsonb NOT NULL DEFAULT '{}'::jsonb,
        scheduled_at timestamptz,
        status text NOT NULL DEFAULT 'draft',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS social_publications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id uuid NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
        platform text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'draft',
        scheduled_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        external_id text,
        external_container_id text,
        external_url text,
        response jsonb,
        error text,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(campaign_id, platform)
      );
    `)
      .then(async () => {
        await ensureRuntimeSettingsSchema();
        await hydrateRuntimeSettings();
        // Performance tuning must never make startup fail: each optional legacy
        // table/index is checked and isolated by ensureVirPerformanceIndexes.
        await ensureVirPerformanceIndexes();
      })
      .then(() => undefined)
      .catch((error) => {
        ensurePromise = null;

        if (isTransientDatabaseError(error)) {
          const candidate = error as { code?: unknown; message?: unknown } | null;
          console.error("[startup] VIR spec dependencies waiting for database; retry scheduled.", {
            code: candidate?.code || "DB_UNAVAILABLE",
            message: String(candidate?.message || error || "database unavailable"),
            retry_ms: retryDelayMs,
          });
          scheduleRetry();
          return;
        }

        throw error;
      });
  }
  return ensurePromise;
}

export default ensureSpecParityDependencies;
