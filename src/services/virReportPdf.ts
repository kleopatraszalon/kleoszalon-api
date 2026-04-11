import PDFDocument from "pdfkit";

export type VirReportSummary = {
  revenue_total: number;
  paid_total: number;
  appointments_count: number;
  completed_count: number;
  cancelled_count: number;
  no_show_count: number;
  avg_basket: number;
  cancellation_rate_percent: number;
  no_show_rate_percent: number;
};

export type VirReportContext = {
  title: string;
  periodLabel: string;
  locationLabel: string;
  summary: VirReportSummary;
  topServices: Array<{ service_name: string; bookings_count: number; revenue_total: number }>;
  topStaff: Array<{ full_name?: string; short_name?: string; appointments_count: number; revenue_total?: number }>;
};

function money(v?: number | null) {
  return new Intl.NumberFormat("hu-HU", { style: "currency", currency: "HUF", maximumFractionDigits: 0 }).format(Number(v || 0));
}
function num(v?: number | null) {
  return new Intl.NumberFormat("hu-HU").format(Number(v || 0));
}
function pct(v?: number | null) {
  return `${Number(v || 0).toFixed(2)}%`;
}

export async function generateVirReportPdf(ctx: VirReportContext): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(22).text(ctx.title);
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#555").text(`Időszak: ${ctx.periodLabel}`);
    doc.text(`Helyszín: ${ctx.locationLabel}`);
    doc.moveDown(0.8);

    doc.fillColor("#000").fontSize(15).text("KPI összefoglaló");
    doc.moveDown(0.3);

    [
      ["Árbevétel", money(ctx.summary.revenue_total)],
      ["Fizetett", money(ctx.summary.paid_total)],
      ["Foglalások", num(ctx.summary.appointments_count)],
      ["Teljesített", num(ctx.summary.completed_count)],
      ["Lemondások", num(ctx.summary.cancelled_count)],
      ["No-show", num(ctx.summary.no_show_count)],
      ["Átlag kosárérték", money(ctx.summary.avg_basket)],
      ["Lemondási arány", pct(ctx.summary.cancellation_rate_percent)],
      ["No-show arány", pct(ctx.summary.no_show_rate_percent)],
    ].forEach(([l, v]) => doc.fontSize(11).text(`${l}: ${v}`));

    doc.moveDown(1);
    doc.fontSize(15).text("Top szolgáltatások");
    doc.moveDown(0.3);
    ctx.topServices.slice(0, 10).forEach((row, i) => {
      doc.fontSize(10).text(`${i + 1}. ${row.service_name} | Foglalás: ${num(row.bookings_count)} | Árbevétel: ${money(row.revenue_total)}`);
    });

    doc.moveDown(1);
    doc.fontSize(15).text("Top dolgozók");
    doc.moveDown(0.3);
    ctx.topStaff.slice(0, 10).forEach((row, i) => {
      const name = row.short_name || row.full_name || "Ismeretlen";
      doc.fontSize(10).text(`${i + 1}. ${name} | Foglalás: ${num(row.appointments_count)} | Árbevétel: ${money(row.revenue_total || 0)}`);
    });

    doc.end();
  });
}
