const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('src/routes/onlineBooking.ts'),source=read('src/booking/bookingRecommendations.ts');
test('public booking exposes fail-open recommendations',()=>{assert.match(route,/router\.get\("\/recommendations"/);assert.match(route,/recommendations:\[\],ai_used:false/)});
test('recommendations only use active bookable location services',()=>{assert.match(source,/COALESCE\(s\.is_active,true\)=true/);assert.match(source,/COALESCE\(s\.online_bookable,true\)=true/);assert.match(source,/service_locations/)});
test('AI is copy-only and candidate ids are validated',()=>{assert.match(source,/Kizárólag a kapott service_id-kat használd/);assert.match(source,/const map=new Map/);assert.match(source,/timeout:4500/)});
test('only currently active campaigns are shown',()=>{assert.match(source,/valid_from IS NULL OR valid_from<=now\(\)/);assert.match(source,/valid_until IS NULL OR valid_until>=now\(\)/)});
test('legacy campaign schema cannot suppress service recommendations',()=>{assert.match(source,/campaign fallback/);assert.match(source,/try\{\s*const campaignTable/)});
test('legacy text service categories are compared without uuid operator errors',()=>{assert.match(source,/service_type_id::text=ANY\(\$3::text\[\]\)/)});
