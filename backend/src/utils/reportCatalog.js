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
  const docs = await Model.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }, { lineItems: 0 }).lean();
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
  const docs = await Model.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean();
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
        L.item("Inventories", (b.otherCA.rows.find((r) => r.code === "inventory") || { amount: 0 }).amount, "inventory"),
        L.item("Trade receivables", b.receivables.total, "ar"),
        L.item("Cash and cash equivalents", b.cash.total),
        ...items(b.cash, 2),
        ...items({ rows: b.otherCA.rows.filter((r) => r.code !== "inventory") }),
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
    // Depreciation is a non-cash charge: added back under operating activities.
    const depAdd = delta(["Fixed Asset"]).filter((r) => r.code === "acc_depreciation");
    const operating = round2(p.net + sum(depAdd, (r) => r.amount) + sum(workingCap, (r) => r.amount));
    const investing = delta(["Fixed Asset"]).filter((r) => r.code !== "acc_depreciation");
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
        ...depAdd.map((r) => L.item("Add: Depreciation (net of disposals)", r.amount, r.code)),
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
      Invoice.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
      CreditNote.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
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
      Bill.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }, { lineItems: 0 }).lean(),
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
      Invoice.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean(),
      CreditNote.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean(),
      Bill.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean(),
      VendorCredit.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean(),
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


/* ================= Inventory, projects, recurring and activity ================= */
const DAYMS = 86400000;
const itemHref = (id) => `/items/${id}`;
const tracked = async (org) => (await require("../models/Item").find({ organization: org, trackInventory: true }).sort({ name: 1 }).lean());

Object.assign(REPORTS, {
  "inventory-summary": async (req, q) => {
    const { from, to } = parseRange(q);
    const { loadStock, committedStock } = require("./inventory");
    const [stock, committed, items] = await Promise.all([loadStock(req.org, { to }), committedStock(req.org), tracked(req.org)]);
    const rows = items.map((it) => {
      const st = stock.items[String(it._id)] || { moves: [], qty: 0 };
      const before = st.moves.filter((m) => new Date(m.date) < from);
      const inRange = st.moves.filter((m) => new Date(m.date) >= from);
      const opening = before.length ? before[before.length - 1].qty : 0;
      const qin = sum(inRange, (m) => m.qtyIn);
      const qout = sum(inRange, (m) => m.qtyOut);
      const c = committed[String(it._id)] || 0;
      return { name: it.name, href: itemHref(it._id), sku: it.sku, unit: it.unit, opening, qin, qout, closing: st.qty, committed: c, available: round2(st.qty - c), reorder: it.reorderLevel || 0 };
    });
    return {
      kind: "table",
      columns: [
        col("name", "Item", "text", { link: "href" }),
        col("sku", "SKU"),
        col("opening", "Opening Stock", "number", { sum: true }),
        col("qin", "Quantity In", "number", { sum: true }),
        col("qout", "Quantity Out", "number", { sum: true }),
        col("closing", "Stock on Hand", "number", { sum: true }),
        col("committed", "Committed", "number", { sum: true }),
        col("available", "Available for Sale", "number", { sum: true }),
        col("reorder", "Reorder Level", "number"),
      ],
      rows,
    };
  },

  "inventory-valuation": async (req, q) => {
    const to = asOfDate(q);
    const { loadStock } = require("./inventory");
    const [stock, items] = await Promise.all([loadStock(req.org, { to }), tracked(req.org)]);
    const rows = items.map((it) => {
      const st = stock.items[String(it._id)] || { qty: 0, value: 0, avgCost: it.purchaseRate };
      return { name: it.name, href: itemHref(it._id), sku: it.sku, qty: st.qty, unit: it.unit, avg: st.qty > 0 ? round2(st.value / st.qty) : 0, value: st.value, retail: round2(st.qty * (it.rate || 0)) };
    });
    return {
      kind: "table",
      note: "FIFO cost. The total equals the Inventory Asset account on the balance sheet.",
      columns: [
        col("name", "Item", "text", { link: "href" }),
        col("sku", "SKU"),
        col("qty", "Stock on Hand", "number", { sum: true }),
        col("unit", "Unit"),
        col("avg", "Average Cost", "money"),
        col("value", "Inventory Value", "money", { sum: true }),
        col("retail", "Value at Selling Price", "money", { sum: true }),
      ],
      rows,
    };
  },

  "fifo-cost-lots": async (req, q) => {
    const to = asOfDate(q);
    const { loadStock } = require("./inventory");
    const [stock, items] = await Promise.all([loadStock(req.org, { to }), tracked(req.org)]);
    const rows = [];
    for (const it of items) {
      const st = stock.items[String(it._id)];
      if (!st) continue;
      // Each remaining lot came from the most recent stock-ins, newest last.
      const ins = st.moves.filter((m) => m.qtyIn > 0);
      let k = ins.length - 1;
      const lots = [...st.layers].reverse().map((l) => {
        const src = l.qty > 0 ? ins[k--] : null;
        return { item: it.name, date: src?.date || null, source: l.qty < 0 ? "Oversold (awaiting stock)" : src ? `${src.type} ${src.number || ""}`.trim() : "", qty: l.qty, unit: l.unit, value: round2(l.qty * l.unit) };
      });
      rows.push(...lots.reverse());
    }
    return {
      kind: "table",
      groupBy: "item",
      note: "Stock still on hand, lot by lot, in the order it will be used up (first in, first out).",
      columns: [col("date", "Received", "date"), col("source", "From"), col("qty", "Quantity Left", "number", { sum: true }), col("unit", "Unit Cost", "money"), col("value", "Value", "money", { sum: true })],
      rows,
    };
  },

  "stock-movement": async (req, q) => {
    const { from, to } = parseRange(q);
    const { loadStock } = require("./inventory");
    const [stock, items] = await Promise.all([loadStock(req.org, { to }), tracked(req.org)]);
    const rows = [];
    for (const it of items) {
      const st = stock.items[String(it._id)];
      if (!st) continue;
      for (const m of st.moves.filter((m) => new Date(m.date) >= from))
        rows.push({ item: it.name, date: m.date, type: m.type, number: m.number, party: m.party, qin: m.qtyIn || null, qout: m.qtyOut || null, unitCost: m.unitCost || null, value: m.value, qty: m.qty, ref: m.type === "Opening Stock" ? null : { type: m.type, id: m.id } });
    }
    return {
      kind: "table",
      groupBy: "item",
      columns: [
        col("date", "Date", "date"),
        col("type", "Transaction"),
        col("number", "Number", "doc"),
        col("party", "Party / Reason"),
        col("qin", "In", "number", { sum: true }),
        col("qout", "Out", "number", { sum: true }),
        col("unitCost", "Unit Cost", "money"),
        col("value", "Value Change", "money", { sum: true }),
        col("qty", "Stock After", "number"),
      ],
      rows,
    };
  },

  "product-sales": async (req, q) => {
    const { from, to } = parseRange(q);
    const { loadStock } = require("./inventory");
    const [stock, invoices] = await Promise.all([loadStock(req.org, { to }), Invoice.find({ organization: req.org, status: live, opening: { $ne: true }, date: inRangeQ(from, to) }).lean()]);
    const map = {};
    for (const i of invoices)
      for (const l of i.lineItems) {
        const k = l.item ? String(l.item) : `n:${l.name}`;
        map[k] = map[k] || { name: l.name, href: l.item ? itemHref(l.item) : undefined, qty: 0, sales: 0, cost: 0, tracked: false };
        map[k].qty = round2(map[k].qty + l.quantity);
        map[k].sales = round2(map[k].sales + l.amount);
      }
    // Cost of what was sold, from the FIFO engine (tracked items only).
    for (const [id, st] of Object.entries(stock.items)) {
      if (!map[id]) continue;
      map[id].tracked = true;
      map[id].cost = round2(-sum(st.moves.filter((m) => m.type === "Invoice" && new Date(m.date) >= from), (m) => m.value));
    }
    const rows = Object.values(map)
      .map((r) => ({ ...r, profit: r.tracked ? round2(r.sales - r.cost) : null, margin: r.tracked && r.sales ? `${round2(((r.sales - r.cost) / r.sales) * 100)}%` : "—", cost: r.tracked ? r.cost : null }))
      .sort((a, b) => b.sales - a.sales);
    return {
      kind: "table",
      note: "Cost and margin are shown for items that track inventory.",
      columns: [col("name", "Item", "text", { link: "href" }), col("qty", "Quantity Sold", "number", { sum: true }), col("sales", "Sales", "money", { sum: true }), col("cost", "Cost of Goods Sold", "money", { sum: true }), col("profit", "Gross Profit", "money", { sum: true }), col("margin", "Margin", "text", { align: "right" })],
      rows,
    };
  },

  "committed-stock": async (req) => {
    const SO = require("../models/SalesOrder");
    const orders = await SO.find({ organization: req.org, status: "confirmed" }).sort({ date: 1 }).lean();
    const items = await tracked(req.org);
    const ids = new Set(items.map((i) => String(i._id)));
    const rows = [];
    for (const o of orders) for (const l of o.lineItems) if (l.item && ids.has(String(l.item))) rows.push({ item: l.name, date: o.date, number: o.number, href: `/sales-orders/${o._id}`, customer: o.customerName, shipment: o.shipmentDate, qty: l.quantity, amount: l.amount });
    return {
      kind: "table",
      groupBy: "item",
      columns: [col("date", "Order Date", "date"), col("number", "Sales Order#", "text", { link: "href" }), col("customer", "Customer"), col("shipment", "Expected Shipment", "date"), col("qty", "Quantity Committed", "number", { sum: true }), col("amount", "Amount", "money", { sum: true })],
      rows,
    };
  },

  "reorder-report": async (req) => {
    const { loadStock, committedStock } = require("./inventory");
    const [stock, committed, items] = await Promise.all([loadStock(req.org), committedStock(req.org), tracked(req.org)]);
    const rows = items
      .map((it) => {
        const st = stock.items[String(it._id)] || { qty: 0 };
        const avail = round2(st.qty - (committed[String(it._id)] || 0));
        return { name: it.name, href: itemHref(it._id), sku: it.sku, qty: st.qty, available: avail, reorder: it.reorderLevel || 0, short: round2(Math.max(0, (it.reorderLevel || 0) - avail)), cost: it.purchaseRate };
      })
      .filter((r) => r.available <= r.reorder)
      .map((r) => ({ ...r, estimate: round2(r.short * (r.cost || 0)) }));
    return {
      kind: "table",
      note: "Items whose available stock (on hand minus committed) is at or below the reorder level.",
      columns: [col("name", "Item", "text", { link: "href" }), col("sku", "SKU"), col("qty", "Stock on Hand", "number"), col("available", "Available", "number"), col("reorder", "Reorder Level", "number"), col("short", "Short By", "number", { sum: true }), col("estimate", "Cost to Top Up", "money", { sum: true })],
      rows,
    };
  },

  /* ---------- Projects & timesheets ---------- */
  "timesheet-details": async (req, q) => {
    const { from, to } = parseRange(q);
    const TimeEntry = require("../models/TimeEntry");
    const Project = require("../models/Project");
    const { rateOf, billedState } = require("../routes/projects");
    const [entries, projects] = await Promise.all([TimeEntry.find({ organization: req.org, timerStartedAt: null, date: inRangeQ(from, to) }).sort({ date: 1 }).lean(), Project.find({ organization: req.org }).lean()]);
    const isBilled = await billedState(req.org, entries);
    const rows = entries.map((e) => {
      const p = projects.find((x) => String(x._id) === String(e.project));
      const rate = p && p.billingMethod !== "fixed" && e.billable ? rateOf(p, e) : 0;
      return {
        project: p ? `${p.name} (${p.customerName})` : "",
        date: e.date,
        task: p?.tasks.find((t) => String(t._id) === String(e.task))?.name || "",
        user: e.userName,
        notes: e.notes,
        status: isBilled(e) ? "Invoiced" : e.billable ? "Unbilled" : "Non-billable",
        hours: round2(e.minutes / 60),
        amount: round2((e.minutes / 60) * rate),
      };
    });
    return {
      kind: "table",
      groupBy: "project",
      columns: [col("date", "Date", "date"), col("task", "Task"), col("user", "User"), col("notes", "Notes"), col("status", "Status"), col("hours", "Hours", "number", { sum: true }), col("amount", "Billable Amount", "money", { sum: true })],
      rows,
    };
  },

  "project-summary": async (req) => {
    const Project = require("../models/Project");
    const projects = await Project.find({ organization: req.org }).sort({ name: 1 }).lean();
    const rows = [];
    for (const p of projects) {
      const r = await require("../routes/projects").summaryOf(req.org, p);
      rows.push({
        name: p.name,
        href: `/projects/${p._id}`,
        customer: p.customerName,
        method: { fixed: "Fixed", project_hours: "Project hours", task_hours: "Task hours", staff_hours: "Staff hours" }[p.billingMethod],
        budget: p.budgetHours || null,
        logged: r.loggedHours,
        used: p.budgetHours ? `${Math.round((r.loggedHours / p.budgetHours) * 100)}%` : "—",
        billed: r.billedHours,
        unbilled: r.unbilledHours,
        unbilledAmount: p.billingMethod === "fixed" ? r.fixedRemaining : r.unbilledAmount,
        invoiced: r.invoicedAmount,
        status: p.status === "active" ? "Active" : "Inactive",
      });
    }
    return {
      kind: "table",
      columns: [
        col("name", "Project", "text", { link: "href" }),
        col("customer", "Customer"),
        col("method", "Billing"),
        col("budget", "Budget Hours", "number", { sum: true }),
        col("logged", "Logged Hours", "number", { sum: true }),
        col("used", "Budget Used", "text", { align: "right" }),
        col("unbilled", "Unbilled Hours", "number", { sum: true }),
        col("unbilledAmount", "Unbilled Amount", "money", { sum: true }),
        col("invoiced", "Invoiced (before GST)", "money", { sum: true }),
        col("status", "Status"),
      ],
      rows,
    };
  },

  "unbilled-time": async (req) => {
    const TimeEntry = require("../models/TimeEntry");
    const Project = require("../models/Project");
    const { rateOf, billedState } = require("../routes/projects");
    const [entries, projects] = await Promise.all([TimeEntry.find({ organization: req.org, timerStartedAt: null, billable: true }).lean(), Project.find({ organization: req.org }).lean()]);
    const isBilled = await billedState(req.org, entries);
    const map = {};
    for (const e of entries.filter((e) => !isBilled(e))) {
      const p = projects.find((x) => String(x._id) === String(e.project));
      if (!p || p.billingMethod === "fixed") continue;
      const k = String(p._id);
      map[k] = map[k] || { customer: p.customerName, project: p.name, href: `/projects/${p._id}`, oldest: e.date, entries: 0, hours: 0, amount: 0 };
      map[k].entries += 1;
      map[k].hours = round2(map[k].hours + e.minutes / 60);
      map[k].amount = round2(map[k].amount + (e.minutes / 60) * rateOf(p, e));
      if (new Date(e.date) < new Date(map[k].oldest)) map[k].oldest = e.date;
    }
    return {
      kind: "table",
      groupBy: "customer",
      columns: [col("project", "Project", "text", { link: "href" }), col("oldest", "Oldest Entry", "date"), col("entries", "Entries", "number", { sum: true }), col("hours", "Unbilled Hours", "number", { sum: true }), col("amount", "Unbilled Amount", "money", { sum: true })],
      rows: Object.values(map).sort((a, b) => a.customer.localeCompare(b.customer)),
    };
  },

  /* ---------- Recurring ---------- */
  "recurring-profiles": async (req) => {
    const RP = require("../models/RecurringProfile");
    const ps = await RP.find({ organization: req.org }, { history: 0 }).sort({ kind: 1, name: 1 }).lean();
    const unit = { day: "Day", week: "Week", month: "Month", year: "Year" };
    const perYear = { day: 365, week: 52, month: 12, year: 1 };
    const rows = ps.map((p) => ({
      kind: { invoice: "Recurring Invoices", bill: "Recurring Bills", expense: "Recurring Expenses" }[p.kind],
      name: p.name,
      href: `/recurring-${p.kind}s/${p._id}`,
      party: p.partyName,
      freq: p.every === 1 ? `Every ${unit[p.unit].toLowerCase()}` : `Every ${p.every} ${unit[p.unit].toLowerCase()}s`,
      start: p.startDate,
      end: p.endDate,
      next: p.status === "active" ? p.nextDate : null,
      count: p.occurrences,
      status: { active: "Active", stopped: "Stopped", expired: "Expired" }[p.status],
      amount: p.amount,
      yearly: p.status === "active" ? round2((p.amount * perYear[p.unit]) / p.every) : 0,
    }));
    return {
      kind: "table",
      groupBy: "kind",
      columns: [
        col("name", "Profile", "text", { link: "href" }),
        col("party", "Customer / Vendor"),
        col("freq", "Frequency"),
        col("start", "Start", "date"),
        col("end", "End", "date"),
        col("next", "Next Date", "date"),
        col("count", "Created", "number", { sum: true }),
        col("status", "Status"),
        col("amount", "Amount", "money", { sum: true }),
        col("yearly", "Yearly Value (active)", "money", { sum: true }),
      ],
      rows,
    };
  },

  /* ---------- Activity ---------- */
  "email-log": async (req, q) => {
    const { from, to } = parseRange(q);
    const EmailLog = require("../models/EmailLog");
    const { DOCS } = require("./documents");
    const logs = await EmailLog.find({ organization: req.org, createdAt: inRangeQ(from, to) }).sort({ createdAt: -1 }).lean();
    const ROUTES = { invoice: "invoices", quote: "quotes", salesOrder: "sales-orders", creditNote: "credit-notes", purchaseOrder: "purchase-orders", vendorCredit: "vendor-credits", payment: "payments", vendorPayment: "payments-made" };
    return {
      kind: "table",
      columns: [col("date", "Sent On", "date"), col("doc", "Document", "text", { link: "href" }), col("type", "Type"), col("to", "To"), col("subject", "Subject"), col("by", "Sent By")],
      rows: logs.map((l) => ({
        date: l.createdAt,
        doc: DOCS[l.kind]?.label || l.kind,
        href: ROUTES[l.kind] ? `/${ROUTES[l.kind]}/${l.docId}` : undefined,
        type: l.type === "reminder" ? (l.reminderDay !== undefined && l.reminderDay !== null ? `Reminder (+${l.reminderDay} days)` : "Reminder") : l.type === "receipt" ? "Receipt" : "Document",
        to: [...(l.to || []), ...(l.cc || []).map((c) => `cc ${c}`)].join(", "),
        subject: l.subject,
        by: l.sentBy,
      })),
    };
  },
});

Object.assign(REPORTS, {
  "fixed-asset-register": async (req, q) => {
    const to = asOfDate(q);
    const FixedAsset = require("../models/FixedAsset");
    const { position } = require("./assets");
    const assets = await FixedAsset.find({ organization: req.org, acquisitionDate: { $lte: to } }).sort({ assetType: 1, acquisitionDate: 1 }).lean();
    const rows = assets.map((a) => {
      const gone = a.status === "disposed" && new Date(a.disposal.date) <= to;
      const pos = position(a, to);
      return {
        type: a.assetType || "Other",
        number: a.number,
        href: `/fixed-assets/${a._id}`,
        name: a.name,
        date: a.acquisitionDate,
        method: a.method === "slm" ? `SLM ${a.usefulLifeYears} yrs` : a.method === "wdv" ? `WDV ${a.rate}%` : "None",
        cost: gone ? 0 : a.cost,
        accumulated: gone ? 0 : pos.accumulated,
        book: gone ? 0 : pos.bookValue,
        status: gone ? `Disposed ${new Date(a.disposal.date).toISOString().slice(0, 10)}` : "Active",
      };
    });
    return {
      kind: "table",
      groupBy: "type",
      note: "Disposed assets are listed with zero balances. Totals match Fixed Assets less Accumulated Depreciation on the balance sheet.",
      columns: [col("number", "Asset#", "text", { link: "href" }), col("name", "Asset"), col("date", "Purchased", "date"), col("method", "Method"), col("cost", "Cost", "money", { sum: true }), col("accumulated", "Accumulated Depreciation", "money", { sum: true }), col("book", "Net Book Value", "money", { sum: true }), col("status", "Status")],
      rows,
    };
  },

  "depreciation-schedule": async (req, q) => {
    const { from, to: asked } = parseRange(q);
    const to = new Date(Math.min(asked.getTime(), require("./time").istEndOfToday().getTime()));
    const FixedAsset = require("../models/FixedAsset");
    const { schedule, position } = require("./assets");
    const assets = await FixedAsset.find({ organization: req.org, acquisitionDate: { $lte: to } }).sort({ acquisitionDate: 1 }).lean();
    const rows = assets
      .map((a) => {
        const opening = position(a, new Date(from.getTime() - 1));
        const charged = schedule(a, to).filter((d) => d.date >= from);
        const closing = position(a, to);
        return { name: a.name, number: a.number, href: `/fixed-assets/${a._id}`, type: a.assetType || "Other", cost: a.cost, openingBook: new Date(a.acquisitionDate) < from ? opening.bookValue : 0, additions: new Date(a.acquisitionDate) >= from ? a.cost : 0, depreciation: round2(charged.reduce((s, d) => s + d.amount, 0)), closingBook: a.status === "disposed" && new Date(a.disposal.date) <= to ? 0 : closing.bookValue, disposed: a.status === "disposed" && new Date(a.disposal.date) >= from && new Date(a.disposal.date) <= to ? closing.bookValue : 0 };
      })
      .filter((r) => r.openingBook || r.additions || r.depreciation || r.closingBook);
    return {
      kind: "table",
      groupBy: "type",
      note: "Opening book value + additions − depreciation − disposals = closing book value. Depreciation is charged up to today.",
      columns: [col("number", "Asset#", "text", { link: "href" }), col("name", "Asset"), col("openingBook", "Opening WDV", "money", { sum: true }), col("additions", "Additions", "money", { sum: true }), col("depreciation", "Depreciation", "money", { sum: true }), col("disposed", "Disposals", "money", { sum: true }), col("closingBook", "Closing WDV", "money", { sum: true })],
      rows,
    };
  },
});

Object.assign(REPORTS, {
  "warehouse-stock": async (req, q) => {
    const to = asOfDate(q);
    const { loadStock } = require("./inventory");
    const Warehouse = require("../models/Warehouse");
    const [stock, items, whs] = await Promise.all([loadStock(req.org, { to }), tracked(req.org), Warehouse.find({ organization: req.org }).sort({ primary: -1, name: 1 }).lean()]);
    const prim = whs.find((w) => w.primary);
    const rows = [];
    for (const w of whs.length ? whs : [{ _id: "primary", name: "All stock" }])
      for (const it of items) {
        const st = stock.items[String(it._id)];
        const qty = st?.byWarehouse?.[String(w._id)] ?? (w._id === "primary" ? st?.qty : 0) ?? 0;
        if (qty) rows.push({ warehouse: `${w.name}${w.primary ? " (primary)" : ""}`, name: it.name, href: itemHref(it._id), sku: it.sku, qty, value: round2(qty * (st?.avgCost || 0)) });
      }
    return {
      kind: "table",
      groupBy: "warehouse",
      note: prim ? "Value uses each item's average FIFO cost." : "Add warehouses in Branches & Warehouses to see stock by location.",
      columns: [col("name", "Item", "text", { link: "href" }), col("sku", "SKU"), col("qty", "Stock on Hand", "number", { sum: true }), col("value", "Value (avg cost)", "money", { sum: true })],
      rows,
    };
  },
});

module.exports = { REPORTS };
