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
    const d = validate(Joi.object({ planId: Joi.string().required(), ledger: Joi.string().allow("") }), req.body);
    try {
      res.status(202).send(AI.startImport({ org: req.org, user: req.user }, d.planId, { ledger: d.ledger }));
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

module.exports = router;
