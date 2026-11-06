/**
 * Home dashboard, from the books: every figure comes from the ledger (the same entries as the trial
 * balance and reports), so it matches Accounts. Receivables / payables ageing is per party, with
 * on-account receipts, credit notes and journals set against the oldest dues (see utils/partyAging.js).
 */
const router = require("express").Router();
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const Item = require("../models/Item");
const { ah, round2 } = require("../utils/http");
const { chartOfAccounts, buildEntries, fiscalYear } = require("../utils/ledger");
const { partyAging } = require("../utils/partyAging");

router.get(
  "/",
  ah(async (req, res) => {
    const org = req.org;
    const time = require("../utils/time");
    const today = time.istToday();
    const end = time.istEndOfToday();
    const fy = fiscalYear(today);
    const monthsBack = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));

    const [accounts, entries, recvAging, payAging, customerCount, itemCount, invoiceCount] = await Promise.all([
      chartOfAccounts(org),
      buildEntries(org, { to: end }),
      partyAging(org, "customer", today),
      partyAging(org, "vendor", today),
      Customer.countDocuments({ organization: org }),
      Item.countDocuments({ organization: org }),
      Invoice.countDocuments({ organization: org, status: { $nin: ["draft", "void"] } }),
    ]);
    const group = new Map(accounts.map((a) => [a.code, a]));
    const isCash = (code) => ["Cash", "Bank"].includes(group.get(code)?.group);

    // Ledger balances of receivables / payables (as in the trial balance).
    let ar = 0;
    let ap = 0;
    // Months: sales = sales (Income) ledgers; receipts = money into cash/bank against receivables.
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(monthsBack.getUTCFullYear(), monthsBack.getUTCMonth() + i, 1));
      months.push({ key: `${d.getUTCFullYear()}-${d.getUTCMonth()}`, label: d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }), year: d.getUTCFullYear(), sales: 0, receipts: 0 });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    let salesThisFy = 0;
    let receiptsThisFy = 0;
    const expense = {};
    for (const e of entries) {
      const d = new Date(e.date);
      const mi = idx[`${d.getUTCFullYear()}-${d.getUTCMonth()}`];
      const inFy = d >= fy.from && d <= fy.to;
      const hitsAr = e.lines.some((l) => l.account === "ar" && l.credit > 0);
      for (const l of e.lines) {
        if (l.account === "ar") ar += l.debit - l.credit;
        if (l.account === "ap") ap += l.credit - l.debit;
        const a = group.get(l.account);
        if (!a) continue;
        if (a.group === "Income") {
          const v = l.credit - l.debit;
          if (mi !== undefined) months[mi].sales += v;
          if (inFy) salesThisFy += v;
        }
        if (hitsAr && isCash(l.account) && l.debit > 0) {
          if (mi !== undefined) months[mi].receipts += l.debit;
          if (inFy) receiptsThisFy += l.debit;
        }
        // Expenses: expense ledgers and your own direct-cost ledgers (not stock movements or the Tally stock difference).
        const exp = ["Expense", "Other Expense"].includes(a.group) || (a.group === "Cost Of Goods Sold" && !a.system && a.role !== "opening_stock_diff");
        if (exp && inFy && !l.stock && a.code !== "adjustments") expense[a.code] = (expense[a.code] || 0) + l.debit - l.credit;
      }
    }
    months.forEach((m) => {
      m.sales = round2(m.sales);
      m.receipts = round2(m.receipts);
    });
    const exps = Object.entries(expense)
      .map(([code, total]) => ({ code, category: group.get(code)?.name || code, total: round2(total) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);

    ar = round2(ar);
    ap = round2(ap);
    const side = (aging, total) => ({
      total, // as per books
      due: aging.due,
      advances: aging.advances,
      other: round2(total - (aging.due - aging.advances)), // posted to receivables/payables without a party
      current: aging.current,
      overdue: aging.overdue,
      buckets: aging.buckets,
    });

    const bills180 = (await require("../utils/bills180").bills180(org).catch(() => null))?.summary || null;
    const recentInvoices = await Invoice.find({ organization: org }, { lineItems: 0, billingAddress: 0 }).sort({ createdAt: -1 }).limit(6);

    res.send({
      source: "books",
      receivables: side(recvAging, ar),
      payables: side(payAging, ap),
      bills180,
      expensesThisFy: round2(exps.reduce((s, x) => s + x.total, 0)),
      topExpenses: exps.slice(0, 5),
      salesThisFy: round2(salesThisFy),
      receiptsThisFy: round2(receiptsThisFy),
      fiscalYearStart: fy.from,
      months,
      topDebtors: recvAging.parties.filter((p) => p.net > 0).slice(0, 5).map((p) => ({ customer: p.id, name: p.name, balance: p.net })),
      recentInvoices,
      counts: { customers: customerCount, items: itemCount, invoices: invoiceCount },
    });
  })
);

// Input tax credit: books month by month beside GSTR-2B, balance left to use, ITC at risk (180 days).
router.get(
  "/itc",
  ah(async (req, res) => {
    const fy = /^\d{4}$/.test(req.query.fy || "") ? Number(req.query.fy) : undefined;
    res.send(await require("../utils/itc").itcSummary(req.org, { fy }));
  })
);

module.exports = router;
