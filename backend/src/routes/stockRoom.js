/**
 * Stock Room: a photo view of stock on hand, read-only. The numbers are the inventory's (bills and other ins add,
 * invoices and other outs take away), so it always matches Items → Inventory. Mounted at /api/stock-room.
 */
const router = require("express").Router();
const Item = require("../models/Item");
const Organization = require("../models/Organization");
const { ah, HttpError } = require("../utils/http");
const { loadStock } = require("../utils/inventory");

// Stock is worked out from every document: kept for a minute per company so scrolling stays quick.
const cache = new Map();
async function stockOf(org) {
  const k = String(org);
  const hit = cache.get(k);
  if (hit && hit.at > Date.now() - 60000) return hit.stock;
  const stock = await loadStock(org);
  cache.set(k, { at: Date.now(), stock });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return stock;
}

router.use(
  ah(async (req, res, next) => {
    const o = await Organization.findById(req.org, { stockRoom: 1 }).lean();
    if (o && o.stockRoom === false) throw new HttpError(403, "The Stock Room is turned off (Settings → Preferences)");
    next();
  }),
);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const imageOf = (it) => it.image || (it.shopifyLinks || []).find((l) => l.image)?.image || "";

// ?q= (name or SKU), ?offset=, ?limit= — the next batch as the page scrolls.
router.get(
  "/",
  ah(async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const items = await Item.find(
      { organization: req.org, type: { $ne: "service" } },
      { name: 1, sku: 1, unit: 1, image: 1, "shopifyLinks.image": 1, "shopifyLinks.sku": 1, active: 1, trackInventory: 1, category: 1 },
    ).lean();
    let list = items.filter((it) => it.active !== false);
    if (q)
      list = list.filter(
        (it) =>
          String(it.name || "").toLowerCase().includes(q) ||
          String(it.sku || "").toLowerCase().includes(q) ||
          (it.shopifyLinks || []).some((l) => String(l.sku || "").toLowerCase().includes(q)),
      );
    const stock = await stockOf(req.org);
    const rows = list
      .map((it) => ({
        _id: it._id,
        name: it.name,
        sku: it.sku || "",
        unit: it.unit || "",
        category: it.category || "",
        image: imageOf(it),
        qty: r2(stock.items[String(it._id)]?.qty),
      }))
      .sort((a, b) => (a.sku || a.name).localeCompare(b.sku || b.name, undefined, { numeric: true }));
    res.send({ rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit });
  }),
);

// One item's recent ins and outs, newest first, with the balance after each.
router.get(
  "/:id/history",
  ah(async (req, res) => {
    const it = await Item.findOne({ _id: req.params.id, organization: req.org }, { name: 1, sku: 1, unit: 1, image: 1, "shopifyLinks.image": 1 }).lean();
    if (!it) throw new HttpError(404, "Item not found");
    const st = (await stockOf(req.org)).items[String(it._id)];
    const moves = (st?.moves || [])
      .filter((m) => m.qtyIn || m.qtyOut || m.transfer)
      .map((m) => ({
        date: m.date,
        type: m.type || "",
        number: m.number || "",
        party: m.party || "",
        in: r2(m.qtyIn),
        out: r2(m.qtyOut),
        transfer: m.transfer ? r2(m.transfer) : 0,
        balance: r2(m.qty),
      }))
      .reverse();
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    res.send({ item: { _id: it._id, name: it.name, sku: it.sku || "", unit: it.unit || "", image: imageOf(it) }, qty: r2(st?.qty), moves: moves.slice(0, limit), more: moves.length > limit });
  }),
);

module.exports = router;
