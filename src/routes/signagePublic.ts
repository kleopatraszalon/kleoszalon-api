import { Router } from "express";
import pool from "../db";
import * as https from "https";
import { classifyBookingCommunicationFailure } from "../booking/communicationFailureAnalysis";

/**
 * Public Signage API (NO AUTH)
 *
 * Mounted under: /api/signage
 *
 * Endpoints used by SignagePage.tsx:
 *  - GET /services        -> { services: ServiceItem[], fetchedAt }
 *  - GET /deals           -> { deals: Deal[] }
 *  - GET /videos          -> { videos: VideoItem[] }
 *  - GET /daily           -> { fitness: Quote|null, beauty: Quote|null }
 *  - GET /professionals   -> { professionals: Professional[] }
 *
 * IMPORTANT:
 *  - Do NOT require cookie/JWT here (display page must work without login)
 *  - Always return JSON
 */

const router = Router();

// -----------------------------
// Helpers
// -----------------------------
const nowIso = () => new Date().toISOString();

function safeText(v: any) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function safeNum(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// -----------------------------
// Villám akció + névnap helper (public)
// -----------------------------
const DEFAULT_NAMEDAY_TEMPLATE =
  "Ma a {names} nevű vendégeink 20% kedvezményben részesülnek!!!";

function ymdBudapest(d = new Date()) {
  // YYYY-MM-DD, Budapest időzóna szerint
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Budapest" });
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      https
        .get(
          url,
          { headers: { "User-Agent": "kleoszalon-signage/1.0", Accept: "application/json" } },
          (r) => {
            let data = "";
            r.on("data", (c) => (data += c));
            r.on("end", () => {
              const code = Number(r.statusCode || 0);
              if (code >= 400) return reject(new Error(`HTTP ${code}`));
              resolve(data);
            });
          }
        )
        .on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

type NamedayCache = { ymd: string; names: string[]; fetchedAt: number };
let namedayCache: NamedayCache | null = null;

function splitNames(raw: string): string[] {
  return String(raw || "")
    .split(/[,;\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchNamedayNamesHu(): Promise<string[]> {
  const today = ymdBudapest();

  // 6 órás cache (bőven elég)
  if (
    namedayCache &&
    namedayCache.ymd === today &&
    Date.now() - namedayCache.fetchedAt < 6 * 60 * 60 * 1000
  ) {
    return namedayCache.names;
  }

  // 1) Primary: Abalin (stabil, de néha üres / limit)
  try {
    const url =
      "https://nameday.abalin.net/api/V1/today?country=hu&timezone=Europe/Budapest";
    const txt = await httpsGet(url);
    let j: any = null;
    try {
      j = JSON.parse(txt);
    } catch {
      j = null;
    }

    // Abalin válaszok többféle formában jöhetnek -> próbáljunk robusztusak lenni
    const raw =
      j?.data?.namedays?.hu ??
      j?.data?.namedays?.HU ??
      j?.namedays?.hu ??
      j?.nameday?.hu ??
      j?.data?.name ??
      "";

    const names = splitNames(String(raw)).slice(0, 40);
    if (names.length) {
      namedayCache = { ymd: today, names, fetchedAt: Date.now() };
      return names;
    }
  } catch {
    // megyünk tovább fallbackra
  }

  // 2) Fallback: xsak.hu (ha az Abalin üres / nem elérhető)
  try {
    // xsak-nál tipikusan hónap-nap formátum kell (02-10 vagy 0210)
    const mmddDash = today.slice(5); // "MM-DD"
    const mmdd = mmddDash.replace("-", ""); // "MMDD"

    const candidates = [
      `https://nevnap.xsak.hu/json.php?datum=${mmddDash}`,
      `https://nevnap.xsak.hu/json.php?datum=${mmdd}`,
    ];

    for (const u of candidates) {
      try {
        const txt2 = await httpsGet(u);
        let j2: any = null;
        try {
          j2 = JSON.parse(txt2);
        } catch {
          j2 = null;
        }

        // xsak: gyakran { nev1:"...", nev2:"..." ... } vagy { data:{...} }
        const obj =
          j2?.data && typeof j2.data === "object" ? j2.data : j2;

        const names2 = Array.isArray(obj)
          ? obj.map(String)
          : Object.keys(obj || {})
              .filter((k) => /^nev\d+$/i.test(k) || /^name\d+$/i.test(k))
              .map((k) => String(obj[k]))
              .filter(Boolean);

        const cleaned = splitNames(names2.join(", ")).slice(0, 40);
        if (cleaned.length) {
          namedayCache = { ymd: today, names: cleaned, fetchedAt: Date.now() };
          return cleaned;
        }
      } catch {
        // próbáljuk a következőt
      }
    }
  } catch {
    // ignore
  }

  // ha minden kötél szakad (elvileg nem kéne), legyen üres, de ne dobjon hibát
  namedayCache = { ymd: today, names: [], fetchedAt: Date.now() };
  return [];
}

async function getSettingValue(key: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT value FROM public.signage_settings WHERE key = $1 LIMIT 1`, [key]);
    const v = r.rows?.[0]?.value;
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

// -----------------------------
// Services (public)
// -----------------------------
router.get("/services", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        s.id::text AS id,
        s.name,
        COALESCE(s.category, '') AS category,
        s.duration_min,
        COALESCE(s.price_text, '') AS price_text,
        COALESCE(s.priority, 0) AS priority
      FROM public.signage_services s
      LEFT JOIN public.signage_service_overrides o
        ON o.service_id = s.id
      WHERE COALESCE(s.show, true) = true
        AND COALESCE(o.enabled, true) = true
      ORDER BY COALESCE(s.priority, 0) DESC, s.updated_at DESC
      LIMIT 200;
      `
    );

    const services = rows.map((r: any) => ({
      id: safeText(r.id),
      name: safeText(r.name),
      category: safeText(r.category),
      durationMin: r.duration_min == null ? null : safeNum(r.duration_min, null as any),
      price_text: safeText(r.price_text),
      priority: safeNum(r.priority, 0),
    }));

    res.json({ services, fetchedAt: nowIso() });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Deals (public)
// -----------------------------
router.get("/deals", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        title,
        COALESCE(subtitle, '') AS subtitle,
        COALESCE(price_text, '') AS price_text,
        valid_from,
        valid_to,
        active,
        COALESCE(priority, 0) AS priority
      FROM public.signage_deals
      WHERE COALESCE(active, true) = true
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 20;
      `
    );

    res.json({ deals: rows });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Videos (public)
// -----------------------------
router.get("/videos", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        youtube_id,
        COALESCE(title, '') AS title,
        COALESCE(duration_sec, 60) AS duration_sec,
        COALESCE(priority, 0) AS priority
      FROM public.signage_videos
      WHERE COALESCE(enabled, true) = true
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 50;
      `
    );

    res.json({ videos: rows });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Daily (ticker quotes) (public)
// -----------------------------
router.get("/daily", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        category,
        text,
        COALESCE(author, '') AS author,
        COALESCE(priority, 0) AS priority
      FROM public.signage_quotes
      WHERE COALESCE(enabled, true) = true
        AND category IN ('fitness', 'beauty')
      ORDER BY category, COALESCE(priority, 0) DESC, updated_at DESC;
      `
    );

    const pick = (cat: string) => rows.find((r: any) => r.category === cat) || null;
    res.json({
      fitness: pick("fitness"),
      beauty: pick("beauty"),
      fetchedAt: nowIso(),
    });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Professionals (public)
// -----------------------------
router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        name,
        COALESCE(title, '') AS title,
        COALESCE(note, '') AS note,
        NULLIF(BTRIM(COALESCE(photo_url, '')), '') AS photo_url,
        COALESCE(priority, 0) AS priority,
        COALESCE(is_free, true) AS is_free
      FROM public.signage_professionals
      WHERE COALESCE(show, true) = true
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(is_free, true) DESC, updated_at DESC
      LIMIT 30;
      `
    );

    const professionals = rows.map((r: any) => ({
      id: safeText(r.id),
      name: safeText(r.name),
      title: safeText(r.title),
      note: safeText(r.note),
      photo_url: r.photo_url ? safeText(r.photo_url) : null,
      priority: safeNum(r.priority, 0),
      is_free: !!r.is_free,
      available: !!r.is_free, // legacy alias for older UIs
    }));

    res.json({ professionals });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});


// -----------------------------
// Villám akció (public)
// -----------------------------
router.get("/flash", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        title,
        COALESCE(body, '') AS body,
        start_at,
        end_at,
        COALESCE(priority, 0) AS priority
      FROM public.signage_flash_promos
      WHERE COALESCE(enabled, true) = true
        AND (start_at IS NULL OR start_at <= now())
        AND (end_at IS NULL OR end_at >= now())
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 1;
      `
    );

    const r = rows?.[0] || null;
    const flash = r
      ? {
          id: safeText(r.id),
          title: safeText(r.title),
          body: safeText(r.body),
          start_at: r.start_at ?? null,
          end_at: r.end_at ?? null,
          priority: safeNum(r.priority, 0),
        }
      : null;

    res.json({ flash, fetchedAt: nowIso() });
  } catch (e: any) {
    // ha DB épp halott, a kijelző akkor is fusson: inkább "nincs villám akció"
    res.json({ flash: null, error: safeText(e?.message || e), fetchedAt: nowIso() });
  }
});

// -----------------------------
// Névnap (public) – automatikusan internetről
// -----------------------------
router.get("/nameday", async (_req, res) => {
  const date = ymdBudapest();
  try {
    const [names, templateDb] = await Promise.all([
      fetchNamedayNamesHu().catch(() => [] as string[]),
      getSettingValue("nameday_template"),
    ]);

    // Üzleti igény: csak a *fő névnap* kell (a legtöbb adatforrás a fő nevet elsőként adja vissza).
    const mainName = names?.[0] ? String(names[0]).trim() : "";
    const template = (templateDb && templateDb.trim()) || DEFAULT_NAMEDAY_TEMPLATE;
    const message = template
      .replace(/\{names\}/g, mainName)
      .replace(/\{date\}/g, date);

    res.json({
      ok: !!mainName,
      date,
      names: mainName ? [mainName] : [],
      template,
      message,
      fetchedAt: nowIso(),
      source: "nameday.abalin.net",
    });
  } catch (e: any) {
    const template = DEFAULT_NAMEDAY_TEMPLATE;
    res.json({
      ok: false,
      date,
      names: [],
      template,
      message: template.replace(/\{names\}/g, "").replace(/\{date\}/g, date),
      error: safeText(e?.message || e),
      fetchedAt: nowIso(),
      source: "nameday.abalin.net",
    });
  }
});

// TEMPORARY 2026-08-14: anonymized aggregate probe for the 1534 failed booking notifications.
// No recipient, location, appointment id, or raw error text is returned. Remove after one production read.
router.get("/booking-failure-probe-20260814", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await pool.query(`SELECT channel,event_type,error_text,failed_at,created_at FROM booking_communication_queue WHERE status='failed' ORDER BY COALESCE(failed_at,created_at) DESC`);
    const causeMap = new Map<string, { key:string; label:string; priority:string; count:number }>();
    const channelMap = new Map<string,number>();
    const eventMap = new Map<string,number>();
    const now = Date.now();
    const day = 24*60*60*1000;
    let failedLast24h=0,failedLast7d=0,missingErrorText=0;
    for(const row of rows){
      const cause=classifyBookingCommunicationFailure(row.error_text,row.channel);
      const cur=causeMap.get(cause.key)||{key:cause.key,label:cause.label,priority:cause.priority,count:0};cur.count++;causeMap.set(cause.key,cur);
      const channel=String(row.channel||"unknown");channelMap.set(channel,(channelMap.get(channel)||0)+1);
      const event=String(row.event_type||"unknown");eventMap.set(event,(eventMap.get(event)||0)+1);
      if(!String(row.error_text||"").trim())missingErrorText++;
      const ts=new Date(row.failed_at||row.created_at).getTime();if(Number.isFinite(ts)){if(now-ts<=day)failedLast24h++;if(now-ts<=7*day)failedLast7d++;}
    }
    const dup=await pool.query(`WITH ordered AS (SELECT appointment_id,event_type,channel,recipient,created_at,LAG(created_at) OVER(PARTITION BY appointment_id,event_type,channel,recipient ORDER BY created_at) prev_created_at FROM booking_communication_queue WHERE appointment_id IS NOT NULL AND status<>'cancelled') SELECT COUNT(*)::int duplicate_rows FROM ordered WHERE prev_created_at IS NOT NULL AND created_at>=prev_created_at AND created_at-prev_created_at<=interval '10 seconds'`);
    const total=rows.length;
    const counts=(map:Map<string,number>)=>[...map.entries()].map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count);
    const causes=[...causeMap.values()].sort((a,b)=>b.count-a.count).map(x=>({...x,percentage:total?Math.round(x.count/total*1000)/10:0}));
    res.json({generated_at:nowIso(),total_failed:total,failed_last_24h:failedLast24h,failed_last_7d:failedLast7d,stale_older_than_7d:Math.max(0,total-failedLast7d),missing_error_text:missingErrorText,duplicate_candidates:Number(dup.rows[0]?.duplicate_rows||0),causes,channels:counts(channelMap),events:counts(eventMap)});
  } catch (_e) {
    res.status(500).json({error:"booking_failure_probe_failed"});
  }
});

export default router;
