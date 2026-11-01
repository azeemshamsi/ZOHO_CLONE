/**
 * Everything needed to turn a document into a PDF and an email.
 */
const { documentPdf, receiptPdf, money, fmtDate } = require("./pdf");

const M = (name) => require(`../models/${name}`);
const settleInvoice = (inv) => require("./salesDoc").settleInvoice(inv);

const DOCS = {
  invoice: {
    model: "Invoice", module: "sales", party: "customer", number: "invoiceNumber", title: "TAX INVOICE", label: "Invoice",
    facts: (d) => [["Invoice Date", fmtDate(d.date)], ["Due Date", fmtDate(d.dueDate)], ["Terms", d.paymentTerms ? `Net ${d.paymentTerms}` : "Due on Receipt"], ["Order Number", d.orderNumber]],
    balance: (d) => ({ paid: d.total - d.balance, balance: d.balance }),
    markSent: (d) => d.status === "draft" && ((d.status = "sent"), settleInvoice(d), true),
    body: (d, org, name) =>
      `Dear ${name},\n\nThank you for your business. Your invoice ${d.invoiceNumber} is attached.\n\nInvoice Amount: ${money(d.total)}\nDue Date: ${fmtDate(d.dueDate)}\nBalance Due: ${money(d.balance)}\n\nIf you have any questions, just reply to this email.\n\nRegards,\n${org.name}`,
  },
  quote: {
    model: "Quote", module: "sales", party: "customer", number: "number", title: "QUOTE", label: "Quote",
    facts: (d) => [["Quote Date", fmtDate(d.date)], ["Expiry Date", fmtDate(d.expiryDate)], ["Reference#", d.reference]],
    markSent: (d) => d.status === "draft" && ((d.status = "sent"), true),
    body: (d, org, name) => `Dear ${name},\n\nThank you for your interest. Please find our quote ${d.number} for ${money(d.total)} attached${d.expiryDate ? `, valid until ${fmtDate(d.expiryDate)}` : ""}.\n\nWe look forward to working with you.\n\nRegards,\n${org.name}`,
  },
  salesOrder: {
    model: "SalesOrder", module: "sales", party: "customer", number: "number", title: "SALES ORDER", label: "Sales Order",
    facts: (d) => [["Order Date", fmtDate(d.date)], ["Expected Shipment", fmtDate(d.shipmentDate)], ["Reference#", d.reference]],
    body: (d, org, name) => `Dear ${name},\n\nThank you for your order. Your sales order ${d.number} for ${money(d.total)} is attached.\n\nRegards,\n${org.name}`,
  },
  creditNote: {
    model: "CreditNote", module: "sales", party: "customer", number: "number", title: "CREDIT NOTE", label: "Credit Note",
    facts: (d) => [["Credit Note Date", fmtDate(d.date)], ["Invoice#", d.invoiceNumber], ["Reason", d.reason]],
    balance: (d) => ({ balance: d.balance, balanceLabel: "Credits Remaining" }),
    body: (d, org, name) => `Dear ${name},\n\nPlease find attached credit note ${d.number} for ${money(d.total)}.\n\nCredits remaining: ${money(d.balance)}\n\nRegards,\n${org.name}`,
  },
  purchaseOrder: {
    model: "PurchaseOrder", module: "purchases", party: "vendor", number: "number", title: "PURCHASE ORDER", label: "Purchase Order", partyLabel: "Vendor",
    facts: (d) => [["Order Date", fmtDate(d.date)], ["Delivery Date", fmtDate(d.deliveryDate)], ["Reference#", d.reference]],
    markSent: (d) => d.status === "draft" && ((d.status = "issued"), true),
    body: (d, org, name) => `Dear ${name},\n\nPlease find our purchase order ${d.number} for ${money(d.total)} attached.${d.deliveryDate ? `\nExpected delivery: ${fmtDate(d.deliveryDate)}` : ""}\n\nKindly confirm.\n\nRegards,\n${org.name}`,
  },
  vendorCredit: {
    model: "VendorCredit", module: "purchases", party: "vendor", number: "number", title: "VENDOR CREDIT", label: "Vendor Credit", partyLabel: "Vendor",
    facts: (d) => [["Date", fmtDate(d.date)], ["Bill#", d.billNumber], ["Reason", d.reason]],
    balance: (d) => ({ balance: d.balance, balanceLabel: "Credits Remaining" }),
    body: (d, org, name) => `Dear ${name},\n\nPlease find attached our debit note ${d.number} for ${money(d.total)}.\n\nRegards,\n${org.name}`,
  },
  payment: {
    model: "Payment", module: "sales", party: "customer", number: "paymentNumber", title: "PAYMENT RECEIPT", label: "Payment Receipt", receipt: true, appliedLabel: "Invoice#",
    applied: (p) => p.allocations.map((a) => ({ number: a.invoiceNumber, amount: a.amount })),
    body: (d, org, name) => `Dear ${name},\n\nThank you for your payment of ${money(d.amount)} received on ${fmtDate(d.date)}. The receipt is attached.\n\nRegards,\n${org.name}`,
  },
  vendorPayment: {
    model: "VendorPayment", module: "purchases", party: "vendor", number: "paymentNumber", title: "PAYMENT ADVICE", label: "Payment", receipt: true, appliedLabel: "Bill#", partyLabel: "Paid To",
    applied: (p) => p.allocations.map((a) => ({ number: a.billNumber, amount: a.amount })),
    body: (d, org, name) => `Dear ${name},\n\nWe have made a payment of ${money(d.amount)} on ${fmtDate(d.date)}. The payment advice is attached.\n\nRegards,\n${org.name}`,
  },
};

async function load(org, kind, id) {
  const cfg = DOCS[kind];
  const { HttpError } = require("./http");
  if (!cfg) throw new HttpError(404, "Unknown document type");
  const d = await M(cfg.model).findOne({ _id: id, organization: org._id });
  if (!d) throw new HttpError(404, `${cfg.label} not found`);
  const contact = await M(cfg.party === "vendor" ? "Vendor" : "Customer").findById(d[cfg.party]).lean();
  return { cfg, d, contact };
}

async function pdfFor(org, kind, d) {
  const cfg = DOCS[kind];
  if (cfg.receipt) {
    return receiptPdf(org, d, { title: cfg.title, partyLabel: cfg.partyLabel || "Received From", party: d[`${cfg.party}Name`], appliedLabel: cfg.appliedLabel, applied: cfg.applied(d) });
  }
  const bal = cfg.balance ? cfg.balance(d) : {};
  return documentPdf(org, d, { title: cfg.title, number: d[cfg.number], partyLabel: cfg.partyLabel || "Bill To", facts: cfg.facts(d), ...bal });
}

const fileName = (cfg, d) => `${cfg.label.replace(/\s+/g, "-")}-${d[cfg.number]}.pdf`.replace(/[^\w.-]+/g, "_");

module.exports = { DOCS, load, pdfFor, fileName };
