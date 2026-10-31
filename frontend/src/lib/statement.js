// Read any bank statement file into rows of text cells.
// CSV / TXT / TSV are read directly; Excel (.xlsx, .xls — including the "HTML .xls" many
// Indian banks send), .xlsm and .ods are read with SheetJS, loaded only when needed.
import { parseCsv } from "./csv";

export const ACCEPT = ".csv,.txt,.tsv,.xls,.xlsx,.xlsm,.ods";
const SHEET_EXT = ["xls", "xlsx", "xlsm", "ods"];
const pad = (n) => String(n).padStart(2, "0");

const ext = (name) => (name.split(".").pop() || "").toLowerCase();
const looksLikeHeader = (row) => row.length >= 3 && row.some((c) => /date|\bdt\b/i.test(c));

function parseDelimited(text) {
  // Tab-separated files (some banks' ".xls"/".txt" downloads) — use tabs if a row has more tabs than commas.
  const sample = text.split(/\r?\n/).slice(0, 30).join("\n");
  if ((sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length) {
    return text
      .split(/\r?\n/)
      .map((l) => l.split("\t").map((c) => c.replace(/^"|"$/g, "").trim()))
      .filter((r) => r.some((c) => c !== ""));
  }
  return parseCsv(text);
}

function sheetRows(XLSX, ws) {
  if (!ws || !ws["!ref"]) return [];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v === undefined || cell.v === null) {
        row.push("");
      } else if (cell.t === "n" && cell.z && XLSX.SSF.is_date(cell.z)) {
        // A real Excel date: take the calendar date exactly (no time-zone or dd/mm vs mm/dd guessing).
        const d = XLSX.SSF.parse_date_code(cell.v);
        row.push(`${d.y}-${pad(d.m)}-${pad(d.d)}`);
      } else if (cell.t === "d" && cell.v instanceof Date) {
        const d = cell.v;
        row.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      } else {
        row.push(String(cell.v).trim());
      }
    }
    if (row.some((c) => c !== "")) rows.push(row);
  }
  return rows;
}

/**
 * Returns { sheets: [{ name, rows }], defaultSheet } for any supported file.
 * CSV/TXT give a single sheet.
 */
export async function readStatementFile(file) {
  const e = ext(file.name);
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, 8));
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // xlsx / ods
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf; // classic .xls

  if (SHEET_EXT.includes(e) || isZip || isOle) {
    const XLSX = await import("xlsx");
    let wb;
    try {
      wb = XLSX.read(buf, { type: "array", cellNF: true, cellDates: false, raw: true, dense: false });
    } catch (err) {
      throw new Error("This file couldn't be read as a spreadsheet. Try saving it as .xlsx or .csv from Excel.");
    }
    const sheets = wb.SheetNames.map((name) => ({ name, rows: sheetRows(XLSX, wb.Sheets[name]) })).filter((s) => s.rows.length);
    if (!sheets.length) throw new Error("The file has no data in it.");
    const best = sheets.findIndex((s) => s.rows.some(looksLikeHeader));
    return { sheets, defaultSheet: best === -1 ? 0 : best };
  }

  const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  const rows = parseDelimited(text);
  if (!rows.length) throw new Error("The file has no data in it.");
  return { sheets: [{ name: file.name, rows }], defaultSheet: 0 };
}
