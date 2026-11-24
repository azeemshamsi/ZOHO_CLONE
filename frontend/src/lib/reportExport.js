/**
 * Download a report as Excel (.xlsx), PDF, Tally XML or CSV.
 * Excel / PDF / CSV come from the tables on screen (what you see is what you get); Tally XML is built from the
 * report's data in the layout Tally itself exports (Trial Balance, P&L, Balance Sheet, Stock Summary), so the
 * file reads like one exported from Tally (Alt+E → XML). Other reports use the same envelope, one entry per row.
 */

const save = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const safeName = (s) => String(s || "Report").replace(/[\\/:*?"<>|]+/g, "-").trim();

// "₹1,23,456.78", "-1,234", "(1,234.00)", "12.50%" → number; other text stays text.
export function toNumber(text) {
  const t = String(text || "").replace(/[₹,\s]/g, "");
  if (!t) return null;
  const m = t.match(/^(\()?(-)?(\d+(?:\.\d+)?)(\))?(%)?$/);
  if (!m) return null;
  let n = Number(m[3]);
  if (m[2] || (m[1] && m[4])) n = -n;
  return m[5] ? n / 100 : n;
}

const visible = (el) => !el.closest(".no-print");

// The tables on screen: [{ title, head: [[cells]], body: [[cells]], foot: [[cells]] }]
export function readTables(el) {
  const out = [];
  let title = "";
  el.querySelectorAll("h3, table").forEach((node) => {
    if (!visible(node)) return;
    if (node.tagName === "H3") {
      title = node.textContent.trim();
      return;
    }
    if (node.parentElement?.closest("table")) return; // nested
    const part = (sel) =>
      [...node.querySelectorAll(sel)]
        .filter((tr) => tr.closest("table") === node && visible(tr))
        .map((tr) => [...tr.children].filter(visible).map((c) => c.textContent.replace(/\s+/g, " ").trim()))
        .filter((r) => r.some((c) => c));
    const head = part("thead tr");
    const body = part("tbody tr");
    const foot = part("tfoot tr");
    if (!head.length && !body.length) return;
    // Tables without thead: nothing special, all rows are body rows.
    out.push({ title, head, body: body.length || foot.length ? body : part("tr"), foot });
    title = "";
  });
  return out;
}

const cellOut = (c) => {
  const n = toNumber(c);
  if (n === null) return c;
  return /%$/.test(c) ? { v: n, t: "n", z: "0.00%" } : { v: n, t: "n", z: "#,##0.00;-#,##0.00" };
};

const headLines = (org, orgLines) => (orgLines && orgLines.length ? orgLines : [org || ""]);

export async function downloadExcel(el, { title, subtitle, org, orgLines }) {
  const XLSX = await import("xlsx");
  const aoa = [...headLines(org, orgLines).map((l) => [l]), [title], [subtitle || ""], []];
  const bold = new Set();
  for (const t of readTables(el)) {
    if (t.title) aoa.push([t.title]);
    for (const r of t.head) (bold.add(aoa.length), aoa.push(r));
    for (const r of t.body) aoa.push(r.map(cellOut));
    for (const r of t.foot) (bold.add(aoa.length), aoa.push(r.map(cellOut)));
    aoa.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const widths = [];
  for (const r of aoa)
    r.forEach((c, i) => {
      const len = String(c && typeof c === "object" ? c.v : c ?? "").length;
      widths[i] = Math.min(60, Math.max(widths[i] || 8, len + 2));
    });
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeName(title).slice(0, 31));
  XLSX.writeFile(wb, `${safeName(`${title} ${subtitle || ""}`)}.xlsx`);
}

export async function downloadPdf(el, { title, subtitle, org, orgLines }) {
  const { jsPDF } = await import("jspdf");
  const at = await import("jspdf-autotable");
  const autoTable = [at.autoTable, at.default, at.default?.default].find((f) => typeof f === "function");
  const tables = readTables(el);
  const widest = Math.max(1, ...tables.flatMap((t) => [...t.head, ...t.body].map((r) => r.length)));
  const doc = new jsPDF({ orientation: widest > 5 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  // jsPDF's built-in fonts have no ₹: amounts are shown without it (as Tally prints them).
  const clean = (r) => r.map((c) => String(c).replace(/₹\s?/g, ""));
  const [first, ...rest] = headLines(org, orgLines);
  let y = 34;
  doc.setFont(undefined, "bold");
  doc.setFontSize(12);
  doc.text(first || "", W / 2, y, { align: "center" });
  doc.setFont(undefined, "normal");
  doc.setFontSize(8.5);
  for (const l of rest) doc.text(clean([l])[0], W / 2, (y += 12), { align: "center" });
  doc.setFontSize(14);
  doc.text(clean([title])[0], W / 2, (y += 20), { align: "center" });
  doc.setFontSize(9);
  doc.text(subtitle || "", W / 2, (y += 14), { align: "center" });
  y += 14;
  for (const t of tables) {
    if (t.title) {
      doc.setFontSize(11);
      doc.text(clean([t.title])[0], 40, y + 10);
      y += 16;
    }
    const numCols = new Set();
    for (const r of t.body) r.forEach((c, i) => toNumber(c) !== null && numCols.add(i));
    autoTable(doc, {
      startY: y,
      head: t.head.map(clean),
      body: t.body.map(clean),
      foot: t.foot.map(clean),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [240, 242, 245], textColor: 20, fontStyle: "bold" },
      footStyles: { fillColor: [240, 242, 245], textColor: 20, fontStyle: "bold" },
      showFoot: "lastPage",
      didParseCell: (d) => {
        if (numCols.has(d.column.index) && toNumber(d.cell.raw) !== null) d.cell.styles.halign = "right";
      },
      margin: { left: 40, right: 40 },
    });
    y = doc.lastAutoTable.finalY + 18;
  }
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.text(`Page ${i} of ${pages}`, W - 40, doc.internal.pageSize.getHeight() - 16, { align: "right" });
  }
  doc.save(`${safeName(`${title} ${subtitle || ""}`)}.pdf`);
}

export function downloadCsv(el, { title, subtitle, org, orgLines }) {
  const rows = [...headLines(org, orgLines).map((l) => [l]), [title], [subtitle || ""], []];
  for (const t of readTables(el)) {
    if (t.title) rows.push([t.title]);
    for (const r of [...t.head, ...t.body, ...t.foot]) rows.push(r.map((c) => c.replace(/₹/g, "").replace(/,/g, "")));
    rows.push([]);
  }
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  save(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${safeName(`${title} ${subtitle || ""}`)}.csv`);
}

/* ---------------- Tally XML ---------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (n) => (n || n === 0 ? (Math.round(Number(n) * 100) / 100 === 0 ? "" : (Math.round(Number(n) * 100) / 100).toFixed(2)) : "");
const qtyOf = (n) => (n || n === 0 ? (Number(n) === 0 ? "" : String(Math.round(Number(n) * 1000) / 1000)) : "");
const name = (n, pad = " ") => `${pad}<DSPACCNAME>\r\n${pad} <DSPDISPNAME>${esc(n)}</DSPDISPNAME>\r\n</DSPACCNAME>\r\n`;
const box = (outer, inner, v, pad = "  ") => `${pad}<${outer}>\r\n${pad} <${inner}>${v}</${inner}>\r\n</${outer}>\r\n`;

// Trial Balance (closing balances): Dr negative, Cr positive, as Tally exports.
function tallyTrialBalance(d) {
  let x = "";
  for (const r of d.rows || []) {
    x += name(r.name);
    x += " <DSPACCINFO>\r\n";
    x += box("DSPCLDRAMT", "DSPCLDRAMTA", amt(r.debit ? -r.debit : 0));
    x += box("DSPCLCRAMT", "DSPCLCRAMTA", amt(r.credit));
    x += "</DSPACCINFO>\r\n";
  }
  return x;
}

// P&L A/c / Balance Sheet: each group with its amount, its ledgers below (Tally's BSNAME / BSAMT).
// Signs as Tally: P&L debit side negative, credit side positive; Balance Sheet liabilities positive, assets negative.
function tallyStatement(d) {
  const isBS = (d.headings || [])[0] === "Liabilities";
  let x = "";
  const ledger = (l, sign) =>
    ` <BSNAME>\r\n${name(l.name, "  ")}</BSNAME>\r\n <BSAMT>\r\n  <BSSUBAMT>${amt(sign * l.amount)}</BSSUBAMT>\r\n  <BSMAINAMT></BSMAINAMT>\r\n</BSAMT>\r\n`;
  const groupXml = (g, sign) => {
    x += name(g.name);
    x += ` <${isBS ? "BSAMT" : "PLAMT"}>\r\n  <${isBS ? "BSSUBAMT" : "PLSUBAMT"}></${isBS ? "BSSUBAMT" : "PLSUBAMT"}>\r\n  <BSMAINAMT>${amt(sign * g.amount)}</BSMAINAMT>\r\n</${isBS ? "BSAMT" : "PLAMT"}>\r\n`;
    for (const sg of g.subgroups || []) x += ledger(sg, sign);
    for (const l of g.ledgers || []) x += ledger(l, sign);
  };
  for (const b of d.blocks || []) {
    for (const g of b.left || []) groupXml(g, isBS ? 1 : -1);
    for (const g of b.right || []) groupXml(g, isBS ? -1 : 1);
  }
  return x;
}

// Stock Summary: opening / inward / outward / closing; values debit (negative) except outward, as Tally.
function tallyStockSummary(d) {
  let x = "";
  for (const r of d.rows || []) {
    const rate = (q, v) => (q ? amt(Math.abs(v / q)) : "");
    x += name(r.name);
    x += " <DSPSTKINFO>\r\n";
    x += `  <DSPSTKOP>\r\n   <DSPOPQTY>${qtyOf(r.oQty)}</DSPOPQTY>\r\n   <DSPOPRATE>${rate(r.oQty, r.oVal)}</DSPOPRATE>\r\n   <DSPOPAMTA>${amt(-(r.oVal || 0))}</DSPOPAMTA>\r\n</DSPSTKOP>\r\n`;
    x += `  <DSPSTKIN>\r\n   <DSPINQTY>${qtyOf(r.iQty)}</DSPINQTY>\r\n   <DSPINRATE>${rate(r.iQty, r.iVal)}</DSPINRATE>\r\n   <DSPDRAMTA>${amt(-(r.iVal || 0))}</DSPDRAMTA>\r\n</DSPSTKIN>\r\n`;
    x += `  <DSPSTKOUT>\r\n   <DSPOUTQTY>${qtyOf(r.xQty)}</DSPOUTQTY>\r\n   <DSPOUTRATE>${rate(r.xQty, r.xVal)}</DSPOUTRATE>\r\n   <DSPNETTCRAMTA>${amt(r.xVal)}</DSPNETTCRAMTA>\r\n</DSPSTKOUT>\r\n`;
    x += `  <DSPSTKCL>\r\n   <DSPCLQTY>${qtyOf(r.cQty)}</DSPCLQTY>\r\n   <DSPCLRATE>${amt(r.cRate)}</DSPCLRATE>\r\n   <DSPCLAMTA>${amt(-(r.cVal || 0))}</DSPCLAMTA>\r\n</DSPSTKCL>\r\n`;
    x += "</DSPSTKINFO>\r\n";
  }
  return x;
}

const tagOf = (label) => `DSP${String(label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "")}` || "DSPVALUE";

// Any other report: one DSPACCNAME per row (its first column), the other columns in DSPACCINFO.
function tallyTable(el) {
  let x = "";
  for (const t of readTables(el)) {
    const cols = t.head[t.head.length - 1] || [];
    for (const r of t.body) {
      x += name(r[0]);
      x += " <DSPACCINFO>\r\n";
      r.slice(1).forEach((c, i) => {
        const tag = tagOf(cols[i + 1] || `COL${i + 2}`);
        const n = toNumber(c);
        x += `  <${tag}>${esc(n === null ? c : String(n))}</${tag}>\r\n`;
      });
      x += "</DSPACCINFO>\r\n";
    }
  }
  return x;
}

export function tallyXml(key, data, el) {
  let body;
  if (key === "trial-balance" && Array.isArray(data?.rows)) body = tallyTrialBalance(data);
  else if (data?.kind === "tally") body = tallyStatement(data);
  else if (key === "stock-summary" && Array.isArray(data?.rows)) body = tallyStockSummary(data);
  else body = tallyTable(el);
  return `<ENVELOPE>\r\n${body}</ENVELOPE>\r\n`;
}

export function downloadTallyXml(key, data, el, { title, subtitle }) {
  save(new Blob([tallyXml(key, data, el)], { type: "application/xml" }), `${safeName(`${title} ${subtitle || ""}`)}.xml`);
}
