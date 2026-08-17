import {Router,Request,Response,NextFunction} from "express";
import pool from "../db";
import {requireAuth} from "../middleware/auth";
import {requireTenantContext,TenantAuthRequest} from "../middleware/tenantContext";
import {assertTenantQuota} from "../services/saasQuota";

const router=Router();
const roleList=(raw:any):string[]=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase());if(p!=null)return[String(p).toLowerCase()]}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const requireAdmin=(req:TenantAuthRequest,res:Response,next:NextFunction)=>{const roles=roleList(req.user?.role);const tenantRole=String(req.tenant?.role||'').toLowerCase();if(!roles.some(r=>['admin','administrator','rendszergazda','superadmin','super_admin'].includes(r))&&!['owner','admin'].includes(tenantRole))return res.status(403).json({error:'Csak adminisztrátor módosíthatja a szalon törzsadatait.'});next()};

// Login előtt szükséges publikus szalonlista. A publikus tenant-resolver külön rétegben szűrhető.
router.get("/public",async(_req:Request,res:Response)=>{try{const result=await pool.query(`SELECT id,name,address,city,phone,email,is_active FROM locations WHERE is_active=true ORDER BY city,name`);return res.json({ok:true,locations:result.rows})}catch(err){console.error("Szalon lekérési hiba (public):",err);return res.status(500).json({ok:false,error:"Nem sikerült lekérni a szalonokat"})}});

router.use(requireAuth,requireTenantContext);

router.get("/",async(req:TenantAuthRequest,res:Response)=>{try{const result=await pool.query(`SELECT id,name,address,city,phone,email,is_active FROM locations WHERE tenant_id=$1::bigint AND is_active=true ORDER BY city,name`,[req.tenant!.id]);return res.json(result.rows)}catch(err){console.error("Szalon lekérési hiba:",err);return res.status(500).json({error:"Nem sikerült lekérni a szalonokat"})}});

router.post("/",requireAdmin,async(req:TenantAuthRequest,res:Response)=>{const{name,address,city,phone,email}=req.body??{};if(!name||!city)return res.status(400).json({error:"Név és város megadása kötelező"});const client=await pool.connect();try{await client.query('BEGIN');await assertTenantQuota(req.tenant!.id,'locations',1,client);const result=await client.query(`INSERT INTO locations(name,address,city,phone,email,is_active,tenant_id) VALUES($1,$2,$3,$4,$5,true,$6::bigint) RETURNING *`,[name,address??null,city,phone??null,email??null,req.tenant!.id]);await client.query('COMMIT');return res.status(201).json(result.rows[0])}catch(err:any){await client.query('ROLLBACK').catch(()=>{});console.error("Szalon hozzáadási hiba:",err);if(err?.code==='SAAS_QUOTA_EXCEEDED')return res.status(409).json({ok:false,code:err.code,error:err.message,quota:err.quota});return res.status(500).json({error:"Nem sikerült hozzáadni a szalont"})}finally{client.release()}});

router.put("/:id",requireAdmin,async(req:TenantAuthRequest,res:Response)=>{const{id}=req.params;const{name,address,city,phone,email,is_active}=req.body??{};try{const result=await pool.query(`UPDATE locations SET name=COALESCE($1,name),address=$2,city=COALESCE($3,city),phone=$4,email=$5,is_active=COALESCE($6,is_active) WHERE id=$7::uuid AND tenant_id=$8::bigint RETURNING *`,[name??null,address??null,city??null,phone??null,email??null,typeof is_active==='boolean'?is_active:null,id,req.tenant!.id]);if(!result.rows.length)return res.status(404).json({error:"Szalon nem található ennél a tenantnál"});return res.json(result.rows[0])}catch(err:any){console.error("Szalon módosítási hiba:",err);if(err?.code==='22P02')return res.status(400).json({error:'Érvénytelen szalonazonosító.'});return res.status(500).json({error:"Nem sikerült módosítani a szalont"})}});

export default router;