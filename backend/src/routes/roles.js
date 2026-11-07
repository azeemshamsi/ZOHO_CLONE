// Custom roles: pick an access level for each module. Mounted at /api/roles (settings permission).
const router = require("express").Router();
const Joi = require("joi");
const Role = require("../models/Role");
const Membership = require("../models/Membership");
const { KEYS, MODULES } = require("../utils/roles");
const { ah, validate, HttpError } = require("../utils/http");
const audit = require("../utils/audit");
const roleAudit = (req, action, r) => {
  audit.log(req, action, { target: r.name || String(r._id), meta: { roleId: String(r._id), perms: r.perms } });
  audit.alert(req.org, `Role ${action.replace("role_", "")}: ${r.name || r._id}`, `${req.user.name} <${req.user.email}> ${action.replace("role_", "")} the role "${r.name || r._id}".${r.perms ? `\nPermissions: ${Object.entries(r.perms).filter(([, v]) => v !== "none").map(([k, v]) => `${k}=${v}`).join(", ") || "none"}` : ""}`, `rolechg:${r._id}`);
};

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
    const r = await Role.create({ ...d, organization: req.org });
    roleAudit(req, "role_created", r);
    res.status(201).send(r);
  })
);
router.put(
  "/:id",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    const r = await Role.findOneAndUpdate({ _id: req.params.id, organization: req.org }, d, { new: true });
    if (!r) throw new HttpError(404, "Role not found");
    roleAudit(req, "role_updated", r);
    res.send(r);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const key = `custom:${req.params.id}`;
    const n = (await Membership.find({ organization: req.org }, { role: 1, extraRoles: 1 }).lean()).filter((m) => m.role === key || (m.extraRoles || []).includes(key)).length;
    if (n) throw new HttpError(400, `${n} user${n === 1 ? " has" : "s have"} this role. Give them another role first.`);
    const gone = await Role.findOneAndDelete({ _id: req.params.id, organization: req.org });
    if (gone) roleAudit(req, "role_deleted", { _id: gone._id, name: gone.name });
    res.send({ ok: true });
  })
);
module.exports = router;
