let savepointCounter=0;

async function tableColumns(c:any,table:string){
  const q=await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
  return new Set<string>(q.rows.map((r:any)=>String(r.column_name)));
}

async function setDefaultIfPresent(c:any,columns:Set<string>,table:string,column:string,expression:string){
  if(!columns.has(column))return;
  await c.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${expression}`);
}

/**
 * KIOSK-specifikus live DB kompatibilitási őr.
 *
 * A production work_orders/work_order_items/clients táblák több történeti
 * sémageneráció mezőit is tartalmazhatják. Az általános booking bootstrap
 * korábban egy túl laza readiness feltétel miatt késznek minősíthette a sémát
 * anélkül, hogy a legacy NOT NULL mezők biztonságos defaultjai ténylegesen
 * helyreálltak volna. A publikus KIOSK mentés ezért közvetlenül is biztosítja a
 * neki szükséges invariánsokat.
 */
export async function ensureKioskWorkOrderInsertCompatibility(c:any){
  const [clientCols,workOrderCols,itemCols]=await Promise.all([
    tableColumns(c,'clients'),tableColumns(c,'work_orders'),tableColumns(c,'work_order_items')
  ]);

  for(const [column,expression] of [
    ['marketing_consent','false'],['is_active','true'],['source',`'manual'`],
    ['created_at','now()'],['updated_at','now()']
  ] as const)await setDefaultIfPresent(c,clientCols,'clients',column,expression);

  for(const [column,expression] of [
    ['status',`'waiting'`],['created_at','now()'],['updated_at','now()'],['status_updated_at','now()'],
    ['fully_paid','false'],['note_for_another_visitor','false'],['client_name',`''`],['client_phone',`''`],['client_email',`''`],
    ['visit_status',`'várakozik'`],['record_note',`''`],['client_first_name',`''`],['client_last_name',`''`],
    ['total_price','0'],['gross_total','0'],['total_gross','0'],['discount_amount','0'],['tip_amount','0'],
    ['amount_due','0'],['amount_paid','0'],['payment_status',`'unpaid'`],['invoice_status',`'not_requested'`],['document_status',`'draft'`]
  ] as const)await setDefaultIfPresent(c,workOrderCols,'work_orders',column,expression);

  for(const [column,expression] of [
    ['quantity','1'],['unit_price','0'],['discount_amount','0'],['line_total','0'],['created_at','now()']
  ] as const)await setDefaultIfPresent(c,itemCols,'work_order_items',column,expression);

  if(itemCols.has('line_no')){
    await c.query(`
      CREATE OR REPLACE FUNCTION fill_work_order_item_line_no()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.line_no IS NULL THEN
          PERFORM pg_advisory_xact_lock(hashtext('work-order-lines:' || COALESCE(NEW.work_order_id::text,'')));
          SELECT COALESCE(MAX(line_no),0)+1 INTO NEW.line_no
            FROM work_order_items WHERE work_order_id=NEW.work_order_id;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS trg_fill_work_order_item_line_no ON work_order_items;
      CREATE TRIGGER trg_fill_work_order_item_line_no
        BEFORE INSERT ON work_order_items
        FOR EACH ROW EXECUTE FUNCTION fill_work_order_item_line_no();
    `);
  }

  if(workOrderCols.has('order_number')&&workOrderCols.has('work_order_number')){
    await c.query(`
      CREATE OR REPLACE FUNCTION sync_work_order_number_columns()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.work_order_number IS NOT NULL THEN
          NEW.order_number:=NEW.work_order_number;
        ELSIF NEW.order_number IS NOT NULL THEN
          NEW.work_order_number:=NEW.order_number;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS trg_sync_work_order_number_columns ON work_orders;
      CREATE TRIGGER trg_sync_work_order_number_columns
        BEFORE INSERT OR UPDATE OF order_number,work_order_number ON work_orders
        FOR EACH ROW EXECUTE FUNCTION sync_work_order_number_columns();
    `);
  }
}

async function optionalTx<T>(c:any,label:string,fn:()=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;error:any}>{
  const sp=`kiosk_optional_${++savepointCounter}`;
  await c.query(`SAVEPOINT ${sp}`);
  try{
    const value=await fn();
    await c.query(`RELEASE SAVEPOINT ${sp}`);
    return{ok:true,value};
  }catch(error:any){
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(()=>undefined);
    await c.query(`RELEASE SAVEPOINT ${sp}`).catch(()=>undefined);
    console.warn(`[kiosk-workorder] ${label} skipped`,{
      code:error?.code||null,table:error?.table||null,column:error?.column||null,constraint:error?.constraint||null,
      message:error?.message||String(error)
    });
    return{ok:false,error};
  }
}

/**
 * A line_total mezők a KIOSK tétel-INSERT során már kanonikus összegeket
 * tartalmaznak, ezért egy legacy recalc_work_order_totals() hiba nem teheti
 * semmissé az egész rendelést. Savepointtal izoláljuk a régi függvényt, majd
 * best-effort módon közvetlenül is frissítjük az ismert fejlécösszegeket.
 */
export async function finalizeKioskWorkOrderTotals(c:any,workOrderId:string,total:number){
  const recalc=(await c.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;
  if(recalc)await optionalTx(c,'legacy recalc_work_order_totals',()=>c.query(`SELECT recalc_work_order_totals($1::uuid)`,[workOrderId]));

  const cols=await tableColumns(c,'work_orders');
  const sets:string[]=[];
  const params:any[]=[workOrderId];
  const add=(column:string,value:any)=>{if(!cols.has(column))return;params.push(value);sets.push(`${column}=$${params.length}`)};
  add('total_price',total);
  add('gross_total',total);
  add('total_gross',total);
  add('discount_amount',0);
  add('tip_amount',0);
  add('amount_due',total);
  add('amount_paid',0);
  add('payment_status','unpaid');
  add('document_status','draft');
  if(cols.has('updated_at'))sets.push('updated_at=now()');
  if(sets.length)await optionalTx(c,'fallback workorder totals',()=>c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id=$1::uuid`,params));
}
