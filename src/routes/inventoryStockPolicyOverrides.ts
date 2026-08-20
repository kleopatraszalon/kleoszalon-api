import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db";
import { hasAnyRole } from "../security/roles";
import { postWarehouseIssue, productNegativeStockAllowed } from "../inventory/inventoryLedgerService";

const router=Router();
const EPS=0.0001;
const actor=(req:any)=>req.user?.email||String(req.user?.id||"system");
const isGlobal=(req:any)=>hasAnyRole(req.user?.role,["admin","manager"]);
const canOperate=(req:any)=>hasAnyRole(req.user?.role,["admin","manager","location_manager","salon_manager","receptionist"]);
const ownLocation=(req:any)=>req.user?.location_id==null?null:String(req.user.location_id);
const num=(v:any)=>{const n=Number(v);return Number.isFinite(n)?n:null};
function fail(status:number,message:string,code:string){const e:any=new Error(message);e.status=status;e.code=code;e.publicCode=code;throw e}
function send(err:any,res:any,next:any){if(err?.status)return res.status(err.status).json({message:err.message,code:err.code||err.publicCode});next(err)}
async function warehouse(id:any,client:any=db){const q=await client.query(`SELECT * FROM inventory_warehouses WHERE id=$1 AND active=true`,[String(id||"")]);if(!q.rows[0])fail(404,"A raktár nem található vagy inaktív.","INVENTORY_WAREHOUSE_NOT_FOUND");return q.rows[0]}
function assertScope(req:any,w:any){if(isGlobal(req))return;const own=ownLocation(req);if(!own||String(w.location_id||"")!==own)fail(403,"Ehhez a raktárhoz nincs jogosultsága.","INVENTORY_WAREHOUSE_FORBIDDEN")}

// Csak akkor vesszük át a régi /operations végpont kezelését, ha egy termék
// ténylegesen negatívba menne ÉS a termékszabály ezt engedélyezi.
router.post("/operations",async(req:any,res,next)=>{
 const client=await db.connect();
 try{
  if(!canOperate(req))return next();
  const type=String(req.body?.operation_type||"").trim();
  if(!["sale","writeoff"].includes(type))return next();
  const w=await warehouse(req.body?.warehouse_id,client);assertScope(req,w);
  const items=Array.isArray(req.body?.items)?req.body.items:[];if(!items.length)return next();
  let override=false;
  for(const raw of items){
   const productId=String(raw?.product_id||"").trim(),qty=Math.abs(Number(raw?.quantity||0));
   if(!productId||!(qty>EPS))continue;
   const b=await client.query(`SELECT COALESCE(quantity,0)::numeric quantity FROM inventory_warehouse_balances WHERE warehouse_id=$1 AND product_id=$2::uuid`,[w.id,productId]);
   if(Number(b.rows[0]?.quantity||0)+EPS<qty&&await productNegativeStockAllowed(client,productId,w.location_id==null?null:String(w.location_id))){override=true;break}
  }
  if(!override)return next();
  const group=randomUUID(),result:any[]=[];
  await client.query("BEGIN");
  for(const raw of items){
   const productId=String(raw?.product_id||"").trim(),qty=Math.abs(Number(raw?.quantity||0));
   if(!productId||!(qty>EPS))fail(400,"Érvénytelen terméktétel.","INVENTORY_INVALID_QUANTITY");
   const posted=await postWarehouseIssue(client,{warehouse:w,productId,quantity:qty,movementType:type,meta:{createdBy:actor(req),operationGroupId:group,supplierId:req.body?.supplier_id||null,documentNumber:String(req.body?.document_number||"").trim()||null,counterpartyName:String(req.body?.counterparty_name||"").trim()||null,note:String(req.body?.note||"").trim()||null}});
   const p=await client.query(`SELECT name FROM products WHERE id=$1::uuid`,[productId]);
   result.push({product_id:productId,product_name:p.rows[0]?.name||productId,quantity:posted.quantity,balance_after:posted.balance_after,unit_cost:posted.unit_cost,negative_stock_override:Number(posted.balance_after)<0});
  }
  await client.query("COMMIT");
  return res.status(201).json({ok:true,operation_group_id:group,operation_type:type,items:result,product_stock_policy_applied:true});
 }catch(err){await client.query("ROLLBACK").catch(()=>undefined);return send(err,res,next)}finally{client.release()}
});

// Ugyanez a raktárközi kiadásnál: normál esetben a régi útvonal fut tovább,
// csak engedélyezett termékszintű negatív felülbírálásnál kezeljük itt.
router.post("/transfers/:id/dispatch",async(req:any,res,next)=>{
 const client=await db.connect();
 try{
  if(!canOperate(req))return next();
  const head=await client.query(`SELECT t.*,sw.location_id AS source_location_id,sw.name AS source_warehouse_name FROM inventory_transfers t JOIN inventory_warehouses sw ON sw.id=t.source_warehouse_id WHERE t.id=$1`,[req.params.id]);
  const transfer=head.rows[0];if(!transfer||transfer.status!=="pending")return next();
  const source=await warehouse(transfer.source_warehouse_id,client);assertScope(req,source);
  const items=await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id=$1 ORDER BY id`,[req.params.id]);
  let override=false;
  for(const item of items.rows){
   const b=await client.query(`SELECT COALESCE(quantity,0)::numeric quantity FROM inventory_warehouse_balances WHERE warehouse_id=$1 AND product_id=$2::uuid`,[source.id,item.product_id]);
   if(Number(b.rows[0]?.quantity||0)+EPS<Number(item.quantity||0)&&await productNegativeStockAllowed(client,String(item.product_id),source.location_id==null?null:String(source.location_id))){override=true;break}
  }
  if(!override)return next();
  const group=randomUUID();await client.query("BEGIN");
  for(const item of items.rows){
   const posted=await postWarehouseIssue(client,{warehouse:source,productId:String(item.product_id),quantity:Number(item.quantity||0),movementType:"transfer_out",meta:{createdBy:actor(req),operationGroupId:group,destinationWarehouseId:transfer.destination_warehouse_id,documentNumber:transfer.document_number,note:`Áthelyezés ${transfer.document_number}`}});
   await client.query(`UPDATE inventory_transfer_items SET unit_cost=$2 WHERE id=$1`,[item.id,posted.unit_cost]);
  }
  const updated=(await client.query(`UPDATE inventory_transfers SET status='in_transit',dispatched_by=$2,dispatched_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,actor(req)])).rows[0];
  await client.query("COMMIT");return res.json({...updated,product_stock_policy_applied:true,operation_group_id:group});
 }catch(err){await client.query("ROLLBACK").catch(()=>undefined);return send(err,res,next)}finally{client.release()}
});

export default router;
