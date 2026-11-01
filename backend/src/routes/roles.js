// Custom roles: pick an access level for each module. Mounted at /api/roles (settings permission).
const router = require("express").Router();
const Joi = require("joi");
const Role = require("../models/Role");
const Membership = require("../models/Membership");
const { KEYS, MODULES } = require("../utils/roles");
const { ah, validate, HttpError } = require("../utils/http");

const schema = Joi.object({
  name: Joi.string().trim().min(2).max(60).required().label("Role name"),
  desc: Joi.string().allow("").max(200),
  perms: Joi.object(Object.fromEntries(KEYS.map((k) => [k, Joi.string().valid("none", "view", "full")]))).required(),
  home: Joi.string().allow("").max(100),
});

router.get("/modules", (req, res) => res.send(MODULES.map(([key, label, desc]) => ({ key, label, desc }))));

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    if (await Role.exists({ organization: req.org, name: d.name })) throw new HttpError(409, "A role with this name exists");
    res.status(201).send(await Role.create({ ...d, organization: req.org }));
  })
);
router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    const r = await Role.findOneAndUpdate({ _id: req.params.id, organization: req.org }, d, { new: true });
    if (!r) throw new HttpError(404, "Role not found");
    res.send(r);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const n = await Membership.countDocuments({ organization: req.org, role: `custom:${req.params.id}` });
    if (n) throw new HttpError(400, `${n} user${n === 1 ? " has" : "s have"} this role. Give them another role first.`);
    await Role.deleteOne({ _id: req.params.id, organization: req.org });
    res.send({ ok: true });
  })
);
module.exports = router;
