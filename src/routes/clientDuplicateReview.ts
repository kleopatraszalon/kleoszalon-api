import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();
const APPROVER_ROLES = new Set(["admin", "administrator", "rendszergazda", "superadmin", "super_admin", "manager", "location_manager", "salon_manager", "szalonvezető", "szalonvezeto", "üzletvezető", "uzletvezeto", "store_manager", "branch_manager"]);
const ADMIN_ROLES = new Set(["admin", "administrator", "rendszergazda", "superadmin", "super_admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let schemaReady: Promise<void> | null = null;

function roles(req: AuthRequest) {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map(v => v.trim().toLowerCase()).filter(Boolean);
  const source = String(raw || "");
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed.map(String).map(v => v.trim().toLowerCase()).filter(Boolean);
  } catch {}
  return source.split(",").map(v => v.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}
function isAdmin(req: AuthRequest) { return roles(req).some(role => ADMIN_ROLES.has(role)); }
function canApprove(req: AuthRequest) { return roles(req).some(role => APPROVER_ROLES.has(role)); }
function actor(req: AuthRequest) { return req.user?.email || String(req.user?.id || "unknown"); }
function scopeLocation(req: AuthRequest) {
  const requested = String(req.query.location_id || req.body?.location_id || "").trim();
  if (isAdmin(req)) return requested || null;
  return req.user?.location_id == null ? null : String(req.user.location_id).trim() || null;
}
function requireScope(req: AuthRequest, res: Response) {
  const locationId = scopeLocation(req);
  if (!isAdmin(req) && !locationId) {
    res.status(403).json({ error: "A CRM duplikáció-kezeléshez telephely-hozzárendelés szükséges." });
    return { ok: false as const, locationId: null };
  }
  return { ok: true as const, locationId };
}
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS crm_duplicate_resolutions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        primary_client_id uuid NOT NULL,
        duplicate_client_id uuid NOT NULL,
        decision text NOT NULL CHECK (decision IN ('merged','dismissed')),
        match_reasons text[] NOT NULL DEFAULT '{}'::text[],
        note text,
        decided_by text,
        location_id uuid,
        primary_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        duplicate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        moved_records jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS crm_duplicate_resolutions_pair_idx
        ON crm_duplicate_resolutions(primary_client_id, duplicate_client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS crm_duplicate_resolutions_location_idx
        ON crm_duplicate_resolutions(location_id, created_at DESC);
    `).then(() => undefined).catch(error => { schemaReady = null; throw error; });
  }
  return schemaReady;
}
async function loadPair(primaryId: string, duplicateId: string) {
  const { rows } = await pool.query(`
    SELECT id::text id,location_id::text location_id,
      COALESCE(NULLIF(full_name,''),NULLIF(name,''),'Névtelen ügyfél') name,
      email,phone,is_active,merged_into_client_id::text,created_at,updated_at,
      COALESCE(altegio_visits,0) visits,COALESCE(altegio_spent,0) spent,to_jsonb(clients) snapshot
    FROM clients WHERE id=ANY($1::uuid[])`, [[primaryId, duplicateId]]);
  return { primary: rows.find((r:any) => r.id === primaryId), duplicate: rows.find((r:any) => r.id === duplicateId) };
}
function matchReasons(a:any,b:any) {
  const reasons:string[]=[];
  const ae=String(a?.email||"").trim().toLowerCase(), be=String(b?.email||"").trim().toLowerCase();
  const ap=String(a?.phone||"").replace(/[^0-9]/g,""), bp=String(b?.phone||"").replace(/[^0-9]/g,"");
  if(ae&&ae===be) reasons.push("email");
  if(ap&&ap===bp) reasons.push("phone");
  return reasons;
}
function validateIds(res:Response, primaryId:string, duplicateId:string) {
  if(!UUID_RE.test(primaryId)||!UUID_RE.test(duplicateId)||primaryId===duplicateId){
    res.status(400).json({error:"Két külön, érvényes ügyfélazonosító szükséges."}); return false;
  }
  return true;
}
function inScope(locationId:string|null,a:any,b:any){return !locationId||(a?.location_id===locationId&&b?.location_id===locationId);}

router.use(requireAuth);
router.use(async (_req,res,next)=>{try{await ensureSchema();next();}catch(error:any){res.status(500).json({error:"A duplikáció-kezelés előkészítése nem sikerült.",detail:error?.message||String(error)});}});

router.get("/duplicate-review", async (req:AuthRequest,res:Response)=>{
  try{
    const scope=requireScope(req,res); if(!scope.ok)return; const locationId=scope.locationId;
    const {rows:pending}=await pool.query(`
      WITH candidates AS (
        SELECT LEAST(a.id::text,b.id::text) pair_a,GREATEST(a.id::text,b.id::text) pair_b,
          (lower(trim(COALESCE(a.email,'')))<>'' AND lower(trim(COALESCE(a.email,'')))=lower(trim(COALESCE(b.email,'')))) email_match,
          (regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')<>'' AND regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')=regexp_replace(COALESCE(b.phone,''),'[^0-9]','','g')) phone_match
        FROM clients a JOIN clients b ON a.id::text<b.id::text
        WHERE COALESCE(a.is_active,true) AND COALESCE(b.is_active,true)
          AND a.merged_into_client_id IS NULL AND b.merged_into_client_id IS NULL
          AND ($1::uuid IS NULL OR (a.location_id=$1::uuid AND b.location_id=$1::uuid))
          AND ((lower(trim(COALESCE(a.email,'')))<>'' AND lower(trim(COALESCE(a.email,'')))=lower(trim(COALESCE(b.email,''))))
            OR (regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')<>'' AND regexp_replace(COALESCE(a.phone,''),'[^0-9]','','g')=regexp_replace(COALESCE(b.phone,''),'[^0-9]','','g')))
      )
      SELECT c.pair_a||':'||c.pair_b pair_key,
        ARRAY_REMOVE(ARRAY[CASE WHEN c.email_match THEN 'email' END,CASE WHEN c.phone_match THEN 'phone' END],NULL) match_reasons,
        json_build_object('id',a.id,'name',COALESCE(NULLIF(a.full_name,''),NULLIF(a.name,''),'Névtelen ügyfél'),'email',a.email,'phone',a.phone,'location_id',a.location_id,'created_at',a.created_at,'updated_at',a.updated_at,'visits',COALESCE(a.altegio_visits,0),'spent',COALESCE(a.altegio_spent,0)) client_a,
        json_build_object('id',b.id,'name',COALESCE(NULLIF(b.full_name,''),NULLIF(b.name,''),'Névtelen ügyfél'),'email',b.email,'phone',b.phone,'location_id',b.location_id,'created_at',b.created_at,'updated_at',b.updated_at,'visits',COALESCE(b.altegio_visits,0),'spent',COALESCE(b.altegio_spent,0)) client_b
      FROM candidates c JOIN clients a ON a.id::text=c.pair_a JOIN clients b ON b.id::text=c.pair_b
      WHERE NOT EXISTS(SELECT 1 FROM crm_duplicate_resolutions r
        WHERE LEAST(r.primary_client_id::text,r.duplicate_client_id::text)=c.pair_a
          AND GREATEST(r.primary_client_id::text,r.duplicate_client_id::text)=c.pair_b)
      ORDER BY GREATEST(a.updated_at,b.updated_at) DESC NULLS LAST LIMIT 500`,[locationId]);
    const {rows:history}=await pool.query(`SELECT id::text,primary_client_id::text,duplicate_client_id::text,decision,match_reasons,note,decided_by,location_id::text,moved_records,created_at,primary_snapshot->>'name' primary_name,duplicate_snapshot->>'name' duplicate_name FROM crm_duplicate_resolutions WHERE ($1::uuid IS NULL OR location_id=$1::uuid) ORDER BY created_at DESC LIMIT 100`,[locationId]);
    res.json({pending,history,can_approve:canApprove(req)});
  }catch(error:any){res.status(500).json({error:"A duplikációs lista betöltése nem sikerült.",detail:error?.message||String(error)});}
});

router.post("/duplicate-review/dismiss",async(req:AuthRequest,res:Response)=>{
  if(!canApprove(req))return res.status(403).json({error:"A duplikációs döntéshez vezetői jogosultság szükséges."});
  const scope=requireScope(req,res);if(!scope.ok)return;
  const primaryId=String(req.body?.primary_client_id||""),duplicateId=String(req.body?.duplicate_client_id||"");
  if(!validateIds(res,primaryId,duplicateId))return;
  try{
    const pair=await loadPair(primaryId,duplicateId);if(!pair.primary||!pair.duplicate)return res.status(404).json({error:"Az egyik ügyfélprofil nem található."});
    if(!inScope(scope.locationId,pair.primary,pair.duplicate))return res.status(403).json({error:"Mindkét ügyfélnek a kezelhető telephelyhez kell tartoznia."});
    const reasons=matchReasons(pair.primary,pair.duplicate);if(!reasons.length)return res.status(409).json({error:"A profilok jelenleg nem egyeznek e-mail vagy telefonszám alapján."});
    const {rows}=await pool.query(`INSERT INTO crm_duplicate_resolutions(primary_client_id,duplicate_client_id,decision,match_reasons,note,decided_by,location_id,primary_snapshot,duplicate_snapshot) VALUES($1::uuid,$2::uuid,'dismissed',$3::text[],$4,$5,$6::uuid,$7::jsonb,$8::jsonb) RETURNING *`,[primaryId,duplicateId,reasons,String(req.body?.note||"").trim()||null,actor(req),pair.primary.location_id||scope.locationId,JSON.stringify({...pair.primary.snapshot,name:pair.primary.name}),JSON.stringify({...pair.duplicate.snapshot,name:pair.duplicate.name})]);
    res.status(201).json({ok:true,resolution:rows[0]});
  }catch(error:any){res.status(500).json({error:"A duplikációs döntés mentése nem sikerült.",detail:error?.message||String(error)});}
});

router.post("/duplicate-review/merged",async(req:AuthRequest,res:Response)=>{
  if(!canApprove(req))return res.status(403).json({error:"Az összevonás naplózásához vezetői jogosultság szükséges."});
  const scope=requireScope(req,res);if(!scope.ok)return;
  const primaryId=String(req.body?.primary_client_id||""),duplicateId=String(req.body?.duplicate_client_id||"");
  if(!validateIds(res,primaryId,duplicateId))return;
  try{
    const pair=await loadPair(primaryId,duplicateId);if(!pair.primary||!pair.duplicate)return res.status(404).json({error:"Az egyik ügyfélprofil nem található."});
    if(!inScope(scope.locationId,pair.primary,pair.duplicate))return res.status(403).json({error:"Mindkét ügyfélnek a kezelhető telephelyhez kell tartoznia."});
    if(pair.duplicate.merged_into_client_id!==primaryId)return res.status(409).json({error:"A kanonikus CRM összevonás még nem történt meg."});
    const audit=(await pool.query(`SELECT moved_counts FROM client_merge_audit WHERE source_client_id=$1::uuid AND target_client_id=$2::uuid ORDER BY merged_at DESC LIMIT 1`,[duplicateId,primaryId])).rows[0];
    const reasons=matchReasons(pair.primary,pair.duplicate);
    const {rows}=await pool.query(`INSERT INTO crm_duplicate_resolutions(primary_client_id,duplicate_client_id,decision,match_reasons,note,decided_by,location_id,primary_snapshot,duplicate_snapshot,moved_records) VALUES($1::uuid,$2::uuid,'merged',$3::text[],$4,$5,$6::uuid,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING *`,[primaryId,duplicateId,reasons,String(req.body?.note||"").trim()||null,actor(req),pair.primary.location_id||scope.locationId,JSON.stringify({...pair.primary.snapshot,name:pair.primary.name}),JSON.stringify({...pair.duplicate.snapshot,name:pair.duplicate.name}),JSON.stringify(audit?.moved_counts||{})]);
    res.status(201).json({ok:true,resolution:rows[0]});
  }catch(error:any){res.status(500).json({error:"Az összevonási audit mentése nem sikerült.",detail:error?.message||String(error)});}
});

export default router;
