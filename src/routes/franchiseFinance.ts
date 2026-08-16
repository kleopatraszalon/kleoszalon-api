import { Router, Response } from "express";
import db from "../db";
import { requireTenantRole, TenantAuthRequest } from "../middleware/tenantContext";

const router=Router();
const adminOnly=requireTenantRole("owner","admin");
const PERIOD_RE=/^\d{4}-(0[1-9]|1[0-2])$/;

function periodBounds(period:string){
  if(!PERIOD_RE.test(period)) return null;
  const [year,month]=period.split("-").map(Number);
  const start=`${period}-01`;
  const nextMonth=month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,"0")}-01`;
  return{start,nextMonth};
}

async function ensureFranchiseFinance(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS franchise_revenue_entries(
      id bigserial PRIMARY KEY,
      tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,
      franchise_member_id bigint NOT NULL REFERENCES franchise_members(id) ON DELETE CASCADE,
      location_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      currency text NOT NULL DEFAULT 'HUF',
      net_revenue numeric(16,2) NOT NULL CHECK(net_revenue>=0),
      source_type text NOT NULL,
      source_id text NOT NULL,
      source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'posted' CHECK(status IN('posted','reversed')),
      reversed_entry_id bigint REFERENCES franchise_revenue_entries(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,source_type,source_id)
    );
    CREATE INDEX IF NOT EXISTS franchise_revenue_period_idx ON franchise_revenue_entries(tenant_id,occurred_at,location_id) WHERE status='posted';

    CREATE TABLE IF NOT EXISTS franchise_settlements(
      id bigserial PRIMARY KEY,
      tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,
      franchise_member_id bigint NOT NULL REFERENCES franchise_members(id) ON DELETE CASCADE,
      location_id text NOT NULL,
      period_start date NOT NULL,
      period_end date NOT NULL,
      currency text NOT NULL DEFAULT 'HUF',
      revenue_base numeric(16,2) NOT NULL DEFAULT 0,
      royalty_percent numeric(8,4) NOT NULL DEFAULT 0,
      marketing_fee_percent numeric(8,4) NOT NULL DEFAULT 0,
      royalty_amount numeric(16,2) NOT NULL DEFAULT 0,
      marketing_fee_amount numeric(16,2) NOT NULL DEFAULT 0,
      total_due numeric(16,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','paid','void')),
      approved_at timestamptz,approved_by text,
      paid_at timestamptz,payment_reference text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,franchise_member_id,period_start,period_end,currency)
    );
    CREATE INDEX IF NOT EXISTS franchise_settlement_period_idx ON franchise_settlements(tenant_id,period_start,status);

    CREATE TABLE IF NOT EXISTS franchise_settlement_events(
      id bigserial PRIMARY KEY,
      tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      settlement_id bigint NOT NULL REFERENCES franchise_settlements(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      actor_user_id text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

router.use(async(_req,_res,next)=>{try{await ensureFranchiseFinance();next()}catch(error){next(error)}});

router.get("/summary",async(req:TenantAuthRequest,res:Response)=>{
  const period=String(req.query.period||new Date().toISOString().slice(0,7));
  const bounds=periodBounds(period);if(!bounds)return res.status(400).json({ok:false,error:"A period formátuma YYYY-MM legyen."});
  try{
    const totals=await db.query(`SELECT currency,COALESCE(SUM(revenue_base),0)::numeric revenue_base,COALESCE(SUM(royalty_amount),0)::numeric royalty_amount,COALESCE(SUM(marketing_fee_amount),0)::numeric marketing_fee_amount,COALESCE(SUM(total_due),0)::numeric total_due,COUNT(*)::int settlement_count,COUNT(*) FILTER(WHERE status='approved')::int approved_count,COUNT(*) FILTER(WHERE status='paid')::int paid_count FROM franchise_settlements WHERE tenant_id=$1::bigint AND period_start=$2::date GROUP BY currency ORDER BY currency`,[req.tenant!.id,bounds.start]);
    const rows=await db.query(`SELECT fs.id::text,fs.status,fs.period_start,fs.period_end,fs.currency,fs.revenue_base,fs.royalty_percent,fs.marketing_fee_percent,fs.royalty_amount,fs.marketing_fee_amount,fs.total_due,fs.approved_at,fs.paid_at,fs.payment_reference,fm.location_id,fn.name network_name,fn.code network_code,l.name location_name,l.city FROM franchise_settlements fs JOIN franchise_members fm ON fm.id=fs.franchise_member_id AND fm.tenant_id=fs.tenant_id JOIN franchise_networks fn ON fn.id=fs.franchise_network_id AND fn.tenant_id=fs.tenant_id LEFT JOIN locations l ON l.id::text=fs.location_id WHERE fs.tenant_id=$1::bigint AND fs.period_start=$2::date ORDER BY fn.name,l.name,fs.currency`,[req.tenant!.id,bounds.start]);
    return res.json({ok:true,period,summary_by_currency:totals.rows,rows:rows.rows});
  }catch(error){console.error("[FRANCHISE-FINANCE] summary",error);return res.status(500).json({ok:false,error:"A franchise elszámolás nem tölthető be."});}
});

router.post("/revenue-entries",adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const locationId=String(req.body?.location_id||"").trim();const sourceType=String(req.body?.source_type||"").trim();const sourceId=String(req.body?.source_id||"").trim();const currency=String(req.body?.currency||"HUF").trim().toUpperCase();const netRevenue=Number(req.body?.net_revenue);const occurredAt=String(req.body?.occurred_at||"").trim();
  if(!locationId||!sourceType||!sourceId||!occurredAt||!Number.isFinite(netRevenue)||netRevenue<0)return res.status(400).json({ok:false,error:"location_id, source_type, source_id, occurred_at és nem negatív net_revenue kötelező."});
  try{
    const member=await db.query(`SELECT fm.id,fm.franchise_network_id FROM franchise_members fm WHERE fm.tenant_id=$1::bigint AND fm.location_id=$2 AND fm.member_type='franchise' AND fm.active=true LIMIT 1`,[req.tenant!.id,locationId]);
    if(!member.rowCount)return res.status(404).json({ok:false,error:"A telephely nem aktív franchise tag ennél a tenantnál."});
    const{rows}=await db.query(`INSERT INTO franchise_revenue_entries(tenant_id,franchise_network_id,franchise_member_id,location_id,occurred_at,currency,net_revenue,source_type,source_id,source_payload) VALUES($1::bigint,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(tenant_id,source_type,source_id) DO NOTHING RETURNING id::text,location_id,occurred_at,currency,net_revenue,source_type,source_id,status`,[req.tenant!.id,member.rows[0].franchise_network_id,member.rows[0].id,locationId,occurredAt,currency,netRevenue,sourceType,sourceId,JSON.stringify(req.body?.source_payload||{})]);
    if(!rows.length)return res.status(409).json({ok:false,code:"FRANCHISE_REVENUE_DUPLICATE",error:"Ez a bevételi forrás már könyvelve van."});
    return res.status(201).json({ok:true,row:rows[0]});
  }catch(error){console.error("[FRANCHISE-FINANCE] revenue entry",error);return res.status(500).json({ok:false,error:"A franchise bevételi tétel nem könyvelhető."});}
});

router.post("/settlements/generate",adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const period=String(req.body?.period||"").trim();const bounds=periodBounds(period);if(!bounds)return res.status(400).json({ok:false,error:"A period formátuma YYYY-MM legyen."});
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const locked=await client.query(`SELECT id,status FROM franchise_settlements WHERE tenant_id=$1::bigint AND period_start=$2::date FOR UPDATE`,[req.tenant!.id,bounds.start]);
    if(locked.rows.some((x:any)=>x.status!=="draft")){await client.query("ROLLBACK");return res.status(409).json({ok:false,code:"FRANCHISE_SETTLEMENT_LOCKED",error:"A periódusban már van jóváhagyott vagy fizetett elszámolás; az nem generálható újra."});}
    const members=await client.query(`SELECT fm.id,fm.location_id,fm.franchise_network_id,COALESCE(fm.royalty_percent,fn.royalty_percent,0)::numeric royalty_percent,COALESCE(fm.marketing_fee_percent,fn.marketing_fee_percent,0)::numeric marketing_fee_percent FROM franchise_members fm JOIN franchise_networks fn ON fn.id=fm.franchise_network_id AND fn.tenant_id=fm.tenant_id WHERE fm.tenant_id=$1::bigint AND fm.member_type='franchise' AND fm.active=true AND (fm.agreement_start IS NULL OR fm.agreement_start<$3::date) AND (fm.agreement_end IS NULL OR fm.agreement_end>=$2::date)`,[req.tenant!.id,bounds.start,bounds.nextMonth]);
    let generated=0;
    for(const member of members.rows){
      const revenue=await client.query(`SELECT currency,COALESCE(SUM(net_revenue),0)::numeric revenue_base FROM franchise_revenue_entries WHERE tenant_id=$1::bigint AND franchise_member_id=$2 AND status='posted' AND occurred_at>=$3::date AND occurred_at<$4::date GROUP BY currency`,[req.tenant!.id,member.id,bounds.start,bounds.nextMonth]);
      for(const r of revenue.rows){
        const revenueBase=String(r.revenue_base||"0"),royaltyPercent=String(member.royalty_percent||"0"),marketingPercent=String(member.marketing_fee_percent||"0");
        const upsert=await client.query(`INSERT INTO franchise_settlements(tenant_id,franchise_network_id,franchise_member_id,location_id,period_start,period_end,currency,revenue_base,royalty_percent,marketing_fee_percent,royalty_amount,marketing_fee_amount,total_due,status) VALUES($1::bigint,$2,$3,$4,$5::date,($6::date-'1 day'::interval)::date,$7,$8::numeric,$9::numeric,$10::numeric,round($8::numeric*$9::numeric/100,2),round($8::numeric*$10::numeric/100,2),round($8::numeric*($9::numeric+$10::numeric)/100,2),'draft') ON CONFLICT(tenant_id,franchise_member_id,period_start,period_end,currency) DO UPDATE SET revenue_base=EXCLUDED.revenue_base,royalty_percent=EXCLUDED.royalty_percent,marketing_fee_percent=EXCLUDED.marketing_fee_percent,royalty_amount=EXCLUDED.royalty_amount,marketing_fee_amount=EXCLUDED.marketing_fee_amount,total_due=EXCLUDED.total_due,updated_at=now() WHERE franchise_settlements.status='draft' RETURNING id`,[req.tenant!.id,member.franchise_network_id,member.id,member.location_id,bounds.start,bounds.nextMonth,r.currency,revenueBase,royaltyPercent,marketingPercent]);
        if(upsert.rowCount){generated++;await client.query(`INSERT INTO franchise_settlement_events(tenant_id,settlement_id,event_type,actor_user_id,payload) VALUES($1::bigint,$2,'generated',$3,$4::jsonb)`,[req.tenant!.id,upsert.rows[0].id,String(req.user?.id||""),JSON.stringify({period,revenue_base:revenueBase,currency:r.currency})]);}
      }
    }
    await client.query("COMMIT");return res.json({ok:true,period,generated});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[FRANCHISE-FINANCE] generate",error);return res.status(500).json({ok:false,error:"A havi franchise elszámolás nem generálható."});}finally{client.release();}
});

router.post("/settlements/:id/approve",adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const id=String(req.params.id||"").trim();if(!/^\d+$/.test(id))return res.status(400).json({ok:false,error:"Érvénytelen settlement azonosító."});
  const client=await db.connect();try{await client.query("BEGIN");const updated=await client.query(`UPDATE franchise_settlements SET status='approved',approved_at=now(),approved_by=$3,updated_at=now() WHERE id=$1::bigint AND tenant_id=$2::bigint AND status='draft' RETURNING *`,[id,req.tenant!.id,String(req.user?.id||"")]);if(!updated.rowCount){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Csak draft elszámolás hagyható jóvá."});}await client.query(`INSERT INTO franchise_settlement_events(tenant_id,settlement_id,event_type,actor_user_id) VALUES($1::bigint,$2::bigint,'approved',$3)`,[req.tenant!.id,id,String(req.user?.id||"")]);await client.query("COMMIT");return res.json({ok:true,row:updated.rows[0]});}catch(error){await client.query("ROLLBACK").catch(()=>{});return res.status(500).json({ok:false,error:"Az elszámolás jóváhagyása nem sikerült."});}finally{client.release();}
});

router.post("/settlements/:id/mark-paid",adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const id=String(req.params.id||"").trim(),paymentReference=String(req.body?.payment_reference||"").trim();if(!/^\d+$/.test(id)||!paymentReference)return res.status(400).json({ok:false,error:"Érvényes settlement ID és payment_reference kötelező."});
  const client=await db.connect();try{await client.query("BEGIN");const updated=await client.query(`UPDATE franchise_settlements SET status='paid',paid_at=now(),payment_reference=$3,updated_at=now() WHERE id=$1::bigint AND tenant_id=$2::bigint AND status='approved' RETURNING *`,[id,req.tenant!.id,paymentReference]);if(!updated.rowCount){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Csak jóváhagyott elszámolás jelölhető fizetettnek."});}await client.query(`INSERT INTO franchise_settlement_events(tenant_id,settlement_id,event_type,actor_user_id,payload) VALUES($1::bigint,$2::bigint,'paid',$3,$4::jsonb)`,[req.tenant!.id,id,String(req.user?.id||""),JSON.stringify({payment_reference:paymentReference})]);await client.query("COMMIT");return res.json({ok:true,row:updated.rows[0]});}catch(error){await client.query("ROLLBACK").catch(()=>{});return res.status(500).json({ok:false,error:"A fizetési státusz nem menthető."});}finally{client.release();}
});

export default router;
