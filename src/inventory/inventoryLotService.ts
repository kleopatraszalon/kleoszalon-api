import { ensureInventoryLotSchema } from "./ensureInventoryLotSchema";

const EPS = 0.0001;
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
};

export type LotReceiptInput = {
  lotCode?: string | null;
  manufacturedAt?: string | null;
  expiresAt?: string | null;
  supplierId?: string | number | null;
  sourceRecordType?: string | null;
  sourceRecordId?: string | null;
  note?: string | null;
  createdBy?: string | null;
  allowExpired?: boolean;
};

export type LotAllocation = {
  lot_id: string | null;
  lot_code: string | null;
  quantity: number;
  unit_cost: number;
  expires_at?: string | null;
  allocation_kind: "lot" | "legacy_untracked";
};

function lotError(message: string, code: string, status = 409) {
  const error: any = new Error(message);
  error.status = status;
  error.publicCode = code;
  error.code = code;
  return error;
}

export async function getProductLotTracking(client: any, productId: string) {
  await ensureInventoryLotSchema(client);
  const { rows } = await client.query(`
    SELECT id::text,name,
           COALESCE(lot_tracking_enabled,false) AS lot_tracking_enabled,
           COALESCE(expiry_tracking_enabled,false) AS expiry_tracking_enabled,
           COALESCE(fefo_enabled,false) AS fefo_enabled
    FROM products WHERE id=$1::uuid
  `, [productId]);
  if (!rows[0]) throw lotError("A termék nem található.", "INVENTORY_PRODUCT_NOT_FOUND", 404);
  return rows[0];
}

async function upsertLot(client: any, productId: string, input: LotReceiptInput) {
  const code = String(input.lotCode || "").trim();
  if (!code) throw lotError("A sarzs-/LOT-szám megadása kötelező ehhez a termékhez.", "INVENTORY_LOT_REQUIRED", 400);
  const expiresAt = input.expiresAt ? String(input.expiresAt) : null;
  const manufacturedAt = input.manufacturedAt ? String(input.manufacturedAt) : null;
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) throw lotError("A lejárati dátum formátuma érvénytelen.", "INVENTORY_EXPIRY_INVALID", 400);
  if (manufacturedAt && !/^\d{4}-\d{2}-\d{2}$/.test(manufacturedAt)) throw lotError("A gyártási dátum formátuma érvénytelen.", "INVENTORY_MANUFACTURED_DATE_INVALID", 400);
  if (expiresAt && manufacturedAt && expiresAt < manufacturedAt) throw lotError("A lejárati dátum nem lehet korábbi a gyártási dátumnál.", "INVENTORY_EXPIRY_BEFORE_MANUFACTURE", 400);
  if (expiresAt && !input.allowExpired) {
    const q = await client.query(`SELECT $1::date < CURRENT_DATE AS expired`, [expiresAt]);
    if (q.rows[0]?.expired) throw lotError("Lejárt sarzs normál bevételezéssel nem vehető készletre.", "INVENTORY_EXPIRED_LOT_RECEIPT", 409);
  }
  const { rows } = await client.query(`
    INSERT INTO inventory_lots(product_id,lot_code,manufactured_at,expires_at,supplier_id,source_record_type,source_record_id,note,created_by)
    VALUES($1::uuid,$2,$3::date,$4::date,$5,$6,$7,$8,$9)
    ON CONFLICT(product_id,lower(lot_code)) DO UPDATE SET
      manufactured_at=COALESCE(EXCLUDED.manufactured_at,inventory_lots.manufactured_at),
      expires_at=COALESCE(EXCLUDED.expires_at,inventory_lots.expires_at),
      supplier_id=COALESCE(EXCLUDED.supplier_id,inventory_lots.supplier_id),
      source_record_type=COALESCE(EXCLUDED.source_record_type,inventory_lots.source_record_type),
      source_record_id=COALESCE(EXCLUDED.source_record_id,inventory_lots.source_record_id),
      note=COALESCE(EXCLUDED.note,inventory_lots.note),updated_at=now()
    RETURNING *
  `, [productId, code, manufacturedAt, expiresAt, input.supplierId || null, input.sourceRecordType || null, input.sourceRecordId || null, input.note || null, input.createdBy || null]);
  return rows[0];
}

export async function receiveInventoryLot(client: any, args: {
  warehouseId: string | number;
  productId: string;
  quantity: number;
  unitCost: number;
  input?: LotReceiptInput | null;
}) : Promise<LotAllocation[]> {
  await ensureInventoryLotSchema(client);
  const tracking = await getProductLotTracking(client, args.productId);
  if (!tracking.lot_tracking_enabled) return [];
  const input = args.input || {};
  if (tracking.expiry_tracking_enabled && !input.expiresAt) {
    throw lotError("Ehhez a termékhez a lejárati dátum megadása is kötelező.", "INVENTORY_EXPIRY_REQUIRED", 400);
  }
  const lot = await upsertLot(client, args.productId, input);
  const qty = Number(args.quantity || 0);
  if (!(qty > EPS)) throw lotError("A sarzs bevételezett mennyiségének pozitívnak kell lennie.", "INVENTORY_INVALID_QUANTITY", 400);
  const existing = await client.query(`SELECT * FROM inventory_warehouse_lot_balances WHERE warehouse_id=$1 AND lot_id=$2::uuid FOR UPDATE`, [args.warehouseId, lot.id]);
  const oldQty = Number(existing.rows[0]?.quantity || 0);
  const oldCost = Number(existing.rows[0]?.unit_cost || 0);
  const after = oldQty + qty;
  const incoming = money(args.unitCost);
  const newCost = after > EPS ? money((oldQty * oldCost + qty * incoming) / after) : incoming;
  if (existing.rows[0]) {
    await client.query(`UPDATE inventory_warehouse_lot_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`, [existing.rows[0].id, after, newCost]);
  } else {
    await client.query(`INSERT INTO inventory_warehouse_lot_balances(warehouse_id,lot_id,quantity,unit_cost) VALUES($1,$2::uuid,$3,$4)`, [args.warehouseId, lot.id, qty, newCost]);
  }
  return [{ lot_id:String(lot.id), lot_code:String(lot.lot_code), quantity:qty, unit_cost:newCost, expires_at:lot.expires_at || null, allocation_kind:"lot" }];
}

export async function allocateInventoryLots(client: any, args: {
  warehouseId: string | number;
  productId: string;
  quantity: number;
  aggregateQuantity: number;
  specificLotId?: string | null;
  allowExpired?: boolean;
}): Promise<LotAllocation[]> {
  await ensureInventoryLotSchema(client);
  const tracking = await getProductLotTracking(client, args.productId);
  if (!tracking.lot_tracking_enabled) return [];
  const requested = Number(args.quantity || 0);
  if (!(requested > EPS)) return [];

  const allTracked = await client.query(`
    SELECT COALESCE(SUM(lb.quantity),0)::numeric AS total,
           COALESCE(SUM(CASE WHEN l.expires_at<CURRENT_DATE THEN lb.quantity ELSE 0 END),0)::numeric AS expired
    FROM inventory_warehouse_lot_balances lb
    JOIN inventory_lots l ON l.id=lb.lot_id
    WHERE lb.warehouse_id=$1 AND l.product_id=$2::uuid
  `, [args.warehouseId, args.productId]);
  const trackedTotal = Number(allTracked.rows[0]?.total || 0);
  const expiredTotal = Number(allTracked.rows[0]?.expired || 0);
  const legacyUntracked = Math.max(0, Number(args.aggregateQuantity || 0) - trackedTotal);

  const params:any[]=[args.warehouseId,args.productId];
  let specific = "";
  if (args.specificLotId) { params.push(args.specificLotId); specific = ` AND l.id=$${params.length}::uuid`; }
  const expiryFilter = args.allowExpired ? "" : " AND (l.expires_at IS NULL OR l.expires_at>=CURRENT_DATE)";
  const { rows } = await client.query(`
    SELECT lb.id AS balance_id,lb.quantity::numeric,lb.unit_cost::numeric,l.id::text AS lot_id,l.lot_code,l.expires_at
    FROM inventory_warehouse_lot_balances lb
    JOIN inventory_lots l ON l.id=lb.lot_id
    WHERE lb.warehouse_id=$1 AND l.product_id=$2::uuid AND lb.quantity>0 ${specific} ${expiryFilter}
    ORDER BY l.expires_at ASC NULLS LAST,l.created_at ASC,l.lot_code ASC
    FOR UPDATE OF lb
  `, params);

  const availableLots = rows.reduce((s:any,r:any)=>s+Number(r.quantity||0),0);
  const allowedLegacy = args.specificLotId ? 0 : legacyUntracked;
  if (availableLots + allowedLegacy + EPS < requested) {
    const usable = availableLots + allowedLegacy;
    throw lotError(
      `Nincs elegendő felhasználható FEFO készlet. Szükséges: ${requested}, felhasználható: ${usable}, lejárt készlet: ${expiredTotal}.`,
      "INVENTORY_FEFO_INSUFFICIENT_USABLE_STOCK",
      409,
    );
  }

  let remaining = requested;
  const allocations:LotAllocation[]=[];
  for (const row of rows) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining, Number(row.quantity || 0));
    if (!(take > EPS)) continue;
    await client.query(`UPDATE inventory_warehouse_lot_balances SET quantity=quantity-$2,updated_at=now() WHERE id=$1`, [row.balance_id, take]);
    allocations.push({lot_id:String(row.lot_id),lot_code:String(row.lot_code),quantity:take,unit_cost:Number(row.unit_cost||0),expires_at:row.expires_at||null,allocation_kind:"lot"});
    remaining -= take;
  }
  if (remaining > EPS) {
    allocations.push({lot_id:null,lot_code:null,quantity:remaining,unit_cost:0,allocation_kind:"legacy_untracked"});
    remaining=0;
  }
  return allocations;
}

export async function recordMovementLotAllocations(client:any,movementId:unknown,allocations:LotAllocation[],direction:1|-1){
  if (!allocations.length || movementId == null) return;
  for (const a of allocations) {
    await client.query(`
      INSERT INTO inventory_movement_lot_allocations(movement_id,lot_id,lot_code_snapshot,quantity,unit_cost,allocation_kind)
      VALUES($1,$2::uuid,$3,$4,$5,$6)
    `,[String(movementId),a.lot_id,a.lot_code,direction*Math.abs(Number(a.quantity||0)),money(a.unit_cost),a.allocation_kind]);
  }
}

export async function receiveTransferLots(client:any,args:{
  warehouseId:string|number;
  productId:string;
  quantity:number;
  operationGroupId?:string|null;
  unitCost:number;
}):Promise<LotAllocation[]> {
  await ensureInventoryLotSchema(client);
  const tracking=await getProductLotTracking(client,args.productId);
  if(!tracking.lot_tracking_enabled)return[];
  if(!args.operationGroupId)throw lotError("A sarzskövetett raktári átadás operation_group_id nélkül nem érkeztethető.","INVENTORY_TRANSFER_LOT_LINK_MISSING",409);
  const {rows}=await client.query(`
    SELECT a.lot_id::text,a.lot_code_snapshot,a.allocation_kind,ABS(a.quantity)::numeric quantity,a.unit_cost,l.expires_at
    FROM inventory_movement_lot_allocations a
    JOIN inventory_movements m ON m.id::text=a.movement_id
    LEFT JOIN inventory_lots l ON l.id=a.lot_id
    WHERE m.operation_group_id=$1::uuid AND m.product_id=$2::uuid AND m.quantity<0
    ORDER BY l.expires_at ASC NULLS LAST,a.id
  `,[args.operationGroupId,args.productId]);
  let remaining=Number(args.quantity||0);
  const credited:LotAllocation[]=[];
  for(const row of rows){
    if(remaining<=EPS)break;
    const take=Math.min(remaining,Number(row.quantity||0));
    if(!(take>EPS))continue;
    if(row.allocation_kind==='lot'&&row.lot_id){
      const bal=await client.query(`SELECT * FROM inventory_warehouse_lot_balances WHERE warehouse_id=$1 AND lot_id=$2::uuid FOR UPDATE`,[args.warehouseId,row.lot_id]);
      const oldQty=Number(bal.rows[0]?.quantity||0),oldCost=Number(bal.rows[0]?.unit_cost||row.unit_cost||args.unitCost||0),after=oldQty+take;
      const cost=Number(row.unit_cost||args.unitCost||0);
      const newCost=after>EPS?money((oldQty*oldCost+take*cost)/after):cost;
      if(bal.rows[0])await client.query(`UPDATE inventory_warehouse_lot_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`,[bal.rows[0].id,after,newCost]);
      else await client.query(`INSERT INTO inventory_warehouse_lot_balances(warehouse_id,lot_id,quantity,unit_cost) VALUES($1,$2::uuid,$3,$4)`,[args.warehouseId,row.lot_id,take,newCost]);
      credited.push({lot_id:String(row.lot_id),lot_code:row.lot_code_snapshot||null,quantity:take,unit_cost:newCost,expires_at:row.expires_at||null,allocation_kind:"lot"});
    }else credited.push({lot_id:null,lot_code:null,quantity:take,unit_cost:Number(row.unit_cost||0),allocation_kind:"legacy_untracked"});
    remaining-=take;
  }
  if(remaining>EPS)throw lotError("A sarzskövetett átadás forrás LOT-allokációja nem fedezi az érkeztetett mennyiséget.","INVENTORY_TRANSFER_LOT_ALLOCATION_SHORT",409);
  return credited;
}

export async function listInventoryLotBalances(client:any,filters:{warehouseId?:string|null;productId?:string|null;locationId?:string|null;status?:string|null}){
  await ensureInventoryLotSchema(client);
  const params:any[]=[];const where=["lb.quantity>0"];
  if(filters.warehouseId){params.push(filters.warehouseId);where.push(`w.id=$${params.length}`)}
  if(filters.productId){params.push(filters.productId);where.push(`l.product_id=$${params.length}::uuid`)}
  if(filters.locationId){params.push(filters.locationId);where.push(`w.location_id=$${params.length}::text`)}
  const status=String(filters.status||"");
  if(status==='expired')where.push(`l.expires_at<CURRENT_DATE`);
  else if(status==='expiring')where.push(`l.expires_at>=CURRENT_DATE AND l.expires_at<=CURRENT_DATE+30`);
  else if(status==='ok')where.push(`(l.expires_at IS NULL OR l.expires_at>CURRENT_DATE+30)`);
  const {rows}=await client.query(`
    SELECT lb.id::text AS lot_balance_id,w.id::text AS warehouse_id,w.name AS warehouse_name,w.location_id,
           l.id::text AS lot_id,l.product_id::text,p.name AS product_name,p.internal_code,p.brand,l.lot_code,
           l.manufactured_at,l.expires_at,lb.quantity::numeric,lb.unit_cost::numeric,
           COALESCE(p.lot_tracking_enabled,false) AS lot_tracking_enabled,
           COALESCE(p.expiry_tracking_enabled,false) AS expiry_tracking_enabled,
           COALESCE(p.fefo_enabled,false) AS fefo_enabled,
           CASE WHEN l.expires_at IS NULL THEN 'no_expiry'
                WHEN l.expires_at<CURRENT_DATE THEN 'expired'
                WHEN l.expires_at<=CURRENT_DATE+30 THEN 'expiring'
                ELSE 'ok' END AS expiry_status,
           CASE WHEN l.expires_at IS NULL THEN NULL ELSE (l.expires_at-CURRENT_DATE) END AS days_to_expiry,
           l.supplier_id,l.source_record_type,l.source_record_id,l.note,l.updated_at
    FROM inventory_warehouse_lot_balances lb
    JOIN inventory_lots l ON l.id=lb.lot_id
    JOIN inventory_warehouses w ON w.id=lb.warehouse_id
    JOIN products p ON p.id=l.product_id
    WHERE ${where.join(" AND ")}
    ORDER BY CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,l.expires_at,p.name,l.lot_code
  `,params);
  return rows;
}
