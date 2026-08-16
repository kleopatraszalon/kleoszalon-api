import type { PoolClient } from "pg";

export type FranchiseRevenuePosting={
  locationId:string;
  occurredAt?:string|Date|null;
  currency?:string;
  netRevenue:number|string;
  sourceType:string;
  sourceId:string;
  sourcePayload?:Record<string,unknown>;
};

/**
 * Posts a source-backed net revenue event only when the location is an active
 * franchise member. The caller owns the surrounding DB transaction, so the
 * commercial event and its royalty basis commit or roll back together.
 */
export async function recordFranchiseRevenueIfApplicable(c:PoolClient,input:FranchiseRevenuePosting){
  const locationId=String(input.locationId||"").trim();
  const sourceType=String(input.sourceType||"").trim();
  const sourceId=String(input.sourceId||"").trim();
  const currency=String(input.currency||"HUF").trim().toUpperCase();
  const revenue=Number(input.netRevenue);
  if(!locationId||!sourceType||!sourceId||!Number.isFinite(revenue)||revenue<0)return{posted:false,reason:"invalid_input" as const};

  const schema=(await c.query(`SELECT to_regclass('public.franchise_members') IS NOT NULL members_ok,to_regclass('public.franchise_revenue_entries') IS NOT NULL ledger_ok`)).rows[0];
  if(!schema?.members_ok||!schema?.ledger_ok)return{posted:false,reason:"schema_unavailable" as const};

  const member=(await c.query(`SELECT fm.id,fm.tenant_id,fm.franchise_network_id FROM franchise_members fm WHERE fm.location_id=$1 AND fm.member_type='franchise' AND fm.active=true LIMIT 1`,[locationId])).rows[0];
  if(!member)return{posted:false,reason:"not_franchise" as const};

  const occurredAt=input.occurredAt instanceof Date?input.occurredAt.toISOString():String(input.occurredAt||new Date().toISOString());
  const inserted=await c.query(`INSERT INTO franchise_revenue_entries(tenant_id,franchise_network_id,franchise_member_id,location_id,occurred_at,currency,net_revenue,source_type,source_id,source_payload)
    VALUES($1,$2,$3,$4,$5::timestamptz,$6,$7::numeric,$8,$9,$10::jsonb)
    ON CONFLICT(tenant_id,source_type,source_id) DO NOTHING
    RETURNING id::text`,[member.tenant_id,member.franchise_network_id,member.id,locationId,occurredAt,currency,revenue.toFixed(2),sourceType,sourceId,JSON.stringify(input.sourcePayload||{})]);
  if(!inserted.rowCount)return{posted:false,reason:"duplicate" as const};
  return{posted:true,id:String(inserted.rows[0].id),tenantId:String(member.tenant_id)};
}
