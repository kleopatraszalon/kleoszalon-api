'use strict';

const {buildNavInvoiceXml}=require('../dist/nav/navInvoiceXml');
const {validateNavInvoiceXmlXsd,getNavXsdRuntimeInfo}=require('../dist/nav/navXsdValidator');

const config={
  supplier_tax_number:'12345678210',
  supplier_name:'Kleoszalon Kft.',
  supplier_country_code:'HU',
  supplier_postal_code:'3300',
  supplier_city:'Eger',
  supplier_address:'Teszt utca 1.'
};

const commonInvoice={
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
  payment_method:'CASH'
};

const positiveLines=[
  {line_number:1,description:'Teszt szolgáltatás 27%',quantity:1,unit_of_measure:'PIECE',unit_price_net:1000,vat_rate:0.27,net_amount:1000,vat_amount:270,gross_amount:1270},
  {line_number:2,description:'Teszt szolgáltatás 5%',quantity:1,unit_of_measure:'PIECE',unit_price_net:1000,vat_rate:0.05,net_amount:1000,vat_amount:50,gross_amount:1050}
];

function correctionLines(sign,startReference){
  return positiveLines.map((line,index)=>({
    ...line,
    unit_price_net:line.unit_price_net*sign,
    net_amount:line.net_amount*sign,
    vat_amount:line.vat_amount*sign,
    gross_amount:line.gross_amount*sign,
    nav_line_number_reference:startReference+index
  }));
}

const cases=[
  {
    name:'CREATE multi-VAT',
    invoice:{...commonInvoice,invoice_no:'KLEO-XSD-SMOKE-1',invoice_type:'NORMAL',net_total:2000,vat_total:320,gross_total:2320},
    lines:positiveLines
  },
  {
    name:'MODIFY',
    invoice:{...commonInvoice,invoice_no:'KLEO-XSD-SMOKE-1-M1',invoice_type:'MODIFY',original_invoice_number:'KLEO-XSD-SMOKE-1',modification_index:1,net_total:2000,vat_total:320,gross_total:2320},
    lines:correctionLines(1,3)
  },
  {
    name:'STORNO',
    invoice:{...commonInvoice,invoice_no:'KLEO-XSD-SMOKE-1-S2',invoice_type:'STORNO',original_invoice_number:'KLEO-XSD-SMOKE-1',modification_index:2,net_total:-2000,vat_total:-320,gross_total:-2320},
    lines:correctionLines(-1,5)
  }
];

async function validateCase(testCase){
  const xml=buildNavInvoiceXml(config,testCase.invoice,testCase.lines);
  const result=await validateNavInvoiceXmlXsd(xml);
  if(result.valid){
    console.log(`[NAV XSD] ${testCase.name} PASS · ${result.xml_sha256}`);
    return;
  }
  console.error(`[NAV XSD] ${testCase.name} invalid against pinned official schema.`);
  for(const error of result.errors)console.error(`- ${error.file_name||'xml'}:${error.line_number||'?'} ${error.message}`);
  throw new Error(`${testCase.name} XSD smoke failed`);
}

async function main(){
  for(const testCase of cases)await validateCase(testCase);
  const runtime=await getNavXsdRuntimeInfo();
  console.log(`[NAV XSD] full smoke PASS · ${runtime.schema_revision} · ${runtime.validator}`);
}

main().catch(err=>{console.error('[NAV XSD] smoke failure:',err);process.exit(1)});
