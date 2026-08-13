import fs from "fs";
import PDFDocument from "pdfkit";

export type CashierClosePdfContext = {
  report: any;
  handovers: any[];
};

const money = (v: any) => `${Math.round(Number(v || 0)).toLocaleString("hu-HU")} Ft`;
const dt = (v: any) =>
  v ? new Date(v).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }) : "—";
const text = (v: any, fallback = "—") => String(v ?? "").trim() || fallback;

function fontPath(bold = false) {
  const candidates = bold
    ? [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
      ]
    : [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
      ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function setFont(doc: PDFKit.PDFDocument, bold = false) {
  const requested = fontPath(bold);
  const regular = fontPath(false);
  doc.font(requested || regular || (bold ? "Helvetica-Bold" : "Helvetica"));
}

function asciiSafe(v: any) {
  return String(v ?? "")
    .replace(/ő/g, "o")
    .replace(/Ő/g, "O")
    .replace(/ű/g, "u")
    .replace(/Ű/g, "U")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

function installSafeTextFallback(doc: PDFKit.PDFDocument) {
  if (fontPath(false)) return;
  const original = (doc as any).text.bind(doc);
  (doc as any).text = (value: any, ...args: any[]) => original(asciiSafe(value), ...args);
}

function hr(doc: PDFKit.PDFDocument) {
  const y = doc.y + 4;
  doc.moveTo(42, y).lineTo(553, y).lineWidth(0.5).strokeColor("#d0c7d9").stroke();
  doc.moveDown(0.8);
}

function heading(doc: PDFKit.PDFDocument, value: string) {
  if (doc.y > 720) doc.addPage();
  setFont(doc, true);
  doc.fillColor("#3b2458").fontSize(12).text(value);
  setFont(doc, false);
  doc.fillColor("#222").fontSize(9);
  hr(doc);
}

function kv(doc: PDFKit.PDFDocument, label: string, value: any) {
  if (doc.y > 748) doc.addPage();
  const y = doc.y;
  setFont(doc, true);
  doc.fillColor("#5f5667").fontSize(8.5).text(`${label}:`, 42, y, { width: 145 });
  setFont(doc, false);
  doc.fillColor("#111").text(text(value), 190, y, { width: 355 });
  doc.y = Math.max(doc.y, y + 14);
}

function moneyRow(doc: PDFKit.PDFDocument, label: string, value: any, emphasis = false) {
  if (doc.y > 748) doc.addPage();
  const y = doc.y;
  setFont(doc, emphasis);
  doc.fillColor(emphasis ? "#3b2458" : "#333").fontSize(emphasis ? 10 : 9).text(label, 42, y, { width: 300 });
  doc.text(money(value), 360, y, { width: 185, align: "right" });
  doc.y = y + (emphasis ? 18 : 15);
  setFont(doc, false);
}

export async function generateCashierClosePdf(ctx: CashierClosePdfContext): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const r = ctx.report || {};
    const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: `Pénztárzárás ${r.report_no || ""}` } });
    installSafeTextFallback(doc);
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    setFont(doc, true);
    doc.fillColor("#3b2458").fontSize(20).text("KLEOPÁTRA – PÉNZTÁRZÁRÁSI JEGYZŐKÖNYV", { align: "center" });
    doc.moveDown(0.4);
    setFont(doc, false);
    doc.fillColor("#666").fontSize(9).text(`Jegyzőkönyv: ${text(r.report_no)}`, { align: "center" });
    doc.text(`Üzleti nap: ${text(r.business_date)}`, { align: "center" });
    doc.moveDown(1);

    heading(doc, "Műszak adatai");
    kv(doc, "Telephely", r.location_name || r.location_id);
    kv(doc, "Nyitotta", r.opened_by);
    kv(doc, "Nyitás időpontja", dt(r.opened_at));
    kv(doc, "Zárta", r.closed_by);
    kv(doc, "Zárás időpontja", dt(r.closed_at));
    kv(doc, "Átadás-átvételek", Number(r.handover_count || 0));

    heading(doc, "Pénztári összesítés");
    moneyRow(doc, "Nyitópénz", r.opening_cash);
    moneyRow(doc, "Készpénzes értékesítés", r.cash_sales);
    moneyRow(doc, "Bankkártyás értékesítés", r.card_sales);
    moneyRow(doc, "Átutalás", r.transfer_sales);
    moneyRow(doc, "Utalvány", r.voucher_sales);
    moneyRow(doc, "Egyéb fizetés", r.other_sales);
    moneyRow(doc, "Kasszabevét", r.cash_in);
    moneyRow(doc, "Kasszakivét", r.cash_out);
    moneyRow(doc, "Kedvezmények", r.discounts);
    moneyRow(doc, "Borravaló", r.tips);
    hr(doc);
    moneyRow(doc, "Várt készpénzkészlet", r.expected_cash, true);
    moneyRow(doc, "Megszámolt készpénz", r.counted_cash, true);
    moneyRow(doc, "Eltérés", r.difference, true);

    if (ctx.handovers?.length) {
      heading(doc, "Pénztáros átadás-átvételek");
      ctx.handovers.forEach((h, index) => {
        if (doc.y > 700) doc.addPage();
        setFont(doc, true);
        doc.fillColor("#222").fontSize(9).text(`${index + 1}. ${text(h.from_cashier)} → ${text(h.to_cashier)}`);
        setFont(doc, false);
        doc.fillColor("#555").fontSize(8.5).text(
          `Átadás: ${dt(h.handed_over_at)} | Átvétel: ${dt(h.accepted_at)} | Várt: ${money(h.expected_cash)} | Átadó számolás: ${money(h.counted_cash)} | Átvevő számolás: ${money(h.accepted_counted_cash)}`,
        );
        if (h.note || h.accept_note) doc.text(`Megjegyzés: ${text(h.note || h.accept_note)}`);
        doc.moveDown(0.5);
      });
    }

    heading(doc, "Zárási nyilatkozat");
    doc.fontSize(9).fillColor("#222").text(
      "A pénztárzárás adatai a VIR rendszerben rögzített fizetések, kasszamozgások és pénztáros átadás-átvételek alapján készültek. A megszámolt készpénz és a várt készpénzkészlet eltérése a jegyzőkönyvben külön feltüntetésre kerül.",
    );
    doc.moveDown(0.8);
    kv(doc, "Zárási megjegyzés", r.close_note);
    doc.moveDown(1.2);
    doc.fontSize(8).fillColor("#777").text(`Generálva: ${dt(new Date())} · VIR pénztár 13. etap`, { align: "center" });

    doc.end();
  });
}
