import pool from "../db";

const MASTERDATA_ITEMS = [
  ["masterdata.central", "Központi törzsadatok", "Database", "/masterdata", 5, "master_data"],
  ["masterdata.user-groups", "Felhasználói csoportok", "ShieldCheck", "/admin/access-control", 10, "access_control"],
  ["masterdata.users", "Felhasználók", "Users", "/employees", 20, "hr"],
  ["masterdata.service-types", "Szolgáltatási kategóriák", "Tags", "/masterdata/services?view=categories", 30, "service_categories"],
  ["masterdata.services", "Szolgáltatások", "Sparkles", "/masterdata/services", 40, "services"],
  ["masterdata.employee-services", "Szakember–szolgáltatás beállítások", "UserCog", "/masterdata/services?view=staff", 45, "employee_services"],
  ["masterdata.product-types", "Terméktípusok", "Tags", "/masterdata/products/taxonomy-review", 50, "product_types"],
  ["masterdata.product-groups", "Termékcsoportok", "Layers3", "/masterdata/products?view=groups", 52, "product_groups"],
  ["masterdata.product-categories", "Alkategóriák", "FolderTree", "/masterdata/products?view=categories", 54, "product_categories"],
  ["masterdata.products", "Termékek", "Package", "/masterdata/products", 60, "products"],
  ["masterdata.equipment-types", "Eszköztípusok", "Settings2", "/masterdata/equipment-types", 70, "assets"],
  ["masterdata.assets", "Eszközök", "Wrench", "/masterdata/assets", 80, "assets"],
  ["masterdata.positions", "Munkakörök", "BriefcaseBusiness", "/hr/positions", 90, "hr_positions"],
  ["masterdata.departments", "Részlegek", "Building2", "/masterdata/departments", 100, "departments"],
  ["masterdata.leave-types", "Szabadságtípusok", "CalendarDays", "/masterdata/leave-types", 110, "leave_types"],
  ["masterdata.discounts", "Kedvezménytörzs", "BadgePercent", "/spec/discounts", 120, "discounts"],
  ["masterdata.payment-methods", "Fizetési módok", "WalletCards", "/masterdata/payment-methods", 130, "finance"],
  ["masterdata.tax-rates", "ÁFA típusok", "Percent", "/spec/vat-types", 140, "vat_types"],
  ["masterdata.salons", "Telephelyek", "MapPin", "/masterdata/salons", 150, "master_data"],
  ["masterdata.price-types", "Ártípusok", "Landmark", "/masterdata/price-types", 160, "price_types"],
  ["masterdata.warehouses", "Raktárak", "Warehouse", "/masterdata/warehouses", 170, "warehouses"],
  ["masterdata.units", "Mértékegységek", "Ruler", "/masterdata/units", 180, "units"],
  ["masterdata.guest-accounts", "Vendégszámlák", "CreditCard", "/spec/guest-accounts", 190, "guest_accounts"],
  ["masterdata.passes-giftcards", "Bérletek és ajándékkártyák", "Gift", "/loyalty", 200, "loyalty"],
  ["masterdata.guest-account-types", "Vendégszámla tranzakció típusok", "ReceiptText", "/spec/guest-account-transaction-types", 210, "guest_account_transaction_types"],
  ["masterdata.user-fields", "Felhasználói mezők", "ListPlus", "/spec/user-fields", 220, "user_fields"],
  ["masterdata.suppliers", "Partnerek / Beszállítók", "Truck", "/masterdata/suppliers", 230, "suppliers"],
  ["masterdata.movement-types", "Készletmozgás-típusok", "Boxes", "/masterdata/movement-types", 240, "movement_types"],
  ["masterdata.transaction-types", "Pénzügyi tranzakciótípusok", "Database", "/masterdata/financial-transaction-types", 250, "financial_transaction_types"],
] as const;

export async function ensureMasterDataMenuHealth() {
  await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text; ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text; ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL`);
  await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=NULL,order_index=EXCLUDED.order_index,parent_id=NULL,feature_key=EXCLUDED.feature_key,is_active=true`);

  const parent = await pool.query(`SELECT id FROM menus WHERE code='masterdata' LIMIT 1`);
  const parentId = parent.rows[0]?.id;
  if (!parentId) throw new Error("A Törzsadatok főmenü nem hozható létre.");

  for (const [code,name,icon,route,orderIndex,featureKey] of MASTERDATA_ITEMS) {
    await pool.query(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`, [code,name,icon,route,orderIndex,parentId,featureKey]);
  }

  await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now() FROM menus m WHERE m.code='masterdata' OR m.code LIKE 'masterdata.%' ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations',updated_at=now()`);
  await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations',now() FROM menus m WHERE (m.code='masterdata' OR m.code LIKE 'masterdata.%') AND m.code<>'masterdata.user-groups' ON CONFLICT(role_key,menu_id) DO NOTHING`);
  await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) SELECT 'manager',m.id,false,false,false,false,false,false,false,false,'all_locations',now() FROM menus m WHERE m.code='masterdata.user-groups' ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,can_manage_permissions=false,updated_at=now()`);
}
