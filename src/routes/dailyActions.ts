import { Router } from "express";
import db from "../db";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";
import webpush from "web-push";
import axios from "axios";
import { applicableDailyActions, ensureDailyActionApplicabilitySchema } from "../marketing/dailyActionApplicability";
export const publicDailyActionsRouter = Router();
const router = Router();
const publicFrontendUrl = (process.env.FRONTEND_URL || "https://kleoszalon-frontend.onrender.com").replace(/\/$/, "");
const kleopatraLogoUrl = `${publicFrontendUrl}/kleopatra-logo.png`;
const defaultAppConfig={design:{primary_color:"#ec008c",accent_color:"#c8a96b",background_color:"#f7f3ed",surface_color:"#ffffff",text_color:"#17110e",hero_color:"#20120c",hero_text_color:"#ffffff",border_radius:26,font_family:"Inter",font_scale:1},media:{logo_url:"/kleopatra-logo.png",hero_image_url:"",entry_image_url:""},visibility:{quick_actions:true,daily_actions:true,assistant:true,salons:true,reviews:true},texts:{entry_eyebrow:"KLEOPÁTRA BEAUTY CLUB",entry_title:"Minden ami szépség, csak Neked!",entry_description:"Foglalás, szalonok, exkluzív ajánlatok és hűségelőnyök egy letisztult alkalmazásban.",login_label:"Bejelentkezés",register_label:"Regisztráció",guest_label:"Folytatás vendégként",hero_eyebrow:"KLEOPÁTRA BEAUTY CLUB",hero_title:"Minden ami szépség, csak Neked!",hero_description:"Foglalás, szalonok, exkluzív ajánlatok és hűségelőnyök egy letisztult alkalmazásban.",booking_cta:"Időpontot foglalok",quick_booking_title:"Gyors foglalás",quick_booking_subtitle:"Néhány egyszerű lépés",pass_title:"Beauty Pass",pass_subtitle:"Belépéssel elérhető",gifts_title:"Ajándékok",gifts_subtitle:"Kuponok és utalványok",salons_title:"Szalonok",salons_subtitle:"Legközelebbi helyszín",deals_eyebrow:"ÖNNEK VÁLOGATVA",deals_title:"Napi akciók",deals_empty_title:"A következő ajánlat már készül",deals_empty_text:"Kapcsolja be az értesítéseket, hogy elsőként értesüljön.",assistant_eyebrow:"SZEMÉLYES SEGÍTSÉG",assistant_title:"Kleopátra szépségsegéd",assistant_description:"Segítünk szolgáltatást választani és megtalálni az Önhöz illő ajánlatot.",locations_eyebrow:"KLEOPÁTRA SZALONOK",locations_title:"Találja meg a legközelebbi szalont",reviews_eyebrow:"VÉLEMÉNYEK",reviews_title:"Mondja el, milyen volt",footer_text:"Kleopátra Szépségszalonok"}};
const appConfigText=(v:any,fallback:string,max=500)=>typeof v==='string'?v.trim().slice(0,max):fallback;
const appColor=(v:any,fallback:string)=>/^#[0-9a-f]{6}$/i.test(String(v||''))?String(v):fallback;
function cleanAppConfig(raw:any){const d=raw?.design||{},m=raw?.media||{},v=raw?.visibility||{},t=raw?.texts||{};const texts:any={};for(const[k,val]of Object.entries(defaultAppConfig.texts))texts[k]=appConfigText(t[k],String(val),k.includes('description')||k.includes('empty_text')?1200:180);return{design:{primary_color:appColor(d.primary_color,defaultAppConfig.design.primary_color),accent_color:appColor(d.accent_color,defaultAppConfig.design.accent_color),background_color:appColor(d.background_color,defaultAppConfig.design.background_color),surface_color:appColor(d.surface_color,defaultAppConfig.design.surface_color),text_color:appColor(d.text_color,defaultAppConfig.design.text_color),hero_color:appColor(d.hero_color,defaultAppConfig.design.hero_color),hero_text_color:appColor(d.hero_text_color,defaultAppConfig.design.hero_text_color),border_radius:Math.max(8,Math.min(48,Number(d.border_radius)||26)),font_family:['Inter','Montserrat','Georgia','Arial'].includes(String(d.font_family))?String(d.font_family):'Inter',font_scale:Math.max(.85,Math.min(1.25,Number(d.font_scale)||1))},media:{logo_url:appConfigText(m.logo_url,defaultAppConfig.media.logo_url,1500000),hero_image_url:appConfigText(m.hero_image_url,'',1500000),entry_image_url:appConfigText(m.entry_image_url,'',1500000)},visibility:Object.fromEntries(Object.keys(defaultAppConfig.visibility).map(k=>[k,v[k]!==false])),texts};}
async function loadAppConfig(){const row=(await db.query(`SELECT config,updated_at FROM mobile_app_settings WHERE id=1`)).rows[0];return{config:cleanAppConfig(row?.config||defaultAppConfig),updated_at:row?.updated_at||null};}
let vapidPromise: Promise<{publicKey:string;privateKey:string}> | null = null;
async function vapidConfig() {
  const envPublic=String(process.env.VAPID_PUBLIC_KEY||"").trim(),envPrivate=String(process.env.VAPID_PRIVATE_KEY||"").trim();
  if(envPublic&&envPrivate)return{publicKey:envPublic,privateKey:envPrivate};
  if(!vapidPromise)vapidPromise=(async()=>{
    await db.query(`CREATE TABLE IF NOT EXISTS app_runtime_secrets(secret_key text PRIMARY KEY,secret_value text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
    const existing=await db.query(`SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`);
    const values=Object.fromEntries(existing.rows.map((x:any)=>[x.secret_key,x.secret_value]));
    if(values.vapid_public_key&&values.vapid_private_key)return{publicKey:values.vapid_public_key,privateKey:values.vapid_private_key};
    const generated=webpush.generateVAPIDKeys();
    await db.query(`INSERT INTO app_runtime_secrets(secret_key,secret_value) VALUES('vapid_public_key',$1),('vapid_private_key',$2) ON CONFLICT(secret_key) DO NOTHING`,[generated.publicKey,generated.privateKey]);
    const saved=await db.query(`SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`);
    const final=Object.fromEntries(saved.rows.map((x:any)=>[x.secret_key,x.secret_value]));
    return{publicKey:final.vapid_public_key,privateKey:final.vapid_private_key};
  })().catch(error=>{vapidPromise=null;throw error});
  return vapidPromise;
}
let ensurePromise: Promise<void> | null = null;
async function ensure() {
  if(ensurePromise)return ensurePromise;
  ensurePromise=db.query(`CREATE TABLE IF NOT EXISTS daily_action_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,headline text NOT NULL,description_html text NOT NULL,image_url text,cta_label text DEFAULT 'Foglalok',cta_url text DEFAULT '/foglalas',discount_text text,valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,audience jsonb DEFAULT '{"type":"all"}'::jsonb,channels jsonb DEFAULT '["app"]'::jsonb,status text DEFAULT 'draft',recipient_count int DEFAULT 0,sent_email int DEFAULT 0,sent_sms int DEFAULT 0,sent_push int DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS headline text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS description_html text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS image_url text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS cta_label text DEFAULT 'Foglalok';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS cta_url text DEFAULT '/foglalas';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS discount_text text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS valid_from timestamptz;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS valid_until timestamptz;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS audience jsonb DEFAULT '{"type":"all"}'::jsonb;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS channels jsonb DEFAULT '["app"]'::jsonb;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS recipient_count int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_email int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_sms int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_push int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE daily_action_campaigns ALTER COLUMN image_url TYPE text USING image_url::text;ALTER TABLE daily_action_campaigns ALTER COLUMN description_html TYPE text USING description_html::text;ALTER TABLE daily_action_campaigns ALTER COLUMN headline TYPE text USING headline::text;
ALTER TABLE daily_action_campaigns DROP CONSTRAINT IF EXISTS daily_action_campaign_name_uq;DROP INDEX IF EXISTS daily_action_campaign_name_uq;
CREATE TABLE IF NOT EXISTS app_push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),endpoint text UNIQUE NOT NULL,subscription jsonb NOT NULL,client_id uuid,active boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());ALTER TABLE app_push_subscriptions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();ALTER TABLE app_push_subscriptions ADD COLUMN IF NOT EXISTS last_reengagement_at timestamptz;ALTER TABLE app_push_subscriptions ADD COLUMN IF NOT EXISTS last_offer_notification_id uuid;
CREATE TABLE IF NOT EXISTS mobile_app_settings(id integer PRIMARY KEY,config jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz DEFAULT now());`).then(async()=>{await ensureDailyActionApplicabilitySchema();}).then(()=>undefined).catch(error=>{ensurePromise=null;throw error});
  return ensurePromise;
}
function campaignInput(body: any) {
  const b = body || {};
  const name = String(b.name || "").trim();
  const headline = String(b.headline || "").trim();
  const descriptionHtml = String(b.description_html || "").trim();
  const validFrom = new Date(b.valid_from);
  const validUntil = new Date(b.valid_until);
  const rawChannels = Array.isArray(b.channels) ? b.channels : [];
  const channels = Array.from(new Set(rawChannels
    .map((x: unknown) => String(x) === "push" ? "app" : String(x))
    .filter((x: string) => ["email", "sms", "app"].includes(x))));
  if (!name || !headline || !descriptionHtml)
    return { error: "A kampánynév, a főcím és az akció leírása kötelező." };
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()))
    return { error: "Adjon meg érvényes kezdő és záró időpontot." };
  if (validUntil <= validFrom)
    return { error: "Az akció vége legyen későbbi a kezdésnél." };
  if (!channels.length)
    return { error: "Válasszon legalább egy kiküldési csatornát." };
  return { name, headline, descriptionHtml, validFrom, validUntil, channels };
}
async function recipients(a: any) {
  let w = `COALESCE(c.marketing_consent,false)=true`;
  if (a?.type === "new")
    w += ` AND c.created_at>=now()-interval '${Math.max(1, Number(a.days || 30))} days'`;
  if (a?.type === "inactive")
    w += ` AND COALESCE(c.altegio_last_visit,c.updated_at)<now()-interval '${Math.max(1, Number(a.days || 180))} days'`;
  if (a?.type === "loyalty")
    w += ` AND EXISTS(SELECT 1 FROM loyalty_program_members pm WHERE pm.client_id=c.id AND pm.tier_code=ANY(ARRAY[${(a.tiers || ["gold"]).map((x: string) => `'${String(x).replace(/'/g, "")}'`).join(",")}]))`;
  if (a?.type === "pass_holders")
    w += ` AND EXISTS(SELECT 1 FROM loyalty_accounts la JOIN loyalty_passes lp ON lp.account_id=la.id WHERE la.customer_id::text=c.id::text AND lp.status='active')`;
  return db.query(
    `SELECT c.id,COALESCE(NULLIF(c.full_name,''),c.name,'Vendég')name,c.email,c.phone,c.email_consent,c.sms_consent FROM clients c WHERE ${w} LIMIT 5000`,
  );
}
router.use(async (_q, _s, n) => {
  try {
    await ensure();
    n();
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.use(async (_q, _s, n) => {
  try {
    await ensure();
    n();
  } catch (e) {
    n(e);
  }
});
router.get("/", async (_q, res, n) => {
  try {
    const vapid=await vapidConfig();
    res.json({
      campaigns: (
        await db.query(
          `SELECT * FROM daily_action_campaigns ORDER BY created_at DESC`,
        )
      ).rows,
      vapid_public_key: vapid.publicKey,
    });
  } catch (e) {
    n(e);
  }
});
router.get("/app-config",async(_q,res,n)=>{try{const saved=await loadAppConfig();res.json({...saved,defaults:defaultAppConfig})}catch(e){n(e)}});
router.put("/app-config",async(req,res,n)=>{try{const config=cleanAppConfig(req.body?.config||req.body);const row=(await db.query(`INSERT INTO mobile_app_settings(id,config,updated_at)VALUES(1,$1::jsonb,now()) ON CONFLICT(id)DO UPDATE SET config=$1::jsonb,updated_at=now() RETURNING config,updated_at`,[JSON.stringify(config)])).rows[0];res.json({config:row.config,updated_at:row.updated_at})}catch(e){n(e)}});
router.post("/audience-preview", async (req, res, n) => {
  try {
    const r = await recipients(req.body);
    res.json({
      count: r.rowCount,
      email: r.rows.filter((x) => x.email && x.email_consent).length,
      sms: r.rows.filter((x) => x.phone && x.sms_consent).length,
    });
  } catch (e) {
    n(e);
  }
});
router.post("/", async (req, res, n) => {
  try {
    const b = req.body,
      input = campaignInput(b);
    if ("error" in input) return res.status(400).json({ message: input.error });
    const
      { rows } = await db.query(
        `INSERT INTO daily_action_campaigns(name,headline,description_html,image_url,cta_label,cta_url,discount_text,location_id,service_id,discount_percent,valid_from,valid_until,audience,channels,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,'draft')RETURNING *`,
        [
          input.name,
          input.headline,
          input.descriptionHtml,
          b.image_url || null,
          b.cta_label || "Foglalok",
          b.cta_url || "/foglalas",
          b.discount_text || null,
          b.location_id || null,
          b.service_id || null,
          b.discount_percent === undefined || b.discount_percent === null || b.discount_percent === "" ? null : Math.max(0,Math.min(100,Number(b.discount_percent)||0)),
          input.validFrom,
          input.validUntil,
          JSON.stringify(b.audience || { type: "all" }),
          JSON.stringify(input.channels),
        ],
      );
    res.status(201).json(rows[0]);
  } catch (e: any) {
    const diagnosticId = `DA-${Date.now().toString(36).toUpperCase()}`;
    console.error("[daily-action-save]", diagnosticId, e?.code, e?.message, e?.detail);
    const known: Record<string, string> = {
      "23505": "Ezzel a névvel már létezik akció. Frissítse az oldalt, majd próbálja újra.",
      "22P02": "Az akció egyik mezője érvénytelen formátumú.",
      "42703": "Az akciók adatbázissémája frissítésre szorul.",
      "22001": "A kampány egyik szöveges vagy képes mezője túl hosszú volt.",
    };
    res.status(500).json({
      code: "DAILY_ACTION_SAVE_FAILED",
      message: known[e?.code] || "Az akció mentése nem sikerült. A hibát naplóztuk.",
      diagnostic_id: diagnosticId,
      database_code: e?.code || null,
    });
  }
});
router.patch("/:id", async (req, res, n) => {
  try {
    const current = (await db.query(`SELECT * FROM daily_action_campaigns WHERE id=$1::uuid`, [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ message: "Az akció nem található." });
    const b = {...current,...req.body,channels:req.body?.channels ?? current.channels ?? ["app"]},
      input = campaignInput(b);
    if ("error" in input) return res.status(400).json({ message: input.error });
    const
      { rows } = await db.query(
        `UPDATE daily_action_campaigns SET name=$2,headline=$3,description_html=$4,image_url=$5,cta_label=$6,cta_url=$7,discount_text=$8,location_id=$9,service_id=$10,discount_percent=$11,valid_from=$12,valid_until=$13,audience=$14::jsonb,channels=$15::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,
        [
          req.params.id,
          input.name,
          input.headline,
          input.descriptionHtml,
          b.image_url || null,
          b.cta_label || "Foglalok",
          b.cta_url || "/foglalas",
          b.discount_text || null,
          b.location_id || null,
          b.service_id || null,
          b.discount_percent === undefined || b.discount_percent === null || b.discount_percent === "" ? null : Math.max(0,Math.min(100,Number(b.discount_percent)||0)),
          input.validFrom,
          input.validUntil,
          JSON.stringify(b.audience || { type: "all" }),
          JSON.stringify(input.channels),
        ],
      );
    if (!rows[0]) return res.status(404).json({ message: "Az akció nem található." });
    res.json(rows[0]);
  } catch (e: any) {
    const diagnosticId = `DA-${Date.now().toString(36).toUpperCase()}`;
    console.error("[daily-action-update]", diagnosticId, e?.code, e?.message, e?.detail);
    res.status(500).json({code:"DAILY_ACTION_UPDATE_FAILED",message:"Az akció módosítása nem sikerült. A hibát naplóztuk.",diagnostic_id:diagnosticId,database_code:e?.code||null});
  }
});
router.post("/:id/publish", async (req, res, n) => {
  try {
    const c = (
      await db.query(`SELECT * FROM daily_action_campaigns WHERE id=$1::uuid`, [
        req.params.id,
      ])
    ).rows[0];
    if (!c) return res.status(404).json({ message: "Az akció nem található." });
    const r = await recipients(c.audience),
      channels: string[] = c.channels || [];
    let email = 0,
      sms = 0,
      push = 0,
      pushFailures = 0;
    for (const x of r.rows) {
      if (channels.includes("email") && x.email && x.email_consent)
        try {
          await sendEmail({
            to: x.email,
            subject: c.headline,
            text: c.headline,
            html: `<div style="margin:0;background:#f5f0eb;padding:28px;font-family:Arial,sans-serif;color:#251a1f"><div style="max-width:680px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e9ddd3"><div style="padding:22px;text-align:center;border-bottom:1px solid #eadfce"><img src="${kleopatraLogoUrl}" alt="Kleopátra Szépségszalonok" style="display:block;width:100%;max-width:420px;height:auto;margin:0 auto"/></div>${c.image_url ? `<img src="${c.image_url}" alt="" style="display:block;width:100%;max-height:360px;object-fit:cover">` : ""}<div style="padding:34px"><h1 style="font-family:Georgia,serif;color:#39251f">${c.headline}</h1>${c.description_html}<p><a href="${c.cta_url}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#17100d;color:#fff;text-decoration:none;font-weight:bold">${c.cta_label}</a></p></div></div></div>`,
          });
          email++;
        } catch {}
      if (channels.includes("sms") && x.phone && x.sms_consent)
        try {
          await sendSms({
            to: x.phone,
            text: `Kleopátra: ${c.headline}. ${c.discount_text || ""} Foglalás: ${c.cta_url}`,
          });
          sms++;
        } catch {}
    }
    const vapid=await vapidConfig();
    if (channels.includes("app")) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:info@kleoszalon.hu",
        vapid.publicKey,
        vapid.privateKey,
      );
      for (const s of (
        await db.query(`SELECT * FROM app_push_subscriptions WHERE active=true`)
      ).rows)
        try {
          await webpush.sendNotification(
            s.subscription,
            JSON.stringify({
              title: c.headline,
              body: c.discount_text || "Új Kleopátra napi akció",
              image: c.image_url,
              url: "/kleopatra-app",
            }),
          );
          push++;
        } catch (pushError:any) {
          pushFailures++;
          if ([404,410].includes(Number(pushError?.statusCode||pushError?.status)))
            await db.query(
              `UPDATE app_push_subscriptions SET active=false WHERE id=$1`,
              [s.id],
            );
          else console.warn("[daily-action-push] transient failure",pushError?.statusCode,pushError?.message||pushError);
        }
    }
    await db.query(
      `UPDATE daily_action_campaigns SET status='published',recipient_count=$2,sent_email=$3,sent_sms=$4,sent_push=$5,updated_at=now()WHERE id=$1`,
      [c.id, r.rowCount, email, sms, push],
    );
    const activeDevices=Number((await db.query(`SELECT COUNT(*)::int count FROM app_push_subscriptions WHERE active=true`)).rows[0]?.count||0);
    res.json({ recipients: r.rowCount, email, sms, push, push_failures:pushFailures, active_devices:activeDevices, push_configured:Boolean(vapid.publicKey&&vapid.privateKey) });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.get("/", async (req, res, n) => {
  try {
    const vapid=await vapidConfig();
    const actions=await applicableDailyActions(db,{locationId:String(req.query.location_id||'').trim()||null,clientId:String(req.query.client_id||'').trim()||null,at:new Date()});
    const app=await loadAppConfig();
    res.json({
      actions,
      vapid_public_key: vapid.publicKey,
      app_config:app.config,
      app_config_updated_at:app.updated_at,
    });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.post("/subscribe", async (req, res, n) => {
  try {
    const s = req.body?.subscription;
    if (!s?.endpoint)
      return res
        .status(400)
        .json({ message: "Érvénytelen push-feliratkozás." });
    const saved=await db.query(
      `INSERT INTO app_push_subscriptions(endpoint,subscription,last_seen_at)VALUES($1,$2,now())ON CONFLICT(endpoint)DO UPDATE SET subscription=$2,active=true,last_seen_at=now(),updated_at=now() RETURNING id,last_offer_notification_id`,
      [s.endpoint, s],
    );
    const current=(await db.query(`SELECT id,headline,discount_text,image_url FROM daily_action_campaigns WHERE status='published' AND valid_from<=now() AND valid_until>=now() ORDER BY updated_at DESC LIMIT 1`)).rows[0];
    let currentOfferSent=false;
    if(current&&String(saved.rows[0]?.last_offer_notification_id||"")!==String(current.id))try{
      const vapid=await vapidConfig();webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:info@kleoszalon.hu",vapid.publicKey,vapid.privateKey);
      await webpush.sendNotification(s,JSON.stringify({title:current.headline,body:current.discount_text||"Aktuális Kleopátra ajánlat",image:current.image_url,url:"/kleopatra-app",tag:`kleopatra-offer-${current.id}`}));
      await db.query(`UPDATE app_push_subscriptions SET last_offer_notification_id=$2 WHERE id=$1`,[saved.rows[0].id,current.id]);currentOfferSent=true;
    }catch(error:any){console.warn("[daily-action-subscribe-current]",error?.statusCode||"",error?.message||error)}
    res.json({ ok: true,current_offer_sent:currentOfferSent });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.post("/heartbeat",async(req,res,n)=>{try{const endpoint=String(req.body?.endpoint||"").trim();if(endpoint)await db.query(`UPDATE app_push_subscriptions SET last_seen_at=now(),updated_at=now(),active=true WHERE endpoint=$1`,[endpoint]);res.json({ok:true,reminder_after_days:7})}catch(e){n(e)}});

const fallbackAssistant=(q:string)=>{const s=q.toLowerCase();if(s.includes("haj"))return"A haj állapotához és a kívánt eredményhez illő kezelést érdemes választani. Az app foglalójában jelölje ki az alapszolgáltatást, és megmutatjuk a kapcsolódó ajánlatokat.";if(s.includes("bőr")||s.includes("arc"))return"Érzékenység vagy bőrpanasz esetén először szakemberes állapotfelmérést javaslunk. Az ajánló csak a valós Kleopátra-katalógusból kínál kiegészítést.";if(s.includes("akció")||s.includes("kedvez"))return"Az aktuális akciókat a kezdőlapon és a szolgáltatás kiválasztása után is megmutatjuk. A foglalás véglegesítése előtt mindig látható a becsült összeg.";return"Segítek eligazodni a szolgáltatások, foglalás, bérletek és aktuális ajánlatok között. Írja le röviden, milyen eredményt szeretne, majd válasszon a katalógusból."};
publicDailyActionsRouter.post("/assistant",async(req,res,n)=>{try{const question=String(req.body?.question||"").trim().slice(0,500);if(question.length<3)return res.status(400).json({message:"Írjon legalább néhány szót."});const key=String(process.env.OPENAI_API_KEY||"").trim();if(!key)return res.json({answer:fallbackAssistant(question),ai_used:false});try{const r:any=await axios.post("https://api.openai.com/v1/responses",{model:process.env.BOOKING_RECOMMENDATION_MODEL||"gpt-5-mini",store:false,max_output_tokens:220,input:[{role:"system",content:[{type:"input_text",text:"Te a Kleopátra Beauty App magyar nyelvű szépségsegédje vagy. Röviden, kedvesen válaszolj. Ne diagnosztizálj, ne ígérj egészségügyi eredményt, és ne találj ki árat vagy akciót. Foglaláshoz és aktuális ajánlatokhoz irányíts az app katalógusába."}]},{role:"user",content:[{type:"input_text",text:question}]}]},{headers:{Authorization:`Bearer ${key}`},timeout:10000});const answer=String(r.data?.output?.flatMap((x:any)=>x.content||[]).find((x:any)=>x.type==="output_text")?.text||"").trim();return res.json({answer:answer||fallbackAssistant(question),ai_used:Boolean(answer)})}catch{return res.json({answer:fallbackAssistant(question),ai_used:false})}}catch(e){n(e)}});

let reminderRunning=false;
async function sendInactiveReminders(){if(reminderRunning)return;reminderRunning=true;try{await ensure();const vapid=await vapidConfig();webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:info@kleoszalon.hu",vapid.publicKey,vapid.privateKey);const{rows}=await db.query(`SELECT id,subscription FROM app_push_subscriptions WHERE active=true AND last_seen_at<now()-interval '7 days' AND (last_reengagement_at IS NULL OR last_reengagement_at<last_seen_at OR last_reengagement_at<now()-interval '7 days') LIMIT 500`);for(const s of rows)try{await webpush.sendNotification(s.subscription,JSON.stringify({title:"A szépségre mindig érdemes időt szánni ✨",body:"Már egy hete nem találkoztunk. Nézze meg az új Kleopátra ajánlatokat, és ajándékozzon magának egy kis énidőt!",url:"/kleopatra-app"}));await db.query(`UPDATE app_push_subscriptions SET last_reengagement_at=now() WHERE id=$1`,[s.id])}catch{await db.query(`UPDATE app_push_subscriptions SET active=false WHERE id=$1`,[s.id])}}catch(e:any){console.warn("[app-reminder]",e?.message||e)}finally{reminderRunning=false}}
const reminderTimer=setInterval(()=>void sendInactiveReminders(),60*60*1000);reminderTimer.unref();setTimeout(()=>void sendInactiveReminders(),60_000).unref();
export default router;
