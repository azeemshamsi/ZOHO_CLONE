const router = require("express").Router();
const Joi = require("joi");
const TransferOrder = require("../models/TransferOrder");
const Warehouse = require("../models/Warehouse");
const Item = require("../models/Item");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");

const schema = Joi.object({
  date: Joi.date().required().label("Date"),
  from: Joi.string().required().label("Source warehouse"),
  to: Joi.string().required().label("Destination warehouse"),
  reason: Joi.string().allow(""),
  status: Joi.string().valid("draft", "transferred").default("transferred"),
  lines: Joi.array().items(Joi.object({ item: Joi.string().required(), quantity: Joi.number().greater(0).required().label("Quantity") }).unknown(true)).min(1).required().label("Items"),
});

async function prepare(req, data, id) {
  if (data.from === data.to) throw new HttpError(400, "Pick two different warehouses");
  const whs = await Warehouse.find({ organization: req.org, _id: { $in: [data.from, data.to] } }).lean();
  if (whs.length !== 2) throw new HttpError(400, "Choose valid warehouses");
  const items = await Item.find({ organization: req.org, _id: { $in: data.lines.map((l) => l.item) }, trackInventory: true }).lean();
  data.lines = data.lines.map((l) => {
    const it = items.find((x) => String(x._id) === l.item);
    if (!it) throw new HttpError(400, "Only items that track inventory can be transferred");
    return { item: it._id, name: it.name, quantity: round2(l.quantity) };
  });
  if (data.status === "transferred") {
    // Don't move more than the source warehouse has.
    const { loadStock } = require("../utils/inventory");
    const st = await loadStock(req.org);
    const prev = id ? await TransferOrder.findById(id).lean() : null;
    for (const l of data.lines) {
      let have = st.items[String(l.item)]?.byWarehouse?.[data.from] || 0;
      if (prev?.status === "transferred" && String(prev.from) === data.from) have += prev.lines.filter((x) => String(x.item) === String(l.item)).reduce((s, x) => s + x.quantity, 0);
      if (l.quantity > have + 1e-9) throw new HttpError(400, `Only ${have} of ${l.name} in the source warehouse`);
    }
  }
  return data;
}

router.get("/", ah(async (req, res) => res.send(await TransferOrder.find({ organization: req.org }).sort({ date: -1, createdAt: -1 }))));
router.get(
  "/:id",
  ah(async (req, res) => {
    const t = await TransferOrder.findOne({ _id: req.params.id, organization: req.org });
    if (!t) throw new HttpError(404, "Transfer order not found");
    res.send(t);
  })
);
router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    res.status(201).send(await TransferOrder.create({ ...data, number: await nextNumber(req.org, "transferOrder", "TO-"), organization: req.org }));
  })
);
router.put(
  "/:id",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body), req.params.id);
    const t = await TransferOrder.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, { new: true });
    if (!t) throw new HttpError(404, "Transfer order not found");
    res.send(t);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await TransferOrder.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Transfer order not found");
    res.send({ message: "Transfer order deleted" });
  })
);
module.exports = router;
