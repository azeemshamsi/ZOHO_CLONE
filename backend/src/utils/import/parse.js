/**
 * Read an uploaded file: Excel (.xlsx/.xls/.ods) and CSV → sheets of row objects;
 * XML (Tally exports, often UTF-16) → a parsed object.
 */
const XLSX = require("xlsx");
const { XMLParser } = require("fast-xml-parser");
const { key } = require("./common");

const KNOWN = require("./sheets").ALL_ALIASES;

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.slice(2));
    b.swap16();
    return b.toString("utf16le");
  }
  // UTF-16 without BOM: lots of zero bytes
  if (buf.length > 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

// Find the header row: the row (in the first 25) that matches the most known column names.
function rowsFromSheet(ws) {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: false });
  if (!grid.length) return [];
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(25, grid.length); i++) {
    const cells = grid[i].map((c) => key(c)).filter(Boolean);
    const score = cells.filter((c) => KNOWN.has(c)).length * 3 + (cells.length >= 2 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const headers = grid[best].map((h, i) => String(h || "").trim() || `Column ${i + 1}`);
  const seen = {};
  const uniq = headers.map((h) => (seen[h] = (seen[h] || 0) + 1) > 1 ? `${h} ${seen[h]}` : h);
  return grid
    .slice(best + 1)
    .filter((r) => r.some((c) => String(c).trim() !== ""))
    .map((r) => Object.fromEntries(uniq.map((h, i) => [h, r[i] instanceof Date ? r[i] : r[i] ?? ""])));
}

const LISTS = new Set(["TALLYMESSAGE", "ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST", "ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST", "INVENTORYENTRIESIN.LIST", "INVENTORYENTRIESOUT.LIST", "BILLALLOCATIONS.LIST", "ACCOUNTINGALLOCATIONS.LIST", "ADDRESS.LIST", "ADDRESS", "LEDGSTREGDETAILS.LIST", "LEDMAILINGDETAILS.LIST", "NAME.LIST", "LANGUAGENAME.LIST", "BATCHALLOCATIONS.LIST", "VOUCHER", "LEDGER", "GROUP", "STOCKITEM"]);

function genericXmlSheets(obj) {
  let best = [];
  const flat = (o) => o && typeof o === "object" && !Array.isArray(o) && Object.values(o).filter((v) => v !== null && typeof v !== "object").length >= 2;
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 12) return;
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) {
        const recs = v.filter(flat);
        if (recs.length > best.length) best = recs;
        v.forEach((x) => walk(x, depth + 1));
      } else walk(v, depth + 1);
    }
  };
  walk(obj);
  const rows = best.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k.replace(/^@_/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"), v])));
  return rows.length ? [{ name: "Sheet1", rows }] : [];
}

/**
 * The XML parser slows down sharply with thousands of sibling records (a 30 MB Tally export took
 * minutes), so big exports are cut into batches of TALLYMESSAGE blocks, parsed one batch at a time,
 * and joined back into one tree with the same shape.
 */
function parseTallyXml(text, parser) {
  const BATCH = 400;
  const BATCH_CHARS = 400_000; // vouchers with many stock lines are big: batch by size too
  if (text.length < 1_500_000) return parser.parse(text);
  const open = /<TALLYMESSAGE\b/g;
  const first = text.search(/<TALLYMESSAGE\b/);
  if (first < 0) return parser.parse(text);
  const messages = [];
  let batch = [];
  let batchChars = 0;
  let pos = first;
  const flush = () => {
    if (!batch.length) return;
    batchChars = 0;
    const tree = parser.parse(`<R>${batch.join("")}</R>`);
    const list = tree?.R?.TALLYMESSAGE || [];
    for (const m of Array.isArray(list) ? list : [list]) messages.push(m);
    batch = [];
  };
  while (pos >= 0 && pos < text.length) {
    open.lastIndex = pos;
    const m = open.exec(text);
    if (!m) break;
    const start = m.index;
    const end = text.indexOf("</TALLYMESSAGE>", start);
    if (end < 0) break;
    batch.push(text.slice(start, end + 15));
    batchChars += end + 15 - start;
    if (batch.length >= BATCH || batchChars >= BATCH_CHARS) flush();
    pos = end + 15;
  }
  flush();
  return { ENVELOPE: { BODY: { IMPORTDATA: { REQUESTDATA: { TALLYMESSAGE: messages } } } } };
}

function parseFile(fileName, buf) {
  const name = String(fileName || "").toLowerCase();
  const head = decodeText(buf.slice(0, 2000)).trim();
  if (name.endsWith(".xml") || head.startsWith("<")) {
    // Tally writes control characters as &#4; etc., which aren't valid XML.
    const text = decodeText(buf).replace(/&#(?:[0-8]|1[1-2]|1[4-9]|2[0-9]|3[01]);/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: true, isArray: (tag) => LISTS.has(tag) });
    if (/<(ENVELOPE|TALLYMESSAGE|VOUCHER|LEDGER)\b/i.test(text.slice(0, 200000))) return { format: "xml", xml: parseTallyXml(text, parser) };
    // Excel's "XML Spreadsheet 2003" (Zoho/Tally "Excel XML" exports)
    if (/urn:schemas-microsoft-com:office:spreadsheet|<Workbook\b/i.test(text.slice(0, 5000))) {
      const wb = XLSX.read(text, { type: "string", cellDates: true });
      return { format: "sheet", sheets: wb.SheetNames.map((n) => ({ name: n, rows: rowsFromSheet(wb.Sheets[n]) })).filter((s) => s.rows.length) };
    }
    // Any other XML: the longest list of flat records becomes a sheet.
    return { format: "sheet", sheets: genericXmlSheets(parser.parse(text)) };
  }
  let wb;
  if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv")) wb = XLSX.read(decodeText(buf), { type: "string", cellDates: true, raw: false });
  else wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  return { format: "sheet", sheets: wb.SheetNames.map((n) => ({ name: n, rows: rowsFromSheet(wb.Sheets[n]) })).filter((s) => s.rows.length) };
}

module.exports = { parseFile, decodeText };
