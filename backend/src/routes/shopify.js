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
    if (!s) s = new ShopifyStore({ organization: req.org });
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
function filterOf(req) {
  const q = req.query;
  const f = { organization: req.storeOrg };
  if (q.status && q.status !== "all") f.status = q.status;
  if (q.from || q.to) {
    f.orderDate = {};
    if (q.from) f.orderDate.$gte = new Date(`${q.from}T00:00:00+05:30`);
    if (q.to) f.orderDate.$lte = new Date(`${q.to}T23:59:59.999+05:30`);
  }
  if (q.payment) f.paymentMode = q.payment;
  if (q.financial) f.financialStatus = q.financial;
  if (q.fulfillment) f.fulfillmentStatus = q.fulfillment;
  if (q.state) f["shippingAddress.state"] = q.state;
  if (q.courier) f["shipment.account"] = mongoose.isValidObjectId(q.courier) ? new mongoose.Types.ObjectId(q.courier) : q.courier;
  if (q.invoiced === "yes") f.invoice = { $exists: true, $ne: null };
  if (q.invoiced === "no") f.$or = [{ invoice: { $exists: false } }, { invoice: null }];
  if (q.tag) f.tags = new RegExp(`^${esc(q.tag)}$`, "i");
  if (q.min || q.max) {
    f.total = {};
    if (q.min) f.total.$gte = Number(q.min);
    if (q.max) f.total.$lte = Number(q.max);
  }
  if (q.q) {
    const rx = new RegExp(esc(q.q.trim().replace(/^#/, "")), "i");
    const digits = q.q.replace(/\D/g, "");
    const or = [{ name: rx }, { "customer.name": rx }, { "customer.email": rx }, { "customer.phone": rx }, { "shippingAddress.phone": rx }, { "shippingAddress.zip": rx }, { "shippingAddress.city": rx }, { "shipment.awb": rx }, { "lines.sku": rx }, { "lines.title": rx }, { invoiceNumber: rx }];
    if (digits && digits.length <= 9) or.push({ orderNumber: Number(digits) });
    f.$and = [...(f.$and || []), { $or: or }];
  }
  return f;
}

router.get(
  "/orders",
  ah(async (req, res) => {
    const f = filterOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const sort = { oldest: { orderDate: 1 }, amount: { total: -1 }, newest: { orderDate: -1 } }[req.query.sort] || { orderDate: -1 };
    const countFilter = { ...f };
    delete countFilter.status;
    const [rows, total, byStatus] = await Promise.all([
      ShopifyOrder.find(f, { "lines.title": 1, "lines.variantTitle": 1, "lines.quantity": 1, "lines.sku": 1, "lines.image": 1, prepaidAmount: 1, codAmount: 1, name: 1, orderNumber: 1, orderDate: 1, customer: 1, "shippingAddress.city": 1, "shippingAddress.state": 1, "shippingAddress.zip": 1, "shippingAddress.province": 1, paymentMode: 1, financialStatus: 1, fulfillmentStatus: 1, total: 1, status: 1, "shipment.courierName": 1, "shipment.awb": 1, "shipment.trackStatus": 1, "shipment.trackingUrl": 1, "shipment.carrier": 1, "shipment.account": 1, invoice: 1, invoiceNumber: 1, invoiceOrg: 1, tags: 1, cancelledAt: 1 })
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ShopifyOrder.countDocuments(f),
      ShopifyOrder.aggregate([{ $match: countFilter }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const b of byStatus) counts[b._id] = b.n;
    counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
    res.send({ rows, total, page, limit, counts });
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
    const rows = await ShopifyOrder.find(filterOf(req)).sort({ orderDate: -1 }).limit(20000).lean();
    const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Order", "Date", "Customer", "Phone", "Email", "City", "State", "Pincode", "Payment", "Financial status", "Status", "Items", "Total", "Courier", "AWB", "Invoice"];
    const out = [head.map(csv).join(",")];
    for (const o of rows)
      out.push(
        [o.name, new Date(o.orderDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), o.customer?.name, o.customer?.phone || o.shippingAddress?.phone, o.customer?.email, o.shippingAddress?.city, o.shippingAddress?.province, o.shippingAddress?.zip, o.paymentMode === "cod" ? "COD" : o.paymentMode === "partial" ? `Partly paid (${o.prepaidAmount} online, ${o.codAmount} COD)` : "Prepaid", o.financialStatus, o.status, (o.lines || []).map((l) => `${l.quantity} x ${l.title}${l.sku ? ` (${l.sku})` : ""}`).join("; "), o.total, o.shipment?.courierName, o.shipment?.awb, o.invoiceNumber]
          .map(csv)
          .join(",")
      );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shopify-orders.csv"`);
    res.send("﻿" + out.join("\r\n"));
  })
);

router.get(
  "/orders/:id",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }).populate("lines.item", "name sku hsnSac taxRate needsReview reviewNote trackInventory").lean();
    if (!o) throw new HttpError(404, "Order not found");
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
    const store = await storeOf(req);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        const r = await invoiceOrder(ctxOf(req), o, store);
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
    const d = validate(Joi.object({ ids: Joi.array().items(Joi.string()).min(1).max(50).required(), pkg: pkgJoi }), req.body);
    const [orders, accs, org] = await Promise.all([ordersFor(req, d.ids), CourierAccount.find({ organization: req.storeOrg, active: true }).sort({ isDefault: -1, name: 1 }), Organization.findById(req.org)]);
    // Log in once up front, so parallel checks share the session.
    for (const a of accs) if (CARRIERS[a.carrier].token) await CARRIERS[a.carrier].token(a).catch(() => {});
    const allItems = new Map((await Item.find({ _id: { $in: orders.flatMap((o) => o.lines.map((l) => l.item)).filter(Boolean) } }).lean()).map((i) => [String(i._id), i]));
    const out = [];
    const one = async (o) => {
      const base = { id: String(o._id), name: o.name, pincode: o.shippingAddress?.zip || "", city: o.shippingAddress?.city || "", cod: false, rows: [] };
      let p;
      try {
        p = await resolvePackage(o, d.pkg, req.storeOrg, allItems);
      } catch (e) {
        return { ...base, error: e.message };
      }
      if (!p) return { ...base, pkg: null, needsPackage: true };
      const s = shipmentFrom(o, org, p, allItems);
      const rows = sortQuotes(await Promise.all(accs.map((a) => quoteAccount(a, s))));
      return { ...base, pkg: p, cod: s.cod, codAmount: s.codAmount, rows };
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
      }),
      req.body
    );
    const store = await storeOf(req, false);
    const results = [];
    for (const o of await ordersFor(req, d.ids)) {
      try {
        if (d.invoiceFirst && !o.invoice && store) await invoiceOrder(ctxOf(req), o, store).catch(() => {});
        const r = await bookOrder(ctxOf(req), o, { accountId: d.account, pkg: d.pkg, manual: d.ids.length === 1 ? d.manual : {}, skipCheck: d.skipCheck });
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
    try {
      await cancelShipment(o);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    res.send(o);
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

// Labels: the courier's own label when there is one (single order), otherwise OrdexaGo's 4x6 label (any number of orders).
router.get(
  "/orders/:id/label",
  ah(async (req, res) => {
    const o = await ShopifyOrder.findOne({ _id: req.params.id, organization: req.storeOrg }).select("+shipment.labelPdf");
    if (!o) throw new HttpError(404, "Order not found");
    if (!o.shipment?.awb) throw new HttpError(400, "Book a courier first");
    if (req.query.own !== "1") {
      if (o.shipment.labelPdf?.length) {
        res.setHeader("Content-Type", "application/pdf");
        return res.send(o.shipment.labelPdf);
      }
      const acc = o.shipment.account ? await CourierAccount.findById(o.shipment.account) : null;
      if (acc) {
        try {
          const l = await CARRIERS[acc.carrier].label(acc, o.shipment);
          if (l?.url) return res.send({ url: l.url });
          if (l?.pdf) {
            res.setHeader("Content-Type", "application/pdf");
            return res.send(l.pdf);
          }
        } catch {}
      }
      if (o.shipment.labelUrl) return res.send({ url: o.shipment.labelUrl });
    }
    const org = await Organization.findById(req.org);
    const accs = new Map((await CourierAccount.find({ organization: req.storeOrg })).map((a) => [String(a._id), a]));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="label-${o.name.replace("#", "")}.pdf"`);
    res.send(await labelsPdf([o], org, accs));
  })
);

router.post(
  "/orders/labels",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ids: idsJoi, format: Joi.string().valid("4x6", "a4").allow("") }), req.body);
    const orders = (await ordersFor(req, d.ids)).filter((o) => o.shipment?.awb);
    if (!orders.length) throw new HttpError(400, "None of these orders has a shipment booked");
    const org = await Organization.findById(req.org);
    const accs = new Map((await CourierAccount.find({ organization: req.storeOrg })).map((a) => [String(a._id), a]));
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
const ptJoi = Joi.object({ name: Joi.string().trim().required().label("Name"), weight: Joi.number().greater(0).required().label("Weight"), length: Joi.number().greater(0).required().label("Length"), breadth: Joi.number().greater(0).required().label("Breadth"), height: Joi.number().greater(0).required().label("Height"), active: Joi.boolean() });
router.get(
  "/package-types",
  ah(async (req, res) => {
    const rows = await PackageType.find({ organization: req.storeOrg, active: true }).sort({ name: 1 }).lean();
    const counts = await Item.aggregate([{ $match: { packageType: { $in: rows.map((r) => r._id) } } }, { $group: { _id: "$packageType", n: { $sum: 1 } } }]);
    const by = new Map(counts.map((c) => [String(c._id), c.n]));
    res.send(rows.map((r) => ({ ...r, items: by.get(String(r._id)) || 0 })));
  })
);
router.post(
  "/package-types",
  ah(async (req, res) => {
    ownerOnly(req);
    res.send(await PackageType.create({ ...validate(ptJoi, req.body), organization: req.storeOrg }));
  })
);
router.put(
  "/package-types/:id",
  ah(async (req, res) => {
    ownerOnly(req);
    const pt = await PackageType.findOneAndUpdate({ _id: req.params.id, organization: req.storeOrg }, validate(ptJoi, req.body), { new: true });
    if (!pt) throw new HttpError(404, "Package type not found");
    res.send(pt);
  })
);
router.delete(
  "/package-types/:id",
  ah(async (req, res) => {
    ownerOnly(req);
    const pt = await PackageType.findOneAndUpdate({ _id: req.params.id, organization: req.storeOrg }, { active: false });
    if (!pt) throw new HttpError(404, "Package type not found");
    await Item.updateMany({ packageType: pt._id }, { packageType: null });
    res.send({ ok: true });
  })
);
// Give several items a package type at once.
router.post(
  "/package-types/:id/assign",
  ah(async (req, res) => {
    const d = validate(Joi.object({ items: Joi.array().items(Joi.string()).min(1).max(2000).required() }), req.body);
    const pt = await PackageType.findOne({ _id: req.params.id, organization: req.storeOrg, active: true });
    if (!pt) throw new HttpError(404, "Package type not found");
    const r = await Item.updateMany({ _id: { $in: d.items }, organization: req.org }, { packageType: pt._id });
    res.send({ updated: r.modifiedCount });
  })
);

// Which permission a request needs: returns, shipping, settings, or orders.
router.moduleOf = function (req) {
  const p = req.path;
  if (/^\/returns\/|^\/orders\/return$/.test(p)) return "store_returns";
  if (/^\/orders\/(ship|track|labels)$|^\/orders\/[^/]+\/(label|cancel-shipment)$/.test(p)) return "store_shipping";
  if (p === "/orders/quotes" || p === "/couriers/calculate") return ["store_orders", "store_shipping", "store_settings"];
  if (/^\/couriers\/[^/]+\/pincodes/.test(p)) return req.method === "GET" ? ["store_shipping", "store_settings"] : "store_settings";
  if (/^\/package-types/.test(p)) return req.method === "GET" ? ["store_shipping", "store_settings", "store_orders"] : /assign$/.test(p) ? ["store_settings", "store_shipping"] : "store_settings";
  if (/^\/couriers/.test(p)) return req.method === "GET" ? ["store_shipping", "store_settings"] : "store_settings";
  if (/^\/(store|locations|rules)/.test(p) && req.method !== "GET") return "store_settings";
  if (/^\/(store|locations)/.test(p)) return ["store_settings", "store_orders", "store_shipping", "store_returns"];
  return "store_orders";
};
module.exports = router;
