import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type ExcelRow = Record<string, unknown>;

type ReadOptions = {
  defval?: unknown;
  raw?: boolean;
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/i)?.[0] || "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const file = files["xl/sharedStrings.xml"];
  if (!file) return [];
  const xml = strFromU8(file);
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    out.push(parts.join(""));
  }
  return out;
}

function firstWorksheetPath(files: Record<string, Uint8Array>): string {
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const firstSheet = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*\/?\s*>/);
  if (firstSheet) {
    const id = firstSheet[1];
    for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
      const attrs = rel[1];
      const rid = attrs.match(/\bId="([^"]+)"/)?.[1];
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
      if (rid === id && target) {
        const normalized = target.replace(/^\//, "").replace(/^\.\//, "");
        return normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
      }
    }
  }
  if (files["xl/worksheets/sheet1.xml"]) return "xl/worksheets/sheet1.xml";
  const fallback = Object.keys(files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!fallback) throw new Error("Az Excel munkafüzet nem tartalmaz munkalapot.");
  return fallback;
}

function inlineString(body: string): string {
  const parts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
  return parts.join("");
}

function parseCell(body: string, attrs: string, strings: string[], raw: boolean): unknown {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "n";
  if (type === "inlineStr") return inlineString(body);
  const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
  const value = decodeXml(rawValue);
  if (type === "s") return strings[Number(value)] ?? "";
  if (type === "str") return value;
  if (type === "b") return value === "1";
  if (type === "e") return raw ? value : "";
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? (raw ? n : String(value)) : value;
}

export async function readFirstSheetRows<T extends ExcelRow = ExcelRow>(buffer: Buffer, options: ReadOptions = {}): Promise<T[]> {
  const files = unzipSync(new Uint8Array(buffer));
  const strings = sharedStrings(files);
  const sheetPath = firstWorksheetPath(files);
  const sheetFile = files[sheetPath];
  if (!sheetFile) throw new Error("Az Excel munkalap nem olvasható.");
  const xml = strFromU8(sheetFile);
  const rows: unknown[][] = [];
  let maxColumn = -1;

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: unknown[] = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cell[1] ?? cell[3] ?? "";
      const body = cell[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1] || "";
      const idx = columnIndex(ref);
      maxColumn = Math.max(maxColumn, idx);
      cells[idx] = parseCell(body, attrs, strings, options.raw !== false);
    }
    rows.push(cells);
  }

  if (!rows.length) return [];
  const defval = Object.prototype.hasOwnProperty.call(options, "defval") ? options.defval : null;
  const headers = Array.from({ length: maxColumn + 1 }, (_v, i) => String(rows[0][i] ?? "").replace(/^\uFEFF/, "").trim());
  const out: T[] = [];
  for (let r = 1; r < rows.length; r++) {
    const source = rows[r];
    const obj: ExcelRow = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      const value = source[c];
      const normalized = value == null || value === "" ? defval : value;
      if (normalized !== null && normalized !== undefined && normalized !== "") hasValue = true;
      obj[header] = normalized;
    }
    if (hasValue) out.push(obj as T);
  }
  return out;
}

export function excelSerialToDate(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  const wholeDays = Math.floor(value);
  const fraction = value - wholeDays;
  const adjustedDays = wholeDays >= 60 ? wholeDays - 1 : wholeDays;
  const millis = Date.UTC(1899, 11, 31) + adjustedDays * 86400000 + Math.round(fraction * 86400000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cellXml(ref: string, value: unknown): string {
  if (value == null) return `<c r="${ref}" t="inlineStr"><is><t></t></is></c>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export async function rowsToXlsxBuffer(rows: ExcelRow[], sheetName = "Riport"): Promise<Buffer> {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const matrix: unknown[][] = [headers, ...rows.map((row) => headers.map((key) => row[key] ?? null))];
  const rowXml = matrix.map((row, r) => {
    const cells = row.map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value)).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const safeSheetName = escapeXml((sheetName || "Riport").slice(0, 31));
  const dimension = headers.length ? `A1:${columnName(headers.length - 1)}${Math.max(1, matrix.length)}` : "A1";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${rowXml}</sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
