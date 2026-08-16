import crypto from "crypto";
import db from "../db";
import JWT_SECRET from "../security/jwtSecret";

export const FRANCHISE_DEFAULTS = {
  "franchise.mailchimp_audience_id": "50fc355134",
  "franchise.mailchimp_server_prefix": "us18",
  "franchise.mailchimp_double_opt_in": false,
  "franchise.lp_segment_id": "3032077",
  "franchise.lp_tag_name": "LP_form",
  "franchise.sp_tag_name": "SP_form",
  "franchise.lp_path": "/lp1",
  "franchise.sp_path": "/ajanlat",
  "franchise.thank_you_path": "/koszonjuk",
} as const;

export type FranchiseSettingKey = keyof typeof FRANCHISE_DEFAULTS;

export type FranchiseFunnelConfig = {
  apiKey: string;
  audienceId: string;
  serverPrefix: string;
  doubleOptIn: boolean;
  lpSegmentId: string;
  lpTagName: string;
  spTagName: string;
  lpPath: string;
  spPath: string;
  thankYouPath: string;
  apiKeySource: "database" | "environment" | "none";
};

let schemaReady: Promise<void> | null = null;

const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);

function encryptionKey() {
  const source = clean(process.env.FRANCHISE_SETTINGS_ENCRYPTION_KEY || JWT_SECRET, 2000);
  return crypto.createHash("sha256").update(source).digest();
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptSecret(payload: string) {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < 29) throw new Error("INVALID_ENCRYPTED_SECRET");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function ensureFranchiseFunnelConfigSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          key text NOT NULL,
          scope_type text NOT NULL DEFAULT 'global',
          scope_id text NOT NULL DEFAULT '*',
          value jsonb NOT NULL,
          category text NOT NULL,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(key,scope_type,scope_id)
        );
        CREATE TABLE IF NOT EXISTS system_secret_settings (
          key text PRIMARY KEY,
          encrypted_value text NOT NULL,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      for (const [key, value] of Object.entries(FRANCHISE_DEFAULTS)) {
        await db.query(
          `INSERT INTO system_settings(key,scope_type,scope_id,value,category)
           VALUES($1,'global','*',$2::jsonb,'franchise')
           ON CONFLICT(key,scope_type,scope_id) DO NOTHING`,
          [key, JSON.stringify(value)],
        );
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function settingValue<T>(key: FranchiseSettingKey, fallback: T): Promise<T> {
  await ensureFranchiseFunnelConfigSchema();
  const row = (
    await db.query(
      `SELECT value FROM system_settings WHERE key=$1 AND scope_type='global' AND scope_id='*' LIMIT 1`,
      [key],
    )
  ).rows[0];
  return (row?.value ?? fallback) as T;
}

async function databaseApiKey() {
  await ensureFranchiseFunnelConfigSchema();
  const row = (
    await db.query(`SELECT encrypted_value FROM system_secret_settings WHERE key='franchise.mailchimp_api_key' LIMIT 1`)
  ).rows[0];
  if (!row?.encrypted_value) return "";
  try {
    return clean(decryptSecret(String(row.encrypted_value)), 500);
  } catch (error) {
    console.error("[franchise-settings-decrypt]", error);
    return "";
  }
}

export async function getFranchiseFunnelConfig(): Promise<FranchiseFunnelConfig> {
  const dbApiKey = await databaseApiKey();
  const envApiKey = clean(process.env.MAILCHIMP_API_KEY, 500);
  const apiKey = dbApiKey || envApiKey;
  const audienceId = clean(
    await settingValue("franchise.mailchimp_audience_id", clean(process.env.MAILCHIMP_AUDIENCE_ID, 200) || FRANCHISE_DEFAULTS["franchise.mailchimp_audience_id"]),
    200,
  );
  const serverPrefix = clean(
    await settingValue("franchise.mailchimp_server_prefix", clean(process.env.MAILCHIMP_SERVER_PREFIX, 80) || apiKey.split("-").pop() || FRANCHISE_DEFAULTS["franchise.mailchimp_server_prefix"]),
    80,
  );
  const envDoubleOptIn = process.env.MAILCHIMP_DOUBLE_OPT_IN === "1";
  return {
    apiKey,
    audienceId,
    serverPrefix: serverPrefix || clean(apiKey.split("-").pop(), 80),
    doubleOptIn: Boolean(await settingValue("franchise.mailchimp_double_opt_in", envDoubleOptIn)),
    lpSegmentId: clean(await settingValue("franchise.lp_segment_id", FRANCHISE_DEFAULTS["franchise.lp_segment_id"]), 80),
    lpTagName: clean(await settingValue("franchise.lp_tag_name", FRANCHISE_DEFAULTS["franchise.lp_tag_name"]), 80),
    spTagName: clean(await settingValue("franchise.sp_tag_name", FRANCHISE_DEFAULTS["franchise.sp_tag_name"]), 80),
    lpPath: clean(await settingValue("franchise.lp_path", FRANCHISE_DEFAULTS["franchise.lp_path"]), 160),
    spPath: clean(await settingValue("franchise.sp_path", FRANCHISE_DEFAULTS["franchise.sp_path"]), 160),
    thankYouPath: clean(await settingValue("franchise.thank_you_path", FRANCHISE_DEFAULTS["franchise.thank_you_path"]), 160),
    apiKeySource: dbApiKey ? "database" : envApiKey ? "environment" : "none",
  };
}

export async function saveFranchiseMailchimpApiKey(value: string, updatedBy: string) {
  const apiKey = clean(value, 500);
  if (!apiKey || !/-[a-z]{2}\d+$/i.test(apiKey)) {
    throw Object.assign(new Error("A Mailchimp API-kulcs formátuma érvénytelen."), { status: 400 });
  }
  await ensureFranchiseFunnelConfigSchema();
  await db.query(
    `INSERT INTO system_secret_settings(key,encrypted_value,updated_by,updated_at)
     VALUES('franchise.mailchimp_api_key',$1,$2,now())
     ON CONFLICT(key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [encryptSecret(apiKey), updatedBy || null],
  );
  return { configured: true, source: "database" as const, suffix: apiKey.slice(-8) };
}

export async function deleteFranchiseMailchimpApiKey() {
  await ensureFranchiseFunnelConfigSchema();
  await db.query(`DELETE FROM system_secret_settings WHERE key='franchise.mailchimp_api_key'`);
}

export async function getFranchiseMailchimpSecretStatus() {
  const cfg = await getFranchiseFunnelConfig();
  return {
    configured: Boolean(cfg.apiKey),
    source: cfg.apiKeySource,
    suffix: cfg.apiKey ? cfg.apiKey.slice(-8) : null,
    audience_id: cfg.audienceId,
    server_prefix: cfg.serverPrefix,
  };
}

export async function testFranchiseMailchimpConnection() {
  const cfg = await getFranchiseFunnelConfig();
  if (!cfg.apiKey || !cfg.audienceId || !cfg.serverPrefix) {
    throw Object.assign(new Error("A Mailchimp kapcsolat nincs teljesen beállítva."), { status: 400 });
  }
  const auth = Buffer.from(`kleoszalon:${cfg.apiKey}`).toString("base64");
  const response = await fetch(`https://${cfg.serverPrefix}.api.mailchimp.com/3.0/lists/${encodeURIComponent(cfg.audienceId)}?fields=id,name,stats.member_count`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({} as any));
  if (!response.ok) {
    throw Object.assign(new Error(body?.detail || body?.title || `Mailchimp HTTP ${response.status}`), { status: 502 });
  }
  return {
    ok: true,
    audience_id: body?.id || cfg.audienceId,
    audience_name: body?.name || null,
    member_count: Number(body?.stats?.member_count || 0),
    server_prefix: cfg.serverPrefix,
  };
}
