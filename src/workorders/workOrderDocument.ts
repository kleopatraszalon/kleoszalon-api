import fs from 'fs';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import db from '../db';
import {sendEmail} from '../mailer';

const DEFAULT_RECIPIENTS=[
  'Birtalan.zoltan1975@gmail.com',
  'h.n.andrea@kleoszalon.hu',
  'rebeka.horvath@kleoszalon.hu',
];

const ISSUER={
  fullName:'Kleopátra 2003 Szépségápoló Szolgáltató és Kereskedelmi Korlátolt Felelősségű Társaság',
  shortName:'Kleopátra 2003 Kft.',
  taxNumber:'13094445-2-41',
  companyNumber:'01-09-882845',
  country:'Magyarország',
  address:'1132 Budapest, Visegrádi utca 8. fszt. 2.',
};

const money=(v:any)=>`${Math.round(Number(v||0)).toLocaleString('hu-HU')} Ft`;
const dateTime=(v:any)=>v?new Date(v).toLocaleString('hu-HU',{timeZone:'Europe/Budapest'}):'—';
const text=(v:any,fallback='—')=>String(v??'').trim()||fallback;

export function closedWorkOrderRecipients(){
  const configured=String(process.env.WORKORDER_CLOSE_EMAILS||'').trim();
  const raw=configured?configured.split(/[;,]/):DEFAULT_RECIPIENTS;
  return Array.from(new Set(raw.map(x=>x.trim()).filter(x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))));
}

function fontPath(bold=false){
  const candidates=bold
    ?['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf']
    :['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
  return candidates.find(p=>fs.existsSync(p))||null;
}

function setFont(doc:PDFKit.PDFDocument,bold=false){
  const requested=fontPath(bold);
  const regular=fontPath(false);
  doc.font(requested||regular||(bold?'Helvetica-Bold':'Helvetica'));
}

function asciiSafe(v:any){
  return String(v??'')
    .replace(/ő/g,'o').replace(/Ő/g,'O').replace(/ű/g,'u').replace(/Ű/g,'U')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/×/g,'x').replace(/[–—]/g,'-').replace(/·/g,' - ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g,'?');
}

function installSafeTextFallback(doc:PDFKit.PDFDocument){
  if(fontPath(false))return;
  const original=(doc as any).text.bind(doc);
  (doc as any).text=(value:any,...args:any[])=>original(asciiSafe(value),...args);
}

function logoPath(){
  const candidates=[
    process.env.WORKORDER_PDF_LOGO,
    `${process.cwd()}/images/kleo_logo.png`,
    `${process.cwd()}/kleopatra-landing/images/kleo_logo.png`,
    `${__dirname}/../../images/kleo_logo.png`,
  ].filter(Boolean) as string[];
  return candidates.find(p=>fs.existsSync(p))||null;
}

function line(doc:PDFKit.PDFDocument){
  const y=doc.y+3;
  doc.moveTo(48,y).lineTo(547,y).lineWidth(.5).strokeColor('#c9c2b7').stroke();
  doc.moveDown(.65);
}

function heading(doc:PDFKit.PDFDocument,title:string){
  if(doc.y>720)doc.addPage();
  setFont(doc,true);doc.fillColor('#2c2118').fontSize(12).text(title);
  setFont(doc,false);doc.fillColor('#222').fontSize(9);line(doc);
}

function kv(doc:PDFKit.PDFDocument,label:string,value:any){
  if(doc.y>748)doc.addPage();
  const y=doc.y;setFont(doc,true);doc.fontSize(8.5).fillColor('#5a5048').text(`${label}:`,48,y,{width:125});
  setFont(doc,false);doc.fillColor('#111').text(text(value),178,y,{width:360});doc.y=Math.max(doc.y,y+14);
}

function archiveSnapshot(archive:any){
  const raw=archive?.snapshot;
  if(raw&&typeof raw==='object')return raw;
  if(typeof raw==='string'){
    try{return JSON.parse(raw)}catch{return{}}
  }
  return{};
}

async function repairClosedWorkOrderArchive(workOrderId:string){
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const archiveTable=(await c.query(`SELECT to_regclass('public.work_order_archive') IS NOT NULL ok`)).rows[0]?.ok;
    if(!archiveTable){await c.query('ROLLBACK');return null}

    const existing=(await c.query(`SELECT * FROM work_order_archive WHERE work_order_id::text=$1 ORDER BY archived_at DESC LIMIT 1`,[String(workOrderId)])).rows[0];
    if(existing){await c.query('COMMIT');return existing}

    const wo=(await c.query(`SELECT w.*,to_jsonb(w) AS _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[String(workOrderId)])).rows[0];
    if(!wo){await c.query('ROLLBACK');return null}
    const j=wo._json||{};
    // Legacy finalization can persist the financial close even when an old
    // status/locking trigger silently keeps the service status unchanged.
    // A paid financial close is durable evidence that document recovery may
    // rebuild the missing immutable archive after the finalizer was invoked.
    const financiallyClosed=Boolean(j.financial_closed_at)&&String(j.payment_status||'')==='paid';
    const closed=Boolean(j.locked_at||j.archived_at||j.completed_at||j.closed_at)
      ||String(wo.status||'')==='completed'||String(j.document_status||'')==='completed'||financiallyClosed;
    if(!closed){await c.query('ROLLBACK');return null}

    const tableRows=async(table:string)=>{
      const exists=(await c.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok;
      if(!exists)return[];
      return (await c.query(`SELECT * FROM ${table} WHERE work_order_id::text=$1 ORDER BY id`,[String(workOrderId)])).rows;
    };
    const [items,payments]=await Promise.all([tableRows('work_order_items'),tableRows('work_order_payments')]);
    const header={...wo,status:'completed'};delete (header as any)._json;
    const snapshot={header,items,payments};
    const hash=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const number=String(wo.work_order_number||`KLEO-ML-${new Date(wo.created_at||Date.now()).getFullYear()}-${String(wo.id).replace(/-/g,'').slice(0,12).toUpperCase()}`);
    const idInfo=(await c.query(`SELECT data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='work_order_archive' AND column_name='work_order_id' LIMIT 1`)).rows[0];
    const textId=['text','character varying','character'].includes(String(idInfo?.data_type||''));
    const idExpr=textId?'$1':'$1::uuid';
    const archivedAt=wo.archived_at||wo.locked_at||wo.completed_at||wo.closed_at||new Date().toISOString();
    const inserted=(await c.query(`INSERT INTO work_order_archive(work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash)
      SELECT ${idExpr},$2,COALESCE($3::timestamptz,now()),'completed',$4::jsonb,$5
      WHERE NOT EXISTS(SELECT 1 FROM work_order_archive WHERE work_order_id::text=$1)
      RETURNING *`,[String(workOrderId),number,archivedAt,JSON.stringify(snapshot),hash])).rows[0];
    const archive=inserted||(await c.query(`SELECT * FROM work_order_archive WHERE work_order_id::text=$1 ORDER BY archived_at DESC LIMIT 1`,[String(workOrderId)])).rows[0]||null;
    await c.query('COMMIT');
    // Keep this optional legacy backfill outside the archive transaction.
    // A failing work_orders trigger must never poison and roll back the newly
    // committed immutable archive row.
    if(archive&&j.archive_hash==null){
      const hasHash=(await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name='archive_hash' LIMIT 1`)).rowCount;
      if(hasHash)await db.query(`UPDATE work_orders SET archive_hash=COALESCE(archive_hash,$2) WHERE id::text=$1`,[String(workOrderId),hash]).catch(()=>undefined);
    }
    if(archive)console.warn('[workorder-document] missing archive self-healed',workOrderId);
    return archive;
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    // A few legacy databases still have an archive trigger whose internal
    // text/uuid comparison prevents persistence. Document delivery must not
    // depend on that obsolete trigger: build the same immutable snapshot in
    // memory and keep the hash visible in the generated document.
    console.warn('[workorder-document] persistent archive repair failed; virtual archive fallback',e?.code||'',e?.message||e);
    return buildVirtualClosedWorkOrderArchive(String(workOrderId));
  }finally{c.release()}
}

async function buildVirtualClosedWorkOrderArchive(workOrderId:string){
  const wo=(await db.query(`SELECT w.*,to_jsonb(w) AS _json FROM work_orders w WHERE w.id::text=$1`,[workOrderId])).rows[0];
  if(!wo)return null;
  const j=wo._json||{};
  const financiallyClosed=Boolean(j.financial_closed_at)&&String(j.payment_status||'')==='paid';
  const closed=Boolean(j.locked_at||j.archived_at||j.completed_at||j.closed_at)
    ||String(wo.status||'')==='completed'||String(j.document_status||'')==='completed'||financiallyClosed;
  if(!closed)return null;
  const rows=async(table:string)=>{
    const exists=(await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok;
    if(!exists)return[];
    return (await db.query(`SELECT * FROM ${table} WHERE work_order_id::text=$1 ORDER BY id`,[workOrderId])).rows;
  };
  const [items,payments]=await Promise.all([rows('work_order_items'),rows('work_order_payments')]);
  const header={...wo,status:'completed'};delete (header as any)._json;
  const snapshot={header,items,payments};
  const snapshotHash=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return{
    id:null,work_order_id:workOrderId,
    work_order_number:String(wo.work_order_number||`KLEO-ML-${new Date(wo.created_at||Date.now()).getFullYear()}-${workOrderId.replace(/-/g,'').slice(0,12).toUpperCase()}`),
    archived_at:wo.archived_at||wo.locked_at||wo.completed_at||wo.closed_at||wo.financial_closed_at||new Date().toISOString(),
    terminal_status:'completed',snapshot,snapshot_hash:snapshotHash,virtual_recovery:true,
  };
}

export async function loadWorkOrderArchive(workOrderId:string){
  const table=(await db.query(`SELECT to_regclass('public.work_order_archive') IS NOT NULL ok`)).rows[0]?.ok;
  if(!table)return buildVirtualClosedWorkOrderArchive(String(workOrderId));
  const q=await db.query(`SELECT * FROM work_order_archive WHERE work_order_id::text=$1 ORDER BY archived_at DESC LIMIT 1`,[String(workOrderId)]);
  if(q.rows[0])return q.rows[0];
  return repairClosedWorkOrderArchive(String(workOrderId));
}

export async function renderClosedWorkOrderPdf(archive:any):Promise<Buffer>{
  const snapshot=archiveSnapshot(archive);
  const header=snapshot?.header||{};
  const items=Array.isArray(snapshot?.items)?snapshot.items:[];
  const payments=Array.isArray(snapshot?.payments)?snapshot.payments:[];
  let locationName='';let employeeName='';
  try{
    if(header.location_id)locationName=(await db.query(`SELECT name FROM locations WHERE id::text=$1 LIMIT 1`,[String(header.location_id)])).rows[0]?.name||'';
    if(header.employee_id)employeeName=(await db.query(`SELECT full_name FROM employees WHERE id::text=$1 LIMIT 1`,[String(header.employee_id)])).rows[0]?.full_name||'';
  }catch{}

  return await new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];
    const doc=new PDFDocument({size:'A4',margin:42,bufferPages:true,info:{Title:`Lezárt munkalap ${archive.work_order_number}`,Author:ISSUER.shortName,Subject:'Számla megjelenésű lezárt digitális munkalap'}});
    installSafeTextFallback(doc);
    doc.on('data',(c:Buffer)=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    const pageWidth=595.28,left=42,right=553.28,contentWidth=right-left;
    const brown='#2d211b',gold='#b28a52',muted='#6f665f',pale='#f5f1eb',border='#d8d0c6';
    const label=(value:any,x:number,y:number,w:number)=>{setFont(doc,true);doc.fillColor(muted).fontSize(7.2).text(String(value).toUpperCase(),x,y,{width:w,characterSpacing:.4})};
    const value=(v:any,x:number,y:number,w:number,size=9)=>{setFont(doc,false);doc.fillColor('#191512').fontSize(size).text(text(v),x,y,{width:w})};
    const box=(x:number,y:number,w:number,h:number)=>doc.roundedRect(x,y,w,h,5).lineWidth(.7).strokeColor(border).stroke();
    const addFooter=(pageNo:number,total:number)=>{
      const y=758;doc.save();doc.moveTo(left,y-9).lineTo(right,y-9).lineWidth(.6).strokeColor(border).stroke();
      setFont(doc,false);doc.fillColor(muted).fontSize(6.6).text('Ez a dokumentum lezárt digitális munkalap és számviteli bizonylati melléklet. Nem minősül adóügyi számlának, nyugtának vagy NAV Online Számla adatszolgáltatásnak, és azokat nem helyettesíti.',left,y,{width:420,lineGap:1});
      doc.text(`${pageNo} / ${total}`,right-70,y,{width:70,align:'right'});doc.restore();
    };
    const addContinuationHeader=()=>{
      setFont(doc,true);doc.fillColor(brown).fontSize(8).text(ISSUER.shortName,left,34,{width:190});
      setFont(doc,false);doc.fillColor(muted).fontSize(7.2).text(`${archive.work_order_number||header.work_order_number||header.id} - folytatás`,300,34,{width:right-300,align:'right'});
      doc.moveTo(left,48).lineTo(right,48).lineWidth(.6).strokeColor(gold).stroke();doc.y=60;
    };
    const ensureSpace=(height:number)=>{if(doc.y+height>735){doc.addPage();doc.y=48}};

    const logo=logoPath();
    if(logo)doc.image(logo,left,42,{fit:[175,55],valign:'center'});
    else{setFont(doc,true);doc.fillColor(brown).fontSize(18).text('KLEOPÁTRA',left,51,{width:180});setFont(doc,false);doc.fontSize(7).fillColor(gold).text('SZÉPSÉGSZALONOK',left,73,{width:180,characterSpacing:1.4})}
    setFont(doc,true);doc.fillColor(brown).fontSize(19).text('LEZÁRT MUNKALAP',310,45,{width:243,align:'right'});
    setFont(doc,false);doc.fillColor(muted).fontSize(8).text('Számla megjelenésű archivált bizonylat',310,70,{width:243,align:'right'});
    doc.moveTo(left,105).lineTo(right,105).lineWidth(1.5).strokeColor(gold).stroke();

    const metaY=120;box(left,metaY,contentWidth,57);
    const meta=[
      ['Bizonylatszám',archive.work_order_number||header.work_order_number||header.id],
      ['Kiállítás / archiválás',dateTime(archive.archived_at)],
      ['Teljesítés / lezárás',dateTime(header.closed_at||header.completed_at||archive.archived_at)],
      ['Fizetési státusz',String(header.payment_status||'paid')==='paid'?'Kifizetve':header.payment_status||'—'],
    ];
    meta.forEach((m,i)=>{const x=left+14+i*(contentWidth/4);label(m[0],x,metaY+11,contentWidth/4-20);value(m[1],x,metaY+28,contentWidth/4-20,i===0?9.2:8.2)});

    const partyY=193,partyW=(contentWidth-12)/2,partyH=128;box(left,partyY,partyW,partyH);box(left+partyW+12,partyY,partyW,partyH);
    label('Kibocsátó',left+14,partyY+12,partyW-28);setFont(doc,true);doc.fillColor(brown).fontSize(9.6).text(ISSUER.shortName,left+14,partyY+29,{width:partyW-28});
    setFont(doc,false);doc.fillColor('#29231f').fontSize(7.4).text(ISSUER.fullName,left+14,partyY+45,{width:partyW-28,lineGap:1});
    doc.fontSize(7.7).text(`${ISSUER.country}\n${ISSUER.address}\nAdószám: ${ISSUER.taxNumber}\nCégjegyzékszám: ${ISSUER.companyNumber}`,left+14,partyY+75,{width:partyW-28,lineGap:2});
    const customerX=left+partyW+26;label('Vevő / Vendég',customerX,partyY+12,partyW-28);setFont(doc,true);doc.fillColor(brown).fontSize(10).text(text(header.client_name,'Nincs megadva'),customerX,partyY+30,{width:partyW-28});
    setFont(doc,false);doc.fillColor('#29231f').fontSize(8).text(`E-mail: ${text(header.client_email)}\nTelefon: ${text(header.client_phone)}\nSzalon: ${text(locationName||header.location_id)}\nMunkatárs: ${text(employeeName||header.employee_id)}`,customerX,partyY+52,{width:partyW-28,lineGap:3});

    doc.y=340;setFont(doc,true);doc.fillColor(brown).fontSize(11).text('Tételek',left,doc.y);doc.y+=18;
    const cols=[left,left+260,left+316,left+389,left+453,right];
    const drawTableHeader=()=>{const y=doc.y;doc.rect(left,y,contentWidth,24).fill(pale);setFont(doc,true);doc.fillColor(brown).fontSize(7.2);doc.text('MEGNEVEZÉS',cols[0]+7,y+8,{width:245});doc.text('MENNY.',cols[1],y+8,{width:50,align:'right'});doc.text('EGYSÉGÁR',cols[2],y+8,{width:66,align:'right'});doc.text('KEDVEZMÉNY',cols[3],y+8,{width:58,align:'right'});doc.text('ÖSSZESEN',cols[4],y+8,{width:55,align:'right'});doc.y=y+24};
    drawTableHeader();
    if(!items.length){setFont(doc,false);doc.fillColor(muted).fontSize(8).text('Nincs rögzített tétel.',left+7,doc.y+9);doc.y+=29}
    for(const item of items){
      if(doc.y>700){doc.addPage();addContinuationHeader();drawTableHeader()}
      const y=doc.y,rowH=31;doc.moveTo(left,y+rowH).lineTo(right,y+rowH).lineWidth(.45).strokeColor(border).stroke();
      setFont(doc,true);doc.fillColor('#211b17').fontSize(8).text(text(item.item_name,'Tétel'),cols[0]+7,y+7,{width:245,height:12,ellipsis:true});
      setFont(doc,false);doc.fillColor(muted).fontSize(6.5).text(String(item.item_type||'')==='service'?'Szolgáltatás':'Termék',cols[0]+7,y+19,{width:245});
      doc.fillColor('#211b17').fontSize(7.6).text(Number(item.quantity||1).toLocaleString('hu-HU'),cols[1],y+11,{width:50,align:'right'});
      doc.text(money(item.unit_price),cols[2],y+11,{width:66,align:'right'});doc.text(money(item.discount_amount),cols[3],y+11,{width:58,align:'right'});setFont(doc,true);doc.text(money(item.line_total),cols[4],y+11,{width:55,align:'right'});doc.y=y+rowH;
    }

    const methodHu:Record<string,string>={cash:'Készpénz',card:'Bankkártya',transfer:'Átutalás',voucher:'Utalvány',other:'Egyéb'};
    const gross=header.gross_total??header.total_gross??items.reduce((n:number,x:any)=>n+Number(x.line_total||0),0);
    const paid=header.amount_paid??payments.reduce((n:number,x:any)=>n+Number(x.amount||0),0);
    ensureSpace(150);doc.y+=18;const sumY=doc.y,payW=300,sumX=left+318;label('Fizetés',left,sumY,payW);
    setFont(doc,false);doc.fillColor('#29231f').fontSize(7.6);
    if(payments.length)payments.slice(0,5).forEach((p:any,i:number)=>{const method=methodHu[String(p.payment_method||'').toLowerCase()]||text(p.payment_method,'Fizetés');doc.text(`${method}  |  ${dateTime(p.paid_at)}  |  ${money(p.amount)}`,left,sumY+17+i*14,{width:payW})});
    else doc.text('Nincs rögzített fizetési sor.',left,sumY+17,{width:payW});
    box(sumX,sumY-3,right-sumX,92);const totals=[['Bruttó tételérték',gross],['Kedvezmény',header.discount_amount],['Borravaló',header.tip_amount],['Fizetendő',header.amount_due??gross],['Kifizetve',paid]];
    totals.forEach((r,i)=>{const y=sumY+8+i*15;setFont(doc,i===3||i===4);doc.fillColor(i===3?brown:muted).fontSize(i===3?9:7.7).text(r[0],sumX+12,y,{width:90});doc.fillColor(i===3?brown:'#211b17').text(money(r[1]),sumX+105,y,{width:76,align:'right'})});

    doc.y=Math.max(sumY+108,doc.y);ensureSpace(82);const auditY=doc.y;doc.rect(left,auditY,contentWidth,64).fill(pale);label('Archiválási ellenőrző adatok',left+12,auditY+10,220);setFont(doc,false);doc.fillColor(muted).fontSize(6.7).text(`Snapshot SHA-256: ${archive.snapshot_hash}`,left+12,auditY+26,{width:contentWidth-24});doc.text(`Munkalap: ${text(header.title)}  |  Létrehozva: ${dateTime(header.created_at)}  |  Pénzügyi zárás: ${dateTime(header.financial_closed_at)}`,left+12,auditY+41,{width:contentWidth-24});

    const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);addFooter(i+1,range.count)}
    doc.end();
  });
}

async function renderEmergencyClosedWorkOrderPdf(archive:any):Promise<Buffer>{
  const snapshot=archiveSnapshot(archive);const header=snapshot?.header||{};
  return await new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',margin:48});
    doc.on('data',(c:Buffer)=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    doc.font('Helvetica-Bold').fontSize(18).text(asciiSafe('KLEOPÁTRA – LEZÁRT DIGITÁLIS MUNKALAP'),{align:'center'});
    doc.moveDown();doc.font('Helvetica').fontSize(10);
    const rows=[
      ['Munkalapszám',archive.work_order_number||header.work_order_number||header.id],
      ['Archiválva',dateTime(archive.archived_at)],['Státusz',archive.terminal_status||header.status||'completed'],
      ['Vendég',header.client_name],['E-mail',header.client_email],['Munkalap címe',header.title],
      ['Fizetendő',money(header.amount_due??header.gross_total??0)],['Kifizetve',money(header.amount_paid??0)],
      ['Snapshot SHA-256',archive.snapshot_hash]
    ];
    for(const[label,value]of rows)doc.text(asciiSafe(`${label}: ${text(value)}`));
    doc.moveDown();doc.fontSize(8).text(asciiSafe('Technikai tartalék PDF: a teljes archivált munkalap továbbra is az adatbázis snapshotban található.'));
    doc.end();
  });
}

export async function generateAndDeliverClosedWorkOrder(workOrderId:string,options:{sendMail?:boolean;forceMail?:boolean}={}){
  const archive=await loadWorkOrderArchive(workOrderId);
  if(!archive)throw new Error('A lezárt munkalap archív példánya nem található.');
  let pdf:Buffer;let pdfFallback=false;
  try{pdf=await renderClosedWorkOrderPdf(archive)}
  catch(e:any){
    pdfFallback=true;
    console.warn('[workorder-document] rich PDF failed, emergency PDF used',e?.message||e);
    pdf=await renderEmergencyClosedWorkOrderPdf(archive);
  }
  await db.query(`UPDATE work_order_archive SET pdf_generated_at=now() WHERE work_order_id::text=$1`,[String(workOrderId)]).catch(()=>undefined);
  const recipients=closedWorkOrderRecipients();
  let mail:any={attempted:false,sent:false,recipients};
  if(options.sendMail!==false){
    if(archive.email_sent_at&&!options.forceMail){
      mail={attempted:false,sent:true,already_sent:true,recipients,email_sent_at:archive.email_sent_at};
    }else if(!recipients.length){
      mail={attempted:false,sent:false,recipients,error:'Nincs érvényes munkalap-zárási e-mail címzett konfigurálva.'};
    }else{
      try{
        const result=await sendEmail({
          to:recipients.join(', '),
          subject:`Kleopátra – lezárt munkalap ${archive.work_order_number}`,
          text:`A ${archive.work_order_number} számú munkalap véglegesen lezárásra és archiválásra került.\n\nA lezárt digitális munkalap PDF formátumban csatolva található.\n\nKleopátra Szépségszalonok`,
          html:`<p>A <strong>${archive.work_order_number}</strong> számú munkalap véglegesen lezárásra és archiválásra került.</p><p>A lezárt digitális munkalap PDF formátumban csatolva található.</p><p>Kleopátra Szépségszalonok</p>`,
          attachments:[{filename:`${archive.work_order_number||'munkalap'}.pdf`,content:pdf,contentType:'application/pdf'}],
        });
        mail={attempted:true,...result,recipients};
        await db.query(`UPDATE work_order_archive SET email_status=$2,email_recipients=$3::jsonb,email_error=NULL,email_sent_at=CASE WHEN $2='sent' THEN now() ELSE email_sent_at END WHERE work_order_id::text=$1`,[String(workOrderId),result.sent?'sent':'logged',JSON.stringify(recipients)]).catch(()=>undefined);
      }catch(e:any){
        mail={attempted:true,sent:false,recipients,error:String(e?.message||e)};
        await db.query(`UPDATE work_order_archive SET email_status='failed',email_recipients=$2::jsonb,email_error=$3 WHERE work_order_id::text=$1`,[String(workOrderId),JSON.stringify(recipients),String(e?.message||e)]).catch(()=>undefined);
      }
    }
  }
  return{archive,pdf,pdf_fallback:pdfFallback,mail};
}
