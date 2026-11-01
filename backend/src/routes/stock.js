/**
 * Inventory management: stock per item with racks, Shopify reservations, buffer and virtual stock,
 * Shopify links, racks and put-away. Mounted at /api/stock.
 */
const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const { ah, validate, HttpError } = require("../utils/http");
const Item = require("../models/Item");
const Rack = require("../models/Rack");
const RackMove = require("../models/RackMove");
const ShopifyOrder = require("../models/ShopifyOrder");
const ShopifyStore = require("../models/ShopifyStore");
const { stockView } = require("../utils/stockview");
const inv = require("../utils/shopify/inventory");

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

router.get(
  "/",
  ah(async (req, res) => {
    const { rows, store, racks, warehouses } = await stockView(req.org);
    const q = req.query;
    let list = rows.filter((r) => r.active || q.inactive === "1");
    if (q.q) {
      const rx = new RegExp(esc(q.q.trim()), "i");
      list = list.filter((r) => rx.test(r.name) || rx.test(r.sku) || rx.test(r.hsnSac) || r.links.some((l) => rx.test(l.sku) || rx.test(l.title)) || r.racks.some((x) => rx.test(x.code)));
    }
    if (q.category) list = list.filter((r) => r.category === q.category);
    if (q.rack) list = list.filter((r) => r.racks.some((x) => x.rack === q.rack));
    if (q.sync === "on") list = list.filter((r) => r.shopifySync && (r.shopifyVariantId || r.links.length));
    if (q.sync === "off") list = list.filter((r) => !r.shopifySync);
    if (q.linked === "yes") list = list.filter((r) => r.links.length);
    const tabs = {
      all: (r) => true,
      in: (r) => r.trackInventory && r.onHand > 0,
      out: (r) => r.trackInventory && r.onHand <= 0,
      virtual: (r) => r.virtual > 0,
      oversold: (r) => r.oversold,
    };
    const counts = Object.fromEntries(Object.entries(tabs).map(([k, f]) => [k, list.filter(f).length]));
    list = list.filter(tabs[q.tab] || tabs.all);
    const sort = { name: (a, b) => a.name.localeCompare(b.name), stock: (a, b) => b.onHand - a.onHand, sku: (a, b) => (a.sku || "").localeCompare(b.sku || "") }[q.sort] || ((a, b) => (a.sku || a.name).localeCompare(b.sku || b.name, undefined, { numeric: true }));
    list.sort(sort);
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Number(q.limit) || 50);
    const totals = { onHand: list.reduce((s, r) => s + r.onHand, 0), value: Math.round(list.reduce((s, r) => s + r.value, 0) * 100) / 100 };
    res.send({
      rows: list.slice((page - 1) * limit, page * limit),
      total: list.length,
      page,
      limit,
      counts,
      totals,
      categories: [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
      racks,
      warehouses: warehouses.map((w) => ({ _id: w._id, name: w.name, primary: w.primary })),
      sync: store ? { on: !!store.inventorySync, location: store.locationName, status: store.pushStatus, connected: !!store.connected } : { on: false },
    });
  })
);

router.get(
  "/export",
  ah(async (req, res) => {
    const { rows } = await stockView(req.org);
    const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [["SKU", "Name", "HSN", "GST %", "Category", "In stock", "Blocked", "Buffer", "Virtual", "Shopify qty", "Racks", "Value", "Purchase price", "Weight kg", "Linked Shopify SKUs"].map(csv).join(",")];
    for (const r of rows) out.push([r.sku, r.name, r.hsnSac, r.taxRate, r.category, r.onHand, r.blocked, r.buffer, r.virtual, r.shopify ?? "", r.racks.map((x) => `${x.code}:${x.qty}`).join(" "), r.value, r.purchaseRate, r.weight, r.links.map((l) => l.sku || l.title).join(" ")].map(csv).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="inventory.csv"');
    res.send("﻿" + out.join("\r\n"));
  })
);

/* ---------------- racks ---------------- */
router.get(
  "/racks",
  ah(async (req, res) => {
    res.send(await Rack.find({ organization: req.org }).sort({ code: 1 }).lean());
  })
);
router.post(
  "/racks",
  ah(async (req, res) => {
    const d = validate(Joi.object({ codes: Joi.string().required().label("Rack codes"), warehouse: Joi.string().allow(null, ""), name: Joi.string().allow("") }), req.body);
    // "A1, A2" or a range "A1-A20"
    const codes = [];
    for (const part of d.codes.split(/[\s,;]+/).filter(Boolean)) {
      const m = part.match(/^([A-Za-z-]*?)(\d+)-\1?(\d+)$/);
      if (m && Number(m[3]) - Number(m[2]) < 500) for (let i = Number(m[2]); i <= Number(m[3]); i++) codes.push(`${m[1]}${String(i).padStart(m[2].length, "0")}`);
      else codes.push(part);
    }
    const made = [];
    for (const code of codes) {
      const exists = await Rack.findOne({ organization: req.org, warehouse: oid(d.warehouse), code: code.toUpperCase() });
      if (exists) continue;
      made.push(await Rack.create({ organization: req.org, warehouse: oid(d.warehouse), code, name: d.name || "" }));
    }
    res.send({ created: made.length, racks: made });
  })
);
router.put(
  "/racks/:id",
  ah(async (req, res) => {
    const d = validate(Joi.object({ code: Joi.string().trim(), name: Joi.string().allow(""), active: Joi.boolean() }), req.body);
    const r = await Rack.findOneAndUpdate({ _id: req.params.id, organization: req.org }, d, { new: true });
    if (!r) throw new HttpError(404, "Rack not found");
    res.send(r);
  })
);

/* ---------------- put away / move ---------------- */
router.post(
  "/moves",
  ah(async (req, res) => {
    const d = validate(Joi.object({ item: Joi.string().required(), from: Joi.string().allow(null, ""), to: Joi.string().allow(null, ""), qty: Joi.number().greater(0).required().label("Quantity"), note: Joi.string().allow("") }), req.body);
    if (!d.from && !d.to) throw new HttpError(400, "Choose a rack");
    if (d.from && d.from === d.to) throw new HttpError(400, "Choose a different rack");
    const [from, to] = await Promise.all([d.from ? Rack.findOne({ _id: d.from, organization: req.org }) : null, d.to ? Rack.findOne({ _id: d.to, organization: req.org }) : null]);
    if ((d.from && !from) || (d.to && !to)) throw new HttpError(400, "Rack not found");
    if (from && to && String(from.warehouse || "") !== String(to.warehouse || "")) throw new HttpError(400, "Racks are in different warehouses — use a transfer order to move stock between warehouses");
    const { rows } = await stockView(req.org, { itemIds: [d.item] });
    const r = rows[0];
    if (!r) throw new HttpError(404, "Item not found");
    if (!r.trackInventory) throw new HttpError(400, "Turn on inventory tracking for this item first");
    const whKey = (w) => (w ? String(w) : null);
    const wh = from || to;
    if (from) {
      const on = r.racks.find((x) => x.rack === String(from._id))?.qty || 0;
      if (d.qty > on) throw new HttpError(400, `Only ${on} on rack ${from.code}`);
    } else {
      const free = r.unassigned.filter((u) => !whKey(wh.warehouse) || u.warehouse === whKey(wh.warehouse)).reduce((s, u) => s + u.qty, 0);
      if (d.qty > free) throw new HttpError(400, `Only ${Math.max(0, free)} not yet on a rack`);
    }
    const m = await RackMove.create({ organization: req.org, item: d.item, warehouse: wh.warehouse || null, from: from?._id || null, to: to?._id || null, qty: d.qty, note: d.note || "", user: req.user?.name || "" });
    res.send(m);
  })
);

/* ---------------- one item ---------------- */
router.get(
  "/:id",
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Item not found");
    const { rows, racks } = await stockView(req.org, { itemIds: [req.params.id] });
    if (!rows[0]) throw new HttpError(404, "Item not found");
    const [moves, orders] = await Promise.all([
      RackMove.find({ organization: req.org, item: req.params.id }).sort({ createdAt: -1 }).limit(30).populate("from to", "code").lean(),
      ShopifyOrder.find({ organization: req.org, "lines.item": req.params.id, status: { $in: ["new", "packed", "ready_to_ship", "shipped", "delivered"] }, $or: [{ invoice: null }, { invoice: { $exists: false } }] }, { name: 1, orderDate: 1, status: 1, "lines.item": 1, "lines.quantity": 1 }).sort({ orderDate: -1 }).limit(50).lean(),
    ]);
    res.send({ ...rows[0], racksAll: racks, moves, reservedBy: orders.map((o) => ({ _id: o._id, name: o.name, orderDate: o.orderDate, status: o.status, qty: o.lines.filter((l) => String(l.item) === req.params.id).reduce((s, l) => s + l.quantity, 0) })) });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        virtualStock: Joi.number().min(0),
        bufferStock: Joi.number().min(0),
        shopifySync: Joi.boolean(),
        trackInventory: Joi.boolean(),
        category: Joi.string().allow(""),
        weight: Joi.number().min(0),
      }),
      req.body
    );
    const it = await Item.findOneAndUpdate({ _id: req.params.id, organization: req.org }, d, { new: true });
    if (!it) throw new HttpError(404, "Item not found");
    res.send(it);
  })
);

// Link Shopify listings to this item. A listing linked here stops being its own item: its open orders move over.
router.put(
  "/:id/links",
  ah(async (req, res) => {
    const d = validate(Joi.object({ links: Joi.array().items(Joi.object({ variantId: Joi.string().required(), inventoryItemId: Joi.string().allow(""), sku: Joi.string().allow(""), title: Joi.string().allow(""), image: Joi.string().allow("") })).max(100).required() }), req.body);
    const it = await Item.findOne({ _id: req.params.id, organization: req.org });
    if (!it) throw new HttpError(404, "Item not found");
    const links = d.links.filter((l) => l.variantId !== it.shopifyVariantId);
    const ids = links.map((l) => l.variantId);
    const moved = [];
    // Take the variant off any other item.
    await Item.updateMany({ organization: req.org, _id: { $ne: it._id }, "shopifyLinks.variantId": { $in: ids } }, { $pull: { shopifyLinks: { variantId: { $in: ids } } } });
    for (const other of await Item.find({ organization: req.org, _id: { $ne: it._id }, shopifyVariantId: { $in: ids } })) {
      // The auto-created item for that listing: point its open (uninvoiced) Shopify orders at this item and retire it.
      const orders = await ShopifyOrder.find({ organization: req.org, "lines.item": other._id, $or: [{ invoice: null }, { invoice: { $exists: false } }] });
      for (const o of orders) {
        o.lines.forEach((l) => String(l.item) === String(other._id) && (l.item = it._id));
        o.markModified("lines");
        await o.save();
      }
      other.shopifyVariantId = "";
      other.shopifyInventoryItemId = "";
      other.active = false;
      other.reviewNote = `Linked to ${it.name}`;
      other.needsReview = false;
      await other.save();
      moved.push({ name: other.name, orders: orders.length });
    }
    it.shopifyLinks = links;
    if (!it.image && links[0]?.image) it.image = links[0].image;
    await it.save();
    res.send({ item: it, retired: moved });
  })
);

/* ---------------- Shopify ---------------- */
router.get(
  "/shopify/variants",
  ah(async (req, res) => {
    const store = await ShopifyStore.findOne({ organization: req.org });
    if (!store?.connected) throw new HttpError(400, "Connect Shopify first");
    try {
      res.send(await inv.searchVariants(store, (req.query.q || "").trim()));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);

router.post(
  "/shopify/push",
  ah(async (req, res) => {
    const r = await inv.pushOrg(String(req.org), { force: !!req.body?.force });
    if (r.skipped === "off") throw new HttpError(400, "Turn on inventory sync and choose a Shopify location in Shopify Settings");
    res.send(r);
  })
);

module.exports = router;
