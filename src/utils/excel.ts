import ExcelJS from "exceljs";

export type ExcelRow = Record<string, unknown>;

type ReadOptions = {
  defval?: unknown;
  raw?: boolean;
};

function cellValue(value: ExcelJS.CellValue, raw: boolean): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;

  const anyValue = value as any;
  if (Object.prototype.hasOwnProperty.call(anyValue, "result")) return anyValue.result ?? null;
  if (Array.isArray(anyValue.richText)) return anyValue.richText.map((x: any) => x?.text ?? "").join("");
  if (typeof anyValue.text === "string") return anyValue.text;
  if (typeof anyValue.hyperlink === "string") return anyValue.text || anyValue.hyperlink;
  if (raw) return anyValue;
  return String(anyValue.text ?? anyValue.result ?? "");
}

export async function readFirstSheetRows<T extends ExcelRow = ExcelRow>(buffer: Buffer, options: ReadOptions = {}): Promise<T[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const defval = Object.prototype.hasOwnProperty.call(options, "defval") ? options.defval : null;
  const raw = options.raw !== false;
  const headerRow = worksheet.getRow(1);
  const maxColumn = Math.max(headerRow.cellCount, worksheet.columnCount);
  const headers: string[] = [];

  for (let c = 1; c <= maxColumn; c++) {
    const value = cellValue(headerRow.getCell(c).value, false);
    headers.push(String(value ?? "").replace(/^\uFEFF/, "").trim());
  }

  const rows: T[] = [];
  for (let r = 2; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const out: ExcelRow = {};
    let hasValue = false;

    for (let c = 1; c <= headers.length; c++) {
      const header = headers[c - 1];
      if (!header) continue;
      const value = cellValue(row.getCell(c).value, raw);
      const normalized = value == null || value === "" ? defval : value;
      if (normalized !== null && normalized !== undefined && normalized !== "") hasValue = true;
      out[header] = normalized;
    }

    if (hasValue) rows.push(out as T);
  }
  return rows;
}

export function excelSerialToDate(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  // Excel's 1900 date system includes the historic fake 1900-02-29 day.
  const wholeDays = Math.floor(value);
  const fraction = value - wholeDays;
  const adjustedDays = wholeDays >= 60 ? wholeDays - 1 : wholeDays;
  const epoch = Date.UTC(1899, 11, 31);
  const millis = epoch + adjustedDays * 86400000 + Math.round(fraction * 86400000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function rowsToXlsxBuffer(rows: ExcelRow[], sheetName = "Riport"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName.slice(0, 31) || "Sheet1");
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  if (headers.length) {
    worksheet.addRow(headers);
    for (const row of rows) worksheet.addRow(headers.map((key) => row[key] ?? null));
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }

  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes as ArrayBuffer);
}
