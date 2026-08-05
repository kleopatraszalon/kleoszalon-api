-- CUSTOMER_CRM_V1
-- A futásidejű kompatibilitási migrációval azonos CRM-bővítés dokumentált változata.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_contact text DEFAULT 'phone';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS crm_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,color text NOT NULL DEFAULT '#7c5ce5',is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_name_uq ON crm_tags ((lower(name)));
CREATE TABLE IF NOT EXISTS crm_client_tags (client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,tag_id uuid NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(client_id,tag_id));
CREATE TABLE IF NOT EXISTS crm_client_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,note_text text NOT NULL,created_by text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS crm_forms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,description text,form_type text NOT NULL DEFAULT 'questionnaire',is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_title_uq ON crm_forms ((lower(title)));
CREATE TABLE IF NOT EXISTS crm_form_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),form_id uuid NOT NULL REFERENCES crm_forms(id) ON DELETE CASCADE,client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,status text NOT NULL DEFAULT 'completed',response_data jsonb NOT NULL DEFAULT '{}'::jsonb,completed_at timestamptz NOT NULL DEFAULT now());
