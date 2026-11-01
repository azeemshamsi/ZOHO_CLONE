const router = require("express").Router();
const Joi = require("joi");
const Item = require("../models/Item");
const Invoice = require("../models/Invoice");
const { ah, validate, HttpError } = require("../utils/http");

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

const schema = Joi.object({
  type: Joi.string().valid("goods", "service"),
  name: Joi.string().trim().min(1).max(200).required().label("Name"),
  sku: Joi.string().allow(""),
  unit: Joi.string().allow(""),
  hsnSac: Joi.string().allow("").label("HSN/SAC"),
  rate: Joi.number().min(0).required().label("Selling price"),
  purchaseRate: Joi.number().min(0),
  taxRate: Joi.number()
    .valid(...GST_RATES)
    .label("GST rate"),
  description: Joi.string().allow(""),
  active: Joi.boolean(),
  trackInventory: Joi.boolean(),
  openingStock: Joi.number().min(0),
  openingStockRate: Joi.number().min(0),
  openingStockDate: Joi.date().allow(null, ""),
  reorderLevel: Joi.number().min(0),
  openingWarehouse: Joi.string().allow(null, ""),
});

// Services never carry stock.
const clean = (data) => {
  if (!data.openingWarehouse) data.openingWarehouse = null;
  if (data.type === "service") data.trackInventory = false;
  if (data.openingStockDate === "") data.openingStockDate = null;
  return data;
};

// Attach stock on hand / committed / available to each item.
async function withStock(org, items) {
  const { loadStock, committedStock } = require("../utils/inventory");
  const [stock, committed] = await Promise.all([loadStock(org), committedStock(org)]);
  return items.map((i) => {
    const o = i.toObject ? i.toObject() : i;
    if (!o.trackInventory) return o;
    const st = stock.items[String(o._id)] || { qty: 0, value: 0, avgCost: 0 };
    const c = committed[String(o._id)] || 0;
    return { ...o, stockOnHand: st.qty, stockValue: st.value, avgCost: st.avgCost, committed: c, available: Math.round((st.qty - c) * 100) / 100, byWarehouse: st.byWarehouse || {} };
  });
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { sku: rx }, { hsnSac: rx }];
    }
    if (req.query.status === "active") filter.active = true;
    if (req.query.status === "inactive") filter.active = false;
    if (req.query.inventory === "tracked") filter.trackInventory = true;
    res.send(await withStock(req.org, await Item.find(filter).sort({ name: 1 }).lean()));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = clean(validate(schema, req.body));
    res.status(201).send(await Item.create({ ...data, organization: req.org }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const item = await Item.findOne({ _id: req.params.id, organization: req.org });
    if (!item) throw new HttpError(404, "Item not found");
    const [full] = await withStock(req.org, [item.toObject()]);
    res.send(full);
  })
);

// Every stock movement of an item, with running quantity and value.
router.get(
  "/:id/stock",
  ah(async (req, res) => {
    const item = await Item.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!item) throw new HttpError(404, "Item not found");
    const { loadStock } = require("../utils/inventory");
    const st = (await loadStock(req.org)).items[String(item._id)];
    res.send(st ? { qty: st.qty, value: st.value, avgCost: st.avgCost, moves: st.moves } : { qty: 0, value: 0, avgCost: 0, moves: [] });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = clean(validate(schema, req.body));
    const item = await Item.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, {
      new: true,
      runValidators: true,
    });
    if (!item) throw new HttpError(404, "Item not found");
    res.send(item);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const q = { organization: req.org, "lineItems.item": req.params.id };
    const used =
      (await Invoice.exists(q)) ||
      (await require("../models/Quote").exists(q)) ||
      (await require("../models/SalesOrder").exists(q)) ||
      (await require("../models/CreditNote").exists(q)) ||
      (await require("../models/Bill").exists(q)) ||
      (await require("../models/PurchaseOrder").exists(q)) ||
      (await require("../models/VendorCredit").exists(q)) ||
      (await require("../models/InventoryAdjustment").exists({ organization: req.org, "lines.item": req.params.id }));
    if (used) throw new HttpError(400, "This item is used in transactions. Mark it inactive instead of deleting.");
    const r = await Item.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Item not found");
    res.send({ message: "Item deleted" });
  })
);

module.exports = router;
module.exports.GST_RATES = GST_RATES;
