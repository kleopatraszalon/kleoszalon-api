import { Router } from "express";
import pool from "../db";
import * as https from "https";

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

export default router;
