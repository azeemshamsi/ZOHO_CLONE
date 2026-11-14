/**
 * Shopify orders: connection, sync, order list with status tabs and filters, one-click invoices,
 * courier booking, labels and tracking. Mounted at /api/shopify.
 */
const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const { ah, validate, HttpError } = require("../utils/http");
const ShopifyStore = require("../models/ShopifyStore");
const ShopifyOrder = require("../models/ShopifyOrder");
const CourierAccount = require("../models/CourierAccount");
const Organization = require("../models/Organization");
const Item = require("../models/Item");
const { gql, shopHost } = require("../utils/shopify/client");
const { syncStore } = require("../utils/shopify/sync");
const { invoiceOrder } = require("../utils/shopify/invoice");
const { DEFAULT_RULES, checkGst } = require("../utils/shopify/catalog");
const { bookOrder, trackOrder, cancelShipment } = require("../utils/shopify/ship");
const { CARRIERS } = require("../utils/couriers");
const { labelsPdf } = require("../utils/couriers/label");
const { shipmentFrom } = require("../utils/couriers");
const { quoteAccount, sortQuotes } = require("../utils/couriers/rates");
const CourierPincode = require("../models/CourierPincode");
const { resolvePackage } = require("../utils/shopify/package");
const PackageType = require("../models/PackageType");
const { orderIndex, filterEntries } = require("../utils/shopify/orderIndex");
const audit = require("../utils/audit");
const { stateCode } = require("../utils/import/common");
const devices = require("../utils/devices");

const STATUSES = ["new", "packed", "ready_to_ship", "shipped", "delivered", "rto", "return_created", "returned", "cancelled"];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ctxOf = (req) => ({ org: req.org, user: req.user, storeOrg: req.storeOrg });

// The Shopify store can belong to this company or be shared from another company of the same owner.
// Orders, couriers and settings live with the store's company; invoices are made in the current company.
async function storeOrgFor(org) {
  if (await ShopifyStore.exists({ organization: org, shop: { $nin: ["", null] } })) return org;
  const shared = await ShopifyStore.findOne({ sharedWith: org, connected: true }, { organization: 1 }).lean();
  return shared ? shared.organization : org;
}
router.use(
  ah(async (req, res, next) => {
    req.storeOrg = await storeOrgFor(req.org);
    req.storeShared = String(req.storeOrg) !== String(req.org);
    next();
  })
);
const ownerOnly = (req) => {
  if (req.storeShared) throw new HttpError(400, "This store is shared from another company. Change its settings there.");
};

async function storeOf(req, required = true) {
  const s = await ShopifyStore.findOne({ organization: req.storeOrg });
  if (!s && required) throw new HttpError(400, "Connect your Shopify store first (Shopify Settings)");
  return s;
}

/* ---------------- store settings ---------------- */
router.get(
  "/store",
  ah(async (req, res) => {
    const s = await storeOf(req, false);
    const out = s ? s.toJSON() : { connected: false };
    if (!out.rules) out.rules = DEFAULT_RULES;
    out.shared = req.storeShared;
    if (req.storeShared) out.ownerName = (await Organization.findById(req.storeOrg, { name: 1 }))?.name;
    // Companies this store can be shared with: the user's other companies where they're an admin.
    const Membership = require("../models/Membership");
    const mine = await Membership.find({ user: req.user._id, status: "active", role: "admin", organization: { $ne: req.storeOrg } }).populate("organization", "name").lean();
    out.shareable = mine.filter((m) => m.organization).map((m) => ({ _id: m.organization._id, name: m.organization.name, on: (s?.sharedWith || []).some((x) => String(x) === String(m.organization._id)) }));
    out.carriers = Object.fromEntries(Object.entries(CARRIERS).map(([k, c]) => [k, { label: c.title, fields: c.fields, help: c.help }]));
    res.send(out);
  })
);

const ruleJoi = Joi.object({ name: Joi.string().trim().required(), taxRate: Joi.number().min(0).max(100).required(), defaultHsn: Joi.string().allow("").pattern(/^\d{4}(\d{2}){0,2}$/).message("Default HSN must be 4, 6 or 8 digits"), hsnPrefixes: Joi.array().items(Joi.string().trim()), keywords: Joi.array().items(Joi.string().trim()) });

router.put(
  "/store",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        shop: Joi.string().trim().allow(""),
        authType: Joi.string().valid("client", "token"),
        clientId: Joi.string().trim().allow(""),
        clientSecret: Joi.string().trim().allow(""),
        accessToken: Joi.string().trim().allow(""),
        syncFrom: Joi.date().allow(null, ""),
        autoSync: Joi.boolean(),
        invoice: Joi.object({ status: Joi.string().valid("draft", "sent"), dateFrom: Joi.string().valid("order", "today"), recordPayment: Joi.boolean(), paymentAccount: Joi.string().allow(""), branch: Joi.string().allow(null, ""), warehouse: Joi.string().allow(null, ""), shippingSac: Joi.string().allow(""), trackInventory: Joi.boolean() }),
        pkg: Joi.object({ weight: Joi.number().greater(0), length: Joi.number().greater(0), breadth: Joi.number().greater(0), height: Joi.number().greater(0) }),
        fulfillInShopify: Joi.boolean(),
        notifyCustomer: Joi.boolean(),
        rules: Joi.array().items(ruleJoi),
        fallbackTaxRate: Joi.number().min(0).max(100),
        inventorySync: Joi.boolean(),
        locationId: Joi.string().allow(""),
        locationName: Joi.string().allow(""),
        stockFrom: Joi.date().allow(null, ""),
        returnCreditNote: Joi.boolean(),
      }),
      req.body
    );
    ownerOnly(req);
    let s = await storeOf(req, false);
    if (!s) {
      await require("../utils/subscription").checkLimit(req.org, "shopifyStores");
      s = new ShopifyStore({ organization: req.org });
    }
    const credsChanged = (d.shop !== undefined && d.shop && shopHost(d.shop) !== s.shop) || (d.clientId !== undefined && d.clientId !== s.clientId) || d.clientSecret || d.accessToken || (d.authType && d.authType !== s.authType);
    if (d.shop !== undefined) s.shop = d.shop ? shopHost(d.shop) : "";
    if (d.authType) s.authType = d.authType;
    if (d.clientId !== undefined) s.clientId = d.clientId;
    if (d.clientSecret) s.clientSecret = d.clientSecret;
    if (d.accessToken) s.accessToken = d.accessToken;
    if (credsChanged && !d.accessToken) {
      if (s.authType === "client") s.accessToken = "";
      s.tokenExpires = null;
    }
    for (const k of ["autoSync", "fulfillInShopify", "notifyCustomer", "fallbackTaxRate", "rules", "inventorySync", "locationId", "locationName", "returnCreditNote"]) if (d[k] !== undefined) s[k] = d[k];
    if (d.stockFrom !== undefined) s.stockFrom = d.stockFrom || null;
    if (d.inventorySync && !s.stockFrom) s.stockFrom = new Date(); // orders from now on reserve stock
    if (d.syncFrom !== undefined) s.syncFrom = d.syncFrom || null;
    if (d.invoice) s.invoice = { ...(s.invoice?.toObject?.() || {}), ...d.invoice, branch: d.invoice.branch || null, warehouse: d.invoice.warehouse || null };
    if (d.pkg) s.pkg = { ...(s.pkg?.toObject?.() || {}), ...d.pkg };
    // Test the connection whenever the credentials change.
    if (credsChanged && s.shop) {
      try {
        const data = await gql(s, "{ shop { name myshopifyDomain } }");
        s.shopName = data.shop.name;
        s.shop = data.shop.myshopifyDomain || s.shop;
        s.connected = true;
        if (!s.syncFrom) s.syncFrom = new Date(Date.now() - 30 * 86400000);
        if (!s.stockFrom) s.stockFrom = new Date(); // only orders from now on reserve stock
      } catch (e) {
        s.connected = false;
        await s.save();
        throw new HttpError(400, `Saved, but couldn't connect: ${e.message}`);
      }
    }
    await s.save();
    if (s.connected && (d.inventorySync || credsChanged)) {
      // Real-time order webhooks (needs the public https address of this app).
      const base = req.get("origin") || `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
      require("../utils/shopify/sync").registerWebhooks(s, base).catch(() => {});
    }
    if (s.inventorySync) require("../utils/shopify/inventory").schedulePush(String(req.storeOrg), 1000);
    res.send(s);
  })
);

router.put(
  "/store/share",
  ah(async (req, res) => {
    ownerOnly(req);
    const { orgs } = validate(Joi.object({ orgs: Joi.array().items(Joi.string()).max(20).required() }), req.body);
    const Membership = require("../models/Membership");
    for (const o of orgs) if (!(await Membership.exists({ user: req.user._id, organization: o, role: "admin", status: "active" }))) throw new HttpError(403, "You can only share with companies where you're an admin");
    const s = await storeOf(req);
    s.sharedWith = orgs;
    await s.save();
    res.send({ sharedWith: s.sharedWith });
  })
);

router.get(
  "/locations",
  ah(async (req, res) => {
    const s = await storeOf(req);
    try {
      res.send(await require("../utils/shopify/inventory").locations(s));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);

router.delete(
  "/store",
  ah(async (req, res) => {
    ownerOnly(req);
    await ShopifyStore.updateOne({ organization: req.org }, { connected: false, accessToken: "", clientSecret: "", clientId: "", tokenExpires: null });
    res.send({ ok: true });
  })
);

router.post(
  "/sync",
  ah(async (req, res) => {
    const s = await storeOf(req);
    if (!s.connected) throw new HttpError(400, "Connect your Shopify store first");
    if (s.sync?.running && s.sync.startedAt > new Date(Date.now() - 30 * 60000)) return res.send({ running: true });
    const full = !!req.body?.full;
    syncStore(s, { full }).catch((e) => console.error("Shopify sync failed:", e.message));
    res.send({ running: true });
  })
);

/* ---------------- orders ---------------- */
const LIST_FIELDS = { awbScannedAt: 1, "flipkart.selfShip": 1, "flipkart.dispatchBy": 1, "flipkart.state": 1, returnStatus: 1, "b2b.gstin": 1, channel: 1, "amazon.easyShip": 1, "amazon.confirmedAt": 1, "amazon.confirmError": 1, "amazon.shipBy": 1, "amazon.label": 1, "amazon.slot": 1, "amazon.gstin": 1, "lines.title": 1, "lines.variantTitle": 1, "lines.quantity": 1, "lines.vendor": 1, sellers: 1, "lines.sku": 1, "lines.image": 1, prepaidAmount: 1, codAmount: 1, name: 1, orderNumber: 1, orderDate: 1, customer: 1, "shippingAddress.city": 1, "shippingAddress.state": 1, "shippingAddress.zip": 1, "shippingAddress.province": 1, paymentMode: 1, financialStatus: 1, fulfillmentStatus: 1, total: 1, status: 1, "shipment.courierName": 1, "shipment.awb": 1, "shipment.trackStatus": 1, "shipment.trackingUrl": 1, "shipment.carrier": 1, "shipment.account": 1, invoice: 1, invoiceNumber: 1, invoiceOrg: 1, tags: 1, cancelledAt: 1 };
// The order list: filters, counts, sort and search from the in-memory index; only the page shown is read.
router.get(
  "/orders",
  ah(async (req, res) => {
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(q.limit) || 50));
    const matched = filterEntries(await orderIndex(req.storeOrg), q);
    const counts = Object.fromEntries([...STATUSES, "awb_scanned"].map((s) => [s, 0]));
    for (const e of matched) counts[e.tab || e.status] = (counts[e.tab || e.status] || 0) + 1;
    counts.all = matched.length;
    const list = q.status && q.status !== "all" ? matched.filter((e) => (e.tab || e.status) === q.status) : matched;
    const cmp = { oldest: (a, b) => a.orderDate - b.orderDate, amount: (a, b) => b.total - a.total }[q.sort] || ((a, b) => b.orderDate - a.orderDate);
    const pageIds = [...list].sort(cmp).slice((page - 1) * limit, page * limit).map((e) => e._id);
    const docs = pageIds.length ? await ShopifyOrder.find({ _id: { $in: pageIds } }, LIST_FIELDS).lean() : [];
    const by = new Map(docs.map((d) => [String(d._id), d]));
    res.send({ rows: pageIds.map((id) => by.get(String(id))).filter(Boolean), total: list.length, page, limit, counts });
  })
);

// Values for the filter dropdowns.
router.get(
  "/orders/facets",
  ah(async (req, res) => {
    const org = new mongoose.Types.ObjectId(String(req.storeOrg));
    const [states, tags, financial] = await Promise.all([ShopifyOrder.distinct("shippingAddress.state", { organization: org }), ShopifyOrder.distinct("tags", { organization: org }), ShopifyOrder.distinct("financialStatus", { organization: org })]);
    res.send({ states: states.filter(Boolean).sort(), tags: tags.filter(Boolean).sort().slice(0, 300), financial: financial.filter(Boolean).sort() });
  })
);

router.get(
  "/orders/export",
  ah(async (req, res) => {
    const ids = filterEntries(await orderIndex(req.storeOrg), req.query).filter((e) => !req.query.status || req.query.status === "all" || (e.tab || e.status) === req.query.status).map((e) => e._id);
    const rows = await ShopifyOrder.find({ _id: { $in: ids } }).sort({ orderDate: -1 }).limit(20000).lean();
    const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Order", "Date", "Customer", "Phone", "Email", "City", "State", "Pincode", "Payment", "Financial status", "Status", "Items", "Total", "Courier", "AWB", "Invoice"];
    const out = [head.map(csv).join(",")];
    for (const o of rows)
      out.push(
        [o.name, new Date(o.orderDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), o.customer?.name, o.customer?.phone || o.shippingAddress?.phone, o.customer?.email, o.shippingAddress?.city, o.shippingAddress?.province, o.shippingAddress?.zip, o.paymentMode === "cod" ? "COD" : o.paymentMode === "partial" ? `Partly paid (${o.prepaidAmount} online, ${o.codAmount} COD)` : "Prepaid", o.financialStatus, o.status, (o.lines || []).map((l) => `${l.quantity} x ${l.title}${l.sku ? ` (${l.sku})` : ""}`).join("; "), o.total, o.shipment?.courierName, o.shipment?.awb, o.invoiceNumber]
          .map(csv)
          .join(",")
      );
    const amazonRows = rows.filter((o) => o.channel === "amazon").length;
    if (amazonRows) await devices.amazonData(req, "order_export", "orders CSV", { rows: rows.length, amazon: amazonRows, status: req.query.status || "all" });
    else await audit.log(req, "order_export", { target: "orders CSV", meta: { rows: rows.length, amazon: 0, status: req.query.status || "all" } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shopify-orders.csv"`);
    res.send("﻿" + out.join("\r\n"));
  })
);

// Abandoned checkouts, read live from Shopify; the team's remarks / status / next follow-up are kept here.
// ?after=<cursor>&q=<search>; 50 per page, newest first; completed checkouts are left out.
// ?status=<status>|any (checkouts with remarks) or ?due=1 (follow-up due today or earlier): from the remarks here.
const CheckoutFollowUp = require("../models/CheckoutFollowUp");
const CK_STATUSES = ["No answer", "Interested", "Will order later", "Price / shipping query", "Not interested", "Wrong number", "Ordered"];
const CK_FIELDS = `id name createdAt updatedAt completedAt abandonedCheckoutUrl
  totalPriceSet { shopMoney { amount } }
  customer { id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } numberOfOrders }
  shippingAddress { name firstName lastName company address1 address2 phone city province provinceCode zip }
  billingAddress { phone }
  lineItems(first: 50) { nodes { title variantTitle sku quantity originalUnitPriceSet { shopMoney { amount } } discountedUnitPriceSet { shopMoney { amount } } image { url } variant { id price inventoryQuantity } } }`;
const ckKey = (r) => (r.customerId ? r.customerId.split("/").pop() : "") || String(r.phone || "").replace(/\D/g, "").slice(-10) || String(r.email || "").toLowerCase();
const ckRow = (x) => {
  const r = {
    id: x.id.split("/").pop(),
    name: x.name,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    completed: !!x.completedAt,
    url: x.abandonedCheckoutUrl,
    total: Number(x.totalPriceSet?.shopMoney?.amount) || 0,
    customer: x.customer?.displayName || x.shippingAddress?.name || "",
    email: x.customer?.defaultEmailAddress?.emailAddress || "",
    phone: x.shippingAddress?.phone || x.customer?.defaultPhoneNumber?.phoneNumber || x.billingAddress?.phone || "",
    orders: x.customer?.numberOfOrders != null ? Number(x.customer.numberOfOrders) : null,
    city: [x.shippingAddress?.city, x.shippingAddress?.province, x.shippingAddress?.zip].filter(Boolean).join(", "),
    items: (x.lineItems?.nodes || []).map((l) => ({
      title: l.title,
      variant: l.variantTitle || "",
      sku: l.sku || "",
      quantity: l.quantity,
      price: Number(l.originalUnitPriceSet?.shopMoney?.amount) || 0,
      cartPrice: Number(l.discountedUnitPriceSet?.shopMoney?.amount) || Number(l.originalUnitPriceSet?.shopMoney?.amount) || 0,
      image: l.image?.url || "",
      variantId: l.variant?.id || "",
      listPrice: Number(l.variant?.price) || 0,
      stock: l.variant?.inventoryQuantity ?? null,
    })),
    // For "Create order" from this checkout.
    customerId: x.customer?.id || "",
    address: {
      name: x.shippingAddress?.name || [x.shippingAddress?.firstName, x.shippingAddress?.lastName].filter(Boolean).join(" "),
      company: x.shippingAddress?.company || "",
      address1: x.shippingAddress?.address1 || "",
      address2: x.shippingAddress?.address2 || "",
      city: x.shippingAddress?.city || "",
      state: stateCode(x.shippingAddress?.provinceCode || x.shippingAddress?.province) || "",
      zip: (x.shippingAddress?.zip || "").replace(/\s/g, ""),
      phone: x.shippingAddress?.phone || "",
    },
  };
  r.customerKey = ckKey(r);
  return r;
};
const fuOut = (f) => (f ? { status: f.status || "", nextOn: f.nextOn, orderName: f.orderName || "", lastAt: f.lastAt, notes: (f.notes || []).map((n) => ({ _id: n._id, text: n.text, status: n.status || "", by: n.by, byId: n.byId, at: n.at })) } : null);
// Remarks of these checkouts, and the same customer's remarks on their other checkouts.
async function withFollowUps(org, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const keys = [...new Set(rows.map((r) => r.customerKey).filter(Boolean))];
  const [own, byCust] = await Promise.all([CheckoutFollowUp.find({ organization: org, checkoutId: { $in: ids } }).lean(), keys.length ? CheckoutFollowUp.find({ organization: org, customerKey: { $in: keys } }).lean() : []]);
  const of = new Map(own.map((f) => [f.checkoutId, f]));
  return rows.map((r) => {
    const earlier = byCust
      .filter((f) => f.customerKey === r.customerKey && f.checkoutId !== r.id)
      .flatMap((f) => (f.notes || []).map((n) => ({ text: n.text, status: n.status || "", by: n.by, at: n.at, checkout: f.checkoutId })))
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    return { ...r, followUp: fuOut(of.get(r.id)), earlier };
  });
}
router.get(
  "/abandoned-checkouts/statuses",
  ah(async (req, res) => res.send(CK_STATUSES))
);
router.get(
  "/abandoned-checkouts",
  ah(async (req, res) => {
    const store = await ShopifyStore.findOne({ organization: req.storeOrg });
    if (!store?.connected) throw new HttpError(400, "Connect the Shopify store first");
    const { gql } = require("../utils/shopify/client");
    const scopeErr = (e) => (/access|scope|permission/i.test(e.message) ? new HttpError(400, "The Shopify app can't read abandoned checkouts — give it the read_orders access scope and reinstall it") : new HttpError(400, e.message));
    // Filtered by the team's remarks: the checkouts are looked up by id.
    if (req.query.status || req.query.due) {
      const today = new Date(Date.now() + 330 * 60000); // end of today in India
      today.setUTCHours(23, 59, 59, 999);
      today.setTime(today.getTime() - 330 * 60000);
      let fus = (await CheckoutFollowUp.find({ organization: req.storeOrg }).lean()).filter((f) => (req.query.due ? f.nextOn && new Date(f.nextOn) <= today && f.status !== "Ordered" && f.status !== "Not interested" : req.query.status === "any" ? (f.notes || []).length : f.status === req.query.status));
      fus.sort((a, b) => (req.query.due ? new Date(a.nextOn) - new Date(b.nextOn) : new Date(b.lastAt || 0) - new Date(a.lastAt || 0)));
      const start = Number(req.query.after) || 0;
      const page = fus.slice(start, start + 50);
      let nodes = [];
      try {
        if (page.length) nodes = (await gql(store, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on AbandonedCheckout { ${CK_FIELDS} } } }`, { ids: page.map((f) => `gid://shopify/AbandonedCheckout/${f.checkoutId}`) })).nodes || [];
      } catch (e) {
        throw scopeErr(e);
      }
      const byId = new Map(nodes.filter((n) => n?.id).map((n) => [n.id.split("/").pop(), n]));
      // A checkout Shopify no longer has still shows, from what was saved with the remarks.
      const rows = page.map((f) => (byId.get(f.checkoutId) ? ckRow(byId.get(f.checkoutId)) : { id: f.checkoutId, gone: true, createdAt: f.createdAt, customer: f.customer, phone: f.phone, email: "", items: [], total: 0, city: "", customerKey: f.customerKey, address: {} }));
      return res.send({ rows: await withFollowUps(req.storeOrg, rows), next: start + 50 < fus.length ? String(start + 50) : null, shop: store.shop, total: fus.length });
    }
    const q = String(req.query.q || "").replace(/["\\]/g, "").trim();
    let d;
    try {
      d = await gql(store, `query($after: String, $query: String) { abandonedCheckouts(first: 50, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${CK_FIELDS} } } }`, { after: req.query.after || null, query: q || null });
    } catch (e) {
      throw scopeErr(e);
    }
    const c = d.abandonedCheckouts || {};
    const rows = (c.nodes || []).filter((x) => !x.completedAt).map(ckRow);
    res.send({ rows: await withFollowUps(req.storeOrg, rows), next: c.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null, shop: store.shop });
  })
);
// Add a remark (and/or change the status / next follow-up date).
router.post(
  "/abandoned-checkouts/:id/remarks",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        text: Joi.string().trim().allow("").max(2000).default(""),
        status: Joi.string().valid("", ...CK_STATUSES).allow(null),
        nextOn: Joi.date().allow(null, ""),
        customerKey: Joi.string().allow("").max(80).default(""),
        customer: Joi.string().allow("").max(200).default(""),
        phone: Joi.string().allow("").max(40).default(""),
      }),
      req.body
    );
    if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, "Bad checkout");
    if (!d.text && d.status == null && d.nextOn === undefined) throw new HttpError(400, "Write a remark or choose a status");
    let f = await CheckoutFollowUp.findOne({ organization: req.storeOrg, checkoutId: req.params.id });
    if (!f) f = new CheckoutFollowUp({ organization: req.storeOrg, checkoutId: req.params.id });
    if (d.customerKey) f.customerKey = d.customerKey;
    if (d.customer) f.customer = d.customer;
    if (d.phone) f.phone = d.phone;
    const statusChanged = d.status != null && d.status !== f.status;
    if (d.status != null) f.status = d.status;
    if (d.nextOn !== undefined) f.nextOn = d.nextOn || null;
    if (d.text || statusChanged) f.notes.push({ text: d.text, status: statusChanged ? d.status : "", by: req.user?.name || "", byId: req.user?._id, at: new Date() });
    f.lastAt = new Date();
    await f.save();
    res.send(fuOut(f));
  })
);
router.delete(
  "/abandoned-checkouts/:id/remarks/:nid",
  ah(async (req, res) => {
    const f = await CheckoutFollowUp.findOne({ organization: req.storeOrg, checkoutId: req.params.id });
    const n = f?.notes.id(req.params.nid);
    if (!n) throw new HttpError(404, "Remark not found");
    const full = (req.perms?.store_orders || "none") === "full";
    if (!full && String(n.byId) !== String(req.user?._id)) throw new HttpError(403, "You can delete only your own remarks");
    n.deleteOne();
    await f.save();
    res.send(fuOut(f));
  })
);

// Create an order in Shopify from OrdexaGo (phone / WhatsApp orders): product and customer look-ups, then the order.
const CO = require("../utils/shopify/createOrder");
const draftScopeErr = (e) => {
  if (/access|scope|permission|denied/i.test(e.message)) return new HttpError(400, "The Shopify app can't create orders yet — add the read_draft_orders and write_draft_orders scopes to the app, release it and reinstall it on the store (Store → Shopify settings has the steps)");
  return new HttpError(400, e.message);
};
async function connectedStore(req) {
  const store = await ShopifyStore.findOne({ organization: req.storeOrg });
  if (!store?.connected) throw new HttpError(400, "Connect the Shopify store first");
  return store;
}
router.get(
  "/new-order/products",
  ah(async (req, res) => {
    const store = await connectedStore(req);
    try {
      res.send(await CO.searchProducts(store, req.query.q));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);
router.get(
  "/new-order/customers",
  ah(async (req, res) => {
    const store = await connectedStore(req);
    try {
      res.send(await CO.searchCustomers(store, req.query.q));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);
const addrSchema = Joi.object({ name: Joi.string().trim().required(), company: Joi.string().allow("").default(""), address1: Joi.string().trim().required(), address2: Joi.string().allow("").default(""), city: Joi.string().trim().required(), state: Joi.string().required(), zip: Joi.string().trim().pattern(/^\d{6}$/).required().messages({ "string.pattern.base": "Pincode must be 6 digits" }), phone: Joi.string().allow("").default("") });
const newOrderSchema = Joi.object({
      customerId: Joi.string().allow("", null),
      customer: Joi.object({ name: Joi.string().allow("").default(""), email: Joi.string().email({ tlds: false }).allow("").default(""), phone: Joi.string().allow("").default("") }).default({}),
      address: addrSchema.required(),
      lines: Joi.array().items(Joi.object({ variantId: Joi.string().required(), quantity: Joi.number().integer().min(1).required(), price: Joi.number().min(0).allow(null, ""), basePrice: Joi.number().allow(null) }).unknown(true)).min(1).required(),
      shipping: Joi.object({ title: Joi.string().allow("").default(""), amount: Joi.number().min(0).default(0) }).default({}),
      discount: Joi.object({ type: Joi.string().valid("percent", "amount").default("amount"), value: Joi.number().min(0).default(0), reason: Joi.string().allow("").default("") }).default({}),
      payment: Joi.string().valid("cod", "paid", "link").required(),
      checkoutId: Joi.string().allow("").max(40).default(""),
      note: Joi.string().allow("").default(""),
      tags: Joi.array().items(Joi.string().allow("")).default([]),
});
router.post(
  "/new-order",
  ah(async (req, res) => {
    const body = validate(newOrderSchema, req.body);
    const store = await connectedStore(req);
    let r;
    try {
      r = await CO.createOrder(store, { ...body, customerId: body.customerId || null }, { user: req.user });
    } catch (e) {
      throw draftScopeErr(e);
    }
    if (body.checkoutId && /^\d+$/.test(body.checkoutId)) {
      const f = (await CheckoutFollowUp.findOne({ organization: req.storeOrg, checkoutId: body.checkoutId })) || new CheckoutFollowUp({ organization: req.storeOrg, checkoutId: body.checkoutId, customer: body.customer?.name || body.address?.name || "", phone: body.customer?.phone || body.address?.phone || "" });
      const label = r.order?.name ? `Order ${r.order.name} created` : `Payment link ${r.draft?.name || ""} sent`;
      if (r.order) f.status = "Ordered";
      f.orderName = r.order?.name || f.orderName || "";
      f.notes.push({ text: `${label} from this checkout`, status: r.order ? "Ordered" : "", by: req.user?.name || "", byId: req.user?._id, at: new Date() });
      f.lastAt = new Date();
      await f.save().catch(() => {});
    }
    await audit.log(req, "shopify_order_create", { target: r.order?.name || r.draft?.name || "", meta: { payment: body.payment, lines: body.lines.length } });
    res.status(201).send(r);
  })
);

// Orders returned in Shopify that are still Shipped here (found by the delivery check): closing them posts the
// credit notes against their OrdexaGo invoices, so the user does it.
router.get(
  "/orders/returned-in-shopify",
  ah(async (req, res) => {
    const list = await ShopifyOrder.find({ organization: req.storeOrg, status: "shipped", returnStatus: "RETURNED" }, { name: 1, invoiceNumber: 1, total: 1, orderDate: 1 }).lean();
    res.send(list);
  })
);
router.post(
  "/orders/returned-in-shopify/close",
  ah(async (req, res) => {
    const store = await ShopifyStore.findOne({ organization: req.storeOrg });
    const { markReturnClosed } = require("../utils/shopify/returns");
    const out = { closed: 0, creditNotes: [], failed: [] };
    for (const o of await ShopifyOrder.find({ organization: req.storeOrg, status: "shipped", returnStatus: "RETURNED" })) {
      try {
        const r = await markReturnClosed({ org: req.storeOrg, user: req.user }, o, store, { shopifyDone: true });
        out.closed++;
        if (r.creditNote) out.creditNotes.push(r.creditNote);
      } catch (e) {
        out.failed.push(`${o.name}: ${e.message}`);
      }
    }
    require("../utils/shopify/orderIndex").forget(String(req.storeOrg));
    res.send(out);
  })
);

router.get(
  "/orders/:id",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }).populate("lines.item", "name sku hsnSac taxRate needsReview reviewNote trackInventory packageType").lean();
    if (!o) throw new HttpError(404, "Order not found");
    if (o.channel === "amazon") await devices.amazonData(req, "amazon_order_view", o.name, { orderId: String(o._id) });
    // Where to pick each item from.
    const ids = o.lines.map((l) => l.item?._id).filter(Boolean);
    if (ids.length) {
      const { rows } = await require("../utils/stockview").stockView(req.storeOrg, { itemIds: ids });
      const by = new Map(rows.map((r) => [String(r._id), r]));
      for (const l of o.lines) {
        const r = l.item && by.get(String(l.item._id));
        if (r) l.stock = { onHand: r.onHand, racks: r.racks.map((x) => `${x.code} (${x.qty})`), unassigned: r.unassigned.reduce((a, u) => a + u.qty, 0) };
      }
    }
    res.send(o);
  })
);

const idsJoi = Joi.array().items(Joi.string()).min(1).max(500).required();
const ordersFor = (req, ids) => ShopifyOrder.find({ _id: { $in: ids }, organization: req.storeOrg }).sort({ orderDate: 1 });

router.post(
  "/orders/status",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi, status: Joi.string().valid(...STATUSES).required() }), req.body);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      if (o.status === "cancelled" && d.status !== "new") {
        results.push({ id: o._id, name: o.name, error: "Cancelled in Shopify" });
        continue;
      }
      if (d.status === "ready_to_ship" && !o.shipment?.awb) {
        results.push({ id: o._id, name: o.name, error: "Book a courier first" });
        continue;
      }
      o.status = d.status;
      o.statusChangedAt = new Date();
      await o.save();
      results.push({ id: o._id, name: o.name, ok: true });
    }
    res.send({ results });
  })
);

router.post(
  "/orders/invoice",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi }), req.body);
    const store = await storeOf(req, false);
    const AmazonAccount = require("../models/AmazonAccount");
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        let r;
        if (o.channel === "flipkart") throw new Error("Flipkart sales come into the books with the monthly Flipkart import, not order by order");
        if (o.channel === "amazon") {
          // Amazon orders are invoiced in the company whose Amazon account they came from (its GSTIN).
          const acc = await AmazonAccount.findById(o.amazon?.account);
          if (!acc) throw new Error("Its Amazon account isn't connected any more");
          if (String(acc.organization) !== String(req.org)) throw new Error("Amazon orders are invoiced in the company that connected Amazon — switch to that company");
          r = await require("../utils/amazon/invoice").invoiceAmazonOrder(o, acc, { user: req.user });
        } else {
          if (!store) throw new Error("Connect your Shopify store first (Shopify Settings)");
          r = await invoiceOrder(ctxOf(req), o, store);
        }
        results.push({ id: o._id, name: o.name, ...r, ok: !r.skipped });
      } catch (e) {
        o.invoiceError = e.message;
        await o.save().catch(() => {});
        results.push({ id: o._id, name: o.name, error: e.message });
      }
    }
    res.send({ results });
  })
);

const pkgJoi = Joi.object({ packageType: Joi.string().allow("", null), weight: Joi.number().min(0).allow(null, ""), length: Joi.number().min(0).allow(null, ""), breadth: Joi.number().min(0).allow(null, ""), height: Joi.number().min(0).allow(null, "") }).default({});

// Live serviceability and expected charges of every active courier, for one or more orders.
router.post(
  "/orders/quotes",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: Joi.array().items(Joi.string()).min(1).max(50).required(), pkg: pkgJoi, pickupFrom: Joi.string().allow("").default("") }), req.body);
    const sellers = require("../utils/sellers");
    const [orders, accs, org] = await Promise.all([ordersFor(req, d.ids), CourierAccount.find({ organization: req.storeOrg, active: true }).sort({ isDefault: -1, name: 1 }), Organization.findById(req.org)]);
    // Log in once up front, so parallel checks share the session.
    for (const a of accs) if (CARRIERS[a.carrier].token) await CARRIERS[a.carrier].token(a).catch(() => {});
    const allItems = new Map((await Item.find({ _id: { $in: orders.flatMap((o) => o.lines.map((l) => l.item)).filter(Boolean) } }).lean()).map((i) => [String(i._id), i]));
    const out = [];
    const one = async (o) => {
      const lines = o.lines.filter((l) => l.quantity > 0).map((l) => ({ item: l.item ? String(l.item) : "", sku: l.sku || allItems.get(String(l.item))?.sku || "", title: l.variantTitle ? `${l.title} - ${l.variantTitle}` : l.title, quantity: l.quantity, packageType: allItems.get(String(l.item))?.packageType ? String(allItems.get(String(l.item)).packageType) : "" }));
      const base = { id: String(o._id), name: o.name, pincode: o.shippingAddress?.zip || "", city: o.shippingAddress?.city || "", cod: false, rows: [], lines };
      let p;
      try {
        p = await resolvePackage(o, d.pkg, req.storeOrg, allItems);
      } catch (e) {
        return { ...base, error: e.message };
      }
      if (!p) return { ...base, pkg: null, needsPackage: true };
      const s = shipmentFrom(o, org, p, allItems);
      // Rates from the seller's pickup pincode for a marketplace seller's order.
      let seller = null;
      let pickupNote = "";
      try {
        seller = await sellers.pickupFor(req.storeOrg, o, d.ids.length === 1 ? d.pickupFrom : "");
      } catch (e) {
        pickupNote = e.message;
      }
      const rows = sortQuotes(await Promise.all(accs.map((a) => quoteAccount(sellers.withPickup(a, seller), s))));
      const choices = [...new Map(o.lines.filter((l) => l.quantity > 0).map((l) => [l.vendor || "", l.vendor || ""])).keys()];
      return { ...base, pkg: p, cod: s.cod, codAmount: s.codAmount, rows, pickup: seller ? { seller: String(seller._id), name: seller.name, city: seller.pickup?.city || "", pincode: seller.pickup?.pincode || "" } : { own: true }, pickupNote, vendors: choices };
    };
    for (let i = 0; i < orders.length; i += 5) out.push(...(await Promise.all(orders.slice(i, i + 5).map(one))));
    // Several orders: per courier, how many it serves and the total.
    const summary = accs.map((a) => {
      const rs = out.map((o) => ({ o, r: o.rows.find((x) => x.account === String(a._id)) })).filter((x) => x.r);
      return {
        account: String(a._id),
        name: a.name,
        carrier: a.carrier,
        isDefault: !!a.isDefault,
        serviceable: rs.filter((x) => x.r.serviceable === true).length,
        unknown: rs.filter((x) => x.r.serviceable === null).length,
        notServiceable: rs.filter((x) => x.r.serviceable === false).map((x) => x.o.name),
        total: Math.round(rs.reduce((t, x) => t + (x.r.serviceable !== false ? x.r.charge || 0 : 0), 0) * 100) / 100,
        priced: rs.filter((x) => x.r.serviceable !== false && x.r.charge != null).length,
      };
    });
    const none = (s) => (s.serviceable + s.unknown === 0 ? 1 : 0);
    summary.sort((a, b) => none(a) - none(b) || b.serviceable + b.unknown - (a.serviceable + a.unknown) || (a.priced ? a.total : 1e12) - (b.priced ? b.total : 1e12));
    res.send({ orders: out, summary });
  })
);

router.post(
  "/orders/ship",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        ids: idsJoi,
        account: Joi.string().required().label("Courier"),
        pkg: pkgJoi,
        manual: Joi.object({ awb: Joi.string().allow(""), courierName: Joi.string().allow(""), courierId: Joi.string().allow("") }).default({}),
        invoiceFirst: Joi.boolean().default(false),
        skipCheck: Joi.boolean().default(false),
        pickupFrom: Joi.string().allow("").default(""), // "" automatic | "own" | "seller:<id>"
      }),
      req.body
    );
    const store = await storeOf(req, false);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        if (d.invoiceFirst && !o.invoice && store && o.channel !== "amazon" && o.channel !== "flipkart") await invoiceOrder(ctxOf(req), o, store).catch(() => {});
        const r = await bookOrder(ctxOf(req), o, { accountId: d.account, pkg: d.pkg, manual: d.ids.length === 1 ? d.manual : {}, skipCheck: d.skipCheck, pickupFrom: d.ids.length === 1 ? d.pickupFrom : "" });
        results.push({ id: o._id, name: o.name, ok: true, ...r });
      } catch (e) {
        await ShopifyOrder.updateOne({ _id: o._id }, { "shipment.error": e.message }).catch(() => {});
        results.push({ id: o._id, name: o.name, error: e.message });
      }
    }
    res.send({ results });
  })
);

router.post(
  "/orders/track",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi }), req.body);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        const t = await trackOrder(o);
        results.push({ id: o._id, name: o.name, ok: !!t, status: o.status, text: t?.text || "" });
      } catch (e) {
        results.push({ id: o._id, name: o.name, error: e.message });
      }
    }
    res.send({ results });
  })
);

const R = require("../utils/shopify/returns");
router.post(
  "/orders/return",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi, action: Joi.string().valid("create", "close").required(), note: Joi.string().allow("").max(250) }), req.body);
    const store = await storeOf(req, false);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        const r = d.action === "create" ? await R.markReturnCreated(ctxOf(req), o, store, d.note) : await R.markReturnClosed(ctxOf(req), o, store);
        results.push({ id: o._id, name: o.name, ok: true, text: r.already ? "Already closed" : r.creditNote ? `Credit note ${r.creditNote}` : "", warning: r.warning });
      } catch (e) {
        results.push({ id: o._id, name: o.name, error: e.message });
      }
    }
    res.send({ results });
  })
);

// Scan an AWB before handing the parcel to the courier: records when (internal record only, status unchanged).
router.post(
  "/orders/awb-scan",
  ah(async (req, res) => {
    const d = validate(Joi.object({ code: Joi.string().trim().allow(""), codes: Joi.array().items(Joi.string().trim().max(80)).max(10) }).or("code", "codes"), req.body);
    const codes = d.codes?.length ? d.codes : [d.code];
    const o = await R.findByCode(req.storeOrg, codes);
    if (!o) throw new HttpError(404, `No order with AWB or order number "${codes.join('" / "')}"`);
    const sh = o.shipment || {};
    const fmt = (t) => new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    const summary = { _id: o._id, name: o.name, customer: o.channel === "amazon" ? "" : o.customer?.name, awb: sh.awb, courier: sh.courierName, status: o.status, items: o.lines.filter((l) => l.quantity > 0).map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`) };
    if (o.status === "cancelled") throw new HttpError(400, `${o.name} is cancelled — don't hand it over`);
    if (!sh.awb) throw new HttpError(400, `${o.name} has no shipment booked`);
    if (["returned", "return_created", "rto"].includes(o.status)) throw new HttpError(400, `${o.name} is ${o.status.replace(/_/g, " ")} — not going out`);
    if (o.awbScannedAt && (o.awbScans || []).some((x) => x.awb === sh.awb)) return res.send({ order: summary, already: true, scannedAt: o.awbScannedAt, message: `${o.name} already scanned on ${fmt(o.awbScannedAt)}` });
    const now = new Date();
    o.awbScannedAt = now;
    o.awbScannedBy = req.user._id;
    o.awbScans = [...(o.awbScans || []), { awb: sh.awb, courier: sh.courierName || "", at: now, by: req.user._id, byName: req.user.name || "" }];
    await o.save();
    require("../utils/shopify/orderIndex").forget(req.storeOrg);
    res.send({ order: summary, scanned: true, scannedAt: now, message: `${o.name} scanned · ${sh.courierName || ""} ${sh.awb}`.trim() });
  })
);

// Scan an AWB or order number to close a return. Answers at once; Shopify + credit note finish in the background.
router.post(
  "/returns/scan",
  ah(async (req, res) => {
    const d = validate(Joi.object({ code: Joi.string().trim().allow(""), codes: Joi.array().items(Joi.string().trim().max(80)).max(10) }).or("code", "codes"), req.body);
    const codes = d.codes?.length ? d.codes : [d.code];
    const o = await R.findByCode(req.storeOrg, codes);
    if (!o) throw new HttpError(404, `No order with AWB or order number "${codes.join('" / "')}"`);
    const summary = { _id: o._id, name: o.name, customer: o.customer?.name, awb: o.shipment?.awb, courier: o.shipment?.courierName, total: o.total, items: o.lines.filter((l) => l.quantity > 0).map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`), image: o.lines.find((l) => l.image)?.image || "" };
    if (o.status === "returned" && o.returnSync?.state !== "error") return res.send({ order: summary, already: true, message: `${o.name} was already closed as returned${o.returnedAt ? ` on ${new Date(o.returnedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}` });
    const store = await storeOf(req, false);
    try {
      const r = await R.markReturnClosed(ctxOf(req), o, store, { background: true });
      res.send({ order: summary, closed: true, was: r.was, pending: true, message: `${o.name} return closed` });
    } catch (e) {
      throw new HttpError(400, `${o.name}: ${e.message}`);
    }
  })
);

// How the background Shopify return / credit note went, for the scan screen.
router.get(
  "/returns/:id/sync",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }, { returnSync: 1, name: 1 }).lean();
    if (!o) throw new HttpError(404, "Order not found");
    res.send(o.returnSync || { state: "done" });
  })
);

router.post(
  "/orders/:id/cancel-shipment",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!o) throw new HttpError(404, "Order not found");
    let r;
    try {
      r = await cancelShipment(o);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    res.send({ ...o.toObject(), shopifyNote: r?.shopify || "" });
  })
);

router.put(
  "/orders/:id/remarks",
  ah(async (req, res) => {
    const { remarks } = validate(Joi.object({ remarks: Joi.string().allow("").max(2000) }), req.body);
    await ShopifyOrder.updateOne({ _id: req.params.id, organization: req.storeOrg }, { remarks });
    res.send({ ok: true });
  })
);

// Payment proof (UPI / bank screenshots): kept here and sent to the Shopify order.
const proofBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "attachments" });
const proofScopeErr = (msg) => (/access|scope|permission|denied/i.test(msg) ? "Saved in OrdexaGo, but the Shopify app can't add files yet — add the write_files, read_files and write_orders scopes, release and reinstall the app, then click Retry" : msg);
async function proofToShopify(req, o, p) {
  const store = await ShopifyStore.findOne({ organization: req.storeOrg });
  if (!store?.connected) return (p.error = "Shopify store not connected");
  const chunks = [];
  await new Promise((resolve, reject) => proofBucket().openDownloadStream(p.fileId).on("data", (c) => chunks.push(c)).on("end", resolve).on("error", reject));
  try {
    const f = await require("../utils/shopify/paymentProof").sendToShopify(store, o, { name: p.name, type: p.type, buf: Buffer.concat(chunks), reference: p.reference, by: p.by });
    p.shopifyFileId = f.id;
    p.shopifyUrl = f.url;
    p.error = "";
  } catch (e) {
    p.error = proofScopeErr(e.message);
  }
}
// Without full Store: Orders access, only the person who created the order here, within 30 minutes of creating it.
function ownProofOk(req, o) {
  if ((req.perms?.store_orders || "none") === "full") return;
  const mine = o.createdBy && String(o.createdBy) === String(req.user?._id);
  const recent = o.createdAt && Date.now() - new Date(o.createdAt).getTime() < 30 * 60000;
  if (!mine || !recent) throw new HttpError(403, "Only an admin or staff with full Store: Orders access can change this order now");
}
const proofOut = (p) => ({ _id: p._id, name: p.name, type: p.type, size: p.size, reference: p.reference, by: p.by, at: p.at, inShopify: !!p.shopifyFileId, shopifyUrl: p.shopifyUrl, error: p.error });
router.get(
  "/orders/:id/payment-proofs",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }, { paymentProofs: 1 }).lean();
    if (!o) throw new HttpError(404, "Order not found");
    res.send((o.paymentProofs || []).map(proofOut));
  })
);
router.post(
  "/orders/:id/payment-proofs",
  ah(async (req, res) => {
    const d = validate(Joi.object({ name: Joi.string().max(200).required(), type: Joi.string().allow("").default(""), data: Joi.string().required(), reference: Joi.string().allow("").max(100).default("") }), req.body);
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!o) throw new HttpError(404, "Order not found");
    ownProofOk(req, o);
    if (!o.shopifyId || o.channel === "amazon" || o.channel === "flipkart") throw new HttpError(400, "Payment proof can be added to Shopify orders only");
    const buf = Buffer.from(d.data.replace(/^data:.*?;base64,/, ""), "base64");
    if (!buf.length) throw new HttpError(400, "The file is empty");
    if (buf.length > 10 * 1024 * 1024) throw new HttpError(400, "Files can be up to 10 MB");
    if (!/^(image\/|application\/pdf)/.test(d.type)) throw new HttpError(400, "Add a screenshot (image) or a PDF");
    const fileId = new mongoose.Types.ObjectId();
    const { Readable } = require("stream");
    await new Promise((resolve, reject) => Readable.from(buf).pipe(proofBucket().openUploadStreamWithId(fileId, d.name, { metadata: { organization: req.storeOrg, type: d.type } })).on("finish", resolve).on("error", reject));
    o.paymentProofs.push({ fileId, name: d.name, type: d.type, size: buf.length, reference: d.reference.trim(), by: req.user?.name || "", at: new Date() });
    const p = o.paymentProofs[o.paymentProofs.length - 1];
    await proofToShopify(req, o, p);
    await ShopifyOrder.updateOne({ _id: o._id }, { paymentProofs: o.paymentProofs });
    await audit.log(req, "payment_proof_add", { target: o.name, meta: { name: d.name, reference: d.reference, shopify: !p.error } });
    res.status(201).send(proofOut(p));
  })
);
router.post(
  "/orders/:id/payment-proofs/:pid/retry",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg });
    const p = o?.paymentProofs.id(req.params.pid);
    if (!p) throw new HttpError(404, "Not found");
    ownProofOk(req, o);
    if (!p.shopifyFileId) await proofToShopify(req, o, p);
    await ShopifyOrder.updateOne({ _id: o._id }, { paymentProofs: o.paymentProofs });
    res.send(proofOut(p));
  })
);
router.get(
  "/orders/:id/payment-proofs/:pid/file",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }, { paymentProofs: 1 });
    const p = o?.paymentProofs.id(req.params.pid);
    if (!p) throw new HttpError(404, "Not found");
    res.setHeader("Content-Type", p.type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(p.name)}"`);
    proofBucket().openDownloadStream(p.fileId).on("error", () => res.status(404).end()).pipe(res);
  })
);

// B2B: the buyer's GSTIN (blank = back to B2C). Not invoiced yet → the invoice goes to the registered customer.
// Already invoiced → the invoice is moved to that customer (GSTR-1 moves it from B2C to B2B, or back).
router.put(
  "/orders/:id/b2b",
  ah(async (req, res) => {
    const d = validate(Joi.object({ gstin: Joi.string().trim().uppercase().allow(""), name: Joi.string().trim().max(200).allow("") }), req.body);
    const { gstinOk, customerFor } = require("../utils/shopify/invoice");
    if (d.gstin && !gstinOk(d.gstin)) throw new HttpError(400, `${d.gstin} isn't a valid GSTIN (check the 15 characters)`);
    if (d.gstin && !d.name) throw new HttpError(400, "Enter the buyer's registered business name");
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!o) throw new HttpError(404, "Order not found");
    o.b2b = d.gstin ? { gstin: d.gstin, name: d.name, at: new Date(), by: req.user._id } : undefined;
    let moved = null;
    if (o.invoice) {
      const invOrg = o.invoiceOrg || req.storeOrg;
      const Organization = require("../models/Organization");
      const org = await Organization.findById(invOrg);
      const c = await customerFor(invOrg, o, org);
      try {
        moved = await require("../utils/cashSale").changeCustomer({ org: invOrg, user: req.user }, o.invoice, c._id);
      } catch (e) {
        throw new HttpError(400, `GSTIN not saved: invoice ${o.invoiceNumber} couldn't be moved to ${c.displayName} — ${e.message}`);
      }
    }
    await o.save();
    res.send({ ok: true, b2b: o.b2b || null, invoiceNumber: o.invoiceNumber || "", movedTo: moved ? moved.invoice.customerName : "" });
  })
);

// Labels: the courier's own label when there is one (single order), otherwise OrdexaGo's 4x6 label (any number of orders).
router.get(
  "/orders/:id/label",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }).select("+shipment.labelPdf");
    if (!o) throw new HttpError(404, "Order not found");
    if (o.channel === "amazon") await devices.requireApproved(req, `Amazon label (${o.name})`);
    if (o.shipment?.carrier === "amazon_easyship" && !o.shipment.labelPdf?.length) {
      // Amazon's Easy Ship label: fetched from Amazon on first use.
      let r;
      try {
        r = await require("../utils/amazon/ship").fetchLabel(o);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      if (r.state !== "ready") throw new HttpError(409, r.message);
    }
    // Flipkart logistics: Flipkart's own label + invoice.
    if (o.channel === "flipkart" && (!o.shipment?.account || o.shipment?.carrier === "flipkart")) {
      let buf;
      try {
        buf = await require("../utils/flipkart/orders").label(o);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="flipkart-${o.name}.pdf"`);
      return res.send(buf);
    }
    if (!o.shipment?.awb && o.shipment?.carrier !== "amazon_easyship") throw new HttpError(400, "Book a courier first");
    if (o.channel === "amazon") await devices.amazonData(req, "amazon_label_download", o.name, { orderId: String(o._id), carrier: o.shipment?.carrier || "" });
    await require("../utils/shopify/labelOut").sendLabel(res, o, { org: req.org, storeOrg: req.storeOrg, own: req.query.own === "1" });
  })
);

router.post(
  "/orders/labels",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi, format: Joi.string().valid("4x6", "a4").allow("") }), req.body);
    const all = await ordersFor(req, d.ids);
    // Easy Ship parcels carry Amazon's own label (open it from the order), never OrdexaGo's.
    const orders = all.filter((o) => o.shipment?.awb && o.shipment.carrier !== "amazon_easyship");
    if (!orders.length) throw new HttpError(400, all.some((o) => o.shipment?.carrier === "amazon_easyship") ? "Easy Ship orders use Amazon's label — open it from each order" : "None of these orders has a shipment booked");
    const org = await Organization.findById(req.org);
    const accs = new Map((await CourierAccount.find({ organization: req.storeOrg })).map((a) => [String(a._id), a]));
    const amz = orders.filter((o) => o.channel === "amazon");
    if (amz.length) await devices.amazonData(req, "amazon_label_download", amz.length === 1 ? amz[0].name : `${amz.length} orders`, { count: amz.length, total: orders.length });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="labels.pdf"`);
    res.send(await labelsPdf(orders, org, accs, d.format));
  })
);

/* ---------------- items created from Shopify ---------------- */
router.get(
  "/items/review",
  ah(async (req, res) => {
    res.send(await Item.find({ organization: req.org, needsReview: true }).select("name sku hsnSac taxRate reviewNote").sort({ name: 1 }).limit(500).lean());
  })
);
router.post(
  "/items/:id/reviewed",
  ah(async (req, res) => {
    await Item.updateOne({ _id: req.params.id, organization: req.org }, { needsReview: false });
    res.send({ ok: true });
  })
);
// Try the GST rules on a product name (settings page preview).
router.post(
  "/rules/test",
  ah(async (req, res) => {
    const d = validate(Joi.object({ title: Joi.string().allow(""), productType: Joi.string().allow(""), hsn: Joi.string().allow(""), shopifyTaxRate: Joi.number().allow(null), rules: Joi.array().items(ruleJoi) }), req.body);
    const store = (await storeOf(req, false)) || { rules: DEFAULT_RULES };
    res.send(checkGst({ title: d.title, productType: d.productType, hsn: (d.hsn || "").replace(/\D/g, ""), shopifyTaxRate: d.shopifyTaxRate ?? null }, { ...store.toObject?.() || store, rules: d.rules || store.rules }));
  })
);

/* ---------------- courier accounts ---------------- */
router.get(
  "/couriers",
  ah(async (req, res) => {
    res.send(await CourierAccount.find({ organization: req.storeOrg }).sort({ isDefault: -1, name: 1 }));
  })
);

const courierJoi = Joi.object({
  carrier: Joi.string().valid(...Object.keys(CARRIERS)).required(),
  name: Joi.string().trim().required().label("Name"),
  active: Joi.boolean(),
  isDefault: Joi.boolean(),
  test: Joi.boolean(),
  baseUrl: Joi.string().trim().allow("").uri({ scheme: ["https", "http"] }).label("API address"),
  credentials: Joi.object().pattern(Joi.string(), Joi.string().allow("")),
  options: Joi.object().pattern(Joi.string(), Joi.alternatives(Joi.string().allow(""), Joi.boolean(), Joi.number())),
  pickup: Joi.object({ name: Joi.string().allow(""), phone: Joi.string().allow(""), address: Joi.string().allow(""), city: Joi.string().allow(""), state: Joi.string().allow(""), pincode: Joi.string().allow("") }),
  trackingUrl: Joi.string().trim().allow(""),
  rateCard: Joi.object({ enabled: Joi.boolean() }).unknown(true), // same format as the Maganova calculator (see utils/couriers/rates.js)
});

async function saveCourier(req, acc) {
  const d = validate(courierJoi, req.body);
  const creds = { ...(acc.credentials || {}) };
  for (const [k, v] of Object.entries(d.credentials || {})) if (v) creds[k] = v.trim(); // blank = keep
  Object.assign(acc, { ...d, credentials: creds });
  acc.markModified("credentials");
  acc.markModified("rateCard");
  acc.markModified("options");
  acc.token = "";
  if (d.isDefault) await CourierAccount.updateMany({ organization: req.storeOrg, _id: { $ne: acc._id } }, { isDefault: false });
  await acc.save();
  return acc;
}
router.post(
  "/couriers",
  ah(async (req, res) => {
    ownerOnly(req);
    res.send(await saveCourier(req, new CourierAccount({ organization: req.org })));
  })
);
router.put(
  "/couriers/:id",
  ah(async (req, res) => {
    const acc = await CourierAccount.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!acc) throw new HttpError(404, "Courier not found");
    res.send(await saveCourier(req, acc));
  })
);
router.delete(
  "/couriers/:id",
  ah(async (req, res) => {
    ownerOnly(req);
    await CourierAccount.updateOne({ _id: req.params.id, organization: req.org }, { active: false, isDefault: false });
    res.send({ ok: true });
  })
);
// Check the credentials by logging in (carriers with a login step) or a tracking call.
router.post(
  "/couriers/:id/test",
  ah(async (req, res) => {
    const acc = await CourierAccount.findOne({ _id: req.params.id, organization: req.storeOrg });
    if (!acc) throw new HttpError(404, "Courier not found");
    const c = CARRIERS[acc.carrier];
    try {
      acc.token = "";
      if (c.token) await c.token.call(c, acc);
      else if (acc.carrier === "custom") return res.send({ message: "Custom couriers don't need a connection" });
      else {
        const miss = c.fields.credentials.filter((k) => !acc.credentials?.[k] && !/^track/.test(k));
        if (miss.length) throw new Error(`Add ${miss.join(", ")}`);
        return res.send({ message: "Credentials saved. They're checked when you book the first shipment." });
      }
      res.send({ message: `Connected to ${c.title}` });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);

/* ---------------- courier pincode lists + rate calculator ---------------- */
const courierOf = async (req) => {
  const acc = await CourierAccount.findOne({ _id: req.params.id, organization: req.storeOrg });
  if (!acc) throw new HttpError(404, "Courier not found");
  return acc;
};
router.get(
  "/couriers/:id/pincodes",
  ah(async (req, res) => {
    const acc = await courierOf(req);
    const counts = await CourierPincode.aggregate([{ $match: { account: acc._id } }, { $group: { _id: { kind: "$kind", zone: "$zone" }, n: { $sum: 1 } } }]);
    const out = { zone: 0, edl: 0, ecc: 0, zones: {} };
    for (const c of counts) {
      out[c._id.kind] += c.n;
      if (c._id.kind === "zone") out.zones[c._id.zone] = c.n;
    }
    res.send(out);
  })
);
router.post(
  "/couriers/:id/pincodes",
  ah(async (req, res) => {
    const d = validate(Joi.object({ kind: Joi.string().valid("zone", "edl", "ecc").required(), replace: Joi.boolean().default(false), rows: Joi.array().items(Joi.object({ pincode: Joi.string().required(), zone: Joi.string().allow("") })).max(20000).required() }), req.body);
    const acc = await courierOf(req);
    if (d.replace) await CourierPincode.deleteMany({ account: acc._id, kind: d.kind });
    const seen = new Set();
    const rows = [];
    for (const r of d.rows) {
      const pin = String(r.pincode).replace(/\D/g, "");
      if (!/^\d{6}$/.test(pin) || seen.has(pin)) continue;
      if (d.kind === "zone" && !String(r.zone || "").trim()) continue;
      seen.add(pin);
      rows.push({ organization: req.storeOrg, account: acc._id, kind: d.kind, pincode: pin, zone: String(r.zone || "").trim() });
    }
    if (!d.replace && rows.length) await CourierPincode.deleteMany({ account: acc._id, kind: d.kind, pincode: { $in: rows.map((r) => r.pincode) } });
    for (let i = 0; i < rows.length; i += 2000) await CourierPincode.insertMany(rows.slice(i, i + 2000), { ordered: false });
    res.send({ added: rows.length, skipped: d.rows.length - rows.length });
  })
);
router.delete(
  "/couriers/:id/pincodes/:kind",
  ah(async (req, res) => {
    const acc = await courierOf(req);
    const r = await CourierPincode.deleteMany({ account: acc._id, kind: req.params.kind });
    res.send({ deleted: r.deletedCount });
  })
);
// Rate calculator: every active courier (or chosen ones) for a pincode, weight and size.
router.post(
  "/couriers/calculate",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        to: Joi.string().pattern(/^\d{6}$/).required().label("Destination pincode"),
        weight: Joi.number().greater(0).required().label("Weight"),
        length: Joi.number().min(0).default(0),
        breadth: Joi.number().min(0).default(0),
        height: Joi.number().min(0).default(0),
        value: Joi.number().min(0).default(0),
        cod: Joi.boolean().default(false),
        accounts: Joi.array().items(Joi.string()).default([]),
      }),
      req.body
    );
    const accs = await CourierAccount.find({ organization: req.storeOrg, active: true, ...(d.accounts.length ? { _id: { $in: d.accounts } } : {}) });
    for (const a of accs) if (CARRIERS[a.carrier].token) await CARRIERS[a.carrier].token(a).catch(() => {});
    const { locatePincode } = require("../utils/couriers/rates");
    const loc = await locatePincode(d.to);
    const s = { consignee: { pincode: d.to, city: loc.district || "", state: "" }, weight: d.weight, length: d.length, breadth: d.breadth, height: d.height, cod: d.cod, codAmount: d.cod ? d.value : 0, value: d.value };
    res.send({ destination: loc, rows: sortQuotes(await Promise.all(accs.map((a) => quoteAccount(a, s)))) });
  })
);

/* ---------------- package types ---------------- */
const ptJoi = Joi.object({ name: Joi.string().trim().required().label("Name"), weight: Joi.number().greater(0).required().label("Weight"), length: Joi.number().greater(0).required().label("Length"), breadth: Joi.number().greater(0).required().label("Breadth"), height: Joi.number().greater(0).required().label("Height"), active: Joi.boolean(), items: Joi.array().items(Joi.string()).max(2000) });
const itemOrgs = (req) => [req.org, req.storeOrg];
// List, with search by name, size or the SKU / name of a product using it (filtered here: the list is small).
router.get(
  "/package-types",
  ah(async (req, res) => {
    const rows = await PackageType.find({ organization: req.storeOrg, active: true }).sort({ name: 1 }).lean();
    const ids = rows.map((r) => r._id);
    const used = ids.length ? await Item.find({ organization: { $in: itemOrgs(req) }, packageType: { $in: ids } }, { packageType: 1, sku: 1, name: 1, shopifyLinks: 1 }).lean() : [];
    const by = new Map();
    for (const it of used) {
      const k = String(it.packageType);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ _id: it._id, sku: it.sku || "", name: it.name, links: (it.shopifyLinks || []).map((l) => l.sku).filter(Boolean) });
    }
    const q = String(req.query.q || "").trim().toLowerCase();
    const hit = (r) => {
      if (!q) return true;
      const prods = by.get(String(r._id)) || [];
      const text = [r.name, `${r.length}x${r.breadth}x${r.height}`, `${r.length}×${r.breadth}×${r.height}`, ...prods.flatMap((p) => [p.sku, p.name, ...p.links])].join(" ").toLowerCase();
      const n = Number(q);
      return q.split(/\s+/).every((w) => text.includes(w)) || (n > 0 && [r.weight, r.length, r.breadth, r.height].includes(n));
    };
    res.send(
      rows.filter(hit).map((r) => {
        const prods = (by.get(String(r._id)) || []).map(({ links, ...p }) => p);
        return { ...r, items: prods.length, products: prods.slice(0, 50) };
      })
    );
  })
);
// Create; optionally give it to products straight away (e.g. from the booking screen).
router.post(
  "/package-types",
  ah(async (req, res) => {
    const { items, ...d } = validate(ptJoi, req.body);
    const pt = await PackageType.create({ ...d, organization: req.storeOrg });
    let assigned = 0;
    if (items?.length) assigned = (await Item.updateMany({ _id: { $in: items }, organization: { $in: itemOrgs(req) } }, { packageType: pt._id })).modifiedCount;
    res.send({ ...pt.toObject(), assigned });
  })
);
router.put(
  "/package-types/:id",
  ah(async (req, res) => {
    const { items, ...d } = validate(ptJoi, req.body);
    void items;
    const pt = await PackageType.findOneAndUpdate({ _id: req.params.id, organization: req.storeOrg }, d, { new: true });
    if (!pt) throw new HttpError(404, "Package type not found");
    res.send(pt);
  })
);
router.delete(
  "/package-types/:id",
  ah(async (req, res) => {
    const pt = await PackageType.findOneAndUpdate({ _id: req.params.id, organization: req.storeOrg }, { active: false });
    if (!pt) throw new HttpError(404, "Package type not found");
    await Item.updateMany({ packageType: pt._id }, { packageType: null });
    res.send({ ok: true });
  })
);
// Set (or clear, with packageType null) the package type of products.
router.post(
  "/package-types/assign",
  ah(async (req, res) => {
    const d = validate(Joi.object({ items: Joi.array().items(Joi.string()).min(1).max(2000).required(), packageType: Joi.string().allow(null, "") }), req.body);
    let pt = null;
    if (d.packageType) {
      pt = await PackageType.findOne({ _id: d.packageType, organization: req.storeOrg, active: true });
      if (!pt) throw new HttpError(404, "Package type not found");
    }
    const r = await Item.updateMany({ _id: { $in: d.items }, organization: { $in: itemOrgs(req) } }, { packageType: pt ? pt._id : null });
    res.send({ updated: r.modifiedCount });
  })
);

// Which permission a request needs: returns, shipping, settings, or orders.
router.moduleOf = function (req) {
  const p = req.path;
  if (/^\/new-order/.test(p)) return "store_orders.new_order";
  if (/^\/abandoned-checkouts/.test(p)) return "store_orders.abandoned";
  // Payment proof: full store_orders, or the order taker on an order they just created (checked in the route).
  if (/^\/orders\/[^/]+\/payment-proofs/.test(p)) return ["store_orders", "store_orders.new_order"];
  if (/^\/returns\/|^\/orders\/return$/.test(p)) return "store_returns";
  if (/^\/orders\/(ship|track|labels)$|^\/orders\/[^/]+\/(label|cancel-shipment)$/.test(p)) return "store_shipping";
  if (p === "/orders/quotes" || p === "/couriers/calculate") return ["store_orders", "store_shipping", "store_settings"];
  if (/^\/couriers\/[^/]+\/pincodes/.test(p)) return req.method === "GET" ? ["store_shipping", "store_settings"] : "store_settings";
  if (/^\/package-types/.test(p)) return ["store_shipping", "store_settings", "store_orders"];
  if (/^\/couriers/.test(p)) return req.method === "GET" ? ["store_shipping", "store_settings"] : "store_settings";
  if (/^\/(store|locations|rules)/.test(p) && req.method !== "GET") return "store_settings";
  if (/^\/(store|locations)/.test(p)) return ["store_settings", "store_orders", "store_shipping", "store_returns"];
  return "store_orders";
};
module.exports = router;
