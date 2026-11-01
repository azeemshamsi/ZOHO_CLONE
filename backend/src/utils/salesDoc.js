const Joi = require("joi");
const Customer = require("../models/Customer");
const Organization = require("../models/Organization");
const { Counter, nextNumber } = require("../models/Counter");
const { computeTotals } = require("./gst");
const { HttpError, round2 } = require("./http");

const lineItemJoi = Joi.object({
  item: Joi.string().allow(null, ""),
  name: Joi.string().trim().min(1).required().label("Item name"),
  description: Joi.string().allow(""),
  hsnSac: Joi.string().allow(""),
  unit: Joi.string().allow(""),
  quantity: Joi.number().greater(0).required().label("Quantity"),
  rate: Joi.number().min(0).required().label("Rate"),
  discount: Joi.number().min(0).max(100),
  taxRate: Joi.number().min(0).max(100),
});

const addrJoi = Joi.object({ street: Joi.string().allow(""), city: Joi.string().allow(""), state: Joi.string().allow(""), pincode: Joi.string().allow(""), country: Joi.string().allow("") });

// Joi fields shared by every sales document form.
const baseDocJoi = {
  customer: Joi.string().required().label("Customer"),
  date: Joi.date().required().label("Date"),
  placeOfSupply: Joi.string().allow(""),
  lineItems: Joi.array().items(lineItemJoi).min(1).required().label("Items"),
  shippingCharge: Joi.number().min(0),
  adjustment: Joi.number(),
  customerNotes: Joi.string().allow(""),
  terms: Joi.string().allow(""),
  branch: Joi.string().allow(null, ""),
  warehouse: Joi.string().allow(null, ""),
  exchangeRate: Joi.number().greater(0),
  billingAddress: addrJoi,
  shipTo: addrJoi.keys({ name: Joi.string().allow(""), phone: Joi.string().allow("") }),
};

// Currency of a party and the rate to use (₹ per unit): the one given, else the currency's current rate.
async function currencyFor(req, party, rate) {
  const code = (party && party.currency) || "INR";
  if (code === "INR") return { currency: "INR", exchangeRate: 1 };
  if (rate) return { currency: code, exchangeRate: Number(rate) };
  const c = await require("../models/Currency").findOne({ organization: req.org, code });
  if (!c) throw new HttpError(400, `Add ${code} with an exchange rate in Settings → Currencies first`);
  return { currency: code, exchangeRate: c.rate };
}

// [counter key, prefix] for a document: a branch with its own prefix gets its own series.
async function branchSeries(key, prefix, branchId) {
  if (!branchId) return [key, prefix];
  const b = await require("../models/Branch").findById(branchId).lean();
  const p = b?.prefixes?.[key];
  return p ? [`${key}:${branchId}`, p] : [key, prefix];
}

// Check the branch / warehouse ids on a document belong to this organization.
async function resolveLocation(req, data) {
  let branch = null;
  let warehouse = null;
  if (data.branch) {
    branch = await require("../models/Branch").findOne({ _id: data.branch, organization: req.org });
    if (!branch) throw new HttpError(400, "Choose a valid branch");
  }
  if (data.warehouse) {
    warehouse = await require("../models/Warehouse").findOne({ _id: data.warehouse, organization: req.org });
    if (!warehouse) throw new HttpError(400, "Choose a valid warehouse");
  }
  return { branch, warehouse };
}

// Look up the customer (or vendor) + org, work out GST and totals.
const hasAddr = (a) => Boolean(a && (a.street || a.city || a.pincode));
function shipToFor(given, customer) {
  if (hasAddr(given)) return { name: given.name || customer.displayName, phone: given.phone || "", street: given.street || "", city: given.city || "", state: given.state || "", pincode: given.pincode || "", country: given.country || "India" };
  const a = hasAddr(customer.shippingAddress) ? customer.shippingAddress : customer.billingAddress || {};
  return { name: customer.displayName, phone: customer.phone || "", street: a.street || "", city: a.city || "", state: a.state || "", pincode: a.pincode || "", country: a.country || "India" };
}

async function prepareDoc(req, data, party = "customer") {
  const Party = party === "vendor" ? require("../models/Vendor") : Customer;
  const [customer, org] = await Promise.all([
    Party.findOne({ _id: data[party], organization: req.org }),
    Organization.findById(req.org),
  ]);
  if (!customer) throw new HttpError(400, `Choose a valid ${party}`);
  const { branch, warehouse } = await resolveLocation(req, data);
  const homeState = branch?.state || org.state; // GST is worked out from the branch's state
  const placeOfSupply = data.placeOfSupply || customer.placeOfSupply || homeState;
  const totals = computeTotals({
    lineItems: data.lineItems.map((l) => ({ ...l, item: l.item || undefined })),
    orgState: homeState,
    placeOfSupply,
    shippingCharge: data.shippingCharge,
    adjustment: data.adjustment,
  });
  return {
    org,
    customer,
    fields: {
      ...data,
      ...totals,
      branch: branch ? branch._id : null,
      warehouse: warehouse ? warehouse._id : null,
      ...(await currencyFor(req, customer, data.exchangeRate)),
      placeOfSupply,
      [`${party}Name`]: customer.displayName,
      [`${party}Gstin`]: customer.gstin,
      // Bill To / Ship To: as given on the document, else the customer's addresses.
      billingAddress: hasAddr(data.billingAddress) ? data.billingAddress : customer.billingAddress,
      ...(party === "customer" ? { shipTo: shipToFor(data.shipTo, customer) } : {}),
    },
  };
}

// The next number without using it up (for showing in the form).
async function peekNumber(org, key, prefix) {
  const c = await Counter.findOne({ organization: org, key });
  return `${prefix}${String((c ? c.seq : 0) + 1).padStart(6, "0")}`;
}

// Bring an invoice's balance and status in line with payments and credits.
function settleInvoice(inv) {
  inv.amountPaid = round2(inv.amountPaid || 0);
  inv.creditsApplied = round2(inv.creditsApplied || 0);
  const received = round2(inv.amountPaid + inv.creditsApplied);
  inv.balance = round2(Math.max(inv.total - received, 0));
  if (inv.status === "void") {
    inv.balance = 0;
    return inv;
  }
  if (received > 0 && inv.balance === 0) inv.status = "paid";
  else if (received > 0) inv.status = "partially_paid";
  else if (inv.status !== "draft") inv.status = "sent";
  return inv;
}

// Fields copied when converting one document into another.
function copyContent(src) {
  return {
    organization: src.organization,
    customer: src.customer,
    customerName: src.customerName,
    customerGstin: src.customerGstin,
    billingAddress: src.billingAddress,
    branch: src.branch,
    warehouse: src.warehouse,
    currency: src.currency || "INR",
    exchangeRate: src.exchangeRate || 1,
    placeOfSupply: src.placeOfSupply,
    isInterState: src.isInterState,
    lineItems: src.lineItems.map((l) => (l.toObject ? l.toObject() : l)),
    subTotal: src.subTotal,
    cgst: src.cgst,
    sgst: src.sgst,
    igst: src.igst,
    taxTotal: src.taxTotal,
    shippingCharge: src.shippingCharge,
    adjustment: src.adjustment,
    total: src.total,
    customerNotes: src.customerNotes,
    terms: src.terms,
  };
}

// Create a draft invoice from a quote or sales order.
async function createInvoiceFrom(req, src, links, orderNumber) {
  const Invoice = require("../models/Invoice");
  const [org, customer] = await Promise.all([
    Organization.findById(req.org),
    Customer.findOne({ _id: src.customer, organization: req.org }),
  ]);
  const terms = customer ? customer.paymentTerms : org.defaultPaymentTerms;
  const date = require("./time").istToday();
  const dueDate = new Date(date);
  dueDate.setUTCDate(dueDate.getUTCDate() + Number(terms || 0));
  const invoice = new Invoice({
    ...copyContent(src),
    ...links,
    invoiceNumber: await nextNumber(req.org, ...(await branchSeries("invoice", org.invoicePrefix || "INV-", src.branch))),
    orderNumber: orderNumber || src.reference || src.number || "",
    date,
    dueDate,
    paymentTerms: terms,
    status: "draft",
  });
  settleInvoice(invoice);
  await invoice.save();
  return invoice;
}

// Same as settleInvoice, for bills (unpaid bills are "open").
function settleBill(bill) {
  bill.amountPaid = round2(bill.amountPaid || 0);
  bill.creditsApplied = round2(bill.creditsApplied || 0);
  const settled = round2(bill.amountPaid + bill.creditsApplied);
  bill.balance = round2(Math.max(bill.total - settled, 0));
  if (bill.status === "void") {
    bill.balance = 0;
    return bill;
  }
  if (settled > 0 && bill.balance === 0) bill.status = "paid";
  else if (settled > 0) bill.status = "partially_paid";
  else if (bill.status !== "draft") bill.status = "open";
  return bill;
}

const escapeRx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

module.exports = {
  lineItemJoi,
  baseDocJoi,
  resolveLocation,
  branchSeries,
  currencyFor,
  prepareDoc,
  peekNumber,
  settleInvoice,
  settleBill,
  copyContent,
  createInvoiceFrom,
  escapeRx,
  nextNumber,
};
