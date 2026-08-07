import {Router,Request,Response,NextFunction} from "express";
import pool from "../db";
import {requireAuth,AuthRequest}from"../middleware/auth";
import{ensureHrV2}from"../hr/ensureHrV2";

const router=Router();
router.use(requireAuth);
const asyncRoute=(fn:(req:any,res:Response)=>Promise<any>)=>(req:Request,res:Response,next:NextFunction)=>fn(req,res).catch(next);

const FEATURE_DEFINITIONS=[
  {feature_key:"finance",name:"Pénzügy és pénztár",description:"Pénzügyi lezárás, kassza, fizetések és napi zárás"},
  {feature_key:"hr",name:"HR adatok",description:"Munkatársak, szerződések, bérezés és HR nyilvántartások"},
  {feature_key:"ai_use",name:"AI Segítő használata",description:"Kleo AI Segítő kérdezése"},
  {feature_key:"ai_stats",name:"AI statisztika",description:"AI használati és költségstatisztika megtekintése"},
  {feature_key:"staff_chat",name:"Munkatársi chat",description:"Saját belső beszélgetések használata"},
  {feature_key:"staff_chat_all",name:"Teljes chat felügyelet",description:"Adminisztratív rálátás minden munkatársi beszélgetésre"},
  {feature_key:"inventory",name:"Raktár és készlet",description:"Készlet, mozgások és készletérték kezelése"},
  {feature_key:"management_dashboard",name:"Vezetői dashboard",description:"Vezetői KPI-k, bevétel és teljesítménymutatók"},
  {feature_key:"audit",name:"Audit napló",description:"Rendszer- és üzleti eseménynapló megtekintése"},
];

function rolesOf(req:AuthRequest){const raw:any=req.user?.role;if(Array.isArray(raw))return raw.map(String);try{const p=JSON.parse(String(raw||""));return Array.isArray(p)?p.map(String):[String(p)]}catch{return String(raw||"").split(",").map(x=>x.replace(/[\[\]"]/g,"").trim()).filter(Boolean)}}
function adminOnly(req:AuthRequest,res:Response,next:NextFunction){if(rolesOf(req).map(x=>x.toLowerCase()).includes("admin"))return next();return res.status(403).json({error:"Ehhez a művelethez rendszergazdai jogosultság szükséges."})}

router.get("/me/features",asyncRoute(async(req:AuthRequest,res)=>{
  await ensureHrV2();
  const roles=rolesOf(req).map(x=>x.toLowerCase());
  if(roles.includes("admin")) return res.json({admin:true,features:FEATURE_DEFINITIONS.map(f=>({...f,can_use:true,scope_type:"all_locations"}))});
  const {rows}=await pool.query(`SELECT role_key,feature_key,can_use,scope_type FROM role_feature_permissions WHERE role_key = ANY($1::text[])`,[roles]);
  const byFeature=new Map<string,any>();
  for(const row of rows){if(row.can_use)byFeature.set(row.feature_key,row)}
  res.json({admin:false,features:FEATURE_DEFINITIONS.map(f=>({...f,can_use:Boolean(byFeature.get(f.feature_key)?.can_use),scope_type:byFeature.get(f.feature_key)?.scope_type||"own_location"}))});
}));

router.use(adminOnly);
router.get("/roles",asyncRoute(async(_req,res)=>{await ensureHrV2();const{rows}=await pool.query("SELECT * FROM access_roles ORDER BY level DESC,name");res.json(rows)}));
router.post("/roles",asyncRoute(async(req,res)=>{await ensureHrV2();const b=req.body||{};if(!b.role_key||!b.name)return res.status(400).json({error:"A szerepkör kulcsa és neve kötelező."});const{rows}=await pool.query(`INSERT INTO access_roles(role_key,name,description,level,is_active) VALUES(lower($1),$2,$3,COALESCE($4,10),COALESCE($5,true)) RETURNING *`,[b.role_key,b.name,b.description||null,b.level,b.is_active]);res.status(201).json(rows[0])}));
router.patch("/roles/:id",asyncRoute(async(req,res)=>{await ensureHrV2();const b=req.body||{};const{rows}=await pool.query(`UPDATE access_roles SET name=COALESCE($2,name),description=$3,level=COALESCE($4,level),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,b.name||null,b.description||null,b.level,b.is_active]);res.json(rows[0])}));
router.get("/matrix",asyncRoute(async(_req,res)=>{await ensureHrV2();const[roles,menus,permissions,featurePermissions]=await Promise.all([pool.query("SELECT * FROM access_roles WHERE is_active ORDER BY level DESC,name"),pool.query(`SELECT id,code,name,parent_id,route,order_index,feature_key FROM menus WHERE COALESCE(is_active,true) ORDER BY COALESCE(parent_id,0),order_index,id`),pool.query("SELECT * FROM role_menu_permissions"),pool.query("SELECT * FROM role_feature_permissions")]);res.json({roles:roles.rows,menus:menus.rows,permissions:permissions.rows,features:FEATURE_DEFINITIONS,feature_permissions:featurePermissions.rows})}));
router.put("/roles/:roleKey/permissions",asyncRoute(async(req,res)=>{await ensureHrV2();const roleKey=String(req.params.roleKey).toLowerCase();if(roleKey==="admin")return res.status(400).json({error:"A rendszergazdai teljes hozzáférés nem korlátozható."});const updates=Array.isArray(req.body)?req.body:[];const client=await pool.connect();try{await client.query("BEGIN");for(const p of updates)await client.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'own_location'),now()) ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=EXCLUDED.can_delete,can_approve=EXCLUDED.can_approve,can_export=EXCLUDED.can_export,can_view_financial=EXCLUDED.can_view_financial,can_manage_permissions=EXCLUDED.can_manage_permissions,scope_type=EXCLUDED.scope_type,updated_at=now()`,[roleKey,p.menu_id,!!p.can_view,!!p.can_create,!!p.can_edit,!!p.can_delete,!!p.can_approve,!!p.can_export,!!p.can_view_financial,!!p.can_manage_permissions,p.scope_type||"own_location"]);await client.query("COMMIT");res.json({success:true})}catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}}));
router.put("/roles/:roleKey/features",asyncRoute(async(req,res)=>{
  const roleKey=String(req.params.roleKey).toLowerCase();
  if(roleKey==="admin")return res.status(400).json({error:"A rendszergazdai teljes hozzáférés nem korlátozható."});
  const updates=Array.isArray(req.body)?req.body:[];
  const allowed=new Set(FEATURE_DEFINITIONS.map(x=>x.feature_key));
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const p of updates){
      const key=String(p.feature_key||"");
      if(!allowed.has(key))continue;
      await client.query(`INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
        VALUES($1,$2,$3,$4,now())
        ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=EXCLUDED.can_use,scope_type=EXCLUDED.scope_type,updated_at=now()`,[roleKey,key,!!p.can_use,p.scope_type||"own_location"]);
    }
    await client.query("COMMIT");
    res.json({success:true});
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}));

export default router;
