BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL DEFAULT 'COMPANY' CHECK (entity_type IN ('COMPANY','SOLE_PROPRIETOR','OTHER')),
  legal_name text NOT NULL,
  short_name text,
  legal_form text,
  tax_number varchar(11) NOT NULL,
  group_tax_number varchar(11),
  eu_vat_number text,
  company_register_number text,
  sole_proprietor_registration_number text,
  statistical_number text,
  registered_country_code varchar(2) NOT NULL DEFAULT 'HU',
  registered_postal_code text NOT NULL,
  registered_city text NOT NULL,
  registered_address_line text NOT NULL,
  main_activity_code text,
  main_activity_name text,
  representative_name text,
  representative_title text,
  bank_account_number text,
  iban text,
  bic text,
  official_email text,
  phone text,
  currency varchar(3) NOT NULL DEFAULT 'HUF',
  default_vat_rate numeric(6,3) NOT NULL DEFAULT 27,
  invoice_prefix text NOT NULL DEFAULT 'KLEO',
  receipt_prefix text NOT NULL DEFAULT 'KLEO-NY',
  accounting_ledger_code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_entities_hu_tax_number_chk CHECK (registered_country_code <> 'HU' OR tax_number ~ '^[0-9]{11}$'),
  CONSTRAINT legal_entities_company_id_chk CHECK (entity_type <> 'COMPANY' OR NULLIF(btrim(company_register_number),'') IS NOT NULL),
  CONSTRAINT legal_entities_sole_prop_id_chk CHECK (entity_type <> 'SOLE_PROPRIETOR' OR NULLIF(btrim(sole_proprietor_registration_number),'') IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_tax_number_uq ON legal_entities(tax_number) WHERE active=true;
CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_ledger_code_uq ON legal_entities(accounting_ledger_code);

CREATE TABLE IF NOT EXISTS legal_entity_locations (
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (legal_entity_id,location_id)
);
CREATE INDEX IF NOT EXISTS legal_entity_locations_location_idx ON legal_entity_locations(location_id,active);
CREATE UNIQUE INDEX IF NOT EXISTS legal_entity_locations_one_default_uq ON legal_entity_locations(location_id) WHERE active=true AND is_default=true;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
ALTER TABLE nav_online_invoice_settings ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;

DO $$ BEGIN
  IF to_regclass('public.vir_receipt_report_batches') IS NOT NULL THEN
    ALTER TABLE vir_receipt_report_batches ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
  END IF;
  IF to_regclass('public.retail_sales') IS NOT NULL THEN
    ALTER TABLE retail_sales ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
  END IF;
  IF to_regclass('public.vir_receipts') IS NOT NULL THEN
    ALTER TABLE vir_receipts ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Első bevezetéskor a meglévő NAV kibocsátói konfigurációból képzünk egy alap céget,
-- hogy a korábbi munkalapok és pénzügyi tételek ne maradjanak gazdátlanul.
DO $$
DECLARE cfg record; entity_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legal_entities) AND to_regclass('public.nav_online_invoice_settings') IS NOT NULL THEN
    SELECT * INTO cfg FROM nav_online_invoice_settings WHERE active=true ORDER BY created_at NULLS LAST LIMIT 1;
    IF cfg IS NOT NULL AND length(regexp_replace(COALESCE(cfg.supplier_tax_number,''),'\D','','g')) >= 11 THEN
      INSERT INTO legal_entities(
        entity_type,legal_name,short_name,company_register_number,tax_number,registered_country_code,
        registered_postal_code,registered_city,registered_address_line,currency,
        default_vat_rate,invoice_prefix,receipt_prefix,accounting_ledger_code,created_by
      ) VALUES(
        'COMPANY',COALESCE(NULLIF(cfg.supplier_name,''),'Kleopatra2003 Kft'),COALESCE(NULLIF(cfg.supplier_name,''),'Kleopatra2003 Kft'),'ADATPOTLAS-SZUKSEGES',
        left(regexp_replace(cfg.supplier_tax_number,'\D','','g'),11),COALESCE(NULLIF(cfg.supplier_country_code,''),'HU'),
        COALESCE(NULLIF(cfg.supplier_postal_code,''),'0000'),COALESCE(NULLIF(cfg.supplier_city,''),'Ismeretlen'),
        COALESCE(NULLIF(cfg.supplier_address,''),'Adatpótlás szükséges'),COALESCE(NULLIF(cfg.currency,''),'HUF'),
        CASE WHEN COALESCE(cfg.default_vat_rate,0.27)<=1 THEN COALESCE(cfg.default_vat_rate,0.27)*100 ELSE cfg.default_vat_rate END,
        COALESCE(NULLIF(cfg.invoice_prefix,''),'KLEO'),'KLEO-NY','LE-0001','migration'
      ) RETURNING id INTO entity_id;
    END IF;
  END IF;
END $$;

-- Ha már van legalább egy cég, minden aktív szalonhoz legyen alapértelmezett hozzárendelés.
DO $$
DECLARE entity_id uuid;
BEGIN
  SELECT id INTO entity_id FROM legal_entities WHERE active=true ORDER BY created_at,id LIMIT 1;
  IF entity_id IS NOT NULL THEN
    INSERT INTO legal_entity_locations(legal_entity_id,location_id,is_default)
    SELECT entity_id,l.id,true FROM locations l
    WHERE COALESCE(l.is_active,true)=true
      AND NOT EXISTS (SELECT 1 FROM legal_entity_locations x WHERE x.location_id=l.id AND x.active=true)
    ON CONFLICT DO NOTHING;

    UPDATE work_orders w SET legal_entity_id=COALESCE(w.legal_entity_id,
      (SELECT x.legal_entity_id FROM legal_entity_locations x WHERE x.location_id=w.location_id AND x.active=true ORDER BY x.is_default DESC LIMIT 1),entity_id)
    WHERE w.legal_entity_id IS NULL;
    UPDATE work_order_payments p SET legal_entity_id=COALESCE(p.legal_entity_id,(SELECT w.legal_entity_id FROM work_orders w WHERE w.id::text=p.work_order_id::text),entity_id)
    WHERE p.legal_entity_id IS NULL;
    UPDATE finance_invoices i SET legal_entity_id=COALESCE(i.legal_entity_id,(SELECT w.legal_entity_id FROM work_orders w WHERE w.id::text=i.work_order_id::text),entity_id)
    WHERE i.legal_entity_id IS NULL;
    UPDATE financial_movements m SET legal_entity_id=COALESCE(m.legal_entity_id,(SELECT w.legal_entity_id FROM work_orders w WHERE w.id::text=m.work_order_id::text),entity_id)
    WHERE m.legal_entity_id IS NULL;
    IF to_regclass('public.retail_sales') IS NOT NULL THEN
      UPDATE retail_sales r SET legal_entity_id=COALESCE(r.legal_entity_id,
        (SELECT x.legal_entity_id FROM legal_entity_locations x WHERE x.location_id::text=r.location_id::text AND x.active=true ORDER BY x.is_default DESC LIMIT 1),entity_id)
      WHERE r.legal_entity_id IS NULL;
    END IF;
    IF to_regclass('public.vir_receipts') IS NOT NULL THEN
      UPDATE vir_receipts r SET legal_entity_id=COALESCE(r.legal_entity_id,
        CASE WHEN r.source_type='WORK_ORDER' THEN (SELECT w.legal_entity_id FROM work_orders w WHERE w.id::text=r.source_id::text) ELSE NULL END,
        CASE WHEN r.source_type='RETAIL_SALE' AND to_regclass('public.retail_sales') IS NOT NULL THEN (SELECT s.legal_entity_id FROM retail_sales s WHERE s.id::text=r.source_id::text) ELSE NULL END,
        entity_id)
      WHERE r.legal_entity_id IS NULL;
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION vir_fill_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reversal_id_text text;
BEGIN
  IF NEW.legal_entity_id IS NULL AND NEW.work_order_id IS NOT NULL THEN
    SELECT legal_entity_id INTO NEW.legal_entity_id FROM work_orders WHERE id::text=NEW.work_order_id::text;
  END IF;
  IF NEW.legal_entity_id IS NULL AND TG_TABLE_NAME='financial_movements' THEN
    reversal_id_text:=to_jsonb(NEW)->>'reversal_of_id';
    IF NULLIF(btrim(COALESCE(reversal_id_text,'')),'') IS NOT NULL THEN
      SELECT legal_entity_id INTO NEW.legal_entity_id FROM financial_movements WHERE id::text=reversal_id_text;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_order_payments_legal_entity ON work_order_payments;
CREATE TRIGGER trg_work_order_payments_legal_entity BEFORE INSERT OR UPDATE OF work_order_id ON work_order_payments FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();
DROP TRIGGER IF EXISTS trg_finance_invoices_legal_entity ON finance_invoices;
CREATE TRIGGER trg_finance_invoices_legal_entity BEFORE INSERT OR UPDATE OF work_order_id ON finance_invoices FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();
DROP TRIGGER IF EXISTS trg_financial_movements_legal_entity ON financial_movements;
CREATE TRIGGER trg_financial_movements_legal_entity BEFORE INSERT OR UPDATE OF work_order_id,reversal_of_id ON financial_movements FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();

CREATE INDEX IF NOT EXISTS work_orders_legal_entity_idx ON work_orders(legal_entity_id,created_at DESC);
CREATE INDEX IF NOT EXISTS work_order_payments_legal_entity_idx ON work_order_payments(legal_entity_id,paid_at DESC);
CREATE INDEX IF NOT EXISTS finance_invoices_legal_entity_idx ON finance_invoices(legal_entity_id,issue_date DESC);
CREATE INDEX IF NOT EXISTS financial_movements_legal_entity_idx ON financial_movements(legal_entity_id,occurred_at DESC);

COMMIT;