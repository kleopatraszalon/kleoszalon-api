import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export type NavXsdError={
  message:string;
  raw_message:string;
  file_name:string|null;
  line_number:number|null;
};

export type NavXsdValidationResult={
  valid:boolean;
  status:'passed'|'failed';
  errors:NavXsdError[];
  raw_output:string;
  xml_sha256:string;
  schema_revision:string;
  schema_name:string;
  validator:string;
};

type Runtime={
  validateXML:(options:any)=>Promise<any>;
  invoiceData:string;
  invoiceBase:string;
  common:string;
  manifest:any;
};

let runtimePromise:Promise<Runtime>|null=null;

const MAX_XML_BYTES=10*1024*1024;
const MAX_ERRORS=100;
const MAX_RAW_OUTPUT=32*1024;

function sha256(text:string){return crypto.createHash('sha256').update(text,'utf8').digest('hex')}

async function loadRuntime():Promise<Runtime>{
  if(!runtimePromise){
    runtimePromise=(async()=>{
      const xsdDir=path.join(__dirname,'xsd');
      const vendorDir=path.join(__dirname,'vendor','xmllint-wasm');
      const [invoiceData,invoiceBase,common,manifestText]=await Promise.all([
        fs.readFile(path.join(xsdDir,'invoiceData.xsd'),'utf8'),
        fs.readFile(path.join(xsdDir,'invoiceBase.xsd'),'utf8'),
        fs.readFile(path.join(xsdDir,'common.xsd'),'utf8'),
        fs.readFile(path.join(xsdDir,'manifest.json'),'utf8')
      ]);
      // Runtimeban kizárólag a buildkor előkészített, lokális WASM modult töltjük.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const modulePath=path.join(vendorDir,'index-node.js');
      const xmllint=require(modulePath);
      if(typeof xmllint?.validateXML!=='function')throw new Error('Az xmllint-wasm validateXML függvény nem tölthető be.');
      const manifest=JSON.parse(manifestText);
      if(!manifest?.schemaRevision)throw new Error('A NAV XSD manifest schemaRevision mezője hiányzik.');
      return {validateXML:xmllint.validateXML,invoiceData,invoiceBase,common,manifest};
    })().catch(err=>{runtimePromise=null;throw err});
  }
  return runtimePromise;
}

export async function getNavXsdRuntimeInfo(){
  const runtime=await loadRuntime();
  return {
    ready:true,
    schema_name:String(runtime.manifest.schema||'NAV Online Számla invoiceData 3.0'),
    schema_revision:String(runtime.manifest.schemaRevision),
    online_invoice_commit:String(runtime.manifest.onlineInvoiceCommit||''),
    common_commit:String(runtime.manifest.commonCommit||''),
    validator:`${runtime.manifest?.validator?.name||'xmllint-wasm'} ${runtime.manifest?.validator?.version||''}`.trim(),
    runtime_network_required:false
  };
}

export async function validateNavInvoiceXmlXsd(xml:string):Promise<NavXsdValidationResult>{
  const bytes=Buffer.byteLength(xml||'','utf8');
  if(!xml||!xml.trim())throw new Error('Üres XML nem validálható.');
  if(bytes>MAX_XML_BYTES)throw new Error(`A NAV XML túl nagy a lokális XSD-validációhoz (${bytes} byte, maximum ${MAX_XML_BYTES}).`);
  const runtime=await loadRuntime();
  const result=await runtime.validateXML({
    xml:[{fileName:'invoice.xml',contents:xml}],
    schema:[{fileName:'invoiceData.xsd',contents:runtime.invoiceData}],
    preload:[
      {fileName:'invoiceBase.xsd',contents:runtime.invoiceBase},
      {fileName:'common.xsd',contents:runtime.common}
    ],
    initialMemoryPages:256,
    maxMemoryPages:2048
  });
  const errors:NavXsdError[]=(result?.errors||[]).slice(0,MAX_ERRORS).map((e:any)=>({
    message:String(e?.message||e?.rawMessage||'Ismeretlen XSD hiba'),
    raw_message:String(e?.rawMessage||e?.message||'Ismeretlen XSD hiba'),
    file_name:e?.loc?.fileName?String(e.loc.fileName):null,
    line_number:Number.isFinite(Number(e?.loc?.lineNumber))?Number(e.loc.lineNumber):null
  }));
  return {
    valid:Boolean(result?.valid),
    status:result?.valid?'passed':'failed',
    errors,
    raw_output:String(result?.rawOutput||'').slice(0,MAX_RAW_OUTPUT),
    xml_sha256:sha256(xml),
    schema_revision:String(runtime.manifest.schemaRevision),
    schema_name:String(runtime.manifest.schema||'NAV Online Számla invoiceData 3.0'),
    validator:`${runtime.manifest?.validator?.name||'xmllint-wasm'} ${runtime.manifest?.validator?.version||''}`.trim()
  };
}
