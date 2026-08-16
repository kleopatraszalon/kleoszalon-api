import pool from "../db";
import { ensureSaasCore } from "../saas/ensureSaasCore";

let ready: Promise<void> | null = null;

export function ensureHrRecruitment(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ensureSaasCore();
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS tenant_id bigint`);
    await pool.query(`CREATE INDEX IF NOT EXISTS hr_positions_tenant_idx ON hr_positions(tenant_id)`);
    await pool.query(`
      UPDATE hr_positions p
         SET tenant_id=t.id
        FROM tenants t
       WHERE p.tenant_id IS NULL AND t.slug='kleopatra'
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hr_recruitment_applications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id bigint NOT NULL REFERENCES tenants(id),
        position_id uuid NOT NULL REFERENCES hr_positions(id),
        preferred_location_id uuid REFERENCES locations(id),
        first_name text NOT NULL,
        last_name text NOT NULL,
        email text NOT NULL,
        phone text NOT NULL,
        cv_url text NOT NULL,
        portfolio_url text,
        cover_letter text,
        consent_given boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'new',
        confirmation_code text NOT NULL UNIQUE,
        submission_key text,
        employee_id uuid REFERENCES employees(id),
        submitted_at timestamptz NOT NULL DEFAULT now(),
        hired_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT hr_recruitment_status_ck CHECK(status IN ('new','contacted','under_review','passed','rejected','hired')),
        CONSTRAINT hr_recruitment_consent_ck CHECK(consent_given=true)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS hr_recruitment_tenant_status_idx ON hr_recruitment_applications(tenant_id,status,submitted_at DESC)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hr_recruitment_submission_key_uq ON hr_recruitment_applications(tenant_id,submission_key) WHERE submission_key IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hr_recruitment_employee_uq ON hr_recruitment_applications(employee_id) WHERE employee_id IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hr_recruitment_contacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id bigint NOT NULL REFERENCES tenants(id),
        application_id uuid NOT NULL REFERENCES hr_recruitment_applications(id) ON DELETE CASCADE,
        channel text NOT NULL,
        result text NOT NULL,
        internal_note text NOT NULL,
        actor_user_id text NOT NULL,
        contacted_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT hr_recruitment_contact_channel_ck CHECK(channel IN ('phone','email'))
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS hr_recruitment_contacts_app_idx ON hr_recruitment_contacts(application_id,contacted_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hr_recruitment_accounting_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id bigint NOT NULL REFERENCES tenants(id),
        application_id uuid NOT NULL REFERENCES hr_recruitment_applications(id) ON DELETE CASCADE,
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        task_type text NOT NULL DEFAULT 'employee_onboarding_accounting',
        status text NOT NULL DEFAULT 'open',
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        UNIQUE(application_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS hr_recruitment_accounting_tenant_status_idx ON hr_recruitment_accounting_tasks(tenant_id,status,created_at DESC)`);
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

export default ensureHrRecruitment;
