/**
 * The inventory picture for an organization, per item:
 *   onHand    – stock in the books (FIFO engine: bills, invoices, adjustments, transfers…)
 *   blocked   – reserved by Shopify orders not yet invoiced (invoicing turns the reservation into a stock-out)
 *   buffer    – kept back from Shopify
 *   virtual   – made-to-order quantity shown on Shopify; never in the books
 *   shopify   – what Shopify should show: free stock + virtual, where free = onHand − buffer − blocked
 *               (orders beyond free stock use up the virtual quantity)
 *   racks     – where the stock sits; stock not put away is "unassigned". If sales take more than is
 *               unassigned, the shortfall comes off the racks in rack order.
 */
const mongoose = require("mongoose");
const Item = require("../models/Item");
const Rack = require("../models/Rack");
const RackMove = require("../models/RackMove");
const Warehouse = require("../models/Warehouse");
const ShopifyOrder = require("../models/ShopifyOrder");
const ShopifyStore = require("../models/ShopifyStore");
const { loadStock } = require("./inventory");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const BLOCKING = ["new", "packed", "ready_to_ship", "shipped", "delivered"];

async function blockedQty(org, store) {
  const match = { organization: new mongoose.Types.ObjectId(String(org)), status: { $in: BLOCKING }, $or: [{ invoice: null }, { invoice: { $exists: false } }] };
  if (store?.stockFrom) match.orderDate = { $gte: store.stockFrom };
  const orders = await ShopifyOrder.find(match, { "lines.item": 1, "lines.quantity": 1 }).lean();
  const m = {};
  for (const o of orders) for (const l of o.lines || []) if (l.item && l.quantity > 0) m[String(l.item)] = r2((m[String(l.item)] || 0) + l.quantity);
  return m;
}

function shopifyQty(item, onHand, blocked) {
  if (item.shopifySync === false) return null;
  const virtual = Math.max(0, item.virtualStock || 0);
  if (!item.trackInventory) return Math.max(0, Math.floor(virtual - blocked));
  const free = onHand - (item.bufferStock || 0) - blocked;
  return Math.max(0, Math.floor(free >= 0 ? free + virtual : virtual + free));
}

async function stockView(org, { itemIds } = {}) {
  const store = await ShopifyStore.findOne({ organization: org }).lean();
  const [stock, blocked, racks, moves, warehouses] = await Promise.all([
    loadStock(org),
    blockedQty(org, store),
    Rack.find({ organization: org }).sort({ code: 1 }).lean(),
    RackMove.find({ organization: org }, { item: 1, from: 1, to: 1, qty: 1 }).lean(),
    Warehouse.find({ organization: org }).lean(),
  ]);
  const primary = warehouses.find((w) => w.primary);
  const whKey = (w) => (w ? String(w) : primary ? String(primary._id) : "primary");
  const whName = (k) => warehouses.find((w) => String(w._id) === k)?.name || "Primary";
  const rackById = new Map(racks.map((r) => [String(r._id), r]));
  const net = {}; // "item|rack" → qty
  for (const m of moves) {
    if (m.to) net[`${m.item}|${m.to}`] = (net[`${m.item}|${m.to}`] || 0) + m.qty;
    if (m.from) net[`${m.item}|${m.from}`] = (net[`${m.item}|${m.from}`] || 0) - m.qty;
  }
  const onRack = {}; // item → [{rack, qty}]
  for (const [k, q] of Object.entries(net)) {
    const [item, rackId] = k.split("|");
    const r = rackById.get(rackId);
    if (!r || !(q > 0)) continue;
    (onRack[item] = onRack[item] || []).push({ rack: r, qty: r2(q) });
  }
  for (const list of Object.values(onRack)) list.sort((a, b) => a.rack.code.localeCompare(b.rack.code));
  const items = await Item.find({ organization: org, ...(itemIds ? { _id: { $in: itemIds } } : {}) }).lean();
  const out = [];
  for (const it of items) {
    const id = String(it._id);
    const s = stock.items[id];
    const onHand = it.trackInventory ? r2(s?.qty || 0) : 0;
    const b = blocked[id] || 0;
    // Racks per warehouse
    const byWh = Object.entries(s?.byWarehouse || {}).filter(([, q]) => q);
    const rackRows = [];
    const unassigned = [];
    const whKeys = new Set([...byWh.map(([k]) => k), ...(onRack[id] || []).map((x) => whKey(x.rack.warehouse))]);
    for (const k of whKeys) {
      const whQty = r2((s?.byWarehouse || {})[k] || 0);
      const list = (onRack[id] || []).filter((x) => whKey(x.rack.warehouse) === k).map((x) => ({ ...x }));
      let free = r2(whQty - list.reduce((a, x) => a + x.qty, 0));
      // Sold more than was unassigned: take it off the racks.
      for (const x of list) {
        if (free >= 0) break;
        const take = Math.min(x.qty, -free);
        x.qty = r2(x.qty - take);
        free = r2(free + take);
      }
      for (const x of list) if (x.qty > 0) rackRows.push({ rack: String(x.rack._id), code: x.rack.code, warehouse: k, warehouseName: whName(k), qty: x.qty });
      if (free) unassigned.push({ warehouse: k, warehouseName: whName(k), qty: free });
    }
    const sq = shopifyQty(it, onHand, b);
    out.push({
      _id: it._id,
      name: it.name,
      sku: it.sku,
      hsnSac: it.hsnSac,
      taxRate: it.taxRate,
      category: it.category || "",
      image: it.image || "",
      weight: it.weight || 0,
      purchaseRate: it.purchaseRate,
      rate: it.rate,
      active: it.active !== false,
      trackInventory: !!it.trackInventory,
      shopifySync: it.shopifySync !== false,
      onHand,
      value: r2(s?.value || 0),
      blocked: b,
      buffer: it.bufferStock || 0,
      virtual: it.virtualStock || 0,
      available: r2(onHand - b - (it.bufferStock || 0)),
      shopify: sq,
      oversold: it.trackInventory ? b > onHand + (it.virtualStock || 0) : b > (it.virtualStock || 0),
      warehouses: byWh.map(([k, q]) => ({ warehouse: k, warehouseName: whName(k), qty: r2(q) })),
      racks: rackRows,
      unassigned,
      shopifyVariantId: it.shopifyVariantId || "",
      links: it.shopifyLinks || [],
      pushed: it.shopifyPushed || {},
    });
  }
  return { rows: out, store, racks, warehouses, primaryKey: whKey(null) };
}

module.exports = { stockView, shopifyQty, blockedQty, BLOCKING };
