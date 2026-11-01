/**
 * GST returns built from the books, in the JSON format the GST portal's offline tools accept,
 * plus GSTR-2B reconciliation and the compliance calendar.
 *
 * Amounts are in rupees: documents in another currency are converted at their exchange rate.
 */
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Bill = require("../models/Bill");
const Expense = require("../models/Expense");
const VendorCredit = require("../models/VendorCredit");
const Vendor = require("../models/Vendor");
const { HttpError } = require("./http");

const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const dmy = (d) => {
  const x = new Date(d);
  return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`;
};
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const OVERSEAS = "96";
const live = { status: { $nin: ["draft", "void"] }, opening: { $ne: true } };

/* ----------------------------- Periods ----------------------------- */
// "2026-07" → that month; with quarterly filing → the quarter (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) holding it.
function periodRange(period, freq = "monthly") {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!m) throw new HttpError(400, "Choose a return period");
  let y = +m[1];
  let mo = +m[2] - 1;
  let first = mo;
  let months = 1;
  if (freq === "quarterly") {
    const fyMonth = (mo + 9) % 12; // Apr = 0
    first = mo - (fyMonth % 3);
    months = 3;
  }
  const from = new Date(Date.UTC(y, first, 1));
  const to = new Date(Date.UTC(y, first + months, 0, 23, 59, 59, 999));
  const last = new Date(Date.UTC(y, first + months - 1, 1));
  return { from, to, fp: `${pad(last.getUTCMonth() + 1)}${last.getUTCFullYear()}`, label: label(from, to) };
}
function fyRange(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || ""));
  if (!m) throw new HttpError(400, "Choose a financial year, e.g. 2025-26");
  const y = +m[1];
  return { from: new Date(Date.UTC(y, 3, 1)), to: new Date(Date.UTC(y + 1, 2, 31, 23, 59, 59, 999)), fy: `${y}-${String(y + 1).slice(2)}` };
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function label(from, to) {
  const a = `${MON[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
  const b = `${MON[to.getUTCMonth()]} ${to.getUTCFullYear()}`;
  return a === b ? a : `${MON[from.getUTCMonth()]}–${b}`;
}

/* ----------------------------- Helpers ----------------------------- */
const fx = (d) => (d.currency && d.currency !== "INR" ? Number(d.exchangeRate) || 1 : 1);
// The lines of a document grouped by GST rate, in rupees.
function byRate(doc) {
  const k = fx(doc);
  const map = {};
  for (const l of doc.lineItems || []) {
    const rt = Number(l.taxRate) || 0;
    const r = (map[rt] = map[rt] || { rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    r.txval += (l.amount || 0) * k;
    r.iamt += (l.igst || 0) * k;
    r.camt += (l.cgst || 0) * k;
    r.samt += (l.sgst || 0) * k;
  }
  return Object.values(map).map((r) => ({ rt: r.rt, txval: r2(r.txval), iamt: r2(r.iamt), camt: r2(r.camt), samt: r2(r.samt), csamt: 0 }));
}
const add = (a, b) => {
  for (const k of ["txval", "iamt", "camt", "samt", "csamt"]) a[k] = r2((a[k] || 0) + (b[k] || 0));
  return a;
};
const zero = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
const total = (rows) => rows.reduce((s, r) => add(s, r), zero());
const isExport = (d) => d.placeOfSupply === OVERSEAS || (d.currency && d.currency !== "INR" && !d.customerGstin);
// Interstate when the place of supply differs from the business's state (or the doc says so).
const inter = (d, org) => d.isInterState || (d.placeOfSupply && d.placeOfSupply !== org.state);

/* ----------------------------- GSTR-1 ----------------------------- */
async function gstr1(org, period, freq) {
  const { from, to, fp, label: lbl } = periodRange(period, freq);
  const [invoices, credits] = await Promise.all([
    Invoice.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).sort({ date: 1, invoiceNumber: 1 }).lean(),
    CreditNote.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).sort({ date: 1, number: 1 }).lean(),
  ]);
  // Voided invoices still count as issued-then-cancelled in the documents table.
  const voided = await Invoice.find({ organization: org._id, status: "void", opening: { $ne: true }, date: { $gte: from, $lte: to } }, { invoiceNumber: 1 }).lean();
  const issues = [];
  const b2bMap = {};
  const b2clMap = {};
  const b2csMap = {};
  const exp = { WPAY: [], WOPAY: [] };
  const nil = { INTRB2B: zero(), INTRAB2B: zero(), INTRB2C: zero(), INTRAB2C: zero() };
  const hsnMap = {};
  const view = { b2b: [], b2cl: [], b2cs: [], exp: [], cdnr: [], cdnur: [], nil: [], hsn: [] };

  for (const i of invoices) {
    const k = fx(i);
    const rates = byRate(i);
    const val = r2(i.total * k);
    const pos = i.placeOfSupply || org.state;
    const itr = inter(i, org);
    if (!i.placeOfSupply) issues.push({ doc: i.invoiceNumber, id: i._id, kind: "invoice", problem: "No place of supply — your own state was used" });
    for (const l of i.lineItems || []) {
      if (!l.hsnSac) issues.push({ doc: i.invoiceNumber, id: i._id, kind: "invoice", problem: `"${l.name}" has no HSN/SAC code` });
      const hk = `${l.hsnSac || ""}|${l.taxRate || 0}`;
      const h = (hsnMap[hk] = hsnMap[hk] || { hsn_sc: l.hsnSac || "", desc: (l.name || "").slice(0, 30), uqc: uqcOf(l.unit), qty: 0, rt: Number(l.taxRate) || 0, ...zero(), b2b: !!i.customerGstin });
      h.qty = r2(h.qty + (l.quantity || 0));
      add(h, { txval: (l.amount || 0) * k, iamt: (l.igst || 0) * k, camt: (l.cgst || 0) * k, samt: (l.sgst || 0) * k });
    }
    const taxed = rates.filter((r) => r.rt > 0);
    const untaxed = rates.filter((r) => !r.rt);
    if (!isExport(i))
      for (const u of untaxed) {
        const key = `${itr ? "INTR" : "INTRA"}${i.customerGstin ? "B2B" : "B2C"}`;
        nil[key].txval = r2(nil[key].txval + u.txval);
      }
    if (isExport(i)) {
      const kind = i.igst > 0 ? "WPAY" : "WOPAY";
      exp[kind].push({ inum: i.invoiceNumber, idt: dmy(i.date), val, sbpcode: "", sbnum: "", sbdt: "", itms: rates.map((r) => ({ txval: r.txval, rt: r.rt, iamt: r.iamt, csamt: 0 })) });
      view.exp.push({ id: i._id, number: i.invoiceNumber, date: i.date, name: i.customerName, type: kind, value: val, ...total(rates) });
      continue;
    }
    if (!taxed.length && !i.customerGstin) continue; // only nil-rated: reported in the nil table
    const itms = (i.customerGstin ? rates : taxed).map((r, n) => ({ num: n + 1, itm_det: { txval: r.txval, rt: r.rt, iamt: r.iamt, camt: r.camt, samt: r.samt, csamt: 0 } }));
    if (i.customerGstin) {
      if (!GSTIN_RE.test(i.customerGstin)) issues.push({ doc: i.invoiceNumber, id: i._id, kind: "invoice", problem: `Customer GSTIN ${i.customerGstin} doesn't look valid` });
      const b = (b2bMap[i.customerGstin] = b2bMap[i.customerGstin] || { ctin: i.customerGstin, inv: [] });
      b.inv.push({ inum: i.invoiceNumber, idt: dmy(i.date), val, pos, rchrg: "N", inv_typ: "R", itms });
      view.b2b.push({ id: i._id, number: i.invoiceNumber, date: i.date, name: i.customerName, gstin: i.customerGstin, pos, value: val, ...total(rates) });
    } else if (itr && val > 100000) {
      const b = (b2clMap[pos] = b2clMap[pos] || { pos, inv: [] });
      b.inv.push({ inum: i.invoiceNumber, idt: dmy(i.date), val, itms: taxed.map((r, n) => ({ num: n + 1, itm_det: { txval: r.txval, rt: r.rt, iamt: r.iamt, csamt: 0 } })) });
      view.b2cl.push({ id: i._id, number: i.invoiceNumber, date: i.date, name: i.customerName, pos, value: val, ...total(taxed) });
    } else {
      for (const r of taxed) {
        const key = `${itr ? "INTER" : "INTRA"}|${pos}|${r.rt}`;
        const s = (b2csMap[key] = b2csMap[key] || { sply_ty: itr ? "INTER" : "INTRA", pos, typ: "OE", rt: r.rt, ...zero() });
        add(s, r);
      }
    }
  }

  const cdnrMap = {};
  const cdnur = [];
  for (const c of credits) {
    const k = fx(c);
    const rates = byRate(c);
    const val = r2(c.total * k);
    const pos = c.placeOfSupply || org.state;
    const itr = inter(c, org);
    for (const l of c.lineItems || []) {
      const hk = `${l.hsnSac || ""}|${l.taxRate || 0}`;
      const h = (hsnMap[hk] = hsnMap[hk] || { hsn_sc: l.hsnSac || "", desc: (l.name || "").slice(0, 30), uqc: uqcOf(l.unit), qty: 0, rt: Number(l.taxRate) || 0, ...zero(), b2b: !!c.customerGstin });
      h.qty = r2(h.qty - (l.quantity || 0));
      add(h, { txval: -(l.amount || 0) * k, iamt: -(l.igst || 0) * k, camt: -(l.cgst || 0) * k, samt: -(l.sgst || 0) * k });
    }
    const itms = rates.map((r, n) => ({ num: n + 1, itm_det: { txval: r.txval, rt: r.rt, iamt: r.iamt, camt: r.camt, samt: r.samt, csamt: 0 } }));
    const note = { ntty: "C", nt_num: c.number, nt_dt: dmy(c.date), pos, rchrg: "N", inv_typ: "R", val, itms };
    if (c.customerGstin) {
      const b = (cdnrMap[c.customerGstin] = cdnrMap[c.customerGstin] || { ctin: c.customerGstin, nt: [] });
      b.nt.push(note);
      view.cdnr.push({ id: c._id, number: c.number, date: c.date, name: c.customerName, gstin: c.customerGstin, invoice: c.invoiceNumber, value: val, ...total(rates) });
    } else if (isExport(c) || (itr && val > 100000)) {
      // Unregistered credit notes are only reported for B2CL and exports; B2CS credit notes reduce the B2CS table.
      cdnur.push({ typ: isExport(c) ? (c.igst > 0 ? "EXPWP" : "EXPWOP") : "B2CL", ntty: "C", nt_num: c.number, nt_dt: dmy(c.date), pos: isExport(c) ? undefined : pos, val, itms: itms.map((x) => ({ num: x.num, itm_det: { txval: x.itm_det.txval, rt: x.itm_det.rt, iamt: x.itm_det.iamt, csamt: 0 } })) });
      view.cdnur.push({ id: c._id, number: c.number, date: c.date, name: c.customerName, invoice: c.invoiceNumber, value: val, ...total(rates) });
    } else {
      for (const r of rates.filter((x) => x.rt > 0)) {
        const key = `${itr ? "INTER" : "INTRA"}|${pos}|${r.rt}`;
        const s = (b2csMap[key] = b2csMap[key] || { sply_ty: itr ? "INTER" : "INTRA", pos, typ: "OE", rt: r.rt, ...zero() });
        add(s, { txval: -r.txval, iamt: -r.iamt, camt: -r.camt, samt: -r.samt });
      }
    }
  }

  const b2cs = Object.values(b2csMap)
    .filter((s) => s.txval)
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt)
    .map((s) => (s.sply_ty === "INTER" ? { sply_ty: s.sply_ty, pos: s.pos, typ: s.typ, rt: s.rt, txval: s.txval, iamt: s.iamt, csamt: 0 } : { sply_ty: s.sply_ty, pos: s.pos, typ: s.typ, rt: s.rt, txval: s.txval, camt: s.camt, samt: s.samt, csamt: 0 }));
  view.b2cs = b2cs.map((s) => ({ type: s.sply_ty === "INTER" ? "Inter-state" : "Intra-state", pos: s.pos, rate: s.rt, txval: s.txval, iamt: s.iamt || 0, camt: s.camt || 0, samt: s.samt || 0 }));
  const nilRows = Object.entries(nil)
    .filter(([, v]) => v.txval)
    .map(([sply_ty, v]) => ({ sply_ty, nil_amt: v.txval, expt_amt: 0, ngsup_amt: 0 }));
  view.nil = nilRows;
  const hsnAll = Object.values(hsnMap).filter((h) => h.txval || h.qty);
  // From 2025 the HSN table is split into B2B and B2C parts.
  const hsnRows = (rows) => rows.sort((a, b) => a.hsn_sc.localeCompare(b.hsn_sc) || a.rt - b.rt).map((h, n) => ({ num: n + 1, hsn_sc: h.hsn_sc, desc: h.desc, uqc: h.uqc, qty: h.qty, rt: h.rt, txval: h.txval, iamt: h.iamt, camt: h.camt, samt: h.samt, csamt: 0 }));
  const hsn_b2b = hsnRows(hsnAll.filter((h) => h.b2b));
  const hsn_b2c = hsnRows(hsnAll.filter((h) => !h.b2b));
  view.hsn = hsnRows(hsnAll.map((h) => ({ ...h })));

  // Table 13: documents issued (series = invoice numbers in the period).
  const nums = invoices.map((i) => i.invoiceNumber).concat(voided.map((v) => v.invoiceNumber)).sort();
  const cnNums = credits.map((c) => c.number).sort();
  const docs = [];
  if (nums.length) docs.push({ doc_num: 1, docs: [{ num: 1, from: nums[0], to: nums[nums.length - 1], totnum: nums.length, cancel: voided.length, net_issue: nums.length - voided.length }] });
  if (cnNums.length) docs.push({ doc_num: 5, docs: [{ num: 1, from: cnNums[0], to: cnNums[cnNums.length - 1], totnum: cnNums.length, cancel: 0, net_issue: cnNums.length }] });

  const json = {
    gstin: org.gstin,
    fp,
    version: "GST3.2.1",
    hash: "hash",
    ...(Object.keys(b2bMap).length && { b2b: Object.values(b2bMap) }),
    ...(Object.keys(b2clMap).length && { b2cl: Object.values(b2clMap) }),
    ...(b2cs.length && { b2cs }),
    ...((exp.WPAY.length || exp.WOPAY.length) && { exp: Object.entries(exp).filter(([, v]) => v.length).map(([exp_typ, inv]) => ({ exp_typ, inv })) }),
    ...(Object.keys(cdnrMap).length && { cdnr: Object.values(cdnrMap) }),
    ...(cdnur.length && { cdnur }),
    ...(nilRows.length && { nil: { inv: nilRows } }),
    ...(hsnAll.length && { hsn: { ...(hsn_b2b.length && { hsn_b2b }), ...(hsn_b2c.length && { hsn_b2c }) } }),
    ...(docs.length && { doc_issue: { doc_det: docs } }),
  };
  if (!org.gstin) issues.unshift({ problem: "Add your GSTIN in Settings → Organization before downloading the return" });
  const sum = (rows) => rows.reduce((s, r) => add(s, { txval: r.txval, iamt: r.iamt, camt: r.camt, samt: r.samt }), zero());
  const summary = {
    b2b: { count: view.b2b.length, ...sum(view.b2b) },
    b2cl: { count: view.b2cl.length, ...sum(view.b2cl) },
    b2cs: { count: view.b2cs.length, ...sum(view.b2cs) },
    exp: { count: view.exp.length, ...sum(view.exp) },
    cdnr: { count: view.cdnr.length, ...sum(view.cdnr) },
    cdnur: { count: view.cdnur.length, ...sum(view.cdnur) },
    nil: { count: nilRows.length, txval: r2(nilRows.reduce((s, r) => s + r.nil_amt, 0)), iamt: 0, camt: 0, samt: 0 },
    hsn: { count: view.hsn.length, ...sum(view.hsn) },
  };
  const liability = add(add(add(add(zero(), summary.b2b), summary.b2cl), summary.b2cs), summary.exp);
  for (const k of ["txval", "iamt", "camt", "samt"]) liability[k] = r2(liability[k] - summary.cdnr[k] - summary.cdnur[k]);
  return { period: lbl, fp, from, to, json, view, summary, liability, issues: dedupe(issues), documents: { invoices: invoices.length, creditNotes: credits.length, cancelled: voided.length } };
}
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = `${x.doc}|${x.problem}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const uqcOf = (u) => require("./einvoice").uqc(u);

/* ----------------------------- GSTR-3B ----------------------------- */
async function purchasesOf(org, from, to) {
  const [bills, expenses, vcs] = await Promise.all([
    Bill.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).lean(),
    Expense.find({ organization: org._id, date: { $gte: from, $lte: to } }).lean(),
    VendorCredit.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).lean(),
  ]);
  return { bills, expenses, vcs };
}
const taxOf = (d, sign = 1) => ({ iamt: r2(sign * (d.igst || 0) * fx(d)), camt: r2(sign * (d.cgst || 0) * fx(d)), samt: r2(sign * (d.sgst || 0) * fx(d)), csamt: 0 });

async function gstr3b(org, period, freq, { itcFrom2b } = {}) {
  const r1 = await gstr1(org, period, freq);
  const { from, to, fp } = periodRange(period, freq);
  const { bills, expenses, vcs } = await purchasesOf(org, from, to);
  const s = r1.summary;
  // 3.1(a) taxable outward (not zero-rated, nil or exempt), net of credit notes
  const osup = zero();
  for (const k of ["b2b", "b2cl", "b2cs"]) add(osup, s[k]);
  for (const k of ["txval", "iamt", "camt", "samt"]) osup[k] = r2(osup[k] - s.cdnr[k] - s.cdnur[k]);
  // nil-rated lines inside B2B invoices are in b2b totals with zero tax: move their value to 3.1(c)
  const nilTotal = r2(r1.json.nil?.inv?.reduce((t, r) => t + r.nil_amt, 0) || 0);
  const nilInB2b = r2((r1.json.nil?.inv || []).filter((r) => /B2B$/.test(r.sply_ty)).reduce((t, r) => t + r.nil_amt, 0));
  osup.txval = r2(osup.txval - nilInB2b);
  const zeroRated = { txval: s.exp.txval, iamt: s.exp.iamt, camt: 0, samt: 0, csamt: 0 };
  // 3.2 inter-state supplies to unregistered persons, by place of supply
  const unreg = {};
  for (const r of r1.view.b2cl) (unreg[r.pos] = unreg[r.pos] || { pos: r.pos, txval: 0, iamt: 0 }), (unreg[r.pos].txval = r2(unreg[r.pos].txval + r.txval)), (unreg[r.pos].iamt = r2(unreg[r.pos].iamt + r.iamt));
  for (const r of r1.view.b2cs.filter((x) => x.type === "Inter-state")) (unreg[r.pos] = unreg[r.pos] || { pos: r.pos, txval: 0, iamt: 0 }), (unreg[r.pos].txval = r2(unreg[r.pos].txval + r.txval)), (unreg[r.pos].iamt = r2(unreg[r.pos].iamt + r.iamt));

  // 4. ITC from the books (bills + expenses − vendor credits), or from GSTR-2B when reconciled
  const books = zero();
  for (const b of bills) add(books, taxOf(b));
  for (const e of expenses) add(books, taxOf(e));
  const reversed = zero();
  for (const v of vcs) add(reversed, taxOf(v));
  let itcAvl = { iamt: r2(books.iamt - reversed.iamt), camt: r2(books.camt - reversed.camt), samt: r2(books.samt - reversed.samt), csamt: 0 };
  let itcSource = "books";
  if (itcFrom2b) {
    itcAvl = { iamt: itcFrom2b.iamt, camt: itcFrom2b.camt, samt: itcFrom2b.samt, csamt: 0 };
    itcSource = "2b";
  }
  // 5. exempt / nil inward supplies
  const inwardNil = { inter: 0, intra: 0 };
  for (const d of [...bills, ...expenses]) {
    const lines = d.lineItems || [{ amount: d.amount, taxRate: d.taxRate }];
    for (const l of lines) if (!l.taxRate) inwardNil[d.isInterState ? "inter" : "intra"] = r2(inwardNil[d.isInterState ? "inter" : "intra"] + (l.amount || 0) * fx(d));
  }

  const liab = { iamt: r2(osup.iamt + zeroRated.iamt), camt: osup.camt, samt: osup.samt };
  const setoff = setOff(liab, itcAvl);
  const json = {
    gstin: org.gstin,
    ret_period: fp,
    sup_details: {
      osup_det: { txval: osup.txval, iamt: osup.iamt, camt: osup.camt, samt: osup.samt, csamt: 0 },
      osup_zero: { txval: zeroRated.txval, iamt: zeroRated.iamt, csamt: 0 },
      osup_nil_exmp: { txval: nilTotal },
      isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
      osup_nongst: { txval: 0 },
    },
    inter_sup: { unreg_details: Object.values(unreg).filter((u) => u.txval > 0), comp_details: [], uin_details: [] },
    itc_elg: {
      itc_avl: [
        { ty: "IMPG", iamt: 0, csamt: 0 },
        { ty: "IMPS", iamt: 0, csamt: 0 },
        { ty: "ISRC", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "ISD", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", ...itcAvl },
      ],
      itc_rev: [
        { ty: "RUL", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", iamt: 0, camt: 0, samt: 0, csamt: 0 },
      ],
      itc_net: { ...itcAvl },
      itc_inelg: [
        { ty: "RUL", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", iamt: 0, camt: 0, samt: 0, csamt: 0 },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: inwardNil.inter, intra: inwardNil.intra },
        { ty: "NONGST", inter: 0, intra: 0 },
      ],
    },
  };
  return {
    period: r1.period,
    fp,
    json,
    outward: osup,
    zeroRated,
    nil: nilTotal,
    unreg: Object.values(unreg),
    itcBooks: { iamt: books.iamt, camt: books.camt, samt: books.samt },
    itcReversed: { iamt: reversed.iamt, camt: reversed.camt, samt: reversed.samt },
    itc: itcAvl,
    itcSource,
    inwardNil,
    liability: liab,
    setoff,
    issues: r1.issues,
  };
}

// Use input tax credit as Section 49 / Rule 88A require: IGST credit first (IGST, then CGST/SGST),
// then CGST credit (CGST, then IGST) and SGST credit (SGST, then IGST). CGST and SGST never cross.
function setOff(liab, itc) {
  const L = { i: liab.iamt, c: liab.camt, s: liab.samt };
  const C = { i: Math.max(0, itc.iamt), c: Math.max(0, itc.camt), s: Math.max(0, itc.samt) };
  const used = { ii: 0, ic: 0, is: 0, cc: 0, ci: 0, ss: 0, si: 0 };
  const take = (from, to, key) => {
    const x = r2(Math.min(C[from], L[to]));
    C[from] = r2(C[from] - x);
    L[to] = r2(L[to] - x);
    used[key] = r2(used[key] + x);
  };
  take("i", "i", "ii");
  // Spread leftover IGST credit to where CGST/SGST credit falls short first, so no cash is paid needlessly.
  const shortC = Math.max(0, r2(L.c - C.c));
  const shortS = Math.max(0, r2(L.s - C.s));
  const toC = r2(Math.min(C.i, shortC));
  C.i = r2(C.i - toC), (L.c = r2(L.c - toC)), (used.ic = toC);
  const toS = r2(Math.min(C.i, shortS));
  C.i = r2(C.i - toS), (L.s = r2(L.s - toS)), (used.is = toS);
  take("i", "c", "ic");
  take("i", "s", "is");
  take("c", "c", "cc");
  take("s", "s", "ss");
  take("c", "i", "ci");
  take("s", "i", "si");
  return {
    used,
    cash: { iamt: L.i, camt: L.c, samt: L.s, total: r2(L.i + L.c + L.s) },
    carryForward: { iamt: C.i, camt: C.c, samt: C.s },
  };
}

/* ----------------------------- GSTR-9 (annual) ----------------------------- */
async function gstr9(org, fy) {
  const { from, to, fy: label } = fyRange(fy);
  const [invoices, credits, { bills, expenses, vcs }] = await Promise.all([
    Invoice.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).lean(),
    CreditNote.find({ organization: org._id, ...live, date: { $gte: from, $lte: to } }).lean(),
    purchasesOf(org, from, to),
  ]);
  const t4 = { B2C: zero(), B2B: zero(), EXP: zero(), CN: zero() };
  const t5 = { nil: 0 };
  const hsnOut = {};
  const hsnIn = {};
  const putHsn = (map, l, k, sign) => {
    const key = `${l.hsnSac || ""}|${l.taxRate || 0}`;
    const h = (map[key] = map[key] || { hsn: l.hsnSac || "", uqc: uqcOf(l.unit), qty: 0, rate: Number(l.taxRate) || 0, ...zero() });
    h.qty = r2(h.qty + sign * (l.quantity || 0));
    add(h, { txval: sign * (l.amount || 0) * k, iamt: sign * (l.igst || 0) * k, camt: sign * (l.cgst || 0) * k, samt: sign * (l.sgst || 0) * k });
  };
  for (const i of invoices) {
    const k = fx(i);
    const rates = byRate(i);
    for (const l of i.lineItems || []) putHsn(hsnOut, l, k, 1);
    t5.nil = r2(t5.nil + rates.filter((r) => !r.rt).reduce((s, r) => s + r.txval, 0));
    const taxed = total(rates.filter((r) => r.rt > 0));
    add(isExport(i) ? t4.EXP : i.customerGstin ? t4.B2B : t4.B2C, taxed);
  }
  for (const c of credits) {
    for (const l of c.lineItems || []) putHsn(hsnOut, l, fx(c), -1);
    add(t4.CN, total(byRate(c)));
  }
  for (const b of bills) for (const l of b.lineItems || []) putHsn(hsnIn, l, fx(b), 1);
  const itc = zero();
  for (const b of bills) add(itc, taxOf(b));
  for (const e of expenses) add(itc, taxOf(e));
  const itcRev = zero();
  for (const v of vcs) add(itcRev, taxOf(v));
  const net = (a, b) => ({ txval: r2(a.txval - b.txval), iamt: r2(a.iamt - b.iamt), camt: r2(a.camt - b.camt), samt: r2(a.samt - b.samt) });
  const t4N = net(add(add(add(zero(), t4.B2C), t4.B2B), t4.EXP), t4.CN);
  const payable = { iamt: t4N.iamt, camt: t4N.camt, samt: t4N.samt };
  const itcNet = { iamt: r2(itc.iamt - itcRev.iamt), camt: r2(itc.camt - itcRev.camt), samt: r2(itc.samt - itcRev.samt) };
  return {
    fy: label,
    from,
    to,
    table4: {
      "4A · Supplies to unregistered persons (B2C)": t4.B2C,
      "4B · Supplies to registered persons (B2B)": t4.B2B,
      "4C · Zero-rated supplies (exports) with tax": t4.EXP,
      "4I · Credit notes issued": t4.CN,
      "4N · Total (net of credit notes)": t4N,
    },
    table5: { "5D · Nil-rated supplies": { txval: t5.nil } },
    table6: { "6B · ITC on inward supplies (bills and expenses)": itc, "7 · ITC reversed (vendor credits)": itcRev, "7J · Net ITC available": itcNet },
    table9: { payable, paidThroughItc: setOff(payable, itcNet) },
    table17: Object.values(hsnOut).filter((h) => h.txval || h.qty).sort((a, b) => a.hsn.localeCompare(b.hsn)),
    table18: Object.values(hsnIn).filter((h) => h.txval || h.qty).sort((a, b) => a.hsn.localeCompare(b.hsn)),
    counts: { invoices: invoices.length, creditNotes: credits.length, bills: bills.length, expenses: expenses.length },
  };
}

/* ----------------------------- GSTR-2B reconciliation ----------------------------- */
const normNo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const looseNo = (s) => normNo(s).replace(/(^|[A-Z])0+(?=\d)/g, "$1");
const numOf = (v) => {
  if (typeof v === "number") return v;
  const n = Number(String(v || "").replace(/[₹,\s]/g, ""));
  return isFinite(n) ? n : 0;
};
function parseDate(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + v * 86400000); // Excel serial
  const s = String(v || "").trim();
  let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/.exec(s);
  if (m) {
    const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (mi >= 0) return new Date(Date.UTC(y, mi, +m[1]));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Accepts the GSTR-2B JSON (or older 2A JSON) downloaded from the portal, or the GSTR-2B Excel.
function parse2b(buf, name = "") {
  const docs = [];
  const push = (d) => {
    d.gstin = String(d.gstin || "").toUpperCase().trim();
    d.number = String(d.number || "").trim();
    if (!d.gstin || !d.number) return;
    d.txval = r2(d.txval);
    d.iamt = r2(d.iamt);
    d.camt = r2(d.camt);
    d.samt = r2(d.samt);
    d.value = r2(d.value);
    docs.push(d);
  };
  const isJson = /\.json$/i.test(name) || /^\s*[{[]/.test(buf.slice(0, 20).toString("utf8"));
  let period = "";
  let gstin = "";
  if (isJson) {
    let j;
    try {
      j = JSON.parse(buf.toString("utf8").replace(/^﻿/, ""));
    } catch {
      throw new HttpError(400, "That file isn't valid JSON");
    }
    const root = j.data || j;
    gstin = root.gstin || "";
    period = root.rtnprd || root.fp || "";
    const dd = root.docdata || root;
    const items2b = (items) => (items || []).reduce((s, x) => add(s, { txval: x.txval, iamt: x.igst, camt: x.cgst, samt: x.sgst }), zero());
    const items2a = (itms) => (itms || []).reduce((s, x) => add(s, { txval: x.itm_det?.txval, iamt: x.itm_det?.iamt, camt: x.itm_det?.camt, samt: x.itm_det?.samt }), zero());
    for (const sup of dd.b2b || []) {
      for (const inv of sup.inv || []) {
        const t = inv.items ? items2b(inv.items) : items2a(inv.itms);
        push({ type: "Invoice", gstin: sup.ctin, name: sup.trdnm || "", number: inv.inum, date: parseDate(inv.dt || inv.idt), value: inv.val, ...t, itc: inv.itcavl ? inv.itcavl === "Y" : true, reverse: (inv.rev || inv.rchrg) === "Y", supplierPeriod: sup.supprd || "", reason: inv.rsn || "" });
      }
    }
    for (const sup of [...(dd.cdnr || []), ...(dd.cdn || [])]) {
      for (const nt of sup.nt || []) {
        const t = nt.items ? items2b(nt.items) : items2a(nt.itms);
        const sign = (nt.typ || nt.ntty) === "D" ? 1 : -1;
        push({ type: sign < 0 ? "Credit Note" : "Debit Note", gstin: sup.ctin, name: sup.trdnm || "", number: nt.ntnum || nt.nt_num, date: parseDate(nt.dt || nt.nt_dt), value: sign * numOf(nt.val), txval: sign * t.txval, iamt: sign * t.iamt, camt: sign * t.camt, samt: sign * t.samt, itc: nt.itcavl ? nt.itcavl === "Y" : true, reverse: nt.rev === "Y", supplierPeriod: sup.supprd || "" });
      }
    }
  } else {
    const XLSX = require("xlsx");
    let wb;
    try {
      wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    } catch {
      throw new HttpError(400, "Couldn't open that file. Upload the GSTR-2B JSON or Excel downloaded from the GST portal.");
    }
    const sheetRows = (want) => {
      const nameHit = wb.SheetNames.find((n) => want.test(n));
      if (!nameHit) return null;
      return XLSX.utils.sheet_to_json(wb.Sheets[nameHit], { header: 1, raw: true, defval: "" });
    };
    const readSheet = (rows, kind) => {
      if (!rows) return;
      const h = rows.findIndex((r) => r.some((c) => /gstin of supplier/i.test(String(c))));
      if (h < 0) return;
      const cols = rows[h].map((c, i) => `${c} ${rows[h + 1]?.[i] || ""}`.toLowerCase());
      const find = (re) => cols.findIndex((c) => re.test(c));
      const ix = {
        gstin: find(/gstin of supplier/),
        name: find(/trade|legal name/),
        number: kind === "inv" ? find(/invoice number|invoice no/) : find(/note number|note no/),
        noteType: find(/note type/),
        date: kind === "inv" ? find(/invoice date/) : find(/note date/),
        value: kind === "inv" ? find(/invoice value/) : find(/note value/),
        txval: find(/taxable value/),
        iamt: find(/integrated/),
        camt: find(/central/),
        samt: find(/state\/ut|state tax/),
        itc: find(/itc availability/),
        rev: find(/reverse charge/),
        period: find(/period/),
      };
      const start = /integrated|central|taxable/i.test(rows[h + 1]?.join(" ") || "") ? h + 2 : h + 1;
      const agg = {};
      for (const r of rows.slice(start)) {
        const g = String(r[ix.gstin] || "").trim();
        if (!/^[0-9]{2}[A-Z0-9]{13}$/i.test(g)) continue;
        const no = String(r[ix.number] || "").trim();
        const k = `${g}|${no}`;
        const sign = kind === "cn" && !/debit/i.test(String(r[ix.noteType] || "")) ? -1 : 1;
        const d = (agg[k] = agg[k] || { type: kind === "inv" ? "Invoice" : sign < 0 ? "Credit Note" : "Debit Note", gstin: g, name: r[ix.name], number: no, date: parseDate(r[ix.date]), value: sign * numOf(r[ix.value]), txval: 0, iamt: 0, camt: 0, samt: 0, itc: ix.itc < 0 ? true : !/^no$/i.test(String(r[ix.itc]).trim()), reverse: /^y/i.test(String(r[ix.rev] || "")), supplierPeriod: String(r[ix.period] || "") });
        d.txval += sign * numOf(r[ix.txval]);
        d.iamt += sign * numOf(r[ix.iamt]);
        d.camt += sign * numOf(r[ix.camt]);
        d.samt += sign * numOf(r[ix.samt]);
      }
      Object.values(agg).forEach(push);
    };
    readSheet(sheetRows(/^b2b$/i), "inv");
    readSheet(sheetRows(/^b2b.?cdnr$/i), "cn");
    if (!docs.length) {
      const any = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
      for (const rows of any) readSheet(rows, "inv");
    }
  }
  if (!docs.length) throw new HttpError(400, "No supplier invoices were found in that file. Upload the GSTR-2B JSON or Excel from the GST portal (Returns → GSTR-2B → Download).");
  return { docs, gstin, period };
}

// Match the 2B documents against the bills and expenses in the books.
async function reconcile(org, docs2b, from, to, { tolerance = 1 } = {}) {
  // Look for matches across the whole financial year up to the period end: suppliers often file late.
  const fyStart = new Date(Date.UTC(from.getUTCMonth() >= 3 ? from.getUTCFullYear() : from.getUTCFullYear() - 1, 3, 1));
  const searchFrom = new Date(Math.min(fyStart, from - 86400000 * 365));
  const [bills, expenses, vcs, vendors] = await Promise.all([
    Bill.find({ organization: org._id, ...live, date: { $gte: searchFrom, $lte: to } }).lean(),
    Expense.find({ organization: org._id, date: { $gte: searchFrom, $lte: to } }).lean(),
    VendorCredit.find({ organization: org._id, ...live, date: { $gte: searchFrom, $lte: to } }).lean(),
    Vendor.find({ organization: org._id }, { displayName: 1, gstin: 1 }).lean(),
  ]);
  const vg = Object.fromEntries(vendors.map((v) => [String(v._id), (v.gstin || "").toUpperCase()]));
  const vendorByGstin = Object.fromEntries(vendors.filter((v) => v.gstin).map((v) => [v.gstin.toUpperCase(), String(v._id)]));
  const book = [];
  for (const b of bills) {
    const g = (b.vendorGstin || vg[String(b.vendor)] || "").toUpperCase();
    if (!g) continue;
    book.push({ kind: "bill", id: b._id, type: "Invoice", gstin: g, name: b.vendorName, number: b.billNumber, date: b.date, value: r2(b.total * fx(b)), txval: r2(b.subTotal * fx(b)), ...taxOf(b) });
  }
  for (const e of expenses) {
    const g = vg[String(e.vendor)] || "";
    if (!g || !(e.igst || e.cgst || e.sgst)) continue;
    book.push({ kind: "expense", id: e._id, type: "Invoice", gstin: g, name: e.vendorName, number: e.reference || "", date: e.date, value: r2(e.total), txval: r2(e.amount), ...taxOf(e) });
  }
  for (const v of vcs) {
    const g = (v.vendorGstin || vg[String(v.vendor)] || "").toUpperCase();
    if (!g) continue;
    book.push({ kind: "vendorCredit", id: v._id, type: "Credit Note", gstin: g, name: v.vendorName, number: v.number || v.creditNoteNumber || "", date: v.date, value: -r2(v.total * fx(v)), txval: -r2(v.subTotal * fx(v)), ...taxOf(v, -1) });
  }
  const tax = (d) => r2((d.iamt || 0) + (d.camt || 0) + (d.samt || 0));
  const used = new Set();
  const rows = [];
  const byGstin = {};
  for (const b of book) (byGstin[b.gstin] = byGstin[b.gstin] || []).push(b);
  for (const d of docs2b) {
    const cands = (byGstin[d.gstin] || []).filter((b) => !used.has(b) && (b.type === "Credit Note") === (d.type === "Credit Note"));
    let m = cands.find((b) => normNo(b.number) === normNo(d.number)) || cands.find((b) => looseNo(b.number) && looseNo(b.number) === looseNo(d.number));
    let how = "number";
    if (!m) {
      m = cands.find((b) => Math.abs(b.value - d.value) <= tolerance && Math.abs(tax(b) - tax(d)) <= tolerance && d.date && Math.abs(new Date(b.date) - d.date) <= 5 * 86400000);
      how = "amount";
    }
    if (m) used.add(m);
    const diffs = [];
    if (m) {
      if (Math.abs(m.txval - d.txval) > tolerance) diffs.push("Taxable value");
      if (Math.abs(tax(m) - tax(d)) > tolerance) diffs.push("Tax amount");
      if (Math.abs(m.iamt - d.iamt) > tolerance && Math.abs(tax(m) - tax(d)) <= tolerance) diffs.push("IGST vs CGST/SGST");
      if (d.date && Math.abs(new Date(m.date) - d.date) > 86400000) diffs.push("Date");
      if (how === "amount") diffs.push("Bill number");
    }
    rows.push({
      status: !m ? "missing_in_books" : diffs.length ? (how === "amount" && diffs.length === 1 ? "probable" : "mismatch") : "matched",
      diffs,
      portal: d,
      books: m ? { kind: m.kind, id: m.id, number: m.number, date: m.date, value: m.value, txval: m.txval, iamt: m.iamt, camt: m.camt, samt: m.samt } : null,
      gstin: d.gstin,
      name: d.name || m?.name || "",
      vendorId: m ? undefined : vendorByGstin[d.gstin],
    });
  }
  // Bills in this period that the supplier hasn't reported: ITC on them isn't in 2B.
  for (const b of book) {
    if (used.has(b)) continue;
    if (new Date(b.date) < from || new Date(b.date) > to) continue;
    rows.push({ status: "missing_in_2b", diffs: [], portal: null, books: { kind: b.kind, id: b.id, number: b.number, date: b.date, value: b.value, txval: b.txval, iamt: b.iamt, camt: b.camt, samt: b.samt }, gstin: b.gstin, name: b.name });
  }
  const sumTax = (list, side) => list.reduce((s, r) => add(s, r[side] || {}), zero());
  const by = (st) => rows.filter((r) => r.status === st);
  const summary = {};
  for (const st of ["matched", "probable", "mismatch", "missing_in_books", "missing_in_2b"]) {
    const list = by(st);
    summary[st] = { count: list.length, portal: sumTax(list, "portal"), books: sumTax(list, "books") };
  }
  // ITC you can claim: 2B documents marked available (whether or not in the books — but flag missing ones).
  const claimable = docs2b.filter((d) => d.itc && !d.reverse).reduce((s, d) => add(s, d), zero());
  return { rows, summary, itc2b: { iamt: claimable.iamt, camt: claimable.camt, samt: claimable.samt }, itcBooks: book.filter((b) => new Date(b.date) >= from && new Date(b.date) <= to).reduce((s, b) => add(s, b), zero()) };
}

/* ----------------------------- Compliance calendar ----------------------------- */
// States whose QRMP GSTR-3B falls on the 22nd; the rest file on the 24th.
const QRMP_22 = ["22", "23", "24", "27", "29", "30", "32", "33", "34", "35", "36", "37", "31", "26", "25", "38", "97"];
function calendar(org, fy, filings = []) {
  const { from } = fyRange(fy);
  const y = from.getUTCFullYear();
  const freq = org.gstFiling?.frequency || "monthly";
  const day3b = QRMP_22.includes(org.state) ? 22 : 24;
  const items = [];
  const at = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
  const per = (yy, mm) => `${yy}-${pad(mm + 1)}`;
  for (let k = 0; k < 12; k++) {
    const mm = (3 + k) % 12;
    const yy = mm < 3 ? y + 1 : y;
    const nx = at(yy, mm + 1, 1);
    const p = per(yy, mm);
    const qEnd = k % 3 === 2;
    const name = `${MON[mm]} ${yy}`;
    if (freq === "monthly") {
      items.push({ form: "GSTR-1", period: p, label: name, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), 11), kind: "gst" });
      items.push({ form: "GSTR-3B", period: p, label: name, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), 20), kind: "gst" });
    } else if (qEnd) {
      const q = `${MON[(mm + 10) % 12]}–${name}`;
      items.push({ form: "GSTR-1", period: p, label: q, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), 13), kind: "gst" });
      items.push({ form: "GSTR-3B", period: p, label: q, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), day3b), kind: "gst" });
    } else {
      items.push({ form: "IFF", period: p, label: name, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), 13), kind: "gst", optional: true, note: "Optional: lets B2B customers claim ITC monthly" });
      items.push({ form: "PMT-06", period: p, label: name, due: at(nx.getUTCFullYear(), nx.getUTCMonth(), 25), kind: "gst", note: "Monthly tax payment under QRMP" });
    }
    // Income tax: TDS deposit by the 7th (March: 30 April)
    items.push({ form: "TDS payment", period: p, label: name, due: mm === 2 ? at(yy, 3, 30) : at(nx.getUTCFullYear(), nx.getUTCMonth(), 7), kind: "tds", note: "Challan 281 for tax deducted in the month" });
  }
  [
    ["TDS return (Q1)", `${y}-Q1`, at(y, 6, 31)],
    ["TDS return (Q2)", `${y}-Q2`, at(y, 9, 31)],
    ["TDS return (Q3)", `${y}-Q3`, at(y + 1, 0, 31)],
    ["TDS return (Q4)", `${y}-Q4`, at(y + 1, 4, 31)],
  ].forEach(([form, period, due]) => items.push({ form, period, label: `FY ${fy}`, due, kind: "tds", note: "Form 24Q / 26Q" }));
  [
    ["Advance tax (15%)", at(y, 5, 15)],
    ["Advance tax (45%)", at(y, 8, 15)],
    ["Advance tax (75%)", at(y, 11, 15)],
    ["Advance tax (100%)", at(y + 1, 2, 15)],
  ].forEach(([form, due]) => items.push({ form, period: `${fy}|${form}`, label: `FY ${fy}`, due, kind: "income" }));
  items.push({ form: "GSTR-9", period: fy, label: `FY ${fy}`, due: at(y + 1, 11, 31), kind: "gst", note: "Annual return (optional below ₹2 crore turnover)" });
  items.push({ form: "GSTR-9C", period: fy, label: `FY ${fy}`, due: at(y + 1, 11, 31), kind: "gst", note: "Reconciliation statement (turnover above ₹5 crore)" });
  items.push({ form: "ITR", period: fy, label: `FY ${fy}`, due: at(y + 1, 9, 31), kind: "income", note: "31 July if no tax audit is needed" });
  const today = require("./time").istToday();
  const done = Object.fromEntries(filings.map((f) => [`${f.form}|${f.period}`, f]));
  return items
    .sort((a, b) => a.due - b.due)
    .map((i) => {
      const f = done[`${i.form}|${i.period}`];
      return { ...i, filing: f || null, status: f ? "filed" : i.optional && i.due < today ? "optional" : i.due < today ? "overdue" : i.due - today < 7 * 86400000 ? "due_soon" : "upcoming" };
    });
}

module.exports = { periodRange, fyRange, gstr1, gstr3b, gstr9, setOff, parse2b, reconcile, calendar, dmy };
