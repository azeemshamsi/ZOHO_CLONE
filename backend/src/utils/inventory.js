/**
 * Inventory engine. Like the ledger, stock is derived from documents on every request:
 *   in  — opening stock, bills, credit notes (sales returns), positive adjustments
 *   out — invoices, vendor credits (returns to vendor), negative adjustments
 * Costing is FIFO. Selling more than is in stock is allowed; the shortfall is costed at the last
 * known unit cost and trued up against Cost of Goods Sold when stock next comes in.
 *
 * For every document the engine returns `inv`: the change in inventory value it caused. The
 * ledger posts exactly that to the Inventory Asset account, so the account always equals the
 * value of stock on hand.
 */
const { round2 } = require("./http");

const ORDER = { opening: 0, bill: 1, adjIn: 2, creditNote: 3, transfer: 4, invoice: 5, vendorCredit: 6, adjOut: 7, adjValue: 8 };
const live = (d) => !["draft", "void"].includes(d.status);

function computeStock({ items, invoices = [], creditNotes = [], bills = [], vendorCredits = [], adjustments = [], transfers = [], primary = null, to = null }) {
  // Quantities are also tracked per warehouse; no warehouse = the primary warehouse.
  const W = (w) => (w ? String(w) : primary ? String(primary) : "primary");
  const tracked = new Map(items.filter((i) => i.trackInventory).map((i) => [String(i._id), i]));
  const events = [];
  const push = (e) => tracked.has(e.item) && events.push(e);

  for (const it of tracked.values()) {
    if (it.openingStock)
      events.push({ kind: "opening", item: String(it._id), wh: W(it.openingWarehouse), date: it.openingStockDate || it.createdAt, seq: 0, qty: it.openingStock, cost: round2(it.openingStock * (it.openingStockRate || 0)), doc: { type: "Opening Stock", id: it._id, number: "", party: "" } });
  }
  const lines = (d, cb) => (d.lineItems || []).forEach((l, i) => l.item && cb(String(l.item), l, i));
  const meta = (type, d, number, party) => ({ type, id: d._id, number, party });
  for (const b of bills.filter(live))
    lines(b, (item, l) => push({ kind: "bill", item, wh: W(b.warehouse), date: b.date, seq: b.createdAt, qty: l.quantity, cost: l.amount * (Number(b.exchangeRate) || 1), doc: meta("Bill", b, b.billNumber, b.vendorName) }));
  for (const c of creditNotes.filter(live))
    lines(c, (item, l) => push({ kind: "creditNote", item, wh: W(c.warehouse), date: c.date, seq: c.createdAt, qty: l.quantity, doc: meta("Credit Note", c, c.number, c.customerName) }));
  for (const i of invoices.filter(live))
    lines(i, (item, l) => push({ kind: "invoice", item, wh: W(i.warehouse), date: i.date, seq: i.createdAt, qty: l.quantity, doc: meta("Invoice", i, i.invoiceNumber, i.customerName) }));
  for (const v of vendorCredits.filter(live))
    lines(v, (item, l) => push({ kind: "vendorCredit", item, wh: W(v.warehouse), date: v.date, seq: v.createdAt, qty: l.quantity, doc: meta("Vendor Credit", v, v.number, v.vendorName) }));
  for (const a of adjustments.filter((a) => a.status === "adjusted"))
    a.lines.forEach((l) => {
      const doc = meta("Inventory Adjustment", a, a.reference || a.number, a.reason);
      const wh = W(a.warehouse);
      if (a.mode === "value") push({ kind: "adjValue", item: String(l.item), wh, date: a.date, seq: a.createdAt, qty: 0, value: l.valueAdjusted || 0, doc });
      else if (l.quantityAdjusted > 0) push({ kind: "adjIn", item: String(l.item), wh, date: a.date, seq: a.createdAt, qty: l.quantityAdjusted, rate: l.costPrice, doc });
      else if (l.quantityAdjusted < 0) push({ kind: "adjOut", item: String(l.item), wh, date: a.date, seq: a.createdAt, qty: -l.quantityAdjusted, doc });
    });

  for (const t of transfers.filter((t) => t.status === "transferred"))
    t.lines.forEach((l) => push({ kind: "transfer", item: String(l.item), from: W(t.from), wh: W(t.to), date: t.date, seq: t.createdAt, qty: l.quantity, doc: { type: "Transfer Order", id: t._id, number: t.number, party: "" } }));
  if (to) {
    const end = new Date(to);
    for (let i = events.length - 1; i >= 0; i--) if (new Date(events[i].date) > end) events.splice(i, 1);
  }
  events.sort((a, b) => new Date(a.date) - new Date(b.date) || ORDER[a.kind] - ORDER[b.kind] || new Date(a.seq || 0) - new Date(b.seq || 0));

  const state = {};
  const docInv = {}; // "Type|id" -> inventory value change
  const docCost = {}; // "Type|id" -> cost of goods for that doc (invoices: COGS; vendor credits: cost removed)
  for (const it of tracked.values()) state[String(it._id)] = { item: it, layers: [], lastCost: it.purchaseRate || 0, lastOutCost: null, moves: [], wh: {} };

  const qtyOf = (s) => round2(s.layers.reduce((t, l) => t + l.qty, 0));
  const valOf = (s) => round2(s.layers.reduce((t, l) => t + l.qty * l.unit, 0));
  const avg = (s) => {
    const q = qtyOf(s);
    return q > 0 ? valOf(s) / q : s.lastCost;
  };

  // Stock in: first repay any shortfall (negative layer), then add a layer.
  function stockIn(s, qty, unit) {
    let left = qty;
    for (const l of s.layers) {
      if (left <= 0) break;
      if (l.qty < 0) {
        const m = Math.min(left, -l.qty);
        l.qty = round2(l.qty + m);
        left = round2(left - m);
      }
    }
    s.layers = s.layers.filter((l) => Math.abs(l.qty) > 1e-9);
    if (left > 0) s.layers.push({ qty: left, unit });
    if (unit > 0) s.lastCost = unit;
  }
  // Stock out, FIFO. Returns the cost of what left.
  function stockOut(s, qty) {
    let left = qty;
    let cost = 0;
    for (const l of s.layers) {
      if (left <= 0) break;
      if (l.qty <= 0) continue;
      const m = Math.min(left, l.qty);
      cost += m * l.unit;
      l.qty = round2(l.qty - m);
      left = round2(left - m);
      s.lastCost = l.unit;
    }
    s.layers = s.layers.filter((l) => Math.abs(l.qty) > 1e-9);
    if (left > 0) {
      const neg = s.layers.find((l) => l.qty < 0);
      if (neg) neg.qty = round2(neg.qty - left);
      else s.layers.push({ qty: -left, unit: s.lastCost });
      cost += left * (neg ? neg.unit : s.lastCost);
    }
    return round2(cost);
  }

  for (const e of events) {
    const s = state[e.item];
    const bump = (w, q) => (s.wh[w] = round2((s.wh[w] || 0) + q));
    if (e.kind === "transfer") {
      bump(e.from, -e.qty);
      bump(e.wh, e.qty);
      s.moves.push({ date: e.date, ...e.doc, party: `${e.from} → ${e.wh}`, from: e.from, to: e.wh, qtyIn: 0, qtyOut: 0, transfer: e.qty, value: 0, unitCost: 0, qty: qtyOf(s), stockValue: valOf(s), warehouse: e.wh });
      continue;
    }
    const before = valOf(s);
    let unitCost = 0;
    if (e.kind === "opening" || e.kind === "bill") {
      unitCost = e.qty ? e.cost / e.qty : 0;
      stockIn(s, e.qty, unitCost);
    } else if (e.kind === "adjIn") {
      unitCost = e.rate || avg(s);
      stockIn(s, e.qty, unitCost);
    } else if (e.kind === "creditNote") {
      unitCost = s.lastOutCost ?? avg(s);
      stockIn(s, e.qty, unitCost);
    } else if (e.kind === "adjValue") {
      const q = qtyOf(s);
      if (q > 0) s.layers.forEach((l) => l.qty > 0 && (l.unit += e.value / q));
    } else {
      const cost = stockOut(s, e.qty);
      unitCost = e.qty ? cost / e.qty : 0;
      if (e.kind === "invoice") s.lastOutCost = unitCost;
    }
    const change = round2(valOf(s) - before);
    const key = `${e.doc.type}|${e.doc.id}`;
    docInv[key] = round2((docInv[key] || 0) + change);
    if (e.kind === "invoice" || e.kind === "vendorCredit" || e.kind === "adjOut") docCost[key] = round2((docCost[key] || 0) - change);
    const isIn = ["opening", "bill", "adjIn", "creditNote"].includes(e.kind);
    if (e.kind !== "adjValue") bump(e.wh, isIn ? e.qty : -e.qty);
    s.moves.push({
      date: e.date,
      ...e.doc,
      qtyIn: isIn ? e.qty : 0,
      qtyOut: isIn || e.kind === "adjValue" ? 0 : e.qty,
      value: change,
      unitCost: round2(unitCost),
      qty: qtyOf(s),
      stockValue: valOf(s),
      warehouse: e.wh,
    });
  }

  const summary = {};
  for (const [id, s] of Object.entries(state)) summary[id] = { item: s.item, qty: qtyOf(s), value: valOf(s), moves: s.moves, avgCost: round2(avg(s)), byWarehouse: s.wh, layers: s.layers.map((l) => ({ qty: l.qty, unit: round2(l.unit) })) };
  return { items: summary, docInv, docCost };
}

// Load everything the engine needs for an organization.
async function loadStock(org, { to } = {}) {
  const Item = require("../models/Item");
  const InventoryAdjustment = require("../models/InventoryAdjustment");
  const Invoice = require("../models/Invoice");
  const CreditNote = require("../models/CreditNote");
  const Bill = require("../models/Bill");
  const VendorCredit = require("../models/VendorCredit");
  const live = { organization: org, status: { $nin: ["draft", "void"] } };
  const TransferOrder = require("../models/TransferOrder");
  const Warehouse = require("../models/Warehouse");
  const { raw } = require("../config/baseCurrency");
  const [items, invoices, creditNotes, bills, vendorCredits, adjustments, transfers, primaryWh] = await raw(() => Promise.all([
    Item.find({ organization: org }).lean(),
    Invoice.find(live).lean(),
    CreditNote.find(live).lean(),
    Bill.find(live).lean(),
    VendorCredit.find(live).lean(),
    InventoryAdjustment.find({ organization: org, status: "adjusted" }).lean(),
    TransferOrder.find({ organization: org, status: "transferred" }).lean(),
    Warehouse.findOne({ organization: org, primary: true }).lean(),
  ]));
  return computeStock({ items, invoices, creditNotes, bills, vendorCredits, adjustments, transfers, primary: primaryWh?._id, to });
}

// Quantity committed to confirmed sales orders not yet invoiced, per item.
async function committedStock(org) {
  const SalesOrder = require("../models/SalesOrder");
  const orders = await SalesOrder.find({ organization: org, status: "confirmed" }).lean();
  const m = {};
  for (const o of orders) for (const l of o.lineItems) if (l.item) m[String(l.item)] = round2((m[String(l.item)] || 0) + l.quantity);
  return m;
}

module.exports = { computeStock, loadStock, committedStock };
