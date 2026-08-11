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
    const closed=Boolean(j.locked_at||j.archived_at||j.completed_at||j.closed_at)||String(wo.status||'')==='completed'||String(j.document_status||'')==='completed';
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
    if(archive&&j.archive_hash==null){
      const hasHash=(await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name='archive_hash' LIMIT 1`)).rowCount;
      if(hasHash)await c.query(`UPDATE work_orders SET archive_hash=COALESCE(archive_hash,$2) WHERE id::text=$1`,[String(workOrderId),hash]).catch(()=>undefined);
    }
    await c.query('COMMIT');
    if(archive)console.warn('[workorder-document] missing archive self-healed',workOrderId);
    return archive;
  }catch(e){
    await c.query('ROLLBACK').catch(()=>undefined);
    throw e;
  }finally{c.release()}
}

export async function loadWorkOrderArchive(workOrderId:string){
  const table=(await db.query(`SELECT to_regclass('public.work_order_archive') IS NOT NULL ok`)).rows[0]?.ok;
  if(!table)return null;
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
    const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`Lezárt munkalap ${archive.work_order_number}`,Author:'Kleopátra Szépségszalonok',Subject:'Digitális munkalap'}});
    installSafeTextFallback(doc);
    doc.on('data',(c:Buffer)=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    setFont(doc,true);doc.fillColor('#2c2118').fontSize(9).text('KLEOPÁTRA SZÉPSÉGSZALONOK',{align:'center'});
    doc.moveDown(.35);doc.fontSize(21).text('LEZÁRT DIGITÁLIS MUNKALAP',{align:'center'});
    setFont(doc,false);doc.fillColor('#6b6158').fontSize(8.5).text('Archivált, zárolt munkalappéldány',{align:'center'});
    doc.moveDown(1);line(doc);

    heading(doc,'Munkalap adatai');
    kv(doc,'Munkalapszám',archive.work_order_number||header.work_order_number||header.id);
    kv(doc,'Státusz',archive.terminal_status||header.status);
    kv(doc,'Archiválva',dateTime(archive.archived_at));
    kv(doc,'Szalon',locationName||header.location_id);
    kv(doc,'Munkatárs',employeeName||header.employee_id);
    kv(doc,'Munkalap címe',header.title);
    kv(doc,'Létrehozva',dateTime(header.created_at));
    kv(doc,'Munka kezdete',dateTime(header.started_at||header.work_started_at));
    kv(doc,'Lezárva',dateTime(header.closed_at||header.completed_at||archive.archived_at));

    heading(doc,'Vendég');
    kv(doc,'Név',header.client_name);
    kv(doc,'Telefon',header.client_phone);
    kv(doc,'E-mail',header.client_email);
    if(header.notes)kv(doc,'Belső megjegyzés',header.notes);

    heading(doc,'Szolgáltatások és termékek');
    if(!items.length){doc.text('Nincs rögzített tétel.');doc.moveDown(.5)}
    for(const item of items){
      if(doc.y>735)doc.addPage();
      const kind=String(item.item_type||'')==='service'?'Szolgáltatás':'Termék';
      setFont(doc,true);doc.fontSize(9).fillColor('#222').text(`${kind}: ${text(item.item_name,'Tétel')}`,48,doc.y,{width:315,continued:false});
      setFont(doc,false);doc.fontSize(8.5).fillColor('#555').text(`${Number(item.quantity||1).toLocaleString('hu-HU')} × ${money(item.unit_price)}   Kedvezmény: ${money(item.discount_amount)}   Összesen: ${money(item.line_total)}`,65,doc.y+2,{width:470});
      doc.moveDown(.45);
    }

    heading(doc,'Fizetések');
    if(!payments.length){doc.text('Nincs rögzített fizetés.');doc.moveDown(.5)}
    const methodHu:Record<string,string>={cash:'Készpénz',card:'Bankkártya',transfer:'Átutalás',voucher:'Utalvány',other:'Egyéb'};
    for(const p of payments){
      if(doc.y>735)doc.addPage();
      const method=methodHu[String(p.payment_method||'').toLowerCase()]||text(p.payment_method,'Fizetés');
      setFont(doc,true);doc.fontSize(9).fillColor('#222').text(`${method} — ${money(p.amount)}`);
      setFont(doc,false);doc.fontSize(8).fillColor('#666').text(`${dateTime(p.paid_at)}${p.note?` · ${p.note}`:''}`);doc.moveDown(.35);
    }

    heading(doc,'Pénzügyi összesítő');
    const gross=header.gross_total??header.total_gross??items.reduce((n:number,x:any)=>n+Number(x.line_total||0),0);
    const paid=header.amount_paid??payments.reduce((n:number,x:any)=>n+Number(x.amount||0),0);
    kv(doc,'Bruttó tételérték',money(gross));
    kv(doc,'Kedvezmény',money(header.discount_amount));
    kv(doc,'Borravaló',money(header.tip_amount));
    kv(doc,'Fizetendő',money(header.amount_due??gross));
    kv(doc,'Kifizetve',money(paid));
    kv(doc,'Pénzügyi státusz',header.payment_status||'paid');
    kv(doc,'Pénzügyi zárás',dateTime(header.financial_closed_at));

    heading(doc,'Archiválási ellenőrző adatok');
    kv(doc,'Snapshot SHA-256',archive.snapshot_hash);
    setFont(doc,false);doc.fontSize(7.5).fillColor('#777').text('A dokumentum az adatbázisban tárolt lezáráskori snapshotból készült. A lezárt munkalap közvetlenül nem módosítható.',48,doc.y+6,{width:499,align:'center'});
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
