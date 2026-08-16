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
      CREATE TABLE IF NOT EXISTS gdpr_request_actions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL REFERENCES gdpr_data_subject_requests(id),
        action_type text NOT NULL CHECK(action_type IN ('discover','export','rectify','restrict','erase','anonymize')),
        status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','awaiting_approval','approved','executed','blocked','cancelled')),
        target_systems text[] NOT NULL DEFAULT '{}',preview_summary jsonb NOT NULL DEFAULT '{}'::jsonb,legal_hold boolean NOT NULL DEFAULT false,
        evidence_ref text,approved_by text,approved_at timestamptz,executed_by text,executed_at timestamptz,
        created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_legal_holds(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope_type text NOT NULL CHECK(scope_type IN ('subject','entity')),scope_ref text NOT NULL,
        reason text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),starts_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,
        created_by text,released_by text,released_at timestamptz,release_reason text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS gdpr_legal_holds_active_uq ON gdpr_legal_holds(scope_type,scope_ref) WHERE status='active';
      CREATE TABLE IF NOT EXISTS gdpr_retention_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),policy_id uuid NOT NULL REFERENCES gdpr_retention_policies(id),
        status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','awaiting_approval','approved','executed','blocked','cancelled')),
        cutoff_at timestamptz NOT NULL,candidate_count integer NOT NULL DEFAULT 0,legal_hold_count integer NOT NULL DEFAULT 0,
        sample_ids text[] NOT NULL DEFAULT '{}',preview_hash text NOT NULL,execution_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by text,approved_by text,approved_at timestamptz,approval_reason text,executed_by text,executed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS gdpr_retention_processed(
        policy_id uuid NOT NULL REFERENCES gdpr_retention_policies(id),entity_id text NOT NULL,run_id uuid NOT NULL REFERENCES gdpr_retention_runs(id),
        processed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(policy_id,entity_id));
      CREATE INDEX IF NOT EXISTS gdpr_processing_review_idx ON gdpr_processing_activities(status,review_at);
      CREATE INDEX IF NOT EXISTS gdpr_dsr_due_idx ON gdpr_data_subject_requests(status,due_at);
      CREATE INDEX IF NOT EXISTS gdpr_incident_deadline_idx ON gdpr_incidents(status,aware_at);
      CREATE INDEX IF NOT EXISTS gdpr_consents_subject_idx ON gdpr_consents(subject_ref,purpose,captured_at DESC);
      CREATE INDEX IF NOT EXISTS gdpr_dpias_review_idx ON gdpr_dpias(status,review_at);
      CREATE INDEX IF NOT EXISTS gdpr_request_actions_request_idx ON gdpr_request_actions(request_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS gdpr_retention_runs_policy_idx ON gdpr_retention_runs(policy_id,created_at DESC);
      ALTER TABLE gdpr_data_subject_requests ADD COLUMN IF NOT EXISTS extension_reason text;
      ALTER TABLE gdpr_data_subject_requests ADD COLUMN IF NOT EXISTS extension_notice_evidence text;
      ALTER TABLE gdpr_data_subject_requests ADD COLUMN IF NOT EXISTS response_evidence text;
      ALTER TABLE gdpr_incidents ADD COLUMN IF NOT EXISTS notification_delay_reason text;
      ALTER TABLE gdpr_incidents ADD COLUMN IF NOT EXISTS authority_reference text;
      ALTER TABLE gdpr_request_actions ADD COLUMN IF NOT EXISTS preview_hash text;
      ALTER TABLE gdpr_request_actions ADD COLUMN IF NOT EXISTS approval_reason text;
      ALTER TABLE gdpr_request_actions ADD COLUMN IF NOT EXISTS execution_summary jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE gdpr_request_actions ADD COLUMN IF NOT EXISTS legal_hold_reason text;
      ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS gdpr_erased_at timestamptz;
      ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS gdpr_erasure_request_id uuid;
      CREATE TABLE IF NOT EXISTS gdpr_audit_outbox(
        id bigserial PRIMARY KEY,event_id uuid NOT NULL DEFAULT gen_random_uuid(),occurred_at timestamptz NOT NULL DEFAULT now(),
        table_name text NOT NULL,entity_id text NOT NULL,operation text NOT NULL,actor_key text,row_hash text NOT NULL,
        delivered_at timestamptz,UNIQUE(event_id));
      CREATE INDEX IF NOT EXISTS gdpr_audit_outbox_pending_idx ON gdpr_audit_outbox(occurred_at) WHERE delivered_at IS NULL;
      CREATE OR REPLACE FUNCTION gdpr_capture_durable_audit() RETURNS trigger AS $$
      DECLARE row_data jsonb; entity text; actor text;
      BEGIN
        row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
        entity:=COALESCE(row_data->>'id',row_data->>'key','unknown');
        actor:=COALESCE(row_data->>'updated_by',row_data->>'created_by');
        INSERT INTO gdpr_audit_outbox(table_name,entity_id,operation,actor_key,row_hash)
        VALUES(TG_TABLE_NAME,entity,TG_OP,actor,md5(row_data::text));
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DO $$ DECLARE table_name text; trigger_name text; BEGIN
        FOREACH table_name IN ARRAY ARRAY['gdpr_settings','gdpr_processing_activities','gdpr_retention_policies','gdpr_retention_runs','gdpr_retention_processed','gdpr_legal_holds','gdpr_data_subject_requests','gdpr_request_actions','gdpr_incidents','gdpr_processors','gdpr_notice_versions','gdpr_consents','gdpr_dpias'] LOOP
          trigger_name:='trg_'||table_name||'_durable_audit';
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=trigger_name AND tgrelid=table_name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gdpr_capture_durable_audit()',trigger_name,table_name);
          END IF;
        END LOOP;
      END $$;
    `);
    for (const [key,value] of Object.entries(DEFAULT_SETTINGS)) await db.query(
      `INSERT INTO gdpr_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING`,[key,JSON.stringify(value)]);
  })().catch(error=>{ready=null;throw error});
  return ready;
}
