/**
 * Tally "Stock Summary" exported to Excel → opening stock per item.
 *
 * The export puts stock groups and stock items in one column; Tally marks items in italics and
 * groups in bold (sub-groups plain), so the cell formatting tells them apart. Columns:
 * Particulars | Closing Balance: Quantity | Rate | Value.
 */
const XLSX = require("xlsx");

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function tallyDate(s) {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(String(s || ""));
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(y, MON[m[2].toLowerCase()], +m[1]));
}
const num = (v) => {
  if (typeof v === "number") return v;
  const m = String(v || "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const unitOf = (v) => (typeof v === "string" ? (v.replace(/[-\d.,\s]+/, "").trim().split(/\s+/)[0] || "").toLowerCase() : "");

function isStockSummary(buf) {
  try {
    const wb = XLSX.read(buf, { type: "buffer", sheetRows: 15 });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const text = rows.flat().join(" ").toLowerCase();
    return /stock summary/.test(text) && /closing balance|quantity/.test(text);
  } catch {
    return false;
  }
}

// Which cell styles are italic (items) / bold (groups), read straight from the workbook's XML.
function styleFlags(buf) {
  const z = XLSX.CFB.read(buf, { type: "buffer" });
  const file = (p) => {
    const f = XLSX.CFB.find(z, `/${p.replace(/^\//, "")}`);
    return f ? Buffer.from(f.content).toString("utf8") : "";
  };
  const styles = file("xl/styles.xml");
  const fontsXml = (styles.split("<fonts")[1] || "").split("</fonts>")[0];
  const fonts = [...fontsXml.matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)].map((m) => ({ italic: /<i\s*\/>|<i\b(?![^>]*val="0")/.test(m[1] || ""), bold: /<b\s*\/>|<b\b(?![^>]*val="0")/.test(m[1] || "") }));
  const xfsXml = (styles.split("<cellXfs")[1] || "").split("</cellXfs>")[0];
  const xfs = [...xfsXml.matchAll(/<xf\b([^>]*)/g)].map((m) => fonts[Number((/fontId="(\d+)"/.exec(m[1]) || [])[1] || 0)] || {});
  // first sheet's column-A cell styles by row number
  const wbXml = file("xl/workbook.xml");
  const rels = file("xl/_rels/workbook.xml.rels");
  const rid = (/<sheet\b[^>]*r:id="([^"]+)"/.exec(wbXml) || [])[1];
  const target = (new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels) || [])[1] || "worksheets/sheet1.xml";
  const sheet = file(`xl/${target.replace(/^\/?xl\//, "")}`);
  const byRow = {};
  for (const m of sheet.matchAll(/<c\b[^>]*\br="A(\d+)"[^>]*>/g)) {
    const s = (/\bs="(\d+)"/.exec(m[0]) || [])[1];
    byRow[+m[1]] = xfs[Number(s || 0)] || {};
  }
  return byRow;
}

function parseStockSummary(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: true });
  const firstRow = range.s.r + 1; // rows[i] is sheet row firstRow + i
  let flags = {};
  try {
    flags = styleFlags(buf);
  } catch {}
  const haveStyles = Object.values(flags).some((f) => f.italic);
  // Header: the row with Quantity / Rate / Value
  let h = rows.findIndex((r) => r.some((c) => /^quantity$/i.test(String(c).trim())) && r.some((c) => /^value$/i.test(String(c).trim())));
  if (h < 0) throw new Error("Couldn't find the Quantity / Rate / Value columns");
  const col = (re) => rows[h].findIndex((c) => re.test(String(c).trim()));
  const qi = col(/^quantity$/i);
  const ri = col(/^rate$/i);
  const vi = col(/^value$/i);
  const period = rows.slice(0, h + 1).flat().map(String).find((c) => /\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test(c)) || "";
  const dates = [...period.matchAll(/\d{1,2}-[A-Za-z]{3}-\d{2,4}/g)].map((m) => tallyDate(m[0]));
  const asOn = dates[dates.length - 1] || null;
  const items = [];
  const warnings = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = String(r[0] || "").trim().replace(/\s+/g, " ");
    if (!name || /^grand total$/i.test(name)) continue;
    const f = flags[firstRow + i] || {};
    const isItem = haveStyles ? f.italic && !f.bold : r[qi] !== "" && r[qi] !== null;
    if (!isItem) continue;
    const qty = num(r[qi]);
    const value = num(r[vi]);
    if (!qty) continue;
    if (qty < 0) {
      warnings.push(`${name}: closing quantity is negative in Tally (${qty}) — skipped`);
      continue;
    }
    items.push({ name, quantity: qty, unit: unitOf(r[qi]), rate: value && qty ? Math.round((value / qty) * 10000) / 10000 : num(r[ri]), value: Math.round(value * 100) / 100 });
  }
  if (!haveStyles) warnings.push("The file's formatting was missing, so every row with a quantity was taken as an item — check that no stock groups were included");
  return { items, asOn, warnings };
}

module.exports = { isStockSummary, parseStockSummary };

/* ---------- Tally Stock Summary exported as XML (Alt+E → XML) ----------
 * A flat list of <DSPACCNAME><DSPDISPNAME>name</…></…><DSPSTKINFO> opening / inwards / outwards / closing </…>
 * pairs. Groups and items are mixed with nothing to tell them apart (a group of one unit even has a quantity),
 * and a group can share its name with an item (shown once as the group, then as the item). So the names
 * decide: OrdexaGo's stock items (from Tally's masters) are items, their groups are skipped. The file has no
 * dates: the Opening column is used (the stock at the start of the period exported), or Closing when it has
 * no opening at all. */
const decodeXml = (buf) => {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.slice(2));
    b.swap16();
    return b.toString("utf16le");
  }
  // UTF-16 without a byte-order mark: every other byte is zero.
  if (buf.length > 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
};
const ent = (s) =>
  String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();

function isStockSummaryXml(buf) {
  const t = decodeXml(buf.slice(0, 20000));
  return /<DSPSTKINFO>/.test(t) && /<DSPACCNAME>/.test(t);
}

// known = { items: Set of item names (lower case), groups: Set of stock group names (lower case) }
function parseStockSummaryXml(buf, known = {}) {
  const text = decodeXml(buf);
  const tag = (t, b) => ent((new RegExp(`<${t}>([^<]*)</${t}>`).exec(b) || [])[1] || "");
  const rows = [];
  const re = /<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>[\s\S]*?<DSPSTKINFO>([\s\S]*?)<\/DSPSTKINFO>/g;
  for (const m of text.matchAll(re)) {
    const b = m[2];
    rows.push({
      name: ent(m[1]),
      opq: tag("DSPOPQTY", b),
      opv: Math.abs(num(tag("DSPOPAMTA", b))),
      clq: tag("DSPCLQTY", b),
      clv: Math.abs(num(tag("DSPCLAMTA", b))),
    });
  }
  if (!rows.length) throw new Error("No stock rows found");
  const useOpening = rows.some((r) => num(r.opq));
  const q = (r) => (useOpening ? r.opq : r.clq);
  const v = (r) => (useOpening ? r.opv : r.clv);
  const items = known.items || new Set();
  const groups = known.groups || new Set();
  const haveMasters = items.size > 0;
  const warnings = [];
  const pick = new Map(); // name → the item's row (an item listed after a group of the same name wins)
  const unknown = [];
  for (const r of rows) {
    const k = r.name.toLowerCase();
    if (!r.name || /^grand total$/i.test(r.name)) continue;
    if (haveMasters) {
      if (items.has(k)) {
        if (num(q(r)) || !pick.has(k)) pick.set(k, r);
      } else if (!groups.has(k) && num(q(r))) unknown.push(r);
    } else if (num(q(r))) pick.set(k, r);
  }
  const out = [];
  for (const r of pick.values()) {
    const qty = num(q(r));
    const value = v(r);
    if (!qty) continue;
    if (qty < 0) {
      warnings.push(`${r.name}: quantity is negative in Tally (${qty}) — skipped`);
      continue;
    }
    out.push({
      name: r.name,
      quantity: qty,
      unit: unitOf(q(r)),
      rate: value ? Math.round((value / qty) * 10000) / 10000 : 0,
      value: Math.round(value * 100) / 100,
    });
  }
  if (unknown.length)
    warnings.push(
      `${unknown.length} row(s) with a quantity aren't stock items in OrdexaGo, so they were taken as stock groups and left out (import Tally's stock item masters first if any is an item): ${unknown
        .slice(0, 10)
        .map((r) => `${r.name} (${q(r)})`)
        .join(", ")}${unknown.length > 10 ? "…" : ""}`,
    );
  if (!haveMasters)
    warnings.push(
      "No stock items in OrdexaGo yet, so every row with a quantity was taken as an item — stock groups may be counted twice. Import Tally's masters first.",
    );
  warnings.push(
    useOpening
      ? "The XML has no dates: its Opening column was used — set the opening date below to the first day of the period you exported from Tally (e.g. 1 Apr)."
      : "The XML has no dates and no opening stock: its Closing column was used — set the opening date below to the day after the period you exported.",
  );
  return { items: out, asOn: null, warnings, column: useOpening ? "opening" : "closing" };
}

module.exports.isStockSummaryXml = isStockSummaryXml;
module.exports.parseStockSummaryXml = parseStockSummaryXml;
