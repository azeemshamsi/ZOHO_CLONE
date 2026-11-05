/**
 * Cash sales imported from Tally come in as journals (Dr Cash, Cr Sales ledger, Cr GST): Tally's party was the Cash
 * ledger, not a customer. When the customer becomes known, the journal is turned into what it really was:
 *   an invoice to the customer (same number, date, ledger and GST) + a payment received in cash for the full amount.
 * Together they post exactly what the journal posted (Cash up, Sales and GST up, the customer at nil), so the
 * trial balance doesn't move. That is checked before the journal is removed; any difference undoes the change.
 */
const Journal = require("../models/Journal");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Customer = require("../models/Customer");
const Organization = require("../models/Organization");
const { chartOfAccounts, buildEntries } = require("./ledger");
const { round2 } = require("./http");

const RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const TAX = { output_cgst: "cgst", output_sgst: "sgst", output_igst: "igst" };
// GST ledgers imported from Tally keep their own names ("CGST 2.5%", "Output IGST 18%"): recognise them by name.
const taxTypeOf = (a) => {
  if (TAX[a.code]) return TAX[a.code];
  const n = a.name.toLowerCase();
  if (/cess|input|itc|\brcm\b|reverse/.test(n)) return null;
  return /igst/.test(n) ? "igst" : /cgst/.test(n) ? "cgst" : /sgst|utgst/.test(n) ? "sgst" : null;
};

// What the journal is: a cash sale we can turn into an invoice, or why not.
async function analyse(org, journal) {
  const accounts = await chartOfAccounts(org);
  const acc = new Map(accounts.map((a) => [a.code, a]));
  const net = new Map(); // account → credit − debit
  for (const l of journal.lines) net.set(l.account, round2((net.get(l.account) || 0) + (l.credit || 0) - (l.debit || 0)));
  const cash = [];
  const income = [];
  const tax = { cgst: 0, sgst: 0, igst: 0 };
  const taxAcc = { cgst: new Set(), sgst: new Set(), igst: new Set() };
  const other = [];
  for (const [code, amt] of net) {
    if (!amt) continue;
    const a = acc.get(code);
    if (!a) return { ok: false, reason: `Account ${code} isn't in the chart of accounts` };
    if (journal.lines.some((l) => l.account === code && (l.customer || l.vendor))) return { ok: false, reason: "It already names a customer or vendor" };
    if (["Cash", "Bank"].includes(a.group) && amt < 0) cash.push({ code, name: a.name, amount: -amt });
    else if (["Income", "Other Income"].includes(a.group) && amt > 0) income.push({ code, name: a.name, amount: amt });
    else if (taxTypeOf(a) && amt > 0) {
      const t = taxTypeOf(a);
      tax[t] = round2(tax[t] + amt);
      taxAcc[t].add(code);
    }
    else other.push({ code, name: a.name, amount: amt }); // round-off etc.: credit positive
  }
  if (cash.length !== 1) return { ok: false, reason: cash.length ? "It debits more than one cash / bank account" : "It isn't received in cash or bank (no cash / bank debit)" };
  if (!income.length) return { ok: false, reason: "It has no sales ledger" };
  if (other.length > 1) return { ok: false, reason: `It has more than one other account (${other.map((o) => o.name).join(", ")})` };
  if (Math.abs(tax.cgst - tax.sgst) > 0.02) return { ok: false, reason: "CGST and SGST differ" };
  for (const t of ["cgst", "sgst", "igst"]) if (taxAcc[t].size > 1) return { ok: false, reason: `Its ${t.toUpperCase()} is split over more than one ledger` };
  const taxAccounts = Object.fromEntries(["cgst", "sgst", "igst"].map((t) => [t, [...taxAcc[t]][0] || ""]).map(([t, c]) => [t, TAX[c] ? "" : c]));
  const taxable = round2(income.reduce((t, l) => t + l.amount, 0));
  const totalTax = round2(tax.cgst + tax.sgst + tax.igst);
  // GST rate per line: one rate for all when it fits, else the rate in each ledger's name ("… @ 18% …").
  const snap = (r) => RATES.find((x) => Math.abs(x - r) < 0.06);
  let lines;
  const one = snap(taxable ? (totalTax / taxable) * 100 : 0);
  if (one !== undefined) lines = income.map((l) => ({ ...l, rate: one }));
  else {
    lines = income.map((l) => ({ ...l, rate: Number((l.name.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1]) }));
    if (lines.some((l) => !RATES.includes(l.rate))) return { ok: false, reason: "The GST rate of each sales ledger can't be worked out" };
  }
  const { voucherNo } = require("../models/Counter");
  return { ok: true, number: voucherNo(journal.number), cash: cash[0], lines, tax, taxAccounts, interState: tax.igst > 0, other: other[0] || null, total: cash[0].amount };
}

// ctx: { org, user }. Returns { invoice, payment }.
async function convert(ctx, journalId, customerId, { placeOfSupply } = {}) {
  const call = require("./import/commit").call;
  const journal = await Journal.findOne({ _id: journalId, organization: ctx.org });
  if (!journal) throw new Error("Journal not found");
  const customer = await Customer.findOne({ _id: customerId, organization: ctx.org });
  if (!customer) throw new Error("Choose a customer");
  const a = await analyse(ctx.org, journal);
  if (!a.ok) throw new Error(`This journal can't be turned into an invoice: ${a.reason}`);
  if (await Invoice.exists({ organization: ctx.org, invoiceNumber: a.number })) throw new Error(`An invoice ${a.number} already exists`);
  const org = await Organization.findById(ctx.org);
  let pos = org.state;
  if (a.interState) {
    pos = placeOfSupply || customer.placeOfSupply || customer.billingAddress?.state || "";
    if (!pos || pos === org.state) throw new Error("This sale was charged IGST (another state): choose the customer's state (place of supply)");
  }
  const iso = new Date(journal.date).toISOString().slice(0, 10);
  const singleLedger = new Set(a.lines.map((l) => l.code)).size === 1 ? a.lines[0].code : "";
  const body = {
    customer: String(customer._id),
    date: iso,
    dueDate: iso,
    placeOfSupply: pos,
    invoiceNumber: a.number,
    lineItems: a.lines.map((l) => ({ name: l.name, description: journal.notes || "", quantity: 1, rate: l.amount, taxRate: l.rate, account: l.code === "sales" ? "" : l.code })),
    ...(singleLedger && singleLedger !== "sales" ? { ledger: singleLedger } : {}),
    adjustment: a.other ? a.other.amount : 0,
    ...(a.other && a.other.code !== "adjustments" ? { adjustmentAccount: a.other.code } : {}),
    customerNotes: journal.notes || "",
    status: "sent",
  };
  let invoice;
  let payment;
  try {
    invoice = await call(require("../routes/invoices"), "POST", "/", ctx, body);
    if (Math.abs(invoice.total - a.total) > 0.005) throw new Error(`The invoice comes to ₹${invoice.total}, the cash sale was ₹${a.total}`);
    // GST to the same ledgers the journal used (e.g. Tally's "CGST 2.5%"), not the built-in Output CGST.
    if (a.taxAccounts.cgst || a.taxAccounts.sgst || a.taxAccounts.igst) await Invoice.updateOne({ _id: invoice._id }, { $set: { taxAccounts: a.taxAccounts } });
    payment = await call(require("../routes/payments"), "POST", "/", ctx, {
      customer: String(customer._id),
      date: iso,
      amount: a.total,
      mode: a.cash.code === "cash" || /cash/i.test(a.cash.name) ? "cash" : "bank_transfer",
      bankAccount: a.cash.code,
      reference: `Cash sale ${a.number}`,
      allocations: [{ invoice: String(invoice._id), amount: a.total }],
    });
    // The two must post exactly what the journal posted.
    const want = new Map();
    for (const l of journal.lines) want.set(l.account, round2((want.get(l.account) || 0) + (l.debit || 0) - (l.credit || 0)));
    const got = new Map();
    const ids = new Set([String(invoice._id), String(payment._id)]);
    for (const e of await buildEntries(ctx.org, {})) {
      if (!ids.has(String(e.id))) continue;
      for (const l of e.lines) got.set(l.account, round2((got.get(l.account) || 0) + (l.debit || 0) - (l.credit || 0)));
    }
    const diffs = [];
    for (const code of new Set([...want.keys(), ...got.keys()])) {
      const d = round2((got.get(code) || 0) - (want.get(code) || 0));
      if (Math.abs(d) >= 0.01) diffs.push(`${code}: ${d > 0 ? "+" : ""}${d}`);
    }
    if (diffs.length) throw new Error(`It wouldn't post exactly like the journal (${diffs.join(", ")}), so nothing was changed`);
  } catch (e) {
    if (payment) await Payment.deleteOne({ _id: payment._id }).catch(() => {});
    if (invoice) await Invoice.deleteOne({ _id: invoice._id }).catch(() => {});
    throw e;
  }
  if (journal.importRef) await Invoice.updateOne({ _id: invoice._id }, { $set: { importRef: journal.importRef } }).catch(() => {});
  await Journal.deleteOne({ _id: journal._id });
  return { invoice, payment };
}

// Move an invoice (and the payments made only for it) to another customer. Amounts and accounts don't change,
// so the trial balance doesn't either; only whose name the sale is in.
async function changeCustomer(ctx, invoiceId, customerId) {
  const inv = await Invoice.findOne({ _id: invoiceId, organization: ctx.org });
  if (!inv) throw new Error("Invoice not found");
  const c = await Customer.findOne({ _id: customerId, organization: ctx.org });
  if (!c) throw new Error("Choose a customer");
  if (inv.einvoice?.status === "generated") throw new Error("This invoice has an e-invoice (IRN); cancel it first");
  const pays = await Payment.find({ organization: ctx.org, "allocations.invoice": inv._id });
  const shared = pays.filter((p) => p.allocations.some((x) => String(x.invoice) !== String(inv._id)) || (p.unusedAmount || 0) > 0);
  if (shared.length) throw new Error(`Payment ${shared[0].paymentNumber} also covers other invoices or has an unused amount; change it separately`);
  const CreditNote = require("../models/CreditNote");
  if (await CreditNote.exists({ organization: ctx.org, invoice: inv._id })) throw new Error("This invoice has a credit note; change the customer there first");
  const was = inv.customerName;
  inv.customer = c._id;
  inv.customerName = c.displayName;
  inv.customerGstin = c.gstin || "";
  if (c.billingAddress && (c.billingAddress.street || c.billingAddress.city)) inv.billingAddress = c.billingAddress;
  await inv.save();
  for (const p of pays) await Payment.updateOne({ _id: p._id }, { $set: { customer: c._id, customerName: c.displayName } });
  return { invoice: inv, payments: pays.length, was };
}

// Cash-sale journals with a number in the invoice series, for the Journals list / journal page.
const looksLikeCashSale = async (org, journal) => (await analyse(org, journal)).ok;

module.exports = { analyse, convert, changeCustomer, looksLikeCashSale };
