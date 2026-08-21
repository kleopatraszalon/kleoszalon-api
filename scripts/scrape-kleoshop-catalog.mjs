import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'https://www.kleoshop.hu/';
const ORIGIN = new URL(ROOT).origin;
const MAX_PAGES = Number(process.env.KLEOSHOP_MAX_PAGES || 3500);
const CONCURRENCY = Number(process.env.KLEOSHOP_CONCURRENCY || 10);
const TIMEOUT = Number(process.env.KLEOSHOP_TIMEOUT_MS || 18000);
const outDir = path.resolve(process.cwd(), 'artifacts');
const blocked = ['/account','/login','/register','/cart','/checkout','/compare','/wishlist','/search','/affiliate','/order','/return','/download'];
const blockedExt = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|map|woff2?|ttf|eot|pdf|zip|xml)(?:$|\?)/i;

function text(value='') {
  return String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<br\s*\/?\s*>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/\s+/g,' ').trim();
}
function key(value=''){return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()}
function cleanPrice(raw){const n=Number(String(raw||'').replace(/[^\d]/g,''));return Number.isFinite(n)&&n>0?n:null}
function url(raw,base=ROOT){
  try{
    const u=new URL(raw,base); if(!/^https?:$/.test(u.protocol)||u.origin!==ORIGIN)return null; u.hash='';
    for(const k of [...u.searchParams.keys()]) if(!['page','limit','sort','order'].includes(k.toLowerCase()))u.searchParams.delete(k);
    if(u.pathname!=='/'&&u.pathname.endsWith('/'))u.pathname=u.pathname.replace(/\/+$/,'');
    const out=u.toString(); if(blockedExt.test(out)||blocked.some(x=>u.pathname.toLowerCase().includes(x)))return null; return out;
  }catch{return null}
}
async function fetchText(target,attempts=3){
  let last; for(let i=1;i<=attempts;i++){
    const c=new AbortController(), timer=setTimeout(()=>c.abort(),TIMEOUT);
    try{
      const r=await fetch(target,{signal:c.signal,redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (compatible; KleopatraCatalogMigration/2.0; +https://kleoszalon.hu)','accept-language':'hu-HU,hu;q=0.9,en;q=0.5'}});
      if(!r.ok)throw new Error(`${r.status} ${r.statusText}`); return {html:await r.text(),finalUrl:r.url,type:r.headers.get('content-type')||''};
    }catch(e){last=e;if(i<attempts)await new Promise(r=>setTimeout(r,450*i))}finally{clearTimeout(timer)}
  } throw last;
}
function links(html,base){const out=new Set();for(const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)){const v=url(m[1]||m[2]||m[3],base);if(v)out.add(v)}return out}
function meta(html,name){const e=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');for(const r of [new RegExp(`<meta\\b[^>]*(?:property|name)=["']${e}["'][^>]*content=["']([^"']*)["']`,'i'),new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${e}["']`,'i')]){const m=String(html).match(r);if(m)return text(m[1])}return ''}
function h1(html){const m=String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);return m?text(m[1]):''}
function jsonLd(html){
  const products=[]; for(const m of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const root=JSON.parse(m[1].trim());const walk=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n))return n.forEach(walk);const t=Array.isArray(n['@type'])?n['@type']:[n['@type']];if(t.some(x=>String(x).toLowerCase()==='product'))products.push(n);if(n['@graph'])walk(n['@graph'])};walk(root)}catch{}
  } return products;
}
function detailPrice(plain){const m=plain.match(/(?:^|\s)Ár:\s*([\d\s.]+)\s*(?:Ft|HUF)\b/i);return m?cleanPrice(m[1]):null}
function extractProduct(html,pageUrl){
  const plain=text(html), title=h1(html), price=detailPrice(plain); if(!title||!price)return null;
  const candidates=jsonLd(html); const data=candidates.find(p=>key(p?.name)===key(title))||candidates[0]||{};
  const imageRaw=Array.isArray(data.image)?data.image[0]:data.image; const image=imageRaw?.url||imageRaw||meta(html,'og:image')||null;
  const description=text(data.description||meta(html,'description')||meta(html,'og:description'))||null;
  return {source_url:pageUrl,name:title,sku:text(data.sku||data.mpn||'')||null,price_gross:price,currency:'HUF',availability:null,image_url:image?new URL(String(image),pageUrl).toString():null,description,source_categories:[]};
}
function usefulContext(label){const k=key(label);return label&&!/^(kleoshop|fooldal|kezdolap|kategoriak|termekek)$/.test(k)&&!/ujdonsag|akcios termek|kapcsolat|fizetes|szallitas|belepes|regisztracio/.test(k)}
function classify(product){
  const cats=(product.source_categories||[]).map(x=>x.label).join(' | '), all=key(`${cats} | ${product.name}`);
  let main='SALON_PRODUCTS',sub='SALON_OTHER',service=null,group='Szalon termékek',subLabel='Egyéb termékek';
  if(/kedvezmenyek cegeknek|ceges/.test(all)||(product.name.includes('5 darab')&&/utalvany|szepsegcsomag/i.test(product.name))){main='COMPANY_DISCOUNTS';sub='COMPANY_OFFERS';group='Céges ajánlatok';subLabel='Céges csomagok'}
  else if(/vendegszamla/.test(all)){main='GUEST_ACCOUNT';sub='GUEST_ACCOUNT_BASIC';group='Vendégszámla';subLabel='Vendégszámla'}
  else if(/tanfolyam/.test(all)){main='TRAININGS';group='Tanfolyamok';if(/fodrasz|hajfonas/.test(all)){sub='TRAINING_HAIR';subLabel='Fodrász tanfolyamok'}else if(/kez es lab|kez- es lab|pedikur|gellakk|korom/.test(all)){sub='TRAINING_NAIL';subLabel='Kéz- és lábápolás tanfolyamok'}else{sub='TRAINING_COSMETIC';subLabel='Kozmetikai tanfolyamok'}}
  else if(/berlet/.test(all)||/\(\d+\+\d+\)/.test(product.name)){main='PASSES';group='Bérletek';if(/videk/.test(all)){sub='PASSES_COUNTRYSIDE';subLabel='Vidék'}else{sub='PASSES_BUDAPEST';subLabel='Budapest'}}
  else if(/ajandekutalvany|szepsegutalvany|szepsegcsomag|egyedi szepsegcsomag/.test(all)){main='GIFT_VOUCHERS';group='Ajándékutalványok';if(/egyedi szepsegcsomag/.test(all)){sub='GIFT_CUSTOM_PACKAGE';subLabel='Egyedi szépségcsomag'}else if(/szepsegcsomag/.test(all)){sub='GIFT_BEAUTY_PACKAGES';subLabel='Szépségcsomagok'}else if(/szepsegutalvany/.test(all)){sub='GIFT_BEAUTY_VOUCHERS';subLabel='Szépségutalványok'}else{sub='GIFT_VOUCHERS_BASIC';subLabel='Ajándékutalványok'}}
  else if(/kleo termek|^kleo\b/.test(all)){main='KLEO_PRODUCTS';sub='KLEO_BRAND';group='Kleo termékek';subLabel='Kleo márkatermékek'}
  else if(/fodrasz|sampon|hajpakolas|hajfest|hajkefe|fesu/.test(all)){sub='SALON_HAIR';subLabel='Fodrászat termékek'}
  else if(/korom|gellakk|pedikur|labapolas|reszelo|strassz|mukorom/.test(all)){sub='SALON_NAIL';subLabel='Körömápolás termékek'}
  else if(/kozmet|szempilla|szemoldok|fogfeherit|fulbevalo|gyanta|cukorpaszta/.test(all)){sub='SALON_COSMETIC';subLabel='Kozmetika termékek'}
  else if(/irodaszer|tisztitoszer|torolkozo|wc papir|oblito|partvis|lepedo/.test(all)){sub='SALON_SUPPLIES';subLabel='Szalonellátás és higiénia'}
  if(/haj|fodrasz/.test(all))service='HAIRDRESSING'; else if(/korom|gellakk|pedikur|labapolas/.test(all))service='HAND_FOOT'; else if(/masszazs/.test(all))service='MASSAGE'; else if(/szempilla/.test(all))service='EYELASH'; else if(/szemoldok/.test(all))service='BROW_LASH'; else if(/kozmet|arckezeles|gyanta|cukorpaszta|ipl|lezer|kavitacio/.test(all))service='COSMETIC';
  return {main_category:main,sub_category:sub,service_category:service,display_group:group,display_subgroup:subLabel};
}
function categorySummary(products){const m=new Map();for(const p of products){const k=`${p.classification.display_group} > ${p.classification.display_subgroup}`;m.set(k,(m.get(k)||0)+1)}return [...m].map(([category_path,count])=>({category_path,count})).sort((a,b)=>b.count-a.count||a.category_path.localeCompare(b.category_path,'hu'))}
async function sitemaps(){
  const maps=new Set([new URL('/sitemap.xml',ROOT).toString(),new URL('/index.php?route=feed/google_sitemap',ROOT).toString()]);
  try{const r=await fetchText(new URL('/robots.txt',ROOT),1);for(const m of r.html.matchAll(/^\s*Sitemap:\s*(\S+)/gim))maps.add(m[1])}catch{}
  const out=new Set(); for(const map of maps){try{const r=await fetchText(map,1);const locs=[...r.html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(m=>text(m[1]));for(const loc of locs){const v=url(loc);if(v)out.add(v)}console.log(`Sitemap OK: ${map} -> ${locs.length} loc`)}catch(e){console.log(`Sitemap skip: ${map} (${e?.message||e})`)}} return out;
}
async function main(){
  await fs.mkdir(outDir,{recursive:true}); const seed=await sitemaps(); const queue=[ROOT,...seed],queued=new Set(queue.map(x=>url(x)).filter(Boolean)),visited=new Set(),rawProducts=[],contexts=[],failures=[];
  async function process(target){
    try{const r=await fetchText(target);if(!/html|xhtml/i.test(r.type)&&!/<html/i.test(r.html))return;const page=url(r.finalUrl)||target, allLinks=links(r.html,page), product=extractProduct(r.html,page);if(product)rawProducts.push(product);else{const label=h1(r.html);if(usefulContext(label))contexts.push({url:page,label,links:[...allLinks]})}for(const l of allLinks){if(!visited.has(l)&&!queued.has(l)&&queued.size<MAX_PAGES*2){queued.add(l);queue.push(l)}}}catch(e){failures.push({url:target,error:e?.message||String(e)})}
  }
  while(queue.length&&visited.size<MAX_PAGES){const batch=[];while(queue.length&&batch.length<CONCURRENCY&&visited.size+batch.length<MAX_PAGES){const v=url(queue.shift());if(!v||visited.has(v))continue;visited.add(v);batch.push(v)}if(batch.length)await Promise.all(batch.map(process));if(visited.size%50<CONCURRENCY)console.log(`Progress: ${visited.size} pages, ${rawProducts.length} product details, queue ${queue.length}`)}
  const byUrl=new Map();for(const p of rawProducts)byUrl.set(p.source_url,p);const productUrls=new Set(byUrl.keys()),refs=new Map();for(const c of contexts){let hit=0;for(const l of c.links){if(!productUrls.has(l))continue;if(!refs.has(l))refs.set(l,new Map());refs.get(l).set(c.url,c.label);hit++}if(hit===0)continue}
  const products=[...byUrl.values()];for(const p of products){p.source_categories=[...(refs.get(p.source_url)?.entries()||[])].map(([url,label])=>({url,label}));p.classification=classify(p)}products.sort((a,b)=>a.name.localeCompare(b.name,'hu'));
  const categories=categorySummary(products),priced=products.filter(p=>p.price_gross>0).length;const payload={generated_at:new Date().toISOString(),source:ROOT,crawled_pages:visited.size,failed_pages:failures.length,product_count:products.length,priced_product_count:priced,categories,products,failures:failures.slice(0,100)};
  await fs.writeFile(path.join(outDir,'kleoshop-catalog.json'),JSON.stringify(payload,null,2));const summary=['# Kleoshop catalog scan','',`- Generated: ${payload.generated_at}`,`- Crawled pages: ${payload.crawled_pages}`,`- Failed pages: ${payload.failed_pages}`,`- Unique product detail pages: ${payload.product_count}`,`- Products with price: ${priced}`,'','## Normalized groups','',...categories.map(x=>`- ${x.count} × ${x.category_path}`)].join('\n');await fs.writeFile(path.join(outDir,'kleoshop-catalog-summary.md'),summary);console.log(summary);
  if(products.length<600||priced/products.length<0.95){console.error(`Catalog guard failed: products=${products.length}, priced=${priced}`);process.exitCode=2}
}
main().catch(e=>{console.error(e);process.exitCode=1});
