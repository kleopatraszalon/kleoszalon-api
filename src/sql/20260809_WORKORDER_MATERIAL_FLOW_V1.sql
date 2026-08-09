BEGIN;
CREATE TABLE IF NOT EXISTS service_material_requirements(
  id bigserial PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  default_quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'db',
  required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id,product_id)
);
CREATE INDEX IF NOT EXISTS service_material_requirements_service_idx ON service_material_requirements(service_id) WHERE active=true;
CREATE TABLE IF NOT EXISTS stock_replenishment_requests(
  id bigserial PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES locations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  requested_quantity numeric(14,3) NOT NULL,
  available_quantity numeric(14,3) NOT NULL DEFAULT 0,
  required_quantity numeric(14,3) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'requested',
  source_type text NOT NULL DEFAULT 'workorder_draft',
  source_ref text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_replenishment_requests_status_ck CHECK(status IN ('requested','approved','ordered','fulfilled','rejected','cancelled')),
  CONSTRAINT stock_replenishment_requests_qty_ck CHECK(requested_quantity>0)
);
CREATE INDEX IF NOT EXISTS stock_replenishment_requests_location_status_idx ON stock_replenishment_requests(location_id,status,created_at DESC);
COMMIT;
