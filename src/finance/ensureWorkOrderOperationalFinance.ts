import db from '../db';
import {ensureFinanceNav} from './ensureFinanceNav';
import {ensureOtherPaymentCompatibility} from './ensureOtherPaymentCompatibility';
import {ensureSalonDefaultLegalEntities} from './ensureSalonDefaultLegalEntities';
import {ensureWorkOrderSettlementCompatibility} from './ensureWorkOrderSettlementCompatibility';

let pending:Promise<void>|null=null;
let lastReadyAt=0;
const CACHE_MS=15_000;

async function hasOperationalSchema(){
  const state=(await db.query(`
    SELECT
      to_regclass('public.work_orders') IS NOT NULL AS work_orders,
      to_regclass('public.work_order_items') IS NOT NULL AS work_order_items,
      to_regclass('public.work_order_payments') IS NOT NULL AS work_order_payments,
      to_regclass('public.work_order_settlements') IS NOT NULL AS work_order_settlements,
      to_regclass('public.legal_entities') IS NOT NULL AS legal_entities,
      to_regclass('public.legal_entity_locations') IS NOT NULL AS legal_entity_locations
  `)).rows[0]||{};
  if(!Object.values(state).every(Boolean))return false;

  const required:[string,string[]][]=[
    ['work_orders',['id','location_id','status','payment_status','financial_closed_at','legal_entity_id']],
    ['work_order_items',['work_order_id','line_total']],
    ['work_order_payments',['work_order_id','payment_method','amount','legal_entity_id']],
    ['work_order_settlements',['work_order_id','settlement_key']],
    ['legal_entity_locations',['legal_entity_id','location_id','active','is_default']],
  ];
  for(const [table,columns] of required){
    const q=await db.query(`
      SELECT COUNT(DISTINCT column_name)::int AS found
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=ANY($2::text[])
    `,[table,columns]);
    if(Number(q.rows[0]?.found||0)!==columns.length)return false;
  }
  return true;
}

/**
 * Operatív munkalap/pénztár readiness.
 *
 * A recepciós fizetésének és végleges munkalaplezárásának nem lehet előfeltétele
 * a NAV Online Számla teljes runtime bootstrapja. Ha az operatív pénzügyi séma
 * már rendelkezésre áll, csak a munkalapfizetéshez szükséges kompatibilitási
 * rétegeket és a szalon alapértelmezett kibocsátó cégét szinkronizáljuk.
 * A teljes Finance/NAV bootstrap csak valóban hiányos, új adatbázis
 * inicializálásakor fut le.
 *
 * A NAV-számlázási route-ok továbbra is a külön ensureNavInvoiceCore fail-closed
 * kaput használják; ez a helper kizárólag munkalap/pénztár operatív útvonalra való.
 */
export function ensureWorkOrderOperationalFinance(force=false){
  if(!force&&lastReadyAt&&Date.now()-lastReadyAt<CACHE_MS)return Promise.resolve();
  if(pending)return pending;

  pending=(async()=>{
    let ready=await hasOperationalSchema();
    if(!ready){
      await ensureFinanceNav();
      ready=await hasOperationalSchema();
    }
    if(!ready)throw Object.assign(new Error('A munkalap operatív pénzügyi sémája hiányos.'),{code:'WORKORDER_FINANCE_SCHEMA_INCOMPLETE'});

    await ensureSalonDefaultLegalEntities(force);
    await ensureWorkOrderSettlementCompatibility();
    await ensureOtherPaymentCompatibility();
    lastReadyAt=Date.now();
  })().finally(()=>{pending=null});

  return pending;
}

export default ensureWorkOrderOperationalFinance;
