import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ROOT=process.cwd();
const OUT=path.join(ROOT,'.nav-build','nav');
const XSD_OUT=path.join(OUT,'xsd');
const VENDOR_OUT=path.join(OUT,'vendor','xmllint-wasm');

const NAV_COMMIT='cc7a775d6dce361311e409abb9934eb755f2749c';
const COMMON_COMMIT='1f37f991fd9fb606b29aac9d8e367d52616e3d69';
const XMLLINT_VERSION='5.2.0';
const XMLLINT_TARBALLS=[
  'https://registry.npmjs.org/xmllint-wasm/-/xmllint-wasm-5.2.0.tgz',
  'https://registry.yarnpkg.com/xmllint-wasm/-/xmllint-wasm-5.2.0.tgz'
];
const XMLLINT_INTEGRITY='sha512-GVMuR3ViU8R7sakcVm/4GClMtCV8p7xgjXZlc6GmvPpInIz4V41lmRnjSd4uKhVkf5MZj97wEZkPM4RMAhojuQ==';
const DOWNLOAD_ATTEMPTS=4;
const RETRYABLE_STATUS=new Set([408,425,429,500,502,503,504]);

function githubSources(repo,commit,filePath,gitBlob){
  return [
    `https://api.github.com/repos/${repo}/git/blobs/${gitBlob}`,
    `https://raw.githubusercontent.com/${repo}/${commit}/${filePath}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${commit}/${filePath}`
  ];
}

const sources=[
  {
    name:'invoiceData.xsd',
    gitBlob:'c644a7112e02e4be53ec151feb00c472ef1c769f',
    repo:'nav-gov-hu/Online-Invoice',
    commit:NAV_COMMIT,
    filePath:'src/schemas/nav/gov/hu/OSA/invoiceData.xsd'
  },
  {
    name:'invoiceBase.xsd',
    gitBlob:'f3484ffe0ad8a85104fc77bacde669eaf47248bb',
    repo:'nav-gov-hu/Online-Invoice',
    commit:NAV_COMMIT,
    filePath:'src/schemas/nav/gov/hu/OSA/invoiceBase.xsd'
  },
  {
    name:'common.xsd',
    gitBlob:'ece06647ae0d454353f347e3d5d4ae9fb96a27f4',
    repo:'nav-gov-hu/Common',
    commit:COMMON_COMMIT,
    filePath:'src/schemas/nav/gov/hu/NTCA/common.xsd'
  }
].map(source=>({...source,urls:githubSources(source.repo,source.commit,source.filePath,source.gitBlob)}));

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

async function download(urls,label='asset'){
  const candidates=Array.isArray(urls)?urls:[urls];
  const errors=[];

  for(const url of candidates){
    for(let attempt=1;attempt<=DOWNLOAD_ATTEMPTS;attempt++){
      try{
        const isGithubApi=url.startsWith('https://api.github.com/');
        const response=await fetch(url,{
          redirect:'follow',
          headers:{
            'user-agent':'kleoszalon-nav-xsd-build/1.2',
            ...(isGithubApi?{
              accept:'application/vnd.github.raw+json',
              'x-github-api-version':'2022-11-28'
            }:{})
          },
          signal:AbortSignal.timeout(isGithubApi?12000:20000)
        });
        if(response.ok){
          if(attempt>1||url!==candidates[0])console.log(`[NAV XSD] ${label} letöltve fallback/retry forrásból: ${url}`);
          return Buffer.from(await response.arrayBuffer());
        }

        const message=`HTTP ${response.status} ${response.statusText}`.trim();
        errors.push(`${url} [${attempt}/${DOWNLOAD_ATTEMPTS}]: ${message}`);
        if(!RETRYABLE_STATUS.has(response.status))break;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        errors.push(`${url} [${attempt}/${DOWNLOAD_ATTEMPTS}]: ${message}`);
      }

      if(attempt<DOWNLOAD_ATTEMPTS){
        const delay=500*(2**(attempt-1));
        await sleep(delay);
      }
    }
  }

  throw new Error(`${label} letöltése minden forrásból sikertelen:\n- ${errors.join('\n- ')}`);
}

function gitBlobSha(buffer){
  return crypto.createHash('sha1').update(Buffer.from(`blob ${buffer.length}\0`)).update(buffer).digest('hex');
}

function sha256(buffer){return crypto.createHash('sha256').update(buffer).digest('hex')}

function verifyGitBlob(buffer,expected,name){
  const actual=gitBlobSha(buffer);
  if(actual!==expected)throw new Error(`${name} Git blob integritási hiba: várt=${expected}, kapott=${actual}`);
}

function patchSchemaLocations(name,text){
  if(name==='invoiceData.xsd'){
    const common='<xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common"/>';
    const base='<xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/base"/>';
    if(!text.includes(common)||!text.includes(base))throw new Error('invoiceData.xsd import szerkezete megváltozott; automatikus resolver-patch blokkolva.');
    return text
      .replace(common,'<xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common" schemaLocation="common.xsd"/>')
      .replace(base,'<xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/base" schemaLocation="invoiceBase.xsd"/>');
  }
  if(name==='invoiceBase.xsd'){
    const common='<xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common"/>';
    if(!text.includes(common))throw new Error('invoiceBase.xsd import szerkezete megváltozott; automatikus resolver-patch blokkolva.');
    return text.replace(common,'<xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common" schemaLocation="common.xsd"/>');
  }
  return text;
}

function parseOctal(buffer,start,length){
  const raw=buffer.subarray(start,start+length).toString('utf8').replace(/\0.*$/,'').trim();
  return raw?parseInt(raw,8):0;
}

function tarFiles(tgz){
  const tar=zlib.gunzipSync(tgz);
  const result=new Map();
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512);
    if(header.every(b=>b===0))break;
    const name=header.subarray(0,100).toString('utf8').replace(/\0.*$/,'');
    const prefix=header.subarray(345,500).toString('utf8').replace(/\0.*$/,'');
    const fullName=prefix?`${prefix}/${name}`:name;
    const size=parseOctal(header,124,12);
    const type=String.fromCharCode(header[156]||48);
    const start=offset+512;
    const end=start+size;
    if(end>tar.length)throw new Error(`Sérült npm tar archívum: ${fullName}`);
    if(type==='0'||type==='\0')result.set(fullName,Buffer.from(tar.subarray(start,end)));
    offset=start+Math.ceil(size/512)*512;
  }
  return result;
}

async function prepareXmllint(){
  const tgz=await download(XMLLINT_TARBALLS,'xmllint-wasm');
  const expected=XMLLINT_INTEGRITY.replace(/^sha512-/, '');
  const actual=crypto.createHash('sha512').update(tgz).digest('base64');
  if(actual!==expected)throw new Error(`xmllint-wasm npm integritási hiba: várt=${expected}, kapott=${actual}`);
  const files=tarFiles(tgz);
  const required=['package/index-node.js','package/xmllint-node.js','package/xmllint.wasm'];
  await fs.mkdir(VENDOR_OUT,{recursive:true});
  for(const item of required){
    const data=files.get(item);
    if(!data)throw new Error(`Hiányzó xmllint-wasm runtime fájl: ${item}`);
    await fs.writeFile(path.join(VENDOR_OUT,path.basename(item)),data);
  }
  const license=files.get('package/COPYING')||files.get('package/LICENSE')||files.get('package/LICENSE.md');
  if(license)await fs.writeFile(path.join(VENDOR_OUT,'LICENSE.txt'),license);
  return {version:XMLLINT_VERSION,integrity:XMLLINT_INTEGRITY,tarballSha256:sha256(tgz)};
}

async function main(){
  await fs.rm(path.join(ROOT,'.nav-build'),{recursive:true,force:true});
  await fs.mkdir(XSD_OUT,{recursive:true});
  const manifestSources=[];
  for(const source of sources){
    const original=await download(source.urls,source.name);
    verifyGitBlob(original,source.gitBlob,source.name);
    const patched=Buffer.from(patchSchemaLocations(source.name,original.toString('utf8')),'utf8');
    await fs.writeFile(path.join(XSD_OUT,source.name),patched);
    manifestSources.push({
      name:source.name,
      sourceUrl:source.urls[0],
      fallbackUrls:source.urls.slice(1),
      sourceGitBlob:source.gitBlob,
      originalSha256:sha256(original),
      runtimeSha256:sha256(patched),
      resolverPatched:!original.equals(patched)
    });
  }
  const validator=await prepareXmllint();
  const manifest={
    schema:'NAV Online Számla invoiceData 3.0',
    schemaRevision:`online-invoice:${NAV_COMMIT};common:${COMMON_COMMIT}`,
    onlineInvoiceCommit:NAV_COMMIT,
    commonCommit:COMMON_COMMIT,
    generatedAt:new Date().toISOString(),
    runtimeNetworkRequired:false,
    buildDownloadResilience:{attemptsPerSource:DOWNLOAD_ATTEMPTS,githubPrimary:'git-blob-api',githubFallback:'raw',githubMirror:'jsDelivr'},
    sources:manifestSources,
    validator:{name:'xmllint-wasm',...validator}
  };
  await fs.writeFile(path.join(XSD_OUT,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  console.log(`[NAV XSD] assets prepared: ${manifest.schemaRevision}; xmllint-wasm ${XMLLINT_VERSION}`);
}

main().catch(err=>{console.error('[NAV XSD] asset preparation failed:',err);process.exit(1)});
