BEGIN;

-- 1. etap: a belső termék- és szolgáltatás-törzs menük alap RBAC mátrixa.
-- A menük létrehozását a korábbi idempotens masterdata migrációk végzik.
-- Itt csak hiányzó alapjogosultságokat adunk hozzá; meglévő, admin felületen
-- testreszabott jogosultságot nem írunk felül.

INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT
  'admin',m.id,true,true,true,true,true,true,true,true,'all_locations'
FROM menus m
WHERE m.code IN (
  'masterdata.products',
  'masterdata.product-groups',
  'masterdata.product-categories',
  'masterdata.services',
  'masterdata.service-types'
)
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- A meglévő VIR alapmátrix mintáját követjük: a vállalati manager
-- törzsadatot láthat, létrehozhat és módosíthat, de nem törölhet.
INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT
  'manager',m.id,true,true,true,false,true,true,true,false,'all_locations'
FROM menus m
WHERE m.code IN (
  'masterdata.products',
  'masterdata.product-groups',
  'masterdata.product-categories',
  'masterdata.services',
  'masterdata.service-types'
)
ON CONFLICT(role_key,menu_id) DO NOTHING;

COMMIT;
