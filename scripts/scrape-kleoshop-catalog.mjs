import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'https://www.kleoshop.hu/';
const ORIGIN = new URL(ROOT).origin;
const MAX_PAGES = Number(process.env.KLEOSHOP_MAX_PAGES || 3500);
const CONCURRENCY = Number(process.env.KLEOSHOP_CONCURRENCY || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.KLEOSHOP_TIMEOUT_MS || 18000);
const outDir = path.resolve(process.cwd(), 'artifacts');

const blockedPathFragments = [
  '/account', '/login', '/register', '/cart', '/checkout', '/compare', '/wishlist',
  '/search', '/information/contact', '/affiliate', '/order', '/return', '/download',
];
const blockedExt = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|map|woff2?|ttf|eot|pdf|zip|xml)(?:$|\?)/i;

function decodeHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(raw, base = ROOT) {
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.origin !== ORIGIN) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (!['page', 'limit', 'sort', 'order'].includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    const normalized = u.toString();
    if (blockedExt.test(normalized)) return null;
    const lower = u.pathname.toLowerCase();
    if (blockedPathFragments.some(fragment => lower.includes(fragment))) return null;
    return normalized;
  } catch {
    return null;
  }
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KleopatraCatalogMigration/1.0; +https://kleoszalon.hu)',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'hu-HU,hu;q=0.9,en;q=0.5',
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { text: await response.text(), finalUrl: response.url, contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 450 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function extractLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => decodeHtml(match[1]));
}

async function discoverSitemaps() {
  const candidates = new Set([
    new URL('/sitemap.xml', ROOT).toString(),
    new URL('/sitemap_index.xml', ROOT).toString(),
    new URL('/index.php?route=feed/google_sitemap', ROOT).toString(),
  ]);
  try {
    const robots = await fetchText(new URL('/robots.txt', ROOT).toString(), 1);
    for (const match of robots.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) candidates.add(match[1]);
  } catch {}

  const urls = new Set();
  const seenMaps = new Set();
  const queue = [...candidates];
  while (queue.length && seenMaps.size < 30) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenMaps.has(sitemapUrl)) continue;
    seenMaps.add(sitemapUrl);
    try {
      const { text } = await fetchText(sitemapUrl, 1);
      const locs = extractLocs(text);
      for (const loc of locs) {
        if (/\.xml(?:$|\?)/i.test(loc) || /sitemap/i.test(loc)) queue.push(loc);
        else {
          const normalized = normalizeUrl(loc);
          if (normalized) urls.add(normalized);
        }
      }
      console.log(`Sitemap OK: ${sitemapUrl} -> ${locs.length} loc`);
    } catch (error) {
      console.log(`Sitemap skip: ${sitemapUrl} (${error?.message || error})`);
    }
  }
  return urls;
}

function extractLinks(html, base) {
  const links = new Set();
  for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const raw = match[1] || match[2] || match[3];
    const normalized = normalizeUrl(raw, base);
    if (normalized) links.add(normalized);
  }
  for (const match of String(html).matchAll(/<link\b[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const normalized = normalizeUrl(match[1], base);
    if (normalized) links.add(normalized);
  }
  return links;
}

function findJsonLdProducts(html) {
  const found = [];
  const breadcrumbs = [];
  const blocks = [...String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some(t => String(t).toLowerCase() === 'product')) found.push(node);
    if (types.some(t => String(t).toLowerCase() === 'breadcrumblist') && Array.isArray(node.itemListElement)) {
      const parts = node.itemListElement
        .map(entry => entry?.item?.name || entry?.name || entry?.item)
        .filter(Boolean)
        .map(value => decodeHtml(String(value)));
      if (parts.length > breadcrumbs.length) breadcrumbs.splice(0, breadcrumbs.length, ...parts);
    }
    if (node['@graph']) walk(node['@graph']);
  }

  for (const block of blocks) {
    const raw = decodeHtml(block[1]).replace(/^\uFEFF/, '');
    try { walk(JSON.parse(raw)); } catch {
      try { walk(JSON.parse(block[1].trim())); } catch {}
    }
  }
  return { products: found, breadcrumbs };
}

function extractMeta(html, property) {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["'][^>]*>`, 'i'),
  ];
  for (const re of patterns) {
    const match = String(html).match(re);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function extractH1(html) {
  const match = String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? decodeHtml(match[1]) : '';
}

function extractBreadcrumbFallback(html) {
  const containers = String(html).match(/<(?:ul|ol|div)\b[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:ul|ol|div)>/i);
  if (!containers) return [];
  const parts = [];
  for (const match of containers[1].matchAll(/<(?:a|span|li)\b[^>]*>([\s\S]*?)<\/(?:a|span|li)>/gi)) {
    const value = decodeHtml(match[1]);
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts;
}

function cleanBreadcrumbs(parts, productName) {
  return parts
    .map(decodeHtml)
    .filter(Boolean)
    .filter(value => !/^(?:főoldal|kezdőlap|home|kategóriák|termékek)$/i.test(value))
    .filter(value => value.toLocaleLowerCase('hu-HU') !== String(productName || '').toLocaleLowerCase('hu-HU'));
}

function offerFrom(product) {
  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const price = Number(offers?.price ?? offers?.lowPrice ?? product?.price ?? NaN);
  return {
    price: Number.isFinite(price) ? price : null,
    currency: String(offers?.priceCurrency || 'HUF').toUpperCase(),
    availability: String(offers?.availability || '').split('/').pop() || null,
  };
}

function extractProduct(html, pageUrl) {
  const { products, breadcrumbs: jsonBreadcrumbs } = findJsonLdProducts(html);
  let data = products[0] || null;
  const ogType = extractMeta(html, 'og:type').toLowerCase();
  const looksLikeProduct = Boolean(data) || ogType === 'product' || /(?:product-info|product-page|product[_-]id)/i.test(html) && /(?:Kosárba|add\s*to\s*cart)/i.test(html);
  if (!looksLikeProduct) return null;

  const name = decodeHtml(data?.name || extractMeta(html, 'og:title') || extractH1(html));
  if (!name) return null;
  const offer = offerFrom(data || {});
  let price = offer.price;
  if (price == null) {
    const metaPrice = extractMeta(html, 'product:price:amount');
    if (metaPrice) price = Number(String(metaPrice).replace(/\s/g, '').replace(',', '.'));
  }
  if (price == null || !Number.isFinite(price)) {
    const match = String(html).match(/(?:price|ár)[^>]{0,80}(?:content=["']\s*)?([\d\s.]+)\s*(?:Ft|HUF)/i);
    if (match) price = Number(match[1].replace(/[^\d]/g, ''));
  }

  const fallbackBreadcrumbs = extractBreadcrumbFallback(html);
  const breadcrumbs = cleanBreadcrumbs(jsonBreadcrumbs.length ? jsonBreadcrumbs : fallbackBreadcrumbs, name);
  const imageRaw = Array.isArray(data?.image) ? data.image[0] : data?.image;
  const image = imageRaw?.url || imageRaw || extractMeta(html, 'og:image') || null;
  const description = decodeHtml(data?.description || extractMeta(html, 'description') || extractMeta(html, 'og:description')) || null;
  const sku = decodeHtml(data?.sku || data?.mpn || '') || null;
  const canonical = normalizeUrl(extractMeta(html, 'og:url') || data?.url || pageUrl, pageUrl) || pageUrl;
  const productCategory = decodeHtml(data?.category || '') || null;

  return {
    source_url: canonical,
    name,
    sku,
    price_gross: price == null || !Number.isFinite(price) ? null : Math.round(price * 100) / 100,
    currency: offer.currency || 'HUF',
    availability: offer.availability,
    image_url: image ? new URL(String(image), pageUrl).toString() : null,
    description,
    breadcrumbs,
    source_category: productCategory,
  };
}

function dedupeProducts(products) {
  const byUrl = new Map();
  for (const product of products) {
    const key = product.source_url || `${product.name}|${product.price_gross ?? ''}`;
    const current = byUrl.get(key);
    if (!current || (product.breadcrumbs?.length || 0) > (current.breadcrumbs?.length || 0)) byUrl.set(key, product);
  }
  return [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name, 'hu'));
}

function categorySummary(products) {
  const counts = new Map();
  for (const product of products) {
    const pathKey = product.breadcrumbs?.join(' > ') || product.source_category || 'Besorolatlan';
    counts.set(pathKey, (counts.get(pathKey) || 0) + 1);
  }
  return [...counts.entries()].map(([category_path, count]) => ({ category_path, count })).sort((a, b) => b.count - a.count || a.category_path.localeCompare(b.category_path, 'hu'));
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const sitemapUrls = await discoverSitemaps();
  const queue = [ROOT, ...sitemapUrls];
  const queued = new Set(queue.map(url => normalizeUrl(url)).filter(Boolean));
  const visited = new Set();
  const products = [];
  const failures = [];

  async function processUrl(url) {
    try {
      const { text, finalUrl, contentType } = await fetchText(url);
      if (!/html|xhtml/i.test(contentType) && !/<html/i.test(text)) return;
      const pageUrl = normalizeUrl(finalUrl) || url;
      const product = extractProduct(text, pageUrl);
      if (product) products.push(product);
      for (const link of extractLinks(text, pageUrl)) {
        if (visited.has(link) || queued.has(link) || queued.size >= MAX_PAGES * 2) continue;
        queued.add(link);
        queue.push(link);
      }
    } catch (error) {
      failures.push({ url, error: error?.message || String(error) });
    }
  }

  while (queue.length && visited.size < MAX_PAGES) {
    const batch = [];
    while (queue.length && batch.length < CONCURRENCY && visited.size + batch.length < MAX_PAGES) {
      const raw = queue.shift();
      const url = normalizeUrl(raw);
      if (!url || visited.has(url)) continue;
      visited.add(url);
      batch.push(url);
    }
    if (!batch.length) continue;
    await Promise.all(batch.map(processUrl));
    if (visited.size % 50 < CONCURRENCY) console.log(`Progress: ${visited.size} pages, ${products.length} product hits, queue ${queue.length}`);
  }

  const uniqueProducts = dedupeProducts(products);
  const categories = categorySummary(uniqueProducts);
  const payload = {
    generated_at: new Date().toISOString(),
    source: ROOT,
    crawled_pages: visited.size,
    failed_pages: failures.length,
    product_count: uniqueProducts.length,
    categories,
    products: uniqueProducts,
    failures: failures.slice(0, 100),
  };

  await fs.writeFile(path.join(outDir, 'kleoshop-catalog.json'), JSON.stringify(payload, null, 2), 'utf8');
  const summary = [
    '# Kleoshop catalog scan',
    '',
    `- Generated: ${payload.generated_at}`,
    `- Crawled pages: ${payload.crawled_pages}`,
    `- Failed pages: ${payload.failed_pages}`,
    `- Unique products: ${payload.product_count}`,
    '',
    '## Category paths',
    '',
    ...categories.map(item => `- ${item.count} × ${item.category_path}`),
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'kleoshop-catalog-summary.md'), summary, 'utf8');
  console.log(summary);

  if (uniqueProducts.length < 150) {
    console.error(`Catalog guard failed: only ${uniqueProducts.length} unique products discovered.`);
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
