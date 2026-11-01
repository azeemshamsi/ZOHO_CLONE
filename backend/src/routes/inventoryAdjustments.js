const router = require("express").Router();
const Joi = require("joi");
const Item = require("../models/Item");
const InventoryAdjustment = require("../models/InventoryAdjustment");
const { REASONS } = require("../models/InventoryAdjustment");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts } = require("../utils/ledger");

const schema = Joi.object({
  mode: Joi.string().valid("quantity", "value").default("quantity"),
  date: Joi.date().required().label("Date"),
  reference: Joi.string().allow(""),
  reason: Joi.string().trim().required().label("Reason"),
  account: Joi.string().default("cogs"),
  description: Joi.string().allow(""),
  status: Joi.string().valid("draft", "adjusted").default("adjusted"),
  warehouse: Joi.string().allow(null, ""),
  lines: Joi.array()
    .min(1)
    .items(
      Joi.object({
        item: Joi.string().required(),
        quantityAdjusted: Joi.number().default(0),
        costPrice: Joi.number().min(0).default(0),
        valueAdjusted: Joi.number().default(0),
      }).unknown(true)
    )
    .required()
    .label("Items"),
});

async function prepare(req, data) {
  data.warehouse = (await require("../utils/salesDoc").resolveLocation(req, data)).warehouse?._id || null;
  const ids = data.lines.map((l) => l.item);
  const items = await Item.find({ organization: req.org, _id: { $in: ids } }).lean();
  const byId = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const accounts = await chartOfAccounts(req.org);
  if (!accounts.some((a) => a.code === data.account)) throw new HttpError(400, "Pick a valid adjustment account");
  data.lines = data.lines.map((l) => {
    const it = byId[l.item];
    if (!it) throw new HttpError(400, "Item not found");
    if (!it.trackInventory) throw new HttpError(400, `${it.name} doesn't track inventory`);
    const line = { item: it._id, name: it.name, quantityAdjusted: round2(l.quantityAdjusted), costPrice: round2(l.costPrice), valueAdjusted: round2(l.valueAdjusted) };
    if (data.mode === "quantity" ? !line.quantityAdjusted : !line.valueAdjusted) throw new HttpError(400, `Enter the adjustment for ${it.name}`);
    return line;
  });
  return data;
}

router.get("/reasons", (req, res) => res.send(REASONS));

router.get(
  "/",
  ah(async (req, res) => res.send(await InventoryAdjustment.find({ organization: req.org }).sort({ date: -1, createdAt: -1 })))
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const a = await InventoryAdjustment.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!a) throw new HttpError(404, "Adjustment not found");
    const { docInv } = await require("../utils/inventory").loadStock(req.org);
    res.send({ ...a, valueChange: docInv[`Inventory Adjustment|${a._id}`] || 0 });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const number = await nextNumber(req.org, "inventoryAdjustment", "IA-");
    res.status(201).send(await InventoryAdjustment.create({ ...data, number, organization: req.org }));
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const a = await InventoryAdjustment.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, { new: true });
    if (!a) throw new HttpError(404, "Adjustment not found");
    res.send(a);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await InventoryAdjustment.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Adjustment not found");
    res.send({ message: "Adjustment deleted" });
  })
);

module.exports = router;
