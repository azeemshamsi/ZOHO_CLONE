/**
 * Reports Center catalog. Each report returns one of three shapes the frontend knows how to draw:
 *   { kind: "table", columns, rows, groupBy?, totals? }        — lists, summaries, ledgers
 *   { kind: "statement", lines }                               — P&L / balance sheet style
 *   { kind: "horizontal", left: {title, lines}, right: {...} } — T-format statements
 * Column types: text | date | money | number | percent. A column with `link` uses row[link] as its URL.
 */
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const CreditNote = require("../models/CreditNote");
const Quote = require("../models/Quote");
const SalesOrder = require("../models/SalesOrder");
const Bill = require("../models/Bill");
const VendorPayment = require("../models/VendorPayment");
const VendorCredit = require("../models/VendorCredit");
const PurchaseOrder = require("../models/PurchaseOrder");
const Expense = require("../models/Expense");
const Customer = require("../models/Customer");
const Vendor = require("../models/Vendor");
const BankStatementLine = require("../models/BankStatementLine");
const BankReconciliation = require("../models/BankReconciliation");
const { round2 } = require("./http");
const { istToday } = require("./time");
const { chartOfAccounts, buildEntries, movements, naturalBalance, fiscalYear, parseRange, debitNormal } = require("./ledger");

const DAY = 24 * 60 * 60 * 1000;
const sum = (xs, f) => round2(xs.reduce((s, x) => s + (Number(f(x)) || 0), 0));
const MODES = { cash: "Cash", bank_transfer: "Bank Transfer", upi: "UPI", cheque: "Cheque", card: "Card", other: "Other" };
const asOfDate = (q) => (q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date(istToday().getTime() + DAY - 1));
const inRangeQ = (from, to) => ({ $gte: from, $lte: to });
const live = { $nin: ["draft", "void"] };

const col = (key, label, type = "text", extra = {}) => ({ key, label, type, ...extra });

/* ---------------- P&L / balance sheet building blocks ---------------- */
function bucket(accounts, mv, groups) {
  const rows = accounts
    .filter((a) => groups.includes(a.group))
    .map((a) => ({ code: a.code, name: a.name, amount: naturalBalance(a, mv[a.code]) }))
    .filter((r) => r.amount !== 0);
  return { rows, total: sum(rows, (r) => r.amount) };
}

function pl(accounts, mv) {
  const income = bucket(accounts, mv, ["Income"]);
  const otherIncome = bucket(accounts, mv, ["Other Income"]);
  const cogs = bucket(accounts, mv, ["Cost Of Goods Sold"]);
  const expense = bucket(accounts, mv, ["Expense"]);
  const otherExpense = bucket(accounts, mv, ["Other Expense"]);
  const net = round2(income.total + otherIncome.total - cogs.total - expense.total - otherExpense.total);
  return { income, otherIncome, cogs, expense, otherExpense, gross: round2(income.total - cogs.total), net };
}

function bs(accounts, entries, to) {
  const mv = movements(entries, { to });
  const fy = fiscalYear(to);
  const retained = pl(accounts, movements(entries, { to: new Date(fy.from.getTime() - 1) })).net;
  const current = pl(accounts, movements(entries, { from: fy.from, to })).net;
  const cash = bucket(accounts, mv, ["Cash", "Bank"]);
  const receivables = bucket(accounts, mv, ["Accounts Receivable"]);
  const otherCA = bucket(accounts, mv, ["Other Current Asset"]);
  const fixed = bucket(accounts, mv, ["Fixed Asset"]);
  const payables = bucket(accounts, mv, ["Accounts Payable"]);
  const otherCL = bucket(accounts, mv, ["Other Current Liability"]);
  const longTerm = bucket(accounts, mv, ["Long Term Liability"]);
  const equity = bucket(accounts, mv, ["Equity"]);
  if (retained) equity.rows.push({ code: "_retained", name: "Retained Earnings", amount: retained });
  if (current) equity.rows.push({ code: "_current", name: "Current Year Earnings", amount: current });
  equity.total = sum(equity.rows, (r) => r.amount);
  const currentAssets = round2(cash.total + receivables.total + otherCA.total);
  const totalAssets = round2(currentAssets + fixed.total);
  const currentLiabilities = round2(payables.total + otherCL.total);
  const totalLiabilities = round2(currentLiabilities + longTerm.total);
  return { cash, receivables, otherCA, fixed, payables, otherCL, longTerm, equity, currentAssets, totalAssets, currentLiabilities, totalLiabilities, totalLE: round2(totalLiabilities + equity.total), current, retained };
}

// Helpers to write statement lines.
const L = {
  head: (label) => ({ label, style: "head" }),
  section: (label) => ({ label, style: "section" }),
  item: (label, amount, code, indent = 1) => ({ label, amount, code, indent, style: "item" }),
  sub: (label, amount) => ({ label, amount, style: "subtotal" }),
  total: (label, amount) => ({ label, amount, style: "total" }),
  grand: (label, amount) => ({ label, amount, style: "grand" }),
};
const items = (b, indent = 1) => b.rows.map((r) => L.item(r.name, r.amount, r.code, indent));

/* ---------------- Aging (details) ---------------- */
function agingRows(docs, { party, number, href }) {
  const today = istToday();
  return docs
    .filter((d) => d.balance > 0)
    .map((d) => {
      const late = Math.floor((today - new Date(d.dueDate)) / DAY);
      return {
        party: d[`${party}Name`],
        date: d.date,
        number: d[number],
        href: href(d),
        dueDate: d.dueDate,
        days: late > 0 ? late : 0,
        bucket: late <= 0 ? "Current" : late <= 15 ? "1–15 days" : late <= 30 ? "16–30 days" : late <= 45 ? "31–45 days" : "> 45 days",
        total: d.total,
        balance: d.balance,
      };
    })
    .sort((a, b) => a.party.localeCompare(b.party) || b.days - a.days);
}
const agingColumns = (partyLabel, numberLabel) => [
  col("date", "Date", "date"),
  col("number", numberLabel, "text", { link: "href" }),
  col("party", partyLabel),
  col("dueDate", "Due Date", "date"),
  col("days", "Days Overdue", "number"),
  col("bucket", "Age"),
  col("total", "Amount", "money", { sum: true }),
  col("balance", "Balance Due", "money", { sum: true }),
];

/* ---------------- Document lists ---------------- */
function docList(Model, { party, number, extra = [], href, statusOf }) {
  return async (req, q) => {
    const { from, to } = parseRange(q);
    const docs = await Model.find({ organization: req.org, date: inRangeQ(from, to) }, { lineItems: 0 }).sort({ date: 1, createdAt: 1 }).lean({ virtuals: true });
    return {
      kind: "table",
      columns: [
        col("date", "Date", "date"),
        col("number", "Number", "text", { link: "href" }),
        col("party", party === "vendor" ? "Vendor" : "Customer"),
        col("status", "Status", "status"),
        ...extra.map((e) => col(e.key, e.label, e.type || "text", e)),
        col("subTotal", "Sub Total", "money", { sum: true }),
        col("tax", "Tax", "money", { sum: true }),
        col("total", "Total", "money", { sum: true }),
      ],
      rows: docs.map((d) => ({
        date: d.date,
        number: d[number],
        href: href(d),
        party: d[`${party}Name`],
        status: statusOf ? statusOf(d) : d.status,
        ...Object.fromEntries(extra.map((e) => [e.key, e.get(d)])),
        subTotal: d.subTotal,
        tax: d.taxTotal,
        total: d.total,
      })),
    };
  };
}

function paymentList(Model, { party, appliedLabel, appliedOf, href }) {
  return async (req, q) => {
    const { from, to } = parseRange(q);
    const docs = await Model.find({ organization: req.org, date: inRangeQ(from, to) }).sort({ date: 1, createdAt: 1 }).lean();
    return {
      kind: "table",
      columns: [
        col("date", "Date", "date"),
        col("number", "Payment#", "text", { link: "href" }),
        col("party", party === "vendor" ? "Vendor" : "Customer"),
        col("mode", "Mode"),
        col("reference", "Reference"),
        col("applied", appliedLabel),
        col("amount", "Amount", "money", { sum: true }),
        col("unused", "Unused", "money", { sum: true }),
      ],
      rows: docs.map((p) => ({
        date: p.date,
        number: p.paymentNumber,
        href: href(p),
        party: p[`${party}Name`],
        mode: MODES[p.mode] || p.mode,
        reference: p.reference,
        applied: appliedOf(p),
        amount: p.amount,
        unused: p.unusedAmount,
      })),
    };
  };
}

/* ---------------- Line-item summaries (by item / by party) ---------------- */
async function byParty(Model, req, q, party) {
  const { from, to } = parseRange(q);
  const docs = await Model.find({ organization: req.org, status: live, date: inRangeQ(from, to) }, { lineItems: 0 }).lean();
  const map = {};
  for (const d of docs) {
    const k = String(d[party]);
    map[k] = map[k] || { party: d[`${party}Name`], href: `/${party === "vendor" ? "vendors" : "customers"}/${d[party]}`, count: 0, amount: 0, tax: 0, total: 0 };
    map[k].count += 1;
    map[k].amount = round2(map[k].amount + d.subTotal);
    map[k].tax = round2(map[k].tax + d.taxTotal);
    map[k].total = round2(map[k].total + d.total);
  }
  return Object.values(map).sort((a, b) => b.amount - a.amount);
}

async function byItem(Model, req, q) {
  const { from, to } = parseRange(q);
  const docs = await Model.find({ organization: req.org, status: live, date: inRangeQ(from, to) }).lean();
  const map = {};
  for (const d of docs) {
    for (const l of d.lineItems) {
      const k = l.item ? String(l.item) : `n:${l.name}`;
      map[k] = map[k] || { name: l.name, hsn: l.hsnSac, unit: l.unit, quantity: 0, amount: 0 };
      map[k].quantity = round2(map[k].quantity + l.quantity);
      map[k].amount = round2(map[k].amount + l.amount);
    }
  }
  return Object.values(map)
    .map((r) => ({ ...r, avg: r.quantity ? round2(r.amount / r.quantity) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/* ================================ Catalog ================================ */
const REPORTS = {
  /* ---------- Business Overview ---------- */
  "pl-schedule-iii": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const p = pl(accounts, movements(entries, { from, to }));
    const revenue = p.income.total;
    const totalIncome = round2(revenue + p.otherIncome.total);
    const totalExpenses = round2(p.cogs.total + p.expense.total + p.otherExpense.total);
    return {
      kind: "statement",
      note: "Format of Schedule III to the Companies Act, 2013 (Division I). Finance cost, depreciation and tax lines appear once those accounts are used.",
      lines: [
        L.section("I. Revenue from operations"),
        ...items(p.income),
        L.sub("Revenue from operations", revenue),
        L.section("II. Other income"),
        ...items(p.otherIncome),
        L.sub("Other income", p.otherIncome.total),
        L.total("III. Total income (I + II)", totalIncome),
        L.section("IV. Expenses"),
        L.section("   Cost of materials consumed / purchases of stock-in-trade"),
        ...items(p.cogs, 2),
        L.section("   Other expenses"),
        ...items(p.expense, 2),
        ...items(p.otherExpense, 2),
        L.total("Total expenses (IV)", totalExpenses),
        L.total("V. Profit / (loss) before tax (III − IV)", round2(totalIncome - totalExpenses)),
        L.item("VI. Tax expense", 0),
        L.grand("VII. Profit / (loss) for the period", round2(totalIncome - totalExpenses)),
      ],
    };
  },

  "horizontal-pl": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const p = pl(accounts, movements(entries, { from, to }));
    const debitSide = [L.section("Cost of Goods Sold"), ...items(p.cogs), L.section("Expenses"), ...items(p.expense), ...items(p.otherExpense)];
    const creditSide = [L.section("Income"), ...items(p.income), L.section("Other Income"), ...items(p.otherIncome)];
    if (p.net >= 0) debitSide.push(L.total("Net Profit", p.net));
    else creditSide.push(L.total("Net Loss", -p.net));
    const side = round2(p.cogs.total + p.expense.total + p.otherExpense.total + Math.max(p.net, 0));
    return {
      kind: "horizontal",
      left: { title: "Expenses (Dr.)", lines: debitSide, total: side },
      right: { title: "Income (Cr.)", lines: creditSide, total: round2(p.income.total + p.otherIncome.total + Math.max(-p.net, 0)) },
    };
  },

  "bs-schedule-iii": async (req, q) => {
    const to = asOfDate(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const b = bs(accounts, entries, to);
    return {
      kind: "statement",
      note: "Format of Schedule III to the Companies Act, 2013 (Division I).",
      lines: [
        L.head("I. EQUITY AND LIABILITIES"),
        L.section("(1) Shareholders' funds"),
        ...items(b.equity),
        L.sub("Total shareholders' funds", b.equity.total),
        L.section("(2) Non-current liabilities"),
        ...items(b.longTerm),
        L.sub("Total non-current liabilities", b.longTerm.total),
        L.section("(3) Current liabilities"),
        L.item("Trade payables", b.payables.total, "ap"),
        ...items(b.otherCL),
        L.sub("Total current liabilities", b.currentLiabilities),
        L.total("TOTAL", b.totalLE),
        L.head("II. ASSETS"),
        L.section("(1) Non-current assets"),
        ...items(b.fixed),
        L.sub("Total non-current assets", b.fixed.total),
        L.section("(2) Current assets"),
        L.item("Trade receivables", b.receivables.total, "ar"),
        L.item("Cash and cash equivalents", b.cash.total),
        ...items(b.cash, 2),
        ...items(b.otherCA),
        L.sub("Total current assets", b.currentAssets),
        L.grand("TOTAL", b.totalAssets),
      ],
    };
  },

  "horizontal-bs": async (req, q) => {
    const to = asOfDate(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const b = bs(accounts, entries, to);
    return {
      kind: "horizontal",
      left: {
        title: "Liabilities & Equity",
        lines: [L.section("Equity"), ...items(b.equity), L.section("Long Term Liabilities"), ...items(b.longTerm), L.section("Current Liabilities"), ...items(b.payables), ...items(b.otherCL)],
        total: b.totalLE,
      },
      right: {
        title: "Assets",
        lines: [L.section("Fixed Assets"), ...items(b.fixed), L.section("Current Assets"), ...items(b.cash), ...items(b.receivables), ...items(b.otherCA)],
        total: b.totalAssets,
      },
    };
  },

  "cash-flow": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mv = movements(entries, { from, to });
    const p = pl(accounts, mv);
    // Change in an account over the period, in "cash effect" terms.
    const delta = (groups) =>
      accounts
        .filter((a) => groups.includes(a.group))
        .map((a) => {
          const m = mv[a.code];
          if (!m) return null;
          // Assets going up use cash; liabilities/equity going up bring cash in.
          const effect = round2(m.credit - m.debit);
          return effect ? { code: a.code, name: a.name, amount: effect } : null;
        })
        .filter(Boolean);
    const workingCap = [...delta(["Accounts Receivable", "Other Current Asset"]), ...delta(["Accounts Payable", "Other Current Liability"])];
    const operating = round2(p.net + sum(workingCap, (r) => r.amount));
    const investing = delta(["Fixed Asset"]);
    const financing = [...delta(["Long Term Liability"]), ...delta(["Equity"])];
    const investingTotal = sum(investing, (r) => r.amount);
    const financingTotal = sum(financing, (r) => r.amount);
    const netChange = round2(operating + investingTotal + financingTotal);
    const cashAccounts = accounts.filter((a) => ["Cash", "Bank"].includes(a.group));
    const opening = sum(cashAccounts, (a) => naturalBalance(a, movements(entries, { to: new Date(from.getTime() - 1) })[a.code]));
    const closing = sum(cashAccounts, (a) => naturalBalance(a, movements(entries, { to })[a.code]));
    return {
      kind: "statement",
      note: "Indirect method. Net change in cash always equals the movement in your cash and bank accounts.",
      lines: [
        L.section("Cash flows from operating activities"),
        L.item("Net profit", p.net),
        L.section("   Adjustments for changes in working capital"),
        ...workingCap.map((r) => L.item(`Change in ${r.name}`, r.amount, r.code, 2)),
        L.sub("Net cash from operating activities", operating),
        L.section("Cash flows from investing activities"),
        ...investing.map((r) => L.item(r.name, r.amount, r.code)),
        L.sub("Net cash from investing activities", investingTotal),
        L.section("Cash flows from financing activities"),
        ...financing.map((r) => L.item(r.name, r.amount, r.code)),
        L.sub("Net cash from financing activities", financingTotal),
        L.total("Net change in cash and cash equivalents", netChange),
        L.item("Cash and cash equivalents at the beginning", opening, null, 0),
        L.grand("Cash and cash equivalents at the end", closing),
      ],
      check: round2(opening + netChange) === closing,
    };
  },

  ratios: async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const p = pl(accounts, movements(entries, { from, to }));
    const b = bs(accounts, entries, to);
    const days = Math.max(1, Math.round((Math.min(to, asOfDate({})) - from) / DAY) + 1);
    const purchases = p.cogs.total;
    const r = (n, d) => (d ? round2(n / d) : null);
    const pct = (n, d) => (d ? round2((n / d) * 100) : null);
    const rows = [
      { group: "Liquidity", ratio: "Current ratio", value: r(b.currentAssets, b.currentLiabilities), unit: "×", formula: "Current assets ÷ current liabilities" },
      { group: "Liquidity", ratio: "Quick ratio", value: r(b.cash.total + b.receivables.total, b.currentLiabilities), unit: "×", formula: "(Cash + receivables) ÷ current liabilities" },
      { group: "Liquidity", ratio: "Cash ratio", value: r(b.cash.total, b.currentLiabilities), unit: "×", formula: "Cash ÷ current liabilities" },
      { group: "Profitability", ratio: "Gross profit margin", value: pct(p.gross, p.income.total), unit: "%", formula: "Gross profit ÷ sales" },
      { group: "Profitability", ratio: "Net profit margin", value: pct(p.net, p.income.total + p.otherIncome.total), unit: "%", formula: "Net profit ÷ total income" },
      { group: "Profitability", ratio: "Return on equity", value: pct(p.net, b.equity.total), unit: "%", formula: "Net profit ÷ equity" },
      { group: "Profitability", ratio: "Return on assets", value: pct(p.net, b.totalAssets), unit: "%", formula: "Net profit ÷ total assets" },
      { group: "Solvency", ratio: "Debt to equity", value: r(b.totalLiabilities, b.equity.total), unit: "×", formula: "Total liabilities ÷ equity" },
      { group: "Efficiency", ratio: "Days sales outstanding", value: p.income.total ? round2((b.receivables.total / p.income.total) * days) : null, unit: "days", formula: "Receivables ÷ sales × days in period" },
      { group: "Efficiency", ratio: "Days payable outstanding", value: purchases ? round2((b.payables.total / purchases) * days) : null, unit: "days", formula: "Payables ÷ purchases × days in period" },
      { group: "Efficiency", ratio: "Asset turnover", value: r(p.income.total, b.totalAssets), unit: "×", formula: "Sales ÷ total assets" },
    ].map((x) => ({ ...x, display: x.value === null ? "—" : x.unit === "%" ? `${x.value}%` : x.unit === "days" ? `${x.value} days` : `${x.value}×` }));
    return { kind: "table", groupBy: "group", columns: [col("ratio", "Ratio"), col("display", "Value", "text", { align: "right" }), col("formula", "How it's worked out")], rows };
  },

  "movement-of-equity": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const before = new Date(from.getTime() - 1);
    const eqAccounts = accounts.filter((a) => a.group === "Equity");
    const mvBefore = movements(entries, { to: before });
    const mvIn = movements(entries, { from, to });
    const earnedBefore = pl(accounts, mvBefore).net;
    const profit = pl(accounts, mvIn).net;
    const rows = eqAccounts
      .map((a) => {
        const opening = naturalBalance(a, mvBefore[a.code]);
        const change = naturalBalance(a, mvIn[a.code]);
        return { name: a.name, href: `/chart-of-accounts/${encodeURIComponent(a.code)}`, opening, additions: change > 0 ? change : 0, reductions: change < 0 ? -change : 0, closing: round2(opening + change) };
      })
      .filter((r) => r.opening || r.additions || r.reductions);
    rows.push({ name: "Retained earnings (profit / loss)", opening: earnedBefore, additions: profit > 0 ? profit : 0, reductions: profit < 0 ? -profit : 0, closing: round2(earnedBefore + profit) });
    return {
      kind: "table",
      columns: [
        col("name", "Equity component", "text", { link: "href" }),
        col("opening", "Opening", "money", { sum: true }),
        col("additions", "Additions", "money", { sum: true }),
        col("reductions", "Reductions", "money", { sum: true }),
        col("closing", "Closing", "money", { sum: true }),
      ],
      rows,
    };
  },

  /* ---------- Sales / Receivables ---------- */
  "sales-summary": async (req, q) => {
    const { from, to } = parseRange(q);
    const [invoices, credits] = await Promise.all([
      Invoice.find({ organization: req.org, status: live, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
      CreditNote.find({ organization: req.org, status: live, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
    ]);
    const map = {};
    const key = (d) => new Date(d).toISOString().slice(0, 7);
    const row = (k) => (map[k] = map[k] || { month: k, count: 0, sales: 0, tax: 0, total: 0, credits: 0 });
    for (const i of invoices) {
      const r = row(key(i.date));
      r.count += 1;
      r.sales = round2(r.sales + i.subTotal);
      r.tax = round2(r.tax + i.taxTotal);
      r.total = round2(r.total + i.total);
    }
    for (const c of credits) {
      const r = row(key(c.date));
      r.credits = round2(r.credits + c.total);
    }
    const rows = Object.values(map)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((r) => ({ ...r, label: new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), net: round2(r.total - r.credits) }));
    return {
      kind: "table",
      columns: [
        col("label", "Month"),
        col("count", "Invoices", "number", { sum: true }),
        col("sales", "Sales", "money", { sum: true }),
        col("tax", "Tax", "money", { sum: true }),
        col("total", "Total", "money", { sum: true }),
        col("credits", "Credit Notes", "money", { sum: true }),
        col("net", "Net Sales", "money", { sum: true }),
      ],
      rows,
    };
  },

  "ar-aging-details": async (req) => {
    const docs = await Invoice.find({ organization: req.org, status: { $in: ["sent", "partially_paid"] } }, { lineItems: 0 }).lean();
    return { kind: "table", groupBy: "party", columns: agingColumns("Customer", "Invoice#"), rows: agingRows(docs, { party: "customer", number: "invoiceNumber", href: (d) => `/invoices/${d._id}` }) };
  },

  "customer-balances": async (req) => {
    const [customers, invoices, payments, credits] = await Promise.all([
      Customer.find({ organization: req.org }).lean(),
      Invoice.find({ organization: req.org, status: live }, { lineItems: 0 }).lean(),
      Payment.find({ organization: req.org }).lean(),
      CreditNote.find({ organization: req.org, status: live }, { lineItems: 0 }).lean(),
    ]);
    const rows = customers
      .map((c) => {
        const id = String(c._id);
        const inv = invoices.filter((i) => String(i.customer) === id);
        const pay = payments.filter((p) => String(p.customer) === id);
        const cn = credits.filter((x) => String(x.customer) === id);
        return {
          name: c.displayName,
          href: `/customers/${c._id}`,
          invoiced: sum(inv, (i) => i.total),
          received: sum(pay, (p) => p.amount),
          credited: sum(cn, (x) => x.total),
          balance: sum(inv.filter((i) => ["sent", "partially_paid"].includes(i.status)), (i) => i.balance),
          available: round2(sum(pay, (p) => p.unusedAmount) + sum(cn.filter((x) => x.status === "open"), (x) => x.balance)),
        };
      })
      .filter((r) => r.invoiced || r.received || r.credited)
      .sort((a, b) => b.balance - a.balance);
    return {
      kind: "table",
      columns: [
        col("name", "Customer", "text", { link: "href" }),
        col("invoiced", "Invoiced", "money", { sum: true }),
        col("received", "Received", "money", { sum: true }),
        col("credited", "Credit Notes", "money", { sum: true }),
        col("available", "Unused Credits", "money", { sum: true }),
        col("balance", "Balance Due", "money", { sum: true }),
      ],
      rows,
    };
  },

  "invoice-details": docList(Invoice, {
    party: "customer",
    number: "invoiceNumber",
    href: (d) => `/invoices/${d._id}`,
    extra: [
      { key: "dueDate", label: "Due Date", type: "date", get: (d) => d.dueDate },
      { key: "balance", label: "Balance", type: "money", sum: true, get: (d) => d.balance },
    ],
  }),
  "quote-details": docList(Quote, { party: "customer", number: "number", href: (d) => `/quotes/${d._id}`, extra: [{ key: "expiry", label: "Expiry", type: "date", get: (d) => d.expiryDate }] }),
  "sales-order-details": docList(SalesOrder, { party: "customer", number: "number", href: (d) => `/sales-orders/${d._id}`, extra: [{ key: "inv", label: "Invoice#", get: (d) => d.invoiceNumber }] }),
  "credit-note-details": docList(CreditNote, {
    party: "customer",
    number: "number",
    href: (d) => `/credit-notes/${d._id}`,
    extra: [
      { key: "inv", label: "Invoice#", get: (d) => d.invoiceNumber },
      { key: "bal", label: "Balance", type: "money", sum: true, get: (d) => d.balance },
    ],
  }),
  "payments-received": paymentList(Payment, {
    party: "customer",
    appliedLabel: "Invoices",
    appliedOf: (p) => p.allocations.map((a) => a.invoiceNumber).join(", "),
    href: (p) => `/payments/${p._id}`,
  }),

  /* ---------- Purchases / Payables ---------- */
  "purchases-by-vendor": async (req, q) => ({
    kind: "table",
    columns: [
      col("party", "Vendor", "text", { link: "href" }),
      col("count", "Bills", "number", { sum: true }),
      col("amount", "Purchases", "money", { sum: true }),
      col("tax", "Tax", "money", { sum: true }),
      col("total", "Total", "money", { sum: true }),
    ],
    rows: await byParty(Bill, req, q, "vendor"),
  }),
  "purchases-by-item": async (req, q) => ({
    kind: "table",
    columns: [col("name", "Item"), col("hsn", "HSN/SAC"), col("quantity", "Quantity", "number", { sum: true }), col("amount", "Amount", "money", { sum: true }), col("avg", "Average Cost", "money")],
    rows: await byItem(Bill, req, q),
  }),
  "ap-aging-details": async (req) => {
    const docs = await Bill.find({ organization: req.org, status: { $in: ["open", "partially_paid"] } }, { lineItems: 0 }).lean();
    return { kind: "table", groupBy: "party", columns: agingColumns("Vendor", "Bill#"), rows: agingRows(docs, { party: "vendor", number: "billNumber", href: (d) => `/bills/${d._id}` }) };
  },
  "vendor-balances": async (req) => {
    const [vendors, bills, payments, credits] = await Promise.all([
      Vendor.find({ organization: req.org }).lean(),
      Bill.find({ organization: req.org, status: live }, { lineItems: 0 }).lean(),
      VendorPayment.find({ organization: req.org }).lean(),
      VendorCredit.find({ organization: req.org, status: live }, { lineItems: 0 }).lean(),
    ]);
    const rows = vendors
      .map((v) => {
        const id = String(v._id);
        const b = bills.filter((x) => String(x.vendor) === id);
        const p = payments.filter((x) => String(x.vendor) === id);
        const c = credits.filter((x) => String(x.vendor) === id);
        return {
          name: v.displayName,
          href: `/vendors/${v._id}`,
          billed: sum(b, (x) => x.total),
          paid: sum(p, (x) => x.amount),
          credited: sum(c, (x) => x.total),
          available: round2(sum(p, (x) => x.unusedAmount) + sum(c.filter((x) => x.status === "open"), (x) => x.balance)),
          balance: sum(b.filter((x) => ["open", "partially_paid"].includes(x.status)), (x) => x.balance),
        };
      })
      .filter((r) => r.billed || r.paid || r.credited)
      .sort((a, b) => b.balance - a.balance);
    return {
      kind: "table",
      columns: [
        col("name", "Vendor", "text", { link: "href" }),
        col("billed", "Billed", "money", { sum: true }),
        col("paid", "Paid", "money", { sum: true }),
        col("credited", "Vendor Credits", "money", { sum: true }),
        col("available", "Advances & Credits", "money", { sum: true }),
        col("balance", "Balance Due", "money", { sum: true }),
      ],
      rows,
    };
  },
  "bill-details": docList(Bill, {
    party: "vendor",
    number: "billNumber",
    href: (d) => `/bills/${d._id}`,
    extra: [
      { key: "dueDate", label: "Due Date", type: "date", get: (d) => d.dueDate },
      { key: "balance", label: "Balance", type: "money", sum: true, get: (d) => d.balance },
    ],
  }),
  "purchase-order-details": docList(PurchaseOrder, { party: "vendor", number: "number", href: (d) => `/purchase-orders/${d._id}`, extra: [{ key: "bill", label: "Bill#", get: (d) => d.billNumber }] }),
  "vendor-credit-details": docList(VendorCredit, {
    party: "vendor",
    number: "number",
    href: (d) => `/vendor-credits/${d._id}`,
    extra: [
      { key: "bill", label: "Bill#", get: (d) => d.billNumber },
      { key: "bal", label: "Balance", type: "money", sum: true, get: (d) => d.balance },
    ],
  }),
  "payments-made": paymentList(VendorPayment, {
    party: "vendor",
    appliedLabel: "Bills",
    appliedOf: (p) => p.allocations.map((a) => a.billNumber).join(", "),
    href: (p) => `/payments-made/${p._id}`,
  }),
  "expense-details": async (req, q) => {
    const { from, to } = parseRange(q);
    const docs = await Expense.find({ organization: req.org, date: inRangeQ(from, to) }).sort({ date: 1 }).lean();
    return {
      kind: "table",
      columns: [
        col("date", "Date", "date"),
        col("category", "Expense Account", "text", { link: "href" }),
        col("vendor", "Vendor"),
        col("paid", "Paid Through"),
        col("reference", "Reference"),
        col("amount", "Amount", "money", { sum: true }),
        col("tax", "GST", "money", { sum: true }),
        col("total", "Total", "money", { sum: true }),
      ],
      rows: docs.map((e) => ({
        date: e.date,
        category: e.category,
        href: `/expenses/${e._id}/edit`,
        vendor: e.vendorName,
        paid: MODES[e.paidThrough] || e.paidThrough,
        reference: e.reference,
        amount: e.amount,
        tax: round2(e.cgst + e.sgst + e.igst),
        total: e.total,
      })),
    };
  },
  "expenses-by-vendor": async (req, q) => {
    const { from, to } = parseRange(q);
    const [bills, expenses] = await Promise.all([
      Bill.find({ organization: req.org, status: live, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
      Expense.find({ organization: req.org, date: inRangeQ(from, to) }).lean(),
    ]);
    const map = {};
    const add = (name, href, amount, total) => {
      const k = name || "(No vendor)";
      map[k] = map[k] || { name: k, href, amount: 0, total: 0 };
      map[k].amount = round2(map[k].amount + amount);
      map[k].total = round2(map[k].total + total);
    };
    bills.forEach((b) => add(b.vendorName, `/vendors/${b.vendor}`, b.subTotal, b.total));
    expenses.forEach((e) => add(e.vendorName, e.vendor ? `/vendors/${e.vendor}` : undefined, e.amount, e.total));
    return {
      kind: "table",
      columns: [col("name", "Vendor", "text", { link: "href" }), col("amount", "Amount (before tax)", "money", { sum: true }), col("total", "Total (with tax)", "money", { sum: true })],
      rows: Object.values(map).sort((a, b) => b.amount - a.amount),
    };
  },

  /* ---------- Accountant ---------- */
  "general-ledger": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mvBefore = movements(entries, { to: new Date(from.getTime() - 1) });
    const mvIn = movements(entries, { from, to });
    const rows = accounts
      .map((a) => {
        const opening = naturalBalance(a, mvBefore[a.code]);
        const m = mvIn[a.code] || { debit: 0, credit: 0 };
        return { name: a.name, href: `/chart-of-accounts/${encodeURIComponent(a.code)}?from=${q.from || ""}&to=${q.to || ""}`, group: a.group, opening, debit: m.debit, credit: m.credit, closing: round2(opening + (debitNormal(a.type) ? m.debit - m.credit : m.credit - m.debit)) };
      })
      .filter((r) => r.opening || r.debit || r.credit);
    return {
      kind: "table",
      columns: [col("name", "Account", "text", { link: "href" }), col("group", "Account Type"), col("opening", "Opening", "money"), col("debit", "Debit", "money", { sum: true }), col("credit", "Credit", "money", { sum: true }), col("closing", "Closing", "money")],
      rows,
    };
  },

  "detailed-general-ledger": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const rows = [];
    for (const a of accounts) {
      const sign = debitNormal(a.type) ? 1 : -1;
      let run = 0;
      const mine = [];
      for (const e of entries)
        for (const l of e.lines) {
          if (l.account !== a.code) continue;
          if (new Date(e.date) < from) run += sign * (l.debit - l.credit);
          else mine.push({ e, l });
        }
      if (!mine.length && !run) continue;
      run = round2(run);
      rows.push({ account: a.name, date: null, type: "Opening Balance", number: "", party: "", debit: null, credit: null, balance: run, muted: true });
      for (const { e, l } of mine) {
        run = round2(run + sign * (l.debit - l.credit));
        rows.push({ account: a.name, date: e.date, type: e.type, number: e.number, party: e.party, debit: l.debit || null, credit: l.credit || null, balance: run, ref: { type: e.type, id: e.id } });
      }
    }
    return {
      kind: "table",
      groupBy: "account",
      columns: [col("date", "Date", "date"), col("type", "Transaction"), col("number", "Number", "doc"), col("party", "Customer / Vendor"), col("debit", "Debit", "money", { sum: true }), col("credit", "Credit", "money", { sum: true }), col("balance", "Balance", "money")],
      rows,
    };
  },

  "journal-report": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const name = (c) => (accounts.find((a) => a.code === c) || { name: c }).name;
    const rows = [];
    for (const e of entries) {
      if (new Date(e.date) < from) continue;
      const group = `${new Date(e.date).toISOString().slice(0, 10)} · ${e.type} ${e.number}${e.party ? ` · ${e.party}` : ""}`;
      for (const l of e.lines) rows.push({ group, account: name(l.account), debit: l.debit || null, credit: l.credit || null, ref: { type: e.type, id: e.id }, number: e.number });
    }
    return { kind: "table", groupBy: "group", columns: [col("account", "Account"), col("debit", "Debit", "money", { sum: true }), col("credit", "Credit", "money", { sum: true })], rows };
  },

  "day-book": async (req, q) => {
    const { from, to } = parseRange(q);
    const entries = await buildEntries(req.org, { to });
    const rows = entries
      .filter((e) => new Date(e.date) >= from)
      .map((e) => ({
        day: new Date(e.date).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }),
        type: e.type,
        number: e.number,
        party: e.party,
        amount: sum(e.lines, (l) => l.debit),
        ref: { type: e.type, id: e.id },
      }));
    return { kind: "table", groupBy: "day", columns: [col("type", "Transaction"), col("number", "Number", "doc"), col("party", "Customer / Vendor / Notes"), col("amount", "Amount", "money", { sum: true })], rows };
  },

  "account-type-summary": async (req, q) => {
    const { from, to } = parseRange(q);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mv = movements(entries, { from, to });
    const map = {};
    for (const a of accounts) {
      const m = mv[a.code];
      if (!m) continue;
      map[a.group] = map[a.group] || { group: a.group, type: a.type, debit: 0, credit: 0 };
      map[a.group].debit = round2(map[a.group].debit + m.debit);
      map[a.group].credit = round2(map[a.group].credit + m.credit);
    }
    const order = ["asset", "liability", "equity", "income", "expense"];
    const rows = Object.values(map)
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
      .map((r) => ({ ...r, typeLabel: { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" }[r.type], net: round2(debitNormal(r.type) ? r.debit - r.credit : r.credit - r.debit) }));
    return { kind: "table", groupBy: "typeLabel", columns: [col("group", "Account Type"), col("debit", "Debit", "money", { sum: true }), col("credit", "Credit", "money", { sum: true }), col("net", "Net", "money")], rows };
  },

  /* ---------- Taxes ---------- */
  "tax-summary": async (req, q) => {
    const { from, to } = parseRange(q);
    const [invoices, credits, bills, vcs, expenses] = await Promise.all([
      Invoice.find({ organization: req.org, status: live, date: inRangeQ(from, to) }).lean(),
      CreditNote.find({ organization: req.org, status: live, date: inRangeQ(from, to) }).lean(),
      Bill.find({ organization: req.org, status: live, date: inRangeQ(from, to) }).lean(),
      VendorCredit.find({ organization: req.org, status: live, date: inRangeQ(from, to) }).lean(),
      Expense.find({ organization: req.org, date: inRangeQ(from, to) }).lean(),
    ]);
    const map = {};
    const row = (rate) => (map[rate] = map[rate] || { rate, outTaxable: 0, outTax: 0, inTaxable: 0, inTax: 0 });
    const addLines = (docs, side, sign) =>
      docs.forEach((d) =>
        d.lineItems.forEach((l) => {
          const r = row(l.taxRate || 0);
          r[`${side}Taxable`] = round2(r[`${side}Taxable`] + sign * l.amount);
          r[`${side}Tax`] = round2(r[`${side}Tax`] + sign * (l.cgst + l.sgst + l.igst));
        })
      );
    addLines(invoices, "out", 1);
    addLines(credits, "out", -1);
    addLines(bills, "in", 1);
    addLines(vcs, "in", -1);
    expenses.forEach((e) => {
      const r = row(e.taxRate || 0);
      r.inTaxable = round2(r.inTaxable + e.amount);
      r.inTax = round2(r.inTax + e.cgst + e.sgst + e.igst);
    });
    const rows = Object.values(map)
      .sort((a, b) => a.rate - b.rate)
      .map((r) => ({ ...r, label: r.rate ? `GST ${r.rate}%` : "Nil / exempt", net: round2(r.outTax - r.inTax) }));
    return {
      kind: "table",
      columns: [
        col("label", "Tax Rate"),
        col("outTaxable", "Sales (taxable value)", "money", { sum: true }),
        col("outTax", "Output GST", "money", { sum: true }),
        col("inTaxable", "Purchases & expenses", "money", { sum: true }),
        col("inTax", "Input GST", "money", { sum: true }),
        col("net", "Net GST", "money", { sum: true }),
      ],
      rows,
    };
  },

  /* ---------- Banking ---------- */
  "reconciliation-status": async (req) => {
    const [accounts, entries, lines, recs] = await Promise.all([
      chartOfAccounts(req.org),
      buildEntries(req.org),
      BankStatementLine.find({ organization: req.org }).lean(),
      BankReconciliation.find({ organization: req.org }).sort({ asOf: -1 }).lean(),
    ]);
    const mv = movements(entries);
    const rows = accounts
      .filter((a) => ["Cash", "Bank"].includes(a.group))
      .map((a) => {
        const mine = lines.filter((l) => l.account === a.code).sort((x, y) => new Date(x.date) - new Date(y.date) || (x.seq || 0) - (y.seq || 0));
        const withBal = mine.filter((l) => l.balance !== null && l.balance !== undefined);
        const last = recs.find((r) => r.account === a.code);
        return {
          name: a.name,
          href: `/banking/${encodeURIComponent(a.code)}`,
          books: naturalBalance(a, mv[a.code]),
          bank: withBal.length ? withBal[withBal.length - 1].balance : null,
          lines: mine.length,
          todo: mine.filter((l) => l.status === "unmatched").length,
          lastReconciled: last ? last.asOf : null,
          lastDifference: last ? last.difference : null,
        };
      });
    return {
      kind: "table",
      columns: [
        col("name", "Account", "text", { link: "href" }),
        col("books", "Balance in MGI", "money", { sum: true }),
        col("bank", "Balance as per bank", "money"),
        col("lines", "Statement lines", "number", { sum: true }),
        col("todo", "To match / categorise", "number", { sum: true }),
        col("lastReconciled", "Last reconciled", "date"),
        col("lastDifference", "Difference then", "money"),
      ],
      rows,
    };
  },
};

module.exports = { REPORTS };
