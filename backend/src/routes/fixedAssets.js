const router = require("express").Router();
const Joi = require("joi");
const FixedAsset = require("../models/FixedAsset");
const { ASSET_TYPES } = require("../models/FixedAsset");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts } = require("../utils/ledger");
const { schedule, position } = require("../utils/assets");
const { istEndOfToday } = require("../utils/time");

const schema = Joi.object({
  name: Joi.string().trim().required().label("Asset name"),
  assetType: Joi.string().allow(""),
  account: Joi.string().default("fixed_assets"),
  serialNumber: Joi.string().allow(""),
  location: Joi.string().allow(""),
  description: Joi.string().allow(""),
  acquisitionDate: Joi.date().required().label("Purchase date"),
  cost: Joi.number().greater(0).required().label("Cost"),
  paidFrom: Joi.string().allow(""),
  vendor: Joi.string().allow(""),
  salvageValue: Joi.number().min(0).default(0),
  method: Joi.string().valid("slm", "wdv", "none").required(),
  usefulLifeYears: Joi.number().min(0).max(100).default(5),
  rate: Joi.number().min(0).max(100).default(0),
  depreciationStart: Joi.date().allow(null, ""),
  branch: Joi.string().allow(null, ""),
});

async function prepare(req, data) {
  const accounts = await chartOfAccounts(req.org);
  const acc = accounts.find((a) => a.code === data.account);
  if (!acc || acc.group !== "Fixed Asset" || acc.code === "acc_depreciation") throw new HttpError(400, "Pick a Fixed Asset account");
  if (data.paidFrom && data.paidFrom !== "opening_equity" && !accounts.some((a) => a.code === data.paidFrom && ["Cash", "Bank"].includes(a.group))) throw new HttpError(400, "Paid from must be a cash or bank account");
  if (data.salvageValue >= data.cost) throw new HttpError(400, "Salvage value must be less than the cost");
  if (data.method === "slm" && !(data.usefulLifeYears > 0)) throw new HttpError(400, "Enter the useful life in years");
  if (data.method === "wdv" && !(data.rate > 0)) throw new HttpError(400, "Enter the depreciation rate");
  if (!data.depreciationStart) data.depreciationStart = null;
  data.branch = (await require("../utils/salesDoc").resolveLocation(req, data)).branch?._id || null;
  return data;
}

const view = (a) => {
  const now = position(a, istEndOfToday());
  return { ...a, accumulated: now.accumulated, bookValue: now.bookValue };
};

router.get("/types", (req, res) => res.send(ASSET_TYPES));

router.get(
  "/",
  ah(async (req, res) => {
    const q = { organization: req.org };
    if (req.query.status) q.status = req.query.status;
    res.send((await FixedAsset.find(q).sort({ acquisitionDate: -1 }).lean()).map(view));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const a = await FixedAsset.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!a) throw new HttpError(404, "Asset not found");
    // Full projected schedule (to end of life) plus what has been charged so far.
    const today = istEndOfToday();
    // Posted months plus up to 10 years ahead (WDV with no salvage value never quite reaches zero).
    const horizon = new Date(Date.UTC(today.getUTCFullYear() + 10, 2, 31));
    const full = schedule(a, a.status === "disposed" ? a.disposal.date : horizon);
    const out = view(a);
    if (a.status === "disposed") {
      const proceeds = a.disposal.kind === "sold" ? a.disposal.amount : 0;
      out.gainLoss = round2(proceeds - (a.cost - (full.length ? full[full.length - 1].accumulated : 0)));
    }
    res.send({ ...out, schedule: full.map((r) => ({ ...r, posted: r.date <= today })) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const number = await nextNumber(req.org, "fixedAsset", "FA-", 4);
    res.status(201).send(await FixedAsset.create({ ...data, number, organization: req.org }));
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const a = await FixedAsset.findOne({ _id: req.params.id, organization: req.org });
    if (!a) throw new HttpError(404, "Asset not found");
    if (a.status === "disposed") throw new HttpError(400, "Undo the disposal before editing this asset");
    a.set(data);
    await a.save();
    res.send(a);
  })
);

router.post(
  "/:id/dispose",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        date: Joi.date().required().label("Date"),
        kind: Joi.string().valid("sold", "written_off").required(),
        amount: Joi.number().min(0).default(0),
        account: Joi.string().allow(""),
        notes: Joi.string().allow(""),
      }),
      req.body
    );
    const a = await FixedAsset.findOne({ _id: req.params.id, organization: req.org });
    if (!a) throw new HttpError(404, "Asset not found");
    if (a.status === "disposed") throw new HttpError(400, "This asset is already disposed");
    if (new Date(data.date) < a.acquisitionDate) throw new HttpError(400, "Disposal can't be before the purchase date");
    if (data.kind === "sold") {
      if (!(data.amount > 0)) throw new HttpError(400, "Enter the sale amount");
      const accounts = await chartOfAccounts(req.org);
      if (!accounts.some((x) => x.code === data.account && ["Cash", "Bank"].includes(x.group))) throw new HttpError(400, "Pick the cash or bank account the money went to");
    } else {
      data.amount = 0;
      data.account = "";
    }
    a.status = "disposed";
    a.disposal = data;
    await a.save();
    res.send(a);
  })
);

router.delete(
  "/:id/dispose",
  ah(async (req, res) => {
    const a = await FixedAsset.findOne({ _id: req.params.id, organization: req.org });
    if (!a) throw new HttpError(404, "Asset not found");
    a.status = "active";
    a.disposal = undefined;
    await a.save();
    res.send(a);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await FixedAsset.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Asset not found");
    res.send({ message: "Asset deleted, with its depreciation" });
  })
);

module.exports = router;
