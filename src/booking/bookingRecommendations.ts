import axios from 'axios';
import db from '../db';

export type BookingRecommendation={type:'service'|'promotion';service_id:string|null;title:string;message:string;name?:string;price?:number;duration_minutes?:number;category_name?:string;campaign_id?:string;discount_type?:string;discount_value?:number;valid_until?:string|null;ai_generated:boolean};

const fallbackMessage=(name:string,duration:number)=>`${name} jól kiegészítheti a választott kezelést, és körülbelül ${duration} perccel hosszabbítja a foglalást.`;
const outputText=(data:any)=>String(data?.output_text||data?.output?.flatMap((x:any)=>x?.content||[]).find((x:any)=>x?.type==='output_text')?.text||'');
const recommendationCache=new Map<string,{expires:number;value:any}>();
const CACHE_TTL_MS=10*60_000;
const parseAiJson=(value:string)=>JSON.parse(value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));

async function aiCopy(selected:string[],items:BookingRecommendation[]){
  const key=String(process.env.OPENAI_API_KEY||'').trim();if(!key||!items.length)return null;
  const allowed=items.map(x=>({service_id:x.service_id,name:x.name,price:x.price,duration_minutes:x.duration_minutes}));
  try{
    const response=await axios.post('https://api.openai.com/v1/responses',{model:process.env.BOOKING_RECOMMENDATION_MODEL||process.env.OPENAI_MODEL||'gpt-5-mini',store:false,max_output_tokens:500,text:{format:{type:'json_schema',name:'booking_recommendations',strict:true,schema:{type:'object',properties:{recommendations:{type:'array',items:{type:'object',properties:{service_id:{type:'string'},title:{type:'string'},message:{type:'string'}},required:['service_id','title','message'],additionalProperties:false}}},required:['recommendations'],additionalProperties:false}}},input:[{role:'system',content:[{type:'input_text',text:'Magyar szépségszalon foglalási ajánlószöveget írsz. Kizárólag a kapott service_id-kat használd. Árat, kedvezményt, hatást vagy elérhetőséget ne találj ki. A cím legfeljebb 45, az üzenet legfeljebb 150 karakter legyen.'}]},{role:'user',content:[{type:'input_text',text:JSON.stringify({selected_services:selected,candidates:allowed})}]}]},{headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},timeout:12_000});
    const parsed=parseAiJson(outputText(response.data))?.recommendations;if(!Array.isArray(parsed))return null;
    const map=new Map(parsed.map((x:any)=>[String(x.service_id),x]));
    return items.map(item=>{const x=map.get(String(item.service_id));return x?{...item,title:String(x.title||item.title).slice(0,45),message:String(x.message||item.message).slice(0,150),ai_generated:true}:item});
  }catch(error:any){console.warn('[booking-recommendations] AI copy fallback',error?.response?.status||error?.message||error);return null}
}

export async function bookingRecommendations(locationId:string,selectedIds:string[]){
  const selected=Array.from(new Set(selectedIds)).slice(0,10);
  const cacheKey=`${locationId}:${[...selected].sort().join(',')}`;
  const cached=recommendationCache.get(cacheKey);if(cached&&cached.expires>Date.now())return cached.value;
  const selectedRows=selected.length?(await db.query(`SELECT s.id::text,s.name,s.service_type_id::text FROM services s WHERE s.id=ANY($1::uuid[]) AND COALESCE(s.is_active,true)=true AND COALESCE(s.online_bookable,true)=true
    AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$2::uuid))`,[selected,locationId])).rows:[];
  if(selectedRows.length!==selected.length)return{recommendations:[],ai_used:false,selected_service_ids:selected};
  const categoryIds=selectedRows.map((x:any)=>x.service_type_id).filter(Boolean);
  const services=selected.length?(await db.query(`SELECT s.id::text,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(st.name,'Kiegészítő szolgáltatás') category_name
    FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
    WHERE COALESCE(s.is_active,true)=true AND COALESCE(s.online_bookable,true)=true AND NOT(s.id=ANY($1::uuid[]))
      AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$2::uuid))
    ORDER BY CASE WHEN s.service_type_id::text=ANY($3::text[]) THEN 0 ELSE 1 END,COALESCE(s.promo_price,s.list_price,s.base_price,0),s.name LIMIT 3`,[selected,locationId,categoryIds])).rows:[];
  let recommendations:BookingRecommendation[]=services.map((s:any)=>({type:'service',service_id:String(s.id),name:s.name,price:Number(s.price||0),duration_minutes:Number(s.duration_minutes||30),category_name:s.category_name,title:'Ajánlott kiegészítés',message:fallbackMessage(s.name,Number(s.duration_minutes||30)),ai_generated:false}));
  try{
    const campaignTable=(await db.query(`SELECT to_regclass('public.loyalty_coupon_campaigns') IS NOT NULL ok`)).rows[0]?.ok;
    if(campaignTable){
      const campaigns=(await db.query(`SELECT id::text,name,discount_type,discount_value::numeric,valid_until FROM loyalty_coupon_campaigns WHERE COALESCE(active,true)=true AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now()) AND COALESCE(applies_to_all,true)=true ORDER BY valid_until NULLS LAST LIMIT 2`)).rows;
      recommendations.push(...campaigns.map((c:any)=>({type:'promotion' as const,service_id:null,campaign_id:String(c.id),title:'Aktuális ajánlat',message:`${c.name}: ${c.discount_type==='percent'?`${Number(c.discount_value)}% kedvezmény`:`${Number(c.discount_value).toLocaleString('hu-HU')} Ft kedvezmény`}.`,discount_type:c.discount_type,discount_value:Number(c.discount_value),valid_until:c.valid_until||null,ai_generated:false})));
    }
  }catch(error:any){console.warn('[booking-recommendations] campaign fallback',error?.message||error)}
  const serviceItems=recommendations.filter(x=>x.type==='service');const enhanced=await aiCopy(selectedRows.map((x:any)=>x.name),serviceItems);
  if(enhanced)recommendations=[...enhanced,...recommendations.filter(x=>x.type==='promotion')];
  const value={recommendations:recommendations.slice(0,5),ai_used:Boolean(enhanced),selected_service_ids:selected};
  if(recommendationCache.size>=100)recommendationCache.delete(recommendationCache.keys().next().value as string);
  recommendationCache.set(cacheKey,{expires:Date.now()+CACHE_TTL_MS,value});
  return value;
}
