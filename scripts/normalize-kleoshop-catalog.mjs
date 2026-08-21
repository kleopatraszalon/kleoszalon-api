import fs from 'node:fs/promises';
import path from 'node:path';

const input = path.resolve('artifacts/kleoshop-catalog.json');
const output = path.resolve('src/data/kleoshop-catalog.json');

const norm = (value = '') => String(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

function classify(product) {
  const labels = (product.source_categories || []).map((item) => item.label || '');
  const cats = norm(labels.join(' | '));
  const name = norm(product.name || '');
  const all = `${cats} | ${name}`;
  let main = 'SALON_PRODUCTS';
  let sub = 'SALON_OTHER';
  let group = 'Szalon termékek';
  let subgroup = 'Egyéb termékek';

  if (cats.includes('kedvezmenyek cegeknek')) {
    [main, sub, group, subgroup] = ['COMPANY_DISCOUNTS', 'COMPANY_OFFERS', 'Céges ajánlatok', 'Céges csomagok'];
  } else if (cats.includes('vendegszamla') || name.includes('vendegszamla')) {
    [main, sub, group, subgroup] = ['GUEST_ACCOUNT', 'GUEST_ACCOUNT_BASIC', 'Vendégszámla', 'Vendégszámla'];
  } else if (cats.includes('tanfolyam') || name.includes('tanfolyam')) {
    main = 'TRAININGS'; group = 'Tanfolyamok';
    if (cats.includes('fodrasz tanfolyamok') || name.includes('hajfonas')) [sub, subgroup] = ['TRAINING_HAIR', 'Fodrász tanfolyamok'];
    else if (cats.includes('kez es labapolas tanfolyamok') || ['pedikur', 'gellakk', 'korom'].some((x) => name.includes(x))) [sub, subgroup] = ['TRAINING_NAIL', 'Kéz- és lábápolás tanfolyamok'];
    else [sub, subgroup] = ['TRAINING_COSMETIC', 'Kozmetikai tanfolyamok'];
  } else if (cats.includes('berlet') || /\(\d+\+\d+\)/.test(product.name || '')) {
    main = 'PASSES'; group = 'Bérletek';
    if (cats.includes('videk') || name.startsWith('videk ')) [sub, subgroup] = ['PASSES_COUNTRYSIDE', 'Vidék'];
    else [sub, subgroup] = ['PASSES_BUDAPEST', 'Budapest'];
  } else if (['ajandekutalvanyok', 'szepsegutalvany', 'szepsegcsomag'].some((x) => cats.includes(x)) || ['ajandekutalvany', 'szepsegutalvany', 'szepsegcsomag'].some((x) => name.includes(x))) {
    main = 'GIFT_VOUCHERS'; group = 'Ajándékutalványok';
    if (cats.includes('egyedi szepsegcsomag') || name.includes('egyedi szepsegcsomag')) [sub, subgroup] = ['GIFT_CUSTOM_PACKAGE', 'Egyedi szépségcsomag'];
    else if (cats.includes('szepsegcsomag') || name.includes('szepsegcsomag')) [sub, subgroup] = ['GIFT_BEAUTY_PACKAGES', 'Szépségcsomagok'];
    else if (cats.includes('szepsegutalvany') || name.includes('szepsegutalvany')) [sub, subgroup] = ['GIFT_BEAUTY_VOUCHERS', 'Szépségutalványok'];
    else [sub, subgroup] = ['GIFT_VOUCHERS_BASIC', 'Ajándékutalványok'];
  } else if (cats.includes('kleo termekek') || name.startsWith('kleo ')) {
    [main, sub, group, subgroup] = ['KLEO_PRODUCTS', 'KLEO_BRAND', 'Kleo termékek', 'Kleo márkatermékek'];
  } else if (['kozmetika termekek', 'egyeb kozmetikai termekek', 'fogfeherites', 'fulbevalok', 'szemoldok es szempilla'].some((x) => cats.includes(x))) {
    sub = 'SALON_COSMETIC'; subgroup = 'Kozmetika termékek';
  } else if (['koromapolas termekek', 'koromapolas kiegeszitok', 'koromdiszites', 'pedikur es labapolas'].some((x) => cats.includes(x))) {
    sub = 'SALON_NAIL'; subgroup = 'Körömápolás termékek';
  } else if (['fodraszat termekek', 'fodraszat kellekek', 'hajpakolasok', 'samponok', 'kallos cosmetics'].some((x) => cats.includes(x))) {
    sub = 'SALON_HAIR'; subgroup = 'Fodrászat termékek';
  } else if (['irodaszerek', 'tisztitoszerek', 'torolkozok'].some((x) => cats.includes(x))) {
    sub = 'SALON_SUPPLIES'; subgroup = 'Szalonellátás és higiénia';
  } else if (['szempilla', 'szemoldok', 'kozmet', 'fogfeherit', 'fulbevalo'].some((x) => name.includes(x))) {
    sub = 'SALON_COSMETIC'; subgroup = 'Kozmetika termékek';
  } else if (['korom', 'gellakk', 'pedikur', 'labapolas', 'reszelo', 'strassz'].some((x) => name.includes(x))) {
    sub = 'SALON_NAIL'; subgroup = 'Körömápolás termékek';
  } else if (['haj', 'sampon', 'hajpakolas', 'fesu'].some((x) => name.includes(x))) {
    sub = 'SALON_HAIR'; subgroup = 'Fodrászat termékek';
  } else if (['tisztito', 'torolkozo', 'wc papir', 'oblito', 'partvis', 'lepedo', 'szalveta', 'kesztyu'].some((x) => name.includes(x))) {
    sub = 'SALON_SUPPLIES'; subgroup = 'Szalonellátás és higiénia';
  }

  let service = null;
  if (all.includes('szempilla')) service = 'EYELASH';
  else if (all.includes('szemoldok')) service = 'BROW_LASH';
  else if (all.includes('masszazs')) service = 'MASSAGE';
  else if (['korom', 'gellakk', 'pedikur', 'labapolas', 'manikur'].some((x) => all.includes(x))) service = 'HAND_FOOT';
  else if (['fodrasz', 'haj'].some((x) => all.includes(x))) service = 'HAIRDRESSING';
  else if (['kozmet', 'arckezeles', 'gyanta', 'cukorpaszta', 'ipl', 'lezer', 'kavitacio', 'fogfeherit'].some((x) => all.includes(x))) service = 'COSMETIC';

  return { main_category: main, sub_category: sub, service_category: service, display_group: group, display_subgroup: subgroup };
}

const source = JSON.parse(await fs.readFile(input, 'utf8'));
const products = source.products.map((product) => ({
  source_url: product.source_url,
  name: product.name,
  sku: product.sku || null,
  price_gross: Number(product.price_gross),
  currency: product.currency || 'HUF',
  image_url: product.image_url || null,
  description: product.description || null,
  classification: classify(product),
}));

const counts = new Map();
for (const product of products) {
  const c = product.classification;
  const label = `${c.display_group} > ${c.display_subgroup}`;
  counts.set(label, (counts.get(label) || 0) + 1);
}
const categories = [...counts.entries()]
  .map(([category_path, count]) => ({ category_path, count }))
  .sort((a, b) => b.count - a.count || a.category_path.localeCompare(b.category_path, 'hu'));

const normalized = {
  source: source.source,
  source_scan_generated_at: source.generated_at,
  product_count: products.length,
  priced_product_count: products.filter((product) => product.price_gross > 0).length,
  categories,
  products,
};

if (normalized.product_count < 500 || normalized.priced_product_count !== normalized.product_count) {
  throw new Error(`Refusing incomplete catalog snapshot: ${normalized.priced_product_count}/${normalized.product_count}`);
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
console.log(`Normalized ${normalized.product_count} Kleoshop products into ${categories.length} shopper groups.`);
for (const item of categories) console.log(`${item.count}\t${item.category_path}`);
