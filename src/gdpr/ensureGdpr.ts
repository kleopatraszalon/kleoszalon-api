import db from "../db";
import { ensureSystemAuditSchema } from "../audit/systemAudit";

let ready: Promise<void> | null = null;

const DEFAULT_SETTINGS: Record<string, unknown> = {
  controller_name: "Kleoszalon Kft.",
  controller_contact_email: "",
  controller_address: "",
  dpo_name: "",
  dpo_email: "",
  authority_name: "Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH)",
  authority_url: "https://www.naih.hu/",
  request_deadline_days: 30,
  incident_notification_hours: 72,
  retention_automation_enabled: false,
  retention_preview_only: true,
  privacy_notice_version: "",
  privacy_notice_url: "https://www.kleoszalon.hu/adatvedelem/",
  cookie_notice_url: "https://www.kleoszalon.hu/cookie-tajekoztato/",
  default_audit_retention_months: 24,
};
export const GDPR_SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

export function ensureGdprSchema() {
  if (!ready) ready = (async () => {
    await ensureSystemAuditSchema();
    await db.query(`
      CREATE TABLE IF NOT EXISTS gdpr_settings(key text PRIMARY KEY,value jsonb NOT NULL,updated_by text,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_processing_activities(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,purpose text NOT NULL,
        data_subjects text[] NOT NULL DEFAULT '{}',data_categories text[] NOT NULL DEFAULT '{}',special_categories boolean NOT NULL DEFAULT false,
        legal_basis text NOT NULL,article9_condition text,recipients text[] NOT NULL DEFAULT '{}',processors text[] NOT NULL DEFAULT '{}',
        transfers text,retention_rule text NOT NULL,security_measures text,owner text,
        status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','review_due','archived')),review_at date,
        created_by text,updated_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_retention_policies(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,entity_type text NOT NULL,trigger_event text NOT NULL,
        retention_days integer NOT NULL CHECK(retention_days>=0),action text NOT NULL CHECK(action IN ('review','anonymize','soft_delete','delete')),
        legal_basis text,enabled boolean NOT NULL DEFAULT false,legal_hold_supported boolean NOT NULL DEFAULT true,
        last_preview_at timestamptz,last_preview_count integer,created_by text,updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(entity_type,trigger_event));
      CREATE TABLE IF NOT EXISTS gdpr_data_subject_requests(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference_no text UNIQUE NOT NULL,
        request_type text NOT NULL CHECK(request_type IN ('access','rectification','erasure','restriction','portability','objection','consent_withdrawal','other')),
        subject_name text NOT NULL,subject_contact text,identity_verified boolean NOT NULL DEFAULT false,received_at timestamptz NOT NULL DEFAULT now(),
        due_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','identity_check','in_progress','extended','completed','rejected','cancelled')),
        assigned_to text,scope text,decision text,rejection_reason text,completed_at timestamptz,created_by text,updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_incidents(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference_no text UNIQUE NOT NULL,title text NOT NULL,detected_at timestamptz NOT NULL,aware_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','contained','assessing','notified','closed')),
        severity text NOT NULL DEFAULT 'medium' CHECK(severity IN ('low','medium','high','critical')),description text NOT NULL,
        data_categories text[] NOT NULL DEFAULT '{}',approximate_subjects integer,approximate_records integer,consequences text,containment text,risk_to_rights text,
        authority_notification_required boolean,authority_notified_at timestamptz,subjects_notification_required boolean,subjects_notified_at timestamptz,
        decision_reason text,owner text,closed_at timestamptz,created_by text,updated_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_processors(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,service text NOT NULL,data_categories text[] NOT NULL DEFAULT '{}',
        processing_locations text[] NOT NULL DEFAULT '{}',subprocessor_url text,dpa_signed_at date,transfer_mechanism text,security_review_at date,
        deletion_verified_at date,owner text,status text NOT NULL DEFAULT 'active' CHECK(status IN ('planned','active','suspended','terminated')),
        notes text,created_by text,updated_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_notice_versions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),notice_type text NOT NULL CHECK(notice_type IN ('privacy','cookie','employee','applicant','marketing','other')),
        version text NOT NULL,title text NOT NULL,url text,content_hash text NOT NULL,effective_from timestamptz NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
        approved_by text,approved_at timestamptz,created_by text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(notice_type,version));
      CREATE TABLE IF NOT EXISTS gdpr_consents(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject_ref text NOT NULL,purpose text NOT NULL,notice_version_id uuid REFERENCES gdpr_notice_versions(id),
        status text NOT NULL CHECK(status IN ('granted','withdrawn','refused')),captured_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz,
        source text NOT NULL,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,created_by text,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_dpias(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,processing_activity_id uuid REFERENCES gdpr_processing_activities(id),
        screening_reason text NOT NULL,systematic_monitoring boolean NOT NULL DEFAULT false,special_category_scale boolean NOT NULL DEFAULT false,
        vulnerable_subjects boolean NOT NULL DEFAULT false,new_technology boolean NOT NULL DEFAULT false,dpia_required boolean NOT NULL,
        necessity_proportionality text,risks text,measures text,residual_risk text,consultation_required boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'screening' CHECK(status IN ('screening','assessment','approved','review_due','closed')),
        owner text,review_at date,approved_by text,approved_at timestamptz,created_by text,updated_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS gdpr_processing_review_idx ON gdpr_processing_activities(status,review_at);
      CREATE INDEX IF NOT EXISTS gdpr_dsr_due_idx ON gdpr_data_subject_requests(status,due_at);
      CREATE INDEX IF NOT EXISTS gdpr_incident_deadline_idx ON gdpr_incidents(status,aware_at);
      CREATE INDEX IF NOT EXISTS gdpr_consents_subject_idx ON gdpr_consents(subject_ref,purpose,captured_at DESC);
      CREATE INDEX IF NOT EXISTS gdpr_dpias_review_idx ON gdpr_dpias(status,review_at);
      ALTER TABLE gdpr_data_subject_requests ADD COLUMN IF NOT EXISTS extension_reason text;
      ALTER TABLE gdpr_data_subject_requests ADD COLUMN IF NOT EXISTS response_evidence text;
      ALTER TABLE gdpr_incidents ADD COLUMN IF NOT EXISTS notification_delay_reason text;
      ALTER TABLE gdpr_incidents ADD COLUMN IF NOT EXISTS authority_reference text;
    `);
    for (const [key,value] of Object.entries(DEFAULT_SETTINGS)) await db.query(
      `INSERT INTO gdpr_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING`,[key,JSON.stringify(value)]);
  })().catch(error=>{ready=null;throw error});
  return ready;
}
