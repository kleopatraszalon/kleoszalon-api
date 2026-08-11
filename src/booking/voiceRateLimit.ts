import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import db from "../db";

const DEFAULT_LIMIT=8;
const WINDOW_SECONDS=60;
const CLEANUP_INTERVAL_MS=10*60_000;
let schemaPromise:Promise<void>|null=null;
let lastCleanupAt=0;

function configuredLimit(){
  const raw=Number(process.env.BOOKING_VOICE_RATE_LIMIT_PER_MINUTE||DEFAULT_LIMIT);
  if(!Number.isFinite(raw))return DEFAULT_LIMIT;
  return Math.min(120,Math.max(1,Math.floor(raw)));
}

function remoteIdentity(req:Request){
  const forwarded=String(req.headers["x-forwarded-for"]||"").split(",")[0].trim();
  return forwarded||String(req.ip||req.socket.remoteAddress||"unknown").trim()||"unknown";
}

export function bookingVoiceClientKey(req:Request){
  const identity=remoteIdentity(req);
  const salt=String(process.env.BOOKING_VOICE_RATE_LIMIT_SALT||"").trim();
  if(salt)return crypto.createHmac("sha256",salt).update(identity).digest("hex").slice(0,32);
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0,32);
}

export function ensureBookingVoiceRateLimitSchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE TABLE IF NOT EXISTS booking_voice_rate_limits(
        client_key_hash text NOT NULL,
        window_start timestamptz NOT NULL,
        request_count integer NOT NULL DEFAULT 0 CHECK(request_count>=0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(client_key_hash,window_start)
      );
      CREATE INDEX IF NOT EXISTS booking_voice_rate_limits_window_idx
        ON booking_voice_rate_limits(window_start);
    `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function cleanupOldWindows(){
  const now=Date.now();
  if(now-lastCleanupAt<CLEANUP_INTERVAL_MS)return;
  lastCleanupAt=now;
  db.query(`DELETE FROM booking_voice_rate_limits WHERE window_start<now()-interval '1 day'`).catch(error=>{
    console.warn("booking voice rate-limit cleanup:",error?.message||String(error));
  });
}

export async function consumeBookingVoiceRateLimit(key:string){
  await ensureBookingVoiceRateLimitSchema();
  const limit=configuredLimit();
  const {rows}=await db.query(`
    INSERT INTO booking_voice_rate_limits(client_key_hash,window_start,request_count,updated_at)
    VALUES($1,date_trunc('minute',now()),1,now())
    ON CONFLICT(client_key_hash,window_start)
    DO UPDATE SET request_count=booking_voice_rate_limits.request_count+1,updated_at=now()
    RETURNING request_count,
      GREATEST(1,CEIL(EXTRACT(EPOCH FROM (window_start+interval '1 minute'-now()))))::int retry_after_seconds
  `,[key]);
  void cleanupOldWindows();
  const count=Number(rows[0]?.request_count||1);
  const retryAfter=Math.max(1,Number(rows[0]?.retry_after_seconds||WINDOW_SECONDS));
  return{allowed:count<=limit,limit,count,remaining:Math.max(0,limit-count),retry_after_seconds:retryAfter};
}

export async function bookingVoiceRateLimit(req:Request,res:Response,next:NextFunction){
  if(req.method!=="POST"||req.path!=="/interpret")return next();
  try{
    const result=await consumeBookingVoiceRateLimit(bookingVoiceClientKey(req));
    res.setHeader("X-RateLimit-Limit",String(result.limit));
    res.setHeader("X-RateLimit-Remaining",String(result.remaining));
    if(!result.allowed){
      res.setHeader("Retry-After",String(result.retry_after_seconds));
      return res.status(429).json({
        error:"Túl sok hangértelmezési kérés. Próbáld újra rövid idő múlva.",
        retry_after_seconds:result.retry_after_seconds,
        rate_limit_backend:"postgresql"
      });
    }
    return next();
  }catch(error:any){
    console.error("booking voice distributed rate limit:",error?.message||String(error));
    return res.status(503).json({error:"A hangfoglalás védelmi ellenőrzése átmenetileg nem elérhető.",code:"voice_rate_limit_unavailable"});
  }
}

export default bookingVoiceRateLimit;
