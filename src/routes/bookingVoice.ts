import { Router, Request } from "express";
import axios from "axios";
import crypto from "crypto";
import db from "../db";
import { estimateOpenAiTextCost, resolveOpenAiTextPricing } from "../ai/openAiCost";

const router = Router();
const MAX_TRANSCRIPT = 700;
const buckets = new Map<string,{startedAt:number;count:number}>();
const normalize=(value:unknown)=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9\s-]/g," ").replace(/\s+/g," ").trim();
const pad=(n:number)=>String(n).padStart(2,"0");
const isoLocal=(d:Date)=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDays=(d:Date,n:number)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const isIsoDate=(v:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""));
const isTime=(v:unknown)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||""));

function clientKey(req:Request){const raw=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").split(",")[0].trim();return crypto.createHash("sha256").update(raw).digest("hex").slice(0,24);}
function allow(key:string){const now=Date.now(),current=buckets.get(key);if(!current||now-current.startedAt>60_000){buckets.set(key,{startedAt:now,count:1});return true;}if(current.count>=8)return false;current.count+=1;return true;}

async function ensureSchema(){await db.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS booking_voice_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),client_key_hash text NOT NULL,
    transcript text,transcript_length integer NOT NULL DEFAULT 0,intent text NOT NULL DEFAULT 'book',
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,requested_date date,requested_time time,preferred_period text,
    recognized boolean NOT NULL DEFAULT false,ai_used boolean NOT NULL DEFAULT false,missing_fields text[] NOT NULL DEFAULT '{}'::text[],metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE INDEX IF NOT EXISTS booking_voice_events_created_idx ON booking_voice_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS booking_voice_events_location_idx ON booking_voice_events(location_id,created_at DESC);
`);}

type Catalog={locations:Array<{id:string;name:string}>;services:Array<{id:string;name:string}>;employees:Array<{id:string;full_name:string;location_id:string|null}>};
type Period="morning"|"afternoon"|"evening"|null;
type VoiceIntent={intent:"book"|"waitlist"|"cancel";location_id:string|null;service_ids:string[];employee_id:string|null;date:string|null;time:string|null;preferred_period:Period};

async function catalog():Promise<Catalog>{const[locations,services,employees]=await Promise.all([
  db.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
  db.query(`SELECT id::text id,name FROM services WHERE COALESCE(is_active,true)=true AND COALESCE(online_bookable,true)=true ORDER BY name`),
  db.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,location_id::text location_id FROM employees WHERE COALESCE(active,true)=true ORDER BY full_name`)
]);return{locations:locations.rows,services:services.rows,employees:employees.rows};}
function longestMatch<T extends{id:string}>(text:string,items:T[],label:(x:T)=>string){let best:T|null=null,bestLen=0;for(const item of items){const n=normalize(label(item));if(n.length>=3&&text.includes(n)&&n.length>bestLen){best=item;bestLen=n.length;}}return best;}
function allMatches<T extends{id:string}>(text:string,items:T[],label:(x:T)=>string){return items.filter(item=>{const n=normalize(label(item));return n.length>=3&&text.includes(n);}).sort((a,b)=>normalize(label(b)).length-normalize(label(a)).length);}

function parseDate(text:string):string|null{
  const today=new Date();today.setHours(12,0,0,0);
  if(/\bholnaputan\b/.test(text))return isoLocal(addDays(today,2));
  if(/\bholnap\b/.test(text))return isoLocal(addDays(today,1));
  if(/\bma\b/.test(text))return isoLocal(today);
  const direct=text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);if(direct)return direct[1];
  const numeric=text.match(/\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](20\d{2}|\d{2}))?\b/);
  if(numeric){const day=Number(numeric[1]),month=Number(numeric[2]);let year=numeric[3]?Number(numeric[3]):today.getFullYear();if(year<100)year+=2000;const d=new Date(year,month-1,day,12);if(d.getFullYear()===year&&d.getMonth()===month-1&&d.getDate()===day){if(!numeric[3]&&d<today)d.setFullYear(year+1);return isoLocal(d);}}
  const months:Record<string,number>={januar:0,februar:1,marcius:2,aprilis:3,majus:4,junius:5,julius:6,augusztus:7,szeptember:8,oktober:9,november:10,december:11};
  for(const[name,month]of Object.entries(months)){const m=text.match(new RegExp(`\\b${name}\\s+(\\d{1,2})(?:[-.]?(?:an|en|jan|jen|ikan|iken))?\\b`));if(m){const d=new Date(today.getFullYear(),month,Number(m[1]),12);if(d<today)d.setFullYear(d.getFullYear()+1);return isoLocal(d);}}
  const weekdays:Record<string,number>={hetfo:1,kedd:2,szerda:3,csutortok:4,pentek:5,szombat:6,vasarnap:0};
  for(const[name,target]of Object.entries(weekdays)){if(new RegExp(`\\b${name}(?:n|on|en|an)?\\b`).test(text)){let delta=(target-today.getDay()+7)%7;if(delta===0)delta=7;return isoLocal(addDays(today,delta));}}
  return null;
}
function parseTime(text:string):{time:string|null;preferred_period:Period}{
  const colon=text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);if(colon)return{time:`${pad(Number(colon[1]))}:${colon[2]}`,preferred_period:null};
  const hour=text.match(/\b([01]?\d|2[0-3])\s*(?:ora(?:ra)?|kor)\b/);if(hour)return{time:`${pad(Number(hour[1]))}:00`,preferred_period:null};
  if(/\b(reggel|delelot|delelott)\b/.test(text))return{time:null,preferred_period:"morning"};
  if(/\b(delutan)\b/.test(text))return{time:null,preferred_period:"afternoon"};
  if(/\b(este|estefele)\b/.test(text))return{time:null,preferred_period:"evening"};
  return{time:null,preferred_period:null};
}
function deterministic(transcript:string,c:Catalog):VoiceIntent{const text=normalize(transcript),location=longestMatch(text,c.locations,x=>x.name),services=allMatches(text,c.services,x=>x.name),scoped=location?c.employees.filter(e=>!e.location_id||e.location_id===location.id):c.employees,employee=longestMatch(text,scoped,x=>x.full_name),date=parseDate(text),t=parseTime(text);const intent:VoiceIntent["intent"]=/(lemond|torol)/.test(text)?"cancel":/(varolista)/.test(text)?"waitlist":"book";return{intent,location_id:location?.id||null,service_ids:services.map(x=>x.id),employee_id:employee?.id||null,date,time:t.time,preferred_period:t.preferred_period};}
function extractOutputText(data:any){let out=String(data?.output_text||"").trim();if(!out&&Array.isArray(data?.output))out=data.output.flatMap((x:any)=>Array.isArray(x?.content)?x.content:[]).filter((x:any)=>x?.type==="output_text").map((x:any)=>String(x.text||"")).join("\n").trim();return out.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();}

async function aiInterpret(transcript:string,c:Catalog,base:VoiceIntent,key:string):Promise<Partial<VoiceIntent>|null>{
  const apiKey=process.env.OPENAI_API_KEY;if(!apiKey||process.env.BOOKING_VOICE_AI_ENABLED==="0")return null;
  const essentialMissing=!base.location_id||!base.service_ids.length||!base.date;if(!essentialMissing&&!/\b(inkabb|legkorabbi|legkesobbi|barmelyik|mindegy|kozeli|valamikor)\b/.test(normalize(transcript)))return null;
  const locations=c.locations.map(x=>`${x.id}|${x.name}`).join("\n"),services=c.services.slice(0,180).map(x=>`${x.id}|${x.name}`).join("\n"),employees=c.employees.slice(0,180).map(x=>`${x.id}|${x.full_name}|${x.location_id||""}`).join("\n");
  const prompt=`A Kleopátra Szépségszalon hangalapú foglalási szándékát értelmezed. Csak JSON-t adj vissza: {"intent":"book|waitlist|cancel","location_id":null,"service_ids":[],"employee_id":null,"date":null,"time":null,"preferred_period":null}. Csak a megadott katalógus ID-kat használhatod. A dátum YYYY-MM-DD, az idő HH:MM. Ha nem biztos, legyen null vagy üres lista. Ma: ${isoLocal(new Date())}.\nSZALONOK:\n${locations}\nSZOLGÁLTATÁSOK:\n${services}\nMUNKATÁRSAK:\n${employees}\nFELHASZNÁLÓ: ${transcript}`;
  const response:any=await axios.post("https://api.openai.com/v1/responses",{model:process.env.BOOKING_VOICE_OPENAI_MODEL||process.env.OPENAI_MODEL||"gpt-5-mini",instructions:"Pontosan, konzervatívan értelmezd a foglalási szándékot. Ne találj ki adatot.",input:[{role:"user",content:[{type:"input_text",text:prompt}]}],store:false,max_output_tokens:300},{headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},timeout:20_000});
  const model=String(response.data?.model||process.env.BOOKING_VOICE_OPENAI_MODEL||process.env.OPENAI_MODEL||"gpt-5-mini");
  const usage=estimateOpenAiTextCost(model,response.data?.usage||{});
  try{
    await db.query(`INSERT INTO ai_usage_log(user_key,model,input_tokens,output_tokens,estimated_cost_usd) VALUES($1,$2,$3,$4,$5)`,[`public-booking-voice:${key}`,model,usage.inputTokens,usage.outputTokens,usage.estimatedCostUsd]);
  }catch(error:any){console.warn("booking voice AI usage log:",error?.message||error);}
  if(!usage.pricingResolved)console.warn("booking voice AI pricing unresolved:",model);

  let parsed:any=null;try{parsed=JSON.parse(extractOutputText(response.data));}catch{return null;}
  const locationIds=new Set(c.locations.map(x=>x.id)),serviceIds=new Set(c.services.map(x=>x.id)),employeeIds=new Set(c.employees.map(x=>x.id)),out:Partial<VoiceIntent>={};
  if(["book","waitlist","cancel"].includes(parsed?.intent))out.intent=parsed.intent;
  if(locationIds.has(String(parsed?.location_id||"")))out.location_id=String(parsed.location_id);
  if(Array.isArray(parsed?.service_ids))out.service_ids=parsed.service_ids.map(String).filter((id:string)=>serviceIds.has(id));
  if(employeeIds.has(String(parsed?.employee_id||"")))out.employee_id=String(parsed.employee_id);
  if(isIsoDate(parsed?.date))out.date=String(parsed.date);if(isTime(parsed?.time))out.time=String(parsed.time);
  if(["morning","afternoon","evening"].includes(parsed?.preferred_period))out.preferred_period=parsed.preferred_period;
  return out;
}
function mergeIntent(base:VoiceIntent,ai:Partial<VoiceIntent>|null):VoiceIntent{if(!ai)return base;return{intent:ai.intent||base.intent,location_id:base.location_id||ai.location_id||null,service_ids:base.service_ids.length?base.service_ids:(ai.service_ids||[]),employee_id:base.employee_id||ai.employee_id||null,date:base.date||ai.date||null,time:base.time||ai.time||null,preferred_period:base.preferred_period||ai.preferred_period||null};}
function followUp(intent:VoiceIntent,missing:string[]){if(intent.intent==="cancel")return"A lemondáshoz nyisd meg a meglévő foglalásodat; hang alapján nem törlünk automatikusan időpontot.";if(missing.includes("location"))return"Melyik Kleopátra szalonba szeretnél jönni?";if(missing.includes("services"))return"Milyen szolgáltatást szeretnél foglalni?";if(missing.includes("date"))return"Melyik nap lenne megfelelő?";if(!intent.time&&!intent.preferred_period)return"Melyik napszak vagy körülbelüli időpont lenne megfelelő?";return"Megvan a kérés. Mutatom a szabad időpontokat; foglalás csak a végső összegzés jóváhagyása után történik.";}

router.post("/interpret",async(req,res)=>{
  const transcript=String(req.body?.transcript||"").trim().slice(0,MAX_TRANSCRIPT);if(transcript.length<2)return res.status(400).json({error:"A felismert szöveg túl rövid."});
  const key=clientKey(req);if(!allow(key))return res.status(429).json({error:"Túl sok hangértelmezési kérés. Próbáld újra egy perc múlva."});
  try{await ensureSchema();const c=await catalog(),base=deterministic(transcript,c);let ai:Partial<VoiceIntent>|null=null,aiUsed=false;try{ai=await aiInterpret(transcript,c,base,key);aiUsed=Boolean(ai);}catch(error:any){console.warn("booking voice AI fallback:",error?.response?.status||error?.message||error);}const intent=mergeIntent(base,ai);
    if(intent.employee_id&&intent.location_id){const e=c.employees.find(x=>x.id===intent.employee_id);if(e?.location_id&&e.location_id!==intent.location_id)intent.employee_id=null;}
    const missing:string[]=[];if(intent.intent!=="cancel"){if(!intent.location_id)missing.push("location");if(!intent.service_ids.length)missing.push("services");if(!intent.date)missing.push("date");}
    const location=c.locations.find(x=>x.id===intent.location_id)||null,matchedServices=c.services.filter(x=>intent.service_ids.includes(x.id)),employee=c.employees.find(x=>x.id===intent.employee_id)||null,recognized=missing.length===0;
    const summary={location:location?.name||null,services:matchedServices.map(x=>x.name),employee:employee?.full_name||null,date:intent.date,time:intent.time,preferred_period:intent.preferred_period};
    const storeTranscript=process.env.BOOKING_VOICE_STORE_TRANSCRIPTS==="1";
    const event=await db.query(`INSERT INTO booking_voice_events(client_key_hash,transcript,transcript_length,intent,location_id,service_ids,employee_id,requested_date,requested_time,preferred_period,recognized,ai_used,missing_fields,metadata) VALUES($1,$2,$3,$4,$5::uuid,$6::uuid[],$7::uuid,$8::date,$9::time,$10,$11,$12,$13::text[],$14::jsonb) RETURNING id::text`,[key,storeTranscript?transcript:null,transcript.length,intent.intent,intent.location_id,intent.service_ids,intent.employee_id,intent.date,intent.time,intent.preferred_period,recognized,aiUsed,missing,JSON.stringify({summary})]);
    const voiceEventId=String(event.rows[0]?.id||"");
    return res.json({ok:true,voice_event_id:voiceEventId,intent,summary,missing_fields:missing,recognized,ai_used:aiUsed,requires_confirmation:true,spoken_follow_up:followUp(intent,missing)});
  }catch(error:any){console.error("POST booking/voice/interpret:",error);return res.status(500).json({error:"A hangalapú foglalási kérés értelmezése sikertelen.",detail:error?.message||String(error)});}
});
router.get("/health",(_req,res)=>{
  const model=process.env.BOOKING_VOICE_OPENAI_MODEL||process.env.OPENAI_MODEL||"gpt-5-mini";
  const pricing=resolveOpenAiTextPricing(model);
  res.json({ok:true,ai_configured:Boolean(process.env.OPENAI_API_KEY),model,transcripts_stored:process.env.BOOKING_VOICE_STORE_TRANSCRIPTS==="1",ai_cost_estimation:{resolved:Boolean(pricing),source:pricing?.source||null,input_usd_per_1m:pricing?.inputUsdPer1M??null,cached_input_usd_per_1m:pricing?.cachedInputUsdPer1M??null,output_usd_per_1m:pricing?.outputUsdPer1M??null}});
});
export default router;