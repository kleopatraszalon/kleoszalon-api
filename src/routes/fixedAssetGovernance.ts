import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";

const router=Router();
const APPROVER_ROLES=new Set(["accounting","bookkeeper","konyveles","könyvelés","admin","administrator","rendszergazda","superadmin","super_admin"]);

function roles(raw:any):string[]{
  if(Array.isArray(raw))return raw.map(String).map(v=>v.toLowerCase());
  const text=String(raw??"");
  try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(v=>v.toLowerCase())}catch{}
  return text.split(",").map(v=>v.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean);
}
function canApprove(req:any){return roles(req.user?.role).some(r=>APPROVER_ROLES.has(r));}
function actor(req:any){return String(req.user?.email||req.user?.id||"system");}
function selectedLocation(req:any){const v=req.query?.location_id??req.body?.location_id;return v==null||String(v).trim()===""?null:String(v).trim();}
function fail(res:any,status:number,message:string,code:string){return res.status(status).json({ok:false,message,code});}

router.use(requireAuth);

router.get("/governance/readiness",async(req:any,res,next)=>{try{
  const loc=selectedLocation(req);const p:any[]=[];let assetWhere=`WHERE a.active=true AND a.status NOT IN('disposed','sold','scrapped')`;
  if(loc){p.push(loc);assetWhere+=` AND a.location_id=$${p.length}`}
  const [gl,assets]=await Promise.all([
    db.query(`SELECT code,name,account_type,external_account_code,mapping_status,mapping_approved_by,mapping_approved_at,mapping_note
      FROM gl_accounts WHERE code LIKE 'FA-%' ORDER BY code`),
    db.query(`SELECT a.id,a.asset_code,a.name,a.location_id,a.status,a.commissioned_at,a.capitalized_cost,a.useful_life_months,a.residual_value,
      a.depreciation_method,a.book_annual_rate,a.tax_depreciation_rate,a.tax_classification,a.depreciation_policy_status,
      a.depreciation_policy_approved_by,a.depreciation_policy_approved_at,a.policy_review_reason,a.source_master_equipment_id,
      EXISTS(SELECT 1 FROM fixed_asset_maintenance_plans mp WHERE mp.asset_id=a.id AND mp.active=true) has_maintenance_plan,
      EXISTS(SELECT 1 FROM fixed_asset_maintenance_plans mp WHERE mp.asset_id=a.id AND mp.active=true
        AND COALESCE(mp.frequency_value,0)>0 AND mp.next_due_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(mp.manufacturer_reference,'')),'') IS NOT NULL
        AND lower(mp.manufacturer_reference) NOT LIKE 'migrált%' AND lower(mp.manufacturer_reference) NOT LIKE 'migralt%'
        AND CASE WHEN jsonb_typeof(mp.checklist)='array' THEN jsonb_array_length(mp.checklist) ELSE 0 END>0) maintenance_source_approved_ready,
      (SELECT MIN(mp.next_due_at) FROM fixed_asset_maintenance_plans mp WHERE mp.asset_id=a.id AND mp.active=true) next_maintenance_at
      FROM fixed_assets a ${assetWhere} ORDER BY a.asset_code,a.name`,p)
  ]);
  const mapped=gl.rows.filter((x:any)=>x.mapping_status==='approved'&&String(x.external_account_code||'').trim()).length;
  const review=assets.rows.filter((a:any)=>a.depreciation_policy_status!=='approved');
  const maintenanceMissing=assets.rows.filter((a:any)=>!a.maintenance_source_approved_ready);
  const taoMissing=assets.rows.filter((a:any)=>!String(a.tax_classification||'').trim()||a.tax_depreciation_rate==null);
  const lifeMissing=assets.rows.filter((a:any)=>Number(a.useful_life_months||0)<=0);
  res.json({
    ok:true,
    chart_of_accounts:{total:gl.rows.length,mapped,unmapped:gl.rows.length-mapped,ready:gl.rows.length>0&&mapped===gl.rows.length,rows:gl.rows},
    assets:{total:assets.rows.length,approved:assets.rows.length-review.length,needs_review:review.length,maintenance_source_missing:maintenanceMissing.length,tao_missing:taoMissing.length,useful_life_missing:lifeMissing.length,rows:assets.rows},
    posting_ready:gl.rows.length>0&&mapped===gl.rows.length&&review.length===0&&maintenanceMissing.length===0,
    generated_at:new Date().toISOString()
  });
}catch(error){next(error)}});

router.post("/governance/assets/:id/approve",async(req:any,res,next)=>{try{
  if(!canApprove(req))return fail(res,403,"Az eszköz számviteli/TAO politikáját csak a Könyvelés vagy rendszergazda hagyhatja jóvá.","fixed_asset_approval_forbidden");
  const loc=selectedLocation(req);const params:any[]=[req.params.id];let where=`id=$1::uuid AND active=true`;
  if(loc){params.push(loc);where+=` AND location_id=$2`}
  const current=(await db.query(`SELECT * FROM fixed_assets WHERE ${where} LIMIT 1`,params)).rows[0];
  if(!current)return fail(res,404,"A tárgyi eszköz nem található.","asset_not_found");
  const updated=(await db.query(`UPDATE fixed_assets SET depreciation_policy_status='approved',updated_by=$2,updated_at=now() WHERE id=$1::uuid RETURNING *`,[current.id,actor(req)])).rows[0];
  await db.query(`INSERT INTO fixed_asset_events(asset_id,event_type,actor,data) VALUES($1::uuid,'accounting_policy_approved',$2,$3::jsonb)`,[current.id,actor(req),JSON.stringify({useful_life_months:updated.useful_life_months,residual_value:updated.residual_value,tax_classification:updated.tax_classification,tax_depreciation_rate:updated.tax_depreciation_rate})]);
  res.json({ok:true,asset:updated});
}catch(error:any){
  if(error?.code==='23514'||error?.code==='42501')return fail(res,409,error.message,"fixed_asset_policy_incomplete");
  next(error)
}});

router.post("/governance/assets/:id/revoke",async(req:any,res,next)=>{try{
  if(!canApprove(req))return fail(res,403,"A jóváhagyást csak a Könyvelés vagy rendszergazda vonhatja vissza.","fixed_asset_approval_forbidden");
  const row=(await db.query(`UPDATE fixed_assets SET depreciation_policy_status='needs_review',depreciation_policy_approved_by=NULL,depreciation_policy_approved_at=NULL,policy_review_reason=$2,updated_by=$3,updated_at=now() WHERE id=$1::uuid AND active=true RETURNING *`,[req.params.id,String(req.body?.reason||"Könyvelői felülvizsgálat szükséges."),actor(req)])).rows[0];
  if(!row)return fail(res,404,"A tárgyi eszköz nem található.","asset_not_found");
  await db.query(`INSERT INTO fixed_asset_events(asset_id,event_type,actor,data) VALUES($1::uuid,'accounting_policy_revoked',$2,$3::jsonb)`,[row.id,actor(req),JSON.stringify({reason:row.policy_review_reason})]);
  res.json({ok:true,asset:row});
}catch(error){next(error)}});

router.put("/governance/chart/:code",async(req:any,res,next)=>{try{
  if(!canApprove(req))return fail(res,403,"A Kleoszalon számlatükör-leképezését csak a Könyvelés vagy rendszergazda módosíthatja.","chart_mapping_forbidden");
  const code=String(req.params.code||"").trim();const external=String(req.body?.external_account_code||"").trim();
  if(!code)return fail(res,400,"A belső főkönyvi kód kötelező.","chart_code_missing");
  if(!external)return fail(res,400,"A tényleges Kleoszalon főkönyvi számlaszám kötelező.","external_account_missing");
  const row=(await db.query(`UPDATE gl_accounts SET external_account_code=$2,mapping_note=$3,mapping_approved_by=$4,updated_at=now() WHERE code=$1 AND active=true RETURNING *`,[code,external,req.body?.mapping_note||null,actor(req)])).rows[0];
  if(!row)return fail(res,404,"A belső főkönyvi számla nem található.","gl_account_not_found");
  res.json({ok:true,account:row});
}catch(error){next(error)}});

router.get("/governance/gl-export",async(req:any,res,next)=>{try{
  if(!canApprove(req))return fail(res,403,"A főkönyvi export csak a Könyvelés vagy rendszergazda számára elérhető.","gl_export_forbidden");
  const loc=selectedLocation(req),from=String(req.query.from||""),to=String(req.query.to||"");const p:any[]=[];let where=`WHERE 1=1`;
  if(loc){p.push(loc);where+=` AND location_id=$${p.length}`}
  if(from){p.push(from);where+=` AND entry_date>=$${p.length}::date`}
  if(to){p.push(to);where+=` AND entry_date<=$${p.length}::date`}
  res.json((await db.query(`SELECT * FROM fixed_asset_gl_export_v ${where} ORDER BY entry_date,journal_no,line_no LIMIT 5000`,p)).rows);
}catch(error){next(error)}});

export default router;
