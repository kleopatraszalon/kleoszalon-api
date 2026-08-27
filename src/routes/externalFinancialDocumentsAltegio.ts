import { Router, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager"));

const GLOBAL = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const PROVIDERS = new Set(["internal", "invee_manual", "nav_epg", "hardware_epg"]);
const NAV_OWNERS = new Set(["vir", "external", "not_applicable"]);
const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function isoDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const hu = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (hu) return `${hu[1]}-${hu[2].padStart(2, "0")}-${hu[3].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

let prereqReady: Promise<void> | null = null;
async function ensurePrerequisites() {
  if (!prereqReady) prereqReady = db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS legal_entity_document_settings(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
      location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
      receipt_provider text NOT NULL DEFAULT 'internal',
      drive_folder_id text,
      altegio_location_id text,
      external_account_ref text,
      nav_reporting_owner text NOT NULL DEFAULT 'external',
      active boolean NOT NULL DEFAULT true,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(receipt_provider IN('internal','invee_manual','nav_epg','hardware_epg')),
      CHECK(nav_reporting_owner IN('vir','external','not_applicable'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_entity_document_settings_scope
      ON legal_entity_document_settings(legal_entity_id,COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid));

    CREATE TABLE IF NOT EXISTS external_financial_import_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
      location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
      source text NOT NULL,
      import_profile text NOT NULL DEFAULT 'generic_file',
      file_name text NOT NULL,
      mime_type text NOT NULL,
      content_sha256 text NOT NULL,
      payload bytea NOT NULL,
      imported_count integer NOT NULL DEFAULT 0,
      duplicate_count integer NOT NULL DEFAULT 0,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(source IN('invee','google_drive','altegio','file_upload','manual'))
    );

    CREATE TABLE IF NOT EXISTS external_financial_documents(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
      location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
      import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL,
      source text NOT NULL,
      document_type text NOT NULL DEFAULT 'other',
      external_id text,
      external_document_number text,
      issue_date date,
      counterparty_name text,
      counterparty_tax_number text,
      currency text NOT NULL DEFAULT 'HUF',
      net_amount numeric(14,2) NOT NULL DEFAULT 0,
      vat_amount numeric(14,2) NOT NULL DEFAULT 0,
      gross_amount numeric(14,2) NOT NULL DEFAULT 0,
      payment_method text,
      work_order_id text,
      source_url text,
      source_file_id text,
      file_name text,
      mime_type text,
      content_sha256 text,
      status text NOT NULL DEFAULT 'pending_review',
      nav_reporting_owner text NOT NULL DEFAULT 'external',
      nav_excluded boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text,
      reviewed_by text,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(source IN('invee','google_drive','altegio','file_upload','manual')),
      CHECK(document_type IN('invoice','receipt','credit_note','void_receipt','transaction','other')),
      CHECK(status IN('pending_review','approved','rejected','duplicate','voided')),
      CHECK(nav_reporting_owner IN('vir','external','not_applicable')),
      CHECK(nav_reporting_owner<>'external' OR nav_excluded=true)
    );
    ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_source_id
      ON external_financial_documents(legal_entity_id,source,external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_hash
      ON external_financial_documents(legal_entity_id,content_sha256) WHERE content_sha256 IS NOT NULL;

    CREATE TABLE IF NOT EXISTS external_financial_document_events(
      id bigserial PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES external_financial_documents(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      actor text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined).catch((e) => { prereqReady = null; throw e; });
  return prereqReady;
}

function isGlobal(req: AuthRequest) {
  return parseRoleKeys(req.user?.role).some((r) => GLOBAL.has(r));
}
async function canUseEntity(req: AuthRequest, entityId: string, locationId?: string | null) {
  if (isGlobal(req)) return true;
  const own = text(req.user?.location_id);
  if (!own) return false;
  if (locationId && locationId !== own) return false;
  return Boolean((await db.query(
    `SELECT 1 FROM legal_entity_locations WHERE legal_entity_id=$1::uuid AND location_id::text=$2 AND active=true`,
    [entityId, own],
  )).rows[0]);
}
async function requireEntity(req: AuthRequest, res: Response, entityId: string, locationId?: string | null) {
  if (!entityId) {
    res.status(400).json({ ok: false, message: "A könyvelési cég kiválasztása kötelező." });
    return false;
  }
  if (!(await canUseEntity(req, entityId, locationId))) {
    res.status(403).json({ ok: false, message: "Ehhez a céghez vagy telephelyhez nincs jogosultsága." });
    return false;
  }
  return true;
}

async function settingsFor(entityId: string, locationId?: string | null) {
  await ensurePrerequisites();
  return (await db.query(
    `SELECT * FROM legal_entity_document_settings
      WHERE legal_entity_id=$1::uuid AND (location_id::text=$2 OR location_id IS NULL)
      ORDER BY location_id NULLS LAST LIMIT 1`,
    [entityId, locationId || ""],
  )).rows[0] || null;
}

router.get("/status", async (_req: AuthRequest, res: Response) => {
  try {
    await ensurePrerequisites();
    return res.json({
      ok: true,
      providers: {
        invee: { mode: "manual_external", api: false },
        google_drive: {
          configured: Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN || (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_DRIVE_PRIVATE_KEY)),
        },
        altegio: {
          configured: Boolean(process.env.ALTEGIO_PARTNER_TOKEN && process.env.ALTEGIO_USER_TOKEN),
          api: true,
          import: true,
          modes: ["live_sync", "export_file"],
          base_url: "https://api.alteg.io/api/v1",
          accepted_import: ["csv", "xls", "xlsx"],
        },
      },
      nav_guard: "A külső bizonylatok nem kerülnek a vir_receipts táblába és alapértelmezetten ki vannak zárva a VIR saját NAV nyugtakötegeiből.",
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.get("/settings", async (req: AuthRequest, res: Response) => {
  try {
    const entityId = text(req.query.legal_entity_id);
    const locationId = text(req.query.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    return res.json({ ok: true, settings: await settingsFor(entityId, locationId) });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.put("/settings", async (req: AuthRequest, res: Response) => {
  try {
    await ensurePrerequisites();
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;

    const provider = PROVIDERS.has(text(req.body?.receipt_provider)) ? text(req.body.receipt_provider) : "internal";
    const navOwner = NAV_OWNERS.has(text(req.body?.nav_reporting_owner))
      ? text(req.body.nav_reporting_owner)
      : provider === "internal" ? "vir" : "external";

    const values = [
      entityId,
      locationId,
      provider,
      text(req.body?.drive_folder_id) || null,
      text(req.body?.altegio_location_id) || null,
      text(req.body?.external_account_ref) || null,
      navOwner,
      req.body?.active !== false,
      actor(req),
    ];

    let q = await db.query(`
      UPDATE legal_entity_document_settings
         SET receipt_provider=$3, drive_folder_id=$4, altegio_location_id=$5,
             external_account_ref=$6, nav_reporting_owner=$7, active=$8,
             updated_by=$9, updated_at=now()
       WHERE legal_entity_id=$1::uuid AND location_id IS NOT DISTINCT FROM $2::uuid
       RETURNING *`, values);

    if (!q.rows[0]) {
      q = await db.query(`
        INSERT INTO legal_entity_document_settings(
          legal_entity_id,location_id,receipt_provider,drive_folder_id,altegio_location_id,
          external_account_ref,nav_reporting_owner,active,updated_by
        ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`, values);
    }

    return res.json({ ok: true, settings: q.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.post("/altegio/sync", async (req: AuthRequest, res: Response) => {
  try {
    await ensurePrerequisites();
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;

    const settings = await settingsFor(entityId, locationId);
    const altegioLocation = text(req.body?.altegio_location_id) || text(settings?.altegio_location_id);
    if (!altegioLocation) {
      return res.status(409).json({ ok: false, code: "ALTEGIO_LOCATION_MISSING", message: "Ehhez a céghez nincs Altegio location ID beállítva." });
    }

    const partner = text(process.env.ALTEGIO_PARTNER_TOKEN);
    const user = text(process.env.ALTEGIO_USER_TOKEN);
    if (!partner || !user) {
      return res.status(409).json({ ok: false, code: "ALTEGIO_NOT_CONFIGURED", message: "Az Altegio API partner/user token nincs konfigurálva az API környezetben." });
    }

    const from = text(req.body?.from) || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const to = text(req.body?.to) || new Date().toISOString().slice(0, 10);
    const headers = {
      Accept: "application/vnd.api.v2+json",
      Authorization: `Bearer ${partner}, User ${user}`,
    };

    const all: any[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const r = await axios.get(`https://api.alteg.io/api/v1/finance_transactions/${encodeURIComponent(altegioLocation)}`, {
        headers,
        params: { page, count: 200, start_date: from, end_date: to },
        timeout: 20000,
      });
      const data = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
      all.push(...data);
      if (data.length < 200) break;
    }

    const grouped = new Map<string, any>();
    for (const t of all) {
      const key = String(t.document_id || t.id);
      const g = grouped.get(key) || {
        document_id: key,
        date: t.date,
        amount: 0,
        items: [],
        client: t.client,
        account: t.account,
      };
      g.amount += Number(t.amount || 0);
      g.items.push(t);
      grouped.set(key, g);
    }

    let imported = 0;
    let duplicates = 0;
    for (const g of grouped.values()) {
      const transactionIds = (g.items || []).map((x: any) => text(x?.id)).filter(Boolean);
      const duplicate = (await db.query(`
        SELECT id::text
          FROM external_financial_documents
         WHERE legal_entity_id=$1::uuid
           AND source='altegio'
           AND (
             external_id=$2
             OR external_id = ANY($3::text[])
             OR metadata->>'altegio_document_id'=$2
           )
         LIMIT 1`, [entityId, String(g.document_id), transactionIds])).rows[0];
      if (duplicate) {
        duplicates += 1;
        continue;
      }

      const stableHash = hash(`altegio-live|${altegioLocation}|${g.document_id}|${transactionIds.sort().join(",")}`);
      const q = await db.query(`
        INSERT INTO external_financial_documents(
          legal_entity_id,location_id,source,document_type,external_id,external_document_number,
          issue_date,counterparty_name,counterparty_tax_number,currency,net_amount,vat_amount,gross_amount,
          payment_method,content_sha256,nav_reporting_owner,nav_excluded,metadata,created_by
        ) VALUES(
          $1::uuid,$2::uuid,'altegio','transaction',$3,$4,$5::date,$6,NULL,'HUF',0,0,$7,$8,$9,'external',true,$10::jsonb,$11
        )
        ON CONFLICT DO NOTHING
        RETURNING id::text`, [
        entityId,
        locationId,
        String(g.document_id),
        `ALT-${g.document_id}`,
        isoDate(g.date),
        text(g.client?.name) || null,
        money(g.amount),
        text(g.account?.title) || null,
        stableHash,
        JSON.stringify({
          altegio_import_mode: "live_sync",
          altegio_location_id: altegioLocation,
          altegio_document_id: String(g.document_id),
          altegio_transaction_ids: transactionIds,
          transactions: g.items,
        }),
        actor(req),
      ]);

      const id = q.rows[0]?.id ? String(q.rows[0].id) : null;
      if (!id) {
        duplicates += 1;
        continue;
      }
      imported += 1;
      await db.query(`
        INSERT INTO external_financial_document_events(document_id,event_type,actor,payload)
        VALUES($1::uuid,'IMPORTED',$2,$3::jsonb)`, [
        id,
        actor(req),
        JSON.stringify({ source: "altegio", import_mode: "live_sync", nav_reporting_owner: "external", nav_excluded: true }),
      ]);
    }

    return res.json({
      ok: true,
      mode: "live_sync",
      from,
      to,
      altegio_location_id: altegioLocation,
      transactions: all.length,
      documents: grouped.size,
      imported,
      duplicates,
      review_required: true,
    });
  } catch (e: any) {
    return res.status(e?.status || 500).json({
      ok: false,
      code: e?.code,
      message: e?.response?.data?.meta?.message || e?.response?.data?.message || e?.message || "Az Altegio szinkron sikertelen.",
    });
  }
});

export default router;
