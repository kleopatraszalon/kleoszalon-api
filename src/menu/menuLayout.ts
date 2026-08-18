import pool from "../db";

export type MenuLayoutItem={id:number;parent_id:number|null;order_index:number};

let schemaPromise:Promise<void>|null=null;

async function ensureMovableAdminItems(){
 await pool.query(`
  WITH defs(code,name,icon,route,order_index,parent_code,feature_key) AS (VALUES
    ('finance.receipt_compliance','Nyugta és NAV-adatszolgáltatás','WalletCards','/finance/receipt-compliance',170,'finance','finance'),
    ('marketing.wallboard','TV napi akciók','MonitorPlay','/marketing/wallboard',160,'marketing','marketing'),
    ('settings.vir_admin','VIR adminisztráció','UserCog','/knowledge-base/library?tab=vir',165,'settings','settings'),
    ('settings.menu_layout','Menürendezés','GripVertical','/admin/menu-layout',175,'settings','settings'),
    ('settings.spec_parity','VIR megfelelőségi ellenőrzés','ClipboardCheck','/admin/vir/spec-parity',180,'settings','audit'),
    ('settings.saas','SaaS és franchise központ','Database','/admin/saas',185,'settings','settings')
  ), resolved AS (
    SELECT d.*,p.id parent_id FROM defs d JOIN menus p ON p.code=d.parent_code
  )
  UPDATE menus m SET name=r.name,icon=r.icon,route=r.route,parent_id=r.parent_id,feature_key=r.feature_key,is_active=true
  FROM resolved r WHERE m.code=r.code;

  WITH defs(code,name,icon,route,order_index,parent_code,feature_key) AS (VALUES
    ('finance.receipt_compliance','Nyugta és NAV-adatszolgáltatás','WalletCards','/finance/receipt-compliance',170,'finance','finance'),
    ('marketing.wallboard','TV napi akciók','MonitorPlay','/marketing/wallboard',160,'marketing','marketing'),
    ('settings.vir_admin','VIR adminisztráció','UserCog','/knowledge-base/library?tab=vir',165,'settings','settings'),
    ('settings.menu_layout','Menürendezés','GripVertical','/admin/menu-layout',175,'settings','settings'),
    ('settings.spec_parity','VIR megfelelőségi ellenőrzés','ClipboardCheck','/admin/vir/spec-parity',180,'settings','audit'),
    ('settings.saas','SaaS és franchise központ','Database','/admin/saas',185,'settings','settings')
  )
  INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
  SELECT d.code,d.name,d.icon,d.route,d.order_index,p.id,d.feature_key,true
  FROM defs d JOIN menus p ON p.code=d.parent_code
  WHERE NOT EXISTS(SELECT 1 FROM menus m WHERE m.code=d.code);
 `);
 await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
   SELECT 'admin',m.id,true,true,true,false,false,false,(m.code='finance.receipt_compliance'),true,'all_locations',now()
   FROM menus m WHERE m.code IN('finance.receipt_compliance','marketing.wallboard','settings.vir_admin','settings.menu_layout','settings.spec_parity','settings.saas')
   ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_manage_permissions=true,scope_type='all_locations',updated_at=now()`).catch(()=>undefined);
 await pool.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
   SELECT 'manager',m.id,true,false,true,false,false,false,(m.code='finance.receipt_compliance'),false,'all_locations',now()
   FROM menus m WHERE m.code IN('finance.receipt_compliance','marketing.wallboard','settings.vir_admin','settings.spec_parity')
   ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_edit=true,scope_type='all_locations',updated_at=now()`).catch(()=>undefined);
}

export function ensureMenuLayoutSchema():Promise<void>{
 if(schemaPromise)return schemaPromise;
 schemaPromise=pool.query(`
  CREATE TABLE IF NOT EXISTS menu_layout_overrides(
    menu_id bigint PRIMARY KEY REFERENCES menus(id) ON DELETE CASCADE,
    parent_id bigint NULL,
    order_index integer NOT NULL,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS menu_layout_overrides_parent_idx
    ON menu_layout_overrides(parent_id,order_index,menu_id);
 `).then(ensureMovableAdminItems).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
 return schemaPromise;
}

export async function applyMenuLayoutOverrides():Promise<void>{
 await ensureMenuLayoutSchema();
 await pool.query(`
  UPDATE menus m
  SET parent_id=CASE
      WHEN o.parent_id IS NULL THEN NULL
      WHEN EXISTS(SELECT 1 FROM menus p WHERE p.id=o.parent_id AND COALESCE(p.is_active,true)) THEN o.parent_id
      ELSE m.parent_id
    END,
    order_index=o.order_index
  FROM menu_layout_overrides o
  WHERE o.menu_id=m.id AND COALESCE(m.is_active,true)
 `);
}

export async function saveMenuLayout(items:MenuLayoutItem[],updatedBy?:string|null):Promise<void>{
 await ensureMenuLayoutSchema();
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const ids=items.map(x=>x.id);
  const {rows}=await client.query(`SELECT id,parent_id FROM menus WHERE COALESCE(is_active,true) AND id=ANY($1::bigint[])`,[ids]);
  if(rows.length!==ids.length)throw new Error("A menüelrendezés inaktív vagy nem létező elemet tartalmaz.");
  const activeParents=items.map(x=>x.parent_id).filter((x):x is number=>x!==null);
  if(activeParents.length){
   const parentRows=await client.query(`SELECT id FROM menus WHERE COALESCE(is_active,true) AND id=ANY($1::bigint[])`,[activeParents]);
   if(new Set(parentRows.rows.map(r=>Number(r.id))).size!==new Set(activeParents).size)throw new Error("A cél menücsoport nem létezik vagy inaktív.");
  }
  const current=await client.query(`SELECT id,parent_id FROM menus WHERE COALESCE(is_active,true)`);
  const parentMap=new Map<number,number|null>(current.rows.map(r=>[Number(r.id),r.parent_id==null?null:Number(r.parent_id)]));
  for(const item of items)parentMap.set(item.id,item.parent_id);
  for(const [id] of parentMap){
   const seen=new Set<number>();let cursor:number|null=id;
   while(cursor!==null){if(seen.has(cursor))throw new Error("Körkörös menüstruktúra nem hozható létre.");seen.add(cursor);cursor=parentMap.get(cursor)??null}
  }
  await client.query(`DELETE FROM menu_layout_overrides WHERE menu_id=ANY($1::bigint[])`,[ids]);
  for(const item of items){
   await client.query(`INSERT INTO menu_layout_overrides(menu_id,parent_id,order_index,updated_by,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(menu_id) DO UPDATE SET parent_id=EXCLUDED.parent_id,order_index=EXCLUDED.order_index,updated_by=EXCLUDED.updated_by,updated_at=now()`,[item.id,item.parent_id,item.order_index,updatedBy||null]);
   await client.query(`UPDATE menus SET parent_id=$2,order_index=$3 WHERE id=$1`,[item.id,item.parent_id,item.order_index]);
  }
  await client.query("COMMIT");
 }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}

export async function clearMenuLayoutOverrides():Promise<void>{await ensureMenuLayoutSchema();await pool.query(`DELETE FROM menu_layout_overrides`)}
