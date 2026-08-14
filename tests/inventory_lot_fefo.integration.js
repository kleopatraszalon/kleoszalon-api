const assert=require('node:assert/strict');
const {pool}=require('../dist/db');
const {ensureInventoryLotSchema}=require('../dist/inventory/ensureInventoryLotSchema');
const {resolveInventoryWarehouse,postWarehouseReceipt,postWarehouseIssue}=require('../dist/inventory/inventoryLedgerService');

async function q(sql,params=[]){return pool.query(sql,params)}

async function main(){
  const seeded=await q(`WITH l AS (
    INSERT INTO locations(name,city,address) VALUES('FEFO Szalon','Eger','FEFO teszt 1') RETURNING id
  ), p AS (
    INSERT INTO products(name,retail_price_gross) VALUES('FEFO ampulla',1500) RETURNING id
  ) SELECT l.id location_id,p.id product_id FROM l,p`);
  const d=seeded.rows[0];
  await ensureInventoryLotSchema();
  await q(`UPDATE products SET lot_tracking_enabled=true,expiry_tracking_enabled=true,fefo_enabled=true WHERE id=$1`,[d.product_id]);

  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const source=await resolveInventoryWarehouse(c,{locationId:String(d.location_id),productId:String(d.product_id)});
    const destination=(await c.query(`INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,sort_order)
      VALUES($1::text,'FEFO_DEST','FEFO célraktár','retail',90) RETURNING *`,[d.location_id])).rows[0];

    const today=(await c.query(`SELECT CURRENT_DATE::text today,(CURRENT_DATE-1)::text expired,(CURRENT_DATE+10)::text soon,(CURRENT_DATE+100)::text later`)).rows[0];
    const meta={createdBy:'fefo.test@test.local',counterpartyName:'FEFO beszállító'};
    await postWarehouseReceipt(c,{warehouse:source,productId:String(d.product_id),quantity:2,incomingUnitCost:100,movementType:'receipt',lot:{lotCode:'LOT-EXPIRED',expiresAt:today.expired,allowExpired:true,createdBy:meta.createdBy},meta});
    await postWarehouseReceipt(c,{warehouse:source,productId:String(d.product_id),quantity:5,incomingUnitCost:110,movementType:'receipt',lot:{lotCode:'LOT-SOON',expiresAt:today.soon,createdBy:meta.createdBy},meta});
    await postWarehouseReceipt(c,{warehouse:source,productId:String(d.product_id),quantity:5,incomingUnitCost:120,movementType:'receipt',lot:{lotCode:'LOT-LATER',expiresAt:today.later,createdBy:meta.createdBy},meta});

    // FEFO must consume the nearest non-expired lot first and never auto-use the expired lot.
    const issue=await postWarehouseIssue(c,{warehouse:source,productId:String(d.product_id),quantity:7,movementType:'sale',meta:{createdBy:'fefo.test@test.local'}});
    assert.equal(issue.lot_allocations.length,2);
    assert.equal(issue.lot_allocations[0].lot_code,'LOT-SOON');
    assert.equal(Number(issue.lot_allocations[0].quantity),5);
    assert.equal(issue.lot_allocations[1].lot_code,'LOT-LATER');
    assert.equal(Number(issue.lot_allocations[1].quantity),2);
    const balances=(await c.query(`SELECT l.lot_code,lb.quantity::numeric FROM inventory_warehouse_lot_balances lb JOIN inventory_lots l ON l.id=lb.lot_id WHERE lb.warehouse_id=$1 ORDER BY l.lot_code`,[source.id])).rows;
    const byCode=new Map(balances.map(r=>[r.lot_code,Number(r.quantity)]));
    assert.equal(byCode.get('LOT-EXPIRED'),2);
    assert.equal(byCode.get('LOT-SOON'),0);
    assert.equal(byCode.get('LOT-LATER'),3);

    // Aggregate stock is 5 here, but only 3 is usable; the 2 expired units must not satisfy FEFO demand.
    await c.query('SAVEPOINT expected_fefo_shortage');
    let shortage=null;
    try{await postWarehouseIssue(c,{warehouse:source,productId:String(d.product_id),quantity:4,movementType:'sale',meta:{createdBy:'fefo.test@test.local'}})}catch(e){shortage=e}
    assert.ok(shortage,'FEFO shortage should fail');
    assert.equal(shortage.code,'INVENTORY_FEFO_INSUFFICIENT_USABLE_STOCK');
    await c.query('ROLLBACK TO SAVEPOINT expected_fefo_shortage');
    await c.query('RELEASE SAVEPOINT expected_fefo_shortage');

    // Transfer keeps the original LOT identity through operation_group_id.
    const group='11111111-1111-4111-8111-111111111111';
    const out=await postWarehouseIssue(c,{warehouse:source,productId:String(d.product_id),quantity:2,movementType:'transfer_out',meta:{createdBy:'fefo.test@test.local',destinationWarehouseId:destination.id,operationGroupId:group}});
    assert.equal(out.lot_allocations[0].lot_code,'LOT-LATER');
    const incoming=await postWarehouseReceipt(c,{warehouse:destination,productId:String(d.product_id),quantity:2,incomingUnitCost:Number(out.unit_cost),movementType:'transfer_in',meta:{createdBy:'fefo.test@test.local',operationGroupId:group}});
    assert.equal(incoming.lot_allocations[0].lot_code,'LOT-LATER');
    const dest=(await c.query(`SELECT l.lot_code,lb.quantity::numeric FROM inventory_warehouse_lot_balances lb JOIN inventory_lots l ON l.id=lb.lot_id WHERE lb.warehouse_id=$1`,[destination.id])).rows[0];
    assert.equal(dest.lot_code,'LOT-LATER');
    assert.equal(Number(dest.quantity),2);

    // A tracked supplier receipt without a LOT/expiry must fail and must be rollback-safe.
    await c.query('SAVEPOINT expected_missing_lot');
    let missing=null;
    try{await postWarehouseReceipt(c,{warehouse:source,productId:String(d.product_id),quantity:1,incomingUnitCost:99,movementType:'receipt',meta:{createdBy:'fefo.test@test.local'}})}catch(e){missing=e}
    assert.ok(missing,'tracked receipt without lot should fail');
    assert.equal(missing.code,'INVENTORY_EXPIRY_REQUIRED');
    await c.query('ROLLBACK TO SAVEPOINT expected_missing_lot');
    await c.query('RELEASE SAVEPOINT expected_missing_lot');

    const movementLinks=await c.query(`SELECT COUNT(*)::int n FROM inventory_movement_lot_allocations`);
    assert.ok(Number(movementLinks.rows[0].n)>=6,'movement lot audit links are missing');
    await c.query('COMMIT');
    console.log('INVENTORY LOT/EXPIRY/FEFO INTEGRATION: PASS');
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release();await pool.end()}
}
main().catch(async e=>{console.error('INVENTORY LOT/EXPIRY/FEFO INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});
