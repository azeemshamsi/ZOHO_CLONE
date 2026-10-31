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
};

// Look up the customer (or vendor) + org, work out GST and totals.
async function prepareDoc(req, data, party = "customer") {
  const Party = party === "vendor" ? require("../models/Vendor") : Customer;
  const [customer, org] = await Promise.all([
    Party.findOne({ _id: data[party], organization: req.org }),
    Organization.findById(req.org),
  ]);
  if (!customer) throw new HttpError(400, `Choose a valid ${party}`);
  const placeOfSupply = data.placeOfSupply || customer.placeOfSupply || org.state;
  const totals = computeTotals({
    lineItems: data.lineItems.map((l) => ({ ...l, item: l.item || undefined })),
    orgState: org.state,
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
      placeOfSupply,
      [`${party}Name`]: customer.displayName,
      [`${party}Gstin`]: customer.gstin,
      billingAddress: customer.billingAddress,
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
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  const dueDate = new Date(date);
  dueDate.setDate(dueDate.getDate() + Number(terms || 0));
  const invoice = new Invoice({
    ...copyContent(src),
    ...links,
    invoiceNumber: await nextNumber(req.org, "invoice", org.invoicePrefix || "INV-"),
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
  bill.balance = round2(Math.max(bill.total - bill.amountPaid, 0));
  if (bill.status === "void") {
    bill.balance = 0;
    return bill;
  }
  if (bill.amountPaid > 0 && bill.balance === 0) bill.status = "paid";
  else if (bill.amountPaid > 0) bill.status = "partially_paid";
  else if (bill.status !== "draft") bill.status = "open";
  return bill;
}

const escapeRx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

module.exports = {
  lineItemJoi,
  baseDocJoi,
  prepareDoc,
  peekNumber,
  settleInvoice,
  settleBill,
  copyContent,
  createInvoiceFrom,
  escapeRx,
  nextNumber,
};
