import db from "../db";

let ready=false;
let running:Promise<void>|null=null;

export default async function ensureBookingV4(){
  if(ready)return;
  if(running)return running;
  running=(async()=>{
    await db.query(`
      -- A publikus árlista és /booking/catalog közvetlenül használja ezt a
      -- taxonómiát. Nem függhet attól, hogy az admin taxonomy route futott-e már.
      CREATE TABLE IF NOT EXISTS booking_departments(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        sort_order int NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS booking_service_categories(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        department_id uuid NOT NULL REFERENCES booking_departments(id) ON DELETE CASCADE,
        code text NOT NULL,
        name text NOT NULL,
        sort_order int NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(department_id,code)
      );
      CREATE TABLE IF NOT EXISTS booking_service_taxonomy(
        service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
        category_id uuid NOT NULL REFERENCES booking_service_categories(id) ON DELETE CASCADE,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO booking_departments(code,name,sort_order) VALUES
        ('hair','Fodrászat',10),
        ('handsfeet','Kéz- és lábápolás',20),
        ('beauty','Kozmetika',30),
        ('massage','Masszázs',40)
      ON CONFLICT(code) DO UPDATE SET
        name=EXCLUDED.name,
        sort_order=EXCLUDED.sort_order,
        is_active=true,
        updated_at=now();

      CREATE TABLE IF NOT EXISTS booking_staff_levels(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE,name text NOT NULL,
        sort_order int NOT NULL DEFAULT 100,is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO booking_staff_levels(code,name,sort_order) VALUES
        ('trainee','Gyakornok',10),('normal','Normál',20),('top','TOP',30),('master','Master',40)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order,is_active=true,updated_at=now();
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS booking_staff_level_id uuid REFERENCES booking_staff_levels(id);
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS public_bio text;
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_top_specialist boolean NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS employee_professional_categories(
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,category_code text NOT NULL,category_name text NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(employee_id,category_code)
      );
      CREATE TABLE IF NOT EXISTS employee_reference_photos(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        image_url text NOT NULL,caption text,sort_order int NOT NULL DEFAULT 100,is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS booking_service_prices_by_level(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        staff_level_id uuid NOT NULL REFERENCES booking_staff_levels(id) ON DELETE CASCADE,location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
        price numeric(12,2) NOT NULL CHECK(price>=0),is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_service_prices_by_level ON booking_service_prices_by_level(service_id,staff_level_id,COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid));
      CREATE TABLE IF NOT EXISTS booking_service_recommendations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        recommended_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
        priority int NOT NULL DEFAULT 100,recommendation_type text NOT NULL DEFAULT 'cross_sell' CHECK(recommendation_type IN('upsell','cross_sell','bundle')),
        label text,discount_percent numeric(5,2),is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(source_service_id<>recommended_service_id)
      );
      CREATE TABLE IF NOT EXISTS booking_coupon_campaigns(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE,name text NOT NULL,
        discount_type text NOT NULL CHECK(discount_type IN('percent','fixed')),discount_value numeric(12,2) NOT NULL CHECK(discount_value>0),
        valid_from timestamptz,valid_until timestamptz,minimum_booking_value numeric(12,2),max_total_uses int,max_uses_per_customer int,
        combinable boolean NOT NULL DEFAULT false,exclude_last_minute boolean NOT NULL DEFAULT true,is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS booking_coupon_locations(coupon_id uuid NOT NULL REFERENCES booking_coupon_campaigns(id) ON DELETE CASCADE,location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,PRIMARY KEY(coupon_id,location_id));
      CREATE TABLE IF NOT EXISTS booking_coupon_services(coupon_id uuid NOT NULL REFERENCES booking_coupon_campaigns(id) ON DELETE CASCADE,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,PRIMARY KEY(coupon_id,service_id));
      CREATE TABLE IF NOT EXISTS booking_coupon_redemptions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),coupon_id uuid NOT NULL REFERENCES booking_coupon_campaigns(id) ON DELETE RESTRICT,
        appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
        discount_amount numeric(12,2) NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_booking_coupon_redemptions_coupon ON booking_coupon_redemptions(coupon_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_booking_coupon_redemptions_client ON booking_coupon_redemptions(coupon_id,client_id,created_at);
      CREATE TABLE IF NOT EXISTS booking_last_minute_rules(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
        service_id uuid REFERENCES services(id) ON DELETE CASCADE,staff_level_id uuid REFERENCES booking_staff_levels(id) ON DELETE SET NULL,
        free_capacity_threshold_percent numeric(5,2) NOT NULL DEFAULT 50 CHECK(free_capacity_threshold_percent BETWEEN 0 AND 100),
        discount_percent numeric(5,2) NOT NULL DEFAULT 20 CHECK(discount_percent>0 AND discount_percent<=100),validity_hours int NOT NULL DEFAULT 24 CHECK(validity_hours BETWEEN 1 AND 168),
        same_day_only boolean NOT NULL DEFAULT true,is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS booking_last_minute_offers(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rule_id uuid REFERENCES booking_last_minute_rules(id) ON DELETE SET NULL,
        location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,
        original_price numeric(12,2) NOT NULL,offer_price numeric(12,2) NOT NULL,discount_percent numeric(5,2) NOT NULL,expires_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK(status IN('active','booked','expired','cancelled')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(end_time>start_time),CHECK(offer_price>=0 AND original_price>=offer_price)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_last_minute_offer_slot ON booking_last_minute_offers(location_id,service_id,employee_id,start_time) WHERE status='active';
      CREATE TABLE IF NOT EXISTS booking_guest_beneficiaries(
        appointment_id uuid PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,booked_for_other boolean NOT NULL DEFAULT false,
        guest_name text,guest_phone text,guest_email text,relationship_label text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS booking_marketing_consents(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,email text,phone text,
        channel text NOT NULL DEFAULT 'email',consented boolean NOT NULL,consent_text_version text NOT NULL DEFAULT 'booking-v4-2026-08-20',
        source text NOT NULL DEFAULT 'online_booking',consented_at timestamptz,withdrawn_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    try{
      await db.query(`
        WITH parent AS (
          SELECT id FROM menus WHERE code IN ('appointments','booking','settings')
          ORDER BY CASE code WHEN 'appointments' THEN 0 WHEN 'booking' THEN 1 ELSE 2 END LIMIT 1
        )
        INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
        SELECT 'appointments.booking_v4','Booking 4.0 – foglalás és ajánlatok','CalendarClock','/admin/booking-v4',95,parent.id,'appointments',true FROM parent
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;
      `);
      await db.query(`
        INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
        SELECT r.role_key,m.id,true,true,true,false,true,true,true,(r.role_key='admin'),'all_locations',now()
        FROM (VALUES ('admin'),('manager')) r(role_key) JOIN menus m ON m.code='appointments.booking_v4'
        ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_approve=true,can_export=true,can_view_financial=true,updated_at=now();
      `);
    }catch(error:any){console.warn('[booking-v4] admin menu self-heal skipped',error?.message||error);}
    ready=true;
  })().finally(()=>{running=null});
  return running;
}
