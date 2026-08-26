import fs from "fs";
import PDFDocument from "pdfkit";

export type ReceiptPdfLine = {
  description: string;
  quantity: number;
  gross: number;
  vat_rate_percent: number;
  vat_category: string;
};

export type ReceiptPdfDocument = {
  receipt_number: string;
  document_type: "SALE" | "VOID";
  issued_at: string;
  issuer_name: string;
  issuer_tax_number: string;
  issuer_address: string;
  currency: string;
  gross_total: number;
  vat_breakdown: Array<{ vat_rate_percent: number; vat_category: string; gross: number; net: number; vat: number }>;
  lines: ReceiptPdfLine[];
  source_number?: string | null;
  customer_name?: string | null;
  original_receipt_number?: string | null;
  correction_reason?: string | null;
  document_hash?: string | null;
};

const text = (v: unknown, fallback = "—") => String(v ?? "").trim() || fallback;
const money = (v: unknown, currency: string) =>
  new Intl.NumberFormat("hu-HU", { style: "currency", currency, maximumFractionDigits: currency === "HUF" ? 0 : 2 }).format(Number(v || 0));
const dt = (v: unknown) => new Date(String(v)).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });

function fontPath(bold = false) {
  const candidates = bold
    ? ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"]
    : ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
function setFont(doc: PDFKit.PDFDocument, bold = false) {
  doc.font(fontPath(bold) || fontPath(false) || (bold ? "Helvetica-Bold" : "Helvetica"));
}
function asciiSafe(v: unknown) {
  return String(v ?? "").replace(/ő/g, "o").replace(/Ő/g, "O").replace(/ű/g, "u").replace(/Ű/g, "U")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[–—]/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}
function installFallback(doc: PDFKit.PDFDocument) {
  if (fontPath(false)) return;
  const original = (doc as any).text.bind(doc);
  (doc as any).text = (value: unknown, ...args: any[]) => original(asciiSafe(value), ...args);
}
function hr(doc: PDFKit.PDFDocument) {
  const y = doc.y + 5;
  doc.moveTo(38, y).lineTo(557, y).lineWidth(0.5).strokeColor("#c9c1cf").stroke();
  doc.moveDown(0.8);
}
function kv(doc: PDFKit.PDFDocument, label: string, value: unknown) {
  const y = doc.y;
  setFont(doc, true); doc.fillColor("#555").fontSize(8.5).text(`${label}:`, 38, y, { width: 145 });
  setFont(doc, false); doc.fillColor("#111").text(text(value), 185, y, { width: 370 });
  doc.y = Math.max(doc.y, y + 14);
}

export async function generateReceiptPdf(data: ReceiptPdfDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 38, info: { Title: `Nyugta ${data.receipt_number}`, CreationDate: new Date(data.issued_at) } });
    installFallback(doc);
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    setFont(doc, true);
    doc.fillColor("#3b2458").fontSize(19).text(data.document_type === "VOID" ? "ÉRVÉNYTELENÍTŐ NYUGTA" : "SZÁMÍTÓGÉPPEL ELŐÁLLÍTOTT NYUGTA", { align: "center" });
    doc.moveDown(0.4);
    setFont(doc, false); doc.fillColor("#666").fontSize(9).text(`Bizonylatszám: ${data.receipt_number}`, { align: "center" });
    doc.text(`Kibocsátás: ${dt(data.issued_at)}`, { align: "center" });
    doc.moveDown(1);

    kv(doc, "Kibocsátó", data.issuer_name);
    kv(doc, "Adószám", data.issuer_tax_number);
    kv(doc, "Cím", data.issuer_address);
    if (data.customer_name) kv(doc, "Vevő / vendég", data.customer_name);
    if (data.source_number) kv(doc, "Forrásbizonylat", data.source_number);
    if (data.document_type === "VOID") {
      kv(doc, "Eredeti nyugta", data.original_receipt_number);
      kv(doc, "Érvénytelenítés oka", data.correction_reason);
    }
    hr(doc);

    setFont(doc, true); doc.fillColor("#333").fontSize(10).text("Tételek"); doc.moveDown(0.4);
    setFont(doc, false); doc.fontSize(8.5);
    for (const line of data.lines || []) {
      if (doc.y > 710) doc.addPage();
      const y = doc.y;
      doc.fillColor("#111").text(text(line.description), 38, y, { width: 275 });
      doc.text(`${Number(line.quantity || 1).toLocaleString("hu-HU")} db`, 315, y, { width: 55, align: "right" });
      doc.text(`${line.vat_category || `${line.vat_rate_percent}%`}`, 378, y, { width: 70, align: "right" });
      doc.text(money(line.gross, data.currency), 455, y, { width: 100, align: "right" });
      doc.y = y + 15;
    }
    hr(doc);

    setFont(doc, true); doc.fillColor("#3b2458").fontSize(12).text("Fizetendő / végösszeg", 38, doc.y, { continued: true, width: 330 });
    doc.text(money(data.gross_total, data.currency), { align: "right" });
    doc.moveDown(0.8);

    setFont(doc, true); doc.fillColor("#333").fontSize(9).text("ÁFA-bontás");
    setFont(doc, false); doc.fontSize(8.2);
    for (const v of data.vat_breakdown || []) {
      doc.text(`${v.vat_category} · ${v.vat_rate_percent}%  |  bruttó ${money(v.gross, data.currency)}  |  nettó ${money(v.net, data.currency)}  |  ÁFA ${money(v.vat, data.currency)}`);
    }

    doc.moveDown(1.1); hr(doc);
    setFont(doc, false); doc.fillColor("#666").fontSize(7.8).text(
      "Elektronikus megjelenésű, számítógéppel előállított nyugta. A NAV jogszabályi terminológiája szerinti e-nyugta kizárólag engedélyezett e-pénztárgéppel állítható ki. A bizonylat eredeti példánya a VIR változtathatatlan bizonylat-nyilvántartásában kerül megőrzésre.",
      { align: "center" },
    );
    if (data.document_hash) {
      doc.moveDown(0.5); doc.fontSize(6.8).text(`Dokumentum-lenyomat: ${data.document_hash}`, { align: "center" });
    }
    doc.end();
  });
}
