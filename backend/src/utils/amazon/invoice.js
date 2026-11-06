/**
 * Invoice an Amazon order in the company that owns the Amazon account. Amazon.in amounts are GST inclusive:
 * rates come out of the price, promotions become line discounts, shipping is a line at the order's highest
 * rate, and paise left over go to Adjustment so the total equals what Amazon shows.
 * Consumers → customer "Amazon B2C" (same as the MTR import); Amazon Business buyers → their GSTIN.
 */
const Customer = require("../../models/Customer");
const Organization = require("../../models/Organization");
const Item = require("../../models/Item");
const ShopifyStore = require("../../models/ShopifyStore");
const { itemFor } = require("../shopify/catalog");
const { computeTotals } = require("../gst");
const { salesLedger, skuMatcher } = require("../import/amazonImport");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const isoIst = (d) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

async function customerOf(org, order) {
  const gstin = order.amazon?.gstin;
  if (!gstin) {
    let c = await Customer.findOne({ organization: org, displayName: "Amazon B2C" });
    if (!c) c = await Customer.create({ organization: org, displayName: "Amazon B2C", companyName: "Amazon B2C customers", customerType: "individual", gstTreatment: "consumer", notes: "Amazon sales to consumers" });
    return c;
  }
  let c = await Customer.findOne({ organization: org, gstin });
  if (c) return c;
  const a = order.shippingAddress || {};
  const name = order.amazon.buyerCompany || order.customer?.name || gstin;
  return Customer.create({
    organization: org,
    displayName: (await Customer.exists({ organization: org, displayName: name })) ? `${name} (${gstin})` : name,
    companyName: order.amazon.buyerCompany || "",
    customerType: "business",
    gstin,
    gstTreatment: "registered",
    placeOfSupply: gstin.slice(0, 2),
    billingAddress: { street: [a.address1, a.address2].filter(Boolean).join(", "), city: a.city || "", state: a.state || gstin.slice(0, 2), pincode: a.zip || "", country: "India" },
    notes: "Amazon Business buyer",
  });
}

async function invoiceAmazonOrder(order, acc, { user } = {}) {
  if (order.invoice) return { skipped: true, invoiceNumber: order.invoiceNumber };
  if (order.status === "cancelled") throw new Error("Order is cancelled");
  const orgId = acc.organization;
  const org = await Organization.findById(orgId);
  const lines = order.lines.filter((l) => l.quantity > 0);
  if (!lines.length) throw new Error("No items left on the order");
  // GST rules and new-item settings from the Shopify store when there is one, otherwise the defaults.
  const store = (await ShopifyStore.findOne({ organization: order.organization })) || { fallbackTaxRate: 18, invoice: { trackInventory: true } };
  const sameOrg = String(order.organization) === String(orgId);
  // Amazon SKUs often carry FBA prefixes / suffixes: match those to the item first.
  const match = skuMatcher(await Item.find({ organization: orgId }, { sku: 1, name: 1 }).lean());
  const cache = new Map();
  const created = [];
  const lineItems = [];
  for (const l of lines) {
    const hit = l.sku ? match(l.sku) : null;
    let item = hit ? await Item.findById(hit._id) : null;
    if (!item) {
      const r = await itemFor(orgId, l, store, cache);
      item = r.item;
      if (r.created) created.push(item.name);
    }
    if (sameOrg) l.item = item._id;
    const tr = item.taxRate;
    const gross = r2(l.unitPrice * l.quantity);
    const discount = gross > 0 ? r4(Math.min(100, ((l.discount || 0) / gross) * 100)) : 0;
    lineItems.push({ item: String(item._id), name: item.name, description: l.sku ? `SKU ${l.sku}` : "", hsnSac: item.hsnSac, unit: item.unit || "pcs", quantity: l.quantity, rate: r4(l.unitPrice / (1 + tr / 100)), discount, taxRate: tr });
  }
  const ship = r2(order.shippingTotal || 0);
  if (ship > 0) {
    const tr = Math.max(...lineItems.map((l) => l.taxRate));
    lineItems.push({ item: null, name: "Shipping charges", hsnSac: acc.shippingSac || "996812", unit: "", quantity: 1, rate: r4(ship / (1 + tr / 100)), discount: 0, taxRate: tr });
  }
  const sa = order.shippingAddress || {};
  const pos = sa.state || (order.amazon?.gstin ? order.amazon.gstin.slice(0, 2) : "") || org.state;
  const customer = await customerOf(orgId, order);
  const t = computeTotals({ lineItems, orgState: org.state, placeOfSupply: pos });
  const adjustment = r2((order.total || t.total) - t.total);
  const iso = isoIst(new Date());
  const needsAddress = !!customer.gstin || (order.total || t.total) >= 50000;
  const ctx = { org: orgId, user: user || null };
  const body = {
    customer: String(customer._id),
    billingAddress: customer.gstin ? undefined : { street: needsAddress ? [sa.address1, sa.address2].filter(Boolean).join(", ") : "", city: sa.city || "", state: sa.state || "", pincode: sa.zip || "", country: sa.country || "India" },
    // Buyer's name, phone and street only where GST needs them (business buyer, or ₹50,000 or more — Rule 46):
    // Amazon buyer data isn't kept beyond what the law requires.
    shipTo: needsAddress ? { name: sa.name || order.customer?.name || "", phone: "", street: [sa.address1, sa.address2].filter(Boolean).join(", "), city: sa.city || "", state: sa.state || "", pincode: sa.zip || "", country: sa.country || "India" } : { name: "", phone: "", street: "", city: sa.city || "", state: sa.state || "", pincode: sa.zip || "", country: sa.country || "India" },
    date: iso,
    dueDate: iso,
    placeOfSupply: pos,
    lineItems,
    adjustment,
    ledger: await salesLedger(orgId, acc.ledger),
    orderNumber: order.name,
    customerNotes: `Amazon ${order.amazon?.easyShip ? "Easy Ship" : "self-ship"} order ${order.name}${order.paymentMode === "cod" ? " · Cash on delivery" : ""}`,
    terms: org.defaultTerms || "",
    status: acc.invoiceStatus || "sent",
  };
  if (!body.billingAddress) delete body.billingAddress;
  const { createInvoice } = require("../../routes/invoices");
  const inv = await createInvoice(ctx, body);
  order.invoice = inv._id;
  order.invoiceNumber = inv.invoiceNumber;
  order.invoiceOrg = orgId;
  order.invoiceError = "";
  order.markModified("lines");
  await order.save();
  return { invoiceNumber: inv.invoiceNumber, invoiceId: inv._id, total: inv.total, adjustment, itemsCreated: created };
}

module.exports = { invoiceAmazonOrder };
