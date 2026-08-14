import db from '../db';

const ACCOUNTING_LOGIN='könyvelés';
const ACCOUNTING_EMAIL='konyveles@kleoszalon.hu';
const ACCOUNTING_NAME='Könyvelés';
const ACCOUNTING_PASSWORD_HASH='$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO';

async function safeQuery(label:string,sql:string){
  try{
    await db.query(sql);
    return true;
  }catch(err){
    console.error(`[ACCOUNTING RBAC] ${label} sikertelen:`,err);
    return false;
  }
}

async function ensureAccountingPermissions(){
  const results:boolean[]=[];

  results.push(await safeQuery('access role',`
    INSERT INTO access_roles(role_key,label,description,level,is_system,is_active,updated_at)
    VALUES('accounting','Könyvelés','Könyvelési moduladmin: pénzügy/NAV, bér, beszerzés és raktár-készlet teljes kezelése minden telephelyen; kapcsolódó adatokhoz szükséges hozzáféréssel.',80,true,true,now())
    ON CONFLICT(role_key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,level=EXCLUDED.level,is_active=true,updated_at=now()
  `));

  results.push(await safeQuery('feature permissions',`
    INSERT INTO role_feature_permissions(role_key,feature_key,can_view,can_create,can_edit,can_delete,can_export,scope_type,updated_at)
    VALUES
      ('accounting','management_dashboard',true,false,false,false,true,'all_locations',now()),
      ('accounting','finance',true,true,true,true,true,'all_locations',now()),
      ('accounting','payroll',true,true,true,true,true,'all_locations',now()),
      ('accounting','inventory',true,true,true,true,true,'all_locations',now()),
      ('accounting','procurement',true,true,true,true,true,'all_locations',now()),
      ('accounting','hr',true,false,false,false,true,'all_locations',now()),
      ('accounting','employees',true,false,false,false,true,'all_locations',now()),
      ('accounting','clients',true,false,false,false,true,'all_locations',now()),
      ('accounting','crm',true,false,false,false,true,'all_locations',now()),
      ('accounting','reports',true,false,false,false,true,'all_locations',now()),
      ('accounting','knowledge_base',true,false,false,false,true,'all_locations',now()),
      ('accounting','audit',true,false,false,false,true,'all_locations',now()),
      ('accounting','marketing',true,false,false,false,true,'all_locations',now()),
      ('accounting','masterdata',true,false,true,false,true,'all_locations',now())
    ON CONFLICT(role_key,feature_key) DO UPDATE SET
      can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,
      can_delete=EXCLUDED.can_delete,can_export=EXCLUDED.can_export,scope_type='all_locations',updated_at=now()
  `));

  results.push(await safeQuery('menu permission rows',`
    INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,manage_permissions,scope_type,updated_at)
    SELECT 'accounting',m.id,false,false,false,false,false,false,false,false,'all_locations',now() FROM menus m
    ON CONFLICT(role_key,menu_id) DO NOTHING
  `));

  results.push(await safeQuery('module admin menu permissions',`
    UPDATE role_menu_permissions p SET
      can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,
      can_view_financial=true,manage_permissions=false,scope_type='all_locations',updated_at=now()
    FROM menus m
    WHERE p.menu_id=m.id AND p.role_key='accounting' AND (
      m.code='finance' OR m.code LIKE 'finance.%' OR
      m.code='payroll' OR m.code LIKE 'payroll%' OR
      m.code='inventory' OR m.code LIKE 'inventory.%' OR
      m.code='procurement' OR m.code LIKE 'procurement.%'
    )
  `));

  results.push(await safeQuery('source-data menu permissions',`
    UPDATE role_menu_permissions p SET
      can_view=true,
      can_create=CASE WHEN m.code LIKE 'masterdata%' THEN true ELSE false END,
      can_edit=CASE WHEN m.code LIKE 'masterdata%' THEN true ELSE false END,
      can_delete=false,can_approve=false,can_export=true,can_view_financial=true,
      manage_permissions=false,scope_type='all_locations',updated_at=now()
    FROM menus m
    WHERE p.menu_id=m.id AND p.role_key='accounting' AND (
      m.code='dashboard' OR m.code LIKE 'dashboard%' OR
      m.code LIKE 'employees%' OR m.code LIKE 'team.employees%' OR
      m.code LIKE 'clients%' OR m.code LIKE 'customers%' OR m.code LIKE 'crm%' OR
      m.code LIKE 'reports%' OR m.code LIKE 'knowledge%' OR
      m.code LIKE 'audit%' OR m.code='settings.audit' OR
      m.code LIKE 'marketing%' OR m.code LIKE 'masterdata%'
    )
  `));

  results.push(await safeQuery('workorder source permission',`
    UPDATE role_menu_permissions p SET
      can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,
      can_export=true,can_view_financial=true,manage_permissions=false,scope_type='all_locations',updated_at=now()
    FROM menus m WHERE p.menu_id=m.id AND p.role_key='accounting' AND m.code='finance.workorders'
  `));

  return results.every(Boolean);
}

export async function ensureAccountingUser(){
  const roleTypeResult=await db.query(`SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role' LIMIT 1`);
  const roleType=String(roleTypeResult.rows[0]?.udt_name||'');
  const existing=await db.query(`SELECT id FROM users WHERE lower(COALESCE(login_name,''))=lower($1) OR lower(COALESCE(email,''))=lower($2) LIMIT 1`,[ACCOUNTING_LOGIN,ACCOUNTING_EMAIL]);
  const roleValue=roleType==='jsonb'||roleType==='json'?'["accounting"]':'accounting';
  let id:string;
  let created=false;

  if(existing.rows[0]?.id){
    id=String(existing.rows[0].id);
    if(roleType==='jsonb') await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5::jsonb,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
    else if(roleType==='json') await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5::json,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
    else await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
  } else {
    let inserted;
    if(roleType==='jsonb') inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::jsonb,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
    else if(roleType==='json') inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::json,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
    else inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
    id=String(inserted.rows[0]?.id||'');
    created=true;
  }

  // A jogosultság-szinkron nem blokkolhatja a bejelentkezést.
  // Eltérő/hiányos éles RBAC séma esetén a hibát naplózzuk, a felhasználó viszont beléphet.
  let permissionsSynced=false;
  try{
    permissionsSynced=await ensureAccountingPermissions();
  }catch(err){
    console.error('[ACCOUNTING RBAC] váratlan szinkronhiba:',err);
  }

  return {created,id,permissionsSynced};
}
