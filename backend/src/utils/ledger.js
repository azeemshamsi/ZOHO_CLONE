/**
 * Double-entry ledger, derived from the documents on every request.
 * Nothing is stored twice, so the books can never drift out of sync with
 * invoices, bills, payments and expenses.
 */
const Account = require("../models/Account");
const { ACCOUNT_TYPES } = require("../models/Account");
const { EXPENSE_CATEGORIES } = require("../models/Expense");
const { round2 } = require("./http");

const expCode = (name) => `exp:${name}`;

// Built-in accounts every organization has.
const SYSTEM_ACCOUNTS = [
  { code: "cash", name: "Cash in Hand", group: "Cash" },
  { code: "bank", name: "Bank Account", group: "Bank" },
  { code: "ar", name: "Accounts Receivable", group: "Accounts Receivable" },
  { code: "input_cgst", name: "Input CGST", group: "Other Current Asset" },
  { code: "input_sgst", name: "Input SGST", group: "Other Current Asset" },
  { code: "input_igst", name: "Input IGST", group: "Other Current Asset" },
  { code: "ap", name: "Accounts Payable", group: "Accounts Payable" },
  { code: "output_cgst", name: "Output CGST", group: "Other Current Liability" },
  { code: "output_sgst", name: "Output SGST", group: "Other Current Liability" },
  { code: "output_igst", name: "Output IGST", group: "Other Current Liability" },
  { code: "owners_equity", name: "Owner's Equity", group: "Equity" },
  { code: "opening_equity", name: "Opening Balance Equity", group: "Equity" },
  { code: "drawings", name: "Drawings", group: "Equity" },
  { code: "sales", name: "Sales", group: "Income" },
  { code: "shipping_income", name: "Shipping Charge", group: "Income" },
  { code: "other_income", name: "Other Income", group: "Other Income" },
  { code: "adjustments", name: "Rounding & Adjustments", group: "Other Expense" },
  { code: "cogs", name: "Cost of Goods Sold", group: "Cost Of Goods Sold" },
  ...EXPENSE_CATEGORIES.map((n) => ({ code: expCode(n), name: n, group: n === "Raw Materials" ? "Cost Of Goods Sold" : "Expense" })),
].map((a) => ({ ...a, system: true, type: GROUP_TYPE(a.group) }));

function GROUP_TYPE(group) {
  if (group === "Accounts Receivable") return "asset";
  if (group === "Accounts Payable") return "liability";
  return ACCOUNT_TYPES[group];
}

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const debitNormal = (type) => type === "asset" || type === "expense";

async function chartOfAccounts(org) {
  const custom = await Account.find({ organization: org }).sort({ name: 1 }).lean();
  return [
    ...SYSTEM_ACCOUNTS,
    ...custom.map((a) => ({
      code: String(a._id),
      name: a.name,
      group: a.group,
      type: GROUP_TYPE(a.group),
      accountCode: a.accountCode,
      description: a.description,
      active: a.active,
      system: false,
    })),
  ];
}

const modeAccount = (mode) => (mode === "cash" ? "cash" : "bank");

// Build a list of balanced entries for everything up to `to`.
async function buildEntries(org, { to } = {}) {
  const Invoice = require("../models/Invoice");
  const Payment = require("../models/Payment");
  const CreditNote = require("../models/CreditNote");
  const Bill = require("../models/Bill");
  const VendorPayment = require("../models/VendorPayment");
  const Expense = require("../models/Expense");
  const Journal = require("../models/Journal");

  const live = { organization: org, status: { $nin: ["draft", "void"] } };
  const all = { organization: org };
  const [invoices, payments, cns, bills, vps, expenses, journals] = await Promise.all([
    Invoice.find(live).lean(),
    Payment.find(all).lean(),
    CreditNote.find(live).lean(),
    Bill.find(live).lean(),
    VendorPayment.find(all).lean(),
    Expense.find(all).lean(),
    Journal.find(all).lean(),
  ]);

  const entries = [];
  const add = (meta) => {
    const lines = [];
    const dr = (account, amt) => {
      amt = round2(amt || 0);
      if (amt > 0) lines.push({ account, debit: amt, credit: 0 });
      else if (amt < 0) lines.push({ account, debit: 0, credit: -amt });
    };
    const cr = (account, amt) => dr(account, -(amt || 0));
    meta.build(dr, cr);
    if (lines.length) entries.push({ date: meta.date, type: meta.type, id: meta.id, number: meta.number, party: meta.party || "", lines });
  };

  for (const i of invoices) {
    add({
      date: i.date, type: "Invoice", id: i._id, number: i.invoiceNumber, party: i.customerName,
      build: (dr, cr) => {
        dr("ar", i.total);
        cr("sales", i.subTotal);
        cr("output_cgst", i.cgst);
        cr("output_sgst", i.sgst);
        cr("output_igst", i.igst);
        cr("shipping_income", i.shippingCharge);
        dr("adjustments", -(i.adjustment || 0));
      },
    });
  }
  for (const p of payments) {
    add({
      date: p.date, type: "Customer Payment", id: p._id, number: p.paymentNumber, party: p.customerName,
      build: (dr, cr) => {
        dr(modeAccount(p.mode), p.amount);
        cr("ar", p.amount);
      },
    });
  }
  for (const c of cns) {
    add({
      date: c.date, type: "Credit Note", id: c._id, number: c.number, party: c.customerName,
      build: (dr, cr) => {
        dr("sales", c.subTotal);
        dr("output_cgst", c.cgst);
        dr("output_sgst", c.sgst);
        dr("output_igst", c.igst);
        dr("shipping_income", c.shippingCharge);
        cr("adjustments", -(c.adjustment || 0));
        cr("ar", c.total);
      },
    });
    for (const r of c.refunds || []) {
      add({
        date: r.date, type: "Credit Note Refund", id: c._id, number: c.number, party: c.customerName,
        build: (dr, cr) => {
          dr("ar", r.amount);
          cr(modeAccount(r.mode), r.amount);
        },
      });
    }
  }
  for (const b of bills) {
    add({
      date: b.date, type: "Bill", id: b._id, number: b.billNumber, party: b.vendorName,
      build: (dr, cr) => {
        dr("cogs", b.subTotal + (b.shippingCharge || 0));
        dr("input_cgst", b.cgst);
        dr("input_sgst", b.sgst);
        dr("input_igst", b.igst);
        dr("adjustments", b.adjustment || 0);
        cr("ap", b.total);
      },
    });
  }
  for (const v of vps) {
    add({
      date: v.date, type: "Vendor Payment", id: v._id, number: v.paymentNumber, party: v.vendorName,
      build: (dr, cr) => {
        dr("ap", v.amount);
        cr(modeAccount(v.mode), v.amount);
      },
    });
  }
  for (const e of expenses) {
    add({
      date: e.date, type: "Expense", id: e._id, number: e.reference || e.category, party: e.vendorName,
      build: (dr, cr) => {
        dr(e.account || expCode(e.category), e.amount);
        dr("input_cgst", e.cgst);
        dr("input_sgst", e.sgst);
        dr("input_igst", e.igst);
        cr(modeAccount(e.paidThrough), e.total);
      },
    });
  }
  for (const j of journals) {
    add({
      date: j.date, type: "Journal", id: j._id, number: j.number, party: j.reference,
      build: (dr, cr) => {
        for (const l of j.lines) {
          dr(l.account, l.debit);
          cr(l.account, l.credit);
        }
      },
    });
  }

  const end = to ? new Date(to) : null;
  return entries
    .filter((e) => !end || new Date(e.date) <= end)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Net movement per account (debit - credit) for entries within [from, to].
function movements(entries, { from, to } = {}) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  const m = {};
  for (const e of entries) {
    const d = new Date(e.date);
    if ((start && d < start) || (end && d > end)) continue;
    for (const l of e.lines) {
      m[l.account] = m[l.account] || { debit: 0, credit: 0 };
      m[l.account].debit += l.debit;
      m[l.account].credit += l.credit;
    }
  }
  for (const k of Object.keys(m)) {
    m[k].debit = round2(m[k].debit);
    m[k].credit = round2(m[k].credit);
  }
  return m;
}

// Balance shown the "normal" way: assets/expenses as debit-positive, others credit-positive.
function naturalBalance(acc, mv) {
  if (!mv) return 0;
  return round2(debitNormal(acc.type) ? mv.debit - mv.credit : mv.credit - mv.debit);
}

// Indian financial year (1 April – 31 March) containing date d.
function fiscalYear(d = new Date()) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { from: new Date(Date.UTC(y, 3, 1)), to: new Date(Date.UTC(y + 1, 2, 31, 23, 59, 59, 999)) };
}

// Parse "YYYY-MM-DD" query dates: from = start of day, to = end of day (UTC).
function parseRange(q, { defaultFy = true } = {}) {
  const fy = fiscalYear();
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : defaultFy ? fy.from : null;
  const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : defaultFy ? fy.to : new Date();
  if ((from && isNaN(from)) || isNaN(to)) {
    const { HttpError } = require("./http");
    throw new HttpError(400, "Invalid date");
  }
  return { from, to };
}

module.exports = {
  SYSTEM_ACCOUNTS,
  TYPE_ORDER,
  chartOfAccounts,
  buildEntries,
  movements,
  naturalBalance,
  debitNormal,
  fiscalYear,
  parseRange,
  expCode,
  GROUP_TYPE,
};
