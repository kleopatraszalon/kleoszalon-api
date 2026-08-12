const TARGET_RECIPIENTS=[
  'birtalan.zoltan1975@gmail.com',
  'h.n.andrea@kleoszalon.hu',
];
const LEGACY_DEMO_RECIPIENT='demo.ugyfel@kleoszalon.hu';

function normalizeWorkOrderCloseEmails(input){
  const configured=String(input||'').split(/[;,]/).map(x=>x.trim()).filter(Boolean);
  const source=configured.length?configured:TARGET_RECIPIENTS;
  const expanded=[];
  for(const email of source){
    if(email.toLowerCase()===LEGACY_DEMO_RECIPIENT){
      expanded.push(...TARGET_RECIPIENTS);
    }else{
      expanded.push(email);
    }
  }
  const seen=new Set();
  return expanded.filter(email=>{
    const key=email.toLowerCase();
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

const normalized=normalizeWorkOrderCloseEmails(process.env.WORKORDER_CLOSE_EMAILS);
process.env.WORKORDER_CLOSE_EMAILS=normalized.join(',');

module.exports={TARGET_RECIPIENTS,LEGACY_DEMO_RECIPIENT,normalizeWorkOrderCloseEmails};
