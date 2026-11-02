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
