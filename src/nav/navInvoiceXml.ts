export type NavInvoiceOperation="CREATE"|"MODIFY"|"STORNO";

type VatGroup={rate:number;net:number;vat:number;gross:number};

const esc=(v:unknown)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const amount=(v:unknown)=>Number(v||0).toFixed(2);
const rate=(v:unknown)=>Number(v??0.27).toFixed(4);
const date10=(v:unknown,fallback:string)=>String(v||fallback).slice(0,10);

export function resolveNavOperation(invoiceType:unknown):NavInvoiceOperation{
  const value=String(invoiceType||"NORMAL").trim().toUpperCase();
  if(value==="MODIFY")return"MODIFY";
  if(value==="STORNO")return"STORNO";
  return"CREATE";
}

export function validateNavXmlPrerequisites(inv:any,lines:any[]){
  const errors:string[]=[];
  const operation=resolveNavOperation(inv?.invoice_type);
  if(!String(inv?.invoice_no||"").trim())errors.push("A számlaszám hiányzik.");
  if(!Array.isArray(lines)||!lines.length)errors.push("A számlának nincs NAV XML-be írható tétele.");
  if(operation!=="CREATE"){
    if(!String(inv?.original_invoice_number||"").trim())errors.push("Módosító/sztornó számlához az eredeti számlaszám kötelező.");
    if(!(Number(inv?.modification_index)>0))errors.push("Módosító/sztornó számlához pozitív modification_index szükséges.");
  }
  for(const [index,line] of (lines||[]).entries()){
    const vatRate=Number(line?.vat_rate);
    if(!Number.isFinite(vatRate)||vatRate<0||vatRate>1)errors.push(`${index+1}. tétel ÁFA-kulcsa érvénytelen.`);
    for(const key of ["net_amount","vat_amount","gross_amount"]){if(!Number.isFinite(Number(line?.[key])))errors.push(`${index+1}. tétel ${key} értéke érvénytelen.`)}
  }
  return{operation,errors,valid:errors.length===0};
}

export function groupVatSummaries(lines:any[]):VatGroup[]{
  const groups=new Map<string,VatGroup>();
  for(const line of lines){
    const r=Number(line?.vat_rate??0.27);
    const key=r.toFixed(4);
    const current=groups.get(key)||{rate:r,net:0,vat:0,gross:0};
    current.net+=Number(line?.net_amount||0);
    current.vat+=Number(line?.vat_amount||0);
    current.gross+=Number(line?.gross_amount||0);
    groups.set(key,current);
  }
  return[...groups.values()].sort((a,b)=>a.rate-b.rate);
}

function invoiceReference(inv:any,operation:NavInvoiceOperation){
  if(operation==="CREATE")return"";
  return `<invoiceReference><originalInvoiceNumber>${esc(inv.original_invoice_number)}</originalInvoiceNumber><modifyWithoutMaster>false</modifyWithoutMaster><modificationIndex>${Math.trunc(Number(inv.modification_index))}</modificationIndex></invoiceReference>`;
}

function vatSummaryXml(lines:any[]){
  return groupVatSummaries(lines).map(g=>`<summaryByVatRate><vatRate><vatPercentage>${rate(g.rate)}</vatPercentage></vatRate><vatRateNetData><vatRateNetAmount>${amount(g.net)}</vatRateNetAmount><vatRateNetAmountHUF>${amount(g.net)}</vatRateNetAmountHUF></vatRateNetData><vatRateVatData><vatRateVatAmount>${amount(g.vat)}</vatRateVatAmount><vatRateVatAmountHUF>${amount(g.vat)}</vatRateVatAmountHUF></vatRateVatData><vatRateGrossData><vatRateGrossAmount>${amount(g.gross)}</vatRateGrossAmount><vatRateGrossAmountHUF>${amount(g.gross)}</vatRateGrossAmountHUF></vatRateGrossData></summaryByVatRate>`).join("");
}

export function buildNavInvoiceXml(c:any,inv:any,lines:any[]){
  const check=validateNavXmlPrerequisites(inv,lines);
  if(!check.valid)throw new Error(`NAV XML előfeltétel hiba: ${check.errors.join(" ")}`);
  const operation=check.operation;
  const issue=date10(inv.issue_date,new Date().toISOString().slice(0,10));
  const perf=date10(inv.performance_date,issue);
  const due=date10(inv.due_date,issue);
  const supplierTax=String(c.supplier_tax_number||"").replace(/\D/g,"");
  const customerTax=String(inv.customer_tax_number||inv.partner_tax_no||"").replace(/\D/g,"");
  const customerName=inv.customer_name||inv.partner_name||"Magánszemély";
  const lineXml=lines.map((l:any,i:number)=>`<line><lineNumber>${i+1}</lineNumber><lineExpressionIndicator>true</lineExpressionIndicator><lineDescription>${esc(l.description)}</lineDescription><quantity>${Number(l.quantity||1).toFixed(4)}</quantity><unitOfMeasure>${esc(l.unit_of_measure||"PIECE")}</unitOfMeasure><unitPrice>${Number(l.unit_price_net||0).toFixed(4)}</unitPrice><lineAmountsNormal><lineNetAmountData><lineNetAmount>${amount(l.net_amount)}</lineNetAmount><lineNetAmountHUF>${amount(l.net_amount)}</lineNetAmountHUF></lineNetAmountData><lineVatRate><vatPercentage>${rate(l.vat_rate)}</vatPercentage></lineVatRate><lineVatData><lineVatAmount>${amount(l.vat_amount)}</lineVatAmount><lineVatAmountHUF>${amount(l.vat_amount)}</lineVatAmountHUF></lineVatData><lineGrossAmountData><lineGrossAmountNormal>${amount(l.gross_amount)}</lineGrossAmountNormal><lineGrossAmountNormalHUF>${amount(l.gross_amount)}</lineGrossAmountNormalHUF></lineGrossAmountData></lineAmountsNormal></line>`).join("");
  const reference=invoiceReference(inv,operation);
  const summaries=vatSummaryXml(lines);
  return `<?xml version="1.0" encoding="UTF-8"?><InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data"><invoiceNumber>${esc(inv.invoice_no)}</invoiceNumber><invoiceIssueDate>${issue}</invoiceIssueDate><completenessIndicator>false</completenessIndicator><invoiceMain><invoice>${reference}<invoiceHead><supplierInfo><supplierTaxNumber><taxpayerId>${supplierTax.slice(0,8)}</taxpayerId><vatCode>${supplierTax.slice(8,9)||"2"}</vatCode><countyCode>${supplierTax.slice(9,11)||"00"}</countyCode></supplierTaxNumber><supplierName>${esc(c.supplier_name)}</supplierName><supplierAddress><simpleAddress><countryCode>${esc(c.supplier_country_code||"HU")}</countryCode><postalCode>${esc(c.supplier_postal_code)}</postalCode><city>${esc(c.supplier_city)}</city><additionalAddressDetail>${esc(c.supplier_address)}</additionalAddressDetail></simpleAddress></supplierAddress></supplierInfo><customerInfo><customerVatStatus>${customerTax?"DOMESTIC":"PRIVATE_PERSON"}</customerVatStatus>${customerTax?`<customerVatData><customerTaxNumber><taxpayerId>${customerTax.slice(0,8)}</taxpayerId><vatCode>${customerTax.slice(8,9)||"2"}</vatCode><countyCode>${customerTax.slice(9,11)||"00"}</countyCode></customerTaxNumber></customerVatData>`:""}<customerName>${esc(customerName)}</customerName><customerAddress><simpleAddress><countryCode>${esc(inv.customer_country_code||"HU")}</countryCode><postalCode>${esc(inv.customer_postal_code||"0000")}</postalCode><city>${esc(inv.customer_city||"N/A")}</city><additionalAddressDetail>${esc(inv.customer_address||"N/A")}</additionalAddressDetail></simpleAddress></customerAddress></customerInfo><invoiceDetail><invoiceCategory>NORMAL</invoiceCategory><invoiceDeliveryDate>${perf}</invoiceDeliveryDate><currencyCode>${esc(inv.currency||"HUF")}</currencyCode><exchangeRate>1</exchangeRate><paymentMethod>${esc(String(inv.payment_method||"OTHER").toUpperCase())}</paymentMethod><paymentDate>${due}</paymentDate><invoiceAppearance>ELECTRONIC</invoiceAppearance></invoiceDetail></invoiceHead><invoiceLines>${lineXml}</invoiceLines><invoiceSummary><summaryNormal>${summaries}<invoiceNetAmount>${amount(inv.net_total)}</invoiceNetAmount><invoiceNetAmountHUF>${amount(inv.net_total)}</invoiceNetAmountHUF><invoiceVatAmount>${amount(inv.vat_total)}</invoiceVatAmount><invoiceVatAmountHUF>${amount(inv.vat_total)}</invoiceVatAmountHUF></summaryNormal><summaryGrossData><invoiceGrossAmount>${amount(inv.gross_total)}</invoiceGrossAmount><invoiceGrossAmountHUF>${amount(inv.gross_total)}</invoiceGrossAmountHUF></summaryGrossData></invoiceSummary></invoice></invoiceMain></InvoiceData>`;
}
