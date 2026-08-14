import crypto from "crypto";
import pool from "../db";
import JWT_SECRET from "../security/jwtSecret";

const ALLOWED_KEYS = [
  "COMPLAINT_EMAIL","COMPLAINT_IMAP_HOST","COMPLAINT_IMAP_PORT","COMPLAINT_IMAP_USER","COMPLAINT_IMAP_PASS",
  "COMPLAINT_IMAP_MAILBOX","COMPLAINT_IMAP_SENT_MAILBOX","COMPLAINT_IMAP_POLL_SECONDS","COMPLAINT_IMAP_MAX_PER_RUN","COMPLAINT_SLA_DAYS",
  "IMAP_HOST","IMAP_PORT","IMAP_USER","IMAP_PASS","IMAP_SENT_MAILBOX","IMAP_SENT_SYNC","IMAP_TLS_REJECT_UNAUTHORIZED",
  "VIR_GITHUB_TOKEN","VIR_GITHUB_OWNER","VIR_GITHUB_REPOS","VIR_GITHUB_ENVIRONMENT","VIR_GITHUB_REVIEWER","VIR_GITHUB_PREVENT_SELF_REVIEW",
  "VIR_RENDER_API_KEY","VIR_RENDER_SERVICE_ID","VIR_RENDER_POSTGRES_ID","VIR_RENDER_TARGET_INSTANCES","VIR_RENDER_ENABLE_DB_HA",
] as const;

export type RuntimeSettingKey = typeof ALLOWED_KEYS[number];
const allowed = new Set<string>(ALLOWED_KEYS);
const secretKeys = new Set<string>(["COMPLAINT_IMAP_PASS","IMAP_PASS","VIR_GITHUB_TOKEN","VIR_RENDER_API_KEY"]);
let schemaPromise: Promise<void> | null = null;

function encryptionKey(): Buffer {
  const seed = String(process.env.VIR_SETTINGS_ENCRYPTION_KEY || JWT_SECRET || "");
  if (!seed) throw new Error("VIR runtime setting encryption key is unavailable");
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(payload: string): string {
  const [version, iv64, tag64, body64] = String(payload || "").split(":");
  if (version !== "v1" || !iv64 || !tag64 || !body64) throw new Error("Unsupported encrypted VIR setting format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body64, "base64")), decipher.final()]).toString("utf8");
}

export async function ensureRuntimeSettingsSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS vir_runtime_settings(
      setting_key text PRIMARY KEY,
      value_text text,
      value_encrypted text,
      is_secret boolean NOT NULL DEFAULT false,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vir_runtime_setting_audit(
      id bigserial PRIMARY KEY,
      setting_key text NOT NULL,
      action text NOT NULL,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined).catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function rowsMap(): Promise<Map<string, any>> {
  await ensureRuntimeSettingsSchema();
  const rows = (await pool.query(`SELECT setting_key,value_text,value_encrypted,is_secret,updated_at FROM vir_runtime_settings`)).rows;
  return new Map(rows.map((row) => [String(row.setting_key), row]));
}

export async function hydrateRuntimeSettings(): Promise<void> {
  const rows = await rowsMap();
  for (const key of ALLOWED_KEYS) {
    const row = rows.get(key);
    if (!row) continue;
    try {
      const value = row.is_secret ? decrypt(row.value_encrypted || "") : String(row.value_text ?? "");
      process.env[key] = value;
    } catch (error) {
      console.error(`VIR runtime setting hydrate failed for ${key}:`, error);
    }
  }
}

export async function saveRuntimeSettings(input: Record<string, unknown>, updatedBy: string): Promise<void> {
  await ensureRuntimeSettingsSchema();
  for (const [key, raw] of Object.entries(input || {})) {
    if (!allowed.has(key)) continue;
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    const isSecret = secretKeys.has(key);
    if (isSecret && !value) continue; // blank secret means: keep current value
    await pool.query(`
      INSERT INTO vir_runtime_settings(setting_key,value_text,value_encrypted,is_secret,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,now())
      ON CONFLICT(setting_key) DO UPDATE SET value_text=EXCLUDED.value_text,value_encrypted=EXCLUDED.value_encrypted,
        is_secret=EXCLUDED.is_secret,updated_by=EXCLUDED.updated_by,updated_at=now()
    `, [key, isSecret ? null : value, isSecret ? encrypt(value) : null, isSecret, updatedBy]);
    await pool.query(`INSERT INTO vir_runtime_setting_audit(setting_key,action,updated_by) VALUES($1,'update',$2)`, [key, updatedBy]);
    process.env[key] = value;
  }
}

export async function getRuntimeSecret(key: RuntimeSettingKey): Promise<string> {
  if (!secretKeys.has(key)) return String(process.env[key] || "");
  const row = (await pool.query(`SELECT value_encrypted FROM vir_runtime_settings WHERE setting_key=$1 AND is_secret=true`, [key])).rows[0];
  if (row?.value_encrypted) return decrypt(row.value_encrypted);
  return String(process.env[key] || "");
}

export async function getRuntimeValue(key: RuntimeSettingKey): Promise<string> {
  const row = (await pool.query(`SELECT value_text,value_encrypted,is_secret FROM vir_runtime_settings WHERE setting_key=$1`, [key])).rows[0];
  if (!row) return String(process.env[key] || "");
  return row.is_secret ? decrypt(row.value_encrypted || "") : String(row.value_text ?? "");
}

export async function getRuntimeSettingsSnapshot(): Promise<Record<string, { value: string; configured: boolean; secret: boolean; updated_at: string | null }>> {
  const rows = await rowsMap();
  const out: Record<string, { value: string; configured: boolean; secret: boolean; updated_at: string | null }> = {};
  for (const key of ALLOWED_KEYS) {
    const row = rows.get(key);
    const isSecret = secretKeys.has(key);
    const envValue = String(process.env[key] || "");
    out[key] = {
      value: isSecret ? "" : String(row?.value_text ?? envValue),
      configured: isSecret ? Boolean(row?.value_encrypted || envValue) : Boolean(row?.value_text ?? envValue),
      secret: isSecret,
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }
  return out;
}

export function isRuntimeSettingSecret(key: string): boolean { return secretKeys.has(key); }
