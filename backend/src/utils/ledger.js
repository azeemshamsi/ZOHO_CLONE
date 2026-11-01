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
  { code: "inventory", name: "Inventory Asset", group: "Other Current Asset" },
  { code: "input_cgst", name: "Input CGST", group: "Other Current Asset" },
  { code: "input_sgst", name: "Input SGST", group: "Other Current Asset" },
  { code: "input_igst", name: "Input IGST", group: "Other Current Asset" },
  { code: "fixed_assets", name: "Fixed Assets", group: "Fixed Asset" },
  { code: "acc_depreciation", name: "Accumulated Depreciation", group: "Fixed Asset" },
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
  { code: "depreciation", name: "Depreciation Expense", group: "Expense" },
  { code: "asset_disposal", name: "Loss / (Gain) on Asset Disposal", group: "Other Expense" },
  { code: "fx_gain_loss", name: "Exchange Loss / (Gain)", group: "Other Expense" },
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

// The cash/bank account money went through: the one picked, else by payment mode.
const modeAccount = (mode, bankAccount) => bankAccount || (mode === "cash" ? "cash" : "bank");

// Is `code` a Cash or Bank account of this organization?
async function isBankAccount(org, code) {
  if (!code) return true;
  return (await chartOfAccounts(org)).some((a) => a.code === code && ["Cash", "Bank"].includes(a.group));
}

// Build a list of balanced entries for everything up to `to`.
async function buildEntries(org, { to } = {}) {
  const Invoice = require("../models/Invoice");
  const Payment = require("../models/Payment");
  const CreditNote = require("../models/CreditNote");
  const Bill = require("../models/Bill");
  const VendorPayment = require("../models/VendorPayment");
  const Expense = require("../models/Expense");
  const Journal = require("../models/Journal");
  const VendorCredit = require("../models/VendorCredit");

  const live = { organization: org, status: { $nin: ["draft", "void"] } };
  const all = { organization: org };
  const Item = require("../models/Item");
  const InventoryAdjustment = require("../models/InventoryAdjustment");
  const FixedAsset = require("../models/FixedAsset");
  // Raw documents in their own currency; rates are applied below.
  const { raw } = require("../config/baseCurrency");
  const [invoices, payments, cns, bills, vps, expenses, journals, vcs, items, adjustments, assets] = await raw(() => Promise.all([
    Invoice.find(live).lean(),
    Payment.find(all).lean(),
    CreditNote.find(live).lean(),
    Bill.find(live).lean(),
    VendorPayment.find(all).lean(),
    Expense.find(all).lean(),
    Journal.find(all).lean(),
    VendorCredit.find(live).lean(),
    Item.find({ organization: org, trackInventory: true }).lean(),
    InventoryAdjustment.find({ organization: org, status: "adjusted" }).lean(),
    FixedAsset.find({ organization: org }).lean(),
  ]));
  // Inventory value change per document (see utils/inventory.js).
  const { docInv } = require("./inventory").computeStock({ items, invoices, creditNotes: cns, bills, vendorCredits: vcs, adjustments });
  const inv = (type, id) => docInv[`${type}|${id}`] || 0;

  const entries = [];
  // meta.rate converts a foreign-currency document to ₹. dr/cr take document amounts;
  // drB/crB take amounts already in ₹ (inventory values, exchange differences).
  const add = (meta) => {
    const lines = [];
    const rate = Number(meta.rate) || 1;
    const drB = (account, amt) => {
      amt = round2(amt || 0);
      if (amt > 0) lines.push({ account, debit: amt, credit: 0 });
      else if (amt < 0) lines.push({ account, debit: 0, credit: -amt });
    };
    const crB = (account, amt) => drB(account, -(amt || 0));
    const dr = (account, amt) => drB(account, (amt || 0) * rate);
    const cr = (account, amt) => dr(account, -(amt || 0));
    meta.build(dr, cr, drB, crB);
    // Converting each line separately can leave a paisa or two over: post it to rounding.
    const diff = round2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (diff && Math.abs(diff) < 1) crB("adjustments", diff);
    if (lines.length) entries.push({ date: meta.date, type: meta.type, id: meta.id, number: meta.number, party: meta.party || "", lines });
  };
  const rateOf = new Map([...invoices, ...bills].map((d) => [String(d._id), Number(d.exchangeRate) || 1]));

  for (const i of invoices) {
    add({
      date: i.date, type: "Invoice", id: i._id, number: i.invoiceNumber, party: i.customerName, rate: i.exchangeRate,
      build: (dr, cr, drB) => {
        dr("ar", i.total);
        cr("sales", i.subTotal);
        cr("output_cgst", i.cgst);
        cr("output_sgst", i.sgst);
        cr("output_igst", i.igst);
        cr("shipping_income", i.shippingCharge);
        dr("adjustments", -(i.adjustment || 0));
        drB("cogs", -inv("Invoice", i._id));
        drB("inventory", inv("Invoice", i._id));
      },
    });
  }
  for (const p of payments) {
    add({
      date: p.date, type: "Customer Payment", id: p._id, number: p.paymentNumber, party: p.customerName,
      build: (dr, cr, drB, crB) => {
        const r = Number(p.exchangeRate) || 1;
        const received = round2(p.amount * r);
        // Receivables are cleared at each invoice's own rate; the difference is exchange gain/loss.
        const cleared = round2(p.allocations.reduce((s, a) => s + round2(a.amount * (rateOf.get(String(a.invoice)) || r)), 0) + (p.unusedAmount || 0) * r);
        drB(modeAccount(p.mode, p.bankAccount), received);
        crB("ar", cleared);
        drB("fx_gain_loss", cleared - received);
      },
    });
  }
  for (const c of cns) {
    add({
      date: c.date, type: "Credit Note", id: c._id, number: c.number, party: c.customerName, rate: c.exchangeRate,
      build: (dr, cr, drB, crB) => {
        dr("sales", c.subTotal);
        dr("output_cgst", c.cgst);
        dr("output_sgst", c.sgst);
        dr("output_igst", c.igst);
        dr("shipping_income", c.shippingCharge);
        cr("adjustments", -(c.adjustment || 0));
        cr("ar", c.total);
        drB("inventory", inv("Credit Note", c._id));
        crB("cogs", inv("Credit Note", c._id));
      },
    });
    for (const r of c.refunds || []) {
      add({
        date: r.date, type: "Credit Note Refund", id: c._id, number: c.number, party: c.customerName, rate: c.exchangeRate,
        build: (dr, cr) => {
          dr("ar", r.amount);
          cr(modeAccount(r.mode, r.bankAccount), r.amount);
        },
      });
    }
  }
  for (const b of bills) {
    add({
      date: b.date, type: "Bill", id: b._id, number: b.billNumber, party: b.vendorName, rate: b.exchangeRate,
      build: (dr, cr, drB) => {
        dr("cogs", b.subTotal + (b.shippingCharge || 0));
        drB("cogs", -inv("Bill", b._id));
        drB("inventory", inv("Bill", b._id));
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
      build: (dr, cr, drB, crB) => {
        const r = Number(v.exchangeRate) || 1;
        const paid = round2(v.amount * r);
        const cleared = round2(v.allocations.reduce((s, a) => s + round2(a.amount * (rateOf.get(String(a.bill)) || r)), 0) + (v.unusedAmount || 0) * r);
        drB("ap", cleared);
        crB(modeAccount(v.mode, v.bankAccount), paid);
        drB("fx_gain_loss", paid - cleared);
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
        cr(modeAccount(e.paidThrough, e.bankAccount), e.total);
      },
    });
  }
  for (const c of vcs) {
    add({
      date: c.date, type: "Vendor Credit", id: c._id, number: c.number, party: c.vendorName, rate: c.exchangeRate,
      build: (dr, cr, drB, crB) => {
        dr("ap", c.total);
        cr("cogs", c.subTotal + (c.shippingCharge || 0));
        crB("cogs", inv("Vendor Credit", c._id));
        drB("inventory", inv("Vendor Credit", c._id));
        cr("input_cgst", c.cgst);
        cr("input_sgst", c.sgst);
        cr("input_igst", c.igst);
        cr("adjustments", c.adjustment || 0);
      },
    });
    for (const r of c.refunds || []) {
      add({
        date: r.date, type: "Vendor Credit Refund", id: c._id, number: c.number, party: c.vendorName, rate: c.exchangeRate,
        build: (dr, cr) => {
          dr(modeAccount(r.mode, r.bankAccount), r.amount);
          cr("ap", r.amount);
        },
      });
    }
  }
  for (const it of items) {
    const v = inv("Opening Stock", it._id);
    if (v)
      add({
        date: it.openingStockDate || it.createdAt, type: "Opening Stock", id: it._id, number: it.sku || "", party: it.name,
        build: (dr, cr) => {
          dr("inventory", v);
          cr("opening_equity", v);
        },
      });
  }
  for (const a of adjustments) {
    add({
      date: a.date, type: "Inventory Adjustment", id: a._id, number: a.reference || a.number, party: a.reason,
      build: (dr, cr) => {
        const v = inv("Inventory Adjustment", a._id);
        dr("inventory", v);
        cr(a.account || "cogs", v);
      },
    });
  }
  // Fixed assets: purchase, monthly depreciation (up to today), disposal.
  const today = require("./time").istEndOfToday();
  const depUntil = to && new Date(to) < today ? new Date(to) : today;
  const { schedule } = require("./assets");
  for (const fa of assets) {
    if (fa.paidFrom)
      add({
        date: fa.acquisitionDate, type: "Fixed Asset", id: fa._id, number: fa.number, party: fa.name,
        build: (dr, cr) => {
          dr(fa.account || "fixed_assets", fa.cost);
          cr(fa.paidFrom, fa.cost);
        },
      });
    const sch = schedule(fa, depUntil);
    for (const d of sch)
      add({
        date: d.date, type: "Depreciation", id: fa._id, number: fa.number, party: fa.name,
        build: (dr, cr) => {
          dr("depreciation", d.amount);
          cr("acc_depreciation", d.amount);
        },
      });
    if (fa.status === "disposed" && fa.disposal?.date) {
      const acc = sch.length ? sch[sch.length - 1].accumulated : 0;
      const proceeds = fa.disposal.kind === "sold" ? fa.disposal.amount || 0 : 0;
      add({
        date: fa.disposal.date, type: "Asset Disposal", id: fa._id, number: fa.number, party: fa.name,
        build: (dr, cr) => {
          if (proceeds) dr(fa.disposal.account || "bank", proceeds);
          dr("acc_depreciation", acc);
          cr(fa.account || "fixed_assets", fa.cost);
          dr("asset_disposal", fa.cost - acc - proceeds);
        },
      });
    }
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
function fiscalYear(d = require("./time").istToday()) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { from: new Date(Date.UTC(y, 3, 1)), to: new Date(Date.UTC(y + 1, 2, 31, 23, 59, 59, 999)) };
}

// Parse "YYYY-MM-DD" query dates: from = start of day, to = end of day (UTC).
function parseRange(q, { defaultFy = true } = {}) {
  const fy = fiscalYear();
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : defaultFy ? fy.from : null;
  const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : defaultFy ? fy.to : require("./time").istEndOfToday();
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
  isBankAccount,
  modeAccount,
};
