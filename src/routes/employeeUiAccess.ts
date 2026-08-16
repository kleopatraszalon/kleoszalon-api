import {Router,Response,NextFunction} from 'express';
import pool from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {parseRoleKeys} from '../security/roles';

const router=Router();
router.use(requireAuth);

const ITEMS=[
 {key:'appointments',name:'Időpontnaptár',description:'Naptár, foglalások és érkeztetés',route:'/appointments/calendar',permission:'appointments'},
 {key:'workorders',name:'Munkalapok',description:'Szolgáltatási munkalapok kezelése',route:'/workorders',permission:'workorders'},
 {key:'product_sale',name:'Termékeladás',description:'Termék értékesítése szolgáltatási munkalap nélkül',route:'/finance/product-sale',permission:'product_sale'},
 {key:'clients',name:'Vendégek / CRM',description:'Vendégadatok, címkék és előzmények',route:'/modules/customers/clients',permission:'clients'},
 {key:'cashier',name:'Pénztár',description:'Fizetések és pénztári műveletek',route:'/finance/cashier',permission:'cashier'},
 {key:'staff_chat',name:'Munkatársi chat',description:'Belső kommunikáció',route:'/staff/chat',permission:'staff_chat'},
 {key:'inventory',name:'Raktár és készlet',description:'Készlet és raktári műveletek',route:'/warehouse',permission:'inventory'},
 {key:'finance',name:'Pénzügyek',description:'Pénzügyi központ és kimutatások',route:'/finance',permission:'finance'},
 {key:'reports',name:'Riportok',description:'Vezetői és üzleti riportok',route:'/reports/top-metrics',permission:'reports'},
 {key:'hr',name:'Munkatársak / HR',description:'HR és munkatársi adatok',route:'/employees',permission:'hr'},
 {key:'checklists',name:'Checklisták',description:'Napi és munkaköri ellenőrzőlisták',route:'/knowledge-base/checklists',permission:'checklists'}
] as const;
const PERMISSIONS=ITEMS.map(x=>({key:x.permission,name:x.name,description:x.description}));

function roles(req:AuthRequest){return parseRoleKeys(req.user?.role)}
function isAdmin(req:AuthRequest){return roles(req).includes('admin')}
function adminOnly(req:AuthRequest,res:Response,next:NextFunction){if(isAdmin(req))return next();return res.status(403).json({message:'Ehhez a beállításhoz rendszergazdai jogosultság szükséges.'})}
function defaultPermission(roleKeys:string[],key:string){
 if(roleKeys.includes('admin'))return true;
 const receptionist=roleKeys.some(r=>['receptionist','reception','recepciós','recepcios'].includes(r));
 const management=roleKeys.some(r=>['manager','location_manager','salon_manager','szalonvezető','szalonvezeto','üzletvezető','uzletvezeto'].includes(r));
 const employee=roleKeys.some(r=>['employee','staff','munkatárs','munkatars','professional','specialist'].includes(r));
 if(receptionist)return ['appointments','workorders','product_sale','clients','cashier','staff_chat','checklists'].includes(key);
 if(management)return true;
 if(employee)return ['appointments','workorders','staff_chat','checklists'].includes(key);
 return false;
}
async function ensureSchema(){await pool.query(`
 CREATE TABLE IF NOT EXISTS employee_ui_permissions(
  employee_id text NOT NULL, permission_key text NOT NULL, can_use boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
  PRIMARY KEY(employee_id,permission_key)
 );
 CREATE TABLE IF NOT EXISTS employee_home_items(
  employee_id text NOT NULL, item_key text NOT NULL, is_visible boolean NOT NULL,
  sort_order integer NOT NULL DEFAULT 100, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
  PRIMARY KEY(employee_id,item_key)
 );
`)}
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
async function employeeRow(id:string){
 const q=await pool.query(`SELECT e.id::text id,COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),NULLIF(to_jsonb(e)->>'email',''),'Munkatárs') name,to_jsonb(e)->>'email' email,to_jsonb(e)->>'role' role,to_jsonb(e)->>'location_id' location_id,COALESCE(l.name,'') location_name FROM employees e LEFT JOIN locations l ON l.id::text=(to_jsonb(e)->>'location_id') WHERE e.id::text=$1 LIMIT 1`,[id]);
 return q.rows[0]||null;
}
function parseEmployeeRoles(raw:any){try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)}
async function profileFor(id:string,roleKeys:string[]){
 await ensureSchema();
 const [pr,hr]=await Promise.all([
  pool.query(`SELECT permission_key,can_use FROM employee_ui_permissions WHERE employee_id=$1`,[id]),
  pool.query(`SELECT item_key,is_visible,sort_order FROM employee_home_items WHERE employee_id=$1`,[id])
 ]);
 const pMap=new Map(pr.rows.map((x:any)=>[String(x.permission_key),Boolean(x.can_use)]));
 const hMap=new Map(hr.rows.map((x:any)=>[String(x.item_key),x]));
 const permissions=PERMISSIONS.map(p=>({...p,can_use:pMap.has(p.key)?Boolean(pMap.get(p.key)):defaultPermission(roleKeys,p.key),overridden:pMap.has(p.key)}));
 const permissionMap=new Map(permissions.map(p=>[p.key,p.can_use]));
 const items=ITEMS.map((x,index)=>{const o=hMap.get(x.key);const allowed=Boolean(permissionMap.get(x.permission));return {...x,is_visible:o?Boolean(o.is_visible)&&allowed:defaultPermission(roleKeys,x.permission)&&allowed,sort_order:o?Number(o.sort_order):index*10,overridden:Boolean(o)}}).sort((a,b)=>a.sort_order-b.sort_order);
 return{permissions,items};
}

router.get('/me',async(req:AuthRequest,res,next)=>{try{const id=String(req.user?.id||'');if(!id)return res.status(401).json({message:'Nincs bejelentkezett munkatárs.'});const row=await employeeRow(id);const roleKeys=row?parseEmployeeRoles(row.role):roles(req);res.json({employee:row||{id,role:req.user?.role},...(await profileFor(id,roleKeys))})}catch(e){next(e)}});
router.use(adminOnly);
router.get('/employees',async(_req,res,next)=>{try{await ensureSchema();const q=await pool.query(`SELECT e.id::text id,COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),NULLIF(to_jsonb(e)->>'email',''),'Munkatárs') name,to_jsonb(e)->>'email' email,to_jsonb(e)->>'role' role,to_jsonb(e)->>'location_id' location_id,COALESCE(l.name,'') location_name FROM employees e LEFT JOIN locations l ON l.id::text=(to_jsonb(e)->>'location_id') WHERE COALESCE((to_jsonb(e)->>'active')::boolean,true)=true ORDER BY lower(COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'')) LIMIT 5000`);res.json({employees:q.rows,items:ITEMS,permissions:PERMISSIONS})}catch(e){next(e)}});
router.get('/employees/:id',async(req,res,next)=>{try{const row=await employeeRow(req.params.id);if(!row)return res.status(404).json({message:'A munkatárs nem található.'});res.json({employee:row,...(await profileFor(String(row.id),parseEmployeeRoles(row.role)))})}catch(e){next(e)}});
router.put('/employees/:id',async(req:AuthRequest,res,next)=>{const c=await pool.connect();try{await ensureSchema();const row=await employeeRow(req.params.id);if(!row)return res.status(404).json({message:'A munkatárs nem található.'});const permissions=Array.isArray(req.body?.permissions)?req.body.permissions:[];const items=Array.isArray(req.body?.items)?req.body.items:[];const allowedP=new Set(PERMISSIONS.map(x=>x.key)),allowedI=new Set(ITEMS.map(x=>x.key));await c.query('BEGIN');await c.query(`DELETE FROM employee_ui_permissions WHERE employee_id=$1`,[req.params.id]);for(const p of permissions){const key=String(p?.key||p?.permission_key||'');if(!allowedP.has(key as any))continue;await c.query(`INSERT INTO employee_ui_permissions(employee_id,permission_key,can_use,updated_by) VALUES($1,$2,$3,$4)`,[req.params.id,key,Boolean(p.can_use),actor(req)])}await c.query(`DELETE FROM employee_home_items WHERE employee_id=$1`,[req.params.id]);for(let i=0;i<items.length;i++){const x=items[i],key=String(x?.key||x?.item_key||'');if(!allowedI.has(key as any))continue;await c.query(`INSERT INTO employee_home_items(employee_id,item_key,is_visible,sort_order,updated_by) VALUES($1,$2,$3,$4,$5)`,[req.params.id,key,Boolean(x.is_visible),Number.isFinite(Number(x.sort_order))?Number(x.sort_order):i*10,actor(req)])}await c.query('COMMIT');res.json({ok:true,employee:row,...(await profileFor(req.params.id,parseEmployeeRoles(row.role)))})}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

export default router;
