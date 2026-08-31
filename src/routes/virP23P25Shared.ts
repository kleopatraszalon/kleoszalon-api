import pool from '../db';
import { findCalendarGaps, upcomingRiskCandidates } from '../booking/virWave1Engine';
import { profitEngine } from '../services/virWave2Engine';
import { buildP20Forecast } from './virP20';
import { clamp, readKpis, safeRows } from './virP20P22Shared';

export type ScenarioLevers={
  price_delta_percent:number;
  staff_hours_delta_percent:number;
  promotion_discount_percent:number;
  no_show_reduction_percent:number;
  stock_availability_delta_percent:number;
  demand_delta_percent:number;
};

export function normalizeLevers(value:any):ScenarioLevers{
  const v=value&&typeof value==='object'?value:{};
  return {
    price_delta_percent:clamp(Number(v.price_delta_percent||0),-15,20),
    staff_hours_delta_percent:clamp(Number(v.staff_hours_delta_percent||0),-20,25),
    promotion_discount_percent:clamp(Number(v.promotion_discount_percent||0),0,25),
    no_show_reduction_percent:clamp(Number(v.no_show_reduction_percent||0),0,50),
    stock_availability_delta_percent:clamp(Number(v.stock_availability_delta_percent||0),-20,20),
    demand_delta_percent:clamp(Number(v.demand_delta_percent||0),-20,30),
  };
}

function isoDay(d:Date){return d.toISOString().slice(0,10);}
function previousDays(days:number){const to=new Date();to.setDate(to.getDate()-1);const from=new Date(to);from.setDate(from.getDate()-Math.max(1,days-1));return{from:isoDay(from),to:isoDay(to)};}

async function tenantLocations(tenant:string,location:string|null){
  if(location){const rows=await safeRows(`SELECT id::text,name FROM locations WHERE tenant_id=$1::bigint AND id=$2::uuid`,[tenant,location]);return rows;}
  return safeRows(`SELECT id::text,name FROM locations WHERE tenant_id=$1::bigint ORDER BY name`,[tenant]);
}

export async function buildDigitalTwin(tenant:string,location:string|null){
  const locs=await tenantLocations(tenant,location),locationIds=locs.map((x:any)=>String(x.id));
  const kpis=await readKpis(tenant,location,30),forecast=await buildP20Forecast(tenant,location,30);
  const upcoming=(await safeRows(`SELECT COUNT(DISTINCT a.id)::int bookings,COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric booked_value FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE a.tenant_id::text=$1 AND ($2::uuid IS NULL OR a.location_id=$2::uuid) AND a.start_time>=now() AND a.start_time<now()+interval '30 days' AND a.status NOT IN ('cancelled','no_show')`,[tenant,location]))[0]||{};
  const employees=(await safeRows(`SELECT COUNT(DISTINCT e.id)::int active_staff FROM employees e JOIN locations l ON l.id=e.location_id WHERE l.tenant_id=$1::bigint AND ($2::uuid IS NULL OR e.location_id=$2::uuid) AND COALESCE(e.active,true)=true`,[tenant,location]))[0]||{};
  const stock=(await safeRows(`SELECT COUNT(*)::int balances,COUNT(*) FILTER(WHERE COALESCE(b.quantity,0)<=0)::int out_of_stock,COUNT(*) FILTER(WHERE COALESCE(b.quantity,0)>0 AND COALESCE(b.quantity,0)<=COALESCE(b.min_quantity,0))::int low_stock,COALESCE(SUM(COALESCE(b.quantity,0)*COALESCE(b.unit_cost,0)),0)::numeric stock_value FROM product_stock_balances b JOIN locations l ON l.id=b.location_id WHERE l.tenant_id=$1::bigint AND ($2::uuid IS NULL OR b.location_id=$2::uuid)`,[tenant,location]))[0]||{};
  let gapCount=0,gapMinutes=0,gapValue=0,highNoShow=0,riskCandidates=0;
  for(const loc of locationIds.slice(0,25)){
    try{const gaps=await findCalendarGaps(loc,14);gapCount+=gaps.length;for(const g of gaps){gapMinutes+=Number((g as any).minutes||0);gapValue+=Number((g as any).estimated_value||0);}}catch{}
    try{const risks=await upcomingRiskCandidates(loc,14);riskCandidates+=risks.length;highNoShow+=risks.filter((r:any)=>Number(r.score||0)>=70).length;}catch{}
  }
  const range=previousDays(30);let revenue=0,material=0,labor=0,commission=0,gross=0,profitLocations=0;
  for(const loc of locationIds.slice(0,25)){
    try{const p:any=await profitEngine({locationId:loc,from:range.from,to:range.to,targetMargin:35});const s=p?.summary||{};revenue+=Number(s.revenue||0);material+=Number(s.material_cost||0);labor+=Number(s.labor_cost||0);commission+=Number(s.commission_cost||0);gross+=Number(s.gross_profit||0);profitLocations++;}catch{}
  }
  const margin=revenue>0?gross/revenue*100:0,stockBalances=Number(stock.balances||0),stockRisk=stockBalances>0?(Number(stock.out_of_stock||0)+Number(stock.low_stock||0))/stockBalances:0;
  const coverage={locations:locs.length>0,kpi_history:true,predictive_forecast:true,staff:Number(employees.active_staff||0)>0,inventory:stockBalances>0,capacity:locationIds.length>0,profitability:profitLocations>0,no_show_risk:locationIds.length>0};
  const completeness=Object.values(coverage).filter(Boolean).length/Object.keys(coverage).length;
  return {
    model:'business_digital_twin_v1',generated_at:new Date().toISOString(),scope:{tenant_id:tenant,location_id:location,locations:locs},
    completeness:Number(completeness.toFixed(4)),coverage,
    demand:{history_30d:kpis,upcoming_bookings_30d:Number(upcoming.bookings||0),upcoming_booked_value_30d:Number(upcoming.booked_value||0),forecast_30d:{revenue:forecast.revenue_forecast,bookings:forecast.booking_forecast,lower:forecast.revenue_lower,upper:forecast.revenue_upper,confidence:forecast.confidence,mape_percent:forecast.metrics.mape_percent}},
    capacity:{active_staff:Number(employees.active_staff||0),open_gaps_14d:gapCount,open_minutes_14d:gapMinutes,open_value_14d:Number(gapValue.toFixed(2)),pressure:gapMinutes<240?'high':gapMinutes<1200?'normal':'low'},
    customer_risk:{risk_candidates_14d:riskCandidates,high_no_show_risk_14d:highNoShow,no_show_percent_30d:kpis.no_show_percent},
    financial:{revenue_30d:Number(revenue.toFixed(2)),material_cost_30d:Number(material.toFixed(2)),labor_cost_30d:Number(labor.toFixed(2)),commission_cost_30d:Number(commission.toFixed(2)),gross_profit_30d:Number(gross.toFixed(2)),margin_percent:Number(margin.toFixed(2))},
    inventory:{balances:stockBalances,out_of_stock:Number(stock.out_of_stock||0),low_stock:Number(stock.low_stock||0),stock_value:Number(stock.stock_value||0),risk_ratio:Number(stockRisk.toFixed(4))},
    governance:{production_mutation:false,approval_layer:'P17',simulation_only:true},
  };
}

export function simulateScenario(twin:any,input:any){
  const l=normalizeLevers(input),baseRevenue=Number(twin?.demand?.forecast_30d?.revenue||twin?.financial?.revenue_30d||0),baseBookings=Math.max(0,Number(twin?.demand?.forecast_30d?.bookings||0)),baseMargin=Number(twin?.financial?.margin_percent||30),baseNoShow=Number(twin?.customer_risk?.no_show_percent_30d||0),baseGap=Math.max(0,Number(twin?.capacity?.open_minutes_14d||0));
  const priceFactor=1+l.price_delta_percent/100,promoCoverage=l.promotion_discount_percent>0?0.30:0,promoPriceFactor=1-(l.promotion_discount_percent/100)*promoCoverage;
  const priceElasticity=1-l.price_delta_percent*0.006,promoDemand=1+l.promotion_discount_percent*0.008,demandFactor=clamp((1+l.demand_delta_percent/100)*priceElasticity*promoDemand,0.55,1.65);
  const capacityFactor=clamp(1+l.staff_hours_delta_percent/100,0.75,1.30),stockFactor=clamp(1+l.stock_availability_delta_percent/100,0.75,1.20);
  const noShowAfter=Math.max(0,baseNoShow*(1-l.no_show_reduction_percent/100)),attendanceLift=(100-noShowAfter)/Math.max(1,100-baseNoShow);
  const unconstrainedBookings=baseBookings*demandFactor,bookingFactor=Math.min(demandFactor,capacityFactor*1.08),bookings=Math.max(0,baseBookings*bookingFactor);
  const serviceFactor=clamp(stockFactor,0.85,1.10),revenue=Math.max(0,baseRevenue*priceFactor*promoPriceFactor*bookingFactor*attendanceLift*serviceFactor);
  const staffCostPressure=l.staff_hours_delta_percent*0.16,promoMarginPressure=l.promotion_discount_percent*promoCoverage,stockMarginEffect=l.stock_availability_delta_percent*0.04;
  const margin=clamp(baseMargin+l.price_delta_percent*0.45-promoMarginPressure-staffCostPressure+stockMarginEffect,2,80),profit=revenue*margin/100;
  const utilization=unconstrainedBookings>0?clamp(bookings/unconstrainedBookings*100,0,100):0,staffLoad=clamp(72+(bookingFactor-1)*45-l.staff_hours_delta_percent*0.7,20,115);
  const retention=clamp(72+l.no_show_reduction_percent*0.20-l.price_delta_percent*0.25+l.promotion_discount_percent*0.12,30,98),stockResilience=clamp((1-Number(twin?.inventory?.risk_ratio||0))*100+l.stock_availability_delta_percent,0,100);
  const result={revenue:Number(revenue.toFixed(2)),profit:Number(profit.toFixed(2)),margin_percent:Number(margin.toFixed(2)),bookings:Math.round(bookings),no_show_percent:Number(noShowAfter.toFixed(2)),utilization_percent:Number(utilization.toFixed(2)),staff_load_percent:Number(staffLoad.toFixed(2)),retention_index:Number(retention.toFixed(2)),stock_resilience:Number(stockResilience.toFixed(2)),open_capacity_minutes_14d:Math.max(0,Math.round(baseGap*(1+l.staff_hours_delta_percent/100)-(bookings-baseBookings)*45))};
  const baseline={revenue:baseRevenue,profit:Number((baseRevenue*baseMargin/100).toFixed(2)),margin_percent:baseMargin,bookings:Math.round(baseBookings),no_show_percent:baseNoShow,open_capacity_minutes_14d:baseGap};
  return {model:'what_if_simulator_v1',levers:l,baseline,result,delta:{revenue:Number((result.revenue-baseline.revenue).toFixed(2)),profit:Number((result.profit-baseline.profit).toFixed(2)),bookings:result.bookings-baseline.bookings,margin_percent:Number((result.margin_percent-baseline.margin_percent).toFixed(2)),no_show_percent:Number((result.no_show_percent-baseline.no_show_percent).toFixed(2))},confidence:Number(clamp(Number(twin?.demand?.forecast_30d?.confidence||0.5)*Number(twin?.completeness||0.5),0.25,0.92).toFixed(4)),assumptions:['bounded deterministic what-if model','price elasticity and promotion response are conservative heuristics','capacity is approximated from staff-hours and open-slot pressure','no production data is mutated by simulation']};
}

export function normalizedWeights(value:any){
  const defaults={revenue:0.22,profit:0.28,utilization:0.14,retention:0.14,staff_balance:0.12,stock_resilience:0.10},v=value&&typeof value==='object'?value:{};const raw:any={};let total=0;
  for(const k of Object.keys(defaults)){raw[k]=Math.max(0,Number(v[k]??(defaults as any)[k])||0);total+=raw[k];}
  if(total<=0)return defaults;for(const k of Object.keys(raw))raw[k]=raw[k]/total;return raw as typeof defaults;
}

export function candidateScore(sim:any,weights:any,base:any){
  const r=sim.result,b=sim.baseline;
  const revenue=clamp(50+((r.revenue-b.revenue)/Math.max(1,b.revenue))*100,0,100),profit=clamp(50+((r.profit-b.profit)/Math.max(1,b.profit))*100,0,100),util=clamp(r.utilization_percent,0,100),ret=clamp(r.retention_index,0,100),staff=clamp(100-Math.abs(r.staff_load_percent-82)*2,0,100),stock=clamp(r.stock_resilience,0,100);
  return Number((revenue*weights.revenue+profit*weights.profit+util*weights.utilization+ret*weights.retention+staff*weights.staff_balance+stock*weights.stock_resilience).toFixed(4));
}

export async function insertP17FromOptimization(tenant:string,location:string|null,run:any,actor:string){
  if(run.promoted_operation_id)return run.promoted_operation_id;
  const champion=run.champion||{},levers=champion.levers||{};
  const staffing=Math.abs(Number(levers.staff_hours_delta_percent||0))>=10,operationType=staffing?'staffing_review':'revenue_review',title=`Optimalizált vezetői beavatkozás · ${Number(run.score||0).toFixed(1)}/100`;
  const client=await pool.connect();try{await client.query('BEGIN');const op=(await client.query(`INSERT INTO vir_p17_operations(tenant_id,location_id,operation_type,title,status,execution_mode,approval_required,risk_level,source_layer,source_ref,idempotency_key,preview_payload,created_by) VALUES($1::bigint,$2::uuid,$3,$4,'pending_approval','controlled_manual',true,'high','p25',$5,$6,$7::jsonb,$8) RETURNING *`,[tenant,location,operationType,title,String(run.id),`p25-${run.id}`,JSON.stringify({optimizer_run_id:run.id,score:run.score,champion,production_mutation:false}),actor])).rows[0];await client.query(`INSERT INTO vir_p17_operation_events(tenant_id,operation_id,event_type,actor_id,payload) VALUES($1::bigint,$2::uuid,'created',$3,$4::jsonb)`,[tenant,op.id,actor,JSON.stringify({source_layer:'p25',optimizer_run_id:run.id,score:run.score})]);await client.query(`UPDATE vir_p25_optimization_runs SET status='promoted',promoted_operation_id=$3::uuid,promoted_by=$4,promoted_at=now(),updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint`,[run.id,tenant,op.id,actor]);await client.query('COMMIT');return op.id as string;}catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}finally{client.release();}
}