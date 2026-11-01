const router = require("express").Router();
const Joi = require("joi");
const Warehouse = require("../models/Warehouse");
const { ah, validate, HttpError } = require("../utils/http");

const schema = Joi.object({
  name: Joi.string().trim().required().label("Warehouse name"),
  branch: Joi.string().allow(null, ""),
  address: Joi.object().unknown(true).default({}),
  primary: Joi.boolean().default(false),
  active: Joi.boolean(),
});

async function save(req, data, id) {
  if (!data.branch) data.branch = null;
  const count = await Warehouse.countDocuments({ organization: req.org, ...(id ? { _id: { $ne: id } } : {}) });
  if (!count) data.primary = true; // the first warehouse is the primary one
  if (data.primary) await Warehouse.updateMany({ organization: req.org }, { primary: false });
  return data;
}

router.get("/", ah(async (req, res) => res.send(await Warehouse.find({ organization: req.org }).sort({ primary: -1, name: 1 }))));
router.post("/", ah(async (req, res) => res.status(201).send(await Warehouse.create({ ...(await save(req, validate(schema, req.body))), organization: req.org }))));
router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const w = await Warehouse.findOne({ _id: req.params.id, organization: req.org });
    if (!w) throw new HttpError(404, "Warehouse not found");
    if (w.primary && data.primary === false) data.primary = true; // pick another one as primary instead
    w.set(await save(req, data, w._id));
    await w.save();
    res.send(w);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const w = await Warehouse.findOne({ _id: req.params.id, organization: req.org });
    if (!w) throw new HttpError(404, "Warehouse not found");
    if (w.primary) throw new HttpError(400, "Make another warehouse primary before deleting this one");
    const { loadStock } = require("../utils/inventory");
    const st = await loadStock(req.org);
    if (Object.values(st.items).some((i) => (i.byWarehouse[String(w._id)] || 0) !== 0)) throw new HttpError(400, "This warehouse still has stock. Transfer it out first.");
    for (const m of ["Invoice", "Bill", "CreditNote", "VendorCredit", "InventoryAdjustment"]) if (await require(`../models/${m}`).exists({ organization: req.org, warehouse: w._id })) throw new HttpError(400, "This warehouse has transactions. Mark it inactive instead.");
    if (await require("../models/TransferOrder").exists({ organization: req.org, $or: [{ from: w._id }, { to: w._id }] })) throw new HttpError(400, "This warehouse has transfer orders. Mark it inactive instead.");
    await w.deleteOne();
    res.send({ message: "Warehouse deleted" });
  })
);
module.exports = router;
