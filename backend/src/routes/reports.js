const router = require("express").Router();
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Bill = require("../models/Bill");
const Expense = require("../models/Expense");
const VendorCredit = require("../models/VendorCredit");
const Organization = require("../models/Organization");
const { ah, round2 } = require("../utils/http");
const { istToday, istEndOfToday } = require("../utils/time");
const { chartOfAccounts, buildEntries, movements, naturalBalance, fiscalYear, parseRange } = require("../utils/ledger");

const DAY = 24 * 60 * 60 * 1000;
const sum = (xs, f) => round2(xs.reduce((s, x) => s + (Number(f(x)) || 0), 0));
const inRange = (d, from, to) => (!from || new Date(d) >= from) && (!to || new Date(d) <= to);

// Sections of accounts for a set of movements.
function section(accounts, mv, groups) {
  const rows = accounts
    .filter((a) => groups.includes(a.group))
    .map((a) => ({ code: a.code, name: a.name, group: a.group, amount: naturalBalance(a, mv[a.code]) }))
    .filter((r) => r.amount !== 0);
  return { rows, total: sum(rows, (r) => r.amount) };
}

function profitAndLoss(accounts, mv) {
  const operatingIncome = section(accounts, mv, ["Income"]);
  const cogs = section(accounts, mv, ["Cost Of Goods Sold"]);
  const operatingExpense = section(accounts, mv, ["Expense"]);
  const otherIncome = section(accounts, mv, ["Other Income"]);
  const otherExpense = section(accounts, mv, ["Other Expense"]);
  const grossProfit = round2(operatingIncome.total - cogs.total);
  const operatingProfit = round2(grossProfit - operatingExpense.total);
  const netProfit = round2(operatingProfit + otherIncome.total - otherExpense.total);
  return { operatingIncome, cogs, grossProfit, operatingExpense, operatingProfit, otherIncome, otherExpense, netProfit };
}

router.get(
  "/profit-and-loss",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    res.send({ from, to, ...profitAndLoss(accounts, movements(entries, { from, to })) });
  })
);

router.get(
  "/balance-sheet",
  ah(async (req, res) => {
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : istEndOfToday();
    const fy = fiscalYear(to);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mvAll = movements(entries, { to });
    const currentAssets = section(accounts, mvAll, ["Cash", "Bank", "Accounts Receivable", "Other Current Asset"]);
    const fixedAssets = section(accounts, mvAll, ["Fixed Asset"]);
    const currentLiabilities = section(accounts, mvAll, ["Accounts Payable", "Other Current Liability"]);
    const longTermLiabilities = section(accounts, mvAll, ["Long Term Liability"]);
    const equity = section(accounts, mvAll, ["Equity"]);
    const priorEnd = new Date(fy.from.getTime() - 1);
    const retained = profitAndLoss(accounts, movements(entries, { to: priorEnd })).netProfit;
    const currentYear = profitAndLoss(accounts, movements(entries, { from: fy.from, to })).netProfit;
    if (retained) equity.rows.push({ code: "_retained", name: "Retained Earnings", amount: retained });
    if (currentYear) equity.rows.push({ code: "_current", name: "Current Year Earnings", amount: currentYear });
    equity.total = sum(equity.rows, (r) => r.amount);
    const totalAssets = round2(currentAssets.total + fixedAssets.total);
    const totalLiabilities = round2(currentLiabilities.total + longTermLiabilities.total);
    const totalLiabilitiesAndEquity = round2(totalLiabilities + equity.total);
    res.send({
      to,
      currentAssets,
      fixedAssets,
      totalAssets,
      currentLiabilities,
      longTermLiabilities,
      totalLiabilities,
      equity,
      totalLiabilitiesAndEquity,
      balanced: totalAssets === totalLiabilitiesAndEquity,
    });
  })
);

router.get(
  "/trial-balance",
  ah(async (req, res) => {
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : istEndOfToday();
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mv = movements(entries);
    const rows = accounts
      .map((a) => {
        const m = mv[a.code] || { debit: 0, credit: 0 };
        const net = round2(m.debit - m.credit);
        return { code: a.code, name: a.name, group: a.group, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      })
      .filter((r) => r.debit || r.credit);
    res.send({ to, rows, totalDebit: sum(rows, (r) => r.debit), totalCredit: sum(rows, (r) => r.credit) });
  })
);

// Ageing of what customers owe (AR) or what you owe vendors (AP), as of today.
function aging(docs, partyKey, nameKey) {
  const today = istToday();
  const buckets = ["current", "d1_15", "d16_30", "d31_45", "d45plus"];
  const map = {};
  for (const d of docs) {
    if (d.balance <= 0) continue;
    const k = String(d[partyKey]);
    map[k] = map[k] || { id: d[partyKey], name: d[nameKey], current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0, total: 0 };
    const late = Math.floor((today - new Date(d.dueDate)) / DAY);
    const b = late <= 0 ? "current" : late <= 15 ? "d1_15" : late <= 30 ? "d16_30" : late <= 45 ? "d31_45" : "d45plus";
    map[k][b] = round2(map[k][b] + d.balance);
    map[k].total = round2(map[k].total + d.balance);
  }
  const rows = Object.values(map).sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries([...buckets, "total"].map((b) => [b, sum(rows, (r) => r[b])]));
  return { asOf: today, rows, totals };
}

router.get(
  "/ar-aging",
  ah(async (req, res) => {
    const invoices = await Invoice.find({ organization: req.org, status: { $in: ["sent", "partially_paid"] } }, { lineItems: 0 }).lean();
    res.send(aging(invoices, "customer", "customerName"));
  })
);

router.get(
  "/ap-aging",
  ah(async (req, res) => {
    const bills = await Bill.find({ organization: req.org, status: { $in: ["open", "partially_paid"] } }, { lineItems: 0 }).lean();
    res.send(aging(bills, "vendor", "vendorName"));
  })
);

const liveInvoices = (org, from, to) =>
  Invoice.find({ organization: org, status: { $nin: ["draft", "void"] }, date: { $gte: from, $lte: to } }).lean();
const liveCredits = (org, from, to) =>
  CreditNote.find({ organization: org, status: { $nin: ["draft", "void"] }, date: { $gte: from, $lte: to } }).lean();

router.get(
  "/sales-by-customer",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const invoices = await liveInvoices(req.org, from, to);
    const map = {};
    for (const i of invoices) {
      const k = String(i.customer);
      map[k] = map[k] || { id: i.customer, name: i.customerName, count: 0, sales: 0, salesWithTax: 0 };
      map[k].count += 1;
      map[k].sales = round2(map[k].sales + i.subTotal);
      map[k].salesWithTax = round2(map[k].salesWithTax + i.total);
    }
    const rows = Object.values(map).sort((a, b) => b.sales - a.sales);
    res.send({ from, to, rows, totals: { count: sum(rows, (r) => r.count), sales: sum(rows, (r) => r.sales), salesWithTax: sum(rows, (r) => r.salesWithTax) } });
  })
);

router.get(
  "/sales-by-item",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const invoices = await liveInvoices(req.org, from, to);
    const map = {};
    for (const i of invoices) {
      for (const l of i.lineItems) {
        const k = l.item ? String(l.item) : `name:${l.name}`;
        map[k] = map[k] || { name: l.name, hsnSac: l.hsnSac, unit: l.unit, quantity: 0, amount: 0 };
        map[k].quantity = round2(map[k].quantity + l.quantity);
        map[k].amount = round2(map[k].amount + l.amount);
      }
    }
    const rows = Object.values(map)
      .map((r) => ({ ...r, averagePrice: r.quantity ? round2(r.amount / r.quantity) : 0 }))
      .sort((a, b) => b.amount - a.amount);
    res.send({ from, to, rows, totals: { quantity: sum(rows, (r) => r.quantity), amount: sum(rows, (r) => r.amount) } });
  })
);

router.get(
  "/expenses-by-category",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mv = movements(entries, { from, to });
    const rows = accounts
      .filter((a) => a.type === "expense")
      .map((a) => ({ code: a.code, name: a.name, group: a.group, amount: naturalBalance(a, mv[a.code]) }))
      .filter((r) => r.amount !== 0)
      .sort((a, b) => b.amount - a.amount);
    res.send({ from, to, rows, total: sum(rows, (r) => r.amount) });
  })
);

/* ----------------------------- GST ----------------------------- */
const B2CL_LIMIT = 100000; // inter-state B2C invoices above ₹1 lakh are reported individually

function taxSplit(lines) {
  return {
    taxable: sum(lines, (l) => l.amount),
    igst: sum(lines, (l) => l.igst),
    cgst: sum(lines, (l) => l.cgst),
    sgst: sum(lines, (l) => l.sgst),
  };
}

router.get(
  "/gstr1",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const [org, invoices, credits] = await Promise.all([
      Organization.findById(req.org).lean(),
      liveInvoices(req.org, from, to),
      liveCredits(req.org, from, to),
    ]);

    const b2b = [];
    const b2cl = [];
    const b2csMap = {};
    const hsnMap = {};
    for (const i of invoices) {
      const t = taxSplit(i.lineItems);
      const row = { id: i._id, number: i.invoiceNumber, date: i.date, name: i.customerName, gstin: i.customerGstin, placeOfSupply: i.placeOfSupply, total: i.total, ...t };
      if (i.customerGstin) b2b.push(row);
      else if (i.isInterState && i.total > B2CL_LIMIT) b2cl.push(row);
      else {
        for (const l of i.lineItems) {
          const k = `${i.placeOfSupply}|${l.taxRate}`;
          b2csMap[k] = b2csMap[k] || { placeOfSupply: i.placeOfSupply, rate: l.taxRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
          const r = b2csMap[k];
          r.taxable = round2(r.taxable + l.amount);
          r.igst = round2(r.igst + l.igst);
          r.cgst = round2(r.cgst + l.cgst);
          r.sgst = round2(r.sgst + l.sgst);
        }
      }
      for (const l of i.lineItems) {
        const k = `${l.hsnSac || "-"}|${l.taxRate}`;
        hsnMap[k] = hsnMap[k] || { hsn: l.hsnSac || "", unit: l.unit || "", rate: l.taxRate, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
        const h = hsnMap[k];
        h.quantity = round2(h.quantity + l.quantity);
        h.taxable = round2(h.taxable + l.amount);
        h.igst = round2(h.igst + l.igst);
        h.cgst = round2(h.cgst + l.cgst);
        h.sgst = round2(h.sgst + l.sgst);
      }
    }
    const cdnr = [];
    const cdnur = [];
    for (const c of credits) {
      const row = { id: c._id, number: c.number, date: c.date, name: c.customerName, gstin: c.customerGstin, invoiceNumber: c.invoiceNumber, placeOfSupply: c.placeOfSupply, total: c.total, ...taxSplit(c.lineItems) };
      (c.customerGstin ? cdnr : cdnur).push(row);
    }
    const b2cs = Object.values(b2csMap).sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate);
    const hsn = Object.values(hsnMap).sort((a, b) => a.hsn.localeCompare(b.hsn));
    const tot = (rows) => ({ count: rows.length, taxable: sum(rows, (r) => r.taxable), igst: sum(rows, (r) => r.igst), cgst: sum(rows, (r) => r.cgst), sgst: sum(rows, (r) => r.sgst) });
    res.send({
      from,
      to,
      gstin: org.gstin,
      b2b: { rows: b2b, ...tot(b2b) },
      b2cl: { rows: b2cl, ...tot(b2cl) },
      b2cs: { rows: b2cs, ...tot(b2cs) },
      cdnr: { rows: cdnr, ...tot(cdnr) },
      cdnur: { rows: cdnur, ...tot(cdnur) },
      hsn: { rows: hsn, ...tot(hsn) },
      documents: { invoices: invoices.length, creditNotes: credits.length },
    });
  })
);

router.get(
  "/gstr3b",
  ah(async (req, res) => {
    const { from, to } = parseRange(req.query);
    const [invoices, credits, bills, expenses, vendorCredits] = await Promise.all([
      liveInvoices(req.org, from, to),
      liveCredits(req.org, from, to),
      Bill.find({ organization: req.org, status: { $nin: ["draft", "void"] }, date: { $gte: from, $lte: to } }).lean(),
      Expense.find({ organization: req.org, date: { $gte: from, $lte: to } }).lean(),
      VendorCredit.find({ organization: req.org, status: { $nin: ["draft", "void"] }, date: { $gte: from, $lte: to } }).lean(),
    ]);
    const lines = (docs, taxed) => docs.flatMap((d) => d.lineItems).filter((l) => (taxed ? l.taxRate > 0 : !l.taxRate));
    const minus = (a, b) => ({
      taxable: round2(a.taxable - b.taxable),
      igst: round2(a.igst - b.igst),
      cgst: round2(a.cgst - b.cgst),
      sgst: round2(a.sgst - b.sgst),
    });
    const outward = minus(taxSplit(lines(invoices, true)), taxSplit(lines(credits, true)));
    const nilExempt = minus(taxSplit(lines(invoices, false)), taxSplit(lines(credits, false)));
    const itcBills = { igst: sum(bills, (b) => b.igst), cgst: sum(bills, (b) => b.cgst), sgst: sum(bills, (b) => b.sgst) };
    const itcExpenses = { igst: sum(expenses, (e) => e.igst), cgst: sum(expenses, (e) => e.cgst), sgst: sum(expenses, (e) => e.sgst) };
    const itcReversed = { igst: sum(vendorCredits, (c) => c.igst), cgst: sum(vendorCredits, (c) => c.cgst), sgst: sum(vendorCredits, (c) => c.sgst) };
    const itc = {
      igst: round2(itcBills.igst + itcExpenses.igst - itcReversed.igst),
      cgst: round2(itcBills.cgst + itcExpenses.cgst - itcReversed.cgst),
      sgst: round2(itcBills.sgst + itcExpenses.sgst - itcReversed.sgst),
    };
    const net = Object.fromEntries(["igst", "cgst", "sgst"].map((k) => [k, round2(outward[k] - itc[k])]));
    res.send({ from, to, outward, nilExempt, itcBills, itcExpenses, itcReversed, itc, net });
  })
);

// Every other report in the Reports Center.
router.get(
  "/:key",
  ah(async (req, res) => {
    const { REPORTS } = require("../utils/reportCatalog");
    const fn = REPORTS[req.params.key];
    if (!fn) return res.status(404).send({ message: "Report not found" });
    res.send(await fn(req, req.query));
  })
);

module.exports = router;
