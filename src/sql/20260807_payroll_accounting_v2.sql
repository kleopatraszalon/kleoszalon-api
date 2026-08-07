BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS payroll_legal_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tax_year int NOT NULL, valid_from date NOT NULL, valid_to date,
 code text NOT NULL, name text NOT NULL, rate numeric(10,6), amount numeric(14,2), config jsonb NOT NULL DEFAULT '{}'::jsonb,
 source_url text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tax_year,code,valid_from)
);
CREATE INDEX IF NOT EXISTS payroll_legal_rules_valid_idx ON payroll_legal_rules(tax_year,valid_from,valid_to,active);

CREATE TABLE IF NOT EXISTS employee_tax_declarations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 declaration_type text NOT NULL, valid_from date NOT NULL, valid_to date, monthly_amount numeric(14,2), data jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'active', document_ref text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_tax_declarations_emp_idx ON employee_tax_declarations(employee_id,valid_from,valid_to,status);

CREATE TABLE IF NOT EXISTS payroll_payslips (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
 payroll_item_id uuid NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE, employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 period_from date NOT NULL, period_to date NOT NULL, document_no text NOT NULL UNIQUE, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 generated_at timestamptz, emailed_at timestamptz, email_to text, email_status text NOT NULL DEFAULT 'not_sent', email_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(payroll_run_id,employee_id)
);

CREATE TABLE IF NOT EXISTS accounting_journal_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
 entry_date date NOT NULL, document_no text, source_type text NOT NULL, source_id text, description text,
 status text NOT NULL DEFAULT 'draft', created_by text, approved_by text, approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounting_journal_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
 account_code text NOT NULL, account_name text, debit numeric(14,2) NOT NULL DEFAULT 0, credit numeric(14,2) NOT NULL DEFAULT 0,
 employee_id uuid REFERENCES employees(id) ON DELETE SET NULL, note text, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(debit>=0 AND credit>=0), CHECK(NOT(debit>0 AND credit>0))
);
CREATE INDEX IF NOT EXISTS accounting_journal_lines_entry_idx ON accounting_journal_lines(journal_entry_id);

INSERT INTO payroll_legal_rules(tax_year,valid_from,code,name,rate,amount,source_url) VALUES
(2026,'2026-01-01','MIN_WAGE_MONTHLY','Minimálbér havi',NULL,322800,'https://magyarkozlony.hu/'),
(2026,'2026-01-01','GUARANTEED_MIN_MONTHLY','Garantált bérminimum havi',NULL,373200,'https://magyarkozlony.hu/'),
(2026,'2026-01-01','PIT','Személyi jövedelemadó',0.15,NULL,'https://nav.gov.hu/'),
(2026,'2026-01-01','TB','Társadalombiztosítási járulék',0.185,NULL,'https://nav.gov.hu/'),
(2026,'2026-01-01','SZOCHO','Szociális hozzájárulási adó',0.13,NULL,'https://nav.gov.hu/')
ON CONFLICT(tax_year,code,valid_from) DO UPDATE SET rate=EXCLUDED.rate,amount=EXCLUDED.amount,source_url=EXCLUDED.source_url,updated_at=now();
COMMIT;
