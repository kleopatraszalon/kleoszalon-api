import { Router } from "express";
import pool from "../db";
import { requireAdmin } from "../middleware/requireRoles";
import type { AuthRequest } from "../middleware/auth";
import { getRuntimeSettingsSnapshot, saveRuntimeSettings } from "../services/virRuntimeSettings";
import { applyGitHubReleaseEnvironment, applyRenderHighAvailability, getRenderInfrastructureStatus } from "../services/virInfrastructureControl";
import { getComplaintMailboxStatus, restartComplaintMailboxWorker } from "../services/complaintMailbox";

const router = Router();

function escXml(value: unknown): string {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&apos;");
}
function escHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");
}
function stripHtml(value: unknown): string {
  return String(value ?? "").replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/p>/gi,"\n").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/[ \t]+/g," ").trim();
}
async function currentAction() {
  const r = await pool.query(`
    SELECT id, name, headline, description_html, image_url, cta_label, cta_url, discount_text,
           valid_from, valid_until, updated_at
    FROM daily_action_campaigns
    WHERE status='published' AND valid_from<=now() AND valid_until>=now()
    ORDER BY updated_at DESC, valid_until ASC
    LIMIT 1
  `);
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, description_text: stripHtml(row.description_html) };
}

router.get("/wallboard/daily-action.json", async (_req,res,next)=>{
  try {
    const action=await currentAction();
    res.setHeader("Cache-Control","public, max-age=30, stale-while-revalidate=120");
    res.json({ version:"1.0", generated_at:new Date().toISOString(), action });
  } catch(e){ next(e); }
});

router.get("/wallboard/daily-action.xml", async (_req,res,next)=>{
  try {
    const a=await currentAction();
    res.setHeader("Content-Type","application/xml; charset=utf-8");
    res.setHeader("Cache-Control","public, max-age=30, stale-while-revalidate=120");
    if(!a)return res.send(`<?xml version="1.0" encoding="UTF-8"?><wallboard version="1.0"><generated_at>${escXml(new Date().toISOString())}</generated_at><daily_action /></wallboard>`);
    res.send(`<?xml version="1.0" encoding="UTF-8"?><wallboard version="1.0"><generated_at>${escXml(new Date().toISOString())}</generated_at><daily_action><id>${escXml(a.id)}</id><name>${escXml(a.name)}</name><headline>${escXml(a.headline)}</headline><description>${escXml(a.description_text)}</description><discount>${escXml(a.discount_text)}</discount><image_url>${escXml(a.image_url)}</image_url><cta_label>${escXml(a.cta_label)}</cta_label><cta_url>${escXml(a.cta_url)}</cta_url><valid_from>${escXml(a.valid_from)}</valid_from><valid_until>${escXml(a.valid_until)}</valid_until></daily_action></wallboard>`);
  } catch(e){ next(e); }
});

router.get("/wallboard", async (_req,res,next)=>{
  try {
    const a=await currentAction();
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy","frame-ancestors *");
    res.setHeader("Cache-Control","no-cache");
    const headline=a?.headline||"Kleopátra Szépségszalonok";
    const description=a?.description_text||"A következő napi akció hamarosan érkezik.";
    const image=a?.image_url?`<div class="media" style="background-image:url('${escHtml(a.image_url)}')"></div>`:"";
    const discount=a?.discount_text?`<div class="discount">${escHtml(a.discount_text)}</div>`:"";
    res.type("html").send(`<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Kleopátra WallBoard</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#160d0a;color:#fff;font-family:Inter,Arial,sans-serif}.screen{height:100vh;display:grid;grid-template-columns:${a?.image_url?"1.1fr 1fr":"1fr"};background:radial-gradient(circle at 20% 20%,#5c173e 0,#24120e 45%,#120907 100%)}.media{background-size:cover;background-position:center;min-height:100%}.copy{display:flex;flex-direction:column;justify-content:center;padding:7vw}.eyebrow{letter-spacing:.22em;text-transform:uppercase;font-size:1.2vw;opacity:.7}.copy h1{font-size:4.5vw;line-height:1.02;margin:.35em 0 .25em;max-width:15ch}.copy p{font-size:1.8vw;line-height:1.4;max-width:34ch;opacity:.92}.discount{font-size:3vw;font-weight:800;color:#ffd88c;margin-top:.55em}.footer{position:fixed;right:2vw;bottom:1.5vw;font-size:1vw;opacity:.55}@media(max-aspect-ratio:1/1){.screen{grid-template-columns:1fr;grid-template-rows:45% 55%}.copy{padding:7vw}.copy h1{font-size:7vw}.copy p{font-size:3vw}.discount{font-size:5vw}.eyebrow{font-size:2vw}}</style></head><body><main class="screen">${image}<section class="copy"><div class="eyebrow">Kleopátra • Napi akció</div><h1>${escHtml(headline)}</h1><p>${escHtml(description)}</p>${discount}</section></main><div class="footer">Automatikus WallBoard feed • frissítés 60 mp</div></body></html>`);
  } catch(e){ next(e); }
});

// Privacy-safe birthday signal for salon signage. No guest names, dates of birth,
// contact details or other identifiers are exposed on the public display feed.
router.get("/birthdays", async (_req,res)=>{
  try {
    const { rows } = await pool.query(`
      WITH today AS (
        SELECT timezone('Europe/Budapest', now())::date AS d
      ), celebrating AS (
        SELECT DISTINCT a.client_id::text
        FROM appointments a
        JOIN clients c ON c.id::text = a.client_id::text
        CROSS JOIN today t
        WHERE timezone('Europe/Budapest', a.start_time)::date = t.d
          AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show')
          AND COALESCE(to_jsonb(c)->>'birth_date','') ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND EXTRACT(MONTH FROM substring(to_jsonb(c)->>'birth_date' from 1 for 10)::date) = EXTRACT(MONTH FROM t.d)
          AND EXTRACT(DAY FROM substring(to_jsonb(c)->>'birth_date' from 1 for 10)::date) = EXTRACT(DAY FROM t.d)
      )
      SELECT count(*)::int AS count FROM celebrating
    `);
    const count = Math.max(0, Number(rows?.[0]?.count || 0));
    const message = count === 1
      ? "Ma egy vendégünk születésnapját ünnepeljük. Boldog születésnapot kíván a Kleopátra csapata!"
      : count > 1
        ? `Ma ${count} vendégünk születésnapját ünnepeljük. Boldog születésnapot kíván a Kleopátra csapata!`
        : "";
    res.setHeader("Cache-Control","public, max-age=60, stale-while-revalidate=180");
    res.json({ celebrating: count > 0, count, message, date: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Budapest" }), privacy: "no_personal_identifiers", generated_at: new Date().toISOString() });
  } catch (e:any) {
    res.json({ celebrating:false, count:0, message:"", privacy:"no_personal_identifiers", generated_at:new Date().toISOString(), error:String(e?.message||e) });
  }
});

// Admin-only runtime configuration. Mounted under /api/signage but every route
// below performs its own authentication/role check before returning any data.
router.get("/runtime-settings", requireAdmin, async (_req,res,next)=>{
  try {
    const [settings, render] = await Promise.all([getRuntimeSettingsSnapshot(), getRenderInfrastructureStatus()]);
    res.json({ settings, render, mailbox: getComplaintMailboxStatus() });
  } catch(e){ next(e); }
});

router.put("/runtime-settings", requireAdmin, async (req:AuthRequest,res,next)=>{
  try {
    const actor=String(req.user?.email||req.user?.id||"admin");
    await saveRuntimeSettings(req.body?.settings||{},actor);
    restartComplaintMailboxWorker();
    const [settings, render] = await Promise.all([getRuntimeSettingsSnapshot(), getRenderInfrastructureStatus()]);
    res.json({ ok:true,settings,render,mailbox:getComplaintMailboxStatus() });
  } catch(e){ next(e); }
});

router.post("/runtime-settings/github/apply", requireAdmin, async (_req,res,next)=>{
  try { res.json(await applyGitHubReleaseEnvironment()); } catch(e){ next(e); }
});

router.post("/runtime-settings/render/verify", requireAdmin, async (_req,res,next)=>{
  try { res.json(await getRenderInfrastructureStatus()); } catch(e){ next(e); }
});

router.post("/runtime-settings/render/apply", requireAdmin, async (_req,res,next)=>{
  try { res.json(await applyRenderHighAvailability()); } catch(e){ next(e); }
});

export default router;
