import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { createHash } from "crypto";
import { ensureGdprSchema } from "../gdpr/ensureGdpr";

const router = Router();
const EDITOR_ROLES = new Set(["admin", "manager", "location_manager", "salon_manager"]);
let schemaReady: Promise<void> | null = null;

function normalizeRole(value: unknown) {
  const role = String(value || "").trim().toLowerCase();
  if (["üzletvezető", "uzletvezeto", "store_manager", "branch_manager"].includes(role)) return "location_manager";
  return role;
}

function roleKeys(req: AuthRequest): string[] {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(normalizeRole).filter(Boolean);
  const source = String(raw ?? "");
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed.map(normalizeRole).filter(Boolean);
    if (parsed != null) return [normalizeRole(parsed)].filter(Boolean);
  } catch {}
  return source.split(",").map(value => normalizeRole(value.replace(/[\[\]"]/g, ""))).filter(Boolean);
}

function hasRole(req: AuthRequest, roleName: string) {
  return roleKeys(req).includes(roleName);
}

function canEdit(req: AuthRequest) {
  return roleKeys(req).some(role => EDITOR_ROLES.has(role));
}

function scopedLocation(req: AuthRequest) {
  const requested = String(req.query.location_id || req.body?.location_id || "").trim();
  if (hasRole(req, "admin")) return requested || null;
  return req.user?.location_id === null || req.user?.location_id === undefined ? null : String(req.user.location_id).trim() || null;
}

function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "unknown");
}

function consentStatus(value:unknown){
  if(typeof value==="boolean")return value?"granted":"refused";
  const normalized=String(value??"").trim().toLowerCase();
  if(["granted","yes","igen","true","1"].includes(normalized))return "granted";
  if(["withdrawn","withdraw","visszavont","visszavonva"].includes(normalized))return "withdrawn";
  if(["refused","no","nem","false","0"].includes(normalized))return "refused";
  return null;
}

function normalizeSchema(value: any) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fields = Array.isArray(source.fields) ? source.fields : [];
  return {
    ...source,
    fields: fields.map((field: any, index: number) => ({
      key: String(field?.key || `field_${index + 1}`).trim().replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80),
      label: String(field?.label || `Kérdés ${index + 1}`).trim().slice(0, 240),
      type: ["text", "textarea", "yes_no", "checkbox", "select", "date", "number"].includes(String(field?.type || "")) ? String(field.type) : "text",
      required: Boolean(field?.required),
      options: Array.isArray(field?.options) ? field.options.map((option: any) => String(option).trim()).filter(Boolean).slice(0, 30) : [],
      help_text: String(field?.help_text || "").trim().slice(0, 500) || null,
    })),
  };
}

function ensureFormVersionSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS crm_forms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        description text,
        form_type text NOT NULL DEFAULT 'questionnaire',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_title_uq ON crm_forms ((lower(title)));
      ALTER TABLE crm_forms ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1;
      ALTER TABLE crm_forms ADD COLUMN IF NOT EXISTS current_version_id uuid;
      ALTER TABLE crm_forms ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

      CREATE TABLE IF NOT EXISTS crm_form_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id uuid NOT NULL REFERENCES crm_forms(id) ON DELETE CASCADE,
        version_no integer NOT NULL CHECK (version_no > 0),
        title text NOT NULL,
        description text,
        form_type text NOT NULL DEFAULT 'questionnaire',
        content_schema jsonb NOT NULL DEFAULT '{"fields":[]}'::jsonb,
        privacy_notice_version text,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
        effective_from timestamptz,
        effective_to timestamptz,
        created_by text,
        published_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(form_id,version_no)
      );
      CREATE INDEX IF NOT EXISTS crm_form_versions_form_idx ON crm_form_versions(form_id,version_no DESC);
      CREATE INDEX IF NOT EXISTS crm_form_versions_status_idx ON crm_form_versions(status,effective_from DESC);

      ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_version_id uuid;
      ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_version_no integer;
      ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_snapshot jsonb;

      INSERT INTO crm_forms(title,description,form_type) VALUES
        ('Általános állapotfelmérő','Első kezelés előtti egészségügyi és bőrállapot-felmérés','questionnaire'),
        ('Adatkezelési nyilatkozat','Személyes és egészségügyi adatok kezelésének jóváhagyása','consent'),
        ('Fotódokumentációs hozzájárulás','Kezelés előtti és utáni képek készítésének engedélye','consent')
      ON CONFLICT DO NOTHING;

      INSERT INTO crm_form_versions(form_id,version_no,title,description,form_type,content_schema,status,effective_from,created_by,published_by)
      SELECT f.id,1,f.title,f.description,f.form_type,'{"fields":[]}'::jsonb,'published',COALESCE(f.created_at,now()),'system-bootstrap','system-bootstrap'
      FROM crm_forms f
      WHERE NOT EXISTS (SELECT 1 FROM crm_form_versions v WHERE v.form_id=f.id);

      UPDATE crm_forms f SET
        current_version = latest.version_no,
        current_version_id = latest.id,
        updated_at = now()
      FROM (
        SELECT DISTINCT ON (form_id) form_id,id,version_no
        FROM crm_form_versions
        WHERE status='published'
        ORDER BY form_id,version_no DESC
      ) latest
      WHERE latest.form_id=f.id
        AND (f.current_version_id IS NULL OR f.current_version IS DISTINCT FROM latest.version_no OR f.current_version_id IS DISTINCT FROM latest.id);
    `).then(() => undefined).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

router.use(requireAuth);
router.use(async (_req, res, next) => {
  try {
    await ensureFormVersionSchema();
    next();
  } catch (error: any) {
    console.error("CRM űrlapverzió sémahiba:", error);
    res.status(500).json({ error: "A kérdőív-verziók előkészítése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.get("/form-versions", async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.id,f.title,f.description,f.form_type,f.is_active,f.current_version,f.current_version_id,f.created_at,f.updated_at,
        v.status current_status,v.privacy_notice_version,v.effective_from,v.content_schema,
        (SELECT COUNT(*)::int FROM crm_form_versions x WHERE x.form_id=f.id) version_count,
        (SELECT COUNT(*)::int FROM crm_form_versions x WHERE x.form_id=f.id AND x.status='draft') draft_count
      FROM crm_forms f
      LEFT JOIN crm_form_versions v ON v.id=f.current_version_id
      ORDER BY lower(f.title)
    `);
    res.json({ forms: rows, can_edit: canEdit(req) });
  } catch (error: any) {
    res.status(500).json({ error: "A kérdőív-verziók betöltése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.get("/form-versions/:formId", async (req: AuthRequest, res: Response) => {
  try {
    const { rows: forms } = await pool.query(`SELECT * FROM crm_forms WHERE id=$1::uuid`, [req.params.formId]);
    if (!forms.length) return res.status(404).json({ error: "A dokumentum nem található." });
    const { rows: versions } = await pool.query(`
      SELECT * FROM crm_form_versions WHERE form_id=$1::uuid ORDER BY version_no DESC
    `, [req.params.formId]);
    res.json({ form: forms[0], versions, can_edit: canEdit(req) });
  } catch (error: any) {
    res.status(500).json({ error: "A verzióelőzmény betöltése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.post("/form-versions/:formId", async (req: AuthRequest, res: Response) => {
  if (!canEdit(req)) return res.status(403).json({ error: "Új dokumentumverzió létrehozásához vezetői jogosultság szükséges." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: forms } = await client.query(`SELECT * FROM crm_forms WHERE id=$1::uuid FOR UPDATE`, [req.params.formId]);
    if (!forms.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "A dokumentum nem található." });
    }
    const form = forms[0];
    const { rows: drafts } = await client.query(`SELECT id,version_no FROM crm_form_versions WHERE form_id=$1::uuid AND status='draft' ORDER BY version_no DESC LIMIT 1`, [req.params.formId]);
    if (drafts.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Már létezik tervezet (v${drafts[0].version_no}). Előbb ezt tedd közzé vagy módosítsd.` });
    }
    const { rows: previous } = await client.query(`SELECT * FROM crm_form_versions WHERE form_id=$1::uuid ORDER BY version_no DESC LIMIT 1`, [req.params.formId]);
    const base = previous[0] || form;
    const nextVersion = Number(base.version_no || 0) + 1;
    const title = String(req.body?.title ?? base.title ?? form.title).trim();
    const description = String(req.body?.description ?? base.description ?? form.description ?? "").trim() || null;
    const formType = String(req.body?.form_type ?? base.form_type ?? form.form_type ?? "questionnaire").trim();
    const privacyNoticeVersion = String(req.body?.privacy_notice_version ?? base.privacy_notice_version ?? "").trim() || null;
    const contentSchema = normalizeSchema(req.body?.content_schema ?? base.content_schema ?? { fields: [] });
    const { rows } = await client.query(`
      INSERT INTO crm_form_versions(form_id,version_no,title,description,form_type,content_schema,privacy_notice_version,status,created_by)
      VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7,'draft',$8) RETURNING *
    `, [req.params.formId, nextVersion, title, description, formType, JSON.stringify(contentSchema), privacyNoticeVersion, actor(req)]);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "Az új dokumentumverzió létrehozása nem sikerült.", detail: error?.message || String(error) });
  } finally {
    client.release();
  }
});

router.patch("/form-versions/:formId/:versionNo", async (req: AuthRequest, res: Response) => {
  if (!canEdit(req)) return res.status(403).json({ error: "A dokumentumverzió módosításához vezetői jogosultság szükséges." });
  try {
    const { rows: current } = await pool.query(`SELECT * FROM crm_form_versions WHERE form_id=$1::uuid AND version_no=$2::int`, [req.params.formId, req.params.versionNo]);
    if (!current.length) return res.status(404).json({ error: "A dokumentumverzió nem található." });
    if (current[0].status !== "draft") return res.status(409).json({ error: "Csak tervezet állapotú verzió módosítható." });
    const item = current[0];
    const contentSchema = normalizeSchema(req.body?.content_schema ?? item.content_schema ?? { fields: [] });
    const { rows } = await pool.query(`
      UPDATE crm_form_versions SET title=$3,description=$4,form_type=$5,content_schema=$6::jsonb,privacy_notice_version=$7,updated_at=now()
      WHERE form_id=$1::uuid AND version_no=$2::int RETURNING *
    `, [req.params.formId, req.params.versionNo,
      String(req.body?.title ?? item.title).trim(),
      String(req.body?.description ?? item.description ?? "").trim() || null,
      String(req.body?.form_type ?? item.form_type).trim(),
      JSON.stringify(contentSchema),
      String(req.body?.privacy_notice_version ?? item.privacy_notice_version ?? "").trim() || null,
    ]);
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A tervezet mentése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.post("/form-versions/:formId/:versionNo/publish", async (req: AuthRequest, res: Response) => {
  if (!canEdit(req)) return res.status(403).json({ error: "A dokumentumverzió közzétételéhez vezetői jogosultság szükséges." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM crm_form_versions WHERE form_id=$1::uuid AND version_no=$2::int FOR UPDATE`, [req.params.formId, req.params.versionNo]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "A dokumentumverzió nem található." });
    }
    const target = rows[0];
    if (target.status === "published") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ez a verzió már közzé van téve." });
    }
    if (target.status !== "draft") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Csak tervezet állapotú verzió tehető közzé." });
    }
    if(target.form_type==="consent"&&!String(target.privacy_notice_version||"").trim()){
      await client.query("ROLLBACK");
      return res.status(400).json({error:"Hozzájárulási dokumentum csak adatkezelési tájékoztató-verzióval tehető közzé."});
    }
    await client.query(`
      UPDATE crm_form_versions SET status='retired',effective_to=now(),updated_at=now()
      WHERE form_id=$1::uuid AND status='published'
    `, [req.params.formId]);
    const { rows: published } = await client.query(`
      UPDATE crm_form_versions SET status='published',effective_from=now(),effective_to=NULL,published_by=$3,updated_at=now()
      WHERE form_id=$1::uuid AND version_no=$2::int RETURNING *
    `, [req.params.formId, req.params.versionNo, actor(req)]);
    await client.query(`
      UPDATE crm_forms SET title=$2,description=$3,form_type=$4,current_version=$5,current_version_id=$6::uuid,updated_at=now()
      WHERE id=$1::uuid
    `, [req.params.formId, target.title, target.description, target.form_type, target.version_no, target.id]);
    await client.query("COMMIT");
    res.json(published[0]);
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "A dokumentumverzió közzététele nem sikerült.", detail: error?.message || String(error) });
  } finally {
    client.release();
  }
});

router.delete("/form-versions/:formId/:versionNo", async (req: AuthRequest, res: Response) => {
  if (!canEdit(req)) return res.status(403).json({ error: "A tervezet törléséhez vezetői jogosultság szükséges." });
  try {
    const { rows } = await pool.query(`
      DELETE FROM crm_form_versions WHERE form_id=$1::uuid AND version_no=$2::int AND status='draft' RETURNING id,version_no
    `, [req.params.formId, req.params.versionNo]);
    if (!rows.length) return res.status(409).json({ error: "Csak tervezet állapotú verzió törölhető." });
    res.json({ ok: true, deleted: rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: "A tervezet törlése nem sikerült.", detail: error?.message || String(error) });
  }
});

router.post("/form-versions/:formId/responses", async (req: AuthRequest, res: Response) => {
  const clientId = String(req.body?.client_id || "").trim();
  if (!clientId) return res.status(400).json({ error: "Az ügyfélazonosító kötelező." });
  const locationId = scopedLocation(req);
  if (!hasRole(req, "admin") && !locationId) return res.status(403).json({ error: "A kitöltés rögzítéséhez telephely-hozzárendelés szükséges." });
  const db=await pool.connect();
  try {
    await ensureGdprSchema();await db.query("BEGIN");
    const { rows: clients } = await db.query(`
      SELECT id::text id,location_id::text location_id FROM clients WHERE id::text=$1 AND COALESCE(is_active,true)
      FOR UPDATE
    `, [clientId]);
    if (!clients.length){await db.query("ROLLBACK");return res.status(404).json({ error: "Az ügyfél nem található." })}
    if (locationId && clients[0].location_id !== locationId){await db.query("ROLLBACK");return res.status(403).json({ error: "Az ügyfél nem tartozik a kezelhető telephelyhez." })}

    const { rows: versions } = await db.query(`
      SELECT v.*,f.is_active FROM crm_form_versions v JOIN crm_forms f ON f.id=v.form_id
      WHERE v.form_id=$1::uuid AND v.status='published' AND f.is_active=true
      ORDER BY v.version_no DESC LIMIT 1
    `, [req.params.formId]);
    if (!versions.length){await db.query("ROLLBACK");return res.status(409).json({ error: "Ehhez a dokumentumhoz nincs közzétett, kitölthető verzió." })}
    const version = versions[0];
    const responseData=req.body?.response_data||{},responseStatus=String(req.body?.status||"completed");
    const recordedConsent=version.form_type==="consent"&&responseStatus==="completed"?consentStatus(req.body?.consent_status??responseData.consent_status??responseData.consent_granted):null;
    let notice:any=null;
    if(version.form_type==="consent"&&responseStatus==="completed"){
      if(!recordedConsent){await db.query("ROLLBACK");return res.status(400).json({error:"Hozzájárulási nyilatkozatnál a consent_status (granted, refused vagy withdrawn) kötelező."})}
      if(!String(version.privacy_notice_version||"").trim()){await db.query("ROLLBACK");return res.status(409).json({error:"A hozzájárulási dokumentum közzétett verziójához nincs adatkezelési tájékoztató-verzió rendelve."})}
      notice=(await db.query(`SELECT id FROM gdpr_notice_versions WHERE version=$1 ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,effective_from DESC LIMIT 1`,[version.privacy_notice_version])).rows[0];
      if(!notice){await db.query("ROLLBACK");return res.status(409).json({error:"A dokumentumhoz rendelt adatkezelési tájékoztató-verzió nincs regisztrálva a GDPR-központban."})}
    }
    const snapshot = {
      version_id: version.id,
      version_no: version.version_no,
      title: version.title,
      description: version.description,
      form_type: version.form_type,
      privacy_notice_version: version.privacy_notice_version,
      content_schema: version.content_schema,
      effective_from: version.effective_from,
    };
    const { rows } = await db.query(`
      INSERT INTO crm_form_responses(form_id,client_id,status,response_data,completed_at,form_version_id,form_version_no,form_snapshot)
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,now(),$5::uuid,$6,$7::jsonb) RETURNING *
    `, [req.params.formId, clientId, responseStatus, JSON.stringify(responseData), version.id, version.version_no, JSON.stringify(snapshot)]);
    if(recordedConsent){const digest=createHash("sha256").update(JSON.stringify(responseData)).digest("hex");await db.query(`INSERT INTO gdpr_consents(subject_ref,purpose,notice_version_id,status,captured_at,withdrawn_at,source,evidence,created_by) VALUES($1,$2,$3,$4,now(),CASE WHEN $4='withdrawn' THEN now() END,'crm_form_response',$5::jsonb,$6)`,[`client:${clientId}`,String(version.content_schema?.gdpr_purpose||version.title).slice(0,500),notice.id,recordedConsent,JSON.stringify({response_id:rows[0].id,form_id:version.form_id,form_version_id:version.id,form_version_no:version.version_no,response_sha256:digest,privacy_notice_version:version.privacy_notice_version}),actor(req)])}
    await db.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (error: any) {
    await db.query("ROLLBACK").catch(()=>undefined);
    res.status(500).json({ error: "A kitöltés rögzítése nem sikerült.", detail: error?.message || String(error) });
  }finally{db.release()}
});

export default router;
