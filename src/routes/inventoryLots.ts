import { Router } from "express";
import db from "../db";
import { hasAnyRole } from "../security/roles";
import { ensureInventoryLotSchema } from "../inventory/ensureInventoryLotSchema";
import { listInventoryLotBalances } from "../inventory/inventoryLotService";
import { postWarehouseIssue, postWarehouseReceipt, resolveInventoryWarehouse } from "../inventory/inventoryLedgerService";

const router=Router();
const num=(v:any)=>Number(v||0);
const actor=(req:any)=>req.user?.email||String(req.user?.id||"system");
const isGlobal=(req:any)=>hasAnyRole(req.user?.role,["admin","manager"]);
const canOperate=(req:any)=>hasAnyRole(req.user?.role,["admin","manager","location_manager","salon_manager","receptionist"]);
const canConfigure=(req:any)=>hasAnyRole(req.user?.role,["admin","manager","location_manager"]);
const ownLocation=(req:any)=>req.user?.location_id==null?null:String(req.user.location_id);

function fail(status:number,message:string,code?:string):never{const e:any=new Error(message);e.status=status;e.code=code;e.publicCode=code;throw e}
function sendError(err:any,res:any,next:any){if(err?.status)return res.status(Number(err.status)).json({message:String(err.message||err),code:err.code||err.publicCode});return next(err)}
function ensureScope(req:any,warehouse:any){if(isGlobal(req))return;const own=ownLocation(req),loc=warehouse.location_id==null?null:String(warehouse.location_id);if(!own||loc!==own)fail(403,"Ehhez a raktárhoz nincs jogosultsága.","inventory_warehouse_forbidden")}

router.use(async(_req,_res,next)=>{try{await ensureInventoryLotSchema();next()}catch(e){next(e)}});

router.get('/lots/products',async(req:any,res,next)=>{try{
  const {rows}=await db.query(`SELECT p.id::text,p.name,p.internal_code,p.barcode,p.brand,
    COALESCE(p.lot_tracking_enabled,false) lot_tracking_enabled,
    COALESCE(p.expiry_tracking_enabled,false) expiry_tracking_enabled,
    COALESCE(p.fefo_enabled,false) fefo_enabled
    FROM products p WHERE COALESCE(p.is_active,true)=true ORDER BY p.name`);
  res.json(rows);
}catch(e){next(e)}});

router.get('/lots',async(req:any,res,next)=>{try{
  let locationId=String(req.query.location_id||'').trim()||null;
  if(!isGlobal(req))locationId=ownLocation(req);
  if(!isGlobal(req)&&!locationId)return res.json([]);
  const rows=await listInventoryLotBalances(db,{
    warehouseId:String(req.query.warehouse_id||'').trim()||null,
    productId:String(req.query.product_id||'').trim()||null,
    locationId,
    status:String(req.query.status||'').trim()||null,
  });
  res.json(rows);
}catch(e){sendError(e,res,next)}});

router.get('/lots/summary',async(req:any,res,next)=>{try{
  let locationId=String(req.query.location_id||'').trim()||null;
  if(!isGlobal(req))locationId=ownLocation(req);
  const params:any[]=[];const where=[`lb.quantity>0`];
  if(locationId){params.push(locationId);where.push(`w.location_id=$${params.length}::text`)}
  const {rows}=await db.query(`SELECT
    COUNT(*)::int AS lot_count,
    COUNT(*) FILTER(WHERE l.expires_at<CURRENT_DATE)::int AS expired_lots,
    COUNT(*) FILTER(WHERE l.expires_at>=CURRENT_DATE AND l.expires_at<=CURRENT_DATE+30)::int AS expiring_lots,
    COALESCE(SUM(lb.quantity) FILTER(WHERE l.expires_at<CURRENT_DATE),0)::numeric AS expired_quantity,
    COALESCE(SUM(lb.quantity) FILTER(WHERE l.expires_at>=CURRENT_DATE AND l.expires_at<=CURRENT_DATE+30),0)::numeric AS expiring_quantity
    FROM inventory_warehouse_lot_balances lb JOIN inventory_lots l ON l.id=lb.lot_id JOIN inventory_warehouses w ON w.id=lb.warehouse_id
    WHERE ${where.join(' AND ')}`,params);
  res.json(rows[0]||{});
}catch(e){next(e)}});

router.patch('/catalog/products/:id/tracking',async(req:any,res,next)=>{try{
  if(!canConfigure(req))return res.status(403).json({message:'Nincs jogosultsága a sarzskövetés beállításához.'});
  const lot=Boolean(req.body?.lot_tracking_enabled);
  const expiry=Boolean(req.body?.expiry_tracking_enabled);
  const fefo=Boolean(req.body?.fefo_enabled);
  if((expiry||fefo)&&!lot)return res.status(400).json({message:'Lejárat- vagy FEFO-kezelés csak bekapcsolt sarzskövetés mellett használható.'});
  const {rows}=await db.query(`UPDATE products SET lot_tracking_enabled=$2,expiry_tracking_enabled=$3,fefo_enabled=$4,updated_at=now() WHERE id=$1::uuid RETURNING id::text,name,lot_tracking_enabled,expiry_tracking_enabled,fefo_enabled`,[req.params.id,lot,expiry,fefo]);
  if(!rows[0])return res.status(404).json({message:'A termék nem található.'});
  res.json(rows[0]);
}catch(e){next(e)}});

router.post('/lots/receive',async(req:any,res,next)=>{const c=await db.connect();try{
  if(!canOperate(req))return res.status(403).json({message:'Nincs jogosultsága készlet bevételezéséhez.'});
  await c.query('BEGIN');
  const productId=String(req.body?.product_id||'');const quantity=num(req.body?.quantity);if(!productId||!(quantity>0))fail(400,'Termék és pozitív mennyiség szükséges.');
  const locationId=req.body?.location_id==null?ownLocation(req):String(req.body.location_id||'')||null;
  const warehouse=await resolveInventoryWarehouse(c,{locationId,productId,warehouseId:req.body?.warehouse_id||null});ensureScope(req,warehouse);
  const posted=await postWarehouseReceipt(c,{warehouse,productId,quantity,incomingUnitCost:num(req.body?.unit_cost),movementType:'receipt',lot:{lotCode:req.body?.lot_code,manufacturedAt:req.body?.manufactured_at,expiresAt:req.body?.expires_at,supplierId:req.body?.supplier_id||null,sourceRecordType:'manual_receipt',sourceRecordId:req.body?.document_number||null,note:req.body?.note||null,createdBy:actor(req),allowExpired:Boolean(req.body?.allow_expired)},meta:{supplierId:req.body?.supplier_id||null,documentNumber:req.body?.document_number||null,counterpartyName:req.body?.counterparty_name||null,note:req.body?.note||null,createdBy:actor(req)}});
  await c.query('COMMIT');res.status(201).json({ok:true,...posted});
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);sendError(e,res,next)}finally{c.release()}});

router.post('/lots/issue',async(req:any,res,next)=>{const c=await db.connect();try{
  if(!canOperate(req))return res.status(403).json({message:'Nincs jogosultsága készlet kiadásához.'});
  await c.query('BEGIN');
  const productId=String(req.body?.product_id||'');const quantity=num(req.body?.quantity);if(!productId||!(quantity>0))fail(400,'Termék és pozitív mennyiség szükséges.');
  const locationId=req.body?.location_id==null?ownLocation(req):String(req.body.location_id||'')||null;
  const warehouse=await resolveInventoryWarehouse(c,{locationId,productId,warehouseId:req.body?.warehouse_id||null,requiredQuantity:quantity});ensureScope(req,warehouse);
  const movementType=String(req.body?.movement_type||'writeoff');
  const posted=await postWarehouseIssue(c,{warehouse,productId,quantity,movementType,specificLotId:req.body?.lot_id||null,allowExpiredLot:Boolean(req.body?.allow_expired_lot),meta:{documentNumber:req.body?.document_number||null,counterpartyName:req.body?.counterparty_name||null,note:req.body?.note||null,createdBy:actor(req)}});
  await c.query('COMMIT');res.status(201).json({ok:true,...posted});
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);sendError(e,res,next)}finally{c.release()}});

// Intercepts the canonical manual operation endpoint for lot-tracked products.
// Untracked operations continue in inventoryOperationsRouter via next().
router.post('/operations',async(req:any,res,next)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  if(!items.length)return next();
  try{
    const ids=items.map((x:any)=>String(x?.product_id||'')).filter(Boolean);
    if(!ids.length)return next();
    const tracked=await db.query(`SELECT id::text,COALESCE(lot_tracking_enabled,false) lot_tracking_enabled FROM products WHERE id=ANY($1::uuid[])`,[ids]);
    const map=new Map(tracked.rows.map((r:any)=>[String(r.id),Boolean(r.lot_tracking_enabled)]));
    const flags=ids.map((id:string)=>Boolean(map.get(id)));
    if(!flags.some(Boolean))return next();
    if(flags.some(Boolean)&&flags.some((x:boolean)=>!x))return res.status(409).json({message:'Sarzskövetett és nem sarzskövetett termékeket külön készletműveletben kell rögzíteni.',code:'INVENTORY_MIXED_LOT_OPERATION'});
  }catch(e){return next(e)}

  const c=await db.connect();
  try{
    if(!canOperate(req))fail(403,'Nincs jogosultsága készletművelethez.');
    const operationType=String(req.body?.operation_type||'').trim();
    if(!['receipt','sale','writeoff','adjustment'].includes(operationType))return next();
    await c.query('BEGIN');
    const warehouseId=req.body?.warehouse_id;
    const wh=(await c.query(`SELECT * FROM inventory_warehouses WHERE id=$1 AND active=true`,[warehouseId])).rows[0];
    if(!wh)fail(404,'A raktár nem található.');ensureScope(req,wh);
    const results:any[]=[];
    for(const x of items){
      const productId=String(x?.product_id||'');const raw=num(x?.quantity);if(!productId||!Number.isFinite(raw)||Math.abs(raw)<=0)fail(400,'Érvénytelen készlettétel.');
      if(operationType==='receipt'||(operationType==='adjustment'&&raw>0)){
        const posted=await postWarehouseReceipt(c,{warehouse:wh,productId,quantity:Math.abs(raw),incomingUnitCost:num(x?.unit_cost),movementType:operationType,lot:{lotCode:x?.lot_code,manufacturedAt:x?.manufactured_at,expiresAt:x?.expires_at,supplierId:req.body?.supplier_id||null,sourceRecordType:'manual_operation',sourceRecordId:req.body?.document_number||null,note:req.body?.note||null,createdBy:actor(req),allowExpired:Boolean(x?.allow_expired)},meta:{supplierId:req.body?.supplier_id||null,documentNumber:req.body?.document_number||null,counterpartyName:req.body?.counterparty_name||null,note:req.body?.note||null,createdBy:actor(req)}});
        results.push({product_id:productId,...posted});
      }else{
        const posted=await postWarehouseIssue(c,{warehouse:wh,productId,quantity:Math.abs(raw),movementType:operationType,specificLotId:x?.lot_id||null,allowExpiredLot:operationType==='writeoff'&&Boolean(x?.lot_id),meta:{documentNumber:req.body?.document_number||null,counterpartyName:req.body?.counterparty_name||null,note:req.body?.note||null,createdBy:actor(req)}});
        results.push({product_id:productId,...posted});
      }
    }
    await c.query('COMMIT');res.status(201).json({ok:true,operation_type:operationType,items:results,lot_tracked:true});
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);sendError(e,res,next)}finally{c.release()}
});

export default router;
