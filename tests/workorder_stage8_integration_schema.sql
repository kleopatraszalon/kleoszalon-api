CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE locations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,city text,address text,is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE employees(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),full_name text NOT NULL,email text,phone text,location_id uuid REFERENCES locations(id),active boolean NOT NULL DEFAULT true,position_id uuid
);
CREATE TABLE clients(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,full_name text,phone text,email text,location_id uuid REFERENCES locations(id),is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE services(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,base_price numeric(14,2) DEFAULT 0,list_price numeric(14,2),promo_price numeric(14,2),duration_minutes int DEFAULT 30,is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE service_locations(service_id uuid REFERENCES services(id),location_id uuid REFERENCES locations(id),PRIMARY KEY(service_id,location_id));
CREATE TABLE employee_service_overrides(
 employee_id uuid REFERENCES employees(id),service_id uuid REFERENCES services(id),custom_price numeric(14,2),custom_duration_minutes int,PRIMARY KEY(employee_id,service_id)
);
CREATE TABLE products(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,retail_price_gross numeric(14,2) DEFAULT 0,is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE appointments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid REFERENCES locations(id),employee_id uuid REFERENCES employees(id),client_id uuid REFERENCES clients(id),title text,start_time timestamptz,end_time timestamptz,status text DEFAULT 'booked',notes text,work_order_id uuid,work_order_number text
);
CREATE TABLE appointment_services(
 appointment_id uuid REFERENCES appointments(id),service_id uuid REFERENCES services(id),duration_minutes int,price numeric(14,2),sort_order int DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text,notes text,status text NOT NULL DEFAULT 'waiting',employee_id uuid REFERENCES employees(id),client_id uuid REFERENCES clients(id),client_name text,client_phone text,client_email text,location_id uuid REFERENCES locations(id),appointment_id uuid REFERENCES appointments(id),fully_paid boolean NOT NULL DEFAULT false,note_for_another_visitor boolean NOT NULL DEFAULT false,created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),status_updated_at timestamptz,work_order_number text,source_created_at timestamptz,source_snapshot jsonb,started_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,locked_at timestamptz,locked_reason text,archived_at timestamptz,archive_hash text,gross_total numeric(14,2) DEFAULT 0,discount_amount numeric(14,2) DEFAULT 0,tip_amount numeric(14,2) DEFAULT 0,amount_due numeric(14,2) DEFAULT 0,amount_paid numeric(14,2) DEFAULT 0,payment_status text DEFAULT 'unpaid',invoice_status text DEFAULT 'not_requested',financial_closed_at timestamptz,financial_closed_by text,stock_consumed_at timestamptz,document_status text DEFAULT 'draft',closed_at timestamptz,closed_by text
);
CREATE TABLE work_order_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id),item_type text NOT NULL,service_id uuid REFERENCES services(id),product_id uuid REFERENCES products(id),item_name text,quantity numeric(14,3) NOT NULL DEFAULT 1,unit_price numeric(14,2) NOT NULL DEFAULT 0,discount_amount numeric(14,2) NOT NULL DEFAULT 0,line_total numeric(14,2) NOT NULL DEFAULT 0,duration_minutes int,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_order_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id),payment_method text NOT NULL,amount numeric(14,2) NOT NULL,paid_at timestamptz NOT NULL DEFAULT now(),note text,financial_account_id uuid,financial_movement_id uuid
);
CREATE TABLE product_stock_balances(
 id bigserial PRIMARY KEY,product_id uuid NOT NULL REFERENCES products(id),location_id uuid,quantity numeric(14,3) NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_stock_balances_product_location_uq ON product_stock_balances(product_id,location_id) WHERE location_id IS NOT NULL;

CREATE TABLE financial_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid,name text NOT NULL,account_type text NOT NULL,currency text NOT NULL DEFAULT 'HUF',opening_balance numeric(14,2) NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,note text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE financial_movements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid,account_id uuid REFERENCES financial_accounts(id),direction text,amount numeric(14,2),occurred_at timestamptz,reference_type text,reference_id text,counterparty text,note text,created_by text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE finance_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid,direction text,invoice_no text,partner_name text,issue_date date,performance_date date,due_date date,currency text,net_total numeric(14,2),vat_total numeric(14,2),gross_total numeric(14,2),status text,work_order_id uuid,note text,created_by text,document_kind text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE internal_invoice_seq START 1;
CREATE OR REPLACE FUNCTION next_internal_invoice_number() RETURNS text LANGUAGE sql AS $$ SELECT 'INT-'||LPAD(nextval('internal_invoice_seq')::text,6,'0') $$;

CREATE TABLE crm_guest_profiles(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_key text UNIQUE NOT NULL,client_name text,client_email text,client_phone text,first_visit_at timestamptz,last_visit_at timestamptz,last_location_id uuid,last_employee_id uuid,last_service_names jsonb DEFAULT '[]',last_product_names jsonb DEFAULT '[]',visit_count int NOT NULL DEFAULT 0,total_spent numeric(14,2) NOT NULL DEFAULT 0,total_discount numeric(14,2) NOT NULL DEFAULT 0,total_tip numeric(14,2) NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_visit_history(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid REFERENCES crm_guest_profiles(id),work_order_id uuid UNIQUE,visited_at timestamptz,location_id uuid,employee_id uuid,gross_total numeric(14,2),discount_amount numeric(14,2),tip_amount numeric(14,2),amount_paid numeric(14,2),service_names jsonb,product_names jsonb
);

CREATE TABLE loyalty_checkout_settlements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid UNIQUE REFERENCES work_orders(id),created_at timestamptz NOT NULL DEFAULT now()
);
