const BASE=process.env.KIOSK_UAT_BASE||'https://kleoszalon-api-1.onrender.com/api/kiosk';

async function req(path,options={}){
  const response=await fetch(`${BASE}${path}`,{
    ...options,
    headers:{'content-type':'application/json','user-agent':'Kleopatra-Kiosk-Live-UAT/1.0',...(options.headers||{})}
  });
  const text=await response.text();
  let body=null;try{body=text?JSON.parse(text):null}catch{body={raw:text}}
  return{status:response.status,ok:response.ok,body};
}

const context=await req('/context');
if(context.status!==200||!context.body?.bound_location?.id){
  console.error('KIOSK_UAT_FAIL context',context.status,JSON.stringify(context.body));
  process.exit(1);
}
const locationId=String(context.body.bound_location.id);

let item=null;
const products=await req(`/products?location_id=${encodeURIComponent(locationId)}`);
if(products.status===200&&Array.isArray(products.body?.products)&&products.body.products.length){
  item={kind:'product',id:String(products.body.products[0].id),qty:1};
}
if(!item){
  const services=await req(`/services?location_id=${encodeURIComponent(locationId)}`);
  if(services.status===200&&Array.isArray(services.body?.services)&&services.body.services.length){
    item={kind:'service',id:String(services.body.services[0].id),qty:1};
  }
}
if(!item){
  console.error('KIOSK_UAT_FAIL no kiosk catalog item available',JSON.stringify({products_status:products.status,location_id:locationId}));
  process.exit(1);
}

const checkout=await req('/workorders?validate_only=1',{
  method:'POST',
  headers:{'x-kleo-kiosk-uat':'1'},
  body:JSON.stringify({
    location_id:locationId,
    client_name:'VIR KIOSK LIVE UAT',
    phone:'+36 30 000 0000',
    email:'vir-kiosk-uat@example.com',
    payment_method:'reception',
    note:'Rollback-only production KIOSK UAT',
    items:[item]
  })
});

const pass=checkout.status===201&&checkout.body?.ok===true&&checkout.body?.validated_only===true&&Number(checkout.body?.item_count||0)>=1;
if(!pass){
  console.error('KIOSK_UAT_FAIL checkout',checkout.status,JSON.stringify(checkout.body));
  process.exit(1);
}
console.log('KIOSK_UAT_PASS',JSON.stringify({
  status:checkout.status,
  location_id:locationId,
  item_kind:item.kind,
  item_count:checkout.body.item_count,
  total:checkout.body.total,
  queue_code:checkout.body.kiosk_queue_code||null,
  rolled_back:true
}));
