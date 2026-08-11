'use strict';

const {buildNavInvoiceXml}=require('../dist/nav/navInvoiceXml');
const {validateNavInvoiceXmlXsd,getNavXsdRuntimeInfo}=require('../dist/nav/navXsdValidator');

async function main(){
  const config={
    supplier_tax_number:'12345678210',
    supplier_name:'Kleoszalon Kft.',
    supplier_country_code:'HU',
    supplier_postal_code:'3300',
    supplier_city:'Eger',
    supplier_address:'Teszt utca 1.'
  };
  const invoice={
    invoice_no:'KLEO-XSD-SMOKE-1',
    issue_date:'2026-08-11',
    performance_date:'2026-08-11',
    due_date:'2026-08-11',
    currency:'HUF',
    customer_name:'Teszt Vendég',
    partner_name:'Teszt Vendég',
    customer_country_code:'HU',
    customer_postal_code:'3300',
    customer_city:'Eger',
    customer_address:'Teszt tér 1.',
    payment_method:'CASH',
    invoice_type:'NORMAL',
    net_total:1000,
    vat_total:270,
    gross_total:1270
  };
  const lines=[{
    line_number:1,
    description:'Teszt szolgáltatás',
    quantity:1,
    unit_of_measure:'PIECE',
    unit_price_net:1000,
    vat_rate:0.27,
    net_amount:1000,
    vat_amount:270,
    gross_amount:1270
  }];
  const xml=buildNavInvoiceXml(config,invoice,lines);
  const result=await validateNavInvoiceXmlXsd(xml);
  const runtime=await getNavXsdRuntimeInfo();
  if(!result.valid){
    console.error('[NAV XSD] smoke XML invalid against pinned official schema.');
    for(const error of result.errors)console.error(`- ${error.file_name||'xml'}:${error.line_number||'?'} ${error.message}`);
    process.exitCode=1;
    return;
  }
  console.log(`[NAV XSD] smoke PASS · ${runtime.schema_revision} · ${runtime.validator}`);
}

main().catch(err=>{console.error('[NAV XSD] smoke engine failure:',err);process.exit(1)});
