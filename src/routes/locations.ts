import {Router,Request,Response,NextFunction} from "express";
import pool from "../db";
import {requireAuth,AuthRequest} from "../middleware/auth";

const router=Router();
const roleList=(raw:any):string[]=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase());if(p!=null)return[String(p).toLowerCase()]}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const requireAdmin=(req:AuthRequest,res:Response,next:NextFunction)=>{const roles=roleList(req.user?.role);if(!roles.some(r=>['admin','administrator','rendszergazda','superadmin','super_admin'].includes(r)))return res.status(403).json({error:'Csak adminisztrátor módosíthatja a szalon törzsadatait.'});next()};

// Login előtt szükséges publikus szalonlista.
router.get("/public",async(_req:Request,res:Response)=>{try{const result=await pool.query(`SELECT id,name,address,city,phone,email,is_active FROM locations WHERE is_active=true ORDER BY city,name`);return res.json({ok:true,locations:result.rows})}catch(err){console.error("Szalon lekérési hiba (public):",err);return res.status(500).json({ok:false,error:"Nem sikerült lekérni a szalonokat"})}});

// Innen minden végpont belépést igényel.
router.use(requireAuth);

router.get("/",async(_req:AuthRequest,res:Response)=>{try{const result=await pool.query(`SELECT id,name,address,city,phone,email,is_active FROM locations WHERE is_active=true ORDER BY city,name`);return res.json(result.rows)}catch(err){console.error("Szalon lekérési hiba:",err);return res.status(500).json({error:"Nem sikerült lekérni a szalonokat"})}});

router.post("/",requireAdmin,async(req:AuthRequest,res:Response)=>{const{name,address,city,phone,email}=req.body??{};if(!name||!city)return res.status(400).json({error:"Név és város megadása kötelező"});try{const result=await pool.query(`INSERT INTO locations(name,address,city,phone,email,is_active) VALUES($1,$2,$3,$4,$5,true) RETURNING *`,[name,address??null,city,phone??null,email??null]);return res.status(201).json(result.rows[0])}catch(err){console.error("Szalon hozzáadási hiba:",err);return res.status(500).json({error:"Nem sikerült hozzáadni a szalont"})}});

router.put("/:id",requireAdmin,async(req:AuthRequest,res:Response)=>{const{id}=req.params;const{name,address,city,phone,email,is_active}=req.body??{};try{const result=await pool.query(`UPDATE locations SET name=COALESCE($1,name),address=$2,city=COALESCE($3,city),phone=$4,email=$5,is_active=COALESCE($6,is_active) WHERE id=$7::uuid RETURNING *`,[name??null,address??null,city??null,phone??null,email??null,typeof is_active==='boolean'?is_active:null,id]);if(!result.rows.length)return res.status(404).json({error:"Szalon nem található"});return res.json(result.rows[0])}catch(err:any){console.error("Szalon módosítási hiba:",err);if(err?.code==='22P02')return res.status(400).json({error:'Érvénytelen szalonazonosító.'});return res.status(500).json({error:"Nem sikerült módosítani a szalont"})}});

export default router;
