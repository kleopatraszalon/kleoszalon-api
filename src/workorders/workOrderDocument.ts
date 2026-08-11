import fs from 'fs';
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
  const p=fontPath(bold);
  doc.font(p|| (bold?'Helvetica-Bold':'Helvetica'));
}

function installSafeTextFallback(doc:PDFKit.PDFDocument){
  if(fontPath(false))return;
  const original=(doc as any).text.bind(doc);
  const safe=(v:any)=>String(v??'').replace(/ő/g,'o').replace(/Ő/g,'O').replace(/ű/g,'u').replace(/Ű/g,'U');
  (doc as any).text=(value:any,...args:any[])=>original(safe(value),...args);
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

export async function loadWorkOrderArchive(workOrderId:string){
  const q=await db.query(`SELECT * FROM work_order_archive WHERE work_order_id=$1::uuid ORDER BY archived_at DESC LIMIT 1`,[workOrderId]);
  return q.rows[0]||null;
}

export async function renderClosedWorkOrderPdf(archive:any):Promise<Buffer>{
  const snapshot=archive?.snapshot||{};
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

export async function generateAndDeliverClosedWorkOrder(workOrderId:string,options:{sendMail?:boolean;forceMail?:boolean}={}){
  const archive=await loadWorkOrderArchive(workOrderId);
  if(!archive)throw new Error('A lezárt munkalap archív példánya nem található.');
  const pdf=await renderClosedWorkOrderPdf(archive);
  await db.query(`UPDATE work_order_archive SET pdf_generated_at=now() WHERE work_order_id=$1::uuid`,[workOrderId]).catch(()=>undefined);
  const recipients=closedWorkOrderRecipients();
  let mail:any={attempted:false,sent:false,recipients};
  if(options.sendMail!==false){
    if(archive.email_sent_at&&!options.forceMail){
      mail={attempted:false,sent:true,already_sent:true,recipients,email_sent_at:archive.email_sent_at};
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
        await db.query(`UPDATE work_order_archive SET email_status=$2,email_recipients=$3::jsonb,email_error=NULL,email_sent_at=CASE WHEN $2='sent' THEN now() ELSE email_sent_at END WHERE work_order_id=$1::uuid`,[workOrderId,result.sent?'sent':'logged',JSON.stringify(recipients)]).catch(()=>undefined);
      }catch(e:any){
        mail={attempted:true,sent:false,recipients,error:String(e?.message||e)};
        await db.query(`UPDATE work_order_archive SET email_status='failed',email_recipients=$2::jsonb,email_error=$3 WHERE work_order_id=$1::uuid`,[workOrderId,JSON.stringify(recipients),String(e?.message||e)]).catch(()=>undefined);
      }
    }
  }
  return{archive,pdf,mail};
}
