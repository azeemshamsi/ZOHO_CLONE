/**
 * Zakat valuation — private to the company's admins and the superadmin. Each item's zakat cost (kept apart from
 * the accounting cost; it posts nothing) times the stock on hand on the chosen date, and zakat at 2.5%.
 * Mounted at /api/zakat.
 */
const router = require("express").Router();
const Joi = require("joi");
const Item = require("../models/Item");
const { ah, validate, HttpError, round2 } = require("../utils/http");

const adminOnly = (req, res, next) =>
  req.user?.superadmin || req.membership?.role === "admin" ? next() : res.status(403).send({ message: "Only admins can open this" });
router.use(adminOnly);

router.get(
  "/",
  ah(async (req, res) => {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? new Date(`${req.query.to}T23:59:59.999+05:30`) : new Date();
    const rate = Math.min(100, Math.max(0, Number(req.query.rate) || 2.5));
    const { loadStock } = require("../utils/inventory");
    const [items, stock] = await Promise.all([
      Item.find({ organization: req.org, type: "goods" }, { name: 1, sku: 1, category: 1, unit: 1, purchaseRate: 1, zakatCost: 1, trackInventory: 1, active: 1, seller: 1 }).select("+zakatCost").lean(),
      loadStock(req.org, { to }),
    ]);
    const rows = [];
    for (const it of items) {
      if (it.seller) continue; // a marketplace seller's product isn't our stock
      const st = stock.items[String(it._id)] || { qty: 0, value: 0 };
      const qty = round2(st.qty || 0);
      if (!qty && !it.zakatCost && it.active === false) continue;
      rows.push({
        _id: it._id,
        name: it.name,
        sku: it.sku || "",
        category: it.category || "",
        unit: it.unit || "",
        qty,
        bookValue: round2(st.value || 0),
        zakatCost: it.zakatCost || 0,
        zakatValue: round2(Math.max(0, qty) * (it.zakatCost || 0)),
      });
    }
    rows.sort((a, b) => b.zakatValue - a.zakatValue || a.name.localeCompare(b.name));
    const total = round2(rows.reduce((s, r) => s + r.zakatValue, 0));
    res.send({
      to,
      rate,
      rows,
      totals: {
        zakatValue: total,
        bookValue: round2(rows.reduce((s, r) => s + (r.qty > 0 ? r.bookValue : 0), 0)),
        zakat: round2((total * rate) / 100),
        missing: rows.filter((r) => r.qty > 0 && !r.zakatCost).length,
      },
    });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(Joi.object({ zakatCost: Joi.number().min(0).max(1e9).required() }), req.body);
    const r = await Item.updateOne({ _id: req.params.id, organization: req.org }, { $set: { zakatCost: round2(d.zakatCost) } });
    if (!r.matchedCount) throw new HttpError(404, "Item not found");
    res.send({ ok: true });
  })
);

// Zakat costs from a sheet: [{ sku, zakatCost }] matched by SKU.
router.post(
  "/bulk",
  ah(async (req, res) => {
    const d = validate(Joi.object({ rows: Joi.array().items(Joi.object({ sku: Joi.string().trim().required(), zakatCost: Joi.number().min(0).max(1e9).required() })).max(20000).required() }), req.body);
    const bySku = new Map((await Item.find({ organization: req.org }, { sku: 1 }).lean()).filter((i) => i.sku).map((i) => [i.sku.trim().toLowerCase(), i._id]));
    let updated = 0;
    const unknown = [];
    for (const r of d.rows) {
      const id = bySku.get(r.sku.toLowerCase());
      if (!id) {
        unknown.push(r.sku);
        continue;
      }
      await Item.updateOne({ _id: id }, { $set: { zakatCost: round2(r.zakatCost) } });
      updated++;
    }
    await require("../utils/audit").log(req, "zakat_costs_imported", { meta: { updated, unknown: unknown.length } }).catch(() => {});
    res.send({ updated, unknown: unknown.slice(0, 50), unknownCount: unknown.length });
  })
);

module.exports = router;
