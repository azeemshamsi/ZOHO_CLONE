/**
 * One-click invoice for a Shopify order. Shopify amounts are GST inclusive: rates are taken out of
 * the price, discounts become line discounts, shipping becomes a line at the order's highest GST rate,
 * and any paise left over from rounding goes into Adjustment so the total matches Shopify exactly.
 */
const Customer = require("../../models/Customer");
const Organization = require("../../models/Organization");
const Invoice = require("../../models/Invoice");
const { itemFor } = require("./catalog");
const { computeTotals } = require("../gst");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function customerFor(orgId, order, org) {
  const ship = order.shippingAddress || {};
  const bill = order.billingAddress?.address1 ? order.billingAddress : ship;
  const phone = digits(order.customer?.phone || ship.phone);
  const email = (order.customer?.email || "").toLowerCase();
  let c = null;
  if (email) c = await Customer.findOne({ organization: orgId, email: new RegExp(`^${esc(email)}$`, "i") });
  if (!c && phone.length === 10) c = await Customer.findOne({ organization: orgId, phone: new RegExp(`${phone}$`) });
  const pos = ship.state || bill.state || org.state;
  const addrOf = (a) => ({ street: [a.address1, a.address2].filter(Boolean).join(", "), city: a.city || "", state: a.state || "", pincode: a.zip || "", country: a.country || "India" });
  if (c) {
    // Keep the latest addresses so the invoice shows where this order went.
    c.shippingAddress = addrOf(ship);
    if (bill.address1) c.billingAddress = addrOf(bill);
    await c.save();
    return c;
  }
  let name = (order.customer?.name || ship.name || bill.name || "Shopify customer").trim();
  if (await Customer.exists({ organization: orgId, displayName: name })) name = `${name} (${phone || email || order.name})`;
  return Customer.create({
    organization: orgId,
    customerType: ship.company ? "business" : "individual",
    displayName: name,
    companyName: ship.company || "",
    email,
    phone: phone || order.customer?.phone || "",
    gstTreatment: "consumer",
    placeOfSupply: pos,
    billingAddress: addrOf(bill),
    shippingAddress: addrOf(ship),
    paymentTerms: 0,
    notes: "Created from Shopify",
  });
}

async function invoiceOrder(ctx, order, store) {
  if (order.invoice) return { skipped: true, invoiceNumber: order.invoiceNumber };
  if (order.status === "cancelled") throw new Error("Order is cancelled");
  const org = await Organization.findById(ctx.org);
  const lines = order.lines.filter((l) => l.quantity > 0);
  if (!lines.length) throw new Error("No items left on the order");
  const cache = new Map();
  const lineItems = [];
  const created = [];
  for (const l of lines) {
    const { item, created: isNew } = await itemFor(ctx.org, l, store, cache);
    if (isNew) created.push(item.name);
    l.item = item._id;
    const tr = item.taxRate;
    const gross = r2(l.unitPrice * l.quantity);
    const discount = gross > 0 ? r4(Math.min(100, ((l.discount || 0) / gross) * 100)) : 0;
    lineItems.push({ item: String(item._id), name: item.name, description: l.variantTitle ? "" : "", hsnSac: item.hsnSac, unit: item.unit || "pcs", quantity: l.quantity, rate: r4(l.unitPrice / (1 + tr / 100)), discount, taxRate: tr });
  }
  const ship = r2(order.shippingTotal || 0);
  if (ship > 0) {
    const tr = Math.max(...lineItems.map((l) => l.taxRate));
    lineItems.push({ item: null, name: "Shipping charges", hsnSac: store.invoice?.shippingSac || "996812", unit: "", quantity: 1, rate: r4(ship / (1 + tr / 100)), discount: 0, taxRate: tr });
  }
  const pos = order.shippingAddress?.state || order.billingAddress?.state || org.state;
  const customer = await customerFor(ctx.org, order, org);
  // Make MGI's total equal Shopify's: rounding paise (and anything Shopify adds that isn't itemised) go to Adjustment.
  const t = computeTotals({ lineItems, orgState: org.state, placeOfSupply: pos });
  const target = order.total || t.total;
  const adjustment = r2(target - t.total);
  const date = store.invoice?.dateFrom === "today" ? new Date() : order.orderDate;
  const iso = new Date(date.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const body = {
    customer: String(customer._id),
    date: iso,
    dueDate: iso,
    placeOfSupply: pos,
    lineItems,
    adjustment,
    orderNumber: order.name,
    status: store.invoice?.status || "sent",
    customerNotes: `Shopify order ${order.name}${order.paymentMode === "cod" ? " · Cash on delivery" : ""}`,
    ...(store.invoice?.branch ? { branch: String(store.invoice.branch) } : {}),
    ...(store.invoice?.warehouse ? { warehouse: String(store.invoice.warehouse) } : {}),
  };
  const { createInvoice } = require("../../routes/invoices");
  const inv = await createInvoice({ org: ctx.org, user: ctx.user }, body);
  let paid = false;
  if (store.invoice?.recordPayment && store.invoice.paymentAccount && order.paymentMode === "prepaid" && order.financialStatus === "PAID" && inv.status !== "draft") {
    const { call } = require("../import/commit");
    await call(require("../../routes/payments"), "POST", "/", ctx, { customer: String(customer._id), date: iso, amount: inv.total, mode: "bank_transfer", reference: `Shopify ${order.name}`, bankAccount: store.invoice.paymentAccount, allocations: [{ invoice: String(inv._id), amount: inv.total }] });
    paid = true;
  }
  order.invoice = inv._id;
  order.invoiceNumber = inv.invoiceNumber;
  order.invoiceError = "";
  order.markModified("lines");
  await order.save();
  return { invoiceNumber: inv.invoiceNumber, invoiceId: inv._id, total: inv.total, adjustment, paid, itemsCreated: created };
}

// Make sure every line has an MGI item (used when orders are synced, so items appear straight away).
async function ensureItems(orgId, order, store, cache) {
  let n = 0;
  for (const l of order.lines) {
    if (l.item) continue;
    const { item, created } = await itemFor(orgId, l, store, cache);
    l.item = item._id;
    if (created) n++;
  }
  order.markModified("lines");
  return n;
}

module.exports = { invoiceOrder, customerFor, ensureItems };
void Invoice;
