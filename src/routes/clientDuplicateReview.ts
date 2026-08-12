import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { evaluateClient } from "../loyalty/loyaltyProgramService";

const router = Router();
const APPROVER_ROLES = new Set(["admin", "manager", "location_manager", "salon_manager"]);
let schemaReady: Promise<void> | null = null;

function ensureDuplicateReviewSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_into_client_id text;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_at timestamptz;
      CREATE TABLE IF NOT EXISTS crm_duplicate_resolutions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        primary_client_id text NOT NULL,
        duplicate_client_id text NOT NULL,
        decision text NOT NULL CHECK (decision IN ('merged','dismissed')),
        match_reasons text[] NOT NULL DEFAULT '{}'::text[],
        note text,
        decided_by text,
        location_id text,
        primary_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        duplicate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        moved_records jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS crm_duplicate_resolutions_pair_idx
        ON crm_duplicate_resolutions(primary_client_id, duplicate_client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS crm_duplicate_resolutions_location_idx
        ON crm_duplicate_resolutions(location_id, created_at DESC);
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function role(req: AuthRequest) {
  return String(req.user?.role || "").trim().toLowerCase();
}

function requestedLocation(req: AuthRequest) {
  const explicit = String(req.query.location_id || req.body?.location_id || "").trim();
  if (role(req) === "admin") return explicit || null;
  return req.user?.location_id === null || req.user?.location_id === undefined
    ? null
    : String(req.user.location_id);
}

function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "unknown");
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function matchReasons(a: any, b: any) {
  const reasons: string[] = [];
  const aEmail = normalizeEmail(a?.email);
  const bEmail = normalizeEmail(b?.email);
  const aPhone = normalizePhone(a?.phone);
  const bPhone = normalizePhone(b?.phone);
  if (aEmail && bEmail && aEmail === bEmail) reasons.push("email");
  if (aPhone && bPhone && aPhone === bPhone) reasons.push("phone");
  return reasons;
}

async function tableHasClientId(client: any, table: string) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='client_id' LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function moveClientRows(client: any, table: string, primaryId: string, duplicateId: string) {
  if (!(await tableHasClientId(client, table))) return 0;
  const result = await client.query(
    `UPDATE "${table}" SET client_id=$1 WHERE client_id::text=$2`,
    [primaryId, duplicateId],
  );
  return Number(result.rowCount || 0);
}

router.use(requireAuth);
router.use(async (_req, res, next) => {
  try {
    await ensureDuplicateReviewSchema();
    next();
  } catch (error: any) {
    console.error("CRM duplikációs sémahiba:", error);
    res.status(500).json({ error: "A duplikáció-kezelés előkészítése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.get("/duplicate-review", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = requestedLocation(req);
    const { rows: pairs } = await pool.query(`
      WITH candidates AS (
        SELECT
          LEAST(a.id::text,b.id::text) pair_a,
          GREATEST(a.id::text,b.id::text) pair_b,
          CASE WHEN lower(trim(COALESCE(a.email,'')))<>''
                 AND lower(trim(COALESCE(a.email,'')))=lower(trim(COALESCE(b.email,''))) THEN true ELSE false END email_match,
          CASE WHEN regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')<>''
                 AND regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')=regexp_replace(COALESCE(b.phone,''),'[^0-9]','','g') THEN true ELSE false END phone_match
        FROM clients a
        JOIN clients b ON a.id::text < b.id::text
        WHERE COALESCE(a.is_active,true) AND COALESCE(b.is_active,true)
          AND COALESCE(a.merged_into_client_id,'')='' AND COALESCE(b.merged_into_client_id,'')=''
          AND ($1::text IS NULL OR a.location_id::text=$1 OR b.location_id::text=$1)
          AND (
            (lower(trim(COALESCE(a.email,'')))<>'' AND lower(trim(COALESCE(a.email,'')))=lower(trim(COALESCE(b.email,''))))
            OR
            (regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')<>'' AND regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')=regexp_replace(COALESCE(b.phone,''),'[^0-9]','','g'))
          )
      ), unresolved AS (
        SELECT DISTINCT c.*
        FROM candidates c
        LEFT JOIN LATERAL (
          SELECT r.decision
          FROM crm_duplicate_resolutions r
          WHERE LEAST(r.primary_client_id,r.duplicate_client_id)=c.pair_a
            AND GREATEST(r.primary_client_id,r.duplicate_client_id)=c.pair_b
          ORDER BY r.created_at DESC LIMIT 1
        ) last_resolution ON true
        WHERE last_resolution.decision IS NULL
      )
      SELECT u.pair_a || ':' || u.pair_b pair_key,
        ARRAY_REMOVE(ARRAY[CASE WHEN u.email_match THEN 'email' END,CASE WHEN u.phone_match THEN 'phone' END],NULL) match_reasons,
        json_build_object('id',a.id,'name',COALESCE(NULLIF(a.full_name,''),a.name,'Névtelen ügyfél'),'email',a.email,'phone',a.phone,'location_id',a.location_id,'created_at',a.created_at,'updated_at',a.updated_at,'visits',COALESCE(a.altegio_visits,0),'spent',COALESCE(a.altegio_spent,0)) client_a,
        json_build_object('id',b.id,'name',COALESCE(NULLIF(b.full_name,''),b.name,'Névtelen ügyfél'),'email',b.email,'phone',b.phone,'location_id',b.location_id,'created_at',b.created_at,'updated_at',b.updated_at,'visits',COALESCE(b.altegio_visits,0),'spent',COALESCE(b.altegio_spent,0)) client_b
      FROM unresolved u
      JOIN clients a ON a.id::text=u.pair_a
      JOIN clients b ON b.id::text=u.pair_b
      ORDER BY GREATEST(a.updated_at,b.updated_at) DESC NULLS LAST, pair_key
      LIMIT 500`, [locationId]);

    const { rows: history } = await pool.query(`
      SELECT id,primary_client_id,duplicate_client_id,decision,match_reasons,note,decided_by,location_id,moved_records,created_at,
        primary_snapshot->>'name' primary_name,duplicate_snapshot->>'name' duplicate_name
      FROM crm_duplicate_resolutions
      WHERE ($1::text IS NULL OR location_id=$1)
      ORDER BY created_at DESC LIMIT 100`, [locationId]);

    res.json({ pending: pairs, history, can_approve: APPROVER_ROLES.has(role(req)) });
  } catch (error: any) {
    console.error("CRM duplikációs lista hiba:", error);
    res.status(500).json({ error: "A duplikációs lista betöltése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.post("/duplicate-review/resolve", async (req: AuthRequest, res: Response) => {
  if (!APPROVER_ROLES.has(role(req))) {
    return res.status(403).json({ error: "A duplikált ügyfélprofilok jóváhagyásához vezetői jogosultság szükséges." });
  }

  const primaryId = String(req.body?.primary_client_id || "").trim();
  const duplicateId = String(req.body?.duplicate_client_id || "").trim();
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  const note = String(req.body?.note || "").trim() || null;
  const locationId = requestedLocation(req);

  if (!primaryId || !duplicateId || primaryId === duplicateId) {
    return res.status(400).json({ error: "Két külön ügyfélprofilt kell kiválasztani." });
  }
  if (!new Set(["merge", "dismiss"]).has(decision)) {
    return res.status(400).json({ error: "Érvénytelen döntés. Engedélyezett: merge vagy dismiss." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT id::text id,location_id::text location_id,COALESCE(NULLIF(full_name,''),name,'Névtelen ügyfél') name,
        full_name,name AS legacy_name,email,phone,birth_date,gender,city,address,notes,preferred_contact,
        marketing_consent,email_consent,sms_consent,phone_consent,consent_recorded_at,consent_source,privacy_notice_version,
        customer_type,barcode,profile_image_url,source,altegio_spent,altegio_paid,altegio_visits,altegio_first_visit,altegio_last_visit,
        is_active,created_at,updated_at
      FROM clients WHERE id::text = ANY($1::text[]) FOR UPDATE`, [[primaryId, duplicateId]]);
    if (rows.length !== 2) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Az egyik ügyfélprofil nem található." });
    }

    const primary = rows.find((row: any) => row.id === primaryId);
    const duplicate = rows.find((row: any) => row.id === duplicateId);
    if (!primary || !duplicate) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Az ügyfélprofilok nem azonosíthatók." });
    }
    if (locationId && primary.location_id !== locationId && duplicate.location_id !== locationId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "A kiválasztott ügyfelek nem tartoznak a kezelhető telephelyhez." });
    }

    const reasons = matchReasons(primary, duplicate);
    if (!reasons.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A két profil jelenleg nem egyezik sem e-mail, sem telefonszám alapján." });
    }

    if (decision === "dismiss") {
      const { rows: saved } = await client.query(`
        INSERT INTO crm_duplicate_resolutions(primary_client_id,duplicate_client_id,decision,match_reasons,note,decided_by,location_id,primary_snapshot,duplicate_snapshot)
        VALUES($1,$2,'dismissed',$3::text[],$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`,
        [primaryId, duplicateId, reasons, note, actor(req), primary.location_id || duplicate.location_id || locationId, JSON.stringify(primary), JSON.stringify(duplicate)]);
      await client.query("COMMIT");
      return res.status(201).json({ ok: true, decision: "dismissed", resolution: saved[0] });
    }

    await client.query(`
      UPDATE clients p SET
        full_name=COALESCE(NULLIF(p.full_name,''),NULLIF(s.full_name,''),NULLIF(s.legacy_name,'')),
        name=COALESCE(NULLIF(p.name,''),NULLIF(s.legacy_name,''),NULLIF(s.full_name,'')),
        email=COALESCE(NULLIF(p.email,''),NULLIF(s.email,'')),
        phone=COALESCE(NULLIF(p.phone,''),NULLIF(s.phone,'')),
        birth_date=COALESCE(p.birth_date,s.birth_date),gender=COALESCE(NULLIF(p.gender,''),NULLIF(s.gender,'')),
        city=COALESCE(NULLIF(p.city,''),NULLIF(s.city,'')),address=COALESCE(NULLIF(p.address,''),NULLIF(s.address,'')),
        notes=CASE WHEN COALESCE(NULLIF(p.notes,''),'')='' THEN s.notes WHEN COALESCE(NULLIF(s.notes,''),'')='' THEN p.notes ELSE p.notes || E'\n\n[Összevont profil megjegyzése]\n' || s.notes END,
        preferred_contact=COALESCE(NULLIF(p.preferred_contact,''),NULLIF(s.preferred_contact,'')),
        marketing_consent=COALESCE(p.marketing_consent,false) OR COALESCE(s.marketing_consent,false),
        email_consent=COALESCE(p.email_consent,false) OR COALESCE(s.email_consent,false),
        sms_consent=COALESCE(p.sms_consent,false) OR COALESCE(s.sms_consent,false),
        phone_consent=COALESCE(p.phone_consent,false) OR COALESCE(s.phone_consent,false),
        consent_recorded_at=GREATEST(p.consent_recorded_at,s.consent_recorded_at),
        consent_source=COALESCE(NULLIF(p.consent_source,''),NULLIF(s.consent_source,'')),
        privacy_notice_version=COALESCE(NULLIF(p.privacy_notice_version,''),NULLIF(s.privacy_notice_version,'')),
        customer_type=CASE WHEN p.customer_type='vip' OR s.customer_type='vip' THEN 'vip' ELSE COALESCE(NULLIF(p.customer_type,''),NULLIF(s.customer_type,''),'normal') END,
        profile_image_url=COALESCE(NULLIF(p.profile_image_url,''),NULLIF(s.profile_image_url,'')),
        altegio_spent=GREATEST(COALESCE(p.altegio_spent,0),COALESCE(s.altegio_spent,0)),
        altegio_paid=GREATEST(COALESCE(p.altegio_paid,0),COALESCE(s.altegio_paid,0)),
        altegio_visits=GREATEST(COALESCE(p.altegio_visits,0),COALESCE(s.altegio_visits,0)),
        altegio_first_visit=LEAST(p.altegio_first_visit,s.altegio_first_visit),
        altegio_last_visit=GREATEST(p.altegio_last_visit,s.altegio_last_visit),
        updated_at=now()
      FROM clients s WHERE p.id::text=$1 AND s.id::text=$2`, [primaryId, duplicateId]);

    const moved: Record<string, number> = {};
    for (const table of ["appointments", "work_orders", "crm_client_notes", "crm_form_responses", "crm_consent_history", "loyalty_program_history", "booking_communications"]) {
      moved[table] = await moveClientRows(client, table, primaryId, duplicateId);
    }

    if (await tableHasClientId(client, "crm_client_tags")) {
      const tagInsert = await client.query(`
        INSERT INTO crm_client_tags(client_id,tag_id,created_at)
        SELECT $1,tag_id,created_at FROM crm_client_tags WHERE client_id::text=$2
        ON CONFLICT(client_id,tag_id) DO NOTHING`, [primaryId, duplicateId]);
      moved.crm_client_tags = Number(tagInsert.rowCount || 0);
      await client.query(`DELETE FROM crm_client_tags WHERE client_id::text=$1`, [duplicateId]);
    }

    if (await tableHasClientId(client, "loyalty_program_members")) {
      await client.query(`DELETE FROM loyalty_program_members WHERE client_id::text=$1`, [duplicateId]);
    }

    await client.query(`
      UPDATE clients SET is_active=false,merged_into_client_id=$1,merged_at=now(),updated_at=now()
      WHERE id::text=$2`, [primaryId, duplicateId]);

    await evaluateClient(client, primaryId, "duplicate_merge", actor(req));

    const { rows: saved } = await client.query(`
      INSERT INTO crm_duplicate_resolutions(primary_client_id,duplicate_client_id,decision,match_reasons,note,decided_by,location_id,primary_snapshot,duplicate_snapshot,moved_records)
      VALUES($1,$2,'merged',$3::text[],$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING *`,
      [primaryId, duplicateId, reasons, note, actor(req), primary.location_id || duplicate.location_id || locationId, JSON.stringify(primary), JSON.stringify(duplicate), JSON.stringify(moved)]);

    await client.query("COMMIT");
    res.status(201).json({ ok: true, decision: "merged", primary_client_id: primaryId, duplicate_client_id: duplicateId, moved_records: moved, resolution: saved[0] });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("CRM duplikációs döntés hiba:", error);
    res.status(500).json({ error: "A duplikációs döntés mentése nem sikerült.", detail: error?.message || String(error) });
  } finally {
    client.release();
  }
});

export default router;
