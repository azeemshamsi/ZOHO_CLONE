// Sales → Amazon: import Amazon's Merchant Tax Report (B2C / B2B) and check it against Amazon's GSTR-1 report.
const router = require("express").Router();
const Joi = require("joi");
const { ah, validate, HttpError } = require("../utils/http");
const AI = require("../utils/import/amazonImport");

const filesJoi = Joi.array().items(Joi.object({ name: Joi.string().required(), data: Joi.string().required() })).min(1).max(12).required();
const decode = (files) =>
  files.map((f) => {
    const data = Buffer.from(f.data.replace(/^data:[^,]*,/, ""), "base64");
    if (data.length > 25 * 1024 * 1024) throw new HttpError(400, `${f.name} is over 25 MB`);
    return { name: f.name, data };
  });
const fail = (e) => (e instanceof HttpError ? e : new HttpError(400, e.message));

router.get(
  "/months",
  ah(async (req, res) => res.send(await AI.months(req.org)))
);

router.post(
  "/preview",
  ah(async (req, res) => {
    const d = validate(Joi.object({ files: filesJoi }), req.body);
    try {
      res.send(await AI.preview(req.org, decode(d.files)));
    } catch (e) {
      throw fail(e);
    }
  })
);

router.post(
  "/import",
  ah(async (req, res) => {
    const d = validate(Joi.object({ planId: Joi.string().required(), ledger: Joi.string().allow(""), mode: Joi.string().valid("online", "single").default("single"), party: Joi.string().allow("") }), req.body);
    try {
      res.status(202).send(AI.startImport({ org: req.org, user: req.user }, d.planId, { ledger: d.ledger, mode: d.mode, party: d.party }));
    } catch (e) {
      throw fail(e);
    }
  })
);

router.get(
  "/jobs/:id",
  ah(async (req, res) => {
    const j = AI.jobOf(req.org, req.params.id);
    if (!j) throw new HttpError(404, "Import not found");
    res.send(j);
  })
);

// B2B documents imported under the Amazon party: list (preview) and move to their buyers.
router.get(
  "/move-b2b",
  ah(async (req, res) => {
    const month = String(req.query.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "Pick a month");
    res.send({ month, rows: await AI.b2bOnParty(req.org, month) });
  })
);
router.post(
  "/move-b2b",
  ah(async (req, res) => {
    const d = validate(Joi.object({ month: Joi.string().pattern(/^\d{4}-\d{2}$/).required() }), req.body);
    res.send(await AI.moveB2b({ org: req.org, user: req.user }, d.month, req));
  })
);

router.post(
  "/reconcile",
  ah(async (req, res) => {
    const d = validate(Joi.object({ month: Joi.string().pattern(/^\d{4}-\d{2}$/).required(), files: filesJoi }), req.body);
    try {
      res.send(await AI.reconcile(req.org, d.month, decode(d.files)));
    } catch (e) {
      throw fail(e);
    }
  })
);

// Undo one month's Amazon import.
router.post(
  "/remove-month",
  ah(async (req, res) => {
    const d = validate(Joi.object({ month: Joi.string().pattern(/^\d{4}-\d{2}$/).required() }), req.body);
    res.send(await AI.removeMonth({ org: req.org, user: req.user }, "amazon", d.month, req));
  })
);

module.exports = router;
