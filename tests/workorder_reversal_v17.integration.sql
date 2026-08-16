\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE work_orders(
 id uuid PRIMARY KEY,tenant_id bigint,location_id uuid,status text,locked_at timestamptz,archived_at timestamptz,archive_hash text
);
CREATE TABLE work_order_reversals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
 tenant_id bigint,location_id uuid,reason text NOT NULL CHECK(length(btrim(reason))>=5),requested_by text NOT NULL,
 idempotency_key text NOT NULL,status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','processing','completed','failed')),
 reversal_payload jsonb NOT NULL DEFAULT '{}'::jsonb,original_archive_hash text,created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,failure_code text,failure_detail text,UNIQUE(work_order_id),UNIQUE(idempotency_key)
);

INSERT INTO work_orders(id,tenant_id,status,locked_at,archived_at,archive_hash) VALUES
 ('00000000-0000-0000-0000-000000000701',1,'completed',now(),now(),'h1'),
 ('00000000-0000-0000-0000-000000000702',1,'completed',now(),now(),'h2');

\i src/sql/20260816_WORKORDER_REVERSAL_API_V8.sql

DO $$
DECLARE first_id uuid;retry_id uuid;blocked boolean:=false;
BEGIN
 SELECT id INTO first_id FROM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000701','téves pénzügyi lezárás','ci','v17-key-0001');
 SELECT id INTO retry_id FROM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000701','téves pénzügyi lezárás','ci','v17-key-0001');
 IF first_id IS DISTINCT FROM retry_id THEN RAISE EXCEPTION 'same-workorder retry did not return same reversal'; END IF;
 BEGIN
   PERFORM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000702','második munkalap','ci','v17-key-0001');
 EXCEPTION WHEN unique_violation THEN
   IF SQLERRM LIKE '%REVERSAL_IDEMPOTENCY_KEY_CONFLICT%' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'cross-workorder idempotency reuse was not blocked'; END IF;
END $$;

SELECT 'PASS workorder_reversal_v17' AS result;
